// The combat engine (app/lib/combat.ts): the required damage numbers, every multiplier, and turn resolution.
import { describe, expect, it } from 'vitest';
import {
  baseDamage, bearingDeg, ceilDamage, computeShot, DEFAULT_SETTINGS, flankOf, resolveCombat, stableUuid, varianceSpan, veteranBonus,
  type CombatInputs, type CombatSettings, type UnitIn,
} from '../app/lib/combat';

/** Variance off and veteran bonus at 1.0, as the required tests specify. */
const FLAT: CombatSettings = { ...DEFAULT_SETTINGS, variance: 0, veteran_max: 1 };
const shot = (o: Partial<Parameters<typeof computeShot>[0]>, s = FLAT) => computeShot({
  attacks: 100, ap: 10, armor: 0, attackerStationary: false, targetStationary: false, targetStationaryTurns: 0,
  strengthRatio: 1, terrain: 'open', flank: 'front', experience: 0, rand: 0.5, ...o }, s);

describe('damage formula', () => {
  it('required: heavy tank 120mm vs medium tank, attacker stationary = 113', () => {
    expect(shot({ attacks: 100, ap: 28, armor: 25, attackerStationary: true }).final).toBe(113);
  });
  it('required: IFV 30mm vs heavy tank, target stationary = 72', () => {
    expect(shot({ attacks: 125, ap: 12, armor: 30, targetStationary: true, targetStationaryTurns: 1 }).final).toBe(72);
  });
  it('edge cases and clamp', () => {
    expect(baseDamage(100, 0, 0)).toBe(100);           // armor 0
    expect(baseDamage(100, 0, 20)).toBe(0);            // AP 0 vs armor
    expect(baseDamage(100, 5, 40)).toBe(0);            // negative clamps to 0
    expect(baseDamage(100, 200, 50)).toBe(137.5);      // AP above armor adds damage (100 + 50·150/200) …
    expect(baseDamage(100, 1000, 100)).toBe(150);      // … and a huge AP edge is capped at 150
    expect(ceilDamage(80 * 0.9)).toBe(72);
    expect(ceilDamage(72.01)).toBe(73);
  });
  it('multipliers: dug in stacks with stationary, terrain, flank, strength', () => {
    const r = shot({ attacks: 100, targetStationary: true, targetStationaryTurns: 2, terrain: 'urban', flank: 'rear', strengthRatio: 0.5 });
    expect(r.mults.map(([n]) => n)).toEqual(expect.arrayContaining(['target stationary', 'target dug in', 'terrain: urban', 'flank: rear', 'attacker strength']));
    expect(r.final).toBe(ceilDamage(100 * 0.9 * 0.85 * 0.5 * 0.7 * 1.3));
    expect(shot({ targetStationary: true, targetStationaryTurns: 1 }).mults.some(([n]) => n === 'target dug in')).toBe(false);
  });
  it('flanking: ±60° front, ±60° around the back is rear, the rest side; no heading = front', () => {
    expect(flankOf(0, 50, DEFAULT_SETTINGS)).toBe('front');
    expect(flankOf(0, 300, DEFAULT_SETTINGS)).toBe('front');
    expect(flankOf(0, 90, DEFAULT_SETTINGS)).toBe('side');
    expect(flankOf(0, 180, DEFAULT_SETTINGS)).toBe('rear');
    expect(flankOf(350, 160, DEFAULT_SETTINGS)).toBe('rear');
    expect(flankOf(null, 180, DEFAULT_SETTINGS)).toBe('front');
    expect(Math.round(bearingDeg([0, 0], [1, 0]))).toBe(90);
  });
  it('veteran bonus and variance scale with experience', () => {
    expect(veteranBonus(0, DEFAULT_SETTINGS)).toBe(1);
    expect(veteranBonus(5, DEFAULT_SETTINGS)).toBeCloseTo(1.05);
    expect(veteranBonus(30, DEFAULT_SETTINGS)).toBeCloseTo(1.1);
    expect(varianceSpan(0, DEFAULT_SETTINGS)).toBeCloseTo(0.2);
    expect(varianceSpan(10, DEFAULT_SETTINGS)).toBe(0);
    const lo = shot({ rand: 0 }, DEFAULT_SETTINGS).raw, hi = shot({ rand: 0.999999 }, DEFAULT_SETTINGS).raw;
    expect(lo).toBeCloseTo(80);
    expect(hi).toBeCloseTo(120, 3);
  });
  it('stable ids', () => {
    expect(stableUuid('a')).toBe(stableUuid('a'));
    expect(stableUuid('a')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

// ---- turn resolution ----
const W = (slot: number, attacks: number, ap: number, range_m = 5000, indirect = false) => ({ slot, id: `w${slot}`, name: `gun${slot}`, attacks, ap, range_m, indirect });
const unit = (id: string, side: string, pos: [number, number], o: Partial<UnitIn> = {}): UnitIn => ({
  id, name: id, owner: side, side, template: { id: 't', name: 'tank', max_strength: 1000, armor: 25, category: 'ground' },
  weapons: [W(0, 100, 28)], start: pos, pos, moved: false, heading: null, strength: 1000, experience: 0, stationary_turns: 0,
  terrain: 'open', new: false, retreat: false, attacks: [], ...o,
});
const inputs = (units: UnitIn[], o: Partial<CombatInputs> = {}): CombatInputs => ({ map_id: 'm', turn: 1, settings: FLAT, units, engagements: [], ...o });
const data = { salt: 's', salts: {}, edits: {} };
const km = (k: number) => k / 111.195;   // degrees of latitude for k km

describe('turn resolution', () => {
  it('first strike: the attacker fires, then the defender returns fire at its reduced strength', () => {
    const r = resolveCombat(inputs([unit('a', 'blue', [0, 0], { attacks: [{ slot: 0, target: 'b' }] }), unit('b', 'red', [0, km(1)])]), data);
    const e = r.log.engagements[0];
    expect(e.new).toBe(true);
    expect(e.rounds).toHaveLength(1);                           // first turn of contact: 1 round
    expect(e.rounds[0].phases.map((p) => p.label)).toEqual(['Attacker fires first', 'Defender returns fire']);
    const first = e.rounds[0].phases[0].shots[0].final;          // 103 × 1.1 stationary × 0.9 target stationary
    expect(first).toBe(ceilDamage(baseDamage(100, 28, 25) * 1.1 * 0.9));
    const back = e.rounds[0].phases[1].shots[0];
    expect(back.mults.find(([n]) => n === 'attacker strength')![1]).toBeCloseTo((1000 - first) / 1000);
    expect(r.units.find((u) => u.id === 'b')!.after).toBe(1000 - first);
    expect(r.units.every((u) => u.experience === 1)).toBe(true);
    expect(r.engagements[0]).toMatchObject({ status: 'active', turns_engaged: 1, rounds: 1 });
  });

  it('meeting engagement: both declared on each other, simultaneous from round 1', () => {
    const r = resolveCombat(inputs([unit('a', 'blue', [0, 0], { attacks: [{ slot: 0, target: 'b' }] }), unit('b', 'red', [0, km(1)], { attacks: [{ slot: 0, target: 'a' }] })]), data);
    expect(r.log.engagements[0].rounds[0].phases[0].label).toMatch(/Meeting/);
    expect(r.units[0].after).toBe(r.units[1].after);
  });

  it('out of range attacks fail and are logged; no engagement', () => {
    const r = resolveCombat(inputs([unit('a', 'blue', [0, 0], { attacks: [{ slot: 0, target: 'b' }] }), unit('b', 'red', [0, km(10)])]), data);
    expect(r.log.failed[0].reason).toMatch(/out of range/);
    expect(r.engagements).toHaveLength(0);
  });

  it('rounds escalate with duration (capped) and the engagement persists', () => {
    const e = { id: '00000000-0000-4000-8000-000000000001', start_turn: 1, turns_engaged: 4, units: [{ fid: 'a', side: 'blue' }, { fid: 'b', side: 'red' }] };
    const r = resolveCombat(inputs([unit('a', 'blue', [0, 0]), unit('b', 'red', [0, km(1)])], { engagements: [e] }), data);
    expect(r.log.engagements[0].rounds).toHaveLength(3);
    expect(r.engagements[0]).toMatchObject({ id: e.id, turns_engaged: 5, status: 'active', new: false });
    // Return fire with no declarations: both sides fire every round.
    expect(r.log.engagements[0].rounds.every((x) => x.phases[0].shots.length === 2)).toBe(true);
  });

  it('stalemate ends an engagement; destruction ends it', () => {
    const tough = { id: 't', name: 'bunker', max_strength: 1000, armor: 200, category: 'ground' as const };
    const e = { id: 'e1', start_turn: 1, turns_engaged: 1, units: [{ fid: 'a', side: 'blue' }, { fid: 'b', side: 'red' }] };
    const r = resolveCombat(inputs([unit('a', 'blue', [0, 0], { template: tough }), unit('b', 'red', [0, km(1)], { template: tough })], { engagements: [e] }), data);
    expect(r.engagements[0]).toMatchObject({ status: 'ended', end_reason: 'stalemate' });
    const r2 = resolveCombat(inputs([unit('a', 'blue', [0, 0], { attacks: [{ slot: 0, target: 'b' }] }), unit('b', 'red', [0, km(1)], { strength: 50 })]), data);
    expect(r2.units.find((u) => u.id === 'b')).toMatchObject({ destroyed: true, after: 0 });
    expect(r2.engagements[0]).toMatchObject({ status: 'ended', end_reason: 'destroyed' });
  });

  it('retreat: one parting round, then the unit leaves and the engagement ends', () => {
    const e = { id: 'e1', start_turn: 1, turns_engaged: 2, units: [{ fid: 'a', side: 'blue' }, { fid: 'b', side: 'red' }] };
    const r = resolveCombat(inputs([unit('a', 'blue', [0, 0]), unit('b', 'red', [0, km(30)], { start: [0, km(1)], moved: true, retreat: true })], { engagements: [e] }), data);
    const log = r.log.engagements[0];
    expect(log.parting?.shots).toHaveLength(1);                  // fired at the start position, out of range now
    expect(log.rounds).toHaveLength(0);
    expect(r.engagements[0]).toMatchObject({ status: 'ended', end_reason: 'retreat' });
    const off = resolveCombat(inputs([unit('a', 'blue', [0, 0]), unit('b', 'red', [0, km(30)], { start: [0, km(1)], moved: true, retreat: true })],
      { engagements: [e], settings: { ...FLAT, parting_round: false } }), data);
    expect(off.log.engagements[0].parting).toBeNull();
  });

  it('indirect fire: stationary only, in range, no engagement and no return fire', () => {
    const arty = { weapons: [W(0, 50, 10, 30000, true)], attacks: [{ slot: 0, target: 'b' }] };
    const r = resolveCombat(inputs([unit('a', 'blue', [0, 0], arty), unit('b', 'red', [0, km(20)])]), data);
    expect(r.log.indirect?.shots).toHaveLength(1);
    expect(r.engagements).toHaveLength(0);
    expect(r.units.find((u) => u.id === 'a')!.after).toBe(1000);
    const moving = resolveCombat(inputs([unit('a', 'blue', [0, 0], { ...arty, moved: true }), unit('b', 'red', [0, km(20)])]), data);
    expect(moving.log.failed[0].reason).toMatch(/stay put/);
  });

  it('stacking: two attackers on one target add up and join one engagement', () => {
    const r = resolveCombat(inputs([
      unit('a1', 'blue', [0, 0], { attacks: [{ slot: 0, target: 'b' }] }),
      unit('a2', 'blue', [km(1), 0], { attacks: [{ slot: 0, target: 'b' }] }),
      unit('b', 'red', [0, km(1)]),
    ]), data);
    expect(r.engagements).toHaveLength(1);
    expect(r.engagements[0].units).toHaveLength(3);
    const hits = r.log.engagements[0].rounds[0].phases[0].shots.filter((x) => x.target === 'b');
    expect(r.units.find((u) => u.id === 'b')!.after).toBe(1000 - hits.reduce((a, x) => a + x.final, 0));
  });

  it('air and naval units neither fire nor get hit; recovery heals stationary units out of combat', () => {
    const air = { template: { id: 'j', name: 'jet', max_strength: 500, armor: 5, category: 'air' as const } };
    const r = resolveCombat(inputs([unit('a', 'blue', [0, 0], { attacks: [{ slot: 0, target: 'b' }] }), unit('b', 'red', [0, km(1)], air), unit('c', 'red', [5, 5], { strength: 500 })]), data);
    expect(r.engagements).toHaveLength(0);
    expect(r.units.find((u) => u.id === 'c')).toMatchObject({ after: 600, recovered: 100, stationary_turns: 1 });
  });

  it('is reproducible; a new salt re-rolls; a hand edit replaces one shot', () => {
    const u = [unit('a', 'blue', [0, 0], { attacks: [{ slot: 0, target: 'b' }] }), unit('b', 'red', [0, km(1)])];
    const live = { ...inputs(u), settings: DEFAULT_SETTINGS };
    const r1 = resolveCombat(live, data), r2 = resolveCombat(live, data);
    expect(r1).toEqual(r2);
    const rolls = new Set(['a', 'b', 'c', 'd', 'e'].map((salt) => resolveCombat(live, { ...data, salt }).units[1].after));
    expect(rolls.size).toBeGreaterThan(1);
    const key = r1.log.engagements[0].rounds[0].phases[0].shots[0].key;
    const edited = resolveCombat(live, { ...data, edits: { [key]: 7 } });
    expect(edited.units.find((x) => x.id === 'b')!.after).toBe(993);
    expect(edited.log.engagements[0].rounds[0].phases[0].shots[0]).toMatchObject({ final: 7, edited: true });
  });
});

describe('terrain generation', () => {
  it('merges neighbours, drops small patches, keeps holes, and reports coverage', async () => {
    const { buildTerrain, tilesFor } = await import('../app/lib/terrain');
    // A 1° x 1° campaign area around (10, 50). Areas: 1 km at 50°N is ~0.0141° lng and ~0.009° lat.
    const sq = (x: number, y: number, kmW: number, kmH = kmW): [number, number][][] =>
      [[[x, y], [x + kmW * 0.01408, y], [x + kmW * 0.01408, y + kmH * 0.009], [x, y + kmH * 0.009], [x, y]]];
    const raw = {
      urban: [sq(10.1, 50.1, 4), sq(10.1 + 4.3 * 0.01408, 50.1, 4), sq(10.8, 50.8, 2)],   // two 16 km² blocks 300 m apart, one 4 km² town
      forest: [sq(10.3, 50.4, 10)],                                                          // 100 km² forest
      source: 'test', tiles: 0,
    };
    const area = { type: 'Polygon' as const, coordinates: [[[10, 50], [11, 50], [11, 51], [10, 51], [10, 50]]] };
    const r = buildTerrain(raw, area, { minKm2: { urban: 25, forest: 50 }, cellM: 250, closeCells: 2 });
    expect(r.stats.urban_zones).toBe(1);          // merged into one city; the small town is dropped
    expect(r.stats.forest_zones).toBe(1);
    expect(r.stats.total_km2).toBeGreaterThan(7000);
    expect(r.stats.urban_pct + r.stats.forest_pct + r.stats.open_pct).toBeCloseTo(100, 1);
    expect(r.stats.open_pct).toBeGreaterThan(95);
    const strict = buildTerrain(raw, area, { minKm2: { urban: 25, forest: 150 }, cellM: 250, closeCells: 0 });
    expect(strict.stats.urban_zones).toBe(0);     // without merging neither block reaches 25 km²
    expect(strict.stats.forest_zones).toBe(0);
    expect(tilesFor([10, 50, 11, 51], 8).length).toBeGreaterThan(0);
  });
});
