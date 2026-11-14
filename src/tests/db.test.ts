// Database tests. Runs the real setup.sql against an in-process Postgres (PGlite) with Supabase's
// roles and stubs for auth.uid() / auth.jwt(), then exercises every role: anon, player, stranger, admin.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { postgis } from '@electric-sql/pglite-postgis';
import { beforeAll, describe, expect, it } from 'vitest';

const U = (n: string) => `00000000-0000-4000-8000-0000000000${n}`;
const OWNER = U('0a'), ADMIN2 = U('0b'), STRANGER = U('0c'), LATE = U('0d');
const A1 = U('a1'), A2 = U('a2'), A3 = U('a3'), A4 = U('a4');
const ANONS = new Set([A1, A2, A3, A4]);
const SETUP = readFileSync(resolve(__dirname, '../supabase/setup.sql'), 'utf8');

type Row = Record<string, any>;
let db: PGlite;
const id: Record<string, string> = {};
const tok: Record<string, string> = {};

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
const su = q;
const uuid = () => crypto.randomUUID();
const pt = (lng: number, lat: number) => ({ type: 'Point', coordinates: [lng, lat] });
/** rpc('name', a, b) as a given user; returns the single value. */
const rpc = (uid: string | null, fn: string, ...args: unknown[]) =>
  as(uid, async () => (await q(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`,
    args.map((a) => (a !== null && typeof a === 'object' && !Array.isArray(a) ? JSON.stringify(a) : a))))[0].r);
const J = (v: unknown) => JSON.stringify(v);
const save = (uid: string, player: string, changes: unknown[]) => rpc(uid, 'save_draft', player, J(changes));
const state = (uid: string, player: string) => rpc(uid, 'get_player_state', player) as Promise<Row | null>;
const feature = async (fid: string) => (await su('select * from public.features where id = $1', [fid]))[0] as Row | undefined;
const move = (fid: string, lng: number, lat: number) => ({ op: 'update', feature_id: fid, payload: { geometry: pt(lng, lat) } });
const place = (alloc: string, lng: number, lat: number, extra: Row = {}) =>
  ({ op: 'create', feature_id: uuid(), payload: { kind: 'asset', geometry: pt(lng, lat), allocation_id: alloc, asset_id: id.asset, ...extra } });
const turn = async () => (await su(`select * from public.turns where map_id = $1 and status in ('open','locked')`, [id.map]))[0] as Row;
const claim = async (uid: string, player: string, pin: string | null = null) => rpc(uid, 'claim_invite', tok[player], pin) as Promise<Row>;

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
    insert into auth.users values ('${OWNER}', 'owner@example.com', now()), ('${ADMIN2}', 'two@example.com', now()),
      ('${STRANGER}', 'stranger@example.com', now()), ('${LATE}', 'late@example.com', null),
      ('${A1}', null, null), ('${A2}', null, null), ('${A3}', null, null), ('${A4}', null, null);
  `);
  await db.exec(SETUP);
});

describe('setup.sql', () => {
  it('records a schema version that anyone can read, and nothing else', async () => {
    expect(await rpc(null, 'app_status')).toEqual({ schema_version: 8, claimed: false });
    await expect(as(null, () => q('select * from public.app_meta'))).rejects.toThrow(/permission denied/);
  });

  it('first signed-in account claims ownership, then the door locks', async () => {
    await expect(rpc(null, 'claim_owner')).rejects.toThrow(/permission denied/);
    await expect(rpc(A1, 'claim_owner')).rejects.toThrow(/sign in first/);
    expect(await rpc(OWNER, 'claim_owner')).toBe(true);
    await expect(rpc(STRANGER, 'claim_owner')).rejects.toThrow(/already has an owner/);
    expect(await rpc(OWNER, 'whoami')).toMatchObject({ is_admin: true, role: 'owner', email: 'owner@example.com' });
    expect(await rpc(STRANGER, 'whoami')).toMatchObject({ is_admin: false, role: null, claimed: true });
  });

  it('builds the fixture through owner RPCs', async () => {
    id.map = (await as(OWNER, () => q(`select * from public.create_map('Op A')`)))[0].id;
    await as(OWNER, async () => {
      id.blue = (await q(`select id from public.layers where map_id = $1`, [id.map]))[0].id;
      id.red = (await q(`insert into public.layers (map_id, name, z) values ($1, 'Red', 1) returning id`, [id.map]))[0].id;
      id.hidden = (await q(`insert into public.layers (map_id, name, z, visible) values ($1, 'Staging', 2, false) returning id`, [id.map]))[0].id;
      id.asset = (await q(`select * from public.add_asset('carrier', $1, 'image/png', 9, 9)`, [`${OWNER}/${uuid()}.png`]))[0].id;
      const mk = async (name: string, team: string, layers: string[] | null = null) => {
        const r = (await q('select * from public.create_player($1, $2, $3, $4, $5)', [id.map, name, team, '#0a84ff', layers]))[0];
        tok[r.id] = r.invite_token;
        return r.id as string;
      };
      id.p1 = await mk('Alice', 'Blue', [id.blue]);
      id.p2 = await mk('Bob', 'Blue', [id.blue]);
      id.p3 = await mk('Rita', 'Red');
      const unit = async (key: string, layer: string, lng: number, lat: number, owner: string | null) => {
        id[key] = (await q(`insert into public.features (map_id, layer_id, kind, geometry, props) values ($1, $2, 'symbol', $3, $4) returning id`,
          [id.map, layer, J(pt(lng, lat)), J({ name: key, sidc: 'SFGPUCI----F---' })]))[0].id;
        if (owner) await q('select public.assign_units($1, $2, $3)', [id.map, [id[key]], owner]);
      };
      await unit('u1', id.blue, 10, 50, id.p1);
      await unit('u2', id.blue, 10.2, 50, id.p2);
      await unit('r1', id.red, 11, 50, id.p3);
      await unit('secret', id.hidden, 12, 50, null);
      id.link = (await q('select * from public.create_share_link($1, $2, $3)', [id.map, 'live', [id.blue]]))[0].id;
      tok.link = (await q('select token from public.share_links where id = $1', [id.link]))[0].token;
    });
    expect((await claim(A1, id.p1)).ok).toBe(true);
    expect((await claim(A2, id.p2)).ok).toBe(true);
    expect((await claim(A3, id.p3)).ok).toBe(true);
  });

  it('is safe to run again: data survives, version stays, functions are rebuilt', async () => {
    await db.exec(SETUP);
    await db.exec(SETUP);
    expect(await rpc(null, 'app_status')).toEqual({ schema_version: 8, claimed: true });
    expect((await su('select count(*)::int as n from public.features'))[0].n).toBe(4);
    expect((await su('select count(*)::int as n from public.players where invite_token is not null'))[0].n).toBe(3);
    expect((await state(A1, id.p1))?.player.name).toBe('Alice');
    // Column defaults dropped with the old functions were put back.
    const made = (await as(OWNER, () => q('select * from public.create_player($1, $2)', [id.map, 'Temp'])))[0];
    expect(made.invite_token).toMatch(/^[0-9a-f]{64}$/);
    await su('delete from public.players where id = $1', [made.id]);
  });
});

describe('who can touch what', () => {
  const tables = ['maps', 'layers', 'features', 'assets', 'share_links', 'players', 'turns', 'turn_move_rules', 'allocations', 'drafts', 'snapshots', 'activity', 'app_meta'];

  it('anon has no table access and only three functions', async () => {
    for (const t of tables) await expect(as(null, () => q(`select * from public.${t}`))).rejects.toThrow(/permission denied/);
    for (const f of ['whoami()', 'diagnostics()', `get_turn('${id.map}')`, `get_player_state('${id.p1}')`, `export_campaign('${id.map}')`]) {
      await expect(as(null, () => q(`select public.${f}`))).rejects.toThrow(/permission denied/);
    }
    expect((await rpc(null, 'keepalive')).ok).toBe(true);
  });

  it('players and signed-in strangers read nothing and write nothing', async () => {
    for (const uid of [A1, STRANGER]) {
      for (const t of ['maps', 'layers', 'features', 'assets', 'share_links', 'turns', 'allocations', 'drafts']) {
        expect(await as(uid, () => q(`select * from public.${t}`))).toEqual([]);
      }
      await expect(as(uid, () => q('select * from public.snapshots'))).rejects.toThrow(/permission denied/);
      await expect(as(uid, () => q('select pin_hash from public.players'))).rejects.toThrow(/permission denied/);
      await expect(as(uid, () => q(`insert into public.features (map_id, layer_id, kind, geometry) values ($1, $2, 'text', $3)`, [id.map, id.blue, J(pt(1, 1))]))).rejects.toThrow(/row-level security/);
      expect(await as(uid, () => q(`update public.features set z = 99 returning id`))).toEqual([]);
      await expect(as(uid, () => q(`insert into public.maps (name) values ('x')`))).rejects.toThrow(/permission denied/);
      await expect(as(uid, () => q(`update public.drafts set ready = true`))).rejects.toThrow(/permission denied/);
      for (const call of [`create_map('x')`, `open_turn('${id.map}')`, `get_turn('${id.map}')`, `export_campaign('${id.map}')`, `list_admins()`,
        `get_snapshot('${id.map}', 0)`, `rollback_to('${id.map}', 0)`, `set_player_pin('${id.p1}', '1234')`, `update_player('${id.p1}', '{"revoked":true}')`,
        `assign_units('${id.map}', '{${id.r1}}', '${id.p1}')`, `set_discord_webhook('${id.map}', null)`, `diagnostics()`, `list_activity()`,
        `update_map('${id.map}', '{"name":"x"}')`, `create_share_link('${id.map}')`, `invite_admin('a@b.co')`]) {
        await expect(as(uid, () => q(`select public.${call}`))).rejects.toThrow(/not authorised|map not found|only the owner/);
      }
    }
  });

  it('even an admin cannot write turn data, snapshots or players around the functions', async () => {
    await expect(as(OWNER, () => q(`update public.players set revoked = true`))).rejects.toThrow(/permission denied/);
    await expect(as(OWNER, () => q(`insert into public.drafts (turn_id, player_id) values ($1, $2)`, [uuid(), id.p1]))).rejects.toThrow(/permission denied/);
    await expect(as(OWNER, () => q(`delete from public.assets`))).rejects.toThrow(/permission denied/);
    await expect(as(OWNER, () => q(`select * from public.snapshots`))).rejects.toThrow(/permission denied/);
    expect((await as(OWNER, () => q('select name, pin_set from public.players where id = $1', [id.p1])))[0]).toEqual({ name: 'Alice', pin_set: false });
  });
});

describe('turn cycle', () => {
  it('opens turn 1 and stores the starting position as turn 0', async () => {
    id.turn = await rpc(OWNER, 'open_turn', id.map, J({ default_radius_m: 20000, conflict_m: 500 }));
    await expect(rpc(OWNER, 'open_turn', id.map)).rejects.toThrow(/already in progress/);
    expect((await turn()).number).toBe(1);
    expect((await su('select turn_number, label from public.snapshots where map_id = $1', [id.map]))).toEqual([{ turn_number: 0, label: 'Start' }]);
    await rpc(OWNER, 'set_move_rule', id.turn, id.u2, null, 0);        // Bob's unit is pinned
    const s = await state(A1, id.p1);
    expect(s?.turn).toMatchObject({ number: 1, status: 'open', frozen: false, default_radius_m: 20000 });
    expect(s?.radii).toEqual({ [id.u1]: 20000 });
    expect((await state(A2, id.p2))?.radii).toEqual({ [id.u2]: 0 });
  });

  it('enforces the movement radius from the start position, not from the last save', async () => {
    await save(A1, id.p1, [move(id.u1, 10.2, 50)]);                    // about 14.3 km east: fine
    await expect(save(A1, id.p1, [move(id.u1, 10.4, 50)])).rejects.toThrow(/beyond the range/);   // 28.6 km in one go
    // Creeping there in two saves does not work either: the origin is still the live position.
    await save(A1, id.p1, [move(id.u1, 10.25, 50)]);
    await expect(save(A1, id.p1, [move(id.u1, 10.45, 50)])).rejects.toThrow(/beyond the range/);
    await expect(save(A2, id.p2, [move(id.u2, 10.21, 50)])).rejects.toThrow(/beyond the range/);
    expect((await feature(id.u1))?.geometry.coordinates).toEqual([10, 50]);   // live map untouched
  });

  it('enforces ownership and keeps drafts to position, heading and orders', async () => {
    await expect(save(A1, id.p1, [move(id.u2, 10.21, 50)])).rejects.toThrow(/not assigned/);
    await expect(save(A1, id.p1, [move(id.secret, 12, 50)])).rejects.toThrow(/not assigned/);
    await expect(save(A1, id.p1, [{ op: 'update', feature_id: id.u1, payload: { props: { name: 'pwned' } } }])).rejects.toThrow(/position, heading, orders, attacks and retreat only/);
    await expect(save(A1, id.p1, [move(id.u1, 10.1, 50), move(id.u1, 10.1, 50)])).rejects.toThrow(/one change per object/);
    await expect(save(A2, id.p1, [move(id.u1, 10.1, 50)])).rejects.toThrow(/not a player/);
    await expect(save(STRANGER, id.p1, [])).rejects.toThrow(/not a player/);
    await expect(save(A1, id.p1, Array.from({ length: 201 }, () => ({ op: 'create', feature_id: uuid(), payload: { kind: 'text', geometry: pt(1, 1) } })))).rejects.toThrow(/too large/);
  });

  it('allocations: only your own, only the right unit, only inside the zone, only as many as allotted', async () => {
    const zone = { center: [10, 50], radius_m: 5000 };
    id.allocP1 = await rpc(OWNER, 'save_allocation', id.turn, J({ player_id: id.p1, asset_id: id.asset, quantity: 2, zone, props: { name: 'CVN', sizeMode: 'm', sizeM: 333 } }));
    id.allocRed = await rpc(OWNER, 'save_allocation', id.turn, J({ team: 'Red', sidc: 'SHGPUCI----E---', quantity: 1,
      zone: { type: 'Polygon', coordinates: [[[10.9, 49.9], [11.1, 49.9], [11.1, 50.1], [10.9, 50.1], [10.9, 49.9]]] } }));
    await expect(rpc(OWNER, 'save_allocation', id.turn, J({ player_id: id.p1, asset_id: id.asset, quantity: 0 }))).rejects.toThrow();
    await expect(rpc(OWNER, 'save_allocation', id.turn, J({ player_id: id.p1, asset_id: id.asset, quantity: 1, zone: { center: [999, 0], radius_m: 5 } }))).rejects.toThrow(/zone/);

    const s = await state(A1, id.p1);
    expect(s?.allocations).toHaveLength(1);
    expect(s?.allocations[0]).toMatchObject({ id: id.allocP1, quantity: 2, shared: false, used_by_others: 0 });
    expect(s?.allocation_assets.map((a: Row) => a.id)).toEqual([id.asset]);

    await expect(save(A1, id.p1, [place(id.allocP1, 10.2, 50)])).rejects.toThrow(/outside the placement zone/);
    await expect(save(A1, id.p1, [place(id.allocRed, 11, 50)])).rejects.toThrow(/not in your allocation/);
    await expect(save(A1, id.p1, [{ op: 'create', feature_id: uuid(), payload: { kind: 'asset', geometry: pt(10, 50), asset_id: id.asset } }])).rejects.toThrow(/not in your allocation/);
    await expect(save(A1, id.p1, [{ op: 'create', feature_id: uuid(), payload: { kind: 'symbol', geometry: pt(10, 50), allocation_id: id.allocP1, props: { sidc: 'SHGPUCI----E---' } } }])).rejects.toThrow(/does not match/);
    await expect(save(A1, id.p1, [place(id.allocP1, 10.01, 50), place(id.allocP1, 10.02, 50), place(id.allocP1, 10.03, 50)])).rejects.toThrow(/allocation used up/);

    // The allocation is the template: a player cannot resize or restyle the unit.
    const c = place(id.allocP1, 10.01, 50, { props: { name: 'Nimitz', heading: 90, sizeM: 99999, tint: '#ff0000' }, style: { color: '#ff0000' } });
    id.newCarrier = c.feature_id;
    await save(A1, id.p1, [move(id.u1, 10.2, 50), c, { op: 'create', feature_id: uuid(), payload: { kind: 'arrow', geometry: { type: 'LineString', coordinates: [[10, 50], [10.2, 50]] } } }]);
    const stored = (await state(A1, id.p1))?.draft.changes[1].payload;
    expect(stored.props).toEqual({ name: 'Nimitz', heading: 90, sizeMode: 'm', sizeM: 333 });
    expect(stored.style).toEqual({});
  });

  it('team pools are first come, first served', async () => {
    id.pool = await rpc(OWNER, 'save_allocation', id.turn, J({ team: 'Blue', asset_id: id.asset, quantity: 2 }));
    const mine = (await state(A2, id.p2))?.draft?.changes ?? [];
    await save(A2, id.p2, [...mine, place(id.pool, 10.5, 50.5), place(id.pool, 10.6, 50.5)]);
    expect((await state(A1, id.p1))?.allocations.find((a: Row) => a.id === id.pool)).toMatchObject({ shared: true, used_by_others: 2 });
    const d = (await state(A1, id.p1))?.draft.changes;
    await expect(save(A1, id.p1, [...d, place(id.pool, 10.7, 50.5)])).rejects.toThrow(/allocation used up: 2 of 2/);
    await expect(save(A3, id.p3, [place(id.pool, 10.7, 50.5)])).rejects.toThrow(/not in your allocation/);
  });

  it('nothing from a draft is visible to viewers or other players before the push', async () => {
    const viewer = await rpc(null, 'get_shared_map', tok.link);
    expect(viewer.features.map((f: Row) => f.id).sort()).toEqual([id.u1, id.u2].sort());
    expect(viewer.features.find((f: Row) => f.id === id.u1).geometry.coordinates).toEqual([10, 50]);
    const bob = await state(A2, id.p2);
    expect(J(bob)).not.toContain(id.newCarrier);
    expect(J(bob)).not.toContain('Nimitz');
    expect(bob?.draft.changes).toHaveLength(2);
  });

  it('ready can be toggled until the lock; the deadline freezes saves but not the toggle', async () => {
    await rpc(A1, 'set_ready', id.p1, true);
    await rpc(A1, 'set_ready', id.p1, false);
    await rpc(A1, 'set_ready', id.p1, true);
    await rpc(OWNER, 'update_turn', id.turn, J({ deadline: new Date(Date.now() - 1000).toISOString() }));
    expect((await state(A1, id.p1))?.turn).toMatchObject({ status: 'open', frozen: true });
    await expect(save(A1, id.p1, [])).rejects.toThrow(/deadline for this turn has passed/);
    await rpc(A2, 'set_ready', id.p2, false);
    // Owner extends the deadline: saving works again.
    await rpc(OWNER, 'update_turn', id.turn, J({ deadline: new Date(Date.now() + 7 * 864e5).toISOString() }));
    await save(A3, id.p3, [move(id.r1, 11.05, 50), { op: 'update', feature_id: id.u1, payload: { heading: 5 } }].slice(0, 1));
    await rpc(A3, 'set_ready', id.p3, true);
  });

  it('lock freezes everything; unlock reopens', async () => {
    await expect(rpc(OWNER, 'push_turn', id.turn)).rejects.toThrow(/turn 1 is open/);
    await rpc(OWNER, 'lock_turn', id.turn);
    await expect(save(A1, id.p1, [])).rejects.toThrow(/locked for review/);
    await expect(rpc(A1, 'set_ready', id.p1, false)).rejects.toThrow(/locked for review/);
    await rpc(OWNER, 'unlock_turn', id.turn);
    await rpc(A1, 'set_ready', id.p1, true);
    await rpc(OWNER, 'lock_turn', id.turn);
  });

  it('review: reject single changes, edit a draft, note per player, accept an unready draft', async () => {
    const t = await rpc(OWNER, 'get_turn', id.map);
    expect(t.drafts.map((d: Row) => [d.player_id, d.ready]).sort()).toEqual([[id.p1, true], [id.p2, false], [id.p3, true]].sort());
    const bob = t.drafts.find((d: Row) => d.player_id === id.p2);
    // Bob hoarded the team pool: reject one placement, accept the rest of his unready draft.
    id.bobKept = bob.changes[0].feature_id;
    id.bobRejected = bob.changes[1].feature_id;
    await rpc(OWNER, 'review_draft', id.turn, id.p2, J({ rejected: [id.bobRejected], ready: true, owner_note: 'One carrier is enough' }));
    // Rita's move is edited by the owner to somewhere beyond her radius: owner edits are not bound by it.
    await rpc(OWNER, 'review_draft', id.turn, id.p3, J({ owner_changes: [move(id.r1, 11.9, 50)] }));
    await expect(rpc(OWNER, 'review_draft', id.turn, id.p3, J({ owner_changes: [move(uuid(), 1, 1)] }))).rejects.toThrow(/not assigned/);
    await expect(rpc(OWNER, 'review_draft', id.turn, id.p3, J({ owner_changes: [{ op: 'update', feature_id: id.r1, payload: { geometry: pt(999, 0) } }] }))).rejects.toThrow(/invalid geometry/);
    // Players see none of this before the push.
    expect(J(await state(A2, id.p2))).not.toContain('One carrier is enough');
  });

  it('push is atomic: one bad change and nothing at all is applied', async () => {
    // The owner moves Alice's unit on the live map, so her saved move is now out of range.
    await as(OWNER, () => q(`update public.features set geometry = $2 where id = $1`, [id.u1, J(pt(9, 50))]));
    await expect(rpc(OWNER, 'push_turn', id.turn)).rejects.toThrow(/Alice: move is beyond the range/);
    expect((await turn()).status).toBe('locked');
    expect(await feature(id.newCarrier)).toBeUndefined();
    expect((await feature(id.r1))?.geometry.coordinates).toEqual([11, 50]);
    expect((await su('select count(*)::int as n from public.snapshots where map_id = $1', [id.map]))[0].n).toBe(1);
    await as(OWNER, () => q(`update public.features set geometry = $2 where id = $1`, [id.u1, J(pt(10, 50))]));
  });

  it('push applies accepted changes, snapshots the turn, opens the next one', async () => {
    await rpc(OWNER, 'update_turn', id.turn, J({ carry_allocations: true }));
    const r = await rpc(OWNER, 'push_turn', id.turn);
    expect(r).toEqual({ pushed: 1, next: 2, applied: 5 });
    expect((await feature(id.u1))?.geometry.coordinates).toEqual([10.2, 50]);
    expect(await feature(id.newCarrier)).toMatchObject({ kind: 'asset', asset_id: id.asset, owner_player_id: id.p1, layer_id: id.red, props: { name: 'Nimitz', sizeM: 333 } });
    expect((await feature(id.r1))?.geometry.coordinates).toEqual([11.9, 50]);
    expect(await feature(id.bobKept)).toBeTruthy();
    expect(await feature(id.bobRejected)).toBeUndefined();

    const next = await turn();
    expect(next).toMatchObject({ number: 2, status: 'open', default_radius_m: 20000, conflict_m: 500, carry_allocations: true });
    expect(+new Date(next.deadline)).toBeGreaterThan(Date.now() + 6 * 864e5);
    expect((await su('select feature_id, radius_m from public.turn_move_rules where turn_id = $1', [next.id]))).toEqual([{ feature_id: id.u2, radius_m: 0 }]);
    // Unplaced allocations carried over: Alice used 1 of 2, the Blue pool 1 of 2 (the rejected one is free again), Red 0 of 1.
    const carried = await su('select player_id, team, quantity from public.allocations where turn_id = $1 order by quantity, team', [next.id]);
    expect(carried.map((a) => a.quantity)).toEqual([1, 1, 1]);
    id.turn2 = next.id;

    const bob = await state(A2, id.p2);
    expect(bob?.last).toMatchObject({ number: 1, applied: true, owner_note: 'One carrier is enough', rejected: [id.bobRejected] });
    expect(bob?.draft).toBeNull();
    expect(bob?.history.map((h: Row) => h.number)).toEqual([0, 1]);
    await expect(rpc(OWNER, 'push_turn', id.turn)).rejects.toThrow(/turn 1 is pushed/);
    const kinds = (await rpc(OWNER, 'list_activity', id.map, 500)).map((a: Row) => a.kind);
    for (const k of ['opened turn', 'saved draft', 'marked ready', 'locked turn', 'reopened turn', 'pushed turn', 'joined']) expect(kinds).toContain(k);
  });

  it('a player who submitted nothing, or was never accepted, simply stays put', async () => {
    await rpc(A1, 'save_draft', id.p1, J([move(id.u1, 10.3, 50)]));    // saved, never marked ready
    await rpc(OWNER, 'lock_turn', id.turn2);
    expect(await rpc(OWNER, 'push_turn', id.turn2)).toMatchObject({ pushed: 2, applied: 0 });
    expect((await feature(id.u1))?.geometry.coordinates).toEqual([10.2, 50]);
    expect((await state(A1, id.p1))?.last).toMatchObject({ number: 2, applied: false });
  });
});

describe('history', () => {
  it('snapshots cannot be changed', async () => {
    await expect(su(`update public.snapshots set payload = '{}' where map_id = $1`, [id.map])).rejects.toThrow(/cannot be changed/);
  });

  it('old turns get the same layer filtering as the live map, for viewers and players', async () => {
    // Turn 1 snapshot holds Red and the hidden Staging layer. The link and Alice only see Blue.
    for (const n of [0, 1, 2]) {
      const v = await rpc(null, 'get_shared_map', tok.link, n);
      expect(v.viewing).toBe(n);
      expect(v.layers.map((l: Row) => l.id)).toEqual([id.blue]);
      expect(v.features.every((f: Row) => f.layer_id === id.blue)).toBe(true);
      const text = J(v);
      for (const leak of [id.red, id.hidden, id.r1, id.secret, id.newCarrier, 'owner_player_id', 'Staging']) expect(text).not.toContain(leak);
      const a = await rpc(A1, 'get_player_history', id.p1, n);
      expect(a.layers.map((l: Row) => l.id)).toEqual([id.blue]);
      expect(J(a)).not.toContain(id.secret);
      expect(J(a)).not.toContain(id.r1);
    }
    // Rita sees every layer that was visible in the editor, so Red but never Staging.
    const r = await rpc(A3, 'get_player_history', id.p3, 1);
    expect(r.layers.map((l: Row) => l.name).sort()).toEqual(['Layer 1', 'Red']);
    expect(J(r)).not.toContain(id.secret);
    expect(await rpc(A2, 'get_player_history', id.p1, 1)).toBeNull();
    expect(await rpc(STRANGER, 'get_player_history', id.p1, 1)).toBeNull();
    // Turn 0 really is the old position.
    const v0 = await rpc(null, 'get_shared_map', tok.link, 0);
    expect(v0.features.find((f: Row) => f.id === id.u1).geometry.coordinates).toEqual([10, 50]);
    // A layer made visible later does not reveal what it held in older snapshots.
    await as(OWNER, () => q('update public.layers set visible = true where id = $1', [id.hidden]));
    expect(J(await rpc(A3, 'get_player_history', id.p3, 1))).not.toContain(id.secret);
    await as(OWNER, () => q('update public.layers set visible = false where id = $1', [id.hidden]));
    // Revoked link: no history either.
    await rpc(OWNER, 'update_share_link', id.link, J({ revoked: true }));
    expect(await rpc(null, 'get_shared_map', tok.link, 1)).toBeNull();
    await rpc(OWNER, 'update_share_link', id.link, J({ revoked: false }));
  });

  it('the owner sees any past turn unfiltered', async () => {
    const s = await rpc(OWNER, 'get_snapshot', id.map, 1);
    expect(s.layers).toHaveLength(3);
    expect(s.features.map((f: Row) => f.id)).toEqual(expect.arrayContaining([id.secret, id.r1, id.newCarrier]));
    expect(s.features.find((f: Row) => f.id === id.u1).owner_player_id).toBe(id.p1);
  });

  it('soft-deleted graphics still render in old turns and on the map', async () => {
    await rpc(OWNER, 'update_asset', id.asset, J({ deleted: true }));
    expect((await su('select deleted_at from public.assets where id = $1', [id.asset]))[0].deleted_at).not.toBeNull();
    await as(OWNER, () => q('update public.features set layer_id = $2 where id = $1', [id.newCarrier, id.blue]));
    expect((await rpc(null, 'get_shared_map', tok.link)).assets.map((a: Row) => a.id)).toEqual([id.asset]);
    expect((await rpc(OWNER, 'get_snapshot', id.map, 1)).assets.map((a: Row) => a.id)).toEqual([id.asset]);
    await expect(rpc(OWNER, 'save_allocation', (await turn()).id, J({ player_id: id.p1, asset_id: id.asset, quantity: 1 }))).rejects.toThrow(/deleted graphic/);
    await rpc(OWNER, 'update_asset', id.asset, J({ deleted: false }));
  });

  it('rollback restores the map, keeps the abandoned drafts, and labels the new turn', async () => {
    const t3 = await turn();
    await save(A1, id.p1, [move(id.u1, 10.25, 50)]);
    const r = await rpc(OWNER, 'rollback_to', id.map, 0);
    expect(r).toEqual({ turn: 4, rollback_of: 0 });
    expect((await feature(id.u1))?.geometry.coordinates).toEqual([10, 50]);
    expect(await feature(id.newCarrier)).toBeUndefined();
    expect((await feature(id.u1))?.owner_player_id).toBe(id.p1);
    expect((await su('select status from public.turns where id = $1', [t3.id]))[0].status).toBe('rolled_back');
    expect((await su('select count(*)::int as n from public.drafts where turn_id = $1', [t3.id]))[0].n).toBe(1);   // archived, not deleted
    expect((await su('select turn_number from public.snapshots where map_id = $1 order by 1', [id.map])).map((s) => s.turn_number)).toEqual([0, 1, 2]);
    expect((await state(A1, id.p1))?.turn).toMatchObject({ number: 4, rollback_of: 0 });
    expect((await state(A1, id.p1))?.draft).toBeNull();
    const t4 = await turn();
    await rpc(OWNER, 'lock_turn', t4.id);
    await rpc(OWNER, 'push_turn', t4.id);
    const hist = (await rpc(null, 'get_shared_map', tok.link)).history;
    expect(hist.map((h: Row) => [h.number, h.label])).toEqual([[0, 'Start'], [1, null], [2, null], [4, 'Rolled back from turn 0']]);
  });

  it('backup and restore round-trips a campaign, links included', async () => {
    const backup = await rpc(OWNER, 'export_campaign', id.map);
    expect(backup).toMatchObject({ format: 'tacmap-campaign', version: 1, schema: 8 });
    expect(J(backup)).not.toContain('auth_uid');
    await expect(rpc(OWNER, 'import_campaign', J(backup))).rejects.toThrow(/already exists/);
    await expect(rpc(OWNER, 'import_campaign', J({ ...backup, format: 'nope' }))).rejects.toThrow(/not a Tacmap campaign/);
    await expect(rpc(OWNER, 'import_campaign', J({ ...backup, layers: [{ ...backup.layers[0], id: uuid(), map_id: uuid() }, ...backup.layers] }), true)).rejects.toThrow();
    expect((await su('select count(*)::int as n from public.maps where id = $1', [id.map]))[0].n).toBe(1);   // failed restore changed nothing

    const before = await rpc(OWNER, 'get_snapshot', id.map, 1);
    await su('delete from public.maps where id = $1', [id.map]);
    expect(await rpc(OWNER, 'import_campaign', J(backup))).toBe(id.map);
    expect(await rpc(OWNER, 'get_snapshot', id.map, 1)).toEqual(before);
    expect((await rpc(null, 'get_shared_map', tok.link)).history).toHaveLength(4);
    // Seats are unbound by a restore; the same invite link re-binds.
    expect(await state(A1, id.p1)).toBeNull();
    expect((await claim(A1, id.p1)).ok).toBe(true);
    expect((await state(A1, id.p1))?.turn.number).toBe(5);
    expect(await rpc(OWNER, 'import_campaign', J(backup), true)).toBe(id.map);
    for (const p of ['p1', 'p2', 'p3'] as const) await claim({ p1: A1, p2: A2, p3: A3 }[p], id[p]);
  });
});

describe('player sessions', () => {
  it('the invite link re-binds to a new device and signs the old one out', async () => {
    expect((await claim(A4, id.p1)).ok).toBe(true);
    expect(await state(A1, id.p1)).toBeNull();
    expect((await state(A4, id.p1))?.player.name).toBe('Alice');
    expect((await as(OWNER, () => q('select last_seen_at from public.players where id = $1', [id.p1])))[0].last_seen_at).not.toBeNull();
  });

  it('with a PIN, the link alone is not enough, and guessing locks the seat', async () => {
    await expect(rpc(OWNER, 'set_player_pin', id.p1, '12345')).rejects.toThrow(/4 digits/);
    await rpc(OWNER, 'set_player_pin', id.p1, '4821');
    expect((await claim(A4, id.p1)).ok).toBe(true);                      // already bound: no prompt
    expect(await claim(A1, id.p1)).toEqual({ ok: false, reason: 'pin_required' });
    expect(await claim(A1, id.p1, '0000')).toEqual({ ok: false, reason: 'wrong_pin', left: 4 });
    for (let i = 0; i < 3; i++) await claim(A1, id.p1, '0000');
    expect(await claim(A1, id.p1, '0000')).toMatchObject({ ok: false, reason: 'locked' });
    expect(await claim(A1, id.p1, '4821')).toMatchObject({ ok: false, reason: 'locked' });   // right PIN, still locked
    expect((await state(A4, id.p1))?.player.name).toBe('Alice');                              // the bound device is unaffected
    await rpc(OWNER, 'clear_pin_lockout', id.p1);
    expect((await claim(A1, id.p1, '4821')).ok).toBe(true);
    expect(await state(A4, id.p1)).toBeNull();
    const row = (await as(OWNER, () => q('select pin_set, pin_locked_until from public.players where id = $1', [id.p1])))[0];
    expect(row).toEqual({ pin_set: true, pin_locked_until: null });
    await rpc(OWNER, 'set_player_pin', id.p1, null);
    expect((await claim(A4, id.p1)).ok).toBe(true);
    await claim(A1, id.p1);
  });

  it('revoke, restore and regenerate', async () => {
    await rpc(OWNER, 'update_player', id.p2, J({ revoked: true }));
    expect(await state(A2, id.p2)).toBeNull();
    expect(await claim(A2, id.p2)).toEqual({ ok: false, reason: 'invalid' });
    await expect(save(A2, id.p2, [])).rejects.toThrow(/not a player/);
    await rpc(OWNER, 'update_player', id.p2, J({ revoked: false, name: 'Robert', color: '#30d158' }));
    expect((await state(A2, id.p2))?.player).toMatchObject({ name: 'Robert', color: '#30d158' });
    const old = tok[id.p2];
    tok[id.p2] = (await as(OWNER, () => q('select * from public.reset_player_invite($1)', [id.p2])))[0].invite_token;
    expect(await state(A2, id.p2)).toBeNull();
    expect(await rpc(A2, 'claim_invite', old, null)).toEqual({ ok: false, reason: 'invalid' });
    expect((await claim(A2, id.p2)).ok).toBe(true);
    await expect(rpc(OWNER, 'update_player', id.p2, J({ visible_layers: [uuid()] }))).rejects.toThrow(/not on this map/);
    expect(await rpc(OWNER, 'set_team_visibility', id.map, 'Blue', [id.blue, id.red])).toBe(2);
    expect((await state(A2, id.p2))?.layers.map((l: Row) => l.name).sort()).toEqual(['Layer 1', 'Red']);
  });
});

describe('admins and settings', () => {
  it('co-admins by email invite; never zero owners', async () => {
    await expect(rpc(ADMIN2, 'invite_admin', 'x@y.co')).rejects.toThrow(/only the owner/);
    expect(await rpc(OWNER, 'invite_admin', 'Two@Example.com')).toBe('added');       // confirmed account exists
    expect(await rpc(OWNER, 'invite_admin', 'late@example.com')).toBe('invited');    // unconfirmed: waits
    expect(await rpc(LATE, 'accept_admin_invite')).toBe(false);
    await su(`update auth.users set email_confirmed_at = now() where id = $1`, [LATE]);
    expect(await rpc(STRANGER, 'accept_admin_invite')).toBe(false);
    expect(await rpc(LATE, 'accept_admin_invite')).toBe(true);
    expect((await rpc(LATE, 'get_turn', id.map)).turn.number).toBe(5);                // co-admins run the game too
    await expect(rpc(ADMIN2, 'remove_admin', LATE)).rejects.toThrow(/only the owner/);
    await expect(rpc(OWNER, 'remove_admin', OWNER)).rejects.toThrow(/transfer ownership/);
    await expect(rpc(OWNER, 'transfer_ownership', STRANGER)).rejects.toThrow(/existing co-admin/);
    await rpc(OWNER, 'remove_admin', LATE);
    await expect(rpc(LATE, 'get_turn', id.map)).rejects.toThrow(/not authorised/);
    await rpc(OWNER, 'transfer_ownership', ADMIN2);
    expect((await rpc(OWNER, 'list_admins')).admins.map((a: Row) => [a.email, a.role])).toEqual([['two@example.com', 'owner'], ['owner@example.com', 'admin']]);
    await rpc(ADMIN2, 'transfer_ownership', OWNER);
    expect((await su(`select count(*)::int as n from private.admins where role = 'owner'`))[0].n).toBe(1);
  });

  it('the Discord webhook is write-only and Discord-only', async () => {
    await expect(rpc(OWNER, 'set_discord_webhook', id.map, 'https://evil.example/api/webhooks/1/abc')).rejects.toThrow(/not a Discord webhook/);
    await rpc(OWNER, 'set_discord_webhook', id.map, 'https://discord.com/api/webhooks/123456/abcdEFGH_secret-9876');
    expect(await rpc(OWNER, 'get_settings', id.map)).toEqual({ discord: 'https://discord.com/api/webhooks/…9876', pg_net: false });
    expect(await rpc(OWNER, 'test_discord_webhook', id.map)).toBe(false);            // no pg_net in the test database
    expect(J(await rpc(OWNER, 'export_campaign', id.map))).not.toContain('abcdEFGH');
    await rpc(OWNER, 'set_discord_webhook', id.map, null);
    expect((await rpc(OWNER, 'get_settings', id.map)).discord).toBeNull();
  });

  it('maps: rename, start view, palette, archive', async () => {
    const m = (await as(OWNER, () => q('select * from public.update_map($1, $2)', [id.map, J({ name: 'Op Alpha', basemap: 'topo', center: [10, 50], zoom: 7, palette_assets: [id.asset, uuid()], archived: true })])))[0];
    expect(m).toMatchObject({ name: 'Op Alpha', basemap: 'topo', center: [10, 50], zoom: 7, palette_assets: [id.asset], archived: true });
    await expect(rpc(OWNER, 'update_map', id.map, J({ basemap: 'mars' }))).rejects.toThrow();
    await expect(rpc(OWNER, 'update_map', id.map, J({ center: [500, 0] }))).rejects.toThrow(/start position/);
    await rpc(OWNER, 'update_map', id.map, J({ archived: false }));
  });

  it('keeps an activity log and reports diagnostics', async () => {
    const kinds = (await rpc(OWNER, 'list_activity', id.map, 500)).map((a: Row) => a.kind);
    // The log belongs to the map, so it restarted when the campaign was restored from backup.
    for (const k of ['restored backup', 'PIN lockout', 'opened on another device', 'set PIN', 'revoked player', 'regenerated invite']) {
      expect(kinds).toContain(k);
    }
    expect(await rpc(OWNER, 'diagnostics')).toMatchObject({ schema_version: 8, pg_net: false });
    expect((await rpc(OWNER, 'diagnostics')).last_keepalive).toBeTruthy();
  });

  it('owner recovery: one statement, then claim again', async () => {
    await su('delete from private.admins');
    expect(await rpc(null, 'app_status')).toMatchObject({ claimed: false });
    expect(await rpc(OWNER, 'claim_owner')).toBe(true);
  });
});
