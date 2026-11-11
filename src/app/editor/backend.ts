// Everything the owner pages ask of Supabase. Map content (layers and objects) is written through
// admin-only row level security; every setting and every turn operation goes through an RPC that
// checks the caller server-side. Nothing here is trusted by the database.
import { asBasemap } from '../lib/basemaps';
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import type { Diff } from '../lib/diff';
import { ASSET_BUCKET, liveChannelName, publicAssetUrl, supabase } from '../lib/supabase';
import type { Allocation, Asset, Change, Feature, Layer, MapMeta, Player, ShareLink, SnapshotPayload, Turn, TurnBundle } from '../lib/types';
import type { PreparedUpload } from '../lib/upload';

export interface NewLink {
  mode: 'live' | 'snapshot';
  visibleLayers: string[] | null;
  expiresAt: string | null;
  label: string;
}

export interface NewPlayer {
  name: string;
  team: string;
  color: string | null;
  visibleLayers: string[] | null;
  targetLayerId: string | null;
}

export type MapPatch = Partial<Pick<MapMeta, 'name' | 'basemap' | 'center' | 'zoom' | 'palette_assets' | 'palette_symbols' | 'archived'>>;
export type PlayerPatch = Partial<Pick<Player, 'name' | 'team' | 'color' | 'visible_layers' | 'target_layer_id' | 'revoked'>>;
export type TurnPatch = Partial<Pick<Turn, 'deadline' | 'default_radius_m' | 'conflict_m' | 'carry_allocations'>>;
export type LinkPatch = Partial<Pick<ShareLink, 'revoked' | 'expires_at' | 'label' | 'visible_layers'>>;
export interface DraftReview {
  rejected?: string[];
  owner_changes?: Change[] | null;
  owner_note?: string;
  ready?: boolean;
  clear?: boolean;
}
export interface Who {
  uid: string | null;
  email: string | null;
  anonymous: boolean;
  is_admin: boolean;
  role: 'owner' | 'admin' | null;
  claimed: boolean;
}
export interface AdminList {
  admins: { uid: string; email: string | null; role: 'owner' | 'admin'; added_at: string; me: boolean }[];
  invites: string[];
}
export interface Diagnostics {
  schema_version: number;
  last_keepalive: string | null;
  pg_net: boolean;
  server_time: string;
  maps: number;
  players: number;
  snapshots: number;
}
export interface Activity {
  id: number;
  at: string;
  actor: string;
  kind: string;
  detail: string | null;
}
export interface CampaignBackup {
  format: 'tacmap-campaign';
  version: number;
  exported_at: string;
  map: { id: string; name: string };
  assets: Asset[];
  /** Image files as data URLs, keyed by storage path, so a backup can be restored into a new project. */
  files?: Record<string, string>;
  [k: string]: unknown;
}

const MAP_COLS = 'id, name, basemap, center, zoom, live_channel, palette_assets, palette_symbols, archived';
const FEATURE_COLS = 'id, layer_id, kind, geometry, props, style, asset_id, z, owner_player_id';
const PLAYER_COLS = 'id, map_id, name, team, color, invite_token, visible_layers, target_layer_id, revoked, claimed_at, created_at, pin_set, pin_locked_until, last_seen_at';
const ASSET_COLS = 'id, name, path, mime, width, height, deleted_at';
const LINK_COLS = 'id, map_id, token, mode, visible_layers, expires_at, revoked, label, created_at';
const WATCH_POLL_MS = 45_000;

function must<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data;
}

export class Backend {
  private channels = new Map<string, RealtimeChannel>();
  private listeners = new Set<() => void>();
  constructor(private sb: SupabaseClient) {}

  private async rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    return must(await this.sb.rpc(fn, args)) as T;
  }

  /** The map's broadcast channel: we send "changed" pings on it and hear players' "draft" pings. */
  private live(map: MapMeta): RealtimeChannel | null {
    if (!map.live_channel) return null;
    let ch = this.channels.get(map.live_channel);
    if (!ch) {
      ch = this.sb.channel(liveChannelName(map.live_channel), { config: { broadcast: { self: false } } });
      ch.on('broadcast', { event: 'draft' }, () => this.listeners.forEach((fn) => fn())).subscribe();
      this.channels.set(map.live_channel, ch);
    }
    return ch;
  }
  /** Tell viewers and players that something changed. Carries no data; they re-read through their own RPC. */
  ping(map: MapMeta) {
    void this.live(map)?.send({ type: 'broadcast', event: 'changed', payload: {} });
  }
  /** Calls back when a player saved or readied a draft (ping), and on a slow timer as a safety net. */
  watchDrafts(map: MapMeta, onChange: () => void) {
    this.listeners.add(onChange);
    this.live(map);
    const timer = window.setInterval(onChange, WATCH_POLL_MS);
    const onVisible = () => !document.hidden && onChange();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      this.listeners.delete(onChange);
    };
  }
  dispose() {
    for (const ch of this.channels.values()) void this.sb.removeChannel(ch);
    this.channels.clear();
    this.listeners.clear();
  }

  // ---- account ----
  whoami = () => this.rpc<Who>('whoami');
  claimOwner = () => this.rpc<boolean>('claim_owner');
  acceptAdminInvite = () => this.rpc<boolean>('accept_admin_invite');
  listAdmins = () => this.rpc<AdminList>('list_admins');
  inviteAdmin = (email: string) => this.rpc<'added' | 'invited'>('invite_admin', { p_email: email });
  cancelAdminInvite = (email: string) => this.rpc<void>('cancel_admin_invite', { p_email: email });
  removeAdmin = (uid: string) => this.rpc<void>('remove_admin', { p_uid: uid });
  transferOwnership = (uid: string) => this.rpc<void>('transfer_ownership', { p_uid: uid });
  diagnostics = () => this.rpc<Diagnostics>('diagnostics');
  listActivity = (mapId: string | null, limit = 150) => this.rpc<Activity[]>('list_activity', { p_map_id: mapId, p_limit: limit });

  // ---- maps ----
  async listMaps() {
    const rows = must(await this.sb.from('maps').select(MAP_COLS).order('updated_at', { ascending: false })) as MapMeta[];
    return rows.map((m) => ({ ...m, basemap: asBasemap(m.basemap) }));
  }
  createMap = (name: string) => this.rpc<MapMeta>('create_map', { p_name: name });
  updateMap = (id: string, patch: MapPatch) => this.rpc<MapMeta>('update_map', { p_map_id: id, p_patch: patch });
  async loadMap(id: string) {
    const [layers, features] = await Promise.all([
      this.sb.from('layers').select('id, name, visible, locked, z').eq('map_id', id).order('z'),
      this.sb.from('features').select(FEATURE_COLS).eq('map_id', id).order('z').limit(20000),
    ]);
    return { layers: must(layers) as Layer[], features: must(features) as Feature[] };
  }
  async saveDiff(mapId: string, d: Diff) {
    // Order matters: layers must exist before the features that reference them.
    if (d.layerUpserts.length) must(await this.sb.from('layers').upsert(d.layerUpserts.map((l) => ({ ...l, map_id: mapId }))));
    for (let i = 0; i < d.featureUpserts.length; i += 500) {
      // Every row carries every column: PostgREST nulls columns that are missing from some rows of a batch.
      must(await this.sb.from('features').upsert(d.featureUpserts.slice(i, i + 500).map((f) => ({ ...f, owner_player_id: f.owner_player_id ?? null, map_id: mapId }))));
    }
    if (d.featureDeletes.length) must(await this.sb.from('features').delete().in('id', d.featureDeletes));
    if (d.layerDeletes.length) must(await this.sb.from('layers').delete().in('id', d.layerDeletes));
  }
  /** Current rows for these feature ids. Ids missing from the result no longer exist. */
  async fetchFeatures(mapId: string, ids: string[]) {
    if (!ids.length) return [];
    return must(await this.sb.from('features').select(FEATURE_COLS).eq('map_id', mapId).in('id', ids)) as Feature[];
  }

  // ---- graphics ----
  /** Includes soft-deleted graphics: objects already on the map still need them to draw. */
  async listAssets() {
    return must(await this.sb.from('assets').select(ASSET_COLS).order('created_at', { ascending: false })) as Asset[];
  }
  async uploadAsset(f: PreparedUpload) {
    const uid = (await this.sb.auth.getUser()).data.user?.id;
    if (!uid) throw new Error('Not signed in');
    const path = `${uid}/${crypto.randomUUID()}.${f.ext}`;
    must(await this.sb.storage.from(ASSET_BUCKET).upload(path, f.blob, { contentType: f.mime, cacheControl: '31536000' }));
    return this.rpc<Asset>('add_asset', { p_name: f.name, p_path: path, p_mime: f.mime, p_width: f.width, p_height: f.height });
  }
  setAssetDeleted = (id: string, deleted: boolean) => this.rpc<Asset>('update_asset', { p_asset_id: id, p_patch: { deleted } });
  assetUrl = (a: Asset) => publicAssetUrl(a.path);

  // ---- sharing ----
  async listLinks(mapId: string) {
    return must(await this.sb.from('share_links').select(LINK_COLS).eq('map_id', mapId).order('created_at', { ascending: false })) as ShareLink[];
  }
  createLink = (mapId: string, o: NewLink) =>
    this.rpc<ShareLink>('create_share_link', { p_map_id: mapId, p_mode: o.mode, p_visible_layers: o.visibleLayers, p_expires_at: o.expiresAt, p_label: o.label || null });
  updateLink = (id: string, patch: LinkPatch) => this.rpc<ShareLink>('update_share_link', { p_link_id: id, p_patch: patch });
  async deleteLink(id: string) {
    must(await this.sb.from('share_links').delete().eq('id', id));
  }

  // ---- players ----
  async listPlayers(mapId: string) {
    return must(await this.sb.from('players').select(PLAYER_COLS).eq('map_id', mapId).order('created_at')) as Player[];
  }
  createPlayer = (mapId: string, p: NewPlayer) =>
    this.rpc<Player>('create_player', { p_map_id: mapId, p_name: p.name, p_team: p.team, p_color: p.color, p_visible_layers: p.visibleLayers, p_target_layer_id: p.targetLayerId });
  updatePlayer = (id: string, patch: PlayerPatch) => this.rpc<Player>('update_player', { p_player_id: id, p_patch: patch });
  resetInvite = (id: string) => this.rpc<Player>('reset_player_invite', { p_player_id: id });
  setPin = (id: string, pin: string | null) => this.rpc<void>('set_player_pin', { p_player_id: id, p_pin: pin });
  clearPinLockout = (id: string) => this.rpc<void>('clear_pin_lockout', { p_player_id: id });
  assignUnits = (mapId: string, featureIds: string[], playerId: string | null) =>
    this.rpc<number>('assign_units', { p_map_id: mapId, p_feature_ids: featureIds, p_player_id: playerId });
  setTeamVisibility = (mapId: string, team: string, layers: string[] | null) =>
    this.rpc<number>('set_team_visibility', { p_map_id: mapId, p_team: team, p_visible_layers: layers });

  // ---- turns ----
  getTurn = (mapId: string) => this.rpc<TurnBundle>('get_turn', { p_map_id: mapId });
  openTurn = (mapId: string, patch: TurnPatch = {}) => this.rpc<string>('open_turn', { p_map_id: mapId, p_patch: patch });
  updateTurn = (turnId: string, patch: TurnPatch) => this.rpc<void>('update_turn', { p_turn_id: turnId, p_patch: patch });
  setMoveRule = (turnId: string, target: { feature_id?: string; asset_id?: string }, radius: number | null) =>
    this.rpc<void>('set_move_rule', { p_turn_id: turnId, p_feature_id: target.feature_id ?? null, p_asset_id: target.asset_id ?? null, p_radius_m: radius });
  saveAllocation = (turnId: string, a: Partial<Allocation>) => this.rpc<string>('save_allocation', { p_turn_id: turnId, p: a });
  deleteAllocation = (id: string) => this.rpc<void>('delete_allocation', { p_allocation_id: id });
  lockTurn = (turnId: string) => this.rpc<void>('lock_turn', { p_turn_id: turnId });
  unlockTurn = (turnId: string) => this.rpc<void>('unlock_turn', { p_turn_id: turnId });
  reviewDraft = (turnId: string, playerId: string, patch: DraftReview) => this.rpc<void>('review_draft', { p_turn_id: turnId, p_player_id: playerId, p_patch: patch });
  pushTurn = (turnId: string) => this.rpc<{ pushed: number; next: number; applied: number }>('push_turn', { p_turn_id: turnId });

  // ---- history ----
  getSnapshot = (mapId: string, turn: number) => this.rpc<SnapshotPayload | null>('get_snapshot', { p_map_id: mapId, p_turn: turn });
  rollbackTo = (mapId: string, turn: number) => this.rpc<{ turn: number; rollback_of: number }>('rollback_to', { p_map_id: mapId, p_turn: turn });

  /** Backup = the database export plus the image files, so it also restores into a brand-new project. */
  async exportCampaign(mapId: string): Promise<CampaignBackup> {
    const backup = await this.rpc<CampaignBackup>('export_campaign', { p_map_id: mapId });
    const files: Record<string, string> = {};
    await Promise.all(
      backup.assets.map(async (a) => {
        try {
          const blob = await (await fetch(publicAssetUrl(a.path))).blob();
          files[a.path] = await new Promise<string>((ok, bad) => {
            const r = new FileReader();
            r.onload = () => ok(r.result as string);
            r.onerror = () => bad(r.error);
            r.readAsDataURL(blob);
          });
        } catch {
          /* a missing image must not make the whole backup fail */
        }
      }),
    );
    return { ...backup, files };
  }
  async importCampaign(backup: CampaignBackup, replace: boolean): Promise<string> {
    const { files = {}, ...data } = backup;
    // Put back any image that is not in this project's storage (restore into a new project).
    for (const a of backup.assets ?? []) {
      const dataUrl = files[a.path];
      if (!dataUrl || !/^data:image\/(png|webp|svg\+xml);base64,/.test(dataUrl)) continue;
      const there = await fetch(publicAssetUrl(a.path), { method: 'HEAD' }).then((r) => r.ok, () => false);
      if (there) continue;
      const blob = await (await fetch(dataUrl)).blob();
      await this.sb.storage.from(ASSET_BUCKET).upload(a.path, blob, { contentType: a.mime, cacheControl: '31536000' });
    }
    return this.rpc<string>('import_campaign', { p: data, p_replace: replace });
  }

  // ---- settings ----
  getSettings = (mapId: string) => this.rpc<{ discord: string | null; pg_net: boolean }>('get_settings', { p_map_id: mapId });
  setDiscordWebhook = (mapId: string, url: string | null) => this.rpc<void>('set_discord_webhook', { p_map_id: mapId, p_url: url });
  testDiscordWebhook = (mapId: string) => this.rpc<boolean>('test_discord_webhook', { p_map_id: mapId });
}

export const backend: Backend | null = supabase ? new Backend(supabase) : null;
