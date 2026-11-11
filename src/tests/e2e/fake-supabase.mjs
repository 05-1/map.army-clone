// A stand-in for a Supabase project, for local end-to-end runs: the real setup.sql in an in-process
// Postgres (PGlite), behind just enough of the Auth, REST, Storage and Realtime HTTP surface for the
// app to work. It also serves src/dist (the last build), so the site and the API share one origin.
//
//   PORT=54399 node tests/e2e/fake-supabase.mjs      then open http://localhost:54399/
//
// Not a security model of Supabase: tokens are unsigned. It exists to exercise the UI against the
// real SQL. Every request runs as the role and JWT claims Supabase would use, so RLS and grants apply.
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const here = dirname(fileURLToPath(import.meta.url));
const SITE = resolve(here, '../../dist');
const PORT = Number(process.env.PORT ?? 54399);
const ORIGIN = `http://localhost:${PORT}`;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp' };

const db = new PGlite();
await db.exec(`
  create role anon nologin; create role authenticated nologin; create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text unique, email_confirmed_at timestamptz, password text, is_anonymous boolean default false);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  grant usage on schema auth to anon, authenticated;
`);
await db.exec(readFileSync(resolve(here, '../../supabase/setup.sql'), 'utf8'));

const files = new Map(); // storage bucket contents
export const state = { anonymous: true, log: [] };

// One connection, so requests take turns.
let chain = Promise.resolve();
const locked = (fn) => (chain = chain.then(fn, fn));
const ident = (s) => { if (!/^[a-z_][a-z0-9_]*$/i.test(s)) throw Object.assign(new Error(`bad identifier ${s}`), { status: 400 }); return `"${s}"`; };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (u) => `${b64({ alg: 'none' })}.${b64({ sub: u.id, role: 'authenticated', is_anonymous: u.is_anonymous, email: u.email ?? undefined, exp: Math.floor(Date.now() / 1000) + 3600 * 24 })}.x`;
const claimsOf = (req) => {
  const t = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  try { const c = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()); return c.sub ? c : null; } catch { return null; }
};
const userJson = (u) => ({ id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email ?? '', is_anonymous: u.is_anonymous, email_confirmed_at: u.email_confirmed_at, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() });
const session = (u) => ({ access_token: jwt(u), token_type: 'bearer', expires_in: 86400, expires_at: Math.floor(Date.now() / 1000) + 86400, refresh_token: `r.${u.id}`, user: userJson(u) });

async function asCaller(req, fn) {
  const c = claimsOf(req);
  await db.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)`, [c?.sub ?? '', JSON.stringify(c ?? {})]);
  await db.exec(`set role ${c ? 'authenticated' : 'anon'}`);
  try { return await fn(); } finally { await db.exec('reset role'); }
}

// The slice of PostgREST's filter syntax the app uses: col=eq.v, col=in.(a,b), order=col.desc, limit=n.
function where(q, params) {
  const out = [];
  for (const [k, v] of q) {
    if (['select', 'order', 'limit', 'on_conflict', 'columns'].includes(k)) continue;
    if (v.startsWith('eq.')) { params.push(v.slice(3)); out.push(`${ident(k)}::text = $${params.length}`); }
    else if (v.startsWith('in.(')) { params.push(v.slice(4, -1).split(',').map((s) => s.replace(/^"|"$/g, ''))); out.push(`${ident(k)}::text = any($${params.length})`); }
    else throw Object.assign(new Error(`unsupported filter ${k}=${v}`), { status: 400 });
  }
  return out.length ? ` where ${out.join(' and ')}` : '';
}

async function rest(req, url, body) {
  const [, , , table, fn] = url.pathname.split('/');
  if (table === 'rpc') {
    const args = Object.entries(body ?? {});
    const exists = await db.query(`select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = $1`, [fn]);
    if (!exists.rows.length) return [404, { code: 'PGRST202', message: `Could not find the function public.${fn}` }];
    const sql = `select to_jsonb(public.${ident(fn)}(${args.map(([k], i) => `${ident(k)} => $${i + 1}`).join(', ')})) as r`;
    const r = await asCaller(req, () => db.query(sql, args.map(([, v]) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : Array.isArray(v) && v.some((x) => typeof x === 'object') ? JSON.stringify(v) : v))));
    return [200, r.rows[0].r];
  }
  const params = [];
  const t = `public.${ident(table)}`;
  if (req.method === 'GET') {
    const cols = (url.searchParams.get('select') ?? '*').split(',').map((c) => (c.trim() === '*' ? '*' : ident(c.trim()))).join(', ');
    const order = (url.searchParams.get('order') ?? '').split(',').filter(Boolean).map((o) => { const [c, d] = o.split('.'); return `${ident(c)} ${d === 'desc' ? 'desc' : 'asc'}`; }).join(', ');
    const sql = `select ${cols} from ${t}${where(url.searchParams, params)}${order ? ` order by ${order}` : ''}${url.searchParams.get('limit') ? ` limit ${Number(url.searchParams.get('limit'))}` : ''}`;
    return [200, (await asCaller(req, () => db.query(sql, params))).rows];
  }
  if (req.method === 'DELETE') {
    await asCaller(req, () => db.query(`delete from ${t}${where(url.searchParams, params)}`, params));
    return [204, null];
  }
  if (req.method === 'POST') {
    const rows = Array.isArray(body) ? body : [body];
    const upsert = /resolution=merge-duplicates/.test(req.headers.prefer ?? '');
    await asCaller(req, async () => {
      for (const row of rows) {
        const keys = Object.keys(row);
        const vals = keys.map((k) => (row[k] !== null && typeof row[k] === 'object' && !Array.isArray(row[k]) ? JSON.stringify(row[k]) : Array.isArray(row[k]) && typeof row[k][0] === 'object' ? JSON.stringify(row[k]) : row[k]));
        await db.query(`insert into ${t} (${keys.map(ident).join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')})${upsert ? ` on conflict (id) do update set ${keys.filter((k) => k !== 'id').map((k) => `${ident(k)} = excluded.${ident(k)}`).join(', ')}` : ''}`, vals);
      }
    });
    return [201, null];
  }
  return [405, { message: 'unsupported' }];
}

async function auth(req, url, body) {
  const path = url.pathname.replace('/auth/v1/', '');
  if (path === 'settings') return [200, { external: { anonymous_users: state.anonymous, email: true }, disable_signup: false }];
  if (path === 'signup') {
    if (!body?.email) {
      if (!state.anonymous) return [422, { code: 'anonymous_provider_disabled', msg: 'Anonymous sign-ins are disabled' }];
      const u = (await db.query(`insert into auth.users (is_anonymous) values (true) returning *`)).rows[0];
      return [200, session(u)];
    }
    const u = (await db.query(`insert into auth.users (email, password, email_confirmed_at) values ($1, $2, now()) on conflict (email) do nothing returning *`, [body.email.toLowerCase(), body.password])).rows[0];
    return u ? [200, session(u)] : [422, { code: 'user_already_exists', msg: 'User already registered' }];
  }
  if (path === 'token') {
    const u = url.searchParams.get('grant_type') === 'refresh_token'
      ? (await db.query(`select * from auth.users where id::text = $1`, [String(body?.refresh_token ?? '').slice(2)])).rows[0]
      : (await db.query(`select * from auth.users where email = $1 and password = $2`, [String(body?.email ?? '').toLowerCase(), body?.password])).rows[0];
    return u ? [200, session(u)] : [400, { code: 'invalid_credentials', msg: 'Invalid login credentials' }];
  }
  if (path === 'user') {
    const c = claimsOf(req);
    const u = c && (await db.query(`select * from auth.users where id = $1`, [c.sub])).rows[0];
    return u ? [200, userJson(u)] : [401, { msg: 'no session' }];
  }
  if (path === 'logout') return [204, null];
  return [404, { msg: `unmocked auth/${path}` }];
}

const read = (req) => new Promise((res) => { const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => res(Buffer.concat(chunks))); });

export const server = createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  const send = (status, body, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type, 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'cache-control': 'no-store' });
    res.end(body == null ? '' : Buffer.isBuffer(body) ? body : type === 'application/json' ? JSON.stringify(body) : body);
  };
  if (req.method === 'OPTIONS') return send(204, null);
  const raw = await read(req);
  try {
    if (url.pathname.startsWith('/storage/v1/object/')) {
      const key = decodeURIComponent(url.pathname.replace(/^\/storage\/v1\/object\/(public\/)?/, ''));
      if (req.method === 'GET') return files.has(key) ? send(200, files.get(key).data, files.get(key).type) : send(404, { message: 'not found' });
      const allowed = await locked(() => asCaller(req, async () => (await db.query('select private.is_admin() as ok')).rows[0].ok).catch(() => false));
      if (!allowed) return send(403, { message: 'new row violates row-level security policy' });
      files.set(key, { data: raw, type: req.headers['content-type'] ?? 'application/octet-stream' });
      return send(200, { Key: key });
    }
    if (url.pathname.startsWith('/realtime/')) return send(202, {});
    if (url.pathname.startsWith('/rest/v1/') || url.pathname.startsWith('/auth/v1/')) {
      const body = raw.length ? JSON.parse(raw.toString()) : null;
      const [status, out] = await locked(() => (url.pathname.startsWith('/rest') ? rest(req, url, body) : auth(req, url, body)));
      if (url.pathname.includes('/rpc/')) state.log.push(url.pathname.split('/').pop());
      return send(status, out);
    }
    // static site
    let p = normalize(join(SITE, decodeURIComponent(url.pathname)));
    if (!p.startsWith(SITE)) return send(403, 'no', 'text/plain');
    if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
    if (url.pathname === '/config.js') return send(200, `window.TACMAP_CONFIG = { supabaseUrl: '${ORIGIN}', supabaseAnonKey: 'sb_publishable_localfakekey0000' };`, 'text/javascript');
    if (!existsSync(p)) return send(404, 'not found', 'text/plain');
    return send(200, readFileSync(p), MIME[extname(p)] ?? 'application/octet-stream');
  } catch (e) {
    // PostgREST-style error body
    return send(e.status ?? (e.code === '42501' ? 403 : 400), { code: e.code ?? 'ERR', message: e.message, details: null, hint: null });
  }
});

/** Superuser query, for test fixtures and assertions. */
export const sql = (text, params = []) => locked(() => db.query(text, params)).then((r) => r.rows);

server.listen(PORT, () => console.log(`fake Supabase + site on ${ORIGIN}`));
