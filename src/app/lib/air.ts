// Air combat engine. Runs inside resolveCombat (lib/combat.ts) before ground combat, on the same inputs,
// salts and hand edits, so the review preview, the sandbox and the tests share one implementation.
//
// Order at push: movement, then air (interceptions, then SEAD and AA over each target, then strikes),
// then ground combat on the strengths the air phase left.
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
  tier: number;
  guidance: Guidance;
  accuracy: number;
  range_m: number;
  damage: number;
  ap: number;
  weight: number;
  slots: number;
  targets: string[];
  /** Per aircraft. */
  count: number;
}

export interface AirframeIn {
  id: string;
  name: string;
  hp: number;
  hardpoints: number;
  max_payload: number;
  radius_m: number;
  radar_m: number;
  signature: number;
  ecm: number;
  flares: number;
  maneuver: number;
  gun_accuracy: number;
  gun_damage: number;
  gun_range_m: number;
  squadron_size: number;
  cost_per_aircraft: number;
}

export interface MissionIn {
  type: 'strike' | 'patrol' | 'escort' | 'recon';
  target?: Pos;
  target_unit?: string;
  escort_of?: string;
  radius_m?: number;
}

export interface SquadronIn {
  id: string;
  name: string;
  owner: string | null;
  side: string;
  airframe: AirframeIn;
  base: string | null;
  base_pos: Pos | null;
  aircraft: number;
  max: number;
  damage: number;
  loadout: AirWeaponIn[];
  radius_m: number;
  mission: MissionIn | null;
}

/** A ground unit as the air phase sees it (a subset of combat.ts' live unit, mutated in place). */
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
  template: { armor: number; category: string; aps?: number };
  weapons: { slot: number; name: string; anti_air?: boolean; guidance?: string; accuracy?: number; air_damage?: number; air_shots?: number; range_m: number }[];
}

export interface AirSettings {
  hit_min: number;
  hit_max: number;
  dark_penalty: number;
  patrol_radius_km: number;
  recon_radius_km: number;
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
  kind: 'strike' | 'recon';
  label: string;
  route: [Pos, Pos];
  squadrons: string[];
  phases: AirPhase[];
}

export interface SquadronOut {
  id: string;
  owner: string | null;
  side: string;
  name: string;
  mission: string | null;
  before: number;
  after: number;
  /** Damage carried over (below one airframe's HP). */
  damage: number;
  lost: number;
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
  reveals: { owner: string | null; side: string; squadron_name: string; center: Pos; radius_m: number }[];
  log: { packages: PackageLog[]; failed: { squadron: string; name: string; reason: string }[] };
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

const ceil = (x: number) => Math.max(0, Math.ceil(x - 1e-9));

/** Local metres around a point; good enough for route-vs-circle tests at campaign scale. */
function local(o: Pos) {
  const kx = 111320 * Math.cos((o[1] * Math.PI) / 180);
  return (p: Pos): [number, number] => [(p[0] - o[0]) * kx, (p[1] - o[1]) * 110540];
}

/** Does the straight route a→b pass within r metres of c? Returns how far along the route (m) it gets closest, or null. */
export function routeCrosses(a: Pos, b: Pos, c: Pos, r: number): number | null {
  const L = local(c);
  const [ax, ay] = L(a);
  const [bx, by] = L(b);
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  const px = ax + t * dx, py = ay + t * dy;
  return Math.hypot(px, py) <= r ? t * Math.sqrt(len2) : null;
}

const distM = (a: Pos, b: Pos) => {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b[1] - a[1]) / 2) ** 2 + Math.cos(r(a[1])) * Math.cos(r(b[1])) * Math.sin(r(b[0] - a[0]) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
};

// ---------------------------------------------------------------------------
// Squadron state
// ---------------------------------------------------------------------------

export interface Sq {
  in: SquadronIn;
  dmg: number;
  ammo: Map<string, number>;
  /** Damage taken from each shooting owner, to share out kills. */
  from: Map<string, number>;
}

export const alive = (q: Sq) => Math.max(0, q.in.aircraft - Math.floor(q.dmg / q.in.airframe.hp));

export function squadronState(q: SquadronIn): Sq {
  return { in: q, dmg: Math.max(0, q.damage), ammo: new Map(q.loadout.map((w) => [w.id, w.count * q.aircraft])), from: new Map() };
}

/** Missiles of one kind this squadron can still fire: limited by what is left and by surviving aircraft. */
const available = (q: Sq, w: AirWeaponIn) => Math.min(q.ammo.get(w.id) ?? 0, alive(q) * w.count);

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

/** Apply hits on squadrons (after a whole volley, so a volley is simultaneous). */
function landOnSquadrons(shots: AirShot[], targets: Map<string, Sq>, owners: Map<string, string | null>) {
  for (const sh of shots) {
    const t = targets.get(sh.target);
    if (!t || !sh.final) continue;
    t.dmg += sh.final;
    const o = owners.get(sh.shooter) ?? '';
    t.from.set(o, (t.from.get(o) ?? 0) + sh.final);
  }
}

/** One side's volley of air-to-air weapons of a guidance at the other side, spread over enemy squadrons. */
function volley(r: Roller, prefix: string, phase: string, from: Sq[], at: Sq[], guidance: 'radar' | 'ir' | 'gun', canFire: (q: Sq) => boolean): AirShot[] {
  const shots: AirShot[] = [];
  const targets = at.filter((q) => alive(q) > 0).sort((a, b) => a.in.id.localeCompare(b.in.id));
  if (!targets.length) return shots;
  let k = 0;
  for (const q of from) {
    if (alive(q) <= 0 || !canFire(q)) continue;
    if (guidance === 'gun') {
      if (q.in.airframe.gun_damage <= 0) continue;
      for (let i = 0; i < alive(q); i++) {
        const t = targets[k++ % targets.length];
        shots.push(shoot(r, `${prefix}:${phase}:${q.in.id}:gun:${i}`, { shooter: q.in.id, shooter_name: q.in.name, weapon: 'gun', guidance: 'gun', target: t.in.id,
          target_name: t.in.name, accuracy: q.in.airframe.gun_accuracy, cm: countermeasure('gun', t.in.airframe), damage: q.in.airframe.gun_damage }));
      }
      continue;
    }
    for (const w of q.in.loadout.filter((x) => x.guidance === guidance && x.targets.includes('air'))) {
      const n = available(q, w);
      q.ammo.set(w.id, (q.ammo.get(w.id) ?? 0) - n);
      for (let i = 0; i < n; i++) {
        const t = targets[k++ % targets.length];
        shots.push(shoot(r, `${prefix}:${phase}:${q.in.id}:${w.id}:${i}`, { shooter: q.in.id, shooter_name: q.in.name, weapon: w.name, guidance, target: t.in.id,
          target_name: t.in.name, accuracy: w.accuracy, cm: countermeasure(guidance, t.in.airframe), damage: w.damage }));
      }
    }
  }
  return shots;
}

/**
 * Air-to-air between two groups: detection both ways, BVR (radar missiles; who fires first by detection,
 * then by missile range, else together), WVR (IR missiles, together), guns (together).
 */
export function airFight(r: Roller, prefix: string, A: Sq[], B: Sq[], labelA: string, labelB: string): AirPhase[] {
  const phases: AirPhase[] = [];
  const all = new Map([...A, ...B].map((q) => [q.in.id, q]));
  const owners = new Map([...A, ...B].map((q) => [q.in.id, q.in.owner]));
  const live = (g: Sq[]) => g.filter((q) => alive(q) > 0);
  const radarRange = (g: Sq[]) => Math.max(0, ...live(g).flatMap((q) => q.in.loadout.filter((w) => w.guidance === 'radar' && w.targets.includes('air') && available(q, w) > 0).map((w) => w.range_m)));
  const detect = (g: Sq[], enemy: Sq[]) => Math.max(0, ...live(g).map((q) => q.in.airframe.radar_m)) * Math.max(0, ...live(enemy).map((q) => q.in.airframe.signature));
  if (!live(A).length || !live(B).length) return phases;

  // BVR
  const dA = detect(A, B), dB = detect(B, A);
  const fireA = Math.min(radarRange(A), dA), fireB = Math.min(radarRange(B), dB);
  if (fireA > 0 || fireB > 0) {
    const first = dA !== dB ? (dA > dB ? 'A' : 'B') : radarRange(A) !== radarRange(B) ? (radarRange(A) > radarRange(B) ? 'A' : 'B') : null;
    const can = (g: Sq[]) => (g === A ? fireA > 0 : fireB > 0);
    if (first) {
      const [X, Y, lx, ly] = first === 'A' ? [A, B, labelA, labelB] : [B, A, labelB, labelA];
      const s1 = can(X) ? volley(r, prefix, 'bvr1', X, Y, 'radar', () => true) : [];
      landOnSquadrons(s1, all, owners);
      phases.push({ label: `Beyond visual range: ${lx} detect first and fire`, shots: s1 });
      const s2 = can(Y) ? volley(r, prefix, 'bvr2', Y, X, 'radar', () => true) : [];
      landOnSquadrons(s2, all, owners);
      phases.push({ label: `Beyond visual range: ${ly} reply`, shots: s2 });
    } else {
      const s1 = [...(can(A) ? volley(r, prefix, 'bvr', A, B, 'radar', () => true) : []), ...(can(B) ? volley(r, prefix, 'bvr', B, A, 'radar', () => true) : [])];
      landOnSquadrons(s1, all, owners);
      phases.push({ label: 'Beyond visual range: both sides fire at once', shots: s1 });
    }
  }
  // WVR, then guns: simultaneous.
  for (const [phase, g, label] of [['wvr', 'ir', 'Within visual range: IR missiles'], ['gun', 'gun', 'Guns']] as const) {
    if (!live(A).length || !live(B).length) break;
    const shots = [...volley(r, prefix, phase, A, B, g, () => true), ...volley(r, prefix, phase, B, A, g, () => true)];
    landOnSquadrons(shots, all, owners);
    if (shots.length) phases.push({ label, shots });
  }
  return phases;
}

// ---------------------------------------------------------------------------
// The air phase of a turn
// ---------------------------------------------------------------------------

export function resolveAir(squadrons: SquadronIn[], ground: Map<string, GroundTarget>, r: Roller, saltFor: (pkg: string) => Roller): AirResult {
  const s = r.s;
  const qs = new Map(squadrons.map((q) => [q.id, squadronState(q)]));
  const failed: AirResult['log']['failed'] = [];
  const fail = (q: SquadronIn, reason: string) => failed.push({ squadron: q.id, name: q.name, reason });
  const ownerOf = new Map<string, string | null>([...squadrons.map((q) => [q.id, q.owner] as const), ...[...ground.values()].map((u) => [u.id, u.owner] as const)]);

  // Who flies, where to.
  const targetPos = (q: SquadronIn): Pos | null => {
    const m = q.mission!;
    if (m.type === 'strike') return ground.get(m.target_unit ?? '')?.pos ?? null;
    if (m.type === 'escort') {
      const st = squadrons.find((x) => x.id === m.escort_of);
      return st?.mission?.type === 'strike' ? ground.get(st.mission.target_unit ?? '')?.pos ?? null : null;
    }
    return m.target ?? null;
  };
  const flying = new Set<string>();
  for (const q of squadrons) {
    if (!q.mission) continue;
    if (!q.base_pos) { fail(q, 'no base: the squadron is stranded'); continue; }
    if (alive(qs.get(q.id)!) < 1) { fail(q, 'no aircraft left'); continue; }
    const to = targetPos(q);
    if (!to) { fail(q, q.mission.type === 'escort' ? 'the strike it was to escort is not flying' : 'target is gone'); continue; }
    const d = distM(q.base_pos, to);
    if (d > q.radius_m * 1.001 + 1) { fail(q, `target ${Math.round(d / 1000)} km away, radius ${Math.round(q.radius_m / 1000)} km with this loadout`); continue; }
    flying.add(q.id);
  }
  const fly = (id: string) => flying.has(id) ? qs.get(id)! : null;

  // Packages: each strike with its escorts; each recon alone.
  type Pkg = { id: string; kind: 'strike' | 'recon'; main: Sq; escorts: Sq[]; route: [Pos, Pos]; side: string };
  const pkgs: Pkg[] = [];
  for (const q of squadrons.filter((x) => flying.has(x.id) && (x.mission!.type === 'strike' || x.mission!.type === 'recon')).sort((a, b) => a.id.localeCompare(b.id))) {
    const escorts = squadrons.filter((e) => flying.has(e.id) && e.mission!.type === 'escort' && e.mission!.escort_of === q.id && e.side === q.side).map((e) => qs.get(e.id)!);
    pkgs.push({ id: q.id, kind: q.mission!.type as 'strike' | 'recon', main: qs.get(q.id)!, escorts, route: [q.base_pos!, targetPos(q)!], side: q.side });
  }
  const patrols = squadrons.filter((x) => flying.has(x.id) && x.mission!.type === 'patrol').map((x) => qs.get(x.id)!);

  const logs: PackageLog[] = [];
  const strikes: StrikeOut[] = [];
  const reveals: AirResult['reveals'] = [];
  for (const pk of pkgs) {
    const pr = saltFor(pk.id);
    const log: PackageLog = { id: pk.id, kind: pk.kind, label: `${pk.kind === 'strike' ? 'Strike' : 'Recon'} by ${pk.main.in.name}${pk.escorts.length ? ` with ${pk.escorts.map((e) => e.in.name).join(', ')}` : ''}`,
      route: pk.route, squadrons: [pk.main.in.id, ...pk.escorts.map((e) => e.in.id)], phases: [] };
    // 1. Interceptions, nearest to the base first. Escorts take on the interceptors before they reach the package.
    const crossing = patrols
      .filter((p) => p.in.side !== pk.side && alive(p) > 0)
      .map((p) => ({ p, at: routeCrosses(pk.route[0], pk.route[1], p.in.mission!.target!, p.in.mission!.radius_m ?? s.patrol_radius_km * 1000) }))
      .filter((x) => x.at != null)
      .sort((a, b) => a.at! - b.at! || a.p.in.id.localeCompare(b.p.in.id));
    for (const { p } of crossing) {
      if (alive(p) <= 0 || alive(pk.main) <= 0) continue;
      const esc = pk.escorts.filter((e) => alive(e) > 0);
      if (esc.length) {
        for (const ph of airFight(pr, `${pk.id}:${p.in.id}:esc`, esc, [p], 'escorts', 'interceptors')) log.phases.push({ ...ph, label: `${p.in.name} intercepts; escorts engage: ${ph.label}` });
      }
      if (alive(p) > 0) {
        for (const ph of airFight(pr, `${pk.id}:${p.in.id}:pkg`, [pk.main], [p], pk.kind === 'strike' ? 'the strike' : 'the recon flight', 'interceptors')) {
          log.phases.push({ ...ph, label: `${p.in.name} reaches ${pk.main.in.name}: ${ph.label}` });
        }
      }
    }
    const over = [pk.main, ...pk.escorts].filter((q) => alive(q) > 0);
    if (pk.kind === 'recon') {
      if (alive(pk.main) > 0) reveals.push({ owner: pk.main.in.owner, side: pk.side, squadron_name: pk.main.in.name, center: pk.route[1], radius_m: s.recon_radius_km * 1000 });
      logs.push(log);
      continue;
    }
    const target = ground.get(pk.main.in.mission!.target_unit!)!;
    const enemies = [...ground.values()].filter((u) => u.side !== pk.side && u.cur > 0 && u.template.category === 'ground').sort((a, b) => a.id.localeCompare(b.id));
    const P = pk.route[1];
    // 2a. SEAD: HARMs at emitting radar AA within range of the target area.
    const radarAA = enemies.filter((u) => u.emit && u.weapons.some((w) => w.anti_air && w.guidance === 'radar'));
    const harm: AirShot[] = [];
    let k = 0;
    for (const q of over) {
      for (const w of q.in.loadout.filter((x) => x.guidance === 'harm' && x.targets.includes('radar'))) {
        const inRange = radarAA.filter((u) => distM(u.pos, P) <= w.range_m);
        const n = available(q, w);
        if (!inRange.length || !n) continue;
        q.ammo.set(w.id, (q.ammo.get(w.id) ?? 0) - n);
        for (let i = 0; i < n; i++) {
          const u = inRange[k++ % inRange.length];
          const g = groundHit(w.damage, w.ap, u, s);
          harm.push(shoot(pr, `${pk.id}:sead:${q.in.id}:${w.id}:${i}`, { shooter: q.in.id, shooter_name: q.in.name, weapon: w.name, guidance: 'harm', target: u.id,
            target_name: u.name, accuracy: w.accuracy, cm: 0, damage: g.raw, mults: g.mults }));
        }
      }
    }
    for (const sh of harm) { const u = ground.get(sh.target)!; u.cur = Math.max(0, u.cur - sh.final); u.hit = true; }
    if (harm.length) log.phases.push({ label: 'SEAD: HARMs at emitting radar AA', shots: harm });
    // 2b. AA over the target: every enemy AA weapon in range of the target fires its shots at the package.
    const aa: AirShot[] = [];
    const pkgNow = over.filter((q) => alive(q) > 0);
    k = 0;
    for (const u of enemies.filter((x) => x.cur > 0)) {
      for (const w of u.weapons.filter((x) => x.anti_air && (x.air_shots ?? 0) > 0 && distM(u.pos, P) <= x.range_m)) {
        const dark = w.guidance === 'radar' && !u.emit;
        const acc = (w.accuracy ?? 0) * (dark ? s.dark_penalty : 1);
        for (let i = 0; i < (w.air_shots ?? 0) && pkgNow.length; i++) {
          const t = pkgNow[k++ % pkgNow.length];
          aa.push(shoot(pr, `${pk.id}:aa:${u.id}:${w.slot}:${i}`, { shooter: u.id, shooter_name: u.name, weapon: `${w.name}${dark ? ' (radar dark)' : ''}`, guidance: w.guidance ?? 'none',
            target: t.in.id, target_name: t.in.name, accuracy: acc, cm: countermeasure(w.guidance ?? 'none', t.in.airframe), damage: w.air_damage ?? 0 }));
        }
        u.fired = true;
      }
    }
    landOnSquadrons(aa, qs, ownerOf);
    if (aa.length) log.phases.push({ label: 'Anti-air over the target', shots: aa });
    // 3. The strike: surviving strike aircraft drop everything that can hit ground units, until the target is destroyed.
    const st: StrikeOut = { squadron: pk.main.in.id, squadron_name: pk.main.in.name, owner: pk.main.in.owner, target: target.id, target_name: target.name,
      shots: 0, hits: 0, damage: 0, destroyed: false, aborted: null };
    if (alive(pk.main) <= 0) st.aborted = 'shot down before reaching the target';
    else if (target.cur <= 0) st.aborted = 'target already destroyed';
    else {
      const strike: AirShot[] = [];
      for (const w of pk.main.in.loadout.filter((x) => x.guidance !== 'harm' && x.targets.includes('ground'))) {
        const n = available(pk.main, w);
        pk.main.ammo.set(w.id, (pk.main.ammo.get(w.id) ?? 0) - n);
        for (let i = 0; i < n && target.cur > 0; i++) {
          const g = groundHit(w.damage, w.ap, target, s);
          const cm = w.guidance === 'agm' ? target.template.aps ?? 0 : 0;
          const sh = shoot(pr, `${pk.id}:strike:${w.id}:${i}`, { shooter: pk.main.in.id, shooter_name: pk.main.in.name, weapon: w.name, guidance: w.guidance,
            target: target.id, target_name: target.name, accuracy: w.accuracy, cm, damage: g.raw, mults: g.mults });
          target.cur = Math.max(0, target.cur - sh.final);
          target.hit = true;
          strike.push(sh);
          st.shots++;
          if (sh.final > 0) (st.hits++, (st.damage += sh.final));
        }
      }
      if (!strike.length) st.aborted = 'no air-to-ground weapons loaded';
      st.destroyed = target.cur <= 0;
      log.phases.push({ label: `Strike on ${target.name}`, shots: strike });
    }
    strikes.push(st);
    logs.push(log);
  }

  // Results per squadron, and kills shared out by damage dealt.
  const kills = new Map<string, number>();
  const out: SquadronOut[] = [];
  for (const q of [...qs.values()].sort((a, b) => a.in.id.localeCompare(b.in.id))) {
    const after = alive(q);
    const lost = q.in.aircraft - after;
    const carried = after > 0 ? q.dmg - (q.in.aircraft - after) * q.in.airframe.hp : 0;
    out.push({ id: q.in.id, owner: q.in.owner, side: q.in.side, name: q.in.name, mission: flying.has(q.in.id) ? q.in.mission!.type : null,
      before: q.in.aircraft, after, damage: Math.max(0, Math.round(carried * 100) / 100), lost });
    const total = [...q.from.values()].reduce((a, b) => a + b, 0);
    const newLost = lost - Math.floor(q.in.damage / q.in.airframe.hp);
    if (total > 0 && newLost > 0) for (const [o, d] of q.from) if (o) kills.set(o, (kills.get(o) ?? 0) + (newLost * d) / total);
  }
  return {
    squadrons: out, strikes, reveals,
    kills: [...kills].map(([owner, c]) => ({ owner, count: Math.round(c) })).filter((x) => x.count > 0),
    log: { packages: logs, failed },
  };
}
