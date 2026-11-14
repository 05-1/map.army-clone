// Tech tree, points and spawn rules against the real setup.sql (PGlite), as the owner and as players.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { postgis } from '@electric-sql/pglite-postgis';
import { beforeAll, describe, expect, it } from 'vitest';

const U = (n: string) => `00000000-0000-4000-8000-0000000000${n}`;
const OWNER = U('0a'), STRANGER = U('0c'), A1 = U('a1'), A2 = U('a2');
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
const uuid = () => crypto.randomUUID();
const pt = (lng: number, lat: number) => ({ type: 'Point', coordinates: [lng, lat] });
const rpc = (uid: string | null, fn: string, ...args: unknown[]) =>
  as(uid, async () => (await q(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`,
    args.map((a) => (a !== null && typeof a === 'object' && !Array.isArray(a) ? JSON.stringify(a) : a))))[0].r);
const save = (uid: string, player: string, changes: unknown[]) => rpc(uid, 'save_draft', player, J(changes));
const state = (uid: string, player: string) => rpc(uid, 'get_player_state', player) as Promise<Row>;
const buy = (item: string, lng: number, lat: number) =>
  ({ op: 'create', feature_id: uuid(), payload: { kind: 'symbol', geometry: pt(lng, lat), purchase_id: item, props: { name: 'bought' } } });
const research = (item: string) => ({ op: 'research', feature_id: item });
const player = async (pid: string) => (await q('select * from public.players where id = $1', [pid]))[0];
const turn = async () => (await q(`select * from public.turns where map_id = $1 and status in ('open','locked')`, [id.map]))[0];
const item = (p: Row) => rpc(OWNER, 'save_tech_item', id.map, J(p)) as Promise<string>;

/** Lock, accept every draft, push. */
async function push() {
  const t = await turn();
  await rpc(OWNER, 'lock_turn', t.id);
  for (const p of [id.p1, id.p2]) await rpc(OWNER, 'review_draft', t.id, p, J({ ready: true }));
  return rpc(OWNER, 'push_turn', t.id);
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
    insert into auth.users values ('${OWNER}', 'owner@example.com', now()), ('${STRANGER}', 's@example.com', now()), ('${A1}', null, null), ('${A2}', null, null);
  `);
  await db.exec(SETUP);
  await rpc(OWNER, 'claim_owner');
  id.map = (await as(OWNER, () => q(`select * from public.create_map('Tech')`)))[0].id;
  id.layer = (await q('select id from public.layers where map_id = $1', [id.map]))[0].id;
  for (const [k, name, team, uid] of [['p1', 'Alice', 'Blue', A1], ['p2', 'Bob', 'Red', A2]] as const) {
    const r = (await as(OWNER, () => q('select * from public.create_player($1, $2, $3)', [id.map, name, team])))[0];
    id[k] = r.id;
    expect((await rpc(uid, 'claim_invite', r.invite_token, null)).ok).toBe(true);
  }
});

describe('tech tree', () => {
  it('only admins edit the tree, and it cannot loop', async () => {
    await expect(rpc(STRANGER, 'save_tech_item', id.map, J({ name: 'x', sidc: 'SFGPUCI----F---' }))).rejects.toThrow(/not authorised/);
    await expect(rpc(A1, 'get_economy', id.map)).rejects.toThrow(/not authorised/);
    await expect(as(A1, () => q('select * from public.tech_items'))).rejects.toThrow(/permission denied/);

    id.depot = await item({ name: 'Depot', tier: 0, research_cost: 0, spawn_cost: 50, sidc: 'SFGPUSS----F---', spawn_radius_m: 5000, income_spawn: 10, placement: 'zone' });
    id.inf = await item({ name: 'Infantry', tier: 0, research_cost: 0, spawn_cost: 10, sidc: 'SFGPUCI----F---', placement: 'either' });
    id.armor = await item({ name: 'Armour', tier: 1, research_cost: 20, spawn_cost: 30, sidc: 'SFGPUCA----F---', prereqs: [id.inf], placement: 'spawn' });
    id.lab = await item({ name: 'Lab', tier: 0, research_cost: 0, spawn_cost: 5, sidc: 'SFGPUUS----F---', income_research: 4, placement: 'anywhere' });
    id.adv = await item({ name: 'Advanced armour', tier: 2, research_cost: 30, buyable: false, prereqs: [id.armor] });
    id.radar = await item({ name: 'Radar', tier: 1, research_cost: 10, buyable: false });
    await expect(item({ id: id.inf, name: 'Infantry', sidc: 'SFGPUCI----F---', prereqs: [id.adv] })).rejects.toThrow(/require itself/);
    await expect(item({ name: 'Nothing to buy', buyable: true })).rejects.toThrow();
    const eco = await rpc(OWNER, 'get_economy', id.map);
    expect(eco.items.map((x: Row) => x.name)).toEqual(['Depot', 'Infantry', 'Lab', 'Armour', 'Radar', 'Advanced armour']);
    expect(eco.items.find((x: Row) => x.id === id.inf).prereqs).toEqual([]);   // the failed edit changed nothing
  });

  it('owner sets points, zones and grants; players see the tree and their own balances', async () => {
    await rpc(OWNER, 'set_player_points', id.p1, 100, 25);
    await rpc(OWNER, 'set_player_points', id.p2, 15, null);
    await expect(rpc(A1, 'set_player_points', id.p1, 9999, 9999)).rejects.toThrow(/not authorised/);
    id.zone = await rpc(OWNER, 'save_spawn_zone', id.map, J({ name: 'Blue base', team: 'Blue', zone: { center: [10, 50], radius_m: 3000 } }));
    await rpc(OWNER, 'save_spawn_zone', id.map, J({ name: 'Red base', player_id: id.p2, zone: { center: [20, 50], radius_m: 3000 } }));
    await expect(rpc(OWNER, 'save_spawn_zone', id.map, J({ zone: null }))).rejects.toThrow(/invalid spawn zone/);
    await rpc(OWNER, 'open_turn', id.map, J({}));

    const s = await state(A1, id.p1);
    expect(s.economy).toMatchObject({ spawn_points: 100, research_points: 25, tech_unlocked: [], income: { spawn: 0, research: 0 } });
    expect(s.tech).toHaveLength(6);
    expect(s.spawn_zones.map((z: Row) => z.name)).toEqual(['Blue base']);     // not Red's
  });

  it('save_draft enforces unlocks, prerequisites, placement and cost', async () => {
    // Not researched yet / prerequisites missing.
    await expect(save(A1, id.p1, [buy(id.armor, 10, 50)])).rejects.toThrow(/not researched/);
    await expect(save(A1, id.p1, [research(id.adv)])).rejects.toThrow(/prerequisites/);
    await expect(save(A1, id.p1, [research(id.inf)])).rejects.toThrow(/already available/);
    // Placement: depot only in a zone, infantry in a zone (no spawn points yet), lab anywhere.
    await expect(save(A1, id.p1, [buy(id.depot, 15, 50)])).rejects.toThrow(/spawn zones/);
    await expect(save(A1, id.p1, [buy(id.depot, 20, 50)])).rejects.toThrow(/spawn zones/);       // Red's zone
    await expect(save(A2, id.p2, [buy(id.inf, 10, 50)])).rejects.toThrow(/spawn/);               // Blue's zone
    // Cost.
    await expect(save(A1, id.p1, [buy(id.depot, 10, 50), buy(id.depot, 10.01, 50), buy(id.inf, 10, 50.01)])).rejects.toThrow(/not enough spawn points: this draft costs 110, you have 100/);
    await expect(save(A1, id.p1, [research(id.armor), research(id.radar)])).rejects.toThrow(/not enough research points: this draft costs 30, you have 25/);
    // A unit cannot be forged into a different one or into an income source.
    const forged = buy(id.inf, 10, 50);
    (forged.payload as Row).props = { name: 'x', tech: id.lab, sidc: 'SFGPUCA----F---' };
    await save(A1, id.p1, [forged]);
    const stored = (await q('select changes from public.drafts where player_id = $1', [id.p1]))[0].changes[0].payload;
    expect(stored.props).toMatchObject({ tech: id.inf, sidc: 'SFGPUCI----F---', name: 'x' });

    id.depotBuy = uuid();
    const ok = [research(id.armor), { ...buy(id.depot, 10, 50.005), feature_id: id.depotBuy }, buy(id.inf, 10.01, 50), buy(id.lab, 30, 30)];
    expect((await save(A1, id.p1, ok)).count).toBe(4);
    expect((await save(A2, id.p2, [buy(id.inf, 20, 50.01)])).count).toBe(1);
  });

  it('push charges costs, unlocks research and pays income from units on the map', async () => {
    await push();
    const a = await player(id.p1);
    // 100 - 50 - 10 - 5 spawn, + 10 depot income; 25 - 20 research, + 4 lab income.
    expect([a.spawn_points, a.research_points, a.tech_unlocked]).toEqual([45, 9, [id.armor]]);
    expect((await player(id.p2)).spawn_points).toBe(5);
    const depot = (await q('select * from public.features where id = $1', [id.depotBuy]))[0];
    expect(depot).toMatchObject({ owner_player_id: id.p1, kind: 'symbol' });
    expect(depot.props.tech).toBe(id.depot);
    expect((await state(A1, id.p1)).economy.income).toEqual({ spawn: 10, research: 4 });
    expect((await state(A1, id.p1)).spawn_points).toEqual([{ feature_id: id.depotBuy, center: [10, 50.005], radius_m: 5000, name: 'Depot', item_id: id.depot }]);
  });

  it('a spawn unit lets its owner place nearby; rejected purchases cost nothing', async () => {
    // Armour is "spawn only": next to the depot (outside every zone) works, far away does not.
    await expect(save(A1, id.p1, [buy(id.armor, 30, 30)])).rejects.toThrow(/spawn points/);
    const tank = buy(id.armor, 10, 50.04);
    const inf = buy(id.inf, 10, 50.03);
    await save(A1, id.p1, [tank, inf]);
    const t = await turn();
    await rpc(OWNER, 'lock_turn', t.id);
    await rpc(OWNER, 'review_draft', t.id, id.p1, J({ ready: true, rejected: [tank.feature_id] }));
    await rpc(OWNER, 'push_turn', t.id);
    // 45 - 10 (infantry only) + 10 income.
    expect((await player(id.p1)).spawn_points).toBe(45);
    expect((await q('select count(*)::int n from public.features where id = $1', [tank.feature_id]))[0].n).toBe(0);
  });

  it('push re-validates: points spent elsewhere in the meantime fail the push, naming the player', async () => {
    await rpc(OWNER, 'set_player_points', id.p2, 20, null);
    await save(A2, id.p2, [buy(id.inf, 20, 50.02)]);
    await rpc(OWNER, 'set_player_points', id.p2, 0, null);
    const t = await turn();
    await rpc(OWNER, 'lock_turn', t.id);
    await rpc(OWNER, 'review_draft', t.id, id.p2, J({ ready: true }));
    await expect(rpc(OWNER, 'push_turn', t.id)).rejects.toThrow(/Bob: not enough spawn points/);
    await rpc(OWNER, 'review_draft', t.id, id.p2, J({ clear: true }));
    await rpc(OWNER, 'push_turn', t.id);
  });

  it('owner grants research and tags existing units; rollback restores balances', async () => {
    await rpc(OWNER, 'set_player_tech', id.p2, id.armor, true);
    await rpc(OWNER, 'set_player_tech', id.p2, id.armor, true);
    expect((await player(id.p2)).tech_unlocked).toEqual([id.armor]);
    // An owner-placed unit tagged with the Lab item pays its player.
    await as(OWNER, () => q(`insert into public.features (map_id, layer_id, kind, geometry, props, owner_player_id) values ($1, $2, 'symbol', $3, $4, $5)`,
      [id.map, id.layer, J(pt(20, 50)), J({ name: 'HQ lab', sidc: 'SFGPUUS----F---', tech: id.lab }), id.p2]));
    const before = await player(id.p2);
    const snapTurn = (await turn()).number - 1;
    await push();
    expect((await player(id.p2)).research_points).toBe(before.research_points + 4);
    await rpc(OWNER, 'rollback_to', id.map, snapTurn);
    const after = await player(id.p2);
    expect([after.spawn_points, after.research_points]).toEqual([before.spawn_points, before.research_points]);
  });

  it('snapshots never show balances to players or viewers; backups keep the tree', async () => {
    const hist = await rpc(A1, 'get_player_history', id.p1, 1);
    expect(J(hist)).not.toContain('economy');
    const backup = await rpc(OWNER, 'export_campaign', id.map);
    expect(backup.tech_items).toHaveLength(6);
    expect(backup.spawn_zones).toHaveLength(2);
    await rpc(OWNER, 'import_campaign', J(backup), true);
    expect((await rpc(OWNER, 'get_economy', id.map)).items).toHaveLength(6);
    expect((await player(id.p1)).tech_unlocked).toEqual([id.armor]);
  });

  it('deleting an item removes it from prerequisites and unlocks', async () => {
    await rpc(OWNER, 'delete_tech_item', id.armor);
    const eco = await rpc(OWNER, 'get_economy', id.map);
    expect(eco.items.find((x: Row) => x.id === id.adv).prereqs).toEqual([]);
    expect(eco.players.find((x: Row) => x.id === id.p1).tech_unlocked).toEqual([]);
  });

  it('a unit can be bought the same turn its research is done; rejecting the research alone fails the push', async () => {
    for (const [pl, uid] of [[id.p1, A1], [id.p2, A2]]) {
      const t = (await q('select invite_token from public.players where id = $1', [pl]))[0].invite_token;
      expect((await rpc(uid, 'claim_invite', t, null)).ok).toBe(true);
    }
    id.heli = await item({ name: 'Helicopter', research_cost: 5, spawn_cost: 5, sidc: 'SFAPMHA----F---', placement: 'anywhere' });
    await rpc(OWNER, 'set_player_points', id.p1, 100, 100);
    await expect(save(A1, id.p1, [buy(id.heli, 0, 0)])).rejects.toThrow(/not researched/);
    const r = research(id.heli);
    const h = buy(id.heli, 0, 0);
    expect((await save(A1, id.p1, [r, h])).count).toBe(2);
    const t = await turn();
    await rpc(OWNER, 'lock_turn', t.id);
    await rpc(OWNER, 'review_draft', t.id, id.p1, J({ ready: true, rejected: [id.heli] }));
    await expect(rpc(OWNER, 'push_turn', t.id)).rejects.toThrow(/Alice: Helicopter is not researched yet/);
    await rpc(OWNER, 'review_draft', t.id, id.p1, J({ rejected: [] }));
    await rpc(OWNER, 'push_turn', t.id);
    const a = await player(id.p1);
    expect(a.tech_unlocked).toContain(id.heli);
    expect((await q('select count(*)::int n from public.features where id = $1', [h.feature_id]))[0].n).toBe(1);
  });

  it('countries work as spawn zones: several parts, holes excluded', async () => {
    const sq = (x: number, y: number, d: number) => [[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]];
    // Two islands; the first has a lake in the middle.
    const country = { type: 'MultiPolygon', coordinates: [[sq(40, 40, 2), sq(40.8, 40.8, 0.4)], [sq(50, 40, 1)]] };
    id.inland = await item({ name: 'Marines', spawn_cost: 1, sidc: 'SFGPUCI----F---', placement: 'zone' });
    await rpc(OWNER, 'save_spawn_zone', id.map, J({ name: 'Atlantis', player_id: id.p1, zone: country }));
    await expect(rpc(OWNER, 'save_spawn_zone', id.map, J({ zone: { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 1]]]] } }))).rejects.toThrow(/invalid spawn zone/);
    await expect(save(A1, id.p1, [buy(id.inland, 41, 41)])).rejects.toThrow(/spawn zone/);     // in the lake
    await expect(save(A1, id.p1, [buy(id.inland, 45, 41)])).rejects.toThrow(/spawn zone/);     // at sea
    expect((await save(A1, id.p1, [buy(id.inland, 40.5, 40.5), buy(id.inland, 50.5, 40.5)])).count).toBe(2);
    expect((await state(A1, id.p1)).spawn_zones.find((z: Row) => z.name === 'Atlantis').zone.type).toBe('MultiPolygon');
    await save(A1, id.p1, []);
  });

  it('flowchart positions are saved by the owner only', async () => {
    expect(await rpc(OWNER, 'move_tech_items', id.map, J([{ id: id.heli, x: 120, y: -80 }, { id: uuid(), x: 1, y: 1 }]))).toBe(1);
    await expect(rpc(A1, 'move_tech_items', id.map, J([{ id: id.heli, x: 0, y: 0 }]))).rejects.toThrow(/not authorised/);
    const it = (await rpc(OWNER, 'get_economy', id.map)).items.find((x: Row) => x.id === id.heli);
    expect([it.pos_x, it.pos_y]).toEqual([120, -80]);
    // Saving the item's other fields without a position keeps it.
    await item({ id: id.heli, name: 'Helicopter', research_cost: 5, spawn_cost: 6, sidc: 'SFAPMHA----F---', placement: 'anywhere' });
    expect((await rpc(OWNER, 'get_economy', id.map)).items.find((x: Row) => x.id === id.heli).pos_x).toBe(120);
  });

  it('production buildings: players build them, they cannot move, and units come only from the right building', async () => {
    await rpc(OWNER, 'set_player_points', id.p1, 1000, 0);
    id.barracks = await item({ name: 'Barracks', category: 'building', can_move: false, spawn_cost: 40, sidc: 'SFGPIB-----H---', spawn_radius_m: 3000, placement: 'anywhere' });
    id.rifle = await item({ name: 'Rifles', spawn_cost: 5, sidc: 'SFGPUCI----F---', placement: 'spawn', spawn_from: [id.barracks] });
    await expect(item({ name: 'Bad', sidc: 'SFGPUCI----F---', spawn_from: [uuid()] })).rejects.toThrow(/producing building/);
    // Build barracks far from everything, push, then recruit next to it (not next to the old depot).
    const b = buy(id.barracks, 60, 10);
    await save(A1, id.p1, [b]);
    await push();
    expect((await player(id.p1)).spawn_points).toBe(1000 - 40 + 10);           // + depot income
    const depot = (await q('select geometry from public.features where id = $1', [id.depotBuy]))[0].geometry.coordinates;
    await expect(save(A1, id.p1, [buy(id.rifle, depot[0], depot[1] + 0.001)])).rejects.toThrow(/spawn point/);
    expect((await save(A1, id.p1, [buy(id.rifle, 60, 10.01)])).count).toBe(1);
    // The building stays where it was built.
    await expect(save(A1, id.p1, [{ op: 'update', feature_id: b.feature_id, payload: { geometry: pt(60, 10.001) } }])).rejects.toThrow(/cannot be moved/);
    expect((await state(A1, id.p1)).radii[b.feature_id]).toBe(0);
    await save(A1, id.p1, []);
    // Deleting the building item clears it from what produces Rifles.
    await rpc(OWNER, 'delete_tech_item', id.barracks);
    expect((await rpc(OWNER, 'get_economy', id.map)).items.find((x: Row) => x.id === id.rifle).spawn_from).toEqual([]);
  });

  it('movement range per unit type comes from the tech tree; a per-unit override still wins', async () => {
    id.scout = await item({ name: 'Scouts', spawn_cost: 1, sidc: 'SFGPUCR----F---', placement: 'anywhere', move_range_m: 1000 });
    const b = buy(id.scout, 70, 10);
    await save(A1, id.p1, [b]);
    await push();
    const t = await turn();
    await rpc(OWNER, 'update_turn', t.id, J({ default_radius_m: 100000 }));
    expect((await state(A1, id.p1)).radii[b.feature_id]).toBe(1000);
    const go = (km: number) => ({ op: 'update', feature_id: b.feature_id, payload: { geometry: pt(70, 10 + km / 111.2) } });
    await expect(save(A1, id.p1, [go(2)])).rejects.toThrow(/beyond the range of this unit \(1000 m\)/);
    expect((await save(A1, id.p1, [go(0.5)])).count).toBe(1);
    await rpc(OWNER, 'set_move_rule', t.id, b.feature_id, null, 5000);
    expect((await save(A1, id.p1, [go(2)])).count).toBe(1);
    await rpc(OWNER, 'set_move_rule', t.id, b.feature_id, null, null);
    // Blank range = the turn's default.
    await item({ id: id.scout, name: 'Scouts', spawn_cost: 1, sidc: 'SFGPUCR----F---', placement: 'anywhere', move_range_m: null });
    expect((await state(A1, id.p1)).radii[b.feature_id]).toBe(100000);
    await save(A1, id.p1, []);
  });

  it('a whole research chain can be done in one turn; rejecting a link fails what depends on it', async () => {
    id.c1 = await item({ name: 'Optics', research_cost: 1, buyable: false });
    id.c2 = await item({ name: 'Night vision', research_cost: 1, buyable: false, prereqs: [id.c1] });
    id.c3 = await item({ name: 'Snipers', research_cost: 1, spawn_cost: 1, sidc: 'SFGPUCI----F---', placement: 'anywhere', prereqs: [id.c2] });
    await rpc(OWNER, 'set_player_points', id.p1, 100, 100);
    await expect(save(A1, id.p1, [research(id.c3), research(id.c2)])).rejects.toThrow(/Snipers|Night vision/);   // Optics missing
    const sn = buy(id.c3, 71, 11);
    expect((await save(A1, id.p1, [research(id.c3), research(id.c2), research(id.c1), sn])).count).toBe(4);
    const t = await turn();
    await rpc(OWNER, 'lock_turn', t.id);
    await rpc(OWNER, 'review_draft', t.id, id.p1, J({ ready: true, rejected: [id.c1] }));
    await expect(rpc(OWNER, 'push_turn', t.id)).rejects.toThrow(/Alice: .*prerequisites/);
    await rpc(OWNER, 'review_draft', t.id, id.p1, J({ rejected: [] }));
    await rpc(OWNER, 'push_turn', t.id);
    expect((await player(id.p1)).tech_unlocked).toEqual(expect.arrayContaining([id.c1, id.c2, id.c3]));
  });

  it('tech is released turn by turn: hidden and locked before its turn', async () => {
    const now = (await turn()).number;
    id.late = await item({ name: 'Jets', research_cost: 2, buyable: false, release_turn: now + 1 });
    id.freeLate = await item({ name: 'Militia', research_cost: 0, spawn_cost: 1, sidc: 'SFGPUCI----F---', placement: 'anywhere', release_turn: now + 1 });
    const names = (s: Row) => s.tech.map((x: Row) => x.name);
    expect(names(await state(A1, id.p1))).not.toContain('Jets');
    expect(names(await state(A1, id.p1))).not.toContain('Militia');
    expect((await rpc(OWNER, 'get_economy', id.map)).items.map((x: Row) => x.name)).toContain('Jets');   // the owner sees everything
    await expect(save(A1, id.p1, [research(id.late)])).rejects.toThrow(new RegExp(`Jets can be researched from turn ${now + 1}`));
    await expect(save(A1, id.p1, [buy(id.freeLate, 72, 12)])).rejects.toThrow(/not researched/);
    await push();
    expect(names(await state(A1, id.p1))).toEqual(expect.arrayContaining(['Jets', 'Militia']));
    expect((await save(A1, id.p1, [research(id.late), buy(id.freeLate, 72, 12)])).count).toBe(2);
    await save(A1, id.p1, []);
  });

  it("units a player creates wear the player's colour, and follow a colour change", async () => {
    await rpc(OWNER, 'update_player', id.p1, J({ color: '#ff0000' }));
    await rpc(OWNER, 'set_player_points', id.p1, 100, null);
    const b = buy(id.heli, 73, 13);
    (b.payload as Row).props = { name: 'x', tint: '#00ff00', made_by: id.p2 };          // cannot be forged
    await save(A1, id.p1, [b]);
    const draft = (await q('select changes from public.drafts d join public.turns t on t.id = d.turn_id where d.player_id = $1 and t.status = $2', [id.p1, 'open']))[0].changes;
    expect(draft[0].payload.props).toMatchObject({ tint: '#ff0000', made_by: id.p1 });
    await push();
    expect((await q('select props from public.features where id = $1', [b.feature_id]))[0].props).toMatchObject({ tint: '#ff0000', made_by: id.p1 });
    await rpc(OWNER, 'update_player', id.p1, J({ color: '#0000ff' }));
    expect((await q('select props from public.features where id = $1', [b.feature_id]))[0].props.tint).toBe('#0000ff');
  });
});
