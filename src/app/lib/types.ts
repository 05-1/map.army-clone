import type { LineString, MultiPolygon, Point, Polygon } from 'geojson';

export type Kind = 'symbol' | 'asset' | 'text' | 'line' | 'arrow' | 'polygon' | 'circle' | 'freehand';
export type Dash = 'solid' | 'dash' | 'dot';
export type BasemapId = 'satellite' | 'topo';
export type Pos = [number, number]; // [lng, lat]

export interface Style {
  color: string;
  width: number;
  dash: Dash;
  fillOpacity: number;
}

export interface Props {
  name?: string;
  type?: string;
  heading?: number;
  speed?: string;
  notes?: string;
  timestamp?: string; // ISO 8601, UTC
  /** symbol: MIL-STD-2525 / APP-6 SIDC */
  sidc?: string;
  /** asset: fixed pixel size or true ground size */
  sizeMode?: 'px' | 'm';
  /** asset + symbol: long side in CSS pixels (symbol: milsymbol size) */
  sizePx?: number;
  /** asset: long side in metres when sizeMode = 'm' */
  sizeM?: number;
  tint?: string | null;
  showLabel?: boolean;
  /** circle: radius in metres */
  radius?: number;
  /** text */
  fontSize?: number;
  /** Tech item this unit is (bought from the tree, or tagged by the owner): pays income, may be a spawn point. */
  tech?: string;
}

export interface Feature {
  id: string;
  layer_id: string;
  kind: Kind;
  geometry: Point | LineString | Polygon;
  props: Props;
  style: Style;
  asset_id: string | null;
  z: number;
  /** Player this object is assigned to. Only that player may propose changes to it. */
  owner_player_id?: string | null;
}

export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  z: number;
}

export interface Asset {
  id: string;
  name: string;
  /** storage object path, or a data: URL in local demo mode */
  path: string;
  mime: string;
  width: number;
  height: number;
  /** Soft-deleted: hidden from pickers, still drawn wherever it is already used. */
  deleted_at?: string | null;
}

export interface MapMeta {
  id: string;
  name: string;
  basemap: BasemapId;
  center: Pos;
  zoom: number;
  live_channel?: string;
  /** Graphics players may place on this map. */
  palette_assets?: string[];
  /** Whether players may place NATO symbols. */
  palette_symbols?: boolean;
  archived?: boolean;
}

export interface ShareLink {
  id: string;
  map_id: string;
  token: string;
  mode: 'live' | 'snapshot';
  visible_layers: string[] | null;
  expires_at: string | null;
  revoked: boolean;
  label: string | null;
  created_at: string;
}

/** What get_shared_map() returns to a viewer. */
export interface SharedPayload {
  map: { name: string; basemap: BasemapId; center: Pos; zoom: number };
  layers: Pick<Layer, 'id' | 'name' | 'z'>[];
  features: Feature[];
  assets: Asset[];
  mode: 'live' | 'snapshot';
  channel?: string;
  expires_at: string | null;
  created_at: string;
  /** Pushed turns that can be stepped back through (live links only). */
  history?: HistoryEntry[];
  /** Number of the turn in progress, if any. */
  turn?: number | null;
  /** Set when the turn in progress was opened by a rollback. */
  rollback_of?: number | null;
  /** Set when this payload is a past turn, not the live map. */
  viewing?: number;
}

export const DEFAULT_STYLE: Style = { color: '#ff453a', width: 3, dash: 'solid', fillOpacity: 0.15 };

// ---------------------------------------------------------------------------
// Players, turns and drafts
// ---------------------------------------------------------------------------

export interface Player {
  id: string;
  map_id: string;
  name: string;
  team: string;
  color: string | null;
  invite_token: string;
  visible_layers: string[] | null;
  target_layer_id: string | null;
  revoked: boolean;
  claimed_at: string | null;
  created_at: string;
  pin_set: boolean;
  pin_locked_until: string | null;
  last_seen_at: string | null;
}

export interface CreatePayload {
  kind: Kind;
  geometry: Feature['geometry'];
  props?: Props;
  style?: Partial<Style>;
  asset_id?: string | null;
  /** Units (symbols and graphics) are placed out of an allocation, or bought from the tech tree. Drawings have neither. */
  allocation_id?: string | null;
  /** Tech item bought with spawn points. */
  purchase_id?: string | null;
}

/** The only things a draft may change on an existing unit. */
export interface UpdatePayload {
  geometry?: Feature['geometry'];
  heading?: number;
  /** Text order; appended to the unit's notes when the turn is pushed. */
  order?: string;
}

export type Change =
  | { op: 'create'; feature_id: string; payload: CreatePayload }
  | { op: 'update'; feature_id: string; payload: UpdatePayload }
  | { op: 'delete'; feature_id: string; payload?: Record<string, never> }
  /** Research a tech item. feature_id is the item's id. */
  | { op: 'research'; feature_id: string; payload?: Record<string, never> };

export interface HistoryEntry {
  number: number;
  label: string | null;
  at: string;
}

export interface Turn {
  id: string;
  number: number;
  status: 'open' | 'locked';
  deadline: string | null;
  /** Metres. Null = units may move any distance. */
  default_radius_m: number | null;
  conflict_m: number | null;
  carry_allocations: boolean;
  rollback_of: number | null;
  opened_at: string;
  /** Locked, or past its deadline: drafts can no longer be saved. */
  frozen: boolean;
}

/** Where a unit may be placed: anywhere, inside a polygon or a country (MultiPolygon), or within a radius of a point. */
export type Zone = null | Polygon | MultiPolygon | { center: Pos; radius_m: number };

export interface MoveRule {
  feature_id: string | null;
  asset_id: string | null;
  radius_m: number;
}

export interface Allocation {
  id: string;
  player_id: string | null;
  team: string | null;
  asset_id: string | null;
  sidc: string | null;
  props: Props;
  quantity: number;
  zone: Zone;
}

export interface Draft {
  player_id: string;
  changes: Change[];
  ready: boolean;
  rejected: string[];
  owner_changes: Change[] | null;
  owner_note: string | null;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Tech tree and points
// ---------------------------------------------------------------------------

/** spawn: near the player's own spawn-point units; zone: inside a spawn zone; either; anywhere. */
export type Placement = 'spawn' | 'zone' | 'either' | 'anywhere';

export interface TechItem {
  id: string;
  name: string;
  description: string | null;
  /** Column in the tree, left to right. */
  tier: number;
  sort: number;
  /** 0 = available from the start. */
  research_cost: number;
  spawn_cost: number;
  prereqs: string[];
  /** Can be bought as a unit. A pure research node is not. */
  buyable: boolean;
  asset_id: string | null;
  sidc: string | null;
  props: Props;
  income_spawn: number;
  income_research: number;
  /** Metres. Set = units of this type are spawn points. */
  spawn_radius_m: number | null;
  placement: Placement;
  /** A production building (usually a spawn point that cannot move) or a unit. */
  category: 'unit' | 'building';
  /** False: players cannot move it once placed. */
  can_move: boolean;
  /** Buildings that produce this unit; empty = any of the player's spawn points. */
  spawn_from: string[];
  /** How far units of this type may move each turn, in metres; null = the turn's default. */
  move_range_m: number | null;
  /** Players do not see it, and cannot research it, before this turn. Null = from the start. */
  release_turn: number | null;
  /** Place in the flowchart; null = laid out by tier. */
  pos_x: number | null;
  pos_y: number | null;
}

export interface SpawnZone {
  id: string;
  name: string | null;
  player_id: string | null;
  team: string | null;
  zone: Exclude<Zone, null>;
}

export interface Income {
  spawn: number;
  research: number;
}

export interface PlayerEconomy {
  id: string;
  spawn_points: number;
  research_points: number;
  tech_unlocked: string[];
  income: Income;
}

/** What get_economy() returns to an admin (also inside get_turn). */
export interface Economy {
  items: TechItem[];
  zones: SpawnZone[];
  players: PlayerEconomy[];
}

/** What get_turn() returns to an admin. */
export interface TurnBundle {
  turn: Turn | null;
  rules: MoveRule[];
  allocations: Allocation[];
  drafts: Draft[];
  economy: Economy;
  history: HistoryEntry[];
  server_time: string;
}

export interface PlayerAllocation extends Pick<Allocation, 'id' | 'asset_id' | 'sidc' | 'props' | 'quantity' | 'zone'> {
  /** Team pool: teammates draw from the same quantity, first come first served. */
  shared: boolean;
  used_by_others: number;
}

/** What get_player_state() returns to a player. */
export interface PlayerState {
  map: SharedPayload['map'];
  layers: SharedPayload['layers'];
  features: Feature[];
  assets: Asset[];
  channel: string;
  server_time: string;
  player: Pick<Player, 'id' | 'name' | 'team' | 'color'>;
  turn: Turn | null;
  history: HistoryEntry[];
  /** Ids of the features assigned to this player. */
  mine: string[];
  /** Movement range in metres per own unit; null = unlimited. */
  radii: Record<string, number | null>;
  allocations: PlayerAllocation[];
  allocation_assets: Asset[];
  draft: { changes: Change[]; ready: boolean; updated_at: string } | null;
  economy: Omit<PlayerEconomy, 'id'>;
  /** The whole tech tree of the map. */
  tech: TechItem[];
  tech_assets: Asset[];
  /** Spawn zones that apply to this player. */
  spawn_zones: Pick<SpawnZone, 'id' | 'name' | 'zone'>[];
  /** This player's own units that are spawn points, where they stand now. */
  spawn_points: { feature_id: string; center: Pos; radius_m: number; name: string; item_id: string }[];
  /** Outcome of the most recent pushed turn. */
  last: { number: number; applied: boolean; changes: Change[]; edited: boolean; rejected: string[]; owner_note: string | null } | null;
}

/** A past turn as returned by get_snapshot / get_player_history / get_shared_map(turn). */
export interface SnapshotPayload {
  map: SharedPayload['map'];
  layers: (Pick<Layer, 'id' | 'name' | 'z'> & Partial<Layer>)[];
  features: Feature[];
  assets: Asset[];
  viewing: number;
}
