// The air engine (app/lib/air.ts) on its own and inside a whole turn (resolveCombat).
import { describe, expect, it } from 'vitest';
import {
  airExchange, alive, clampHit, clampMove, combatRadius, countermeasure, coverageAt, groundHit, squadronState,
  type AirframeIn, type AirUnitIn, type AirWeaponIn, type Roller, type Sq,
} from '../app/lib/air';
import { DEFAULT_SETTINGS, resolveCombat, type CombatInputs, type UnitIn } from '../app/lib/combat';

const S = { ...DEFAULT_SETTINGS };
const frame = (o: Partial<AirframeIn> = {}): AirframeIn => ({
  id: 'af', name: 'F-1', hp: 100, hardpoints: 8, max_payload: 8000, radius_m: 800000, radar_m: 100000, signature: 1, ecm: 20, flares: 20, maneuver: 20,
  gun_accuracy: 40, gun_damage: 0, gun_range_m: 1500, squadron_size: 12, cost_per_aircraft: 10, speed_m: 1000000, refuelable: true, ...o,
});
const missile = (id: string, o: Partial<AirWeaponIn> = {}): AirWeaponIn => ({
  id, name: id, tier: 1, guidance: 'radar', accuracy: 70, range_m: 80000, damage: 100, ap: 10, weight: 150, slots: 1, targets: ['air'], count: 2, ...o,
});
const sq = (id: string, side: string, o: Partial<AirUnitIn> = {}): AirUnitIn => ({
  id, name: id, owner: side, side, airframe: frame(), pos: [0, 0], moved: true, landed_at: null, aircraft: 4, max: 12, damage: 0,
  loadout: [missile('arh')], ammo: {}, radius_m: 800000, attacks: [], return_salvo: 2, refuel_priority: [], grounded: false, ...o,
});
/** Every shot hits (or misses) with certainty, so outcomes are exact. */
const sure = (hit: boolean): Roller => ({ s: { ...S, hit_min: hit ? 100 : 0, hit_max: hit ? 100 : 0 }, edits: {}, rand: () => 0.5 });
const att = (q: Sq, salvo: Record<string, number>) => ({ q, salvo: new Map(Object.entries(salvo)) });
const owners = (...qs: Sq[]) => new Map(qs.map((q) => [q.in.id, q.in.owner]));

describe('air pieces', () => {
  it('hit clamp, countermeasure matching, combat radius', () => {
    expect(clampHit(85 - 30, S)).toBe(55);
    expect(clampHit(10 - 30, S)).toBe(5);
    expect(clampHit(140, S)).toBe(95);
    const a = frame({ ecm: 30, flares: 40, maneuver: 50 });
    expect([countermeasure('radar', a), countermeasure('ir', a), countermeasure('gun', a), countermeasure('agm', a)]).toEqual([30, 40, 50, 0]);
    expect(combatRadius({ radius_m: 1000000, max_payload: 8000 }, 4000, 0.4)).toBe(800000);   // 1 − 0.4 × 0.5
    expect(combatRadius({ radius_m: 1000000, max_payload: 8000 }, 8000, 0.2)).toBe(800000);   // a bomber's lighter penalty
  });
  it('air-to-ground damage: AP ÷ armor capped at 1.5, armor 0 = 1.5, terrain and dug in apply', () => {
    const t = (armor: number, terrain: 'open' | 'urban' = 'open', st = false) => ({ template: { armor, category: 'ground' }, terrain, stationary: st, stationary_turns: st ? 3 : 0 });
    expect(groundHit(100, 10, t(20), S).raw).toBe(50);
    expect(groundHit(100, 60, t(20), S).raw).toBe(150);
    expect(groundHit(100, 5, t(0), S).raw).toBe(150);
    expect(groundHit(100, 20, t(20, 'urban', true), S).raw).toBeCloseTo(100 * 0.7 * 0.85);
  });
  it('damage accumulates: every full airframe HP removes an aircraft; ammo defaults to a full load', () => {
    const q = squadronState(sq('a', 'x'));
    q.dmg = 250;
    expect(alive(q)).toBe(2);
    expect(q.ammo.get('arh')).toBe(8);
  });
  it('reachable area: speed circle, base radius or a tanker circle; moves are pulled back inside', () => {
    const cov = { bases: [{ pos: [0, 0] as [number, number], radius_m: 300000 }], tankers: [{ id: 't', pos: [4, 0] as [number, number], radius_m: 50000 }] };
    expect(coverageAt([2, 0], cov)).toEqual({ ok: true, tanker: null });
    expect(coverageAt([4.2, 0], cov)).toEqual({ ok: true, tanker: 't' });     // only because of the tanker
    expect(coverageAt([3.5, 0], cov).ok).toBe(false);
    const p = clampMove([0, 0], [3.5, 0], 1000000, cov)!;
    expect(p[0]).toBeGreaterThan(2.6);                                         // edge of the 300 km base radius (~2.7°)
    expect(p[0]).toBeLessThan(2.71);
    expect(clampMove([0, 0], [2, 0], 100000, cov)![0]).toBeLessThan(0.91);     // speed 100 km
  });
});

describe('air-to-air exchange', () => {
  it('the side that detects first fires first: a declared salvo with no limit; survivors reply', () => {
    const A = squadronState(sq('a', 'blue', { airframe: frame({ radar_m: 150000 }), pos: [0, 0] }));
    const B = squadronState(sq('b', 'red', { pos: [0.5, 0] }));                // ~55 km apart
    const ph = airExchange(sure(true), 'x', [att(A, { arh: 8 })], B, [], owners(A, B));
    expect(ph[0].label).toMatch(/attackers detect first/);
    expect(ph[0].shots).toHaveLength(4);                  // stops firing once the target is gone: 4 hits × 100 vs 4 × 100 HP
    expect(alive(B)).toBe(0);
    expect(A.ammo.get('arh')).toBe(4);                    // the rest is kept
    expect(ph).toHaveLength(1);                           // nobody left to reply
  });
  it('only what was declared is fired; defenders return fire per aircraft and phase', () => {
    const A = squadronState(sq('a', 'blue', { pos: [0, 0] }));
    const B = squadronState(sq('b', 'red', { pos: [0.5, 0], return_salvo: 1 }));
    const ph = airExchange(sure(false), 'x', [att(A, { arh: 3 })], B, [], owners(A, B));
    expect(ph[0].label).toMatch(/both sides fire at once/);
    expect(ph[0].shots.filter((s) => s.shooter === 'a')).toHaveLength(3);
    expect(ph[0].shots.filter((s) => s.shooter === 'b')).toHaveLength(4);   // 1 per aircraft
    expect(A.ammo.get('arh')).toBe(5);
  });
  it('out of BVR range: radar missiles hold; IR and guns close in', () => {
    const A = squadronState(sq('a', 'blue', { pos: [0, 0], airframe: frame({ gun_damage: 30 }), loadout: [missile('arh'), missile('ir9', { guidance: 'ir', count: 1, range_m: 20000 })] }));
    const B = squadronState(sq('b', 'red', { pos: [2, 0], airframe: frame({ gun_damage: 30 }), loadout: [missile('ir9', { guidance: 'ir', count: 1 })] }));
    const ph = airExchange(sure(false), 'x', [att(A, { arh: 8, ir9: 4 })], B, [], owners(A, B));
    expect(ph.map((p) => p.label)).toEqual(['Within visual range: IR missiles', 'Guns']);
    expect(A.ammo.get('arh')).toBe(8);
  });
  it('stealth is detected late; mutual support joins the defence', () => {
    const A = squadronState(sq('a', 'blue', { pos: [0, 0], airframe: frame({ signature: 0.25 }) }));
    const B = squadronState(sq('b', 'red', { pos: [0.5, 0] }));
    const C = squadronState(sq('c', 'red', { pos: [0.6, 0] }));
    const ph = airExchange(sure(false), 'x', [att(A, { arh: 2 })], B, [C], owners(A, B, C));
    expect(ph[0].label).toMatch(/attackers detect first/);          // 100 km × 1 vs 100 km × 0.25
    expect(ph.flatMap((x) => x.shots).filter((x) => x.shooter !== 'a')).toHaveLength(0);   // 25 km detection: A at 55 km is invisible to them
  });
});

// ---- a whole turn ----
const W = (slot: number, o: Record<string, unknown> = {}) => ({ slot, id: `w${slot}`, name: `gun${slot}`, attacks: 50, ap: 10, range_m: 3000, indirect: false, ...o });
const unit = (id: string, side: string, pos: [number, number], o: Partial<UnitIn> = {}): UnitIn => ({
  id, name: id, owner: side, side, template: { id: 't', name: 'tank', max_strength: 1000, armor: 20, category: 'ground' },
  weapons: [W(0)], start: pos, pos, moved: false, heading: null, strength: 1000, experience: 0, stationary_turns: 0,
  terrain: 'open', new: false, retreat: false, attacks: [], emit: true, ...o,
});
const base = (id: string, side: string, pos: [number, number], cap = 2) => unit(id, side, pos, { template: { id: 'ab', name: 'airbase', max_strength: 1000, armor: 5, category: 'ground', air_capacity: cap }, weapons: [] });
const data = { salt: 's', salts: {}, edits: {} };
const agm = missile('agm', { guidance: 'agm', targets: ['ground'], damage: 200, ap: 30, count: 2, range_m: 30000 });
const harm = missile('harm', { guidance: 'harm', targets: ['radar'], damage: 150, ap: 30, count: 1, range_m: 100000 });

describe('air phase of a turn', () => {
  const sam = (o: Partial<UnitIn> = {}) => unit('sam', 'red', [5, 0.05], { weapons: [W(0, { name: 'SAM', anti_air: true, guidance: 'radar', accuracy: 80, air_damage: 100, air_shots: 2, range_m: 40000 })], ...o });
  const turn = (air: AirUnitIn[], units: UnitIn[], settings = S): CombatInputs => ({ map_id: 'm', turn: 1, settings, units, engagements: [], air_units: air });
  const striker = (o: Partial<AirUnitIn> = {}) => sq('strike', 'blue', { pos: [4.9, 0], loadout: [agm, harm], attacks: [{ target: 'tank', weapons: [{ weapon: 'agm', count: 8 }] }], ...o });
  const home = base('home', 'blue', [0, 0]);

  it('strikes hit within weapon range until the target is destroyed; struck units do not recover', () => {
    const r = resolveCombat(turn([striker({ airframe: frame({ radius_m: 2000000 }), radius_m: 2000000 })], [home, unit('tank', 'red', [5, 0], { stationary_turns: 0, strength: 500 })], { ...S, hit_min: 100, hit_max: 100 }), data);
    const st = r.air!.strikes[0];
    expect(st.hits).toBe(2);                                          // 200 × min(30/20, 1.5) = 300 per hit; 500 strength
    expect(st.destroyed).toBe(true);
    expect(r.air!.squadrons[0].ammo.agm).toBe(6);
  });
  it('out of weapon range: no shot, and the reason is logged', () => {
    const r = resolveCombat(turn([striker({ pos: [4, 0], radius_m: 2000000 })], [home, unit('tank', 'red', [5, 0])]), data);
    expect(r.air!.strikes[0].aborted).toMatch(/out of range: 111 km/);
  });
  it('AA auto-fires at squadrons ending within range; dark radar halves its accuracy and cannot be HARMed', () => {
    const dark = resolveCombat(turn([striker({ radius_m: 2000000, attacks: [{ target: 'sam', weapons: [{ weapon: 'harm', count: 4 }] }] })], [home, sam({ emit: false })]), data);
    const aa = dark.air!.log.packages.find((p) => p.kind === 'aa')!;
    expect(aa.phases[0].shots[0].accuracy).toBe(40);
    expect(dark.air!.strikes[0].aborted).toMatch(/went dark/);
    const lit = resolveCombat(turn([striker({ radius_m: 2000000, attacks: [{ target: 'sam', weapons: [{ weapon: 'harm', count: 4 }] }] })], [home, sam()], { ...S, hit_min: 100, hit_max: 100 }), data);
    expect(lit.air!.strikes[0].shots).toBeGreaterThan(0);
  });
  it('lands at a friendly base within the snap distance and rearms for free', () => {
    const q = sq('q', 'blue', { pos: [0.02, 0], ammo: { arh: 1 } });
    const r = resolveCombat(turn([q], [home]), data);
    const out = r.air!.squadrons[0];
    expect([out.state, out.base, out.ammo.arh]).toEqual(['landed', 'home', 8]);
  });
  it('outside every base radius: a tanker with capacity keeps it out; without one it is forced home and grounded', () => {
    const tanker = sq('tk', 'blue', { pos: [3, 0], airframe: frame({ tanker: true }), aircraft: 1, radius_m: 600000, loadout: [] });
    const f1 = sq('f1', 'blue', { pos: [3.2, 0], radius_m: 300000 });
    const f2 = sq('f2', 'blue', { pos: [3.2, 0.1], radius_m: 300000 });
    const f3 = sq('f3', 'blue', { pos: [3.1, 0], radius_m: 300000 });
    const r = resolveCombat(turn([{ ...tanker, refuel_priority: ['f3', 'f2'] }, f1, f2, f3], [home], { ...S, refuel_per_aircraft: 2 }), data);
    const by = Object.fromEntries(r.air!.squadrons.map((x) => [x.id, x]));
    expect([by.f3.refueled_by, by.f2.refueled_by]).toEqual(['tk', 'tk']);     // the player's priority
    expect(by.f1.forced).toMatch(/no capacity left/);
    expect([by.f1.state, by.f1.base, by.f1.grounded]).toEqual(['landed', 'home', true]);
    expect(by.tk.state).toBe('airborne');
  });
  it('a tanker shot down this turn refuels no one; a destroyed base sends its squadrons elsewhere', () => {
    const tanker = sq('tk', 'blue', { pos: [3, 0], airframe: frame({ tanker: true }), aircraft: 1, radius_m: 600000, loadout: [] });
    const f1 = sq('f1', 'blue', { pos: [3.2, 0], radius_m: 300000 });
    const killer = sq('k', 'red', { pos: [3.3, 0], airframe: frame({ radar_m: 200000 }), attacks: [{ target: 'tk', weapons: [{ weapon: 'arh', count: 2 }] }] });
    const r = resolveCombat(turn([tanker, f1, killer], [home, base('rb', 'red', [6, 0])], { ...S, hit_min: 100, hit_max: 100 }), data);
    expect(r.air!.squadrons.find((x) => x.id === 'f1')!.forced).toMatch(/out of reach/);
    const landed = sq('l', 'blue', { pos: [0, 0], moved: false, landed_at: 'home' });
    const tank = unit('art', 'red', [0.05, 0], { weapons: [W(0, { attacks: 5000, ap: 50, range_m: 20000, indirect: true })], attacks: [{ slot: 0, target: 'home' }] });
    const r2 = resolveCombat(turn([landed], [home, base('alt', 'blue', [1, 0]), tank]), data);
    const out = r2.air!.squadrons[0];
    expect([out.base, out.forced]).toEqual(['alt', 'its base was destroyed']);
  });
  it('landed squadrons can be struck at their base', () => {
    const parked = sq('p', 'red', { pos: [5, 0], moved: false, landed_at: 'rb' });
    const r = resolveCombat(turn([striker({ radius_m: 2000000, attacks: [{ target: 'p', weapons: [{ weapon: 'agm', count: 2 }] }] }), parked],
      [home, base('rb', 'red', [5, 0])], { ...S, hit_min: 100, hit_max: 100 }), data);
    expect(r.air!.strikes[0].hits).toBe(2);
    expect(r.air!.squadrons.find((x) => x.id === 'p')!.after).toBe(0);    // 2 × 300 vs 4 × 100 HP
  });
  it('re-rolling one exchange leaves the others alone; hand edits are used', () => {
    const A = sq('a', 'blue', { pos: [0.1, 0], attacks: [{ target: 'b', weapons: [{ weapon: 'arh', count: 4 }] }] });
    const B = sq('b', 'red', { pos: [0.5, 0] });
    const r1 = resolveCombat(turn([A, B], [home]), data);
    const key = r1.air!.log.packages[0].phases[0].shots[0].key;
    const r2 = resolveCombat(turn([A, B], [home]), { ...data, edits: { [key]: 77 } });
    expect(r2.air!.log.packages[0].phases[0].shots[0]).toMatchObject({ final: 77, edited: true });
    const r3 = resolveCombat(turn([A, B], [home]), { ...data, salts: { 'x:b': 'other' } });
    expect(r3.air!.log.packages[0].phases[0].shots.map((s) => s.roll)).not.toEqual(r1.air!.log.packages[0].phases[0].shots.map((s) => s.roll));
  });
});
