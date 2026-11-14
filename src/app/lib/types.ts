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
  /** Unit template (combat stats). Absent = from the tech item, or matched by graphic / symbol. */
  unit?: string;
  /** Player who created this unit; it wears their colour (tint) and follows changes to it. */
  made_by?: string;
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
  /** Targets per weapon slot this turn. */
  attacks?: { slot: number; target: string }[];
  /** Leave the engagement this unit is in (takes one parting round, then may move). */
  retreat?: boolean;
  /** Radar AA: emitting (true) or dark (false); kept until changed. */
  emit?: boolean;
}

export type Change =
  | { op: 'create'; feature_id: string; payload: CreatePayload }
  | { op: 'update'; feature_id: string; payload: UpdatePayload }
  | { op: 'delete'; feature_id: string; payload?: Record<string, never> }
  /** Research a tech item. feature_id is the item's id. */
  | { op: 'research'; feature_id: string; payload?: Record<string, never> }
  /** One mission per squadron per turn; feature_id is the squadron. */
  | { op: 'mission'; feature_id: string; payload: { type: 'strike' | 'patrol' | 'escort' | 'recon'; target?: Pos; target_unit?: string; escort_of?: string; radius_m?: number } }
  /** Replacement aircraft for a squadron, arriving at push. */
  | { op: 'buy_aircraft'; feature_id: string; payload: { squadron: string; count: number } }
  /** A new squadron at one of the player's airbases; feature_id becomes the squadron's id. */
  | { op: 'buy_squadron'; feature_id: string; payload: { purchase_id: string; base: string; name?: string } };

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
  /** A unit, a production building, a missile tier (research only, managed in the Air window) or a squadron to buy. */
  category: 'unit' | 'building' | 'weapon' | 'squadron';
  /** False: players cannot move it once placed. */
  can_move: boolean;
  /** Buildings that produce this unit; empty = any of the player's spawn points. */
  spawn_from: string[];
  /** How far units of this type may move each turn, in metres; null = the turn's default. */
  move_range_m: number | null;
  /** Players do not see it, and cannot research it, before this turn. Null = from the start. */
  release_turn: number | null;
  /** Combat stats for units bought from it. */
  template_id: string | null;
  /** category 'squadron': buying it raises a squadron of this airframe. */
  airframe_id?: string | null;
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
  combat: PlayerCombat;
  air: PlayerAir;
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

// ---------------------------------------------------------------------------
// Ground combat
// ---------------------------------------------------------------------------

export interface WeaponProfile {
  id: string;
  name: string;
  attacks: number;
  ap: number;
  range_m: number;
  indirect: boolean;
  deleted_at: string | null;
  anti_air?: boolean;
  guidance?: 'none' | 'radar' | 'ir' | 'gun';
  accuracy?: number;
  air_damage?: number;
  air_shots?: number;
}

export interface UnitTemplate {
  id: string;
  name: string;
  max_strength: number;
  armor: number;
  category: 'ground' | 'air' | 'naval';
  asset_id: string | null;
  sidc: string | null;
  weapon_ids: string[];
  deleted_at: string | null;
  /** Squadrons it can base (0 = not an airbase). */
  air_capacity?: number;
  /** Active protection against AGMs (percentage points). */
  aps?: number;
}

export interface UnitLive {
  template: string;
  strength: number | null;
  experience: number | null;
  stationary_turns: number | null;
  engaged: boolean;
}

export interface Engagement {
  id: string;
  status: 'active' | 'ended';
  start_turn: number;
  turns_engaged: number;
  units: { fid: string; side: string }[];
}

export interface TerrainStats {
  zones: number;
  total_km2?: number;
  urban_pct?: number;
  forest_pct?: number;
  open_pct?: number;
  source?: string | null;
  generated_at?: string | null;
}

/** What get_combat_admin() returns. Settings are typed in lib/combat.ts. */
export interface CombatAdmin {
  turn: number;
  defaults: Record<string, unknown>;
  settings: import('./combat').CombatSettings;
  versions: { from_turn: number; settings: Record<string, unknown>; updated_at: string }[];
  weapons: WeaponProfile[];
  templates: UnitTemplate[];
  units: Record<string, UnitLive>;
  engagements: Engagement[];
  terrain: TerrainStats;
}

/** A player's view of combat: exact for own units, a band for others within intel range. */
export interface PlayerCombat {
  intel_km: number;
  own: Record<string, { template: string; category: string; max: number; strength: number; experience: number; stationary_turns: number; engaged: boolean;
    radar_aa?: boolean; anti_air?: boolean; emit?: boolean;
    weapons: { slot: number; name: string; range_m: number; indirect: boolean }[] }>;
  seen: Record<string, { band: string; ground: boolean }>;
  engagements: { id: string; turns: number; units: string[] | null }[];
  report: CombatReport | null;
}

export interface CombatReport {
  turn: number;
  own: { id: string; name: string; max: number; before: number; after: number; destroyed: boolean; fired: boolean; hit: boolean; recovered: number }[];
  engagements: { id: string; status: string; new: boolean; end_reason: string | null; rounds: number; own: string[]; others: { name: string; band: string | null }[] }[];
  air?: AirReport;
}

export interface AirReport {
  squadrons: { name: string; mission: string | null; before: number; after: number; lost: number }[];
  downed: number;
  strikes: { squadron: string; target: string; hits: number; shots: number; damage: number; destroyed: boolean; aborted: string | null }[];
  recon: { squadron: string; center: Pos; radius_m: number; units: { name: string; type: string; strength: number; max: number }[];
    squadrons: { name: string; airframe: string; aircraft: number; max: number }[] }[];
}

// ---------------------------------------------------------------------------
// Air combat
// ---------------------------------------------------------------------------

export type AirGuidance = 'radar' | 'ir' | 'harm' | 'agm' | 'none';

export interface Airframe {
  id: string;
  name: string;
  hp: number;
  hardpoints: number;
  max_payload: number;
  radius_m: number;
  radar_m: number;
  signature: number;
  ecm: number;
  flares: number;
  maneuver: number;
  gun_accuracy: number;
  gun_damage: number;
  gun_range_m: number;
  squadron_size: number;
  cost_per_aircraft: number;
  asset_id: string | null;
  sidc: string | null;
  deleted_at: string | null;
}

export interface AirFamily {
  id: string;
  name: string;
  guidance: AirGuidance;
  color: string | null;
  sort: number;
  deleted_at: string | null;
}

export interface AirWeapon {
  id: string;
  family_id: string;
  tier: number;
  name: string;
  guidance: AirGuidance;
  accuracy: number;
  range_m: number;
  damage: number;
  ap: number;
  weight: number;
  slots: number;
  targets: ('air' | 'ground' | 'ship' | 'radar')[];
  tech_item_id: string | null;
  research_cost: number | null;
  release_turn: number | null;
  deleted_at: string | null;
}

export interface LoadoutEntry { weapon: string; count: number }

export interface Squadron {
  id: string;
  name: string;
  owner_player_id: string | null;
  airframe_id: string;
  base_feature_id: string | null;
  aircraft: number;
  max_aircraft: number;
  damage: number;
  loadout: LoadoutEntry[];
  radius_m: number;
  weight: number;
}

export interface AirBase { id: string; name: string; owner: string | null; capacity: number; used: number; pos: Pos }

export interface AirAdmin {
  airframes: Airframe[];
  families: AirFamily[];
  weapons: AirWeapon[];
  squadrons: Squadron[];
  bases: AirBase[];
}

/** A player's view of air: own squadrons and bases in full; missiles as fit data; others as bands or recon. */
export interface PlayerAir {
  squadrons: {
    id: string; name: string; aircraft: number; max: number; damage: number; loadout: LoadoutEntry[]; base: string | null; base_name: string | null;
    base_pos: Pos | null; radius_m: number; weight: number;
    airframe: { id: string; name: string; hp: number; hardpoints: number; max_payload: number; radius_m: number; radar_m: number; cost_per_aircraft: number; sidc: string | null; asset_id: string | null };
  }[];
  weapons: { id: string; name: string; family: string; family_color: string | null; tier: number; guidance: AirGuidance; range_m: number; weight: number; slots: number;
    targets: string[]; tech_item: string | null; unlocked: boolean }[];
  bases: { id: string; name: string; capacity: number; used: number; pos: Pos }[];
  radius_penalty: number;
  patrol_radius_km: number;
  patrol_radius_max_km: number;
  recon_radius_km: number;
  enemy_bases: { base: string; squadrons: string[] }[];
  reveals: { center: Pos; radius_m: number }[];
  revealed: Record<string, { type: string; strength: number; max: number }>;
  revealed_squadrons: { base: string; name: string; airframe: string; aircraft: number; max: number }[];
  squadron_items: { id: string; name: string; spawn_cost: number; airframe: string; size: number; unlocked: boolean }[];
}
