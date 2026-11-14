// Ground combat engine. Pure functions, no I/O: the owner's preview, the combat sandbox and the tests
// all run this one implementation. Inputs come from get_combat_inputs() (final positions after movement,
// terrain looked up by PostGIS, the settings in force for the turn); the result is stored with a
// fingerprint of those inputs and applied by push_turn exactly as reviewed.
//
// Every random number comes from a hash of (map, turn, engagement, round, salt, shot), so the same
// inputs and salts always give the same result, and one engagement can be re-rolled on its own.
import { resolveAir, type AirResult, type GroundTarget, type SquadronIn } from './air';
import type { Pos } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Terrain = 'open' | 'urban' | 'forest';

export interface CombatSettings {
  attacker_stationary: number;
  target_stationary: number;
  dug_in: number;
  dug_in_turns: number;
  flank_front_deg: number;
  flank_rear_deg: number;
  flank_side: number;
  flank_rear: number;
  veteran_max: number;
  veteran_encounters: number;
  variance: number;
  clamp: number;
  rounds_max: number;
  parting_round: boolean;
  recovery_pct: number;
  remove_destroyed: boolean;
  intel_km: number;
  band_fresh: number;
  band_damaged: number;
  band_heavy: number;
  terrain: Record<Terrain, number>;
  terrain_min_km2: { urban: number; forest: number };
  hit_min: number;
  hit_max: number;
  radius_penalty: number;
  dark_penalty: number;
  patrol_radius_km: number;
  patrol_radius_max_km: number;
  recon_radius_km: number;
}

/** Same values as private.combat_defaults() in setup.sql. */
export const DEFAULT_SETTINGS: CombatSettings = {
  attacker_stationary: 1.1, target_stationary: 0.9, dug_in: 0.85, dug_in_turns: 2,
  flank_front_deg: 60, flank_rear_deg: 60, flank_side: 1.15, flank_rear: 1.3,
  veteran_max: 1.1, veteran_encounters: 10, variance: 0.2, clamp: 1.5,
  rounds_max: 3, parting_round: true, recovery_pct: 10, remove_destroyed: true,
  intel_km: 100, band_fresh: 0.9, band_damaged: 0.6, band_heavy: 0.3,
  terrain: { open: 1.0, urban: 0.7, forest: 0.8 },
  terrain_min_km2: { urban: 25, forest: 50 },
  hit_min: 5, hit_max: 95, radius_penalty: 0.4, dark_penalty: 0.5,
  patrol_radius_km: 50, patrol_radius_max_km: 200, recon_radius_km: 25,
};

export interface WeaponIn {
  slot: number;
  id: string;
  name: string;
  attacks: number;
  ap: number;
  range_m: number;
  indirect: boolean;
  /** Anti-air: fires at aircraft over targets in range. */
  anti_air?: boolean;
  guidance?: 'none' | 'radar' | 'ir' | 'gun';
  accuracy?: number;
  air_damage?: number;
  air_shots?: number;
}

export interface UnitIn {
  id: string;
  name: string;
  owner: string | null;
  side: string;
  template: { id: string; name: string; max_strength: number; armor: number; category: 'ground' | 'air' | 'naval'; aps?: number; air_capacity?: number };
  weapons: WeaponIn[];
  start: Pos;
  pos: Pos;
  moved: boolean;
  heading: number | null;
  strength: number;
  experience: number;
  stationary_turns: number;
  terrain: Terrain;
  new: boolean;
  retreat: boolean;
  attacks: { slot: number; target: string }[];
  /** Radar on (emitting) this turn. Dark radar AA cannot be targeted by HARMs but aims worse. */
  emit?: boolean;
}

export interface EngagementIn {
  id: string;
  start_turn: number;
  turns_engaged: number;
  units: { fid: string; side: string }[];
}

export interface CombatInputs {
  map_id: string;
  turn: number;
  settings: CombatSettings;
  units: UnitIn[];
  engagements: EngagementIn[];
  /** Air: squadrons with their missions this turn. */
  squadrons?: SquadronIn[];
}

/** The owner's choices that shape a result: salts (re-rolls) and hand-edited damage per shot. */
export interface PreviewData {
  salt: string;
  salts: Record<string, string>;
  edits: Record<string, number>;
}

export interface Shot {
  key: string;
  attacker: string;
  attacker_name: string;
  slot: number;
  weapon: string;
  target: string;
  target_name: string;
  base: number;
  mults: [string, number][];
  roll: number;
  raw: number;
  computed: number;
  final: number;
  edited: boolean;
}

export interface Phase {
  label: string;
  shots: Shot[];
}

export interface RoundLog {
  n: number;
  phases: Phase[];
  damage: number;
}

export interface EngagementLog {
  id: string;
  new: boolean;
  start_turn: number;
  turns_engaged: number;
  rounds: RoundLog[];
  parting: Phase | null;
  status: 'active' | 'ended';
  end_reason: string | null;
  units: { fid: string; side: string }[];
  retreated: string[];
}

export interface FailedAttack {
  attacker: string;
  attacker_name: string;
  slot: number;
  weapon: string;
  target: string;
  target_name: string;
  reason: string;
}

export interface UnitOut {
  id: string;
  owner: string | null;
  name: string;
  side: string;
  max: number;
  before: number;
  after: number;
  destroyed: boolean;
  fired: boolean;
  hit: boolean;
  experience: number;
  stationary_turns: number;
  recovered: number;
  pos: Pos;
}

export interface EngagementOut {
  id: string;
  status: 'active' | 'ended';
  new: boolean;
  start_turn: number;
  turns_engaged: number;
  end_reason: string | null;
  rounds: number;
  units: { fid: string; side: string }[];
}

export interface CombatResult {
  turn: number;
  units: UnitOut[];
  engagements: EngagementOut[];
  log: { indirect: Phase | null; engagements: EngagementLog[]; failed: FailedAttack[] };
  /** The air phase, resolved before ground combat. */
  air?: AirResult;
}

// ---------------------------------------------------------------------------
// Damage
// ---------------------------------------------------------------------------

/** Per weapon per round, before multipliers: Attacks − Armor × (Armor − AP) / AP, clamped to [0, clamp × Attacks]. */
export function baseDamage(attacks: number, ap: number, armor: number, clamp = 1.5): number {
  let base: number;
  if (armor <= 0) base = attacks;
  else if (ap <= 0) base = 0;
  else base = attacks - (armor * (armor - ap)) / ap;
  return Math.min(Math.max(base, 0), clamp * attacks);
}

/** Round up, ignoring floating-point dust: 80 × 0.9 is 72.00000000000001 in binary and must stay 72. */
export const ceilDamage = (x: number) => Math.max(0, Math.ceil(x - 1e-9));

const norm = (d: number) => ((d % 360) + 360) % 360;
const rad = (d: number) => (d * Math.PI) / 180;

/** Initial bearing from a to b, degrees clockwise from north. */
export function bearingDeg(a: Pos, b: Pos): number {
  const [l1, p1] = [rad(a[0]), rad(a[1])];
  const [l2, p2] = [rad(b[0]), rad(b[1])];
  const y = Math.sin(l2 - l1) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(l2 - l1);
  return norm((Math.atan2(y, x) * 180) / Math.PI);
}

/** Great-circle distance in metres (same formula and radius as private.dist_m). */
export function distM(a: Pos, b: Pos): number {
  const dLat = rad(b[1] - a[1]);
  const dLng = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type Flank = 'front' | 'side' | 'rear';

/** Where the attacker sits relative to the target's facing. A target with no heading is always hit in front. */
export function flankOf(targetHeading: number | null, bearingToAttacker: number, s: Pick<CombatSettings, 'flank_front_deg' | 'flank_rear_deg'>): Flank {
  if (targetHeading == null) return 'front';
  const d = Math.abs(((bearingToAttacker - targetHeading + 540) % 360) - 180); // 0 = dead ahead, 180 = directly behind
  if (d <= s.flank_front_deg) return 'front';
  if (d >= 180 - s.flank_rear_deg) return 'rear';
  return 'side';
}

const progress = (exp: number, s: CombatSettings) => (s.veteran_encounters > 0 ? Math.min(1, Math.max(0, exp) / s.veteran_encounters) : 1);
export const veteranBonus = (exp: number, s: CombatSettings) => 1 + (s.veteran_max - 1) * progress(exp, s);
export const varianceSpan = (exp: number, s: CombatSettings) => s.variance * (1 - progress(exp, s));

export interface ShotConditions {
  attacks: number;
  ap: number;
  armor: number;
  attackerStationary: boolean;
  targetStationary: boolean;
  /** Consecutive stationary turns of the target, counting this one. */
  targetStationaryTurns: number;
  /** Attacker's current strength ÷ its max strength. */
  strengthRatio: number;
  terrain: Terrain;
  flank: Flank;
  experience: number;
  /** Uniform random number in [0, 1). */
  rand: number;
}

/** One weapon firing once: base damage, every multiplier, the roll and the result. */
export function computeShot(c: ShotConditions, s: CombatSettings): { base: number; mults: [string, number][]; roll: number; raw: number; final: number } {
  const base = baseDamage(c.attacks, c.ap, c.armor, s.clamp);
  const mults: [string, number][] = [];
  if (c.attackerStationary) mults.push(['attacker stationary', s.attacker_stationary]);
  if (c.targetStationary) mults.push(['target stationary', s.target_stationary]);
  if (c.targetStationary && c.targetStationaryTurns >= s.dug_in_turns) mults.push(['target dug in', s.dug_in]);
  mults.push(['attacker strength', c.strengthRatio]);
  mults.push([`terrain: ${c.terrain}`, s.terrain[c.terrain] ?? 1]);
  mults.push([`flank: ${c.flank}`, c.flank === 'rear' ? s.flank_rear : c.flank === 'side' ? s.flank_side : 1]);
  mults.push(['veteran', veteranBonus(c.experience, s)]);
  const v = varianceSpan(c.experience, s);
  const roll = 1 - v + 2 * v * c.rand;
  mults.push(['variance roll', roll]);
  const raw = mults.reduce((x, [, m]) => x * m, base);
  return { base, mults, roll, raw, final: ceilDamage(raw) };
}

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

/** 53-bit string hash (cyrb53). */
export function hash53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Uniform in [0, 1) from the given parts. */
export const rand01 = (...parts: (string | number)[]) => hash53(parts.join('|')) / 2 ** 53;

/** A stable UUID (v4 layout) from a string, for engagements that start this turn. */
export function stableUuid(str: string): string {
  const hex = [1, 2, 3].map((s) => hash53(str, s).toString(16).padStart(14, '0')).join('').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = '89ab'[parseInt(hex[16], 16) & 3];
  const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export const newSalt = () => Math.random().toString(36).slice(2, 10);

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

interface Live extends UnitIn {
  cur: number;
  max: number;
  stationary: boolean;
  fired: boolean;
  hit: boolean;
}

/** All combat for one turn. Movement has already happened: positions in `inputs` are final. */
export function resolveCombat(inputs: CombatInputs, data: PreviewData): CombatResult {
  const s: CombatSettings = { ...DEFAULT_SETTINGS, ...inputs.settings, terrain: { ...DEFAULT_SETTINGS.terrain, ...inputs.settings?.terrain } };
  const units = new Map<string, Live>();
  for (const u of inputs.units) {
    const max = u.template.max_strength;
    units.set(u.id, { ...u, cur: Math.min(max, Math.max(0, u.strength)), max, stationary: !u.moved && !u.new, fired: false, hit: false });
  }
  const ground = (u: Live | undefined): u is Live => !!u && u.template.category === 'ground' && u.cur > 0;
  const failed: FailedAttack[] = [];
  const weaponOf = (u: Live, slot: number) => u.weapons.find((w) => w.slot === slot);

  // ---- 0. Air: interceptions, SEAD and AA, strikes, recon. Ground combat then runs on what is left.
  let air: AirResult | undefined;
  if (inputs.squadrons?.length) {
    const roller = (salt: string) => ({ s, edits: data.edits, rand: (...parts: (string | number)[]) => rand01(inputs.map_id, inputs.turn, 'air', salt, ...parts) });
    const targets = new Map([...units.values()].filter((u) => u.template.category === 'ground').map((u) => [u.id, u as unknown as GroundTarget]));
    for (const u of targets.values()) u.emit = u.emit ?? true;
    air = resolveAir(inputs.squadrons, targets, roller(data.salt), (pkg) => roller(data.salts[pkg] ?? data.salt));
  }

  /** Fire one weapon. Damage is returned, not applied, so rounds can be simultaneous. */
  const fire = (a: Live, w: WeaponIn, t: Live, eid: string, round: number | string, phase: string, salt: string, strength: number): Shot => {
    const key = `${eid}:${round}:${phase}:${a.id}:${w.slot}`;
    const flank = flankOf(t.heading, bearingDeg(t.pos, a.pos), s);
    const r = computeShot({
      attacks: w.attacks, ap: w.ap, armor: t.template.armor,
      attackerStationary: a.stationary, targetStationary: t.stationary,
      targetStationaryTurns: t.stationary_turns + (t.stationary ? 1 : 0),
      strengthRatio: a.max > 0 ? strength / a.max : 0,
      terrain: t.terrain, flank, experience: a.experience,
      rand: rand01(inputs.map_id, inputs.turn, eid, round, salt, phase, a.id, w.slot, t.id),
    }, s);
    const edited = Object.prototype.hasOwnProperty.call(data.edits, key);
    return {
      key, attacker: a.id, attacker_name: a.name, slot: w.slot, weapon: w.name, target: t.id, target_name: t.name,
      base: r.base, mults: r.mults, roll: r.roll, raw: r.raw, computed: r.final,
      final: edited ? Math.max(0, Math.round(data.edits[key])) : r.final, edited,
    };
  };
  const applyShots = (shots: Shot[]) => {
    let total = 0;
    for (const sh of shots) {
      const t = units.get(sh.target)!;
      t.cur = Math.max(0, t.cur - sh.final);
      units.get(sh.attacker)!.fired = true;
      t.hit = true;
      total += sh.final;
    }
    return total;
  };

  // ---- 1. Indirect fire: stationary firers, declared targets in range, once, no engagement, no return fire.
  const indirect: Shot[] = [];
  for (const a of units.values()) {
    if (!ground(a) || a.retreat) continue;
    for (const at of a.attacks) {
      const w = weaponOf(a, at.slot);
      if (!w?.indirect) continue;
      const t = units.get(at.target);
      const fail = (reason: string) => failed.push({ attacker: a.id, attacker_name: a.name, slot: at.slot, weapon: w.name, target: at.target, target_name: t?.name ?? 'unknown', reason });
      if (!ground(t)) fail('target is not a ground unit on the map');
      else if (!a.stationary) fail('indirect fire needs the firing unit to stay put this turn');
      else if (distM(a.pos, t.pos) > w.range_m) fail(`target out of range (${Math.round(distM(a.pos, t.pos))} m, range ${Math.round(w.range_m)} m)`);
      else indirect.push(fire(a, w, t, 'indirect', 0, 'indirect', data.salt, a.cur));
    }
  }
  applyShots(indirect);

  // ---- 2. Direct attacks declared this turn, checked against final positions.
  type Decl = { a: Live; w: WeaponIn; t: Live };
  const declared: Decl[] = [];
  for (const a of units.values()) {
    if (!ground(a) || a.retreat) continue;
    for (const at of a.attacks) {
      const w = weaponOf(a, at.slot);
      if (!w || w.indirect) continue;
      const t = units.get(at.target);
      const fail = (reason: string) => failed.push({ attacker: a.id, attacker_name: a.name, slot: at.slot, weapon: w.name, target: at.target, target_name: t?.name ?? 'unknown', reason });
      if (!ground(t)) fail('target is not a ground unit on the map');
      else if (t.side === a.side) fail('target is on the same side');
      else if (distM(a.pos, t.pos) > w.range_m) fail(`target out of range (${Math.round(distM(a.pos, t.pos))} m, range ${Math.round(w.range_m)} m)`);
      else declared.push({ a, w, t });
    }
  }

  // ---- 3. Engagements: running ones carry on; a declared attack starts one or joins (merges) the ones its units are in.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)!)!);
      x = parent.get(x)!;
    }
    return x;
  };
  const join = (x: string, y: string) => {
    for (const k of [x, y]) if (!parent.has(k)) parent.set(k, k);
    const [a, b] = [find(x), find(y)].sort();
    if (a !== b) parent.set(b, a);
  };
  const prev = [...inputs.engagements].sort((a, b) => a.id.localeCompare(b.id));
  const ended: EngagementLog[] = [];
  for (const e of prev) {
    const alive = e.units.map((x) => x.fid).filter((id) => ground(units.get(id)));
    if (new Set(alive.map((id) => units.get(id)!.side)).size < 2) {
      ended.push({ id: e.id, new: false, start_turn: e.start_turn, turns_engaged: e.turns_engaged, rounds: [], parting: null, status: 'ended',
        end_reason: 'no opponents left', units: e.units, retreated: [] });
      continue;
    }
    for (const id of alive) join(alive[0], id);
  }
  for (const d of declared) join(d.a.id, d.t.id);

  const groups = new Map<string, string[]>();
  for (const id of parent.keys()) {
    if (!ground(units.get(id))) continue;
    const r = find(id);
    groups.set(r, [...(groups.get(r) ?? []), id]);
  }
  const logs: EngagementLog[] = [];
  for (const members of [...groups.values()].map((m) => m.sort()).sort((a, b) => a[0].localeCompare(b[0]))) {
    const set = new Set(members);
    const olds = prev.filter((e) => e.units.some((x) => set.has(x.fid)) && !ended.some((x) => x.id === e.id));
    const isNew = olds.length === 0;
    const base = olds.sort((a, b) => a.start_turn - b.start_turn || a.id.localeCompare(b.id))[0];
    const id = base?.id ?? stableUuid(`${inputs.map_id}|${inputs.turn}|${members.join(',')}`);
    // Engagements merged into this one are recorded as ended.
    for (const o of olds.slice(1)) {
      ended.push({ id: o.id, new: false, start_turn: o.start_turn, turns_engaged: o.turns_engaged, rounds: [], parting: null, status: 'ended',
        end_reason: `merged into engagement ${id.slice(0, 8)}`, units: o.units, retreated: [] });
    }
    const turns = isNew ? 1 : Math.max(...olds.map((o) => o.turns_engaged)) + 1;
    logs.push(fight(id, isNew, base?.start_turn ?? inputs.turn, turns, members));
  }

  function fight(eid: string, isNew: boolean, startTurn: number, turns: number, members: string[]): EngagementLog {
    const salt = data.salts[eid] ?? data.salt;
    let inFight = members.map((id) => units.get(id)!).filter(ground);
    const log: EngagementLog = { id: eid, new: isNew, start_turn: startTurn, turns_engaged: turns, rounds: [], parting: null, status: 'active', end_reason: null,
      units: inFight.map((u) => ({ fid: u.id, side: u.side })), retreated: [] };
    const enemiesOf = (u: Live) => inFight.filter((x) => x.side !== u.side && ground(x));
    const sides = () => new Set(inFight.filter(ground).map((x) => x.side)).size;
    const end = (reason: string) => ((log.status = 'ended'), (log.end_reason = reason));

    /** Weapons for one unit this round: declared targets that are in this fight, else each weapon at the nearest enemy in range. */
    const targetsFor = (u: Live, only?: Set<string>): { w: WeaponIn; t: Live }[] => {
      const mine = declared.filter((d) => d.a === u && inFight.includes(d.t) && ground(d.t) && (!only || only.has(d.t.id)));
      if (mine.length && !only) return mine.map((d) => ({ w: d.w, t: d.t }));
      const foes = enemiesOf(u).filter((x) => !only || only.has(x.id)).sort((a, b) => distM(u.pos, a.pos) - distM(u.pos, b.pos) || a.id.localeCompare(b.id));
      const use = new Map<string, number>();
      const out: { w: WeaponIn; t: Live }[] = [];
      for (const w of u.weapons.filter((x) => !x.indirect)) {
        // Nearest first, spreading weapons over engagers: the least-used enemy in range, nearest on ties.
        const inRange = foes.filter((f) => only || distM(u.pos, f.pos) <= w.range_m);
        if (!inRange.length) continue;
        const t = [...inRange].sort((a, b) => (use.get(a.id) ?? 0) - (use.get(b.id) ?? 0))[0];
        use.set(t.id, (use.get(t.id) ?? 0) + 1);
        out.push({ w, t });
      }
      return out;
    };

    // Retreats: the leaving units take one parting round from the enemies, at the positions they left from.
    const leaving = inFight.filter((u) => u.retreat);
    if (leaving.length) {
      const leave = new Set(leaving.map((u) => u.id));
      if (s.parting_round) {
        const shots: Shot[] = [];
        for (const u of inFight.filter((x) => !leave.has(x.id) && ground(x))) {
          for (const { w, t } of targetsFor(u, leave)) {
            const final = t.pos;
            t.pos = t.start; // fired at where it left from; range does not apply
            shots.push(fire(u, w, t, eid, 'parting', 'parting', salt, u.cur));
            t.pos = final;
          }
        }
        applyShots(shots);
        log.parting = { label: 'Parting fire at retreating units', shots };
      }
      log.retreated = leaving.map((u) => u.id);
      inFight = inFight.filter((u) => !leave.has(u.id));
      if (sides() < 2) end(leaving.length ? 'retreat' : 'no opponents left');
    }

    const rounds = Math.min(turns, Math.max(1, s.rounds_max));
    for (let n = 1; n <= rounds && log.status === 'active'; n++) {
      const r: RoundLog = { n, phases: [], damage: 0 };
      const alive = inFight.filter(ground);
      const attackers = new Set(declared.filter((d) => alive.includes(d.a)).map((d) => d.a.id));
      const meeting = declared.some((d) => attackers.has(d.a.id) && attackers.has(d.t.id) && d.a.side !== d.t.side);
      if (n === 1 && isNew && !meeting && attackers.size) {
        // First strike: attackers fire, then defenders return fire at their reduced strength.
        const first = alive.filter((u) => attackers.has(u.id)).flatMap((u) => targetsFor(u).map(({ w, t }) => fire(u, w, t, eid, n, 'attack', salt, u.cur)));
        r.damage += applyShots(first);
        r.phases.push({ label: 'Attacker fires first', shots: first });
        const back = alive.filter((u) => !attackers.has(u.id) && ground(u))
          .flatMap((u) => targetsFor(u).map(({ w, t }) => fire(u, w, t, eid, n, 'return', salt, u.cur)));
        r.damage += applyShots(back);
        r.phases.push({ label: 'Defender returns fire', shots: back });
      } else {
        // Simultaneous: everyone fires from the strength they had at the start of the round.
        const shots = alive.flatMap((u) => targetsFor(u).map(({ w, t }) => fire(u, w, t, eid, n, 'all', salt, u.cur)));
        r.damage += applyShots(shots);
        r.phases.push({ label: n === 1 && isNew ? 'Meeting engagement: both sides fire at once' : 'Both sides fire at once', shots });
      }
      log.rounds.push(r);
      if (sides() < 2) end('destroyed');
      else if (r.damage === 0) end('stalemate');
    }
    log.units = log.units.filter((x) => !log.retreated.includes(x.fid) && ground(units.get(x.fid)));
    if (log.status === 'active' && sides() < 2) end('destroyed');
    return log;
  }

  // ---- 4. End of turn: experience, stationary count, recovery.
  const active = new Set(logs.filter((l) => l.status === 'active').flatMap((l) => l.units.map((x) => x.fid)));
  // A unit hit from the air this turn does not recover this turn either.
  for (const st of air?.strikes ?? []) if (st.hits > 0) active.add(st.target);
  const out: UnitOut[] = [];
  for (const u of [...units.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const destroyed = u.cur <= 0;
    let after = u.cur;
    let recovered = 0;
    if (!destroyed && u.stationary && !active.has(u.id) && after < u.max) {
      recovered = Math.min(u.max - after, (u.max * s.recovery_pct) / 100);
      after += recovered;
    }
    out.push({
      id: u.id, owner: u.owner, name: u.name, side: u.side, max: u.max, before: Math.min(u.max, u.strength), after, destroyed,
      fired: u.fired, hit: u.hit, experience: u.experience + (u.fired || u.hit ? 1 : 0),
      stationary_turns: u.stationary ? u.stationary_turns + 1 : 0, recovered, pos: u.pos,
    });
  }
  const all = [...ended, ...logs];
  return {
    turn: inputs.turn,
    units: out,
    engagements: all.map((l) => ({ id: l.id, status: l.status, new: l.new, start_turn: l.start_turn, turns_engaged: l.turns_engaged,
      end_reason: l.end_reason, rounds: l.rounds.length, units: l.units })),
    log: { indirect: indirect.length ? { label: 'Indirect fire', shots: indirect } : null, engagements: all, failed },
    ...(air ? { air } : {}),
  };
}

/** Intel band for a strength ratio, as private.band() in setup.sql. */
export function band(ratio: number, s: Pick<CombatSettings, 'band_fresh' | 'band_damaged' | 'band_heavy'>): string {
  if (ratio <= 0) return 'destroyed';
  if (ratio >= s.band_fresh) return 'fresh';
  if (ratio >= s.band_damaged) return 'damaged';
  if (ratio >= s.band_heavy) return 'heavily damaged';
  return 'critical';
}
