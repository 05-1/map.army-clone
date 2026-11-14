// Air combat against the real setup.sql (PGlite + PostGIS): weapon tiers in the tech tree, squadrons
// bought and replenished through the purchase system, loadouts, missions, push, intel, recon, rollback.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { postgis } from '@electric-sql/pglite-postgis';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveCombat, type CombatInputs } from '../app/lib/combat';

const U = (n: string) => `00000000-0000-4000-8000-0000000000${n}`;
const OWNER = U('0a'), A1 = U('a1'), A2 = U('a2');
const ANONS = new Set([A1, A2]);
const SETUP = readFileSync(resolve(__dirname, '../supabase/setup.sql'), 'utf8');

type Row = Record<string, any>;
let db: PGlite;
const id: Record<string, string> = {};

async function as<T>(uid: string | null, fn: () => Promise<T>): Promise<T> {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid ?? '']);
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(uid ? { sub: uid, is_anonymous: ANONS.has(uid) } : {})]);
  await db.exec(`set role ${uid ? 'authenticated' : 'anon'}`);
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
  }
}
const q = async (sql: string, params: unknown[] = []) => (await db.query<Row>(sql, params)).rows;
const J = (v: unknown) => JSON.stringify(v);
const pt = (lng: number, lat: number) => ({ type: 'Point', coordinates: [lng, lat] });
const uuid = () => crypto.randomUUID();
const rpc = (uid: string | null, fn: string, ...args: unknown[]) =>
  as(uid, async () => (await q(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`,
    args.map((a) => (a !== null && typeof a === 'object' && !Array.isArray(a) ? JSON.stringify(a) : a))))[0].r);
const save = (uid: string, player: string, changes: unknown[]) => rpc(uid, 'save_draft', player, J(changes));
const state = (uid: string, player: string) => rpc(uid, 'get_player_state', player) as Promise<Row>;
const turn = async () => (await q(`select * from public.turns where map_id = $1 and status in ('open','locked')`, [id.map]))[0];
const squad = async (sid: string) => (await q('select * from public.squadrons where id = $1', [sid]))[0];

async function playTurn() {
  const t = await turn();
  if (t.status === 'open') await rpc(OWNER, 'lock_turn', t.id);
  for (const p of [id.p1, id.p2]) await rpc(OWNER, 'review_draft', t.id, p, J({ ready: true }));
  const inputs = (await rpc(OWNER, 'get_combat_inputs', t.id)) as CombatInputs;
  const data = { salt: 'air', salts: {}, edits: {} };
  const result = resolveCombat(inputs, data);
  await rpc(OWNER, 'save_combat_preview', t.id, J({ data, result }));
  await rpc(OWNER, 'push_turn', t.id);
  return { inputs, result };
}

beforeAll(async () => {
  db = new PGlite({ extensions: { postgis } });
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable
      as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable
      as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    grant usage on schema auth to anon, authenticated;
    insert into auth.users values ('${OWNER}', 'owner@example.com', now()), ('${A1}', null, null), ('${A2}', null, null);
  `);
  await db.exec(SETUP);
  await rpc(OWNER, 'claim_owner');
  id.map = (await as(OWNER, () => q(`select * from public.create_map('Sky')`)))[0].id;
  id.layer = (await q('select id from public.layers where map_id = $1', [id.map]))[0].id;
  for (const [k, name, team, uid] of [['p1', 'Blue', 'Blue', A1], ['p2', 'Red', 'Red', A2]] as const) {
    const r = (await as(OWNER, () => q('select * from public.create_player($1, $2, $3)', [id.map, name, team])))[0];
    id[k] = r.id;
    expect((await rpc(uid, 'claim_invite', r.invite_token, null)).ok).toBe(true);
  }
});

describe('air combat', () => {
  it('missile tiers become a chain in the tech tree', async () => {
    expect(await rpc(OWNER, 'seed_air_families', id.map)).toBe(4);
    const fams = (await rpc(OWNER, 'get_air_admin', id.map)).families;
    id.arh = fams.find((f: Row) => f.name === 'ARH').id;
    id.agmF = fams.find((f: Row) => f.name === 'AGM').id;
    id.harmF = fams.find((f: Row) => f.name === 'HARM').id;
    id.m1 = await rpc(OWNER, 'save_air_weapon', id.map, J({ family_id: id.arh, tier: 1, name: 'AIM-1', accuracy: 70, range_m: 60000, damage: 100, weight: 150 }));
    id.m2 = await rpc(OWNER, 'save_air_weapon', id.map, J({ family_id: id.arh, tier: 2, name: 'AIM-2', accuracy: 80, range_m: 100000, damage: 120, weight: 160, research_cost: 15 }));
    id.agm = await rpc(OWNER, 'save_air_weapon', id.map, J({ family_id: id.agmF, tier: 1, name: 'AGM-1', guidance: 'agm', targets: ['ground'], damage: 300, ap: 40, weight: 300, slots: 1 }));
    id.harm = await rpc(OWNER, 'save_air_weapon', id.map, J({ family_id: id.harmF, tier: 1, name: 'HARM-1', guidance: 'harm', targets: ['radar'], damage: 200, ap: 30, weight: 350 }));
    const w = (await rpc(OWNER, 'get_air_admin', id.map)).weapons;
    const t1 = w.find((x: Row) => x.id === id.m1), t2 = w.find((x: Row) => x.id === id.m2);
    const items = await q('select id, name, category, prereqs, research_cost, buyable from public.tech_items where map_id = $1', [id.map]);
    const i2 = items.find((x) => x.id === t2.tech_item_id);
    expect(i2).toMatchObject({ category: 'weapon', buyable: false, research_cost: 15, prereqs: [t1.tech_item_id] });
    expect(items.find((x) => x.id === t1.tech_item_id)!.research_cost).toBe(0);              // tier 1 is free
    await expect(rpc(A1, 'save_air_weapon', id.map, J({ family_id: id.arh, name: 'x' }))).rejects.toThrow(/not authorised/);
  });

  it('airframes, an airbase, and a squadron item in the tree', async () => {
    id.af = await rpc(OWNER, 'save_airframe', id.map, J({ name: 'F-16', hp: 100, hardpoints: 4, max_payload: 1000, radius_m: 500000, squadron_size: 6, cost_per_aircraft: 7 }));
    id.base = await rpc(OWNER, 'save_unit_template', id.map, J({ name: 'Airbase', max_strength: 2000, armor: 5, sidc: 'SFGPIBA----H---', air_capacity: 2 }));
    id.gun = await rpc(OWNER, 'save_weapon', id.map, J({ name: 'SAM', attacks: 0, ap: 0, range_m: 30000, anti_air: true, guidance: 'radar', accuracy: 70, air_damage: 100, air_shots: 2 }));
    id.samT = await rpc(OWNER, 'save_unit_template', id.map, J({ name: 'SAM site', max_strength: 500, armor: 5, sidc: 'SFGPUCDM---F---', weapon_ids: [id.gun] }));
    id.tankT = await rpc(OWNER, 'save_unit_template', id.map, J({ name: 'MBT', max_strength: 1000, armor: 20, sidc: 'SFGPUCA----F---' }));
    const mk = async (k: string, lng: number, lat: number, owner: string, sidc: string) => {
      id[k] = (await as(OWNER, () => q(`insert into public.features (map_id, layer_id, kind, geometry, props, owner_player_id) values ($1, $2, 'symbol', $3, $4, $5) returning id`,
        [id.map, id.layer, J(pt(lng, lat)), J({ name: k, sidc }), owner])))[0].id;
    };
    await mk('blueBase', 0, 0, id.p1, 'SFGPIBA----H---');
    await mk('redBase', 3, 0, id.p2, 'SFGPIBA----H---');
    await mk('tank', 3.02, 0, id.p2, 'SFGPUCA----F---');
    await mk('sam', 3.03, 0.02, id.p2, 'SFGPUCDM---F---');
    id.sqItem = await rpc(OWNER, 'save_tech_item', id.map, J({ name: 'F-16 squadron', category: 'squadron', airframe_id: id.af, spawn_cost: 40, research_cost: 0, buyable: true }));
    await rpc(OWNER, 'set_player_points', id.p1, 200, 50);
    await rpc(OWNER, 'set_player_points', id.p2, 200, 50);
    id.cap = await rpc(OWNER, 'save_squadron', id.map, J({ name: 'Red CAP', owner_player_id: id.p2, airframe_id: id.af, base_feature_id: id.redBase,
      aircraft: 4, loadout: [{ weapon: id.m1, count: 2 }] }));
    await expect(rpc(OWNER, 'save_squadron', id.map, J({ name: 'x', airframe_id: id.af, base_feature_id: id.tank }))).rejects.toThrow(/not an airbase/);
    await rpc(OWNER, 'open_turn', id.map, J({}));
  });

  it('players buy a new squadron at their airbase through the purchase system', async () => {
    id.blue = uuid();
    const buy = { op: 'buy_squadron', feature_id: id.blue, payload: { purchase_id: id.sqItem, base: id.blueBase, name: 'Vipers' } };
    await expect(save(A1, id.p1, [{ ...buy, payload: { ...buy.payload, base: id.redBase } }])).rejects.toThrow(/your own airbases/);
    expect((await save(A1, id.p1, [buy])).count).toBe(1);
    const s = await state(A1, id.p1);
    expect(s.air.squadron_items[0]).toMatchObject({ name: 'F-16 squadron', spawn_cost: 40, size: 6, unlocked: true });
    expect(s.air.bases[0]).toMatchObject({ id: id.blueBase, capacity: 2, used: 0 });
    await save(A2, id.p2, []);
    await playTurn();
    expect(await squad(id.blue)).toMatchObject({ name: 'Vipers', aircraft: 6, max_aircraft: 6, owner_player_id: id.p1, base_feature_id: id.blueBase });
    expect((await q('select spawn_points from public.players where id = $1', [id.p1]))[0].spawn_points).toBe(160);
  });

  it('loadouts: free and instant, research, hardpoints and payload are checked; radius shrinks with weight', async () => {
    await expect(rpc(A1, 'set_loadout', id.p1, id.blue, J([{ weapon: id.m2, count: 2 }]))).rejects.toThrow(/not researched/);
    await expect(rpc(A1, 'set_loadout', id.p1, id.blue, J([{ weapon: id.m1, count: 5 }]))).rejects.toThrow(/hardpoints/);
    await expect(rpc(A1, 'set_loadout', id.p1, id.blue, J([{ weapon: id.harm, count: 3 }]))).rejects.toThrow(/weighs/);
    await expect(rpc(A2, 'set_loadout', id.p2, id.blue, J([]))).rejects.toThrow(/not yours/);
    const r = await rpc(A1, 'set_loadout', id.p1, id.blue, J([{ weapon: id.agm, count: 2 }, { weapon: id.harm, count: 1 }]));
    expect(r.weight).toBe(950);
    expect(r.radius_m).toBeCloseTo(500000 * (1 - 0.4 * 0.95));                 // 310 km
    expect((await state(A1, id.p1)).air.squadrons[0].loadout).toHaveLength(2);
    const w = (await state(A1, id.p1)).air.weapons;
    expect(w.find((x: Row) => x.name === 'AIM-2')).toMatchObject({ unlocked: false, range_m: 100000, slots: 1 });
    expect(J(w)).not.toMatch(/"accuracy"|"damage"|"ap"/);                       // fit data only
  });

  it('missions: range from the base with this loadout, own escorts only, radar emit or dark', async () => {
    const strike = { op: 'mission', feature_id: id.blue, payload: { type: 'strike', target_unit: id.tank } };
    await expect(save(A1, id.p1, [{ ...strike, payload: { type: 'strike', target_unit: id.blueBase } }])).rejects.toThrow(/own unit/);
    await rpc(A1, 'set_loadout', id.p1, id.blue, J([{ weapon: id.agm, count: 3 }]));          // 900 kg: 320 km, target ~334 km away
    await expect(save(A1, id.p1, [strike])).rejects.toThrow(/reaches 320 km/);
    await rpc(A1, 'set_loadout', id.p1, id.blue, J([{ weapon: id.agm, count: 1 }, { weapon: id.harm, count: 1 }]));   // 650 kg: 370 km
    await expect(save(A1, id.p1, [strike, { op: 'mission', feature_id: id.cap, payload: { type: 'escort', escort_of: id.blue } }])).rejects.toThrow(/not yours/);
    expect((await save(A1, id.p1, [strike])).count).toBe(1);
    expect((await save(A2, id.p2, [
      { op: 'mission', feature_id: id.cap, payload: { type: 'patrol', target: [1.5, 0], radius_m: 60000 } },
      { op: 'update', feature_id: id.sam, payload: { emit: false } },
    ])).count).toBe(2);
  });

  it('push flies the missions: interception, AA, strike; squadrons, ground units and reports updated', async () => {
    const { inputs, result } = await playTurn();
    expect(inputs.squadrons!.find((s) => s.id === id.blue)!.mission).toMatchObject({ type: 'strike' });
    expect(inputs.units.find((u) => u.id === id.sam)!.emit).toBe(false);
    const pk = result.air!.log.packages[0];
    expect(pk.phases[0].label).toMatch(/Red CAP reaches Vipers/);               // no escorts, so straight at the strike
    expect(pk.phases.some((p) => p.label.startsWith('SEAD'))).toBe(false);       // dark radar: no HARM lock
    const blue = result.air!.squadrons.find((s) => s.id === id.blue)!;
    expect((await squad(id.blue)).aircraft).toBe(blue.after);
    expect((await q(`select props from public.features where id = $1`, [id.sam]))[0].props.emit).toBe(false);   // the choice persists
    const rep = (await state(A1, id.p1)).combat.report;
    expect(rep.air.squadrons[0]).toMatchObject({ name: 'Vipers', mission: 'strike', before: 6 });
    expect(rep.air.strikes).toHaveLength(1);
    const redRep = (await state(A2, id.p2)).combat.report;
    expect(redRep.air.squadrons[0]).toMatchObject({ name: 'Red CAP', mission: 'patrol' });
    expect(typeof redRep.air.downed).toBe('number');
  });

  it('intel: enemy squadrons at bases as bands within range; recon shows exact stats until the next push', async () => {
    const red = await state(A2, id.p2);
    expect(red.air.enemy_bases).toEqual([]);                                     // Blue's base is 333 km from every Red unit
    await rpc(OWNER, 'save_combat_settings', id.map, J({ intel_km: 1000 }));
    const red2 = await state(A2, id.p2);
    expect(red2.air.enemy_bases[0].base).toBe(id.blueBase);
    expect(['fresh', 'damaged', 'heavily damaged', 'critical', 'destroyed']).toContain(red2.air.enemy_bases[0].squadrons[0]);
    expect(J(red2.air)).not.toContain('Vipers');
    await rpc(OWNER, 'save_combat_settings', id.map, J({ intel_km: 100 }));
    // Recon over Red's base.
    if ((await squad(id.blue)).aircraft < 1) await rpc(OWNER, 'save_squadron', id.map, J({ ...(await squad(id.blue)), aircraft: 6 }));
    await rpc(A1, 'set_loadout', id.p1, id.blue, J([]));
    await save(A1, id.p1, [{ op: 'mission', feature_id: id.blue, payload: { type: 'recon', target: [3, 0] } }]);
    await save(A2, id.p2, []);
    await playTurn();
    const blue = await state(A1, id.p1);
    expect(blue.air.reveals).toHaveLength(1);
    expect(blue.air.revealed[id.tank] ?? blue.air.revealed[id.sam]).toMatchObject({ max: expect.any(Number), strength: expect.any(Number) });
    expect(blue.air.revealed_squadrons[0]).toMatchObject({ name: 'Red CAP', airframe: 'F-16' });
    expect(blue.combat.report.air.recon[0].units.length).toBeGreaterThan(0);
  });

  it('replacements cost SP per aircraft at the base; a squadron whose base is destroyed is stranded', async () => {
    const sq = await squad(id.blue);
    await rpc(OWNER, 'save_squadron', id.map, J({ ...sq, aircraft: 3 }));
    await expect(save(A1, id.p1, [{ op: 'buy_aircraft', feature_id: uuid(), payload: { squadron: id.blue, count: 4 } }])).rejects.toThrow(/room for 3/);
    const before = (await q('select spawn_points from public.players where id = $1', [id.p1]))[0].spawn_points;
    await save(A1, id.p1, [{ op: 'buy_aircraft', feature_id: uuid(), payload: { squadron: id.blue, count: 2 } }]);
    await save(A2, id.p2, []);
    await playTurn();
    expect((await squad(id.blue)).aircraft).toBe(5);
    expect((await q('select spawn_points from public.players where id = $1', [id.p1]))[0].spawn_points).toBe(before - 14);
    // Base destroyed (here: removed by the owner): stranded, cannot fly or be replenished until rebased.
    await as(OWNER, () => q('delete from public.features where id = $1', [id.blueBase]));
    expect((await squad(id.blue)).base_feature_id).toBeNull();
    await expect(save(A1, id.p1, [{ op: 'mission', feature_id: id.blue, payload: { type: 'recon', target: [1, 0] } }])).rejects.toThrow(/no base/);
    expect((await state(A1, id.p1)).air.squadrons[0].base).toBeNull();
  });

  it('rollback restores squadrons; players cannot touch other tables', async () => {
    const t = (await turn()).number;
    await rpc(OWNER, 'rollback_to', id.map, 1);
    expect((await squad(id.blue)).aircraft).toBe(6);
    expect(t).toBeGreaterThan(2);
    await expect(as(A1, () => q('select * from public.squadrons'))).rejects.toThrow(/permission denied/);
    await expect(rpc(A1, 'get_air_admin', id.map)).rejects.toThrow(/not authorised/);
  });
});
