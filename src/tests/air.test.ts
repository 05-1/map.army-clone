// The air engine (app/lib/air.ts) on its own and inside a whole turn (resolveCombat).
import { describe, expect, it } from 'vitest';
import { airFight, alive, clampHit, combatRadius, countermeasure, groundHit, routeCrosses, squadronState, type AirframeIn, type AirWeaponIn, type Roller, type SquadronIn } from '../app/lib/air';
import { DEFAULT_SETTINGS, resolveCombat, type CombatInputs, type UnitIn } from '../app/lib/combat';

const S = { ...DEFAULT_SETTINGS };
const frame = (o: Partial<AirframeIn> = {}): AirframeIn => ({
  id: 'af', name: 'F-1', hp: 100, hardpoints: 8, max_payload: 8000, radius_m: 800000, radar_m: 100000, signature: 1, ecm: 20, flares: 20, maneuver: 20,
  gun_accuracy: 40, gun_damage: 0, gun_range_m: 1500, squadron_size: 12, cost_per_aircraft: 10, ...o,
});
const missile = (id: string, o: Partial<AirWeaponIn> = {}): AirWeaponIn => ({
  id, name: id, tier: 1, guidance: 'radar', accuracy: 70, range_m: 80000, damage: 100, ap: 10, weight: 150, slots: 1, targets: ['air'], count: 2, ...o,
});
const sq = (id: string, side: string, o: Partial<SquadronIn> = {}): SquadronIn => ({
  id, name: id, owner: side, side, airframe: frame(), base: `b-${id}`, base_pos: [0, 0], aircraft: 4, max: 12, damage: 0,
  loadout: [missile('arh')], radius_m: 800000, mission: null, ...o,
});
/** Every shot hits (or misses) with certainty, so outcomes are exact. */
const sure = (hit: boolean): Roller => ({ s: { ...S, hit_min: hit ? 100 : 0, hit_max: hit ? 100 : 0 }, edits: {}, rand: () => 0.5 });

describe('air pieces', () => {
  it('hit clamp, countermeasure matching, combat radius', () => {
    expect(clampHit(85 - 30, S)).toBe(55);
    expect(clampHit(10 - 30, S)).toBe(5);
    expect(clampHit(140, S)).toBe(95);
    const a = frame({ ecm: 30, flares: 40, maneuver: 50 });
    expect([countermeasure('radar', a), countermeasure('ir', a), countermeasure('gun', a), countermeasure('agm', a)]).toEqual([30, 40, 50, 0]);
    expect(combatRadius({ radius_m: 1000000, max_payload: 8000 }, 4000, 0.4)).toBe(800000);   // 1 − 0.4 × 0.5
    expect(combatRadius({ radius_m: 1000000, max_payload: 8000 }, 0, 0.4)).toBe(1000000);
  });
  it('air-to-ground damage: AP ÷ armor capped at 1.5, armor 0 = 1.5, terrain and dug in apply', () => {
    const t = (armor: number, terrain: 'open' | 'urban' = 'open', st = false) => ({ template: { armor, category: 'ground' }, terrain, stationary: st, stationary_turns: st ? 3 : 0 });
    expect(groundHit(100, 10, t(20), S).raw).toBe(50);
    expect(groundHit(100, 60, t(20), S).raw).toBe(150);
    expect(groundHit(100, 5, t(0), S).raw).toBe(150);
    expect(groundHit(100, 20, t(20, 'urban', true), S).raw).toBeCloseTo(100 * 0.7 * 0.85);
  });
  it('a route crosses a patrol circle', () => {
    expect(routeCrosses([0, 0], [2, 0], [1, 0.1], 20000)).not.toBeNull();   // ~11 km off the route
    expect(routeCrosses([0, 0], [2, 0], [1, 1], 20000)).toBeNull();
    expect(routeCrosses([0, 0], [2, 0], [3, 0], 20000)).toBeNull();          // beyond the target
  });
  it('damage accumulates: every full airframe HP removes an aircraft', () => {
    const q = squadronState(sq('a', 'x'));
    q.dmg = 250;
    expect(alive(q)).toBe(2);
  });
});

describe('air-to-air', () => {
  it('the side that detects first fires first; the other replies with survivors', () => {
    const A = squadronState(sq('a', 'blue', { airframe: frame({ radar_m: 150000 }) }));
    const B = squadronState(sq('b', 'red'));
    const ph = airFight(sure(true), 'x', [A], [B], 'blue', 'red');
    expect(ph[0].label).toMatch(/blue detect first/);
    expect(ph[0].shots).toHaveLength(8);                 // 4 aircraft × 2 missiles
    expect(alive(B)).toBe(0);                             // 8 hits × 100 vs 4 × 100 HP
    expect(ph[1].shots).toHaveLength(0);                  // nobody left to reply
  });
  it('equal detection: longer missile range first; equal range: simultaneous', () => {
    const A = squadronState(sq('a', 'blue', { loadout: [missile('long', { range_m: 120000 })] }));
    const B = squadronState(sq('b', 'red'));
    expect(airFight(sure(false), 'x', [A], [B], 'blue', 'red')[0].label).toMatch(/blue detect first/);
    const C = squadronState(sq('c', 'blue')), D = squadronState(sq('d', 'red'));
    const ph = airFight(sure(true), 'x', [C], [D], 'blue', 'red');
    expect(ph[0].label).toMatch(/both sides fire at once/);
    expect(alive(C)).toBe(0);
    expect(alive(D)).toBe(0);
  });
  it('stealth: a low signature is detected late; IR then guns close in', () => {
    const A = squadronState(sq('a', 'blue', { airframe: frame({ signature: 0.2, gun_damage: 30 }), loadout: [missile('arh'), missile('ir9', { guidance: 'ir', count: 1 })] }));
    const B = squadronState(sq('b', 'red', { airframe: frame({ gun_damage: 30 }), loadout: [missile('ir9', { guidance: 'ir', count: 1 })] }));
    const ph = airFight(sure(false), 'x', [A], [B], 'blue', 'red');
    expect(ph.map((p) => p.label)).toEqual([expect.stringMatching(/blue detect first/), expect.stringMatching(/red reply/), 'Within visual range: IR missiles', 'Guns']);
    expect(ph[1].shots).toHaveLength(0);                  // red has no radar missiles
  });
  it('missiles are spent: a second fight has nothing left', () => {
    const A = squadronState(sq('a', 'blue'));
    airFight(sure(false), 'x', [A], [squadronState(sq('b', 'red'))], 'blue', 'red');
    const again = airFight(sure(false), 'y', [A], [squadronState(sq('c', 'red'))], 'blue', 'red');
    expect(again.flatMap((p) => p.shots).filter((s) => s.shooter === 'a')).toHaveLength(0);
  });
});

// ---- a whole turn ----
const W = (slot: number, o: Record<string, unknown> = {}) => ({ slot, id: `w${slot}`, name: `gun${slot}`, attacks: 50, ap: 10, range_m: 3000, indirect: false, ...o });
const unit = (id: string, side: string, pos: [number, number], o: Partial<UnitIn> = {}): UnitIn => ({
  id, name: id, owner: side, side, template: { id: 't', name: 'tank', max_strength: 1000, armor: 20, category: 'ground' },
  weapons: [W(0)], start: pos, pos, moved: false, heading: null, strength: 1000, experience: 0, stationary_turns: 0,
  terrain: 'open', new: false, retreat: false, attacks: [], emit: true, ...o,
});
const data = { salt: 's', salts: {}, edits: {} };
const agm = missile('agm', { guidance: 'agm', targets: ['ground'], damage: 200, ap: 30, count: 2, range_m: 20000 });
const harm = missile('harm', { guidance: 'harm', targets: ['radar'], damage: 150, ap: 30, count: 1, range_m: 100000 });

describe('air phase of a turn', () => {
  const sam = (o: Partial<UnitIn> = {}) => unit('sam', 'red', [5, 0.05], { weapons: [W(0, { name: 'SAM', anti_air: true, guidance: 'radar', accuracy: 80, air_damage: 100, air_shots: 2, range_m: 40000 })], ...o });
  const turn = (squadrons: SquadronIn[], units: UnitIn[], settings = S): CombatInputs => ({ map_id: 'm', turn: 1, settings, units, engagements: [], squadrons });
  const striker = (o: Partial<SquadronIn> = {}) => sq('strike', 'blue', { loadout: [agm, harm], mission: { type: 'strike', target_unit: 'tank' }, ...o });

  it('escorts take on interceptors first; HARMs fire before AA; dark radar is harder to hit and halves its own aim', () => {
    const esc = sq('escort', 'blue', { mission: { type: 'escort', escort_of: 'strike' } });
    const cap = sq('cap', 'red', { base_pos: [5, 1], mission: { type: 'patrol', target: [2.5, 0], radius_m: 50000 } });
    const r = resolveCombat(turn([striker(), esc, cap], [unit('tank', 'red', [5, 0]), sam()]), data);
    const pk = r.air!.log.packages[0];
    const labels = pk.phases.map((p) => p.label);
    expect(labels[0]).toMatch(/cap intercepts; escorts engage/);
    const sead = labels.indexOf('SEAD: HARMs at emitting radar AA');
    const aa = labels.indexOf('Anti-air over the target');
    expect(sead).toBeGreaterThan(-1);
    expect(sead).toBeLessThan(aa === -1 ? Infinity : aa);
    // Dark radar: no HARM shots, AA accuracy halved.
    const dark = resolveCombat(turn([striker()], [unit('tank', 'red', [5, 0]), sam({ emit: false })]), data);
    const dl = dark.air!.log.packages[0].phases;
    expect(dl.some((p) => p.label.startsWith('SEAD'))).toBe(false);
    expect(dl.find((p) => p.label === 'Anti-air over the target')!.shots[0]).toMatchObject({ accuracy: 40, countermeasure: 20, hit_pct: 20 });
  });

  it('strike damage lands on the ground unit before ground combat, and is reported', () => {
    const sureS = { ...S, hit_min: 100, hit_max: 100 };
    const r = resolveCombat(turn([striker({ loadout: [agm] })], [unit('tank', 'red', [5, 0])], sureS), data);
    const st = r.air!.strikes[0];
    // 4 aircraft × 2 AGMs, each hit 200 × min(30/20, 1.5) = 300: the 4th hit destroys the 1000-strength tank; the rest are not dropped.
    expect(st).toMatchObject({ target: 'tank', shots: 4, hits: 4, damage: 1200, destroyed: true });
    expect(r.units.find((u) => u.id === 'tank')).toMatchObject({ destroyed: true, hit: true });
  });

  it('active protection counts against AGMs only', () => {
    const r = resolveCombat(turn([striker({ loadout: [agm] })], [unit('tank', 'red', [5, 0], { template: { id: 't', name: 'tank', max_strength: 99999, armor: 20, category: 'ground', aps: 30 } })]), data);
    expect(r.air!.log.packages[0].phases.at(-1)!.shots[0]).toMatchObject({ countermeasure: 30, hit_pct: 40 });
  });

  it('recon reveals around its target; missions out of range or without a base fail', () => {
    const r = resolveCombat(turn([
      sq('rec', 'blue', { mission: { type: 'recon', target: [3, 0] }, loadout: [] }),
      sq('far', 'blue', { radius_m: 1000, mission: { type: 'recon', target: [3, 0] } }),
      sq('lost', 'blue', { base_pos: null, mission: { type: 'patrol', target: [1, 0] } }),
    ], []), data);
    expect(r.air!.reveals).toEqual([expect.objectContaining({ owner: 'blue', center: [3, 0], radius_m: 25000 })]);
    expect(r.air!.log.failed.map((f) => f.squadron).sort()).toEqual(['far', 'lost']);
  });

  it('losses, carried damage and kills; reproducible; a hand edit replaces a shot', () => {
    const cap = sq('cap', 'red', { base_pos: [5, 1], mission: { type: 'patrol', target: [2.5, 0], radius_m: 50000 } });
    const inp = turn([striker(), cap], [unit('tank', 'red', [5, 0])]);
    const r1 = resolveCombat(inp, data);
    expect(resolveCombat(inp, data)).toEqual(r1);
    const out = r1.air!.squadrons.find((q) => q.id === 'strike')!;
    expect(out.before - out.after).toBe(out.lost);
    const first = r1.air!.log.packages[0].phases[0].shots[0];
    const ed = resolveCombat(inp, { ...data, edits: { [first.key]: 0 } });
    expect(ed.air!.log.packages[0].phases[0].shots[0]).toMatchObject({ final: 0, edited: true, hit: false });
    const kills = r1.air!.kills.reduce((a, k) => a + k.count, 0);
    expect(kills).toBeLessThanOrEqual(r1.air!.squadrons.reduce((a, q) => a + q.lost, 0));
  });
});
