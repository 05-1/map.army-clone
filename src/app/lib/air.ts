// Air combat engine (v2: squadrons are map units). Runs inside resolveCombat (lib/combat.ts) on the
// same inputs, salts and hand edits, so the owner's preview, the sandbox and the tests share one
// implementation.
//
// Order at push: movement (already applied: positions are final), then
//   resolveAirCombat:  landing, air-to-air exchanges, AA auto-fire, HARMs, strikes
//   ground combat      (lib/combat.ts)
//   finishAir:         aerial refuelling with what is left of each tanker, forced returns, rearming.
//
// Hit chance: weapon accuracy − the target's countermeasure for the weapon's guidance, in percentage
// points, clamped (5–95 by default). Every shot is rolled from a seeded hash, so it is reproducible.
import type { Pos } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Guidance = 'radar' | 'ir' | 'harm' | 'agm' | 'none';

export interface AirWeaponIn {
  id: string;
  name: string;
  family?: string;
  tier: number;
  guidance: Guidance;
  accuracy: number;
  range_m: number;
  damage: number;
  ap: number;
  weight: number;
  slots: number;
  targets: string[];
  /** Per aircraft, as loaded. */
  count: number;
}

export interface AirframeIn {
  id: string;
  name: string;
  role?: string;
  tanker?: boolean;
  refuelable?: boolean;
  hp: number;
  speed_m?: number;
  hardpoints: number;
  max_payload: number;
  payload_penalty?: number;
  radius_m: number;
  radar_m: number;
  signature: number;
  ecm: number;
  flares: number;
  maneuver: number;
  gun_accuracy: number;
  gun_damage: number;
  gun_range_m: number;
  landed_armor?: number;
  squadron_size: number;
  cost_per_aircraft: number;
}

export interface AirAttackIn {
  target: string;
  weapons: { weapon: string; count: number }[];
}

export interface AirUnitIn {
  id: string;
  name: string;
  owner: string | null;
  /** Team key: units on the same side are friendly (radar picture and mutual support). */
  side: string;
  airframe: AirframeIn;
  /** Position after movement. */
  pos: Pos;
  /** Did it move this turn? */
  moved: boolean;
  /** Base it was landed at before this turn's movement (null = airborne or stranded). */
  landed_at: string | null;
  aircraft: number;
  max: number;
  damage: number;
  loadout: AirWeaponIn[];
  /** Missiles left, per weapon id, for the whole squadron. */
  ammo: Record<string, number>;
  /** Combat radius with this loadout. */
  radius_m: number;
  attacks: AirAttackIn[];
  /** Missiles per aircraft per phase it fires back with when attacked. */
  return_salvo: number;
  /** Tankers: which squadrons to refuel first. */
  refuel_priority: string[];
  grounded: boolean;
}

/** A ground or naval unit as the air phase sees it (a subset of combat.ts' live unit, mutated in place). */
export interface GroundTarget {
  id: string;
  name: string;
  owner: string | null;
  side: string;
  pos: Pos;
  cur: number;
  max: number;
  hit: boolean;
  fired: boolean;
  stationary: boolean;
  stationary_turns: number;
  terrain: 'open' | 'urban' | 'forest';
  emit: boolean;
  template: { armor: number; category: string; aps?: number; air_capacity?: number };
  weapons: { slot: number; name: string; anti_air?: boolean; guidance?: string; accuracy?: number; air_damage?: number; air_shots?: number; range_m: number }[];
}

export interface AirSettings {
  hit_min: number;
  hit_max: number;
  dark_penalty: number;
  mutual_support_km: number;
  refuel_radius_km: number;
  refuel_per_aircraft: number;
  tankers_refuel_tankers: boolean;
  land_snap_km: number;
  dug_in: number;
  dug_in_turns: number;
  terrain: Record<string, number>;
}

export interface AirShot {
  key: string;
  shooter: string;
  shooter_name: string;
  weapon: string;
  guidance: string;
  target: string;
  target_name: string;
  accuracy: number;
  countermeasure: number;
  hit_pct: number;
  roll: number;
  hit: boolean;
  /** Ground targets: the damage multipliers applied on a hit. */
  mults: [string, number][];
  computed: number;
  final: number;
  edited: boolean;
}

export interface AirPhase {
  label: string;
  shots: AirShot[];
}

export interface PackageLog {
  id: string;
  kind: 'exchange' | 'aa' | 'harm' | 'strike';
  label: string;
  squadrons: string[];
  phases: AirPhase[];
}

export interface SquadronOut {
  id: string;
  owner: string | null;
  side: string;
  name: string;
  before: number;
  after: number;
  /** Damage carried over (below one airframe's HP). */
  damage: number;
  lost: number;
  ammo: Record<string, number>;
  pos: Pos;
  state: 'landed' | 'airborne';
  base: string | null;
  refueled_by: string | null;
  /** Why it had to fly home (or null). */
  forced: string | null;
  /** Grounded for the next turn (forced return) or until rebased (stranded). */
  grounded: boolean;
  stranded: boolean;
  fired: boolean;
}

export interface StrikeOut {
  squadron: string;
  squadron_name: string;
  owner: string | null;
  target: string;
  target_name: string;
  shots: number;
  hits: number;
  damage: number;
  destroyed: boolean;
  aborted: string | null;
}

export interface AirResult {
  squadrons: SquadronOut[];
  strikes: StrikeOut[];
  kills: { owner: string; count: number }[];
  log: { packages: PackageLog[]; notes: { squadron: string; name: string; text: string }[]; refuel: { tanker: string; name: string; served: string[]; capacity: number }[] };
}

/** A friendly base for landing and the radius rule: an airbase or carrier unit, at its final position. */
export interface AirBaseIn {
  id: string;
  name: string;
  owner: string | null;
  side: string;
  pos: Pos;
  capacity: number;
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

export const clampHit = (pct: number, s: Pick<AirSettings, 'hit_min' | 'hit_max'>) => Math.min(s.hit_max, Math.max(s.hit_min, pct));

/** Effective combat radius: base × (1 − penalty × payload ÷ max payload). */
export function combatRadius(a: Pick<AirframeIn, 'radius_m' | 'max_payload'>, payloadKg: number, penalty: number): number {
  return a.radius_m * (1 - penalty * Math.min(1, a.max_payload > 0 ? payloadKg / a.max_payload : 0));
}

/** The countermeasure that works against a guidance type. */
export function countermeasure(guidance: string, a: Pick<AirframeIn, 'ecm' | 'flares' | 'maneuver'>): number {
  return guidance === 'radar' ? a.ecm : guidance === 'ir' ? a.flares : guidance === 'gun' ? a.maneuver : 0;
}

/** Damage of a hit on a ground unit: damage × min(AP ÷ armor, 1.5) (armor 0 counts as 1.5), × terrain, × dug in. */
export function groundHit(damage: number, ap: number, t: Pick<GroundTarget, 'template' | 'terrain' | 'stationary' | 'stationary_turns'>, s: AirSettings): { mults: [string, number][]; raw: number } {
  const armor = t.template.armor;
  const mults: [string, number][] = [[armor > 0 ? `AP ${ap} vs armor ${armor}` : 'no armor', armor > 0 ? Math.min(ap / armor, 1.5) : 1.5]];
  mults.push([`terrain: ${t.terrain}`, s.terrain[t.terrain] ?? 1]);
  if (t.stationary && t.stationary_turns + 1 >= s.dug_in_turns) mults.push(['target dug in', s.dug_in]);
  return { mults, raw: mults.reduce((x, [, m]) => x * m, damage) };
}

/** A hit on a landed squadron: damage × min(AP ÷ its landed armor, 1.5). */
function landedHit(damage: number, ap: number, armor: number): { mults: [string, number][]; raw: number } {
  const m = armor > 0 ? Math.min(ap / armor, 1.5) : 1.5;
  return { mults: [[armor > 0 ? `AP ${ap} vs armor ${armor} (on the ground)` : 'aircraft on the ground', m]], raw: damage * m };
}

const ceil = (x: number) => Math.max(0, Math.ceil(x - 1e-9));

export const distM = (a: Pos, b: Pos) => {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b[1] - a[1]) / 2) ** 2 + Math.cos(r(a[1])) * Math.cos(r(b[1])) * Math.sin(r(b[0] - a[0]) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
};

// ---------------------------------------------------------------------------
// Squadron state
// ---------------------------------------------------------------------------

export interface Sq {
  in: AirUnitIn;
  dmg: number;
  ammo: Map<string, number>;
  /** Damage taken from each shooting owner, to share out kills. */
  from: Map<string, number>;
  pos: Pos;
  landed: boolean;
  base: string | null;
  fired: boolean;
}

export const alive = (q: Sq) => Math.max(0, q.in.aircraft - Math.floor(q.dmg / Math.max(1, q.in.airframe.hp)));

export function squadronState(q: AirUnitIn): Sq {
  const ammo = new Map(q.loadout.map((w) => [w.id, Math.max(0, q.ammo[w.id] ?? w.count * q.aircraft)]));
  return { in: q, dmg: Math.max(0, q.damage), ammo, from: new Map(), pos: q.pos, landed: false, base: null, fired: false };
}

/** Missiles of one kind this squadron can still fire: what is left, and no more than its surviving aircraft carry. */
const available = (q: Sq, w: AirWeaponIn, n = alive(q)) => Math.min(q.ammo.get(w.id) ?? 0, n * w.count);

export interface Roller {
  /** Uniform in [0, 1) for this shot. */
  rand(...parts: (string | number)[]): number;
  edits: Record<string, number>;
  s: AirSettings;
}

function shoot(r: Roller, key: string, o: { shooter: string; shooter_name: string; weapon: string; guidance: string; target: string; target_name: string;
  accuracy: number; cm: number; damage: number; mults?: [string, number][] }): AirShot {
  const hit_pct = clampHit(o.accuracy - o.cm, r.s);
  const roll = r.rand(key) * 100;
  const hit = roll < hit_pct;
  const computed = hit ? ceil(o.damage) : 0;
  const edited = Object.prototype.hasOwnProperty.call(r.edits, key);
  return {
    key, shooter: o.shooter, shooter_name: o.shooter_name, weapon: o.weapon, guidance: o.guidance, target: o.target, target_name: o.target_name,
    accuracy: o.accuracy, countermeasure: o.cm, hit_pct, roll, hit: edited ? r.edits[key] > 0 : hit, mults: o.mults ?? [], computed,
    final: edited ? Math.max(0, Math.round(r.edits[key])) : computed, edited,
  };
}

function hitSquadron(t: Sq, sh: AirShot, shooterOwner: string | null) {
  if (!sh.final) return;
  t.dmg += sh.final;
  const o = shooterOwner ?? '';
  t.from.set(o, (t.from.get(o) ?? 0) + sh.final);
}

const airWeapons = (q: Sq, g: 'radar' | 'ir') => q.in.loadout.filter((w) => w.guidance === g && w.targets.includes('air'));

// ---------------------------------------------------------------------------
// Air-to-air
// ---------------------------------------------------------------------------

/**
 * One exchange: attackers that declared on a target, against the target and its friends within the
 * mutual-support distance. BVR: radar missiles within min(missile range, detection range); the side that
 * detects first fires first, then the longer missile range, else both at once. WVR: IR missiles, at once.
 * Guns: at once. Attackers fire the salvo they declared; defenders fire back `return_salvo` missiles per
 * aircraft per phase. Who can fire is judged at the start of each volley; shots stop on dead targets.
 */
export function airExchange(r: Roller, prefix: string, attackers: { q: Sq; salvo: Map<string, number> }[], target: Sq, defenders: Sq[], owners: Map<string, string | null>): AirPhase[] {
  const phases: AirPhase[] = [];
  const A = attackers.filter((a) => alive(a.q) > 0);
  const D = [target, ...defenders.filter((d) => d !== target)].filter((d) => alive(d) > 0);
  if (!A.length || alive(target) <= 0) return phases;
  const sig = (q: Sq) => q.in.airframe.signature;
  const detect = (from: Sq, to: Sq) => from.in.airframe.radar_m * sig(to);
  const dist = (a: Sq, b: Sq) => distM(a.pos, b.pos);

  // Attackers' volley at the target with one guidance (or guns). Declared counts, ammo and survivors limit it.
  const attackVolley = (phase: string, g: 'radar' | 'ir' | 'gun', canFire: Map<Sq, number>): AirShot[] => {
    const shots: AirShot[] = [];
    for (const { q, salvo } of A) {
      const n = canFire.get(q) ?? 0;
      if (n <= 0) continue;
      if (g === 'gun') {
        if (q.in.airframe.gun_damage <= 0) continue;
        for (let i = 0; i < n && alive(target) > 0; i++) {
          const sh = shoot(r, `${prefix}:${phase}:${q.in.id}:gun:${i}`, { shooter: q.in.id, shooter_name: q.in.name, weapon: 'gun', guidance: 'gun', target: target.in.id,
            target_name: target.in.name, accuracy: q.in.airframe.gun_accuracy, cm: countermeasure('gun', target.in.airframe), damage: q.in.airframe.gun_damage });
          hitSquadron(target, sh, owners.get(q.in.id) ?? null);
          shots.push(sh);
          q.fired = true;
        }
        continue;
      }
      for (const w of airWeapons(q, g)) {
        const want = salvo.get(w.id) ?? 0;
        if (want <= 0) continue;
        if (g === 'radar' && dist(q, target) > Math.min(w.range_m, detect(q, target))) continue;
        const k = Math.min(want, available(q, w, n));
        for (let i = 0; i < k && alive(target) > 0; i++) {
          q.ammo.set(w.id, (q.ammo.get(w.id) ?? 0) - 1);
          salvo.set(w.id, (salvo.get(w.id) ?? 0) - 1);
          const sh = shoot(r, `${prefix}:${phase}:${q.in.id}:${w.id}:${i}`, { shooter: q.in.id, shooter_name: q.in.name, weapon: w.name, guidance: g, target: target.in.id,
            target_name: target.in.name, accuracy: w.accuracy, cm: countermeasure(g, target.in.airframe), damage: w.damage });
          hitSquadron(target, sh, owners.get(q.in.id) ?? null);
          shots.push(sh);
          q.fired = true;
        }
      }
    }
    return shots;
  };
  // Defenders' volley, spread over the attackers in reach.
  const defendVolley = (phase: string, g: 'radar' | 'ir' | 'gun', canFire: Map<Sq, number>): AirShot[] => {
    const shots: AirShot[] = [];
    let k = 0;
    for (const d of D) {
      const n = canFire.get(d) ?? 0;
      if (n <= 0) continue;
      if (g === 'gun') {
        if (d.in.airframe.gun_damage <= 0) continue;
        for (let i = 0; i < n; i++) {
          const ts = A.filter((a) => alive(a.q) > 0);
          if (!ts.length) break;
          const t = ts[k++ % ts.length].q;
          const sh = shoot(r, `${prefix}:${phase}:${d.in.id}:gun:${i}`, { shooter: d.in.id, shooter_name: d.in.name, weapon: 'gun', guidance: 'gun', target: t.in.id,
            target_name: t.in.name, accuracy: d.in.airframe.gun_accuracy, cm: countermeasure('gun', t.in.airframe), damage: d.in.airframe.gun_damage });
          hitSquadron(t, sh, owners.get(d.in.id) ?? null);
          shots.push(sh);
          d.fired = true;
        }
        continue;
      }
      let budget = Math.max(0, Math.round(d.in.return_salvo)) * n;
      for (const w of [...airWeapons(d, g)].sort((a, b) => b.range_m - a.range_m)) {
        const reach = (t: Sq) => g !== 'radar' || dist(d, t) <= Math.min(w.range_m, detect(d, t));
        let i = 0;
        while (budget > 0 && available(d, w, n) > 0) {
          const ts = A.filter((a) => alive(a.q) > 0 && reach(a.q));
          if (!ts.length) break;
          const t = ts[k++ % ts.length].q;
          d.ammo.set(w.id, (d.ammo.get(w.id) ?? 0) - 1);
          budget--;
          const sh = shoot(r, `${prefix}:${phase}:${d.in.id}:${w.id}:${i++}`, { shooter: d.in.id, shooter_name: d.in.name, weapon: w.name, guidance: g, target: t.in.id,
            target_name: t.in.name, accuracy: w.accuracy, cm: countermeasure(g, t.in.airframe), damage: w.damage });
          hitSquadron(t, sh, owners.get(d.in.id) ?? null);
          shots.push(sh);
          d.fired = true;
        }
      }
    }
    return shots;
  };
  const snapshot = (gs: Sq[]) => new Map(gs.map((q) => [q, alive(q)]));
  const As = A.map((a) => a.q);

  // BVR
  const detA = Math.max(0, ...As.map((q) => detect(q, target)));
  const detD = Math.max(0, ...D.flatMap((d) => As.map((a) => detect(d, a))));
  const rangeOf = (gs: Sq[], declared: boolean) => Math.max(0, ...gs.flatMap((q) => airWeapons(q, 'radar')
    .filter((w) => (q.ammo.get(w.id) ?? 0) > 0 && (!declared || (A.find((a) => a.q === q)?.salvo.get(w.id) ?? 0) > 0)).map((w) => w.range_m)));
  const rA = rangeOf(As, true), rD = rangeOf(D, false);
  if (rA > 0 || rD > 0) {
    const first = detA !== detD ? (detA > detD ? 'A' : 'D') : rA !== rD ? (rA > rD ? 'A' : 'D') : null;
    if (first === 'A') {
      const s1 = attackVolley('bvr1', 'radar', snapshot(As));
      if (s1.length) phases.push({ label: 'Beyond visual range: attackers detect first and fire', shots: s1 });
      const s2 = defendVolley('bvr2', 'radar', snapshot(D));
      if (s2.length) phases.push({ label: 'Beyond visual range: defenders reply', shots: s2 });
    } else if (first === 'D') {
      const s1 = defendVolley('bvr1', 'radar', snapshot(D));
      if (s1.length) phases.push({ label: 'Beyond visual range: defenders detect first and fire', shots: s1 });
      const s2 = attackVolley('bvr2', 'radar', snapshot(As));
      if (s2.length) phases.push({ label: 'Beyond visual range: attackers reply', shots: s2 });
    } else {
      const sa = snapshot(As), sd = snapshot(D);
      const s = [...attackVolley('bvr', 'radar', sa), ...defendVolley('bvr', 'radar', sd)];
      if (s.length) phases.push({ label: 'Beyond visual range: both sides fire at once', shots: s });
    }
  }
  // WVR, then guns: simultaneous (who can fire is fixed before either side's shots land).
  for (const [phase, g, label] of [['wvr', 'ir', 'Within visual range: IR missiles'], ['gun', 'gun', 'Guns']] as const) {
    if (!As.some((q) => alive(q) > 0) || !D.some((q) => alive(q) > 0)) break;
    const sa = snapshot(As), sd = snapshot(D);
    const shots = [...attackVolley(phase, g, sa), ...defendVolley(phase, g, sd)];
    if (shots.length) phases.push({ label, shots });
  }
  return phases;
}

// ---------------------------------------------------------------------------
// The air phase before ground combat
// ---------------------------------------------------------------------------

export interface AirState {
  qs: Map<string, Sq>;
  bases: AirBaseIn[];
  packages: PackageLog[];
  strikes: StrikeOut[];
  notes: AirResult['log']['notes'];
}

/** Which friendly base a squadron lands at this turn: it stays put on its base, or ends its move on one with room. */
function land(qs: Sq[], bases: AirBaseIn[], s: AirSettings) {
  const used = new Map<string, number>();
  const byId = new Map(bases.map((b) => [b.id, b]));
  // Squadrons that did not move keep their base (a carrier carries them along).
  for (const q of qs) {
    const b = q.in.landed_at ? byId.get(q.in.landed_at) : undefined;
    if (b && !q.in.moved) {
      q.landed = true;
      q.base = b.id;
      q.pos = b.pos;
      used.set(b.id, (used.get(b.id) ?? 0) + 1);
    }
  }
  for (const q of qs.filter((x) => !x.landed && x.in.moved).sort((a, b) => a.in.id.localeCompare(b.in.id))) {
    const b = bases.filter((x) => x.owner === q.in.owner && distM(x.pos, q.pos) <= s.land_snap_km * 1000 && (used.get(x.id) ?? 0) < x.capacity)
      .sort((a, c) => distM(a.pos, q.pos) - distM(c.pos, q.pos))[0];
    if (b) {
      q.landed = true;
      q.base = b.id;
      q.pos = b.pos;
      used.set(b.id, (used.get(b.id) ?? 0) + 1);
    }
  }
}

export function resolveAirCombat(units: AirUnitIn[], bases: AirBaseIn[], ground: Map<string, GroundTarget>, r: Roller, saltFor: (pkg: string) => Roller): AirState {
  const s = r.s;
  const qs = new Map(units.map((q) => [q.id, squadronState(q)]));
  const all = [...qs.values()].sort((a, b) => a.in.id.localeCompare(b.in.id));
  const owners = new Map<string, string | null>([...units.map((q) => [q.id, q.owner] as const), ...[...ground.values()].map((u) => [u.id, u.owner] as const)]);
  const notes: AirState['notes'] = [];
  const note = (q: Sq, text: string) => notes.push({ squadron: q.in.id, name: q.in.name, text });
  const packages: PackageLog[] = [];
  const strikes: StrikeOut[] = [];
  land(all, bases, s);
  const airborne = (q: Sq) => !q.landed && alive(q) > 0;
  // A squadron grounded this turn neither flies nor fires.
  const canAttack = (q: Sq) => airborne(q) && !q.in.grounded;

  // 1. Air-to-air: one exchange per attacked squadron, attackers declared on it in id order.
  const salvos = new Map(all.map((q) => [q, new Map(q.in.attacks.map((a) => [a.target, new Map(a.weapons.map((w) => [w.weapon, w.count]))]))]));
  const airTargets = [...new Set(all.flatMap((q) => q.in.attacks.map((a) => a.target)))].filter((id) => qs.has(id)).sort();
  for (const tid of airTargets) {
    const t = qs.get(tid)!;
    const att = all.filter((q) => q.in.attacks.some((a) => a.target === tid));
    if (!airborne(t)) continue; // landed targets are struck below
    const live = att.filter((q) => canAttack(q) && q.in.side !== t.in.side);
    for (const q of att.filter((x) => !live.includes(x))) note(q, `no air-to-air shots at ${t.in.name}: ${q.landed ? 'it landed' : alive(q) <= 0 ? 'shot down' : 'grounded'}`);
    if (!live.length) continue;
    const support = all.filter((d) => d !== t && airborne(d) && d.in.side === t.in.side && distM(d.pos, t.pos) <= s.mutual_support_km * 1000);
    const pr = saltFor(`x:${tid}`);
    const phases = airExchange(pr, `x:${tid}`, live.map((q) => ({ q, salvo: salvos.get(q)!.get(tid)! })), t, support, owners);
    packages.push({ id: `x:${tid}`, kind: 'exchange', label: `${live.map((q) => q.in.name).join(', ')} attack ${t.in.name}${support.length ? ` (supported by ${support.map((d) => d.in.name).join(', ')})` : ''}`,
      squadrons: [...live.map((q) => q.in.id), t.in.id, ...support.map((d) => d.in.id)], phases });
  }

  // 2. AA auto-fire: every AA weapon fires its shots at each enemy squadron that ends its move within range.
  for (const u of [...ground.values()].filter((x) => x.cur > 0).sort((a, b) => a.id.localeCompare(b.id))) {
    const shots: AirShot[] = [];
    const pr = saltFor(`aa:${u.id}`);
    for (const w of u.weapons.filter((x) => x.anti_air && (x.air_shots ?? 0) > 0)) {
      const dark = w.guidance === 'radar' && !u.emit;
      const acc = (w.accuracy ?? 0) * (dark ? s.dark_penalty : 1);
      for (const t of all.filter((q) => airborne(q) && q.in.side !== u.side && distM(u.pos, q.pos) <= w.range_m)) {
        for (let i = 0; i < (w.air_shots ?? 0) && alive(t) > 0; i++) {
          const sh = shoot(pr, `aa:${u.id}:${w.slot}:${t.in.id}:${i}`, { shooter: u.id, shooter_name: u.name, weapon: `${w.name}${dark ? ' (radar dark)' : ''}`, guidance: w.guidance ?? 'none',
            target: t.in.id, target_name: t.in.name, accuracy: acc, cm: countermeasure(w.guidance ?? 'none', t.in.airframe), damage: w.air_damage ?? 0 });
          hitSquadron(t, sh, u.owner);
          shots.push(sh);
        }
        u.fired = true;
      }
    }
    if (shots.length) packages.push({ id: `aa:${u.id}`, kind: 'aa', label: `Anti-air: ${u.name}`, squadrons: [...new Set(shots.map((x) => x.target))], phases: [{ label: 'Auto-fire at aircraft in range', shots }] });
  }

  // 3. HARMs (at emitting radar AA in range), then every other strike, squadron by squadron.
  for (const harmPass of [true, false]) {
    for (const q of all) {
      const shots: AirShot[] = [];
      const pr = saltFor(`${harmPass ? 'h' : 's'}:${q.in.id}`);
      for (const a of q.in.attacks) {
        const g = ground.get(a.target);
        const tq = qs.get(a.target);
        if (!g && !(tq && tq.landed)) continue; // air targets were handled above
        const name = g?.name ?? tq!.in.name;
        const ws = a.weapons.map((x) => ({ w: q.in.loadout.find((l) => l.id === x.weapon), count: x.count }))
          .filter((x): x is { w: AirWeaponIn; count: number } => !!x.w && (x.w.guidance === 'harm') === harmPass);
        if (!ws.length) continue;
        const st: StrikeOut = { squadron: q.in.id, squadron_name: q.in.name, owner: q.in.owner, target: a.target, target_name: name, shots: 0, hits: 0, damage: 0, destroyed: false, aborted: null };
        strikes.push(st);
        if (!canAttack(q)) { st.aborted = q.landed ? 'it landed instead' : alive(q) <= 0 ? 'shot down before it could fire' : 'grounded'; continue; }
        const tpos = g?.pos ?? tq!.pos;
        const dead = () => (g ? g.cur <= 0 : alive(tq!) <= 0);
        if (dead()) { st.aborted = 'target already destroyed'; continue; }
        const d = distM(q.pos, tpos);
        for (const { w, count } of ws) {
          const cat = g ? (g.template.category === 'naval' ? 'ship' : 'ground') : 'ground';
          const harmOk = w.guidance !== 'harm' || (!!g && g.emit && g.weapons.some((x) => x.anti_air && x.guidance === 'radar'));
          if (w.guidance === 'harm' ? !w.targets.includes('radar') : !w.targets.includes(cat)) { st.aborted = `${w.name} cannot hit that target`; continue; }
          if (!harmOk) { st.aborted = `${w.name}: no emitting radar to lock on (it went dark)`; continue; }
          if (d > w.range_m) { st.aborted = `out of range: ${Math.round(d / 1000)} km, ${w.name} reaches ${Math.round(w.range_m / 1000)} km`; continue; }
          const k = Math.min(count, available(q, w));
          for (let i = 0; i < k && !dead(); i++) {
            q.ammo.set(w.id, (q.ammo.get(w.id) ?? 0) - 1);
            const hit = g ? groundHit(w.damage, w.ap, g, s) : landedHit(w.damage, w.ap, tq!.in.airframe.landed_armor ?? 0);
            const cm = w.guidance === 'agm' && g ? g.template.aps ?? 0 : 0;
            const sh = shoot(pr, `${harmPass ? 'h' : 's'}:${q.in.id}:${a.target}:${w.id}:${i}`, { shooter: q.in.id, shooter_name: q.in.name, weapon: w.name, guidance: w.guidance,
              target: a.target, target_name: name, accuracy: w.accuracy, cm, damage: hit.raw, mults: hit.mults });
            if (g) { g.cur = Math.max(0, g.cur - sh.final); g.hit = true; } else hitSquadron(tq!, sh, q.in.owner);
            shots.push(sh);
            q.fired = true;
            st.shots++;
            if (sh.final > 0) (st.hits++, (st.damage += sh.final));
          }
          if (st.shots) st.aborted = null;
        }
        st.destroyed = dead();
      }
      if (shots.length) packages.push({ id: `${harmPass ? 'h' : 's'}:${q.in.id}`, kind: harmPass ? 'harm' : 'strike', label: `${harmPass ? 'SEAD' : 'Strike'} by ${q.in.name}`,
        squadrons: [q.in.id], phases: [{ label: `${harmPass ? 'HARMs' : 'Strikes'}: ${[...new Set(shots.map((x) => x.target_name))].join(', ')}`, shots }] });
    }
  }
  return { qs, bases, packages, strikes, notes };
}

// ---------------------------------------------------------------------------
// After ground combat: refuelling, forced returns, rearming
// ---------------------------------------------------------------------------

/** Is this point inside the combat radius of one of the owner's bases (alive, at their final position)? */
export function baseCovers(q: { owner: string | null; radius_m: number }, at: Pos, bases: AirBaseIn[]): boolean {
  return bases.some((b) => b.owner === q.owner && distM(b.pos, at) <= q.radius_m * 1.001 + 1);
}

export function finishAir(st: AirState, baseAlive: (id: string) => boolean, s: AirSettings): AirResult {
  const all = [...st.qs.values()].sort((a, b) => a.in.id.localeCompare(b.in.id));
  const bases = st.bases.filter((b) => baseAlive(b.id));
  const byId = new Map(bases.map((b) => [b.id, b]));
  const used = new Map<string, number>();
  for (const q of all) if (q.landed && q.base && byId.has(q.base) && alive(q) > 0) used.set(q.base, (used.get(q.base) ?? 0) + 1);
  const forced = new Map<string, string>();
  const refueledBy = new Map<string, string>();
  const refuelLog: AirResult['log']['refuel'] = [];

  // Landed squadrons whose base was destroyed this turn have to go elsewhere.
  for (const q of all) if (q.landed && alive(q) > 0 && (!q.base || !byId.has(q.base))) forced.set(q.in.id, 'its base was destroyed');

  // The radius rule for everything still airborne: a base in reach, or a tanker with capacity left.
  const air = all.filter((q) => !q.landed && alive(q) > 0);
  const covered = new Set(air.filter((q) => baseCovers({ owner: q.in.owner, radius_m: q.in.radius_m }, q.pos, bases)).map((q) => q.in.id));
  const tankers = air.filter((q) => q.in.airframe.tanker && covered.has(q.in.id));
  for (const t of air.filter((q) => q.in.airframe.tanker && !covered.has(q.in.id))) forced.set(t.in.id, 'tanker out of reach of its bases');
  const needs = air.filter((q) => !covered.has(q.in.id) && !forced.has(q.in.id));
  for (const t of tankers) {
    const cap = Math.floor(s.refuel_per_aircraft * alive(t));
    const pri = (id: string) => { const i = t.in.refuel_priority.indexOf(id); return i < 0 ? 1e9 : i; };
    const cands = needs.filter((q) => !refueledBy.has(q.in.id) && q.in.owner === t.in.owner && q !== t
      && (q.in.airframe.refuelable ?? true) && (!q.in.airframe.tanker || s.tankers_refuel_tankers)
      && distM(t.pos, q.pos) <= s.refuel_radius_km * 1000)
      .sort((a, b) => pri(a.in.id) - pri(b.in.id) || a.in.id.localeCompare(b.in.id));
    const served = cands.slice(0, cap);
    for (const q of served) refueledBy.set(q.in.id, t.in.id);
    refuelLog.push({ tanker: t.in.id, name: t.in.name, served: served.map((q) => q.in.id), capacity: cap });
  }
  for (const q of needs) {
    if (refueledBy.has(q.in.id)) continue;
    const inCircle = tankers.some((t) => t.in.owner === q.in.owner && distM(t.pos, q.pos) <= s.refuel_radius_km * 1000);
    forced.set(q.in.id, inCircle ? 'the tanker had no capacity left for it' : 'out of reach of its bases and tankers');
  }

  // Forced returns: to the nearest own base with room; grounded next turn. None anywhere: stranded.
  const stranded = new Set<string>();
  for (const q of all.filter((x) => forced.has(x.in.id))) {
    const b = bases.filter((x) => x.owner === q.in.owner && (used.get(x.id) ?? 0) < x.capacity).sort((a, c) => distM(a.pos, q.pos) - distM(c.pos, q.pos))[0];
    if (b) {
      q.landed = true;
      q.base = b.id;
      q.pos = b.pos;
      used.set(b.id, (used.get(b.id) ?? 0) + 1);
    } else {
      q.landed = true;
      q.base = null;
      stranded.add(q.in.id);
    }
  }

  // Results per squadron; landed squadrons rearm for free. Kills shared out by damage dealt.
  const kills = new Map<string, number>();
  const out: SquadronOut[] = [];
  for (const q of all) {
    const after = alive(q);
    const lost = q.in.aircraft - after;
    const carried = after > 0 ? q.dmg - (q.in.aircraft - after) * q.in.airframe.hp : 0;
    const ammo: Record<string, number> = {};
    for (const w of q.in.loadout) {
      ammo[w.id] = q.landed && q.base ? w.count * after : Math.min(q.ammo.get(w.id) ?? 0, w.count * after);
    }
    out.push({
      id: q.in.id, owner: q.in.owner, side: q.in.side, name: q.in.name, before: q.in.aircraft, after, damage: Math.max(0, Math.round(carried * 100) / 100), lost,
      ammo, pos: q.pos, state: q.landed ? 'landed' : 'airborne', base: q.landed ? q.base : null, refueled_by: refueledBy.get(q.in.id) ?? null,
      forced: forced.get(q.in.id) ?? null, grounded: forced.has(q.in.id), stranded: stranded.has(q.in.id), fired: q.fired,
    });
    const total = [...q.from.values()].reduce((a, b) => a + b, 0);
    const newLost = lost - Math.floor(q.in.damage / Math.max(1, q.in.airframe.hp));
    if (total > 0 && newLost > 0) for (const [o, d] of q.from) if (o) kills.set(o, (kills.get(o) ?? 0) + (newLost * d) / total);
  }
  return {
    squadrons: out, strikes: st.strikes,
    kills: [...kills].map(([owner, c]) => ({ owner, count: Math.round(c) })).filter((x) => x.count > 0),
    log: { packages: st.packages, notes: st.notes, refuel: refuelLog },
  };
}

// ---------------------------------------------------------------------------
// Movement and coverage (draft UI and overlays; the server applies the same rules)
// ---------------------------------------------------------------------------

/** Where a squadron may end its move: within its speed of where it starts, and inside a base radius or a tanker circle. */
export interface Coverage {
  bases: { pos: Pos; radius_m: number }[];
  tankers: { id: string; pos: Pos; radius_m: number }[];
}

export function coverageAt(at: Pos, c: Coverage): { ok: boolean; tanker: string | null } {
  if (c.bases.some((b) => distM(b.pos, at) <= b.radius_m)) return { ok: true, tanker: null };
  const t = c.tankers.find((x) => distM(x.pos, at) <= x.radius_m);
  return t ? { ok: true, tanker: t.id } : { ok: false, tanker: null };
}

/**
 * Pull a wanted end point into the reachable area: inside the speed circle and covered. Walks back along
 * the line from the start (which is covered) until both hold. UX only: the server enforces the same rule.
 */
export function clampMove(start: Pos, want: Pos, speed_m: number, c: Coverage): Pos | null {
  const ok = (p: Pos) => distM(start, p) <= speed_m && coverageAt(p, c).ok;
  if (ok(want)) return want;
  const lerp = (t: number): Pos => [start[0] + (want[0] - start[0]) * t, start[1] + (want[1] - start[1]) * t];
  let best: Pos | null = null;
  for (let i = 40; i >= 0; i--) {
    const p = lerp(i / 40);
    if (ok(p)) { best = p; break; }
  }
  if (!best) return null;
  // Refine towards the edge.
  let lo = 0, hi = 1;
  const t0 = distM(start, best) / Math.max(1, distM(start, want));
  lo = t0; hi = Math.min(1, t0 + 1 / 40);
  for (let i = 0; i < 20; i++) {
    const m = (lo + hi) / 2;
    if (ok(lerp(m))) lo = m; else hi = m;
  }
  return lerp(lo);
}
