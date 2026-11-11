// Tech tree, points and spawn rules against the real setup.sql (PGlite), as the owner and as players.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
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
  db = new PGlite();
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
    expect((await state(A1, id.p1)).spawn_points).toEqual([{ feature_id: id.depotBuy, center: [10, 50.005], radius_m: 5000, name: 'Depot' }]);
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
});
