// Everything the player page may ask of the backend: five RPCs and one realtime channel.
// There are no table reads or writes here because players have no table privileges to use.
import { createClient, type RealtimeChannel } from '@supabase/supabase-js';
import { liveChannelName, SUPABASE_KEY, SUPABASE_URL } from '../lib/supabase';
import type { Change, PlayerState, SnapshotPayload } from '../lib/types';

/**
 * A client of its own, with its own session storage key. Without that, opening an invite in a
 * browser where the owner is signed in would reuse (and bind the invite to) the owner's session.
 * The session refreshes itself for as long as the browser keeps its storage; if it is ever lost,
 * the invite link signs in again and takes the seat back.
 */
export const sb = SUPABASE_URL && SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { storageKey: 'tacmap.player.auth', detectSessionInUrl: false } })
  : null;

const FRIENDLY: [RegExp, string][] = [
  [/anonymous sign-?ins are disabled/i, 'Player access is not switched on for this map yet. The owner needs to enable anonymous sign-ins in Supabase.'],
  [/signups? not allowed/i, 'Player access is not switched on for this map yet. The owner needs to allow new sign-ups in Supabase.'],
  [/not a player on this map/i, 'This seat is no longer held by this browser. Reload the page to take it back.'],
  [/failed to fetch|networkerror|load failed/i, 'Could not reach the server. Check your connection; your draft is kept here and will be sent again.'],
];

function fail(message: string): never {
  throw new Error(FRIENDLY.find(([re]) => re.test(message))?.[1] ?? message.replace(/^./, (c) => c.toUpperCase()));
}

function must<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) fail(res.error.message);
  return res.data;
}

export type JoinResult =
  | { ok: true; player_id: string }
  | { ok: false; reason: 'invalid' | 'pin_required' }
  | { ok: false; reason: 'wrong_pin'; left: number }
  | { ok: false; reason: 'locked'; until: string };

let queue: Promise<unknown> = Promise.resolve();

/**
 * Sign in anonymously if needed, then bind this session to the invite (with the PIN, if the seat has one).
 * Attempts run one after another: two overlapping ones would create two anonymous users.
 */
export function join(token: string, pin: string | null = null): Promise<JoinResult> {
  const run = async () => {
    const { data } = await sb!.auth.getSession();
    if (!data.session) {
      const { error } = await sb!.auth.signInAnonymously();
      if (error) fail(error.message);
    }
    return must(await sb!.rpc('claim_invite', { p_token: token, p_pin: pin })) as JoinResult;
  };
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}

/** Null when this browser no longer holds the seat (revoked, link regenerated, or opened elsewhere). */
export async function fetchState(playerId: string): Promise<PlayerState | null> {
  return must(await sb!.rpc('get_player_state', { p_player_id: playerId })) as PlayerState | null;
}

export async function fetchHistory(playerId: string, turn: number): Promise<SnapshotPayload | null> {
  return must(await sb!.rpc('get_player_history', { p_player_id: playerId, p_turn: turn })) as SnapshotPayload | null;
}

/** Replace the draft for the open turn. The server checks ownership, range, zones and allocation counts. */
export async function saveDraft(playerId: string, changes: Change[]): Promise<{ updated_at: string }> {
  return must(await sb!.rpc('save_draft', { p_player_id: playerId, p_changes: changes })) as { updated_at: string };
}

/** Urban and forest zones of the map (common knowledge for every player). */
export async function fetchTerrain(playerId: string): Promise<import('geojson').FeatureCollection | null> {
  return must(await sb!.rpc('get_player_terrain', { p_player_id: playerId })) as import('geojson').FeatureCollection | null;
}

/** Change a squadron's loadout now (free and instant). Returns its new combat radius. */
export async function setLoadout(playerId: string, squadronId: string, loadout: { weapon: string; count: number }[]): Promise<{ radius_m: number; weight: number }> {
  return must(await sb!.rpc('set_loadout', { p_player_id: playerId, p_squadron_id: squadronId, p_loadout: loadout })) as { radius_m: number; weight: number };
}

export async function setReady(playerId: string, ready: boolean): Promise<void> {
  must(await sb!.rpc('set_ready', { p_player_id: playerId, p_ready: ready }));
}

/** The map's ping channel. It carries no data in either direction, only "go and re-read". */
export function openChannel(channelId: string, onChanged: () => void, onStatus: (online: boolean) => void): RealtimeChannel {
  const ch = sb!.channel(liveChannelName(channelId), { config: { broadcast: { self: false } } });
  ch.on('broadcast', { event: 'changed' }, onChanged).subscribe((status) => onStatus(status === 'SUBSCRIBED'));
  return ch;
}

/** Tell the owner's page that a draft changed, so the turn panel refreshes. */
export const announceDraft = (ch: RealtimeChannel | null) => void ch?.send({ type: 'broadcast', event: 'draft', payload: {} });
export const closeChannel = (ch: RealtimeChannel | null) => ch && void sb!.removeChannel(ch);
