// Upgrade path: a project that ran the earlier migrations (owner allowlist, per-submission review)
// and then runs setup.sql must keep its data and end up on the current schema.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';

const OWNER = '00000000-0000-4000-8000-00000000000a';
const ANON = '00000000-0000-4000-8000-0000000000a1';
const read = (f: string) => readFileSync(resolve(__dirname, f), 'utf8');

it('upgrades the previous schema in place', async () => {
  const db = new PGlite();
  const as = async (uid: string, anon: boolean, sql: string, params: unknown[] = []) => {
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid]);
    await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, is_anonymous: anon })]);
    await db.exec('set role authenticated');
    try {
      return (await db.query<Record<string, any>>(sql, params)).rows;
    } finally {
      await db.exec('reset role');
    }
  };
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create schema auth;
    create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    grant usage on schema auth to anon, authenticated;
    insert into auth.users values ('${OWNER}', 'o@example.com', now()), ('${ANON}', null, null);
  `);
  await db.exec(read('fixtures/legacy-schema.sql'));
  const map = (await as(OWNER, false, `insert into public.maps (name) values ('Old campaign') returning id`))[0].id;
  const layer = (await as(OWNER, false, `insert into public.layers (map_id, name) values ($1, 'L') returning id`, [map]))[0].id;
  await as(OWNER, false, `insert into public.features (map_id, layer_id, kind, geometry) values ($1, $2, 'text', '{"type":"Point","coordinates":[1,2]}')`, [map, layer]);
  const player = (await as(OWNER, false, `select * from public.create_player($1, 'Alice')`, [map]))[0];
  await as(ANON, true, 'select public.claim_invite($1)', [player.invite_token]);
  await as(ANON, true, 'select public.submit_turn($1, null, $2)', [player.id, JSON.stringify([{ op: 'create', feature_id: crypto.randomUUID(), payload: { kind: 'text', geometry: { type: 'Point', coordinates: [1, 1] } } }])]);

  await db.exec(read('../supabase/setup.sql'));
  await db.exec(read('../supabase/setup.sql'));

  expect((await db.query(`select to_regclass('public.submissions') as t, to_regclass('private.owners') as o`)).rows[0]).toEqual({ t: null, o: null });
  expect((await as(OWNER, false, 'select public.whoami() as w'))[0].w).toMatchObject({ is_admin: true, role: 'owner' });
  expect((await as(OWNER, false, 'select name from public.maps'))[0].name).toBe('Old campaign');
  expect(await as(OWNER, false, 'select count(*)::int as n from public.features')).toEqual([{ n: 1 }]);
  // The player's seat and link survive, and the old session is still bound.
  const state = (await as(ANON, true, 'select public.get_player_state($1) as s', [player.id]))[0].s;
  expect(state.player.name).toBe('Alice');
  expect(state.turn).toBeNull();
  const tid = (await as(OWNER, false, 'select public.open_turn($1) as t', [map]))[0].t;
  expect(tid).toBeTruthy();
  await as(ANON, true, 'select public.save_draft($1, $2)', [player.id, '[]']);
  await expect(as(ANON, true, 'select * from public.submit_turn($1, null, $2)', [player.id, '[]'])).rejects.toThrow(/does not exist/);
});
