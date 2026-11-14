// Ground combat against the real setup.sql (PGlite + PostGIS): templates, attack orders, engine inputs,
// preview fingerprint, push, intel, reports, settings versions, terrain, rollback. The engine that turns
// inputs into a result is the real one (app/lib/combat.ts), as in the owner's browser.
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
const km = (k: number) => k / 111.195;
const rpc = (uid: string | null, fn: string, ...args: unknown[]) =>
  as(uid, async () => (await q(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`,
    args.map((a) => (a !== null && typeof a === 'object' && !Array.isArray(a) ? JSON.stringify(a) : a))))[0].r);
const save = (uid: string, player: string, changes: unknown[]) => rpc(uid, 'save_draft', player, J(changes));
const state = (uid: string, player: string) => rpc(uid, 'get_player_state', player) as Promise<Row>;
const turn = async () => (await q(`select * from public.turns where map_id = $1 and status in ('open','locked')`, [id.map]))[0];
const unitState = async (fid: string) => (await q('select * from public.unit_state where feature_id = $1', [fid]))[0];
const salt = { salt: 's1', salts: {}, edits: {} };

/** Lock, accept drafts, preview with the real engine, push. Returns the engine result. */
async function playTurn(edits: Record<string, number> = {}) {
  const t = await turn();
  if (t.status === 'open') await rpc(OWNER, 'lock_turn', t.id);
  for (const p of [id.p1, id.p2]) await rpc(OWNER, 'review_draft', t.id, p, J({ ready: true }));
  const inputs = (await rpc(OWNER, 'get_combat_inputs', t.id)) as CombatInputs;
  const data = { ...salt, edits };
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
  id.map = (await as(OWNER, () => q(`select * from public.create_map('War')`)))[0].id;
  id.layer = (await q('select id from public.layers where map_id = $1', [id.map]))[0].id;
  for (const [k, name, team, uid] of [['p1', 'Blue', 'Blue', A1], ['p2', 'Red', 'Red', A2]] as const) {
    const r = (await as(OWNER, () => q('select * from public.create_player($1, $2, $3)', [id.map, name, team])))[0];
    id[k] = r.id;
    expect((await rpc(uid, 'claim_invite', r.invite_token, null)).ok).toBe(true);
  }
});

describe('ground combat', () => {
  it('owner manages weapons and templates; players cannot', async () => {
    id.gun = await rpc(OWNER, 'save_weapon', id.map, J({ name: '120mm', attacks: 100, ap: 28, range_m: 4000 }));
    id.mg = await rpc(OWNER, 'save_weapon', id.map, J({ name: 'MG', attacks: 30, ap: 2, range_m: 1500 }));
    id.how = await rpc(OWNER, 'save_weapon', id.map, J({ name: '155mm', attacks: 60, ap: 15, range_m: 30000, indirect: true }));
    id.tank = await rpc(OWNER, 'save_unit_template', id.map, J({ name: 'MBT', max_strength: 1000, armor: 25, sidc: 'SFGPUCA----F---', weapon_ids: [id.gun, id.mg] }));
    id.arty = await rpc(OWNER, 'save_unit_template', id.map, J({ name: 'SPG', max_strength: 500, armor: 5, sidc: 'SFGPUCF----F---', weapon_ids: [id.how] }));
    id.jet = await rpc(OWNER, 'save_unit_template', id.map, J({ name: 'Jet', max_strength: 300, armor: 2, category: 'air', sidc: 'SFAPMF-----F---', weapon_ids: [id.mg] }));
    await expect(rpc(A1, 'save_weapon', id.map, J({ name: 'x' }))).rejects.toThrow(/not authorised/);
    await expect(as(A1, () => q('select * from public.weapon_profiles'))).rejects.toThrow(/permission denied/);
    const admin = await rpc(OWNER, 'get_combat_admin', id.map);
    expect(admin.templates.map((t: Row) => t.name)).toEqual(['MBT', 'SPG', 'Jet']);
    expect(admin.settings.attacker_stationary).toBe(1.1);
  });

  it('units find their template from the symbol; players see own stats without attacks or AP', async () => {
    const mk = async (key: string, lng: number, lat: number, owner: string, sidc: string, heading?: number) => {
      id[key] = (await as(OWNER, () => q(`insert into public.features (map_id, layer_id, kind, geometry, props, owner_player_id) values ($1, $2, 'symbol', $3, $4, $5) returning id`,
        [id.map, id.layer, J(pt(lng, lat)), J({ name: key, sidc, ...(heading != null ? { heading } : {}) }), owner])))[0].id;
    };
    await mk('b1', 10, 50, id.p1, 'SFGPUCA----F---');
    await mk('b2', 10.05, 50, id.p1, 'SFGPUCF----F---');
    await mk('r1', 10, 50 + km(2), id.p2, 'SFGPUCA----F---', 180);
    await mk('r2', 12, 50, id.p2, 'SFGPUCA----F---');                 // ~143 km away
    await mk('rjet', 10, 50 + km(1), id.p2, 'SFAPMF-----F---');
    await rpc(OWNER, 'open_turn', id.map, J({}));
    const s = await state(A1, id.p1);
    expect(s.combat.own[id.b1]).toMatchObject({ template: 'MBT', strength: 1000, max: 1000, engaged: false });
    expect(s.combat.own[id.b1].weapons).toEqual([{ slot: 0, name: '120mm', range_m: 4000, indirect: false }, { slot: 1, name: 'MG', range_m: 1500, indirect: false }]);
    expect(J(s.combat)).not.toMatch(/"attacks"|"ap"|"armor"/);
    expect(s.combat.seen[id.r1]).toMatchObject({ band: 'fresh' });
    expect(s.combat.seen[id.r2]).toBeUndefined();                     // beyond 100 km: nothing at all
    expect(J(s)).not.toContain(`"${id.r2}":{"band"`);
  });

  it('attack orders are validated: own weapons, one target each, ground targets only', async () => {
    const atk = (attacks: unknown) => ({ op: 'update', feature_id: id.b1, payload: { attacks } });
    await expect(save(A1, id.p1, [atk([{ slot: 5, target: id.r1 }])])).rejects.toThrow(/each weapon/);
    await expect(save(A1, id.p1, [atk([{ slot: 0, target: id.r1 }, { slot: 0, target: id.r2 }])])).rejects.toThrow(/each weapon/);
    await expect(save(A1, id.p1, [atk([{ slot: 0, target: id.b2 }])])).rejects.toThrow(/own unit/);
    await expect(save(A1, id.p1, [atk([{ slot: 0, target: id.rjet }])])).rejects.toThrow(/cannot be attacked on the ground/);
    expect((await save(A1, id.p1, [atk([{ slot: 0, target: id.r1 }, { slot: 1, target: id.r1 }])])).count).toBe(1);
  });

  it('push needs a preview built from exactly what it applies', async () => {
    const t = await turn();
    await rpc(OWNER, 'lock_turn', t.id);
    for (const p of [id.p1, id.p2]) await rpc(OWNER, 'review_draft', t.id, p, J({ ready: true }));
    await expect(rpc(OWNER, 'push_turn', t.id)).rejects.toThrow(/run the combat preview first/);
    const inputs = (await rpc(OWNER, 'get_combat_inputs', t.id)) as CombatInputs;
    expect(inputs.units.map((u) => u.name).sort()).toEqual(['b1', 'b2', 'r1', 'r2', 'rjet']);
    expect(inputs.units.find((u) => u.id === id.b1)!.attacks).toHaveLength(2);
    expect(inputs.units.every((u) => u.terrain === 'open')).toBe(true);
    const result = resolveCombat(inputs, salt);
    await rpc(OWNER, 'save_combat_preview', t.id, J({ data: salt, result }));
    expect((await rpc(OWNER, 'get_combat_preview', t.id)).stale).toBe(false);
    await rpc(OWNER, 'review_draft', t.id, id.p1, J({ rejected: [id.b1] }));            // something changed
    expect((await rpc(OWNER, 'get_combat_preview', t.id)).stale).toBe(true);
    await expect(rpc(OWNER, 'push_turn', t.id)).rejects.toThrow(/changed since the combat preview/);
    await rpc(OWNER, 'review_draft', t.id, id.p1, J({ rejected: [] }));
    const again = resolveCombat((await rpc(OWNER, 'get_combat_inputs', t.id)) as CombatInputs, salt);
    expect(again).toEqual(result);                                                      // reproducible
    await rpc(OWNER, 'save_combat_preview', t.id, J({ data: salt, result }));
    await rpc(OWNER, 'push_turn', t.id);
    // Applied exactly as previewed.
    const r1 = result.units.find((u) => u.id === id.r1)!;
    expect((await unitState(id.r1)).strength).toBe(r1.after);
    expect((await unitState(id.b1)).experience).toBe(1);
    const eng = (await q(`select * from public.engagements where map_id = $1`, [id.map]));
    expect(eng).toHaveLength(1);
    expect(eng[0]).toMatchObject({ status: 'active', turns_engaged: 1, start_turn: 1 });
    // The full log is stored with the snapshot, never shown to players.
    const snap = (await q('select payload from public.snapshots where map_id = $1 and turn_number = 1', [id.map]))[0].payload;
    expect(snap.combat_log.engagements[0].rounds[0].phases[0].shots.length).toBeGreaterThan(0);
    expect(J(await rpc(A1, 'get_player_history', id.p1, 1))).not.toContain('combat_log');
  });

  it('each player gets a report: own losses in full, others as a band within intel range', async () => {
    const red = (await state(A2, id.p2)).combat;
    expect(red.report.own.find((u: Row) => u.name === 'r1')).toMatchObject({ hit: true, max: 1000 });
    const e = red.report.engagements[0];
    expect(e.own).toEqual(['r1']);
    expect(e.others.map((o: Row) => o.name)).toEqual(['b1']);
    expect(['fresh', 'damaged', 'heavily damaged', 'critical']).toContain(e.others[0].band);
    expect(Object.keys(e.others[0]).sort()).toEqual(['band', 'name']);           // nothing exact about Blue
    expect(red.report.own.map((u: Row) => u.name)).not.toContain('b1');
    expect(red.engagements[0].units).toEqual(expect.arrayContaining([id.r1, id.b1]));
  });

  it('engaged units cannot move except by retreating; the parting round ends it', async () => {
    const away = { op: 'update', feature_id: id.r1, payload: { geometry: pt(10, 50 + km(20)) } };
    await expect(save(A2, id.p2, [away])).rejects.toThrow(/engaged in combat/);
    expect((await save(A2, id.p2, [{ ...away, payload: { ...away.payload, retreat: true } }])).count).toBe(1);
    const before = (await unitState(id.r1)).strength;
    const { result } = await playTurn();
    const log = result.log.engagements.find((x) => x.retreated.length)!;
    expect(log.parting!.shots.length).toBeGreaterThan(0);
    expect((await unitState(id.r1)).strength).toBeLessThan(before);
    expect((await q(`select status, end_reason from public.engagements where map_id = $1`, [id.map]))[0]).toMatchObject({ status: 'ended', end_reason: 'retreat' });
  });

  it('settings are versioned per turn; history keeps the old numbers', async () => {
    const now = (await turn()).number;
    expect(await rpc(OWNER, 'save_combat_settings', id.map, J({ recovery_pct: 25, terrain: { urban: 0.5 }, bogus: 1 }))).toBe(now);
    await expect(rpc(OWNER, 'save_combat_settings', id.map, J({ variance: 'lots' }))).rejects.toThrow(/invalid setting/);
    const inputs = (await rpc(OWNER, 'get_combat_inputs', (await turn()).id)) as CombatInputs;
    expect(inputs.settings).toMatchObject({ recovery_pct: 25, terrain: { urban: 0.5, forest: 0.8, open: 1 } });
    expect(inputs.settings).not.toHaveProperty('bogus');
    const v1 = (await q(`select private.combat_settings_for($1, 1) s`, [id.map]))[0].s;
    expect(v1.recovery_pct).toBe(10);
  });

  it('owner overrides strength and experience, and can end an engagement', async () => {
    await rpc(OWNER, 'set_unit_state', id.r2, J({ strength: 400, experience: 7 }));
    expect(await unitState(id.r2)).toMatchObject({ strength: 400, experience: 7 });
    await rpc(OWNER, 'set_unit_state', id.r2, J({ strength: 99999 }));
    expect((await unitState(id.r2)).strength).toBe(1000);                               // capped at max
    await expect(rpc(A1, 'set_unit_state', id.r2, J({ strength: 1 }))).rejects.toThrow(/not authorised/);
    await save(A1, id.p1, [{ op: 'update', feature_id: id.b1, payload: { attacks: [{ slot: 0, target: id.r1 }] } }]);
    await save(A2, id.p2, []);
    // r1 retreated 20 km: out of range now, so the attack fails and is logged.
    const { result } = await playTurn();
    expect(result.log.failed[0].reason).toMatch(/out of range/);
  });

  it('terrain: stored with PostGIS, looked up at the target, coverage stats, everyone can see it', async () => {
    const sq = (x: number, y: number, d: number) => [[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]];
    const stats = await rpc(OWNER, 'replace_terrain', id.map, J({
      zones: [{ type: 'urban', geometry: { type: 'Polygon', coordinates: sq(9.99, 50.01, 0.05) } },
              { type: 'forest', geometry: { type: 'MultiPolygon', coordinates: [sq(11.5, 49.5, 1)] } }],
      area: { type: 'Polygon', coordinates: sq(9, 49, 4) }, source: 'test' }));
    expect(stats.zones).toBe(2);
    expect(stats.urban_pct + stats.forest_pct + stats.open_pct).toBeCloseTo(100, 1);
    expect(stats.open_pct).toBeGreaterThan(90);
    expect((await q(`select private.terrain_at($1, array[10.0, 50.03]) t`, [id.map]))[0].t).toBe('urban');
    expect((await q(`select private.terrain_at($1, array[12.0, 50.0]) t`, [id.map]))[0].t).toBe('forest');
    expect((await q(`select private.terrain_at($1, array[9.5, 49.5]) t`, [id.map]))[0].t).toBe('open');
    expect((await rpc(A1, 'get_player_terrain', id.p1)).features).toHaveLength(2);
    const inputs = (await rpc(OWNER, 'get_combat_inputs', (await turn()).id)) as CombatInputs;
    expect(inputs.units.find((u) => u.id === id.r2)!.terrain).toBe('forest');
    await expect(rpc(A1, 'replace_terrain', id.map, J({ zones: [] }))).rejects.toThrow(/not authorised/);
  });

  it('rollback restores strength and engagements; destroyed units leave the map', async () => {
    const t = (await turn()).number;
    const r2 = await unitState(id.r2);
    await rpc(OWNER, 'set_unit_state', id.r2, J({ strength: 10 }));
    await save(A1, id.p1, [{ op: 'update', feature_id: id.b1, payload: { geometry: pt(12, 50 - km(1)), attacks: [{ slot: 0, target: id.r2 }] } }]);
    await save(A2, id.p2, []);
    const { result } = await playTurn();
    expect(result.units.find((u) => u.id === id.r2)!.destroyed).toBe(true);
    expect((await q('select count(*)::int n from public.features where id = $1', [id.r2]))[0].n).toBe(0);
    await rpc(OWNER, 'rollback_to', id.map, t - 1);
    expect((await unitState(id.r2)).strength).toBe(r2.strength);
  });
});
