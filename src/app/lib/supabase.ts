import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Settings come from config.js, a plain file next to the HTML pages that is edited by hand after
// upload. Nothing is baked in at build time, so the same release folder works for any project.
// In development, VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in .env.local are used as a fallback.
declare global {
  interface Window {
    TACMAP_CONFIG?: { supabaseUrl?: string; supabaseAnonKey?: string };
  }
}

const cfg = typeof window !== 'undefined' ? window.TACMAP_CONFIG : undefined;
const ok = (v: string | undefined) => (v && !/YOUR[-_ ]|^\s*$/i.test(v) ? v.trim() : undefined);

export const SUPABASE_URL = ok(cfg?.supabaseUrl)?.replace(/\/+$/, '') ?? (import.meta.env.VITE_SUPABASE_URL as string | undefined);
export const SUPABASE_KEY = ok(cfg?.supabaseAnonKey) ?? (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined);

/** The database schema this build of the app expects. Bump together with setup.sql. */
export const SCHEMA_VERSION = 8;

/** null when config.js has not been filled in yet. */
export const supabase: SupabaseClient | null = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

export const ASSET_BUCKET = 'assets';

export function publicAssetUrl(path: string): string {
  if (path.startsWith('data:') || !SUPABASE_URL) return path;
  return `${SUPABASE_URL}/storage/v1/object/public/${ASSET_BUCKET}/${path}`;
}

export const liveChannelName = (id: string) => `live:${id}`;

export type AppStatus =
  | { s: 'no-config' }
  | { s: 'unreachable'; detail: string }
  | { s: 'no-schema' }
  | { s: 'ok'; schema: number; claimed: boolean };

/** Can we reach the project, and is setup.sql in place? Works without a session. */
export async function checkApp(): Promise<AppStatus> {
  if (!supabase) return { s: 'no-config' };
  try {
    const { data, error, status } = await supabase.rpc('app_status');
    if (error) {
      // PostgREST answers 404 for a function it does not know: the project is there, the schema is not.
      if (status === 404 || /PGRST202|could not find the function/i.test(`${error.code} ${error.message}`)) return { s: 'no-schema' };
      return { s: 'unreachable', detail: error.message || `HTTP ${status}` };
    }
    return { s: 'ok', schema: data.schema_version, claimed: data.claimed };
  } catch (e) {
    return { s: 'unreachable', detail: (e as Error).message };
  }
}

/** Reads the project's public auth settings. null when they cannot be read. */
export async function anonymousSignInsEnabled(): Promise<boolean | null> {
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: SUPABASE_KEY! } });
    if (!r.ok) return null;
    const j = (await r.json()) as { external?: { anonymous_users?: boolean } };
    return typeof j.external?.anonymous_users === 'boolean' ? j.external.anonymous_users : null;
  } catch {
    return null;
  }
}
