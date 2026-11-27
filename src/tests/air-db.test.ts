// Air combat against the real setup.sql (PGlite + PostGIS): squadrons as map units bought through the tech
// tree, loadouts while landed, movement under the base-radius rule, tankers, radar visibility (live, history,
// share links), declared attacks with salvos and ammo, push, forced returns, replacements, rollback.
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
const squad = async (sid: string) => (await q('select q.*, f.geometry from public.air_units q join public.features f on f.id = q.feature_id where q.feature_id = $1', [sid]))[0];
const featureIds = (st: Row) => (st.features as Row[]).map((f) => f.id);

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
  it('missile tiers become a chain in their own tree', async () => {
    expect(await rpc(OWNER, 'seed_air_families', id.map)).toBe(4);
    const admin = await rpc(OWNER, 'get_air_admin', id.map);
    expect(admin.roles.map((r: Row) => r.name)).toEqual(['Fighter', 'Multirole', 'Bomber', 'Tanker']);
    const fams = admin.families;
    for (const f of ['IR', 'ARH', 'AGM', 'HARM']) id[`f${f}`] = fams.find((x: Row) => x.name === f).id;
    id.m1 = await rpc(OWNER, 'save_air_weapon', id.map, J({ family_id: id.fARH, tier: 1, name: 'AIM-1', accuracy: 70, range_m: 60000, damage: 100, weight: 150 }));
    id.m2 = await rpc(OWNER, 'save_air_weapon', id.map, J({ family_id: id.fARH, tier: 2, name: 'AIM-2', accuracy: 80, range_m: 100000, damage: 120, weight: 160, research_cost: 15 }));
    id.ir = await rpc(OWNER, 'save_air_weapon', id.map, J({ family_id: id.fIR, tier: 1, name: 'AIM-9', guidance: 'ir', range_m: 20000, weight: 85 }));
    id.agm = await rpc(OWNER, 'save_air_weapon', id.map, J({ family_id: id.fAGM, tier: 1, name: 'AGM-1', guidance: 'agm', targets: ['ground'], accuracy: 90, damage: 30, ap: 40, weight: 300, range_m: 50000 }));
    id.harm = await rpc(OWNER, 'save_air_weapon', id.map, J({ family_id: id.fHARM, tier: 1, name: 'HARM-1', guidance: 'harm', targets: ['radar'], damage: 200, ap: 30, weight: 350 }));
    const w = (await rpc(OWNER, 'get_air_admin', id.map)).weapons;
    const t1 = w.find((x: Row) => x.id === id.m1), t2 = w.find((x: Row) => x.id === id.m2);
    const items = await q('select id, category, prereqs, research_cost, buyable, tree from public.tech_items where map_id = $1', [id.map]);
    expect(items.find((x) => x.id === t2.tech_item_id)).toMatchObject({ category: 'weapon', buyable: false, research_cost: 15, prereqs: [t1.tech_item_id], tree: 'missiles' });
    expect(items.find((x) => x.id === t1.tech_item_id)!.research_cost).toBe(0);              // tier 1 is free
    await expect(rpc(A1, 'save_air_weapon', id.map, J({ family_id: id.fARH, name: 'x' }))).rejects.toThrow(/not authorised/);
  });

  it('airframes with roles and families, bases, sensors, a squadron item; the owner places a squadron', async () => {
    const roles = (await rpc(OWNER, 'get_air_admin', id.map)).roles;
    const role = (n: string) => roles.find((r: Row) => r.name === n).id;
    id.af = await rpc(OWNER, 'save_airframe', id.map, J({ name: 'F-16', role_id: role('Multirole'), hp: 100, hardpoints: 4, max_payload: 1000, radius_m: 500000,
      speed_m: 600000, payload_penalty: 0.4, radar_m: 100000, squadron_size: 6, cost_per_aircraft: 7, families: [id.fARH, id.fAGM, id.fHARM] }));
    id.kc = await rpc(OWNER, 'save_airframe', id.map, J({ name: 'KC-135', role_id: role('Tanker'), refuelable: false, hp: 100, hardpoints: 0, max_payload: 0,
      radius_m: 1500000, speed_m: 1000000, radar_m: 0, gun_damage: 0, squadron_size: 2, families: [] }));
    expect((await rpc(OWNER, 'get_air_admin', id.map)).airframes.find((a: Row) => a.id === id.kc).tanker).toBe(true);
    id.base = await rpc(OWNER, 'save_unit_template', id.map, J({ name: 'Airbase', max_strength: 2000, armor: 5, sidc: 'SFGPIBA----H---', air_capacity: 2 }));
    id.gun = await rpc(OWNER, 'save_weapon', id.map, J({ name: 'SAM', attacks: 0, ap: 0, range_m: 30000, anti_air: true, guidance: 'radar', accuracy: 0, air_damage: 100, air_shots: 2 }));
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
    id.cap = await rpc(OWNER, 'save_squadron', id.map, J({ name: 'Red CAP', owner_player_id: id.p2, airframe_id: id.af, state: 'landed', base_feature_id: id.redBase,
      aircraft: 4, loadout: [{ weapon: id.m1, count: 2 }] }));
    expect(await squad(id.cap)).toMatchObject({ state: 'landed', base_feature_id: id.redBase, ammo: { [id.m1]: 8 } });
    expect((await squad(id.cap)).geometry.coordinates).toEqual([3, 0]);
    await expect(rpc(OWNER, 'save_squadron', id.map, J({ name: 'x', airframe_id: id.af, base_feature_id: id.tank }))).rejects.toThrow(/not an airbase/);
    await expect(rpc(OWNER, 'save_squadron', id.map, J({ name: 'x', airframe_id: id.af, base_feature_id: id.redBase, loadout: [{ weapon: id.ir, count: 1 }] })))
      .rejects.toThrow(/cannot carry AIM-9/);
    await rpc(OWNER, 'save_combat_settings', id.map, J({ hit_min: 0 }));        // the 0%-accurate SAM never hits: exact counts below
    await rpc(OWNER, 'open_turn', id.map, J({}));
  });

  it('players buy a squadron from the tree and place it on their own airbase', async () => {
    id.blue = uuid();
    const buy = (at: [number, number]) => ({ op: 'create', feature_id: id.blue, payload: { kind: 'symbol', geometry: pt(...at), purchase_id: id.sqItem, props: { name: 'Vipers', sidc: 'SFAPMF---------' } } });
    await expect(save(A1, id.p1, [buy([3, 0])])).rejects.toThrow(/one of your airbases/);
    await expect(save(A1, id.p1, [buy([0.5, 0])])).rejects.toThrow(/one of your airbases/);
    expect((await save(A1, id.p1, [buy([0.02, 0.01])])).count).toBe(1);                // snapped onto the base 2.5 km away
    const s = await state(A1, id.p1);
    expect(s.draft.changes[0].payload).toMatchObject({ base: id.blueBase, geometry: pt(0, 0) });
    expect(s.air.squadron_items[0]).toMatchObject({ name: 'F-16 squadron', spawn_cost: 40, size: 6, unlocked: true });
    expect(s.air.bases[0]).toMatchObject({ id: id.blueBase, capacity: 2, used: 0 });
    await save(A2, id.p2, []);
    await playTurn();
    expect(await squad(id.blue)).toMatchObject({ aircraft: 6, max_aircraft: 6, state: 'landed', base_feature_id: id.blueBase });
    expect((await q('select spawn_points from public.players where id = $1', [id.p1]))[0].spawn_points).toBe(160);
  });

  it('loadouts only while landed: research, families, hardpoints and payload checked; radius shrinks; ammo refills', async () => {
    await expect(rpc(A1, 'set_loadout', id.p1, id.blue, J([{ weapon: id.m2, count: 2 }]))).rejects.toThrow(/not researched/);
    await expect(rpc(A1, 'set_loadout', id.p1, id.blue, J([{ weapon: id.ir, count: 2 }]))).rejects.toThrow(/cannot carry/);
    await expect(rpc(A1, 'set_loadout', id.p1, id.blue, J([{ weapon: id.m1, count: 5 }]))).rejects.toThrow(/hardpoints/);
    await expect(rpc(A1, 'set_loadout', id.p1, id.blue, J([{ weapon: id.harm, count: 3 }]))).rejects.toThrow(/weighs/);
    await expect(rpc(A2, 'set_loadout', id.p2, id.blue, J([]))).rejects.toThrow(/not yours/);
    const r = await rpc(A1, 'set_loadout', id.p1, id.blue, J([{ weapon: id.agm, count: 2 }, { weapon: id.harm, count: 1 }]));
    expect(r.weight).toBe(950);
    expect(r.radius_m).toBeCloseTo(500000 * (1 - 0.4 * 0.95));                 // 310 km
    expect((await squad(id.blue)).ammo).toEqual({ [id.agm]: 12, [id.harm]: 6 });
    const w = (await state(A1, id.p1)).air.weapons;
    expect(w.find((x: Row) => x.name === 'AIM-2')).toMatchObject({ unlocked: false, range_m: 100000, slots: 1 });
    expect(J(w)).not.toMatch(/"accuracy"|"damage"|"ap"/);                       // fit data only
  });

  it('radar fog: enemy squadrons outside every sensor are never sent', async () => {
    const red = await state(A2, id.p2);
    expect(featureIds(red)).not.toContain(id.blue);                              // 333 km from Red's 30 km SAM
    expect(red.air.enemy[id.blue]).toBeUndefined();
    const blue = await state(A1, id.p1);
    expect(featureIds(blue)).toContain(id.blue);
    expect(featureIds(blue)).not.toContain(id.cap);
    await expect(save(A1, id.p1, [{ op: 'update', feature_id: id.blue, payload: { geometry: pt(1, 0), air_attacks: [{ target: id.cap, weapons: [{ weapon: id.agm, count: 1 }] }] } }]))
      .rejects.toThrow(/not on your radar/);
  });

  it('moves: speed, the base radius rule, attacks with salvos limited by range and ammo', async () => {
    await expect(save(A1, id.p1, [{ op: 'update', feature_id: id.blue, payload: { geometry: pt(6, 0) } }])).rejects.toThrow(/at most 600 km/);
    await expect(save(A1, id.p1, [{ op: 'update', feature_id: id.blue, payload: { geometry: pt(2.9, 0) } }])).rejects.toThrow(/combat radius \(310 km/);
    await rpc(A1, 'set_loadout', id.p1, id.blue, J([{ weapon: id.agm, count: 2 }]));                       // 600 kg: 380 km
    const strike = (n: number, at = 2.9) => ({ op: 'update', feature_id: id.blue, payload: { geometry: pt(at, 0), air_attacks: [{ target: id.tank, weapons: [{ weapon: id.agm, count: n }] }] } });
    await expect(save(A1, id.p1, [strike(13)])).rejects.toThrow(/only 12 of AGM-1 left/);
    await expect(save(A1, id.p1, [strike(2, 2.4)])).rejects.toThrow(/reaches 50 km; that target is 69 km/);
    await expect(save(A1, id.p1, [{ ...strike(2), payload: { ...strike(2).payload, air_attacks: [{ target: id.blueBase, weapons: [{ weapon: id.agm, count: 1 }] }] } }]))
      .rejects.toThrow(/friendly/);
    await expect(save(A1, id.p1, [{ op: 'update', feature_id: id.blue, payload: { attacks: [] } }])).rejects.toThrow(/squadron's draft/);
    expect((await save(A1, id.p1, [strike(12)])).count).toBe(1);
    await save(A2, id.p2, []);
  });

  it('push: AA, strikes, ammo spent, position kept; the enemy now sees it, also in the history', async () => {
    const { inputs, result } = await playTurn();
    const inp = inputs.air_units!.find((u) => u.id === id.blue)!;
    expect(inp).toMatchObject({ moved: true, landed_at: id.blueBase, attacks: [{ target: id.tank }] });
    expect(inputs.units.some((u) => u.id === id.blue)).toBe(false);              // squadrons never fight on the ground
    const st = result.air!.strikes[0];
    expect(st.shots).toBeGreaterThan(0);
    const sq = await squad(id.blue);
    expect(sq).toMatchObject({ state: 'airborne', base_feature_id: null });
    expect(sq.geometry.coordinates).toEqual([2.9, 0]);
    expect(sq.ammo[id.agm]).toBe(12 - st.shots);
    const tank = (await q('select strength from public.unit_state where feature_id = $1', [id.tank]))[0];
    expect(tank.strength).toBe(1000 - st.damage);
    expect(result.air!.log.packages.some((p) => p.kind === 'aa')).toBe(true);    // 13 km from the SAM
    const red = await state(A2, id.p2);
    expect(featureIds(red)).toContain(id.blue);
    expect(red.air.enemy[id.blue]).toMatchObject({ airframe: 'F-16', state: 'airborne' });
    expect(J(red.air.enemy)).not.toMatch(/aircraft|ammo|loadout/);
    const n = (await turn()).number;
    expect(featureIds(await rpc(A2, 'get_player_history', id.p2, n - 1))).toContain(id.blue);
    expect(featureIds(await rpc(A2, 'get_player_history', id.p2, n - 2))).not.toContain(id.blue);
    const rep = (await state(A1, id.p1)).combat.report;
    expect(rep.air.strikes[0]).toMatchObject({ squadron: 'Vipers', target: 'tank' });
  });

  it('share links show no squadrons unless their air picture says so', async () => {
    const link = (await as(OWNER, () => q('select * from public.create_share_link($1)', [id.map])))[0];
    expect(link.air_picture).toBe('none');
    expect(featureIds(await rpc(null, 'get_shared_map', link.token))).not.toContain(id.blue);
    await as(OWNER, () => q(`select public.update_share_link($1, $2)`, [link.id, J({ air_picture: 'team:Red' })]));
    const asRed = featureIds(await rpc(null, 'get_shared_map', link.token));
    expect(asRed).toContain(id.blue);
    expect(asRed).toContain(id.cap);                                              // its own
    await as(OWNER, () => q(`select public.update_share_link($1, $2)`, [link.id, J({ air_picture: 'team:Blue' })]));
    expect(featureIds(await rpc(null, 'get_shared_map', link.token))).toContain(id.cap);   // on Vipers' radar, 11 km away
    await expect(as(OWNER, () => q(`select public.update_share_link($1, $2)`, [link.id, J({ air_picture: 'everything' })]))).rejects.toThrow(/air picture/);
  });

  it('tankers: a refuel circle extends the reach; then without one the squadron is forced home and grounded', async () => {
    id.tk = await rpc(OWNER, 'save_squadron', id.map, J({ name: 'Shell', owner_player_id: id.p1, airframe_id: id.kc, state: 'airborne', pos: [1.5, 0], aircraft: 2 }));
    const far = { op: 'update', feature_id: id.blue, payload: { geometry: pt(4.4, 0) } };     // 489 km from the base, radius 380
    await expect(save(A1, id.p1, [far])).rejects.toThrow(/refuel circles/);
    expect((await save(A1, id.p1, [far, { op: 'update', feature_id: id.tk, payload: { geometry: pt(4.2, 0), refuel_priority: [id.blue] } }])).count).toBe(2);
    await expect(save(A1, id.p1, [{ op: 'update', feature_id: id.blue, payload: { refuel_priority: [] } }])).rejects.toThrow(/only tankers/);
    await save(A1, id.p1, [far, { op: 'update', feature_id: id.tk, payload: { geometry: pt(4.2, 0), refuel_priority: [id.blue] } }]);
    await save(A2, id.p2, []);
    const { result } = await playTurn();
    expect(result.air!.squadrons.find((x) => x.id === id.blue)).toMatchObject({ refueled_by: id.tk, state: 'airborne' });
    expect((await state(A1, id.p1)).combat.report.air.squadrons.find((x: Row) => x.name === 'Vipers').refueled_by).toBe('Shell');
    // The tanker is lost: nothing keeps Vipers out there, so it flies home at push and is grounded next turn.
    await as(OWNER, () => q('delete from public.features where id = $1', [id.tk]));
    await save(A1, id.p1, []);
    await save(A2, id.p2, []);
    const r2 = (await playTurn()).result;
    expect(r2.air!.squadrons.find((x) => x.id === id.blue)!.forced).toMatch(/out of reach/);
    const sq = await squad(id.blue);
    expect(sq).toMatchObject({ state: 'landed', base_feature_id: id.blueBase, grounded_until: (await turn()).number });
    expect(sq.ammo[id.agm]).toBe(12);                                               // rearmed on landing
    await expect(save(A1, id.p1, [{ op: 'update', feature_id: id.blue, payload: { geometry: pt(1, 0) } }])).rejects.toThrow(/grounded/);
    expect((await state(A1, id.p1)).air.squadrons.find((x: Row) => x.id === id.blue).grounded).toBe(true);
  });

  it('replacements only while landed, paid per aircraft at push', async () => {
    await rpc(OWNER, 'save_squadron', id.map, J({ id: id.blue, aircraft: 3 }));
    await expect(save(A1, id.p1, [{ op: 'buy_aircraft', feature_id: uuid(), payload: { squadron: id.blue, count: 4 } }])).rejects.toThrow(/room for 3/);
    const before = (await q('select spawn_points from public.players where id = $1', [id.p1]))[0].spawn_points;
    await save(A1, id.p1, [{ op: 'buy_aircraft', feature_id: uuid(), payload: { squadron: id.blue, count: 2 } }]);
    await save(A2, id.p2, []);
    await playTurn();
    expect(await squad(id.blue)).toMatchObject({ aircraft: 5, ammo: { [id.agm]: 10 } });
    expect((await q('select spawn_points from public.players where id = $1', [id.p1]))[0].spawn_points).toBe(before - 14);
    await rpc(OWNER, 'save_squadron', id.map, J({ id: id.blue, state: 'airborne', pos: [1, 0] }));
    await expect(save(A1, id.p1, [{ op: 'buy_aircraft', feature_id: uuid(), payload: { squadron: id.blue, count: 1 } }])).rejects.toThrow(/only while it is landed/);
  });

  it('rollback restores squadrons; older squadrons convert; players cannot touch the tables', async () => {
    await rpc(OWNER, 'rollback_to', id.map, 1);
    expect(await squad(id.blue)).toMatchObject({ aircraft: 6, state: 'landed', base_feature_id: id.blueBase });
    const legacy = uuid();
    await q(`select private.squadrons_to_units($1, $2)`, [id.map, J([{ id: legacy, name: 'Old', owner_player_id: id.p1, airframe_id: id.af, base_feature_id: id.blueBase,
      aircraft: 5, max_aircraft: 6, damage: 0, loadout: [{ weapon: id.m1, count: 2 }] }])]);
    expect(await squad(legacy)).toMatchObject({ state: 'landed', base_feature_id: id.blueBase, ammo: { [id.m1]: 10 } });
    await expect(as(A1, () => q('select * from public.air_units'))).rejects.toThrow(/permission denied/);
    await expect(rpc(A1, 'get_air_admin', id.map)).rejects.toThrow(/not authorised/);
  });
});
