-- Tacmap: complete database setup. Paste the whole file into the Supabase SQL editor and run it.
-- Safe to run again at any time: tables and data are kept, functions and policies are rebuilt.
-- Re-run it whenever the app says the schema is out of date.
--
-- Roles:
--   admin   a signed-in (non-anonymous) account listed in private.admins. Exactly one is the owner.
--   player  an anonymous session bound to an invite. No table access at all; four RPCs.
--   viewer  no session. One RPC, checked against a share-link token.

begin;

create schema if not exists private;

-- ---------------------------------------------------------------------------
-- 0. Rebuild code objects from scratch (functions, policies). Data is untouched.
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in select policyname, tablename from pg_policies
            where schemaname = 'public' and tablename = any (array['maps','layers','features','assets','share_links','players',
              'turns','turn_move_rules','allocations','drafts','snapshots','activity','app_meta','submissions','submission_changes',
              'tech_items','spawn_zones','weapon_profiles','unit_templates','unit_state','engagements','combat_settings',
              'combat_previews','combat_reports','terrain_zones','terrain_meta','airframes','air_weapon_families','air_weapons',
              'squadrons','air_reveals']) loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
  -- Everything in `private` is ours. Cascade also removes the triggers and column defaults that use them; both are re-created below.
  for r in select p.oid::regprocedure as sig from pg_proc p where p.pronamespace = 'private'::regnamespace loop
    execute 'drop function ' || r.sig || ' cascade';
  end loop;
  for r in select p.oid::regprocedure as sig from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.proname = any (array[
              'app_status','keepalive','whoami','claim_owner','diagnostics','list_activity',
              'list_admins','invite_admin','cancel_admin_invite','accept_admin_invite','remove_admin','transfer_ownership',
              'create_map','update_map','add_asset','update_asset',
              'create_player','update_player','reset_player_invite','set_player_pin','clear_pin_lockout','assign_units','set_team_visibility',
              'open_turn','update_turn','set_move_rule','save_allocation','delete_allocation','lock_turn','unlock_turn','review_draft','push_turn','get_turn',
              'get_snapshot','rollback_to','export_campaign','import_campaign',
              'create_share_link','update_share_link','get_shared_map',
              'get_settings','set_discord_webhook','test_discord_webhook',
              'claim_invite','get_player_state','get_player_history','save_draft','set_ready',
              'get_economy','save_tech_item','delete_tech_item','save_spawn_zone','delete_spawn_zone','set_player_points','set_player_tech',
              'move_tech_items',
              'get_combat_admin','save_weapon','save_unit_template','save_combat_settings','set_unit_state','end_engagement',
              'get_combat_inputs','save_combat_preview','get_combat_preview','replace_terrain','get_terrain','get_player_terrain','get_shared_terrain',
              'get_air_admin','save_airframe','save_air_family','save_air_weapon','save_squadron','delete_squadron','seed_air_families','set_loadout',
              'submit_turn','withdraw_submission','review_submission']) loop
    execute 'drop function ' || r.sig || ' cascade';
  end loop;
end $$;

-- The earlier per-submission review system is replaced by turns and drafts.
drop table if exists public.submission_changes, public.submissions;

-- ---------------------------------------------------------------------------
-- 1. Tables. `create table if not exists` for a fresh project, `add column if not exists` for upgrades.
-- ---------------------------------------------------------------------------

create table if not exists public.app_meta (
  key text primary key, value text not null, updated_at timestamptz not null default now()
);

create table if not exists private.admins (
  uid      uuid primary key references auth.users (id) on delete cascade,
  role     text not null default 'admin' check (role in ('owner', 'admin')),
  added_at timestamptz not null default now()
);
create unique index if not exists admins_one_owner on private.admins ((true)) where role = 'owner';

create table if not exists private.admin_invites (
  email text primary key, invited_at timestamptz not null default now()
);

create table if not exists public.maps (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid default auth.uid(),
  name         text not null default 'Untitled map' check (char_length(name) between 1 and 120),
  basemap      text not null default 'satellite' check (basemap in ('satellite', 'topo', 'dark')),  -- 'dark' kept legal for old backups; the app shows it as satellite
  center       double precision[] not null default '{0,20}' check (array_length(center, 1) = 2),
  zoom         double precision not null default 2,
  live_channel uuid not null default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
alter table public.maps
  add column if not exists palette_assets  uuid[]  not null default '{}',
  add column if not exists palette_symbols boolean not null default true,
  add column if not exists archived        boolean not null default false;
-- Maps belong to the installation, not to one account: removing an admin must not delete maps.
alter table public.maps alter column basemap set default 'satellite';
alter table public.maps alter column owner_id drop not null;
alter table public.maps drop constraint if exists maps_owner_id_fkey;
alter table public.maps add constraint maps_owner_id_fkey foreign key (owner_id) references auth.users (id) on delete set null;

create table if not exists public.layers (
  id      uuid primary key default gen_random_uuid(),
  map_id  uuid not null references public.maps (id) on delete cascade,
  name    text not null default 'Layer' check (char_length(name) between 1 and 80),
  visible boolean not null default true,
  locked  boolean not null default false,
  z       integer not null default 0,
  unique (id, map_id)
);
create index if not exists layers_map_idx on public.layers (map_id);

create table if not exists public.assets (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid default auth.uid(),
  name       text not null check (char_length(name) between 1 and 120),
  path       text not null unique,
  mime       text not null check (mime in ('image/png', 'image/webp', 'image/svg+xml')),
  width      integer not null check (width > 0),
  height     integer not null check (height > 0),
  created_at timestamptz not null default now()
);
-- Soft delete only: old turn snapshots refer to asset ids, so rows and files are never removed.
alter table public.assets add column if not exists deleted_at timestamptz;
alter table public.assets alter column owner_id drop not null;
alter table public.assets drop constraint if exists assets_owner_id_fkey;
alter table public.assets add constraint assets_owner_id_fkey foreign key (owner_id) references auth.users (id) on delete set null;

create table if not exists public.players (
  id              uuid primary key default gen_random_uuid(),
  map_id          uuid not null references public.maps (id) on delete cascade,
  auth_uid        uuid references auth.users (id) on delete set null,
  name            text not null check (char_length(name) between 1 and 60),
  team            text not null default '' check (char_length(team) <= 40),
  color           text check (color is null or color ~ '^#[0-9a-fA-F]{6}$'),
  invite_token    text not null unique,
  visible_layers  uuid[],
  target_layer_id uuid references public.layers (id) on delete set null,
  revoked         boolean not null default false,
  claimed_at      timestamptz,
  created_at      timestamptz not null default now(),
  unique (id, map_id),
  unique (map_id, auth_uid)
);
alter table public.players
  add column if not exists pin_salt         text,
  add column if not exists pin_hash         text,
  add column if not exists pin_failures     integer not null default 0,
  add column if not exists pin_locked_until timestamptz,
  add column if not exists last_seen_at     timestamptz;
create index if not exists players_map_idx on public.players (map_id);
create index if not exists players_auth_idx on public.players (auth_uid);

create table if not exists public.features (
  id         uuid primary key default gen_random_uuid(),
  map_id     uuid not null references public.maps (id) on delete cascade,
  layer_id   uuid not null,
  kind       text not null check (kind in ('symbol', 'asset', 'text', 'line', 'arrow', 'polygon', 'circle', 'freehand')),
  geometry   jsonb not null check (geometry ? 'type' and geometry ? 'coordinates' and octet_length(geometry::text) < 400000),
  props      jsonb not null default '{}' check (octet_length(props::text) < 20000),
  style      jsonb not null default '{}' check (octet_length(style::text) < 4000),
  asset_id   uuid references public.assets (id) on delete set null,
  z          integer not null default 0,
  updated_at timestamptz not null default now(),
  foreign key (layer_id, map_id) references public.layers (id, map_id) on delete cascade
);
alter table public.features add column if not exists owner_player_id uuid;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'features_owner_player_fk') then
    alter table public.features add constraint features_owner_player_fk
      foreign key (owner_player_id, map_id) references public.players (id, map_id) on delete set null (owner_player_id);
  end if;
end $$;
create index if not exists features_map_idx on public.features (map_id);
create index if not exists features_layer_idx on public.features (layer_id);
create index if not exists features_owner_player_idx on public.features (owner_player_id) where owner_player_id is not null;

create table if not exists public.share_links (
  id             uuid primary key default gen_random_uuid(),
  map_id         uuid not null references public.maps (id) on delete cascade,
  token          text not null unique,
  mode           text not null default 'live' check (mode in ('live', 'snapshot')),
  visible_layers uuid[],
  expires_at     timestamptz,
  revoked        boolean not null default false,
  snapshot       jsonb,
  label          text check (label is null or char_length(label) <= 120),
  created_at     timestamptz not null default now(),
  check ((mode = 'snapshot') = (snapshot is not null))
);
create index if not exists share_links_map_idx on public.share_links (map_id);

-- One turn per map is active (open or locked) at a time. Pushed and rolled-back turns are history.
create table if not exists public.turns (
  id                uuid primary key default gen_random_uuid(),
  map_id            uuid not null references public.maps (id) on delete cascade,
  number            integer not null,
  status            text not null default 'open' check (status in ('open', 'locked', 'pushed', 'rolled_back')),
  deadline          timestamptz,
  default_radius_m  double precision check (default_radius_m is null or default_radius_m >= 0),  -- null = unlimited
  conflict_m        double precision check (conflict_m is null or conflict_m > 0),
  carry_allocations boolean not null default false,
  rollback_of       integer,           -- set when this turn was opened by rolling back to that turn
  opened_at         timestamptz not null default now(),
  locked_at         timestamptz,
  pushed_at         timestamptz,
  unique (map_id, number)
);
create unique index if not exists turns_one_active on public.turns (map_id) where status in ('open', 'locked');

create table if not exists public.turn_move_rules (
  id         uuid primary key default gen_random_uuid(),
  turn_id    uuid not null references public.turns (id) on delete cascade,
  feature_id uuid,                      -- one unit ...
  asset_id   uuid,                      -- ... or every unit drawn with this graphic
  radius_m   double precision not null check (radius_m >= 0),
  check ((feature_id is null) <> (asset_id is null)),
  unique (turn_id, feature_id),
  unique (turn_id, asset_id)
);

create table if not exists public.allocations (
  id         uuid primary key default gen_random_uuid(),
  turn_id    uuid not null references public.turns (id) on delete cascade,
  player_id  uuid references public.players (id) on delete cascade,   -- one player ...
  team       text,                                                    -- ... or a pool shared by a team
  asset_id   uuid references public.assets (id),                      -- a graphic ...
  sidc       text check (sidc is null or sidc ~ '^[A-Za-z0-9*-]{10,30}$'),  -- ... or a NATO symbol
  props      jsonb not null default '{}' check (octet_length(props::text) < 4000),  -- template: name, size
  quantity   integer not null check (quantity between 1 and 500),
  zone       jsonb,                     -- null = anywhere | GeoJSON Polygon | {"center":[lng,lat],"radius_m":n}
  created_at timestamptz not null default now(),
  check ((player_id is null) <> (team is null)),
  check ((asset_id is null) <> (sidc is null))
);
create index if not exists allocations_turn_idx on public.allocations (turn_id);

-- Exactly one draft per player per turn. `changes` is what the player saved; the owner's review
-- lives beside it and never overwrites it.
create table if not exists public.drafts (
  turn_id       uuid not null references public.turns (id) on delete cascade,
  player_id     uuid not null references public.players (id) on delete cascade,
  changes       jsonb not null default '[]' check (octet_length(changes::text) <= 300000),
  ready         boolean not null default false,
  rejected      uuid[] not null default '{}',     -- feature ids of changes the owner turned down
  owner_changes jsonb check (owner_changes is null or octet_length(owner_changes::text) <= 300000),
  owner_note    text check (owner_note is null or char_length(owner_note) <= 1000),
  updated_at    timestamptz not null default now(),
  primary key (turn_id, player_id)
);

create table if not exists public.snapshots (
  id          uuid primary key default gen_random_uuid(),
  map_id      uuid not null references public.maps (id) on delete cascade,
  turn_number integer not null,
  label       text,
  payload     jsonb not null,           -- unfiltered; every read goes through private.filter_snapshot()
  created_at  timestamptz not null default now(),
  unique (map_id, turn_number)
);

create table if not exists private.map_secrets (
  map_id uuid primary key references public.maps (id) on delete cascade,
  discord_webhook text
);

create table if not exists public.activity (
  id     bigint generated always as identity primary key,
  map_id uuid references public.maps (id) on delete cascade,
  at     timestamptz not null default now(),
  actor  text not null,
  kind   text not null,
  detail text
);
create index if not exists activity_map_idx on public.activity (map_id, id desc);

-- Tech tree (schema 4). One tree per map. Each item is a node: research unlocks it for one player
-- (research_cost 0 = available from the start), and a buyable item is a unit that player may then buy
-- with spawn points, as often as they can afford. Units on the map carry their item in props.tech;
-- that is what pays income each push and what makes a unit a spawn point.
create table if not exists public.tech_items (
  id              uuid primary key default gen_random_uuid(),
  map_id          uuid not null references public.maps (id) on delete cascade,
  name            text not null check (char_length(name) between 1 and 80),
  description     text check (description is null or char_length(description) <= 1000),
  tier            integer not null default 1 check (tier between 0 and 50),       -- column in the tree
  sort            integer not null default 0,                                     -- order within the column
  research_cost   integer not null default 0 check (research_cost between 0 and 1000000),
  spawn_cost      integer not null default 0 check (spawn_cost between 0 and 1000000),
  prereqs         uuid[] not null default '{}',
  buyable         boolean not null default true,
  asset_id        uuid references public.assets (id),                             -- a graphic ...
  sidc            text check (sidc is null or sidc ~ '^[A-Za-z0-9*-]{10,30}$'),   -- ... or a NATO symbol
  props           jsonb not null default '{}' check (octet_length(props::text) < 4000),  -- template: name, size
  income_spawn    integer not null default 0 check (income_spawn between 0 and 1000000),
  income_research integer not null default 0 check (income_research between 0 and 1000000),
  spawn_radius_m  double precision check (spawn_radius_m is null or spawn_radius_m > 0),  -- set = this unit is a spawn point
  placement       text not null default 'either' check (placement in ('spawn', 'zone', 'either', 'anywhere')),
  pos_x           double precision,                                               -- place in the flowchart (null = by tier)
  pos_y           double precision,
  category        text not null default 'unit' check (category in ('unit', 'building')),  -- a building usually produces units
  can_move        boolean not null default true,                                  -- false: players cannot move it once placed
  spawn_from      uuid[] not null default '{}',                                   -- buildings that produce this unit (empty = any spawn point)
  move_range_m    double precision check (move_range_m is null or move_range_m >= 0),  -- per turn; null = the turn's default
  release_turn    integer check (release_turn is null or release_turn >= 1),       -- hidden from players, and not researchable, before this turn
  created_at      timestamptz not null default now(),
  check (asset_id is null or sidc is null),
  check (not buyable or asset_id is not null or sidc is not null)
);
create index if not exists tech_items_map_idx on public.tech_items (map_id);
alter table public.tech_items
  add column if not exists pos_x double precision,
  add column if not exists pos_y double precision,
  add column if not exists category text not null default 'unit' check (category in ('unit', 'building')),
  add column if not exists can_move boolean not null default true,
  add column if not exists spawn_from uuid[] not null default '{}',
  add column if not exists move_range_m double precision check (move_range_m is null or move_range_m >= 0),
  add column if not exists release_turn integer check (release_turn is null or release_turn >= 1);

-- Areas where bought units may be placed: for one player, a team, or (both null) everyone on the map.
create table if not exists public.spawn_zones (
  id         uuid primary key default gen_random_uuid(),
  map_id     uuid not null references public.maps (id) on delete cascade,
  name       text check (name is null or char_length(name) <= 80),
  player_id  uuid references public.players (id) on delete cascade,
  team       text check (team is null or char_length(team) between 1 and 40),
  zone       jsonb not null,
  created_at timestamptz not null default now(),
  check (player_id is null or team is null)
);
create index if not exists spawn_zones_map_idx on public.spawn_zones (map_id);

-- ---------------------------------------------------------------------------
-- Ground combat (schema 8). PostGIS holds the terrain zones; Supabase keeps extensions in their own schema.
-- ---------------------------------------------------------------------------
create schema if not exists extensions;
create extension if not exists postgis with schema extensions;

-- What a unit fires. A template lists the weapons its units carry (the same profile may appear twice).
create table if not exists public.weapon_profiles (
  id         uuid primary key default gen_random_uuid(),
  map_id     uuid not null references public.maps (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 80),
  attacks    double precision not null default 100 check (attacks between 0 and 1000000),
  ap         double precision not null default 10 check (ap between 0 and 1000000),
  range_m    double precision not null default 3000 check (range_m between 0 and 20000000),
  indirect   boolean not null default false,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists weapon_profiles_map_idx on public.weapon_profiles (map_id);

create table if not exists public.unit_templates (
  id           uuid primary key default gen_random_uuid(),
  map_id       uuid not null references public.maps (id) on delete cascade,
  name         text not null check (char_length(name) between 1 and 80),
  max_strength double precision not null default 1000 check (max_strength > 0 and max_strength <= 1000000000),
  armor        double precision not null default 0 check (armor between 0 and 1000000),
  category     text not null default 'ground' check (category in ('ground', 'air', 'naval')),
  asset_id     uuid references public.assets (id),                              -- units drawn with this graphic ...
  sidc         text check (sidc is null or sidc ~ '^[A-Za-z0-9*-]{10,30}$'),    -- ... or this symbol use the template
  weapon_ids   uuid[] not null default '{}',
  deleted_at   timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists unit_templates_map_idx on public.unit_templates (map_id);

-- Live state of each unit that has a template. A unit with no row yet is at full strength.
create table if not exists public.unit_state (
  feature_id       uuid primary key references public.features (id) on delete cascade,
  map_id           uuid not null references public.maps (id) on delete cascade,
  strength         double precision not null check (strength >= 0),
  experience       integer not null default 0 check (experience >= 0),
  stationary_turns integer not null default 0 check (stationary_turns >= 0),
  updated_at       timestamptz not null default now()
);
create index if not exists unit_state_map_idx on public.unit_state (map_id);

-- A fight between units: units is [{"fid": ..., "side": ...}]. Active ones carry on every push until they end.
create table if not exists public.engagements (
  id            uuid primary key default gen_random_uuid(),
  map_id        uuid not null references public.maps (id) on delete cascade,
  status        text not null default 'active' check (status in ('active', 'ended')),
  start_turn    integer not null,
  turns_engaged integer not null default 1,
  ended_turn    integer,
  end_reason    text,
  units         jsonb not null default '[]',
  updated_at    timestamptz not null default now()
);
create index if not exists engagements_map_idx on public.engagements (map_id, status);

-- Every combat number, versioned: a turn uses the newest row with from_turn <= its number.
create table if not exists public.combat_settings (
  map_id     uuid not null references public.maps (id) on delete cascade,
  from_turn  integer not null check (from_turn >= 1),
  settings   jsonb not null check (octet_length(settings::text) < 20000),
  updated_at timestamptz not null default now(),
  primary key (map_id, from_turn)
);

-- The owner's reviewed combat result for a turn. Push applies it exactly, if its inputs are unchanged.
create table if not exists public.combat_previews (
  turn_id    uuid primary key references public.turns (id) on delete cascade,
  signature  text not null,
  data       jsonb not null default '{}',   -- salts and hand edits, to recompute the same result
  result     jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.combat_reports (
  map_id      uuid not null references public.maps (id) on delete cascade,
  turn_number integer not null,
  player_id   uuid not null references public.players (id) on delete cascade,
  report      jsonb not null,
  primary key (player_id, turn_number)
);

create table if not exists public.terrain_zones (
  id         uuid primary key default gen_random_uuid(),
  map_id     uuid not null references public.maps (id) on delete cascade,
  type       text not null check (type in ('urban', 'forest')),
  geom       extensions.geometry(MultiPolygon, 4326) not null,
  area_km2   double precision not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists terrain_zones_map_idx on public.terrain_zones (map_id);
create index if not exists terrain_zones_geom_idx on public.terrain_zones using gist (geom);

create table if not exists public.terrain_meta (
  map_id       uuid primary key references public.maps (id) on delete cascade,
  area         extensions.geometry(MultiPolygon, 4326),
  source       text,
  options      jsonb not null default '{}',
  generated_at timestamptz not null default now()
);

alter table public.tech_items add column if not exists template_id uuid;   -- units bought from it get this template

-- ---------------------------------------------------------------------------
-- Air combat (schema 10). Aircraft live in squadrons at a base (a unit whose template has air capacity);
-- they are never on the map between turns. Missiles are researched through the tech tree.
-- ---------------------------------------------------------------------------
create table if not exists public.airframes (
  id               uuid primary key default gen_random_uuid(),
  map_id           uuid not null references public.maps (id) on delete cascade,
  name             text not null check (char_length(name) between 1 and 80),
  hp               double precision not null default 100 check (hp > 0 and hp <= 1000000),      -- per aircraft
  hardpoints       integer not null default 6 check (hardpoints between 0 and 50),
  max_payload      double precision not null default 6000 check (max_payload >= 0),           -- kg
  radius_m         double precision not null default 600000 check (radius_m >= 0),             -- combat radius, empty
  radar_m          double precision not null default 100000 check (radar_m >= 0),
  signature        double precision not null default 1 check (signature between 0 and 100),   -- RCS multiplier; stealth is low
  ecm              double precision not null default 20 check (ecm between 0 and 100),        -- vs radar-guided
  flares           double precision not null default 20 check (flares between 0 and 100),     -- vs IR
  maneuver         double precision not null default 20 check (maneuver between 0 and 100),   -- vs guns
  gun_accuracy     double precision not null default 40 check (gun_accuracy between 0 and 100),
  gun_damage       double precision not null default 40 check (gun_damage >= 0),
  gun_range_m      double precision not null default 1500 check (gun_range_m >= 0),
  squadron_size    integer not null default 12 check (squadron_size between 1 and 100),
  cost_per_aircraft integer not null default 10 check (cost_per_aircraft between 0 and 1000000),  -- SP for a replacement
  asset_id         uuid references public.assets (id),
  sidc             text check (sidc is null or sidc ~ '^[A-Za-z0-9*-]{10,30}$'),
  deleted_at       timestamptz,
  created_at       timestamptz not null default now()
);
create index if not exists airframes_map_idx on public.airframes (map_id);

-- Each family (IR, ARH, HARM, AGM, ...) is its own chain in the tech tree: one tech item per tier.
create table if not exists public.air_weapon_families (
  id         uuid primary key default gen_random_uuid(),
  map_id     uuid not null references public.maps (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 40),
  guidance   text not null default 'radar' check (guidance in ('radar', 'ir', 'harm', 'agm', 'none')),
  color      text check (color is null or color ~ '^#[0-9a-fA-F]{6}$'),
  sort       integer not null default 0,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists air_weapon_families_map_idx on public.air_weapon_families (map_id);

create table if not exists public.air_weapons (
  id           uuid primary key default gen_random_uuid(),
  map_id       uuid not null references public.maps (id) on delete cascade,
  family_id    uuid not null references public.air_weapon_families (id) on delete cascade,
  tier         integer not null default 1 check (tier between 1 and 20),
  name         text not null check (char_length(name) between 1 and 80),
  guidance     text not null default 'radar' check (guidance in ('radar', 'ir', 'harm', 'agm', 'none')),
  accuracy     double precision not null default 70 check (accuracy between 0 and 100),
  range_m      double precision not null default 50000 check (range_m >= 0),
  damage       double precision not null default 100 check (damage >= 0),
  ap           double precision not null default 10 check (ap >= 0),
  weight       double precision not null default 150 check (weight >= 0),      -- kg
  slots        integer not null default 1 check (slots between 1 and 20),      -- hardpoints it takes
  targets      text[] not null default '{air}',                                -- air, ground, ship, radar
  tech_item_id uuid,                                                           -- the research node that unlocks it
  deleted_at   timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists air_weapons_map_idx on public.air_weapons (map_id);

-- A squadron: aircraft of one airframe at one base. damage carries over below one airframe's HP.
-- base_feature_id is cleared when the base is destroyed: the squadron is stranded until rebased.
create table if not exists public.squadrons (
  id              uuid primary key default gen_random_uuid(),
  map_id          uuid not null references public.maps (id) on delete cascade,
  owner_player_id uuid references public.players (id) on delete set null,
  name            text not null check (char_length(name) between 1 and 80),
  airframe_id     uuid not null references public.airframes (id),
  base_feature_id uuid references public.features (id) on delete set null,
  aircraft        integer not null default 12 check (aircraft >= 0),
  max_aircraft    integer not null default 12 check (max_aircraft >= 1),
  damage          double precision not null default 0 check (damage >= 0),
  loadout         jsonb not null default '[]' check (octet_length(loadout::text) < 4000),   -- [{"weapon": id, "count": n}] per aircraft
  created_at      timestamptz not null default now()
);
create index if not exists squadrons_map_idx on public.squadrons (map_id);

-- What a recon mission showed a player, until the next push.
create table if not exists public.air_reveals (
  id          uuid primary key default gen_random_uuid(),
  map_id      uuid not null references public.maps (id) on delete cascade,
  player_id   uuid not null references public.players (id) on delete cascade,
  turn_number integer not null,
  center      double precision[] not null,
  radius_m    double precision not null
);
create index if not exists air_reveals_idx on public.air_reveals (player_id, turn_number);

alter table public.unit_templates
  add column if not exists air_capacity integer not null default 0 check (air_capacity between 0 and 100),   -- squadrons it can base (airbase)
  add column if not exists aps double precision not null default 0 check (aps between 0 and 100);          -- active protection vs AGMs
alter table public.weapon_profiles
  add column if not exists anti_air   boolean not null default false,
  add column if not exists guidance   text not null default 'none' check (guidance in ('none', 'radar', 'ir', 'gun')),
  add column if not exists accuracy   double precision not null default 60 check (accuracy between 0 and 100),
  add column if not exists air_damage double precision not null default 50 check (air_damage >= 0),
  add column if not exists air_shots  integer not null default 2 check (air_shots between 0 and 100);
alter table public.tech_items add column if not exists airframe_id uuid;   -- category 'squadron': buying it raises a new squadron
alter table public.tech_items drop constraint if exists tech_items_category_check;
alter table public.tech_items add constraint tech_items_category_check check (category in ('unit', 'building', 'weapon', 'squadron'));

alter table public.players
  add column if not exists spawn_points    integer not null default 0,
  add column if not exists research_points integer not null default 0,
  add column if not exists tech_unlocked   uuid[]  not null default '{}';

-- Upgrade from the allowlist used before co-admins existed: the creator of the oldest map becomes the owner.
do $$ begin
  if to_regclass('private.owners') is not null then
    insert into private.admins (uid, role)
      select o.uid, 'admin' from private.owners o on conflict do nothing;
    drop table private.owners;
  end if;
  if not exists (select 1 from private.admins where role = 'owner') then
    update private.admins set role = 'owner'
     where uid = coalesce(
       (select m.owner_id from public.maps m join private.admins a on a.uid = m.owner_id order by m.created_at limit 1),
       (select uid from private.admins order by added_at limit 1));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Core helpers
-- ---------------------------------------------------------------------------

create function private.new_token() returns text
language sql volatile set search_path = ''
as $$ select replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''); $$;   -- 244 random bits
alter table public.share_links alter column token set default private.new_token();
alter table public.players alter column invite_token set default private.new_token();

create function private.touch() returns trigger
language plpgsql set search_path = ''
as $$ begin new.updated_at := now(); return new; end $$;
drop trigger if exists maps_touch on public.maps;
create trigger maps_touch before update on public.maps for each row execute function private.touch();
drop trigger if exists features_touch on public.features;
create trigger features_touch before update on public.features for each row execute function private.touch();

create function private.snapshots_are_immutable() returns trigger
language plpgsql set search_path = ''
as $$ begin raise exception 'turn snapshots cannot be changed' using errcode = '42501'; end $$;
drop trigger if exists snapshots_immutable on public.snapshots;
create trigger snapshots_immutable before update on public.snapshots for each row execute function private.snapshots_are_immutable();

-- Anonymous player sessions are in the `authenticated` role too, so "signed in" is never enough.
create function private.is_admin() returns boolean
language sql stable security definer set search_path = ''
as $$
  select (select auth.uid()) is not null
    and not coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
    and exists (select 1 from private.admins a where a.uid = (select auth.uid()));
$$;

create function private.is_owner() returns boolean
language sql stable set search_path = ''
as $$ select private.is_admin() and exists (select 1 from private.admins a where a.uid = (select auth.uid()) and a.role = 'owner'); $$;

create function private.need_admin() returns void
language plpgsql stable set search_path = ''
as $$ begin
  if not private.is_admin() then raise exception 'not authorised' using errcode = '42501'; end if;
end $$;

create function private.need_owner() returns void
language plpgsql stable set search_path = ''
as $$ begin
  if not private.is_owner() then raise exception 'only the owner can do this' using errcode = '42501'; end if;
end $$;

create function private.need_map(p_map_id uuid) returns void
language plpgsql stable set search_path = ''
as $$ begin
  perform private.need_admin();
  if not exists (select 1 from public.maps m where m.id = p_map_id) then
    raise exception 'map not found' using errcode = '42501';
  end if;
end $$;

create function private.actor() returns text
language sql stable set search_path = ''
as $$ select coalesce((select u.email::text from auth.users u where u.id = (select auth.uid())), 'admin'); $$;

create function private.log(p_map_id uuid, p_actor text, p_kind text, p_detail text default null) returns void
language sql volatile set search_path = ''
as $$ insert into public.activity (map_id, actor, kind, detail) values (p_map_id, left(p_actor, 120), p_kind, left(p_detail, 500)); $$;

create function private.schema_version() returns integer
language sql stable set search_path = ''
as $$ select coalesce((select value::integer from public.app_meta where key = 'schema_version'), 0); $$;

create function private.has_pg_net() returns boolean
language sql stable set search_path = ''
as $$ select exists (select 1 from pg_extension where extname = 'pg_net'); $$;

-- Fire-and-forget: pg_net queues the request, so a slow or broken webhook can never block a push.
create function private.notify_discord(p_map_id uuid, p_text text) returns boolean
language plpgsql volatile set search_path = ''
as $$
declare w text;
begin
  select s.discord_webhook into w from private.map_secrets s where s.map_id = p_map_id;
  if w is null or not private.has_pg_net() then return false; end if;
  begin
    execute 'select net.http_post(url := $1, body := $2, headers := $3)'
      using w, jsonb_build_object('content', left(p_text, 1800)), '{"Content-Type":"application/json"}'::jsonb;
    return true;
  exception when others then
    return false;
  end;
end $$;

create function private.asset_json(a public.assets) returns jsonb
language sql immutable set search_path = ''
as $$ select jsonb_build_object('id', a.id, 'name', a.name, 'path', a.path, 'mime', a.mime, 'width', a.width, 'height', a.height); $$;

-- Live map as a viewer or player may see it.
create function private.build_payload(p_map_id uuid, p_visible uuid[]) returns jsonb
language sql stable set search_path = ''
as $$
  with vis as (
    select l.id, l.name, l.z from public.layers l
    where l.map_id = p_map_id and l.visible and (p_visible is null or l.id = any (p_visible))
  ),
  feats as (
    select f.id, f.layer_id, f.kind, f.geometry, f.props, f.style, f.asset_id, f.z
    from public.features f join vis on vis.id = f.layer_id where f.map_id = p_map_id
  )
  select jsonb_build_object(
    'map', (select jsonb_build_object('name', m.name, 'basemap', m.basemap, 'center', to_jsonb(m.center), 'zoom', m.zoom)
              from public.maps m where m.id = p_map_id),
    'layers', coalesce((select jsonb_agg(to_jsonb(vis) order by vis.z) from vis), '[]'::jsonb),
    'features', coalesce((select jsonb_agg(to_jsonb(feats)) from feats), '[]'::jsonb),
    'assets', coalesce((select jsonb_agg(private.asset_json(a)) from public.assets a
                         where a.id in (select feats.asset_id from feats where feats.asset_id is not null)), '[]'::jsonb)
  );
$$;

-- Full, unfiltered state of a map. Stored as the turn snapshot.
create function private.snapshot_now(p_map_id uuid) returns jsonb
language sql stable set search_path = ''
as $$
  select jsonb_build_object(
    'map', (select jsonb_build_object('name', m.name, 'basemap', m.basemap, 'center', to_jsonb(m.center), 'zoom', m.zoom)
              from public.maps m where m.id = p_map_id),
    'layers', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'z', l.z, 'visible', l.visible, 'locked', l.locked) order by l.z)
                          from public.layers l where l.map_id = p_map_id), '[]'::jsonb),
    'features', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'layer_id', f.layer_id, 'kind', f.kind, 'geometry', f.geometry,
                            'props', f.props, 'style', f.style, 'asset_id', f.asset_id, 'z', f.z, 'owner_player_id', f.owner_player_id))
                          from public.features f where f.map_id = p_map_id), '[]'::jsonb),
    -- Points and research per player, so a rollback puts them back too. Never sent to players or viewers.
    'economy', coalesce((select jsonb_object_agg(p.id, jsonb_build_object('spawn_points', p.spawn_points,
                            'research_points', p.research_points, 'tech_unlocked', to_jsonb(p.tech_unlocked)))
                          from public.players p where p.map_id = p_map_id), '{}'::jsonb),
    -- Unit strength, experience and engagements, so a rollback restores the fighting too. Owner only.
    'combat', jsonb_build_object(
      'units', coalesce((select jsonb_object_agg(u.feature_id, jsonb_build_object('strength', u.strength, 'experience', u.experience,
                           'stationary_turns', u.stationary_turns)) from public.unit_state u where u.map_id = p_map_id), '{}'::jsonb),
      'engagements', coalesce((select jsonb_agg(to_jsonb(e) - 'map_id' - 'updated_at') from public.engagements e
                                where e.map_id = p_map_id and e.status = 'active'), '[]'::jsonb),
      'squadrons', coalesce((select jsonb_agg(to_jsonb(q) - 'map_id') from public.squadrons q where q.map_id = p_map_id), '[]'::jsonb))
  );
$$;

-- The only way a stored snapshot leaves the database for a viewer or player. Applies the same two
-- rules as the live map: layers hidden in the editor (at the time of the snapshot) are dropped, and
-- so is every layer outside the caller's allowed set. p_all is for admins only.
create function private.filter_snapshot(s jsonb, p_visible uuid[], p_all boolean default false) returns jsonb
language sql stable set search_path = ''
as $$
  with vis as (
    select l from jsonb_array_elements(s -> 'layers') l
    where p_all or ((l ->> 'visible')::boolean and (p_visible is null or (l ->> 'id')::uuid = any (p_visible)))
  ),
  feats as (
    select case when p_all then f else f - 'owner_player_id' end as f
    from jsonb_array_elements(s -> 'features') f
    where (f ->> 'layer_id') in (select l ->> 'id' from vis)
  )
  select jsonb_build_object(
    'map', s -> 'map',
    'layers', coalesce((select jsonb_agg(case when p_all then l else l - 'visible' - 'locked' end order by (l ->> 'z')::integer) from vis), '[]'::jsonb),
    'features', coalesce((select jsonb_agg(f) from feats), '[]'::jsonb),
    'assets', coalesce((select jsonb_agg(private.asset_json(a)) from public.assets a
                         where a.id::text in (select f ->> 'asset_id' from feats where f ->> 'asset_id' is not null)), '[]'::jsonb)
  );
$$;

create function private.history(p_map_id uuid) returns jsonb
language sql stable set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('number', s.turn_number, 'label', s.label, 'at', s.created_at) order by s.turn_number), '[]'::jsonb)
  from public.snapshots s where s.map_id = p_map_id;
$$;

create function private.active_turn(p_map_id uuid) returns public.turns
language sql stable set search_path = ''
as $$ select t from public.turns t where t.map_id = p_map_id and t.status in ('open', 'locked'); $$;

create function private.turn_json(t public.turns) returns jsonb
language sql stable set search_path = ''
as $$
  select case when t.id is null then null else jsonb_build_object(
    'id', t.id, 'number', t.number, 'status', t.status, 'deadline', t.deadline, 'default_radius_m', t.default_radius_m,
    'conflict_m', t.conflict_m, 'carry_allocations', t.carry_allocations, 'rollback_of', t.rollback_of, 'opened_at', t.opened_at,
    'frozen', t.status <> 'open' or (t.deadline is not null and t.deadline <= now())) end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Geometry and validation
-- ---------------------------------------------------------------------------

create function private.valid_pos(c jsonb) returns boolean
language sql immutable set search_path = ''
as $$
  select coalesce(case
    when jsonb_typeof(c) <> 'array' then false
    when jsonb_array_length(c) <> 2 then false
    when jsonb_typeof(c -> 0) <> 'number' or jsonb_typeof(c -> 1) <> 'number' then false
    else (c ->> 0)::float8 between -180 and 180 and (c ->> 1)::float8 between -90 and 90
  end, false);
$$;

create function private.valid_line(c jsonb, min_pts integer) returns boolean
language sql immutable set search_path = ''
as $$
  select coalesce(case
    when jsonb_typeof(c) <> 'array' then false
    when jsonb_array_length(c) not between min_pts and 5000 then false
    else not exists (select 1 from jsonb_array_elements(c) e where not private.valid_pos(e))
  end, false);
$$;

create function private.valid_geom(g jsonb, expected text) returns boolean
language sql immutable set search_path = ''
as $$
  select coalesce(case
    when jsonb_typeof(g) <> 'object' or g ->> 'type' is distinct from expected then false
    when expected = 'Point' then private.valid_pos(g -> 'coordinates')
    when expected = 'LineString' then private.valid_line(g -> 'coordinates', 2)
    when expected = 'Polygon' then
      case
        when jsonb_typeof(g -> 'coordinates') <> 'array' then false
        when jsonb_array_length(g -> 'coordinates') not between 1 and 10 then false
        else not exists (select 1 from jsonb_array_elements(g -> 'coordinates') r where not private.valid_line(r, 4))
      end
    else false
  end, false);
$$;

create function private.pick(j jsonb, keys text[]) returns jsonb
language sql immutable set search_path = ''
as $$
  select coalesce((
    select jsonb_object_agg(e.key, e.value)
    from jsonb_each(case when jsonb_typeof(j) = 'object' then j else '{}'::jsonb end) e
    where e.key = any (keys)
  ), '{}'::jsonb);
$$;

-- Absent is fine; present must be a number in range.
create function private.num_in(v jsonb, lo float8, hi float8) returns boolean
language sql immutable set search_path = ''
as $$
  select v is null or coalesce(jsonb_typeof(v) = 'number' and (v #>> '{}')::float8 between lo and hi, false);
$$;

-- Absent is fine; present must be a string no longer than max_len (and match re, if given).
create function private.str_ok(v jsonb, max_len integer, re text default null) returns boolean
language sql immutable set search_path = ''
as $$
  select v is null or coalesce(
    jsonb_typeof(v) = 'string' and char_length(v #>> '{}') <= max_len and (re is null or (v #>> '{}') ~ re), false);
$$;

-- Player-supplied props and style end up in MapLibre expressions and canvas calls in every
-- viewer's browser, so each value is type- and range-checked here, not just size-capped.
create function private.valid_props(props jsonb, style jsonb) returns boolean
language sql immutable set search_path = ''
as $$
  select private.str_ok(props -> 'name', 400)
     and private.str_ok(props -> 'type', 80)
     and private.str_ok(props -> 'speed', 40)
     and private.str_ok(props -> 'notes', 4000)
     and private.str_ok(props -> 'timestamp', 40)
     and private.str_ok(props -> 'sidc', 30, '^[A-Za-z0-9*-]{10,30}$')
     and private.str_ok(props -> 'sizeMode', 2, '^(px|m)$')
     and private.num_in(props -> 'heading', 0, 360)
     and private.num_in(props -> 'sizePx', 8, 512)
     and private.num_in(props -> 'sizeM', 1, 100000)
     and private.num_in(props -> 'radius', 1, 20000000)
     and private.num_in(props -> 'fontSize', 8, 96)
     and (props -> 'tint' is null or props -> 'tint' = 'null'::jsonb or private.str_ok(props -> 'tint', 7, '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$'))
     and (props -> 'showLabel' is null or jsonb_typeof(props -> 'showLabel') = 'boolean')
     and (props -> 'emit' is null or jsonb_typeof(props -> 'emit') = 'boolean')
     and private.str_ok(props -> 'tech', 36, '^[0-9a-f-]{36}$')
     and private.str_ok(props -> 'unit', 36, '^[0-9a-f-]{36}$')
     and private.str_ok(props -> 'made_by', 36, '^[0-9a-f-]{36}$')
     and private.str_ok(style -> 'color', 7, '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$')
     and private.str_ok(style -> 'dash', 5, '^(solid|dash|dot)$')
     and private.num_in(style -> 'width', 1, 16)
     and private.num_in(style -> 'fillOpacity', 0, 1);
$$;

-- Great-circle distance in metres (same formula and radius as the client).
create function private.dist_m(a float8[], b float8[]) returns float8
language sql immutable set search_path = ''
as $$
  select 2 * 6371008.8 * asin(least(1, sqrt(
    power(sin(radians(b[2] - a[2]) / 2), 2) + cos(radians(a[2])) * cos(radians(b[2])) * power(sin(radians(b[1] - a[1]) / 2), 2))));
$$;

-- Reference point of an object: the point itself, or the centre of a shape's bounding box.
create function private.anchor(g jsonb) returns float8[]
language sql immutable set search_path = ''
as $$
  select case g ->> 'type'
    when 'Point' then array[(g -> 'coordinates' ->> 0)::float8, (g -> 'coordinates' ->> 1)::float8]
    when 'LineString' then (
      select array[(min((e ->> 0)::float8) + max((e ->> 0)::float8)) / 2, (min((e ->> 1)::float8) + max((e ->> 1)::float8)) / 2]
      from jsonb_array_elements(g -> 'coordinates') e)
    when 'Polygon' then (
      select array[(min((e ->> 0)::float8) + max((e ->> 0)::float8)) / 2, (min((e ->> 1)::float8) + max((e ->> 1)::float8)) / 2]
      from jsonb_array_elements(g -> 'coordinates') r, jsonb_array_elements(r) e)
  end;
$$;

create function private.in_ring(ring jsonb, p float8[]) returns boolean
language plpgsql immutable set search_path = ''
as $$
declare
  n integer := jsonb_array_length(ring);
  j integer := n - 1;
  xi float8; yi float8; xj float8; yj float8;
  inside boolean := false;
begin
  for i in 0 .. n - 1 loop
    xi := (ring -> i ->> 0)::float8; yi := (ring -> i ->> 1)::float8;
    xj := (ring -> j ->> 0)::float8; yj := (ring -> j ->> 1)::float8;
    if ((yi > p[2]) <> (yj > p[2])) and (p[1] < (xj - xi) * (p[2] - yi) / (yj - yi) + xi) then
      inside := not inside;
    end if;
    j := i;
  end loop;
  return inside;
end $$;

-- A zone: null (anywhere), {"center": [lng, lat], "radius_m": n}, a GeoJSON Polygon, or a MultiPolygon
-- (a country: up to 1000 parts, 4 MB).
create function private.valid_zone(z jsonb) returns boolean
language sql immutable set search_path = ''
as $$
  select z is null or z = 'null'::jsonb or coalesce(case
    when jsonb_typeof(z) <> 'object' then false
    when z ? 'center' then private.valid_pos(z -> 'center') and z ? 'radius_m' and private.num_in(z -> 'radius_m', 1, 20000000)
    when z ->> 'type' = 'MultiPolygon' then
      jsonb_typeof(z -> 'coordinates') = 'array' and jsonb_array_length(z -> 'coordinates') between 1 and 1000
      and octet_length(z::text) < 4000000
      and not exists (select 1 from jsonb_array_elements(z -> 'coordinates') poly
                      where not private.valid_geom(jsonb_build_object('type', 'Polygon', 'coordinates', poly), 'Polygon'))
    else private.valid_geom(z, 'Polygon')
  end, false);
$$;

-- Inside the outer ring and not in a hole.
create function private.in_polygon(rings jsonb, p float8[]) returns boolean
language sql immutable set search_path = ''
as $$
  select private.in_ring(rings -> 0, p)
     and not exists (select 1 from jsonb_array_elements(rings) with ordinality r (ring, i) where r.i > 1 and private.in_ring(r.ring, p));
$$;

create function private.in_zone(z jsonb, p float8[]) returns boolean
language sql immutable set search_path = ''
as $$
  select case
    when z is null or z = 'null'::jsonb then true
    when z ? 'center' then private.dist_m(array[(z -> 'center' ->> 0)::float8, (z -> 'center' ->> 1)::float8], p) <= (z ->> 'radius_m')::float8 * 1.001 + 1
    when z ->> 'type' = 'MultiPolygon' then exists (select 1 from jsonb_array_elements(z -> 'coordinates') poly where private.in_polygon(poly, p))
    else private.in_polygon(z -> 'coordinates', p)
  end;
$$;

-- How far a unit may move this turn; null means no limit. Most specific first: an override for this
-- one unit (turn panel), then its tech item (a building that cannot move = 0, else the item's range),
-- then an older per-graphic override, then the turn's default.
create function private.radius_for(p_turn_id uuid, p_default float8, p_feature_id uuid, p_asset_id uuid, p_tech text default null) returns float8
language sql stable set search_path = ''
as $$
  select coalesce(
    (select r.radius_m from public.turn_move_rules r where r.turn_id = p_turn_id and r.feature_id = p_feature_id),
    (select case when not x.can_move then 0 else x.move_range_m end from public.tech_items x where x.id::text = p_tech),
    (select r.radius_m from public.turn_move_rules r where r.turn_id = p_turn_id and r.asset_id = p_asset_id),
    p_default);
$$;

-- Strip a change down to the fields a draft may contain.
create function private.clean_payload(p_op text, j jsonb) returns jsonb
language sql immutable set search_path = ''
as $$
  select case p_op
    when 'create' then private.pick(j, array['kind', 'geometry', 'asset_id', 'allocation_id', 'purchase_id']) || jsonb_build_object(
      'props', private.pick(j -> 'props', array['name', 'type', 'heading', 'speed', 'notes', 'timestamp', 'sidc',
                                                'sizeMode', 'sizePx', 'sizeM', 'tint', 'showLabel', 'radius', 'fontSize']),
      'style', private.pick(j -> 'style', array['color', 'width', 'dash', 'fillOpacity']))
    when 'update' then private.pick(j, array['geometry', 'heading', 'order', 'attacks', 'retreat', 'emit'])
    when 'mission' then private.pick(j, array['type', 'target', 'target_unit', 'escort_of', 'radius_m'])
    when 'buy_aircraft' then private.pick(j, array['squadron', 'count'])
    when 'buy_squadron' then private.pick(j, array['purchase_id', 'base', 'name'])
    else '{}'::jsonb
  end;
$$;

-- Released by turn n: no release turn, or that turn has come.
create function private.released(it public.tech_items, n integer) returns boolean
language sql immutable set search_path = ''
as $$ select it.release_turn is null or n is null or n >= it.release_turn; $$;

-- A tech item this player may use on turn n: researched, or free and released.
create function private.unlocked(p public.players, it public.tech_items, n integer default null) returns boolean
language sql stable set search_path = ''
as $$ select it.id = any (p.tech_unlocked) or (it.research_cost = 0 and private.released(it, n)); $$;

-- May this player put a unit bought from this item at position pos? Spawn points count where the
-- player's units stand on the live map, i.e. where they started the turn.
create function private.can_spawn_at(p public.players, it public.tech_items, pos float8[]) returns boolean
language sql stable set search_path = ''
as $$
  with near_spawn as (
    select exists (
      select 1 from public.features f join public.tech_items s on s.id::text = f.props ->> 'tech' and s.map_id = f.map_id
      where f.map_id = p.map_id and f.owner_player_id = p.id and s.spawn_radius_m is not null
        and (cardinality(it.spawn_from) = 0 or s.id = any (it.spawn_from))
        and private.dist_m(private.anchor(f.geometry), pos) <= s.spawn_radius_m * 1.001 + 1) as ok
  ), in_zone as (
    select exists (
      select 1 from public.spawn_zones z
      where z.map_id = p.map_id
        and (z.player_id = p.id or (z.team is not null and z.team = p.team) or (z.player_id is null and z.team is null))
        and private.in_zone(z.zone, pos)) as ok
  )
  select case it.placement
    when 'anywhere' then true
    when 'spawn' then (select ok from near_spawn)
    when 'zone' then (select ok from in_zone)
    else (select ok from near_spawn) or (select ok from in_zone)
  end;
$$;

-- What each player's units on the map would earn at the next push.
create function private.income(p_player_id uuid) returns jsonb
language sql stable set search_path = ''
as $$
  select jsonb_build_object('spawn', coalesce(sum(t.income_spawn), 0), 'research', coalesce(sum(t.income_research), 0))
  from public.features f join public.tech_items t on t.id::text = f.props ->> 'tech' and t.map_id = f.map_id
  where f.owner_player_id = p_player_id;
$$;

create function private.tech_json(t public.tech_items) returns jsonb
language sql stable set search_path = ''
as $$ select to_jsonb(t) - 'map_id' - 'created_at'; $$;

-- Raises unless this change is allowed. strict = the player's rules (ownership, movement radius,
-- allocation, zone). Not strict = the owner editing a draft: structure and map membership only.
create function private.check_change(p public.players, t public.turns, p_op text, p_fid uuid, j jsonb, strict boolean) returns void
language plpgsql stable set search_path = ''
as $$
declare
  f public.features;
  a public.allocations;
  it public.tech_items;
  sq public.squadrons;
  k text;
  want text;
  r float8;
begin
  if p_fid is null then
    raise exception 'change has no feature_id' using errcode = '22023';
  end if;

  if p_op = 'create' then
    k := j ->> 'kind';
    want := case
      when k in ('symbol', 'asset', 'text', 'circle') then 'Point'
      when k in ('line', 'arrow', 'freehand') then 'LineString'
      when k = 'polygon' then 'Polygon'
    end;
    if want is null then
      raise exception 'object kind not allowed' using errcode = '22023';
    end if;
    if not private.valid_geom(j -> 'geometry', want) or octet_length((j -> 'geometry')::text) > 100000 then
      raise exception 'invalid geometry' using errcode = '22023';
    end if;
    if octet_length(coalesce(j -> 'props', '{}')::text) > 8000 or octet_length(coalesce(j -> 'style', '{}')::text) > 1000 then
      raise exception 'properties too large' using errcode = '22023';
    end if;
    if not private.valid_props(coalesce(j -> 'props', '{}'), coalesce(j -> 'style', '{}')) then
      raise exception 'invalid properties' using errcode = '22023';
    end if;
    if exists (select 1 from public.features x where x.id = p_fid) then
      raise exception 'object id already exists' using errcode = '22023';
    end if;
    -- Units are bought from the tech tree or come out of an allocation. Drawings (arrows, lines, areas, notes) are free.
    if nullif(j ->> 'purchase_id', '') is not null then
      if nullif(j ->> 'allocation_id', '') is not null then
        raise exception 'a unit is bought or allocated, not both' using errcode = '22023';
      end if;
      select * into it from public.tech_items x where x.id = (j ->> 'purchase_id')::uuid and x.map_id = p.map_id;
      if not found or not it.buyable then
        raise exception 'that item cannot be bought' using errcode = '42501';
      end if;
      if (k = 'symbol' and (it.sidc is null or j -> 'props' ->> 'sidc' is distinct from it.sidc))
         or (k = 'asset' and (it.asset_id is null or (j ->> 'asset_id')::uuid is distinct from it.asset_id))
         or k not in ('symbol', 'asset') then
        raise exception 'unit does not match its tech item' using errcode = '42501';
      end if;
      if strict and not private.unlocked(p, it, t.number) then
        raise exception '% is not researched yet', it.name using errcode = '42501';
      end if;
      if strict and not private.can_spawn_at(p, it, private.anchor(j -> 'geometry')) then
        raise exception '% must be placed %', it.name, case it.placement
          when 'spawn' then 'within range of one of your spawn points'
          when 'zone' then 'inside one of your spawn zones'
          else 'near one of your spawn points or inside a spawn zone' end using errcode = '42501';
      end if;
    elsif strict and k in ('symbol', 'asset') then
      select * into a from public.allocations x
       where x.id = nullif(j ->> 'allocation_id', '')::uuid and x.turn_id = t.id
         and (x.player_id = p.id or (x.team is not null and x.team <> '' and x.team = p.team));
      if not found then
        raise exception 'that unit is not in your allocation for this turn' using errcode = '42501';
      end if;
      if (k = 'symbol' and (a.sidc is null or j -> 'props' ->> 'sidc' is distinct from a.sidc))
         or (k = 'asset' and (a.asset_id is null or (j ->> 'asset_id')::uuid <> a.asset_id)) then
        raise exception 'unit does not match its allocation' using errcode = '42501';
      end if;
      if not private.in_zone(a.zone, private.anchor(j -> 'geometry')) then
        raise exception 'outside the placement zone' using errcode = '42501';
      end if;
    end if;
    if k = 'asset' and not exists (select 1 from public.assets x where x.id = nullif(j ->> 'asset_id', '')::uuid) then
      raise exception 'unknown graphic' using errcode = '22023';
    end if;

  elsif p_op = 'research' then
    select * into it from public.tech_items x where x.id = p_fid and x.map_id = p.map_id;
    if not found then
      raise exception 'unknown tech item' using errcode = '22023';
    end if;
    if strict and not private.released(it, t.number) then
      raise exception '% can be researched from turn %', it.name, it.release_turn using errcode = '42501';
    end if;
    if it.id = any (p.tech_unlocked) or (it.research_cost = 0 and private.released(it, t.number)) then
      raise exception '% is already available', it.name using errcode = '22023';
    end if;
    -- p here already counts the draft's other research, so a whole chain can be researched in one turn.
    if strict and exists (
      select 1 from unnest(it.prereqs) as need (item_id) join public.tech_items x on x.id = need.item_id
      where not private.unlocked(p, x, t.number)) then
      raise exception '% needs its prerequisites researched first', it.name using errcode = '42501';
    end if;

  elsif p_op in ('update', 'delete') then
    select * into f from public.features where id = p_fid and map_id = p.map_id;
    if not found or (strict and f.owner_player_id is distinct from p.id) then
      raise exception 'object is not assigned to this player' using errcode = '42501';
    end if;
    if p_op = 'update' then
      if j = '{}'::jsonb or exists (select 1 from jsonb_object_keys(j) key where key not in ('geometry', 'heading', 'order', 'attacks', 'retreat', 'emit')) then
        raise exception 'a draft can change position, heading, orders, attacks, retreat and radar only' using errcode = '42501';
      end if;
      if j ? 'emit' and jsonb_typeof(j -> 'emit') <> 'boolean' then
        raise exception 'invalid radar setting' using errcode = '22023';
      end if;
      if j ? 'retreat' and jsonb_typeof(j -> 'retreat') <> 'boolean' then
        raise exception 'invalid retreat order' using errcode = '22023';
      end if;
      if j ? 'attacks' then
        perform private.check_attacks(p, f, j -> 'attacks', strict);
      end if;
      -- A unit in a fight stays put unless it is ordered to retreat.
      if strict and j ? 'geometry' and not coalesce((j ->> 'retreat')::boolean, false) and private.engaged(f.id) then
        raise exception '% is engaged in combat and can only move by retreating', coalesce(nullif(f.props ->> 'name', ''), 'this unit') using errcode = '42501';
      end if;
      if j ? 'geometry' and (not private.valid_geom(j -> 'geometry', f.geometry ->> 'type')
                             or octet_length((j -> 'geometry')::text) > 100000) then
        raise exception 'invalid geometry' using errcode = '22023';
      end if;
      if j ? 'heading' and not (jsonb_typeof(j -> 'heading') = 'number' and private.num_in(j -> 'heading', 0, 360)) then
        raise exception 'invalid heading' using errcode = '22023';
      end if;
      if j ? 'order' and (jsonb_typeof(j -> 'order') <> 'string' or char_length(j ->> 'order') not between 1 and 2000) then
        raise exception 'invalid order text' using errcode = '22023';
      end if;
      if strict and j ? 'geometry' and exists (
        select 1 from public.tech_items x where x.id::text = f.props ->> 'tech' and x.map_id = f.map_id and not x.can_move) then
        raise exception '% cannot be moved', coalesce(nullif(f.props ->> 'name', ''), 'this building') using errcode = '42501';
      end if;
      -- Measured from where the unit is on the live map, i.e. where it started the turn.
      if strict and j ? 'geometry' then
        r := private.radius_for(t.id, t.default_radius_m, f.id, f.asset_id, f.props ->> 'tech');
        if r is not null and private.dist_m(private.anchor(f.geometry), private.anchor(j -> 'geometry')) > r * 1.001 + 1 then
          raise exception 'move is beyond the range of this unit (% m)', round(r) using errcode = '42501';
        end if;
      end if;
    end if;

  elsif p_op = 'mission' then
    perform private.check_mission(p, p_fid, j, strict);

  elsif p_op = 'buy_aircraft' then
    select * into sq from public.squadrons x where x.id = nullif(j ->> 'squadron', '')::uuid and x.map_id = p.map_id;
    if not found or (strict and sq.owner_player_id is distinct from p.id) then
      raise exception 'that squadron is not yours' using errcode = '42501';
    end if;
    if jsonb_typeof(j -> 'count') <> 'number' or (j ->> 'count')::integer < 1 then
      raise exception 'buy at least one aircraft' using errcode = '22023';
    end if;
    if strict and sq.aircraft + (j ->> 'count')::integer > sq.max_aircraft then
      raise exception '% has room for % more aircraft', sq.name, sq.max_aircraft - sq.aircraft using errcode = '42501';
    end if;
    if strict and sq.base_feature_id is null then
      raise exception '% has no base: replacements need a base to arrive at', sq.name using errcode = '42501';
    end if;

  elsif p_op = 'buy_squadron' then
    select * into it from public.tech_items x where x.id = nullif(j ->> 'purchase_id', '')::uuid and x.map_id = p.map_id;
    if not found or it.category <> 'squadron' or not it.buyable or it.airframe_id is null then
      raise exception 'that is not a squadron you can buy' using errcode = '42501';
    end if;
    if strict and not private.unlocked(p, it, t.number) then
      raise exception '% is not researched yet', it.name using errcode = '42501';
    end if;
    if exists (select 1 from public.squadrons x where x.id = p_fid) then
      raise exception 'squadron id already exists' using errcode = '22023';
    end if;
    if not private.str_ok(j -> 'name', 80) then
      raise exception 'invalid squadron name' using errcode = '22023';
    end if;
    select * into f from public.features x where x.id = nullif(j ->> 'base', '')::uuid and x.map_id = p.map_id;
    if not found or (strict and f.owner_player_id is distinct from p.id) then
      raise exception 'new squadrons need one of your own airbases' using errcode = '42501';
    end if;
    if private.base_capacity(f) <= 0 then
      raise exception 'that unit is not an airbase' using errcode = '42501';
    end if;
    if strict and (select count(*) from public.squadrons x where x.base_feature_id = f.id) >= private.base_capacity(f) then
      raise exception 'that airbase is full (% squadrons)', private.base_capacity(f) using errcode = '42501';
    end if;

  else
    raise exception 'invalid op' using errcode = '22023';
  end if;
end $$;

-- How many units other players' drafts have already taken out of an allocation (team pools).
create function private.used_by_others(p_turn_id uuid, p_allocation_id uuid, p_player_id uuid) returns integer
language sql stable set search_path = ''
as $$
  select count(*)::integer
  from public.drafts d, jsonb_array_elements(coalesce(d.owner_changes, d.changes)) c
  where d.turn_id = p_turn_id and d.player_id <> p_player_id
    and c ->> 'op' = 'create' and c -> 'payload' ->> 'allocation_id' = p_allocation_id::text
    and not ((c ->> 'feature_id')::uuid = any (d.rejected));
$$;

-- The tech items a draft spends points on: one row per purchase (spawn cost) and per research (research cost).
-- Rows are (item_id, kind) with kind 'buy' or 'research'; draft_costs joins them to their prices.
create function private.draft_items(p_changes jsonb, p_rejected uuid[]) returns table (item_id uuid, kind text)
language sql immutable set search_path = ''
as $$
  select case when c ->> 'op' = 'research' then (c ->> 'feature_id')::uuid else (c -> 'payload' ->> 'purchase_id')::uuid end,
         case when c ->> 'op' = 'research' then 'research' else 'buy' end
  from jsonb_array_elements(p_changes) c
  where not ((c ->> 'feature_id')::uuid = any (p_rejected))
    and (c ->> 'op' = 'research' or (c ->> 'op' in ('create', 'buy_squadron') and nullif(c -> 'payload' ->> 'purchase_id', '') is not null));
$$;

-- Per change: the item and which price applies. Research costs research points, a purchase spawn points.
create function private.draft_costs(p_changes jsonb, p_rejected uuid[]) returns table (item_id uuid, spawn bigint, research bigint)
language sql stable set search_path = ''
as $$
  select d.item_id, case when d.kind = 'buy' then t.spawn_cost else 0 end::bigint, case when d.kind = 'research' then t.research_cost else 0 end::bigint
  from private.draft_items(p_changes, p_rejected) d join public.tech_items t on t.id = d.item_id
  union all
  -- Replacement aircraft: the airframe's price per aircraft.
  select null::uuid, (a.cost_per_aircraft * greatest(0, (c -> 'payload' ->> 'count')::integer))::bigint, 0::bigint
  from jsonb_array_elements(p_changes) c
  join public.squadrons sq on sq.id::text = c -> 'payload' ->> 'squadron'
  join public.airframes a on a.id = sq.airframe_id
  where c ->> 'op' = 'buy_aircraft' and not ((c ->> 'feature_id')::uuid = any (p_rejected));
$$;

-- Validate a whole draft and return it in stored form. Changes listed in p_rejected are kept but
-- not checked: they will never be applied.
create function private.normalise(p public.players, t public.turns, p_changes jsonb, strict boolean, p_rejected uuid[] default '{}') returns jsonb
language plpgsql stable set search_path = ''
as $$
declare
  c jsonb;
  op text;
  fid uuid;
  clean jsonb;
  a public.allocations;
  seen uuid[] := '{}';
  result jsonb := '[]'::jsonb;
  taken integer;
  aid uuid;
  quota integer;
  others integer;
  it public.tech_items;
  cost_s bigint;
  cost_r bigint;
  -- The player as each change sees them: what this draft researches counts as researched, so a whole
  -- chain can be researched, and its units bought, in one turn. A research does not count itself.
  pp public.players := p;
  fresh uuid[];
begin
  if jsonb_typeof(p_changes) is distinct from 'array' then
    raise exception 'a draft is a list of changes' using errcode = '22023';
  end if;
  if jsonb_array_length(p_changes) > 200 or octet_length(p_changes::text) > 256000 then
    raise exception 'draft is too large' using errcode = '22023';
  end if;
  fresh := coalesce(array(
    select (ch ->> 'feature_id')::uuid from jsonb_array_elements(p_changes) ch
    where ch ->> 'op' = 'research' and not ((ch ->> 'feature_id')::uuid = any (p_rejected))), '{}');
  for c in select * from jsonb_array_elements(p_changes) loop
    op := c ->> 'op';
    fid := (c ->> 'feature_id')::uuid;
    if fid = any (seen) then
      raise exception 'a draft holds one change per object' using errcode = '22023';
    end if;
    seen := seen || fid;
    clean := private.clean_payload(op, c -> 'payload');
    if op = 'create' and clean ->> 'kind' in ('symbol', 'asset') and nullif(clean ->> 'allocation_id', '') is not null then
      -- The allocation is the template: the player supplies position, heading and a name, nothing else.
      select * into a from public.allocations x where x.id = (clean ->> 'allocation_id')::uuid and x.turn_id = t.id;
      if found then
        clean := clean || jsonb_build_object(
          'asset_id', a.asset_id,
          'props', a.props || private.pick(clean -> 'props', array['name', 'heading'])
                   || case when a.sidc is not null then jsonb_build_object('sidc', a.sidc) else '{}'::jsonb end,
          'style', '{}'::jsonb);
      end if;
    elsif op = 'create' and nullif(clean ->> 'purchase_id', '') is not null then
      -- Same for a purchase: the tech item is the template, and the unit remembers its item.
      select * into it from public.tech_items x where x.id = (clean ->> 'purchase_id')::uuid and x.map_id = p.map_id;
      if found then
        clean := clean || jsonb_build_object(
          'kind', case when it.asset_id is not null then 'asset' else 'symbol' end,
          'asset_id', it.asset_id,
          'props', it.props || private.pick(clean -> 'props', array['name', 'heading'])
                   || case when it.sidc is not null then jsonb_build_object('sidc', it.sidc) else '{}'::jsonb end
                   || jsonb_build_object('tech', it.id)
                   || case when it.template_id is not null then jsonb_build_object('unit', it.template_id) else '{}'::jsonb end,
          'style', '{}'::jsonb);
      end if;
    end if;
    -- Units a player creates wear that player's colour (tint on graphics, fill on NATO symbols) and remember
    -- who made them, so a later colour change follows. Also for drafts the owner edited.
    if op = 'create' and clean ->> 'kind' in ('symbol', 'asset') then
      clean := clean || jsonb_build_object('props', (coalesce(clean -> 'props', '{}') - 'tint')
                 || jsonb_build_object('made_by', p.id) || case when p.color is not null then jsonb_build_object('tint', p.color) else '{}'::jsonb end);
    end if;
    if not (fid = any (p_rejected)) then
      pp.tech_unlocked := p.tech_unlocked || case when op = 'create' then fresh when op = 'research' then array_remove(fresh, fid) else '{}' end;
      perform private.check_change(case when op in ('create', 'research') then pp else p end, t, op, fid, clean, strict);
    end if;
    result := result || jsonb_build_array(jsonb_build_object('op', op, 'feature_id', fid, 'payload', clean));
  end loop;

  if strict then
    for aid, quota, taken in
      select x.id, x.quantity, count(*)::integer
      from jsonb_array_elements(result) e
      join public.allocations x on x.id = nullif(e -> 'payload' ->> 'allocation_id', '')::uuid
      where e ->> 'op' = 'create' and not ((e ->> 'feature_id')::uuid = any (p_rejected))
      group by x.id, x.quantity
    loop
      others := private.used_by_others(t.id, aid, p.id);
      if taken + others > quota then
        raise exception 'allocation used up: % of % already taken by your team', least(quota, others), quota using errcode = '42501';
      end if;
    end loop;
    if exists (select 1 from jsonb_array_elements(result) e where e ->> 'op' = 'buy_aircraft' and not ((e ->> 'feature_id')::uuid = any (p_rejected))
               group by e -> 'payload' ->> 'squadron' having count(*) > 1) then
      raise exception 'buy replacements for a squadron in one order' using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(result) e
               where e ->> 'op' = 'mission' and e -> 'payload' ->> 'type' = 'escort' and not ((e ->> 'feature_id')::uuid = any (p_rejected))
                 and not exists (select 1 from jsonb_array_elements(result) x
                                 where x ->> 'op' = 'mission' and x ->> 'feature_id' = e -> 'payload' ->> 'escort_of'
                                   and x -> 'payload' ->> 'type' = 'strike' and not ((x ->> 'feature_id')::uuid = any (p_rejected)))) then
      raise exception 'an escort needs one of your strikes this turn to escort' using errcode = '42501';
    end if;
    if exists (select 1 from jsonb_array_elements(result) e
               join public.features b on b.id::text = e -> 'payload' ->> 'base'
               where e ->> 'op' = 'buy_squadron' and not ((e ->> 'feature_id')::uuid = any (p_rejected))
               group by b.id, b.kind, b.asset_id, b.props, b.map_id
               having count(*) + (select count(*) from public.squadrons x where x.base_feature_id = b.id)
                      > private.template_capacity(b.map_id, b.kind, b.asset_id, b.props)) then
      raise exception 'an airbase cannot take that many new squadrons' using errcode = '42501';
    end if;
    select coalesce(sum(c.spawn), 0), coalesce(sum(c.research), 0) into cost_s, cost_r
      from private.draft_costs(result, p_rejected) c;
    if cost_s > p.spawn_points then
      raise exception 'not enough spawn points: this draft costs %, you have %', cost_s, p.spawn_points using errcode = '42501';
    end if;
    if cost_r > p.research_points then
      raise exception 'not enough research points: this draft costs %, you have %', cost_r, p.research_points using errcode = '42501';
    end if;
  end if;
  return result;
end $$;

create function private.apply_change(p_map_id uuid, p public.players, p_layer_id uuid, c jsonb, p_z integer) returns void
language plpgsql volatile set search_path = ''
as $$
declare
  j jsonb := c -> 'payload';
  fid uuid := (c ->> 'feature_id')::uuid;
begin
  if c ->> 'op' = 'create' then
    if p_layer_id is null then
      raise exception 'map has no layer to put new objects on' using errcode = 'P0001';
    end if;
    insert into public.features (id, map_id, layer_id, kind, geometry, props, style, asset_id, z, owner_player_id)
    values (fid, p_map_id, p_layer_id, j ->> 'kind', j -> 'geometry', coalesce(j -> 'props', '{}'), coalesce(j -> 'style', '{}'),
            case when j ->> 'kind' = 'asset' then (j ->> 'asset_id')::uuid end, p_z, p.id);
    if nullif(j ->> 'purchase_id', '') is not null then
      update public.players x set spawn_points = x.spawn_points - t.spawn_cost
        from public.tech_items t where t.id = (j ->> 'purchase_id')::uuid and x.id = p.id;
    end if;
  elsif c ->> 'op' = 'mission' then
    null;   -- flown in the combat phase
  elsif c ->> 'op' = 'buy_aircraft' then
    update public.players x set spawn_points = x.spawn_points - a.cost_per_aircraft * (j ->> 'count')::integer
      from public.squadrons sq join public.airframes a on a.id = sq.airframe_id
     where sq.id = (j ->> 'squadron')::uuid and x.id = p.id;
    update public.squadrons sq set aircraft = least(sq.max_aircraft, sq.aircraft + (j ->> 'count')::integer)
     where sq.id = (j ->> 'squadron')::uuid and sq.map_id = p_map_id;
  elsif c ->> 'op' = 'buy_squadron' then
    insert into public.squadrons (id, map_id, owner_player_id, name, airframe_id, base_feature_id, aircraft, max_aircraft)
    select fid, p_map_id, p.id, coalesce(nullif(trim(j ->> 'name'), ''), t.name), a.id, (j ->> 'base')::uuid, a.squadron_size, a.squadron_size
    from public.tech_items t join public.airframes a on a.id = t.airframe_id
    where t.id = (j ->> 'purchase_id')::uuid
      and exists (select 1 from public.features b where b.id = (j ->> 'base')::uuid and b.map_id = p_map_id);
    update public.players x set spawn_points = x.spawn_points - t.spawn_cost
      from public.tech_items t where t.id = (j ->> 'purchase_id')::uuid and x.id = p.id;
  elsif c ->> 'op' = 'research' then
    update public.players x set research_points = x.research_points - t.research_cost,
                                tech_unlocked = array_append(x.tech_unlocked, t.id)
      from public.tech_items t where t.id = fid and t.map_id = p_map_id and x.id = p.id and not (t.id = any (x.tech_unlocked));
  elsif c ->> 'op' = 'update' then
    update public.features ft set
      geometry = coalesce(j -> 'geometry', ft.geometry),
      props = ft.props
        || case when j ? 'heading' then jsonb_build_object('heading', j -> 'heading') else '{}'::jsonb end
        || case when j ? 'emit' then jsonb_build_object('emit', j -> 'emit') else '{}'::jsonb end
        || case when j ? 'order' then jsonb_build_object('notes', left(concat_ws(E'\n',
             nullif(ft.props ->> 'notes', ''), '[' || p.name || '] ' || (j ->> 'order')), 4000)) else '{}'::jsonb end
    where ft.id = fid and ft.map_id = p_map_id;
  else
    delete from public.features where id = fid and map_id = p_map_id;
  end if;
end $$;

-- Put a map's layers and objects back to a stored snapshot.
create function private.restore_snapshot(p_map_id uuid, s jsonb) returns void
language plpgsql volatile set search_path = ''
as $$
begin
  delete from public.features where map_id = p_map_id;
  delete from public.layers l where l.map_id = p_map_id
    and l.id::text not in (select e ->> 'id' from jsonb_array_elements(s -> 'layers') e);
  insert into public.layers (id, map_id, name, visible, locked, z)
    select (e ->> 'id')::uuid, p_map_id, e ->> 'name', (e ->> 'visible')::boolean, coalesce((e ->> 'locked')::boolean, false), (e ->> 'z')::integer
    from jsonb_array_elements(s -> 'layers') e
  on conflict (id) do update set name = excluded.name, visible = excluded.visible, z = excluded.z;
  insert into public.features (id, map_id, layer_id, kind, geometry, props, style, asset_id, z, owner_player_id)
    select (e ->> 'id')::uuid, p_map_id, (e ->> 'layer_id')::uuid, e ->> 'kind', e -> 'geometry', e -> 'props', e -> 'style',
           (select a.id from public.assets a where a.id = nullif(e ->> 'asset_id', '')::uuid), (e ->> 'z')::integer,
           (select pl.id from public.players pl where pl.id = nullif(e ->> 'owner_player_id', '')::uuid and pl.map_id = p_map_id)
    from jsonb_array_elements(s -> 'features') e;
  -- Snapshots from before schema 4 have no economy: balances then stay as they are.
  update public.players pl set
    spawn_points = coalesce((e.value ->> 'spawn_points')::integer, pl.spawn_points),
    research_points = coalesce((e.value ->> 'research_points')::integer, pl.research_points),
    tech_unlocked = coalesce(array(select jsonb_array_elements_text(e.value -> 'tech_unlocked')::uuid), pl.tech_unlocked)
  from jsonb_each(coalesce(s -> 'economy', '{}'::jsonb)) e
  where pl.map_id = p_map_id and pl.id::text = e.key;
  -- Snapshots from before schema 8 have no combat state: it then stays as it is.
  if s ? 'combat' then
    delete from public.unit_state where map_id = p_map_id;
    insert into public.unit_state (feature_id, map_id, strength, experience, stationary_turns)
      select f.id, p_map_id, (e.value ->> 'strength')::float8, (e.value ->> 'experience')::integer, (e.value ->> 'stationary_turns')::integer
      from jsonb_each(s -> 'combat' -> 'units') e join public.features f on f.id::text = e.key and f.map_id = p_map_id;
    update public.engagements set status = 'ended', end_reason = coalesce(end_reason, 'rolled back') where map_id = p_map_id and status = 'active';
    insert into public.engagements (id, map_id, status, start_turn, turns_engaged, ended_turn, end_reason, units)
      select (e ->> 'id')::uuid, p_map_id, 'active', (e ->> 'start_turn')::integer, (e ->> 'turns_engaged')::integer, null, null, e -> 'units'
      from jsonb_array_elements(s -> 'combat' -> 'engagements') e
    on conflict (id) do update set status = 'active', turns_engaged = excluded.turns_engaged, units = excluded.units,
      ended_turn = null, end_reason = null;
    -- Squadrons (schema 10 and later): as they were, including ones raised since being removed.
    if s -> 'combat' ? 'squadrons' then
      delete from public.squadrons where map_id = p_map_id;
      insert into public.squadrons (id, map_id, owner_player_id, name, airframe_id, base_feature_id, aircraft, max_aircraft, damage, loadout, created_at)
        select (q ->> 'id')::uuid, p_map_id, (select pl.id from public.players pl where pl.id::text = q ->> 'owner_player_id' and pl.map_id = p_map_id),
               q ->> 'name', (q ->> 'airframe_id')::uuid,
               (select f.id from public.features f where f.id::text = q ->> 'base_feature_id' and f.map_id = p_map_id),
               (q ->> 'aircraft')::integer, (q ->> 'max_aircraft')::integer, (q ->> 'damage')::float8, coalesce(q -> 'loadout', '[]'),
               coalesce((q ->> 'created_at')::timestamptz, now())
        from jsonb_array_elements(s -> 'combat' -> 'squadrons') q
        where exists (select 1 from public.airframes a where a.id::text = q ->> 'airframe_id');
    end if;
  end if;
end $$;

create function private.pin_hash(p_salt text, p_pin text) returns text
language sql immutable set search_path = ''
as $$ select encode(sha256(convert_to(p_salt || ':' || p_pin, 'UTF8')), 'hex'); $$;

-- ---------------------------------------------------------------------------
-- 4. First run, admins, diagnostics
-- ---------------------------------------------------------------------------

-- Callable without a session: lets the app check the schema version and whether an owner exists.
create function public.app_status() returns jsonb
language sql stable security definer set search_path = ''
as $$ select jsonb_build_object('schema_version', private.schema_version(), 'claimed', exists (select 1 from private.admins)); $$;

-- Called by the keep-alive workflow. Any database query counts as activity for Supabase's pause timer.
create function public.keepalive() returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$ begin
  insert into public.app_meta (key, value) values ('last_keepalive', now()::text)
  on conflict (key) do update set value = excluded.value, updated_at = now();
  return jsonb_build_object('ok', true, 'schema_version', private.schema_version());
end $$;

create function public.whoami() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'uid', (select auth.uid()),
    'email', (select u.email from auth.users u where u.id = (select auth.uid())),
    'anonymous', coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false),
    'is_admin', private.is_admin(),
    'role', (select a.role from private.admins a where a.uid = (select auth.uid()) and private.is_admin()),
    'claimed', exists (select 1 from private.admins));
$$;

-- The first signed-in account takes ownership. After that this always fails.
create function public.claim_owner() returns boolean
language plpgsql volatile security definer set search_path = ''
as $$ begin
  if (select auth.uid()) is null or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  lock table private.admins in exclusive mode;
  if exists (select 1 from private.admins) then
    raise exception 'this installation already has an owner' using errcode = '42501';
  end if;
  insert into private.admins (uid, role) values ((select auth.uid()), 'owner');
  perform private.log(null, private.actor(), 'claimed ownership');
  return true;
end $$;

create function public.list_admins() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$ begin
  perform private.need_admin();
  return jsonb_build_object(
    'admins', (select jsonb_agg(jsonb_build_object('uid', a.uid, 'email', u.email, 'role', a.role, 'added_at', a.added_at,
                 'me', a.uid = (select auth.uid())) order by a.role desc, a.added_at)
               from private.admins a left join auth.users u on u.id = a.uid),
    'invites', coalesce((select jsonb_agg(i.email order by i.invited_at) from private.admin_invites i), '[]'::jsonb));
end $$;

-- Invite a co-admin by email. If that person already has a confirmed account they are added at
-- once; otherwise they become an admin the first time they sign in with that address.
create function public.invite_admin(p_email text) returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  e text := lower(trim(p_email));
  u uuid;
begin
  perform private.need_owner();
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(e) > 254 then
    raise exception 'that does not look like an email address' using errcode = '22023';
  end if;
  select x.id into u from auth.users x where lower(x.email) = e and x.email_confirmed_at is not null limit 1;
  if u is not null then
    insert into private.admins (uid, role) values (u, 'admin') on conflict do nothing;
    perform private.log(null, private.actor(), 'added admin', e);
    return 'added';
  end if;
  insert into private.admin_invites (email) values (e) on conflict do nothing;
  perform private.log(null, private.actor(), 'invited admin', e);
  return 'invited';
end $$;

create function public.cancel_admin_invite(p_email text) returns void
language plpgsql volatile security definer set search_path = ''
as $$ begin
  perform private.need_owner();
  delete from private.admin_invites where email = lower(trim(p_email));
end $$;

-- Called after sign-in. Only a confirmed address can pick up an invite.
create function public.accept_admin_invite() returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
declare e text;
begin
  if (select auth.uid()) is null or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) then
    return false;
  end if;
  select lower(u.email) into e from auth.users u where u.id = (select auth.uid()) and u.email_confirmed_at is not null;
  if e is null or not exists (select 1 from private.admin_invites i where i.email = e) then
    return false;
  end if;
  insert into private.admins (uid, role) values ((select auth.uid()), 'admin') on conflict do nothing;
  delete from private.admin_invites where email = e;
  perform private.log(null, e, 'accepted admin invite');
  return true;
end $$;

-- The owner cannot be removed, only replaced: there is always exactly one.
create function public.remove_admin(p_uid uuid) returns void
language plpgsql volatile security definer set search_path = ''
as $$ begin
  perform private.need_owner();
  if exists (select 1 from private.admins where uid = p_uid and role = 'owner') then
    raise exception 'transfer ownership before removing the owner' using errcode = 'P0001';
  end if;
  delete from private.admins where uid = p_uid;
  perform private.log(null, private.actor(), 'removed admin');
end $$;

create function public.transfer_ownership(p_uid uuid) returns void
language plpgsql volatile security definer set search_path = ''
as $$ begin
  perform private.need_owner();
  if not exists (select 1 from private.admins where uid = p_uid and role = 'admin') then
    raise exception 'ownership can only go to an existing co-admin' using errcode = 'P0001';
  end if;
  update private.admins set role = 'admin' where role = 'owner';
  update private.admins set role = 'owner' where uid = p_uid;
  perform private.log(null, private.actor(), 'transferred ownership');
end $$;

create function public.diagnostics() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$ begin
  perform private.need_admin();
  return jsonb_build_object(
    'schema_version', private.schema_version(),
    'last_keepalive', (select value from public.app_meta where key = 'last_keepalive'),
    'pg_net', private.has_pg_net(),
    'server_time', now(),
    'maps', (select count(*) from public.maps),
    'players', (select count(*) from public.players),
    'snapshots', (select count(*) from public.snapshots));
end $$;

create function public.list_activity(p_map_id uuid default null, p_limit integer default 100) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$ begin
  perform private.need_admin();
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.id desc) from (
      select a.id, a.map_id, a.at, a.actor, a.kind, a.detail from public.activity a
      where p_map_id is null or a.map_id = p_map_id or a.map_id is null
      order by a.id desc limit least(greatest(p_limit, 1), 500)) x), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------------
-- 5. Maps, graphics, sharing, settings
-- ---------------------------------------------------------------------------

create function public.create_map(p_name text) returns public.maps
language plpgsql volatile security definer set search_path = ''
as $$
declare m public.maps;
begin
  perform private.need_admin();
  insert into public.maps (name, owner_id) values (coalesce(nullif(trim(p_name), ''), 'Untitled map'), (select auth.uid())) returning * into m;
  insert into public.layers (map_id, name) values (m.id, 'Layer 1');
  perform private.log(m.id, private.actor(), 'created map', m.name);
  return m;
end $$;

-- p_patch may hold: name, basemap, center [lng, lat], zoom, archived, palette_assets [ids], palette_symbols.
create function public.update_map(p_map_id uuid, p_patch jsonb) returns public.maps
language plpgsql volatile security definer set search_path = ''
as $$
declare m public.maps;
begin
  perform private.need_map(p_map_id);
  if p_patch ? 'center' and not private.valid_pos(p_patch -> 'center') then
    raise exception 'invalid start position' using errcode = '22023';
  end if;
  if p_patch ? 'zoom' and not (jsonb_typeof(p_patch -> 'zoom') = 'number' and private.num_in(p_patch -> 'zoom', 0, 24)) then
    raise exception 'invalid zoom' using errcode = '22023';
  end if;
  update public.maps x set
    name = case when p_patch ? 'name' then trim(p_patch ->> 'name') else x.name end,
    basemap = case when p_patch ? 'basemap' then p_patch ->> 'basemap' else x.basemap end,
    center = case when p_patch ? 'center' then array[(p_patch -> 'center' ->> 0)::float8, (p_patch -> 'center' ->> 1)::float8] else x.center end,
    zoom = case when p_patch ? 'zoom' then (p_patch ->> 'zoom')::float8 else x.zoom end,
    archived = case when p_patch ? 'archived' then (p_patch ->> 'archived')::boolean else x.archived end,
    palette_symbols = case when p_patch ? 'palette_symbols' then (p_patch ->> 'palette_symbols')::boolean else x.palette_symbols end,
    palette_assets = case when p_patch ? 'palette_assets' then coalesce(
        (select array_agg(a.id) from public.assets a where a.id::text in (select jsonb_array_elements_text(p_patch -> 'palette_assets'))), '{}')
      else x.palette_assets end
  where x.id = p_map_id returning * into m;
  if p_patch ? 'archived' then
    perform private.log(p_map_id, private.actor(), case when m.archived then 'archived map' else 'restored map' end, m.name);
  end if;
  return m;
end $$;

-- Record an uploaded image. The file is already in storage; the path format is fixed by the uploader.
create function public.add_asset(p_name text, p_path text, p_mime text, p_width integer, p_height integer) returns public.assets
language plpgsql volatile security definer set search_path = ''
as $$
declare a public.assets;
begin
  perform private.need_admin();
  if p_path !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(png|webp|svg)$' then
    raise exception 'invalid file path' using errcode = '22023';
  end if;
  if p_width not between 1 and 20000 or p_height not between 1 and 20000 then
    raise exception 'invalid image size' using errcode = '22023';
  end if;
  insert into public.assets (owner_id, name, path, mime, width, height)
  values ((select auth.uid()), left(trim(p_name), 120), p_path, p_mime, p_width, p_height) returning * into a;
  return a;
end $$;

-- p_patch may hold: name, deleted (true hides the graphic from pickers; nothing is ever removed).
create function public.update_asset(p_asset_id uuid, p_patch jsonb) returns public.assets
language plpgsql volatile security definer set search_path = ''
as $$
declare a public.assets;
begin
  perform private.need_admin();
  update public.assets x set
    name = case when p_patch ? 'name' then left(trim(p_patch ->> 'name'), 120) else x.name end,
    deleted_at = case when p_patch ? 'deleted' then case when (p_patch ->> 'deleted')::boolean then coalesce(x.deleted_at, now()) end else x.deleted_at end
  where x.id = p_asset_id returning * into a;
  if not found then raise exception 'graphic not found' using errcode = '42501'; end if;
  return a;
end $$;

create function public.create_share_link(
  p_map_id uuid, p_mode text default 'live', p_visible_layers uuid[] default null,
  p_expires_at timestamptz default null, p_label text default null
) returns public.share_links
language plpgsql volatile security definer set search_path = ''
as $$
declare r public.share_links;
begin
  perform private.need_map(p_map_id);
  if p_mode not in ('live', 'snapshot') then
    raise exception 'invalid mode' using errcode = '22023';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'expiry must be in the future' using errcode = '22023';
  end if;
  insert into public.share_links (map_id, mode, visible_layers, expires_at, label, snapshot)
  values (p_map_id, p_mode, p_visible_layers, p_expires_at, nullif(trim(p_label), ''),
          case when p_mode = 'snapshot' then private.build_payload(p_map_id, p_visible_layers) end)
  returning * into r;
  return r;
end $$;

-- p_patch may hold: revoked, expires_at, label, visible_layers (null = all). The token never changes.
create function public.update_share_link(p_link_id uuid, p_patch jsonb) returns public.share_links
language plpgsql volatile security definer set search_path = ''
as $$
declare r public.share_links;
begin
  perform private.need_admin();
  update public.share_links x set
    revoked = case when p_patch ? 'revoked' then (p_patch ->> 'revoked')::boolean else x.revoked end,
    expires_at = case when p_patch ? 'expires_at' then (p_patch ->> 'expires_at')::timestamptz else x.expires_at end,
    label = case when p_patch ? 'label' then nullif(left(trim(p_patch ->> 'label'), 120), '') else x.label end,
    visible_layers = case when p_patch ? 'visible_layers' then
        case when jsonb_typeof(p_patch -> 'visible_layers') = 'array'
             then array(select jsonb_array_elements_text(p_patch -> 'visible_layers')::uuid) end
      else x.visible_layers end
  where x.id = p_link_id returning * into r;
  if not found then raise exception 'link not found' using errcode = '42501'; end if;
  return r;
end $$;

-- The webhook is write-only: it can be set, tested and cleared, but only a masked form is ever read back.
create function public.get_settings(p_map_id uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$ begin
  perform private.need_map(p_map_id);
  return jsonb_build_object(
    'discord', (select 'https://discord.com/api/webhooks/…' || right(s.discord_webhook, 4)
                  from private.map_secrets s where s.map_id = p_map_id and s.discord_webhook is not null),
    'pg_net', private.has_pg_net());
end $$;

create function public.set_discord_webhook(p_map_id uuid, p_url text) returns void
language plpgsql volatile security definer set search_path = ''
as $$ begin
  perform private.need_map(p_map_id);
  -- Discord hosts only, so this can never be pointed at anything else.
  if p_url is not null and trim(p_url) !~ '^https://(discord\.com|discordapp\.com)/api/webhooks/[0-9]+/[A-Za-z0-9_-]+$' then
    raise exception 'that is not a Discord webhook URL' using errcode = '22023';
  end if;
  insert into private.map_secrets (map_id, discord_webhook) values (p_map_id, nullif(trim(p_url), ''))
  on conflict (map_id) do update set discord_webhook = excluded.discord_webhook;
  perform private.log(p_map_id, private.actor(), case when p_url is null then 'cleared Discord webhook' else 'set Discord webhook' end);
end $$;

create function public.test_discord_webhook(p_map_id uuid) returns boolean
language plpgsql volatile security definer set search_path = ''
as $$ begin
  perform private.need_map(p_map_id);
  return private.notify_discord(p_map_id, 'Tacmap test message for "' || (select name from public.maps where id = p_map_id) || '". Turn announcements will appear here.');
end $$;

-- ---------------------------------------------------------------------------
-- 6. Players (owner side)
-- ---------------------------------------------------------------------------

create function private.check_layers(p_map_id uuid, p_layers uuid[]) returns void
language plpgsql stable set search_path = ''
as $$ begin
  if p_layers is not null and exists (
    select 1 from unnest(p_layers) x where x not in (select l.id from public.layers l where l.map_id = p_map_id)) then
    raise exception 'a chosen layer is not on this map' using errcode = '22023';
  end if;
end $$;

create function public.create_player(
  p_map_id uuid, p_name text, p_team text default '', p_color text default null,
  p_visible_layers uuid[] default null, p_target_layer_id uuid default null
) returns public.players
language plpgsql volatile security definer set search_path = ''
as $$
declare r public.players;
begin
  perform private.need_map(p_map_id);
  perform private.check_layers(p_map_id, p_visible_layers);
  perform private.check_layers(p_map_id, case when p_target_layer_id is not null then array[p_target_layer_id] end);
  if (select count(*) from public.players where map_id = p_map_id) >= 200 then
    raise exception 'player limit reached for this map' using errcode = 'P0001';
  end if;
  insert into public.players (map_id, name, team, color, visible_layers, target_layer_id)
  values (p_map_id, trim(p_name), coalesce(trim(p_team), ''), p_color, p_visible_layers, p_target_layer_id)
  returning * into r;
  perform private.log(p_map_id, private.actor(), 'created player', r.name);
  return r;
end $$;

-- p_patch may hold: name, team, color, visible_layers (null = all), target_layer_id, revoked.
create function public.update_player(p_player_id uuid, p_patch jsonb) returns public.players
language plpgsql volatile security definer set search_path = ''
as $$
declare
  r public.players;
  vis uuid[];
begin
  perform private.need_admin();
  select * into r from public.players where id = p_player_id for update;
  if not found then raise exception 'player not found' using errcode = '42501'; end if;
  if p_patch ? 'visible_layers' and jsonb_typeof(p_patch -> 'visible_layers') = 'array' then
    vis := array(select jsonb_array_elements_text(p_patch -> 'visible_layers')::uuid);
    perform private.check_layers(r.map_id, vis);
  end if;
  if nullif(p_patch ->> 'target_layer_id', '') is not null then
    perform private.check_layers(r.map_id, array[(p_patch ->> 'target_layer_id')::uuid]);
  end if;
  update public.players x set
    name = case when p_patch ? 'name' then trim(p_patch ->> 'name') else x.name end,
    team = case when p_patch ? 'team' then coalesce(trim(p_patch ->> 'team'), '') else x.team end,
    color = case when p_patch ? 'color' then p_patch ->> 'color' else x.color end,
    visible_layers = case when p_patch ? 'visible_layers' then vis else x.visible_layers end,
    target_layer_id = case when p_patch ? 'target_layer_id' then nullif(p_patch ->> 'target_layer_id', '')::uuid else x.target_layer_id end,
    revoked = case when p_patch ? 'revoked' then (p_patch ->> 'revoked')::boolean else x.revoked end
  where x.id = p_player_id returning * into r;
  -- Units this player created follow their colour.
  if p_patch ? 'color' then
    update public.features f set props = (f.props - 'tint') || case when r.color is not null then jsonb_build_object('tint', r.color) else '{}'::jsonb end
     where f.map_id = r.map_id and f.props ->> 'made_by' = r.id::text;
  end if;
  if p_patch ? 'revoked' then
    perform private.log(r.map_id, private.actor(), case when r.revoked then 'revoked player' else 'restored player' end, r.name);
  end if;
  return r;
end $$;

-- New link; the old one stops working and the browser bound to it is signed out of the seat.
create function public.reset_player_invite(p_player_id uuid) returns public.players
language plpgsql volatile security definer set search_path = ''
as $$
declare r public.players;
begin
  perform private.need_admin();
  update public.players p set invite_token = private.new_token(), auth_uid = null
   where p.id = p_player_id returning * into r;
  if not found then raise exception 'player not found' using errcode = '42501'; end if;
  perform private.log(r.map_id, private.actor(), 'regenerated invite', r.name);
  return r;
end $$;

-- p_pin null removes the PIN. Setting or removing it also clears any lockout.
create function public.set_player_pin(p_player_id uuid, p_pin text) returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  salt text := private.new_token();
  r public.players;
begin
  perform private.need_admin();
  if p_pin is not null and p_pin !~ '^[0-9]{4}$' then
    raise exception 'a PIN is exactly 4 digits' using errcode = '22023';
  end if;
  update public.players p set
    pin_salt = case when p_pin is null then null else salt end,
    pin_hash = case when p_pin is null then null else private.pin_hash(salt, p_pin) end,
    pin_failures = 0, pin_locked_until = null
  where p.id = p_player_id returning * into r;
  if not found then raise exception 'player not found' using errcode = '42501'; end if;
  perform private.log(r.map_id, private.actor(), case when p_pin is null then 'removed PIN' else 'set PIN' end, r.name);
end $$;

create function public.clear_pin_lockout(p_player_id uuid) returns void
language plpgsql volatile security definer set search_path = ''
as $$ begin
  perform private.need_admin();
  update public.players set pin_failures = 0, pin_locked_until = null where id = p_player_id;
  if not found then raise exception 'player not found' using errcode = '42501'; end if;
end $$;

-- Assign units to a player, or to nobody with p_player_id null. Returns how many changed.
create function public.assign_units(p_map_id uuid, p_feature_ids uuid[], p_player_id uuid) returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare n integer;
begin
  perform private.need_map(p_map_id);
  if p_player_id is not null and not exists (select 1 from public.players where id = p_player_id and map_id = p_map_id) then
    raise exception 'player is not on this map' using errcode = '22023';
  end if;
  update public.features set owner_player_id = p_player_id
   where map_id = p_map_id and id = any (p_feature_ids) and owner_player_id is distinct from p_player_id;
  get diagnostics n = row_count;
  return n;
end $$;

-- Set which layers every player on a team sees (null = all). Returns how many players changed.
create function public.set_team_visibility(p_map_id uuid, p_team text, p_visible_layers uuid[]) returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare n integer;
begin
  perform private.need_map(p_map_id);
  perform private.check_layers(p_map_id, p_visible_layers);
  update public.players set visible_layers = p_visible_layers where map_id = p_map_id and team = coalesce(p_team, '');
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- 7. Turns (owner side)
-- ---------------------------------------------------------------------------

create function private.need_turn(p_turn_id uuid, p_statuses text[]) returns public.turns
language plpgsql volatile set search_path = ''
as $$
declare t public.turns;
begin
  perform private.need_admin();
  select * into t from public.turns where id = p_turn_id for update;
  if not found then raise exception 'turn not found' using errcode = '42501'; end if;
  if not (t.status = any (p_statuses)) then
    raise exception 'turn % is %', t.number, replace(t.status, '_', ' ') using errcode = 'P0001';
  end if;
  return t;
end $$;

-- p_patch may hold: deadline, default_radius_m, conflict_m, carry_allocations. A key with null clears it.
create function private.patch_turn(p_turn_id uuid, p_patch jsonb) returns void
language sql volatile set search_path = ''
as $$
  update public.turns x set
    deadline = case when p_patch ? 'deadline' then (p_patch ->> 'deadline')::timestamptz else x.deadline end,
    default_radius_m = case when p_patch ? 'default_radius_m' then (p_patch ->> 'default_radius_m')::float8 else x.default_radius_m end,
    conflict_m = case when p_patch ? 'conflict_m' then (p_patch ->> 'conflict_m')::float8 else x.conflict_m end,
    carry_allocations = case when p_patch ? 'carry_allocations' then coalesce((p_patch ->> 'carry_allocations')::boolean, false) else x.carry_allocations end
  where x.id = p_turn_id;
$$;

-- Start the first turn (or a new one when none is active). Also records the starting position as turn 0.
create function public.open_turn(p_map_id uuid, p_patch jsonb default '{}') returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  tid uuid;
  n integer;
begin
  perform private.need_map(p_map_id);
  if (private.active_turn(p_map_id)).id is not null then
    raise exception 'a turn is already in progress' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.snapshots where map_id = p_map_id) then
    insert into public.snapshots (map_id, turn_number, label, payload) values (p_map_id, 0, 'Start', private.snapshot_now(p_map_id));
  end if;
  select greatest(coalesce((select max(number) from public.turns where map_id = p_map_id), 0),
                  coalesce((select max(turn_number) from public.snapshots where map_id = p_map_id), 0)) + 1 into n;
  insert into public.turns (map_id, number) values (p_map_id, n) returning id into tid;
  perform private.patch_turn(tid, coalesce(p_patch, '{}'));
  perform private.log(p_map_id, private.actor(), 'opened turn', 'Turn ' || n);
  return tid;
end $$;

create function public.update_turn(p_turn_id uuid, p_patch jsonb) returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare t public.turns;
begin
  t := private.need_turn(p_turn_id, array['open', 'locked']);
  perform private.patch_turn(p_turn_id, p_patch);
  perform private.log(t.map_id, private.actor(), 'changed turn settings', 'Turn ' || t.number);
end $$;

-- One override for a unit or for a graphic. p_radius_m null removes it; 0 pins the unit in place.
create function public.set_move_rule(p_turn_id uuid, p_feature_id uuid, p_asset_id uuid, p_radius_m double precision) returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare t public.turns;
begin
  t := private.need_turn(p_turn_id, array['open', 'locked']);
  if (p_feature_id is null) = (p_asset_id is null) then
    raise exception 'give a unit or a graphic, not both' using errcode = '22023';
  end if;
  if p_feature_id is not null and not exists (select 1 from public.features where id = p_feature_id and map_id = t.map_id) then
    raise exception 'unit is not on this map' using errcode = '22023';
  end if;
  if p_asset_id is not null and not exists (select 1 from public.assets where id = p_asset_id) then
    raise exception 'unknown graphic' using errcode = '22023';
  end if;
  delete from public.turn_move_rules r where r.turn_id = p_turn_id
    and (r.feature_id = p_feature_id or r.asset_id = p_asset_id);
  if p_radius_m is not null then
    insert into public.turn_move_rules (turn_id, feature_id, asset_id, radius_m) values (p_turn_id, p_feature_id, p_asset_id, p_radius_m);
  end if;
end $$;

-- p may hold: id (to change an existing one), player_id or team, asset_id or sidc, props, quantity, zone.
create function public.save_allocation(p_turn_id uuid, p jsonb) returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  t public.turns;
  aid uuid := coalesce(nullif(p ->> 'id', '')::uuid, gen_random_uuid());
  pid uuid := nullif(p ->> 'player_id', '')::uuid;
  asset uuid := nullif(p ->> 'asset_id', '')::uuid;
  props jsonb := private.pick(p -> 'props', array['name', 'type', 'speed', 'sizeMode', 'sizePx', 'sizeM', 'tint', 'showLabel']);
begin
  t := private.need_turn(p_turn_id, array['open', 'locked']);
  if pid is not null and not exists (select 1 from public.players where id = pid and map_id = t.map_id) then
    raise exception 'player is not on this map' using errcode = '22023';
  end if;
  if asset is not null and not exists (select 1 from public.assets where id = asset and deleted_at is null) then
    raise exception 'unknown or deleted graphic' using errcode = '22023';
  end if;
  if not private.valid_zone(p -> 'zone') then
    raise exception 'invalid placement zone' using errcode = '22023';
  end if;
  if not private.valid_props(props, '{}') then
    raise exception 'invalid properties' using errcode = '22023';
  end if;
  insert into public.allocations (id, turn_id, player_id, team, asset_id, sidc, props, quantity, zone)
  values (aid, p_turn_id, pid, case when pid is null then nullif(trim(p ->> 'team'), '') end, asset,
          case when asset is null then p ->> 'sidc' end, props, (p ->> 'quantity')::integer, nullif(p -> 'zone', 'null'::jsonb))
  on conflict (id) do update set player_id = excluded.player_id, team = excluded.team, asset_id = excluded.asset_id,
    sidc = excluded.sidc, props = excluded.props, quantity = excluded.quantity, zone = excluded.zone
  where public.allocations.turn_id = p_turn_id;
  return aid;
end $$;

create function public.delete_allocation(p_allocation_id uuid) returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare tid uuid;
begin
  perform private.need_admin();
  select turn_id into tid from public.allocations where id = p_allocation_id;
  if tid is null then return; end if;
  perform private.need_turn(tid, array['open', 'locked']);
  delete from public.allocations where id = p_allocation_id;
end $$;

create function public.lock_turn(p_turn_id uuid) returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare t public.turns;
begin
  t := private.need_turn(p_turn_id, array['open']);
  update public.turns set status = 'locked', locked_at = now() where id = p_turn_id;
  perform private.log(t.map_id, private.actor(), 'locked turn', 'Turn ' || t.number);
end $$;

-- Reopen a turn locked by mistake. Review notes and decisions made so far are kept.
create function public.unlock_turn(p_turn_id uuid) returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare t public.turns;
begin
  t := private.need_turn(p_turn_id, array['locked']);
  update public.turns set status = 'open', locked_at = null where id = p_turn_id;
  perform private.log(t.map_id, private.actor(), 'reopened turn', 'Turn ' || t.number);
end $$;

-- The owner's side of one draft. p_patch may hold:
--   rejected       [feature ids] changes to leave out of the push
--   owner_changes  replacement list of changes (null goes back to the player's own)
--   owner_note     text shown to the player after the push
--   ready          accept (true) or set aside (false) the whole draft; only ready drafts are applied
--   clear          true empties the draft and the review
create function public.review_draft(p_turn_id uuid, p_player_id uuid, p_patch jsonb) returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  t public.turns;
  p public.players;
  oc jsonb;
begin
  t := private.need_turn(p_turn_id, array['open', 'locked']);
  select * into p from public.players where id = p_player_id and map_id = t.map_id;
  if not found then raise exception 'player is not on this map' using errcode = '22023'; end if;
  insert into public.drafts (turn_id, player_id) values (p_turn_id, p_player_id) on conflict do nothing;

  if coalesce((p_patch ->> 'clear')::boolean, false) then
    update public.drafts set changes = '[]', owner_changes = null, rejected = '{}', ready = false, updated_at = now()
     where turn_id = p_turn_id and player_id = p_player_id;
    perform private.log(t.map_id, private.actor(), 'cleared draft', p.name);
  end if;
  if p_patch ? 'owner_changes' and jsonb_typeof(p_patch -> 'owner_changes') = 'array' then
    oc := private.normalise(p, t, p_patch -> 'owner_changes', false);
  end if;
  update public.drafts d set
    rejected = case when p_patch ? 'rejected' then array(select jsonb_array_elements_text(p_patch -> 'rejected')::uuid) else d.rejected end,
    owner_changes = case when p_patch ? 'owner_changes' then oc else d.owner_changes end,
    owner_note = case when p_patch ? 'owner_note' then nullif(left(trim(p_patch ->> 'owner_note'), 1000), '') else d.owner_note end,
    ready = case when p_patch ? 'ready' then (p_patch ->> 'ready')::boolean else d.ready end
  where d.turn_id = p_turn_id and d.player_id = p_player_id;
  if p_patch ? 'ready' then
    perform private.log(t.map_id, private.actor(), case when (p_patch ->> 'ready')::boolean then 'marked ready for' else 'marked not ready for' end, p.name);
  end if;
end $$;

-- Everything the owner's turn panel needs.
create function public.get_turn(p_map_id uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare t public.turns;
begin
  perform private.need_map(p_map_id);
  t := private.active_turn(p_map_id);
  return jsonb_build_object(
    'turn', private.turn_json(t),
    'rules', coalesce((select jsonb_agg(jsonb_build_object('feature_id', r.feature_id, 'asset_id', r.asset_id, 'radius_m', r.radius_m))
                         from public.turn_move_rules r where r.turn_id = t.id), '[]'::jsonb),
    'allocations', coalesce((select jsonb_agg(to_jsonb(a) - 'turn_id' order by a.created_at) from public.allocations a where a.turn_id = t.id), '[]'::jsonb),
    'drafts', coalesce((select jsonb_agg(to_jsonb(d) - 'turn_id' order by d.updated_at) from public.drafts d where d.turn_id = t.id), '[]'::jsonb),
    'economy', private.economy_json(p_map_id),
    'history', private.history(p_map_id),
    'server_time', now());
end $$;

-- Push the turn. Everything below happens in one transaction: either the whole turn lands, a
-- snapshot is written and the next turn opens, or nothing changes and the error says why.
create function public.push_turn(p_turn_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  t public.turns;
  d public.drafts;
  p public.players;
  c jsonb;
  eff jsonb;
  plan jsonb := '[]'::jsonb;
  item jsonb;
  lid uuid;
  top_z integer;
  applied integer := 0;
  used jsonb := '{}'::jsonb;
  k text;
  next_id uuid;
  next_n integer;
  cp public.combat_previews;
begin
  t := private.need_turn(p_turn_id, array['locked']);

  -- Combat: a reviewed result is needed whenever there are units with templates or running fights,
  -- and it must have been computed from exactly what this push is about to apply.
  if private.combat_needed(t) then
    select * into cp from public.combat_previews where turn_id = t.id;
    if not found then
      raise exception 'combat has not been resolved for this turn: run the combat preview first' using errcode = 'P0001';
    end if;
    if cp.signature <> md5(private.combat_inputs(t)::text) then
      raise exception 'something changed since the combat preview (a draft, a rejection, a unit or a setting): run it again' using errcode = 'P0001';
    end if;
  end if;

  -- Pass 1: re-check every accepted draft against the map as it is now. A draft the owner edited
  -- is held to structural checks only; an untouched one must still obey radius, zone and allocation.
  for d in select * from public.drafts where turn_id = t.id and ready order by updated_at loop
    select * into p from public.players where id = d.player_id;
    continue when p.revoked;
    begin
      eff := private.normalise(p, t, coalesce(d.owner_changes, d.changes), d.owner_changes is null, d.rejected);
    exception when others then
      raise exception '%: % Reject or edit that change, then push again.', p.name, sqlerrm using errcode = sqlstate;
    end;
    plan := plan || jsonb_build_array(jsonb_build_object('player', d.player_id, 'rejected', to_jsonb(d.rejected), 'changes', eff));
  end loop;

  -- Pass 2: apply.
  select coalesce(max(z), 0) into top_z from public.features where map_id = t.map_id;
  for item in select * from jsonb_array_elements(plan) loop
    select * into p from public.players where id = (item ->> 'player')::uuid;
    select l.id into lid from public.layers l where l.map_id = t.map_id and l.id = p.target_layer_id;
    if lid is null then
      select l.id into lid from public.layers l where l.map_id = t.map_id order by l.visible desc, l.z desc limit 1;  -- top visible layer
    end if;
    for c in select * from jsonb_array_elements(item -> 'changes') loop
      continue when (item -> 'rejected') ? (c ->> 'feature_id');
      top_z := top_z + 1;
      perform private.apply_change(t.map_id, p, lid, c, top_z);
      applied := applied + 1;
      k := c -> 'payload' ->> 'allocation_id';
      if c ->> 'op' = 'create' and k is not null then
        used := used || jsonb_build_object(k, coalesce((used ->> k)::integer, 0) + 1);
      end if;
    end loop;
  end loop;

  -- Combat, on the final positions: strength, experience, engagements, destroyed units, reports.
  if cp.turn_id is not null then
    perform private.apply_combat(t, cp.result);
  end if;

  -- Income: every unit on the map that carries a tech item pays its owner, after this turn's moves,
  -- purchases and losses. Revoked seats earn nothing.
  update public.players x set
    spawn_points = x.spawn_points + i.s,
    research_points = x.research_points + i.r
  from (select f.owner_player_id as pid, sum(ti.income_spawn)::integer as s, sum(ti.income_research)::integer as r
          from public.features f join public.tech_items ti on ti.id::text = f.props ->> 'tech' and ti.map_id = f.map_id
         where f.map_id = t.map_id and f.owner_player_id is not null
         group by f.owner_player_id) i
  where x.id = i.pid and not x.revoked and (i.s <> 0 or i.r <> 0);

  update public.turns set status = 'pushed', pushed_at = now() where id = t.id;
  insert into public.snapshots (map_id, turn_number, label, payload)
  values (t.map_id, t.number, case when t.rollback_of is not null then 'Rolled back from turn ' || t.rollback_of end,
          private.snapshot_now(t.map_id) || case when cp.turn_id is not null then jsonb_build_object('combat_log', cp.result -> 'log', 'combat_data', cp.data) else '{}'::jsonb end);

  -- Next turn: same settings, same length, same per-unit rules.
  next_n := t.number + 1;
  insert into public.turns (map_id, number, default_radius_m, conflict_m, carry_allocations, deadline)
  values (t.map_id, next_n, t.default_radius_m, t.conflict_m, t.carry_allocations,
          case when t.deadline is not null then now() + greatest(t.deadline - t.opened_at, interval '1 hour') end)
  returning id into next_id;
  insert into public.turn_move_rules (turn_id, feature_id, asset_id, radius_m)
    select next_id, r.feature_id, r.asset_id, r.radius_m from public.turn_move_rules r
    where r.turn_id = t.id and (r.feature_id is null or exists (select 1 from public.features f where f.id = r.feature_id));
  if t.carry_allocations then
    insert into public.allocations (turn_id, player_id, team, asset_id, sidc, props, quantity, zone)
      select next_id, a.player_id, a.team, a.asset_id, a.sidc, a.props, a.quantity - coalesce((used ->> a.id::text)::integer, 0), a.zone
      from public.allocations a
      where a.turn_id = t.id and a.quantity - coalesce((used ->> a.id::text)::integer, 0) > 0;
  end if;

  perform private.log(t.map_id, private.actor(), 'pushed turn', 'Turn ' || t.number || ', ' || applied || ' changes');
  perform private.notify_discord(t.map_id, 'Turn ' || t.number || ' of "' || (select name from public.maps where id = t.map_id)
    || '" is live. Turn ' || next_n || ' is open for orders.');
  return jsonb_build_object('pushed', t.number, 'next', next_n, 'applied', applied);
end $$;

-- ---------------------------------------------------------------------------
-- 7b. Tech tree, points and spawn zones (owner side)
-- ---------------------------------------------------------------------------

create function private.economy_json(p_map_id uuid) returns jsonb
language sql stable set search_path = ''
as $$
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(private.tech_json(t) order by t.tier, t.sort, t.name) from public.tech_items t where t.map_id = p_map_id), '[]'::jsonb),
    'zones', coalesce((select jsonb_agg(to_jsonb(z) - 'map_id' order by z.created_at) from public.spawn_zones z where z.map_id = p_map_id), '[]'::jsonb),
    'players', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'spawn_points', p.spawn_points, 'research_points', p.research_points,
                           'tech_unlocked', to_jsonb(p.tech_unlocked), 'income', private.income(p.id)) order by p.created_at)
                         from public.players p where p.map_id = p_map_id), '[]'::jsonb));
$$;

create function public.get_economy(p_map_id uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$ begin
  perform private.need_map(p_map_id);
  return private.economy_json(p_map_id);
end $$;

-- p may hold: id (to change an existing item), name, description, tier, sort, research_cost, spawn_cost,
-- prereqs [ids], buyable, asset_id or sidc, props, income_spawn, income_research, spawn_radius_m, placement.
create function public.save_tech_item(p_map_id uuid, p jsonb) returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  tid uuid := coalesce(nullif(p ->> 'id', '')::uuid, gen_random_uuid());
  asset uuid := nullif(p ->> 'asset_id', '')::uuid;
  pre uuid[] := coalesce(array(select distinct jsonb_array_elements_text(case when jsonb_typeof(p -> 'prereqs') = 'array' then p -> 'prereqs' else '[]' end)::uuid), '{}');
  sfrom uuid[] := coalesce(array(select distinct jsonb_array_elements_text(case when jsonb_typeof(p -> 'spawn_from') = 'array' then p -> 'spawn_from' else '[]' end)::uuid), '{}');
  props jsonb := private.pick(p -> 'props', array['name', 'type', 'speed', 'sizeMode', 'sizePx', 'sizeM', 'tint', 'showLabel']);
begin
  perform private.need_map(p_map_id);
  if exists (select 1 from public.tech_items x where x.id = tid and x.map_id <> p_map_id) then
    raise exception 'tech item is on another map' using errcode = '42501';
  end if;
  if asset is not null and not exists (select 1 from public.assets where id = asset) then
    raise exception 'unknown graphic' using errcode = '22023';
  end if;
  if tid = any (pre) or exists (select 1 from unnest(pre) r where r not in (select x.id from public.tech_items x where x.map_id = p_map_id)) then
    raise exception 'a prerequisite is not in this tech tree' using errcode = '22023';
  end if;
  if not private.valid_props(props, '{}') then
    raise exception 'invalid properties' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(sfrom) r where r not in (select x.id from public.tech_items x where x.map_id = p_map_id and x.id <> tid)) then
    raise exception 'a producing building is not in this tech tree' using errcode = '22023';
  end if;
  insert into public.tech_items (id, map_id, name, description, tier, sort, research_cost, spawn_cost, prereqs, buyable,
                                 asset_id, sidc, props, income_spawn, income_research, spawn_radius_m, placement, pos_x, pos_y,
                                 category, can_move, spawn_from, move_range_m, release_turn, template_id, airframe_id)
  values (tid, p_map_id, trim(p ->> 'name'), nullif(trim(p ->> 'description'), ''), coalesce((p ->> 'tier')::integer, 1),
          coalesce((p ->> 'sort')::integer, 0), coalesce((p ->> 'research_cost')::integer, 0), coalesce((p ->> 'spawn_cost')::integer, 0),
          pre, coalesce((p ->> 'buyable')::boolean, true), asset,
          case when asset is null then coalesce(nullif(p ->> 'sidc', ''), case when p ->> 'category' = 'squadron' then 'SFAPMF---------' end) end, props,
          coalesce((p ->> 'income_spawn')::integer, 0), coalesce((p ->> 'income_research')::integer, 0),
          nullif((p ->> 'spawn_radius_m')::float8, 0), coalesce(p ->> 'placement', 'either'),
          (p ->> 'pos_x')::float8, (p ->> 'pos_y')::float8,
          coalesce(p ->> 'category', 'unit'), coalesce((p ->> 'can_move')::boolean, true), sfrom, (p ->> 'move_range_m')::float8,
          (p ->> 'release_turn')::integer,
          (select x.id from public.unit_templates x where x.id = nullif(p ->> 'template_id', '')::uuid and x.map_id = p_map_id),
          (select x.id from public.airframes x where x.id = nullif(p ->> 'airframe_id', '')::uuid and x.map_id = p_map_id))
  on conflict (id) do update set name = excluded.name, description = excluded.description, tier = excluded.tier, sort = excluded.sort,
    research_cost = excluded.research_cost, spawn_cost = excluded.spawn_cost, prereqs = excluded.prereqs, buyable = excluded.buyable,
    asset_id = excluded.asset_id, sidc = excluded.sidc, props = excluded.props, income_spawn = excluded.income_spawn,
    income_research = excluded.income_research, spawn_radius_m = excluded.spawn_radius_m, placement = excluded.placement,
    pos_x = coalesce(excluded.pos_x, public.tech_items.pos_x), pos_y = coalesce(excluded.pos_y, public.tech_items.pos_y),
    category = excluded.category, can_move = excluded.can_move, spawn_from = excluded.spawn_from, move_range_m = excluded.move_range_m,
    release_turn = excluded.release_turn, template_id = excluded.template_id, airframe_id = excluded.airframe_id;
  -- No loops: an item may not (indirectly) require itself.
  if exists (
    with recursive up (id) as (
      select unnest(pre)
      union
      select unnest(x.prereqs) from public.tech_items x join up on x.id = up.id
    ) select 1 from up where up.id = tid) then
    raise exception 'that would make the item require itself' using errcode = '22023';
  end if;
  return tid;
end $$;

-- Move flowchart boxes. p is [{"id": ..., "x": ..., "y": ...}]; items on other maps are ignored.
create function public.move_tech_items(p_map_id uuid, p jsonb) returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare n integer;
begin
  perform private.need_map(p_map_id);
  update public.tech_items t set pos_x = (e ->> 'x')::float8, pos_y = (e ->> 'y')::float8
    from jsonb_array_elements(case when jsonb_typeof(p) = 'array' then p else '[]' end) e
   where t.map_id = p_map_id and t.id::text = e ->> 'id'
     and abs((e ->> 'x')::float8) < 1000000 and abs((e ->> 'y')::float8) < 1000000;
  get diagnostics n = row_count;
  return n;
end $$;

-- Removes the item from the tree and from other items' prerequisites. Units already on the map keep
-- their props.tech, which then pays nothing. Drafts that buy or research it fail until fixed.
create function public.delete_tech_item(p_item_id uuid) returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare t public.tech_items;
begin
  perform private.need_admin();
  delete from public.tech_items where id = p_item_id returning * into t;
  if t.id is null then return; end if;
  update public.tech_items set prereqs = array_remove(prereqs, p_item_id) where map_id = t.map_id and p_item_id = any (prereqs);
  update public.tech_items set spawn_from = array_remove(spawn_from, p_item_id) where map_id = t.map_id and p_item_id = any (spawn_from);
  update public.players set tech_unlocked = array_remove(tech_unlocked, p_item_id) where map_id = t.map_id and p_item_id = any (tech_unlocked);
  perform private.log(t.map_id, private.actor(), 'deleted tech item', t.name);
end $$;

-- p may hold: id, name, player_id or team (neither = everyone), zone.
create function public.save_spawn_zone(p_map_id uuid, p jsonb) returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  zid uuid := coalesce(nullif(p ->> 'id', '')::uuid, gen_random_uuid());
  pid uuid := nullif(p ->> 'player_id', '')::uuid;
begin
  perform private.need_map(p_map_id);
  if pid is not null and not exists (select 1 from public.players where id = pid and map_id = p_map_id) then
    raise exception 'player is not on this map' using errcode = '22023';
  end if;
  if p -> 'zone' is null or p -> 'zone' = 'null'::jsonb or not private.valid_zone(p -> 'zone') then
    raise exception 'invalid spawn zone' using errcode = '22023';
  end if;
  insert into public.spawn_zones (id, map_id, name, player_id, team, zone)
  values (zid, p_map_id, nullif(trim(p ->> 'name'), ''), pid, case when pid is null then nullif(trim(p ->> 'team'), '') end, p -> 'zone')
  on conflict (id) do update set name = excluded.name, player_id = excluded.player_id, team = excluded.team, zone = excluded.zone
  where public.spawn_zones.map_id = p_map_id;
  return zid;
end $$;

create function public.delete_spawn_zone(p_zone_id uuid) returns void
language plpgsql volatile security definer set search_path = ''
as $$ begin
  perform private.need_admin();
  delete from public.spawn_zones where id = p_zone_id;
end $$;

-- Set a player's balances. Null keeps a value as it is.
create function public.set_player_points(p_player_id uuid, p_spawn integer, p_research integer) returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare r public.players;
begin
  perform private.need_admin();
  if p_spawn not between -1000000000 and 1000000000 or p_research not between -1000000000 and 1000000000 then
    raise exception 'points out of range' using errcode = '22023';
  end if;
  update public.players x set spawn_points = coalesce(p_spawn, x.spawn_points), research_points = coalesce(p_research, x.research_points)
   where x.id = p_player_id returning * into r;
  if not found then raise exception 'player not found' using errcode = '42501'; end if;
  perform private.log(r.map_id, private.actor(), 'set points', r.name || ': ' || r.spawn_points || ' spawn, ' || r.research_points || ' research');
end $$;

-- Grant or take away a researched item without charging points.
create function public.set_player_tech(p_player_id uuid, p_item_id uuid, p_unlocked boolean) returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare r public.players;
begin
  perform private.need_admin();
  select * into r from public.players where id = p_player_id;
  if not found then raise exception 'player not found' using errcode = '42501'; end if;
  if not exists (select 1 from public.tech_items where id = p_item_id and map_id = r.map_id) then
    raise exception 'unknown tech item' using errcode = '22023';
  end if;
  update public.players set tech_unlocked = case when p_unlocked
      then (select array_agg(distinct x) from unnest(array_append(tech_unlocked, p_item_id)) x)
      else array_remove(tech_unlocked, p_item_id) end
   where id = p_player_id;
end $$;

-- Payload weight of a loadout (per aircraft), kg.
create function private.loadout_weight(p_loadout jsonb) returns float8
language sql stable set search_path = ''
as $$
  select coalesce(sum(w.weight * (l ->> 'count')::integer), 0)
  from jsonb_array_elements(coalesce(p_loadout, '[]')) l join public.air_weapons w on w.id::text = l ->> 'weapon';
$$;

-- Combat radius with this loadout: base radius x (1 - penalty x payload / max payload).
create function private.squadron_radius(sq public.squadrons, s jsonb) returns float8
language sql stable set search_path = ''
as $$
  select a.radius_m * (1 - (s ->> 'radius_penalty')::float8 * least(1, private.loadout_weight(sq.loadout) / nullif(a.max_payload, 0)))
  from public.airframes a where a.id = sq.airframe_id;
$$;

-- ---------------------------------------------------------------------------
-- 7c. Ground combat
-- The damage engine itself runs in the owner's browser (app/lib/combat.ts) on inputs built here,
-- so the sandbox, the review preview and the tests use one implementation. The database builds the
-- inputs (final positions after movement, terrain via PostGIS, settings for the turn), stores the
-- reviewed result with a fingerprint of those inputs, and push applies it only if nothing changed.
-- ---------------------------------------------------------------------------

-- Every number has a default here; combat_settings rows override them per map from a given turn.
create function private.combat_defaults() returns jsonb
language sql immutable set search_path = ''
as $$ select '{
  "attacker_stationary": 1.1, "target_stationary": 0.9, "dug_in": 0.85, "dug_in_turns": 2,
  "flank_front_deg": 60, "flank_rear_deg": 60, "flank_side": 1.15, "flank_rear": 1.3,
  "veteran_max": 1.1, "veteran_encounters": 10, "variance": 0.2, "clamp": 1.5,
  "rounds_max": 3, "parting_round": true, "recovery_pct": 10, "remove_destroyed": true,
  "intel_km": 100, "band_fresh": 0.9, "band_damaged": 0.6, "band_heavy": 0.3,
  "terrain": {"open": 1.0, "urban": 0.7, "forest": 0.8},
  "terrain_min_km2": {"urban": 25, "forest": 50},
  "hit_min": 5, "hit_max": 95, "radius_penalty": 0.4, "dark_penalty": 0.5,
  "patrol_radius_km": 50, "patrol_radius_max_km": 200, "recon_radius_km": 25
}'::jsonb $$;

-- Settings in force on turn n: the defaults, overlaid by the newest saved version at or before n.
create function private.combat_settings_for(p_map_id uuid, n integer) returns jsonb
language sql stable set search_path = ''
as $$
  select private.combat_defaults() || coalesce((
    select c.settings from public.combat_settings c where c.map_id = p_map_id and c.from_turn <= coalesce(n, 1)
    order by c.from_turn desc limit 1), '{}'::jsonb);
$$;

-- The turn settings are judged against: the open turn, else the next one.
create function private.current_turn_number(p_map_id uuid) returns integer
language sql stable set search_path = ''
as $$
  select coalesce((private.active_turn(p_map_id)).number, (select max(t.number) + 1 from public.turns t where t.map_id = p_map_id), 1);
$$;

-- A unit's template: set on the unit, else its tech item's, else the first template drawn the same way.
create function private.template_for(p_map_id uuid, p_kind text, p_asset uuid, p_props jsonb) returns uuid
language sql stable set search_path = ''
as $$
  select coalesce(
    (select t.id from public.unit_templates t where t.id::text = p_props ->> 'unit' and t.map_id = p_map_id and t.deleted_at is null),
    (select t.id from public.tech_items x join public.unit_templates t on t.id = x.template_id
      where x.id::text = p_props ->> 'tech' and x.map_id = p_map_id and t.deleted_at is null),
    (select t.id from public.unit_templates t where t.map_id = p_map_id and t.deleted_at is null and p_kind = 'asset'
      and t.asset_id = p_asset order by t.created_at limit 1),
    (select t.id from public.unit_templates t where t.map_id = p_map_id and t.deleted_at is null and p_kind = 'symbol'
      and t.sidc = p_props ->> 'sidc' order by t.created_at limit 1));
$$;

create function private.engaged(p_fid uuid) returns boolean
language sql stable set search_path = ''
as $$ select exists (select 1 from public.engagements e where e.status = 'active' and e.units @> jsonb_build_array(jsonb_build_object('fid', p_fid))); $$;

-- Terrain at a point: urban wins over forest where both cover it; elsewhere open.
create function private.terrain_at(p_map_id uuid, pos float8[]) returns text
language sql stable set search_path = ''
as $$
  select coalesce((
    select z.type from public.terrain_zones z
    where z.map_id = p_map_id and extensions.st_covers(z.geom, extensions.st_setsrid(extensions.st_makepoint(pos[1], pos[2]), 4326))
    order by (z.type = 'urban') desc limit 1), 'open');
$$;

-- Declared attacks on a unit's update: [{"slot": weapon index on its template, "target": feature id}].
-- One target per weapon; the target must be another player's (or the owner's) ground unit the player can see.
create function private.check_attacks(p public.players, f public.features, a jsonb, strict boolean) returns void
language plpgsql stable set search_path = ''
as $$
declare
  tid uuid := private.template_for(f.map_id, f.kind, f.asset_id, f.props);
  tpl public.unit_templates;
  e jsonb;
  slots integer[] := '{}';
  slot integer;
  tgt public.features;
  ttpl uuid;
begin
  if jsonb_typeof(a) <> 'array' or jsonb_array_length(a) > 20 then
    raise exception 'invalid attack orders' using errcode = '22023';
  end if;
  if jsonb_array_length(a) = 0 then return; end if;
  select * into tpl from public.unit_templates where id = tid;
  if not found or tpl.category <> 'ground' then
    raise exception 'this unit cannot fight on the ground' using errcode = '42501';
  end if;
  for e in select * from jsonb_array_elements(a) loop
    if jsonb_typeof(e -> 'slot') <> 'number' or nullif(e ->> 'target', '') is null then
      raise exception 'invalid attack order' using errcode = '22023';
    end if;
    slot := (e ->> 'slot')::integer;
    if slot < 0 or slot >= coalesce(array_length(tpl.weapon_ids, 1), 0) or slot = any (slots) then
      raise exception 'each weapon takes one target' using errcode = '22023';
    end if;
    slots := slots || slot;
    select * into tgt from public.features x where x.id = (e ->> 'target')::uuid and x.map_id = f.map_id;
    if not found or tgt.id = f.id then
      raise exception 'that target is not on the map' using errcode = '22023';
    end if;
    if strict and tgt.owner_player_id = p.id then
      raise exception 'you cannot attack your own unit' using errcode = '42501';
    end if;
    ttpl := private.template_for(tgt.map_id, tgt.kind, tgt.asset_id, tgt.props);
    if not exists (select 1 from public.unit_templates t where t.id = ttpl and t.category = 'ground') then
      raise exception 'that target cannot be attacked on the ground' using errcode = '42501';
    end if;
    if strict and not exists (select 1 from public.layers l where l.id = tgt.layer_id and l.visible
                                and (p.visible_layers is null or l.id = any (p.visible_layers))) then
      raise exception 'that target is not visible to you' using errcode = '42501';
    end if;
  end loop;
end $$;

-- Everything the engine needs for this turn, built from the database as push would see it:
-- units at their final positions after the accepted drafts, with template, weapons, state, terrain,
-- declared attacks and retreats; active engagements; the turn's settings. Deterministic, so its md5
-- is the fingerprint a preview is checked against.
create function private.combat_inputs(t public.turns) returns jsonb
language sql stable set search_path = ''
as $$
  with acc as (
    select d.player_id, c
    from public.drafts d join public.players pl on pl.id = d.player_id,
         jsonb_array_elements(coalesce(d.owner_changes, d.changes)) c
    where d.turn_id = t.id and d.ready and not pl.revoked and not ((c ->> 'feature_id')::uuid = any (d.rejected))
  ),
  upd as (select (c ->> 'feature_id')::uuid as fid, c -> 'payload' as pl from acc where c ->> 'op' = 'update'),
  gone as (select (c ->> 'feature_id')::uuid as fid from acc where c ->> 'op' = 'delete'),
  existing as (
    select f.id, f.owner_player_id as owner, f.props, private.template_for(f.map_id, f.kind, f.asset_id, f.props) as tid,
           private.anchor(f.geometry) as start,
           coalesce(private.anchor(u.pl -> 'geometry'), private.anchor(f.geometry)) as pos,
           coalesce((u.pl -> 'heading')::float8, (f.props ->> 'heading')::float8) as heading,
           coalesce(u.pl -> 'attacks', '[]'::jsonb) as attacks, coalesce((u.pl ->> 'retreat')::boolean, false) as retreat, false as fresh,
           coalesce((u.pl ->> 'emit')::boolean, (f.props ->> 'emit')::boolean, true) as emit
    from public.features f left join upd u on u.fid = f.id
    where f.map_id = t.map_id and f.kind in ('symbol', 'asset') and f.id not in (select fid from gone)
  ),
  created as (
    select (a.c ->> 'feature_id')::uuid, a.player_id, a.c -> 'payload' -> 'props',
           private.template_for(t.map_id, a.c -> 'payload' ->> 'kind', nullif(a.c -> 'payload' ->> 'asset_id', '')::uuid, a.c -> 'payload' -> 'props'),
           private.anchor(a.c -> 'payload' -> 'geometry'), private.anchor(a.c -> 'payload' -> 'geometry'),
           (a.c -> 'payload' -> 'props' ->> 'heading')::float8, '[]'::jsonb, false, true, true
    from acc a where a.c ->> 'op' = 'create' and a.c -> 'payload' ->> 'kind' in ('symbol', 'asset')
  ),
  units as (
    select x.*, tp.name as tname, tp.max_strength, tp.armor, tp.category, tp.weapon_ids, tp.aps, tp.air_capacity
    from (select * from existing union all select * from created) x
    join public.unit_templates tp on tp.id = x.tid
  )
  select jsonb_build_object(
    'map_id', t.map_id, 'turn', t.number,
    'settings', private.combat_settings_for(t.map_id, t.number),
    'units', coalesce((select jsonb_agg(jsonb_build_object(
        'id', u.id, 'name', coalesce(nullif(u.props ->> 'name', ''), u.tname), 'owner', u.owner,
        'side', coalesce(nullif((select pl.team from public.players pl where pl.id = u.owner), ''), u.owner::text, 'owner'),
        'template', jsonb_build_object('id', u.tid, 'name', u.tname, 'max_strength', u.max_strength, 'armor', u.armor, 'category', u.category,
                                       'aps', u.aps, 'air_capacity', u.air_capacity),
        'weapons', coalesce((select jsonb_agg(jsonb_build_object('slot', w.n - 1, 'id', wp.id, 'name', wp.name, 'attacks', wp.attacks, 'ap', wp.ap,
                               'range_m', wp.range_m, 'indirect', wp.indirect, 'anti_air', wp.anti_air, 'guidance', wp.guidance,
                               'accuracy', wp.accuracy, 'air_damage', wp.air_damage, 'air_shots', wp.air_shots) order by w.n)
                             from unnest(u.weapon_ids) with ordinality w (wid, n) join public.weapon_profiles wp on wp.id = w.wid and wp.deleted_at is null), '[]'::jsonb),
        'start', to_jsonb(u.start), 'pos', to_jsonb(u.pos),
        'moved', u.fresh or private.dist_m(u.start, u.pos) > 0.5,
        'heading', u.heading,
        'strength', coalesce(s.strength, u.max_strength), 'experience', coalesce(s.experience, 0), 'stationary_turns', coalesce(s.stationary_turns, 0),
        'terrain', private.terrain_at(t.map_id, u.pos),
        'new', u.fresh, 'retreat', u.retreat, 'attacks', u.attacks, 'emit', u.emit) order by u.id)
      from units u left join public.unit_state s on s.feature_id = u.id), '[]'::jsonb),
    -- Squadrons with their airframe, loadout, base position after movement, and this turn's mission.
    'squadrons', coalesce((select jsonb_agg(jsonb_build_object(
        'id', q.id, 'name', q.name, 'owner', q.owner_player_id,
        'side', coalesce(nullif((select pl.team from public.players pl where pl.id = q.owner_player_id), ''), q.owner_player_id::text, 'owner'),
        'airframe', to_jsonb(af) - 'map_id' - 'created_at' - 'deleted_at' - 'asset_id' - 'sidc',
        'base', q.base_feature_id,
        'base_pos', (select to_jsonb(coalesce(private.anchor(u2.pl -> 'geometry'), private.anchor(bf.geometry)))
                     from public.features bf left join upd u2 on u2.fid = bf.id where bf.id = q.base_feature_id and bf.id not in (select fid from gone)),
        'aircraft', q.aircraft, 'max', q.max_aircraft, 'damage', q.damage,
        'loadout', coalesce((select jsonb_agg((to_jsonb(w) - 'map_id' - 'created_at' - 'deleted_at' - 'tech_item_id' - 'family_id') || jsonb_build_object('count', (l ->> 'count')::integer)
                                              order by w.id)
                             from jsonb_array_elements(q.loadout) l join public.air_weapons w on w.id::text = l ->> 'weapon' and w.deleted_at is null), '[]'::jsonb),
        'radius_m', private.squadron_radius(q, private.combat_settings_for(t.map_id, t.number)),
        'mission', (select a.c -> 'payload' from acc a where a.c ->> 'op' = 'mission' and (a.c ->> 'feature_id')::uuid = q.id limit 1)) order by q.id)
      from public.squadrons q join public.airframes af on af.id = q.airframe_id where q.map_id = t.map_id), '[]'::jsonb),
    'engagements', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'start_turn', e.start_turn, 'turns_engaged', e.turns_engaged, 'units', e.units) order by e.id)
      from public.engagements e where e.map_id = t.map_id and e.status = 'active'), '[]'::jsonb));
$$;

create function public.get_combat_inputs(p_turn_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare t public.turns;
begin
  t := private.need_turn(p_turn_id, array['open', 'locked']);
  return private.combat_inputs(t);
end $$;

-- p: {"data": {...salts and edits...}, "result": {...engine output...}}. Stored with the inputs' fingerprint.
create function public.save_combat_preview(p_turn_id uuid, p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  t public.turns;
  sig text;
begin
  t := private.need_turn(p_turn_id, array['open', 'locked']);
  if jsonb_typeof(p -> 'result') <> 'object' or jsonb_typeof(p -> 'result' -> 'units') <> 'array' or jsonb_typeof(p -> 'result' -> 'engagements') <> 'array' then
    raise exception 'invalid combat result' using errcode = '22023';
  end if;
  if octet_length(p::text) > 8000000 then
    raise exception 'combat result is too large' using errcode = '22023';
  end if;
  sig := md5(private.combat_inputs(t)::text);
  insert into public.combat_previews (turn_id, signature, data, result) values (t.id, sig, coalesce(p -> 'data', '{}'), p -> 'result')
  on conflict (turn_id) do update set signature = excluded.signature, data = excluded.data, result = excluded.result, created_at = now();
  return jsonb_build_object('signature', sig, 'saved_at', now());
end $$;

create function public.get_combat_preview(p_turn_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  t public.turns;
  c public.combat_previews;
begin
  t := private.need_turn(p_turn_id, array['open', 'locked']);
  select * into c from public.combat_previews where turn_id = t.id;
  if not found then return null; end if;
  return jsonb_build_object('data', c.data, 'result', c.result, 'created_at', c.created_at,
                            'stale', c.signature <> md5(private.combat_inputs(t)::text));
end $$;

-- Does this map need a combat result to push? Any unit with a template (strength, recovery and
-- stationary counts move every turn) or any engagement still running.
create function private.combat_needed(t public.turns) returns boolean
language sql stable set search_path = ''
as $$ select jsonb_array_length(private.combat_inputs(t) -> 'units') > 0
          or exists (select 1 from public.engagements e where e.map_id = t.map_id and e.status = 'active')
          or exists (select 1 from public.squadrons q where q.map_id = t.map_id); $$;

create function private.band(ratio float8, s jsonb) returns text
language sql immutable set search_path = ''
as $$
  select case
    when ratio <= 0 then 'destroyed'
    when ratio >= (s ->> 'band_fresh')::float8 then 'fresh'
    when ratio >= (s ->> 'band_damaged')::float8 then 'damaged'
    when ratio >= (s ->> 'band_heavy')::float8 then 'heavily damaged'
    else 'critical' end;
$$;

-- Apply a reviewed result inside push_turn, after movement. Returns the combat log for the snapshot.
create function private.apply_combat(t public.turns, res jsonb) returns void
language plpgsql volatile set search_path = ''
as $$
declare
  s jsonb := private.combat_settings_for(t.map_id, t.number);
  u jsonb;
  e jsonb;
  pl public.players;
  own jsonb;
  engs jsonb;
begin
  for u in select * from jsonb_array_elements(res -> 'units') loop
    continue when not exists (select 1 from public.features f where f.id = (u ->> 'id')::uuid and f.map_id = t.map_id);
    if coalesce((u ->> 'destroyed')::boolean, false) and coalesce((s ->> 'remove_destroyed')::boolean, true) then
      delete from public.features where id = (u ->> 'id')::uuid and map_id = t.map_id;
      continue;
    end if;
    insert into public.unit_state (feature_id, map_id, strength, experience, stationary_turns, updated_at)
    values ((u ->> 'id')::uuid, t.map_id, greatest(0, (u ->> 'after')::float8), (u ->> 'experience')::integer, (u ->> 'stationary_turns')::integer, now())
    on conflict (feature_id) do update set strength = excluded.strength, experience = excluded.experience,
      stationary_turns = excluded.stationary_turns, updated_at = now();
  end loop;
  -- Air: aircraft lost and damage carried per squadron; recon reveals for the next turn.
  for u in select * from jsonb_array_elements(coalesce(res -> 'air' -> 'squadrons', '[]')) loop
    -- Losses as a difference: replacements bought this turn were added already and must not be overwritten.
    update public.squadrons q set aircraft = greatest(0, q.aircraft - greatest(0, (u ->> 'lost')::integer)), damage = greatest(0, (u ->> 'damage')::float8)
     where q.id = (u ->> 'id')::uuid and q.map_id = t.map_id;
  end loop;
  insert into public.air_reveals (map_id, player_id, turn_number, center, radius_m)
    select t.map_id, (r ->> 'owner')::uuid, t.number, array[(r -> 'center' ->> 0)::float8, (r -> 'center' ->> 1)::float8], (r ->> 'radius_m')::float8
    from jsonb_array_elements(coalesce(res -> 'air' -> 'reveals', '[]')) r
    where exists (select 1 from public.players pr where pr.id::text = r ->> 'owner' and pr.map_id = t.map_id);
  for e in select * from jsonb_array_elements(res -> 'engagements') loop
    insert into public.engagements (id, map_id, status, start_turn, turns_engaged, ended_turn, end_reason, units, updated_at)
    values ((e ->> 'id')::uuid, t.map_id, e ->> 'status', (e ->> 'start_turn')::integer, (e ->> 'turns_engaged')::integer,
            case when e ->> 'status' = 'ended' then t.number end, e ->> 'end_reason', coalesce(e -> 'units', '[]'), now())
    on conflict (id) do update set status = excluded.status, turns_engaged = excluded.turns_engaged, ended_turn = excluded.ended_turn,
      end_reason = excluded.end_reason, units = excluded.units, updated_at = now()
    where public.engagements.map_id = t.map_id;
  end loop;

  -- One report per player: their own units in full, everyone else only as an intel band, and only
  -- within intel range of one of their units after the turn. Nothing else about other units.
  for pl in select * from public.players x where x.map_id = t.map_id and not x.revoked loop
    own := coalesce((
      select jsonb_agg(jsonb_build_object('id', x ->> 'id', 'name', x ->> 'name', 'max', x -> 'max', 'before', x -> 'before', 'after', x -> 'after',
                                          'destroyed', x -> 'destroyed', 'fired', x -> 'fired', 'hit', x -> 'hit', 'recovered', x -> 'recovered'))
      from jsonb_array_elements(res -> 'units') x
      where x ->> 'owner' = pl.id::text
        and (coalesce((x ->> 'fired')::boolean, false) or coalesce((x ->> 'hit')::boolean, false) or coalesce((x ->> 'recovered')::float8, 0) > 0)), '[]');
    engs := '[]';
    for e in select * from jsonb_array_elements(res -> 'engagements') loop
      continue when not exists (select 1 from jsonb_array_elements(res -> 'units') x
                                where x ->> 'owner' = pl.id::text and e -> 'units' @> jsonb_build_array(jsonb_build_object('fid', x ->> 'id')));
      engs := engs || jsonb_build_array(jsonb_build_object(
        'id', e ->> 'id', 'status', e ->> 'status', 'new', e -> 'new', 'end_reason', e ->> 'end_reason', 'rounds', e -> 'rounds',
        'own', coalesce((select jsonb_agg(x ->> 'name') from jsonb_array_elements(res -> 'units') x
                         where x ->> 'owner' = pl.id::text and e -> 'units' @> jsonb_build_array(jsonb_build_object('fid', x ->> 'id'))), '[]'),
        'others', coalesce((
          select jsonb_agg(jsonb_build_object('name', x ->> 'name', 'band',
                   case when exists (select 1 from public.features mf
                                     where mf.map_id = t.map_id and mf.owner_player_id = pl.id
                                       and private.dist_m(private.anchor(mf.geometry), array[(x -> 'pos' ->> 0)::float8, (x -> 'pos' ->> 1)::float8])
                                           <= (s ->> 'intel_km')::float8 * 1000)
                        then private.band((x ->> 'after')::float8 / nullif((x ->> 'max')::float8, 0), s) end))
          from jsonb_array_elements(res -> 'units') x
          where x ->> 'owner' is distinct from pl.id::text and e -> 'units' @> jsonb_build_array(jsonb_build_object('fid', x ->> 'id'))), '[]')));
    end loop;
    insert into public.combat_reports (map_id, turn_number, player_id, report)
    values (t.map_id, t.number, pl.id, jsonb_build_object('turn', t.number, 'own', own, 'engagements', engs, 'air', private.air_report(t, pl, res, s)))
    on conflict (player_id, turn_number) do update set report = excluded.report;
  end loop;
end $$;

-- Combat state for one player: exact for their own units, an estimate band for others within intel
-- range of any of their units, nothing beyond. Built per request; nothing out of range is ever sent.
create function private.player_combat(p public.players) returns jsonb
language sql stable set search_path = ''
as $$
  with s as (select private.combat_settings_for(p.map_id, private.current_turn_number(p.map_id)) as v),
  u as (
    select f.id, f.owner_player_id, private.anchor(f.geometry) as pos, f.layer_id, f.props, tp.name, tp.category, tp.max_strength, tp.weapon_ids,
           st.strength, st.experience, st.stationary_turns
    from public.features f
    join public.unit_templates tp on tp.id = private.template_for(f.map_id, f.kind, f.asset_id, f.props)
    left join public.unit_state st on st.feature_id = f.id
    where f.map_id = p.map_id and f.kind in ('symbol', 'asset')
  ),
  mine as (select * from u where u.owner_player_id = p.id),
  seen as (
    select u.* from u
    where u.owner_player_id is distinct from p.id
      and exists (select 1 from public.layers l where l.id = u.layer_id and l.visible and (p.visible_layers is null or l.id = any (p.visible_layers)))
      and exists (select 1 from mine m where private.dist_m(m.pos, u.pos) <= (select (v ->> 'intel_km')::float8 * 1000 from s))
  )
  select jsonb_build_object(
    'intel_km', (select (v ->> 'intel_km')::float8 from s),
    'own', coalesce((select jsonb_object_agg(m.id, jsonb_build_object(
        'template', m.name, 'category', m.category, 'max', m.max_strength, 'strength', coalesce(m.strength, m.max_strength),
        'experience', coalesce(m.experience, 0), 'stationary_turns', coalesce(m.stationary_turns, 0), 'engaged', private.engaged(m.id),
        'radar_aa', exists (select 1 from unnest(m.weapon_ids) w2 join public.weapon_profiles wp2 on wp2.id = w2 where wp2.anti_air and wp2.guidance = 'radar'),
        'anti_air', exists (select 1 from unnest(m.weapon_ids) w2 join public.weapon_profiles wp2 on wp2.id = w2 where wp2.anti_air),
        'emit', coalesce((m.props ->> 'emit')::boolean, true),
        -- Weapon names and ranges only: enough to pick targets, never attacks or AP.
        'weapons', coalesce((select jsonb_agg(jsonb_build_object('slot', w.n - 1, 'name', wp.name, 'range_m', wp.range_m, 'indirect', wp.indirect) order by w.n)
                             from unnest(m.weapon_ids) with ordinality w (wid, n) join public.weapon_profiles wp on wp.id = w.wid and wp.deleted_at is null), '[]'::jsonb)))
      from mine m), '{}'::jsonb),
    'seen', coalesce((select jsonb_object_agg(x.id, jsonb_build_object('band', private.band(coalesce(x.strength, x.max_strength) / x.max_strength, (select v from s)),
                        'ground', x.category = 'ground'))
      from seen x), '{}'::jsonb),
    -- Own engagements, naming only units this player can see on the map.
    'engagements', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'turns', e.turns_engaged,
        'units', (select jsonb_agg(x ->> 'fid') from jsonb_array_elements(e.units) x
                   where exists (select 1 from mine m where m.id::text = x ->> 'fid') or exists (select 1 from seen v where v.id::text = x ->> 'fid'))))
      from public.engagements e
      where e.map_id = p.map_id and e.status = 'active'
        and exists (select 1 from jsonb_array_elements(e.units) x join mine m on m.id::text = x ->> 'fid')), '[]'::jsonb),
    'report', (select r.report from public.combat_reports r where r.player_id = p.id order by r.turn_number desc limit 1));
$$;

-- ---- owner: templates, weapons, settings, unit overrides ----

create function public.get_combat_admin(p_map_id uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare n integer;
begin
  perform private.need_map(p_map_id);
  n := private.current_turn_number(p_map_id);
  return jsonb_build_object(
    'turn', n,
    'defaults', private.combat_defaults(),
    'settings', private.combat_settings_for(p_map_id, n),
    'versions', coalesce((select jsonb_agg(jsonb_build_object('from_turn', c.from_turn, 'settings', c.settings, 'updated_at', c.updated_at) order by c.from_turn)
                          from public.combat_settings c where c.map_id = p_map_id), '[]'::jsonb),
    'weapons', coalesce((select jsonb_agg(to_jsonb(w) - 'map_id' order by w.created_at) from public.weapon_profiles w where w.map_id = p_map_id), '[]'::jsonb),
    'templates', coalesce((select jsonb_agg(to_jsonb(x) - 'map_id' order by x.created_at) from public.unit_templates x where x.map_id = p_map_id), '[]'::jsonb),
    'units', coalesce((select jsonb_object_agg(f.id, jsonb_build_object('template', tid, 'strength', st.strength, 'experience', st.experience,
                          'stationary_turns', st.stationary_turns, 'engaged', private.engaged(f.id)))
                       from (select f.*, private.template_for(f.map_id, f.kind, f.asset_id, f.props) as tid from public.features f
                             where f.map_id = p_map_id and f.kind in ('symbol', 'asset')) f
                       left join public.unit_state st on st.feature_id = f.id where f.tid is not null), '{}'::jsonb),
    'engagements', coalesce((select jsonb_agg(to_jsonb(e) - 'map_id' order by e.start_turn) from public.engagements e
                             where e.map_id = p_map_id and e.status = 'active'), '[]'::jsonb),
    'terrain', private.terrain_stats(p_map_id));
end $$;

-- p: id (to edit), name, attacks, ap, range_m, indirect, deleted (true = soft delete, false = restore).
create function public.save_weapon(p_map_id uuid, p jsonb) returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare wid uuid := coalesce(nullif(p ->> 'id', '')::uuid, gen_random_uuid());
begin
  perform private.need_map(p_map_id);
  if exists (select 1 from public.weapon_profiles w where w.id = wid and w.map_id <> p_map_id) then
    raise exception 'weapon is on another map' using errcode = '42501';
  end if;
  insert into public.weapon_profiles (id, map_id, name, attacks, ap, range_m, indirect, deleted_at, anti_air, guidance, accuracy, air_damage, air_shots)
  values (wid, p_map_id, trim(p ->> 'name'), coalesce((p ->> 'attacks')::float8, 100), coalesce((p ->> 'ap')::float8, 10),
          coalesce((p ->> 'range_m')::float8, 3000), coalesce((p ->> 'indirect')::boolean, false),
          case when coalesce((p ->> 'deleted')::boolean, false) then now() end,
          coalesce((p ->> 'anti_air')::boolean, false), coalesce(p ->> 'guidance', 'none'), coalesce((p ->> 'accuracy')::float8, 60),
          coalesce((p ->> 'air_damage')::float8, 50), coalesce((p ->> 'air_shots')::integer, 2))
  on conflict (id) do update set name = excluded.name, attacks = excluded.attacks, ap = excluded.ap, range_m = excluded.range_m,
    indirect = excluded.indirect, deleted_at = case when p ? 'deleted' then excluded.deleted_at else public.weapon_profiles.deleted_at end,
    anti_air = case when p ? 'anti_air' then excluded.anti_air else public.weapon_profiles.anti_air end,
    guidance = case when p ? 'guidance' then excluded.guidance else public.weapon_profiles.guidance end,
    accuracy = case when p ? 'accuracy' then excluded.accuracy else public.weapon_profiles.accuracy end,
    air_damage = case when p ? 'air_damage' then excluded.air_damage else public.weapon_profiles.air_damage end,
    air_shots = case when p ? 'air_shots' then excluded.air_shots else public.weapon_profiles.air_shots end;
  return wid;
end $$;

-- p: id, name, max_strength, armor, category, asset_id or sidc, weapon_ids, deleted.
create function public.save_unit_template(p_map_id uuid, p jsonb) returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  tid uuid := coalesce(nullif(p ->> 'id', '')::uuid, gen_random_uuid());
  asset uuid := nullif(p ->> 'asset_id', '')::uuid;
  wids uuid[] := coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(p -> 'weapon_ids') = 'array' then p -> 'weapon_ids' else '[]' end)::uuid), '{}');
begin
  perform private.need_map(p_map_id);
  if exists (select 1 from public.unit_templates x where x.id = tid and x.map_id <> p_map_id) then
    raise exception 'template is on another map' using errcode = '42501';
  end if;
  if cardinality(wids) > 20 or exists (select 1 from unnest(wids) w where w not in (select x.id from public.weapon_profiles x where x.map_id = p_map_id)) then
    raise exception 'a weapon is not on this map' using errcode = '22023';
  end if;
  if asset is not null and not exists (select 1 from public.assets where id = asset) then
    raise exception 'unknown graphic' using errcode = '22023';
  end if;
  insert into public.unit_templates (id, map_id, name, max_strength, armor, category, asset_id, sidc, weapon_ids, deleted_at, air_capacity, aps)
  values (tid, p_map_id, trim(p ->> 'name'), coalesce((p ->> 'max_strength')::float8, 1000), coalesce((p ->> 'armor')::float8, 0),
          coalesce(p ->> 'category', 'ground'), asset, case when asset is null then nullif(p ->> 'sidc', '') end, wids,
          case when coalesce((p ->> 'deleted')::boolean, false) then now() end,
          coalesce((p ->> 'air_capacity')::integer, 0), coalesce((p ->> 'aps')::float8, 0))
  on conflict (id) do update set name = excluded.name, max_strength = excluded.max_strength, armor = excluded.armor, category = excluded.category,
    asset_id = excluded.asset_id, sidc = excluded.sidc, weapon_ids = excluded.weapon_ids,
    deleted_at = case when p ? 'deleted' then excluded.deleted_at else public.unit_templates.deleted_at end,
    air_capacity = case when p ? 'air_capacity' then excluded.air_capacity else public.unit_templates.air_capacity end,
    aps = case when p ? 'aps' then excluded.aps else public.unit_templates.aps end;
  return tid;
end $$;

-- Save the settings from the current turn on. Earlier turns keep the version they were played with.
-- Only known keys are kept; numbers must be numbers within sane bounds.
create function public.save_combat_settings(p_map_id uuid, p jsonb) returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare
  n integer;
  d jsonb := private.combat_defaults();
  clean jsonb := '{}';
  k text;
  v jsonb;
begin
  perform private.need_map(p_map_id);
  n := private.current_turn_number(p_map_id);
  for k, v in select * from jsonb_each(coalesce(p, '{}')) loop
    continue when not d ? k;
    if jsonb_typeof(d -> k) = 'object' then
      if jsonb_typeof(v) <> 'object' or exists (select 1 from jsonb_each(v) x where not (d -> k) ? x.key or jsonb_typeof(x.value) <> 'number'
                                                   or (x.value #>> '{}')::float8 not between 0 and 1000000) then
        raise exception 'invalid setting %', k using errcode = '22023';
      end if;
      clean := clean || jsonb_build_object(k, (d -> k) || v);
    elsif jsonb_typeof(d -> k) <> jsonb_typeof(v) or (jsonb_typeof(v) = 'number' and (v #>> '{}')::float8 not between 0 and 1000000) then
      raise exception 'invalid setting %', k using errcode = '22023';
    else
      clean := clean || jsonb_build_object(k, v);
    end if;
  end loop;
  insert into public.combat_settings (map_id, from_turn, settings) values (p_map_id, n, private.combat_settings_for(p_map_id, n) || clean)
  on conflict (map_id, from_turn) do update set settings = excluded.settings, updated_at = now();
  perform private.log(p_map_id, private.actor(), 'changed combat settings', 'from turn ' || n);
  return n;
end $$;

-- Owner override of one unit: strength, experience, stationary_turns.
create function public.set_unit_state(p_feature_id uuid, p jsonb) returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  f public.features;
  tp public.unit_templates;
begin
  perform private.need_admin();
  select * into f from public.features where id = p_feature_id;
  if not found then raise exception 'unit not found' using errcode = '42501'; end if;
  select * into tp from public.unit_templates where id = private.template_for(f.map_id, f.kind, f.asset_id, f.props);
  if not found then raise exception 'this unit has no unit template' using errcode = '22023'; end if;
  insert into public.unit_state (feature_id, map_id, strength, experience, stationary_turns)
  values (f.id, f.map_id, least(tp.max_strength, greatest(0, coalesce((p ->> 'strength')::float8, tp.max_strength))),
          greatest(0, coalesce((p ->> 'experience')::integer, 0)), greatest(0, coalesce((p ->> 'stationary_turns')::integer, 0)))
  on conflict (feature_id) do update set
    strength = case when p ? 'strength' then least(tp.max_strength, greatest(0, (p ->> 'strength')::float8)) else public.unit_state.strength end,
    experience = case when p ? 'experience' then greatest(0, (p ->> 'experience')::integer) else public.unit_state.experience end,
    stationary_turns = case when p ? 'stationary_turns' then greatest(0, (p ->> 'stationary_turns')::integer) else public.unit_state.stationary_turns end,
    updated_at = now();
end $$;

create function public.end_engagement(p_id uuid) returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare e public.engagements;
begin
  perform private.need_admin();
  update public.engagements x set status = 'ended', end_reason = 'ended by the owner', ended_turn = private.current_turn_number(x.map_id), updated_at = now()
   where x.id = p_id and x.status = 'active' returning * into e;
  if e.id is not null then perform private.log(e.map_id, private.actor(), 'ended engagement', null); end if;
end $$;

-- ---- terrain ----

-- Share of the campaign area that is urban, forest and open (urban wins where both overlap).
create function private.terrain_stats(p_map_id uuid) returns jsonb
language sql stable set search_path = ''
as $$
  with a as (
    select coalesce((select m.area from public.terrain_meta m where m.map_id = p_map_id),
                    (select extensions.st_multi(extensions.st_envelope(extensions.st_collect(z.geom))) from public.terrain_zones z where z.map_id = p_map_id)) as g
  ),
  parts as (
    select (select extensions.st_union(z.geom) from public.terrain_zones z where z.map_id = p_map_id and z.type = 'urban') as urban,
           (select extensions.st_union(z.geom) from public.terrain_zones z where z.map_id = p_map_id and z.type = 'forest') as forest
  ),
  m as (
    select extensions.st_area(a.g::extensions.geography) / 1e6 as total,
           coalesce(extensions.st_area(extensions.st_intersection(p.urban, a.g)::extensions.geography) / 1e6, 0) as urban,
           coalesce(extensions.st_area(extensions.st_intersection(
             case when p.urban is null then p.forest else extensions.st_difference(p.forest, p.urban) end, a.g)::extensions.geography) / 1e6, 0) as forest
    from a, parts p
  )
  select case when (select g from a) is null then jsonb_build_object('zones', 0) else (
    select jsonb_build_object(
      'zones', (select count(*) from public.terrain_zones z where z.map_id = p_map_id),
      'total_km2', round(m.total::numeric, 1), 'urban_km2', round(m.urban::numeric, 1), 'forest_km2', round(m.forest::numeric, 1),
      'urban_pct', round((100 * m.urban / nullif(m.total, 0))::numeric, 2), 'forest_pct', round((100 * m.forest / nullif(m.total, 0))::numeric, 2),
      'open_pct', round((100 - 100 * (m.urban + m.forest) / nullif(m.total, 0))::numeric, 2),
      'source', (select tm.source from public.terrain_meta tm where tm.map_id = p_map_id),
      'generated_at', (select tm.generated_at from public.terrain_meta tm where tm.map_id = p_map_id))
    from m) end;
$$;

-- Replace the map's terrain. p: {"zones": [{"type": "urban"|"forest", "geometry": GeoJSON}], "area": GeoJSON, "source": text, "options": {}}.
-- Geometry is repaired and reduced to (multi)polygons here, so a bad shape cannot break lookups.
create function public.replace_terrain(p_map_id uuid, p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  z jsonb;
  g extensions.geometry;
begin
  perform private.need_map(p_map_id);
  if jsonb_typeof(p -> 'zones') <> 'array' or jsonb_array_length(p -> 'zones') > 20000 or octet_length(p::text) > 30000000 then
    raise exception 'invalid terrain' using errcode = '22023';
  end if;
  delete from public.terrain_zones where map_id = p_map_id;
  for z in select * from jsonb_array_elements(p -> 'zones') loop
    if z ->> 'type' not in ('urban', 'forest') then raise exception 'unknown terrain type' using errcode = '22023'; end if;
    g := extensions.st_multi(extensions.st_collectionextract(extensions.st_makevalid(
           extensions.st_setsrid(extensions.st_geomfromgeojson((z -> 'geometry')::text), 4326)), 3));
    continue when g is null or extensions.st_isempty(g);
    insert into public.terrain_zones (map_id, type, geom, area_km2)
    values (p_map_id, z ->> 'type', g, extensions.st_area(g::extensions.geography) / 1e6);
  end loop;
  insert into public.terrain_meta (map_id, area, source, options, generated_at)
  values (p_map_id,
          case when p -> 'area' is not null and p -> 'area' <> 'null'::jsonb then extensions.st_multi(extensions.st_collectionextract(extensions.st_makevalid(
                 extensions.st_setsrid(extensions.st_geomfromgeojson((p -> 'area')::text), 4326)), 3)) end,
          left(p ->> 'source', 200), coalesce(p -> 'options', '{}'), now())
  on conflict (map_id) do update set area = excluded.area, source = excluded.source, options = excluded.options, generated_at = now();
  perform private.log(p_map_id, private.actor(), 'generated terrain', left(p ->> 'source', 200));
  return private.terrain_stats(p_map_id);
end $$;

create function private.terrain_json(p_map_id uuid) returns jsonb
language sql stable set search_path = ''
as $$
  select jsonb_build_object('type', 'FeatureCollection', 'features', coalesce((
    select jsonb_agg(jsonb_build_object('type', 'Feature', 'properties', jsonb_build_object('type', z.type, 'area_km2', round(z.area_km2::numeric, 1)),
                                        'geometry', extensions.st_asgeojson(z.geom, 5)::jsonb))
    from public.terrain_zones z where z.map_id = p_map_id), '[]'::jsonb));
$$;

create function public.get_terrain(p_map_id uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$ begin
  perform private.need_map(p_map_id);
  return private.terrain_json(p_map_id) || jsonb_build_object('stats', private.terrain_stats(p_map_id),
    'area', (select extensions.st_asgeojson(m.area, 5)::jsonb from public.terrain_meta m where m.map_id = p_map_id));
end $$;

-- Terrain is common knowledge: every player and viewer of the map may see it.
create function public.get_player_terrain(p_player_id uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare p public.players := private.me(p_player_id);
begin
  if p.id is null then return null; end if;
  return private.terrain_json(p.map_id);
end $$;

create function public.get_shared_terrain(p_token text) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare l public.share_links;
begin
  if p_token is null or char_length(p_token) <> 64 then return null; end if;
  select * into l from public.share_links where token = p_token;
  if not found or l.revoked or (l.expires_at is not null and l.expires_at <= now()) then return null; end if;
  return private.terrain_json(l.map_id);
end $$;

-- ---------------------------------------------------------------------------
-- 7d. Air combat: squadrons, loadouts, missions, admin
-- ---------------------------------------------------------------------------

-- Squadrons a unit can base: its template's air capacity (0 = not an airbase).
create function private.template_capacity(p_map_id uuid, p_kind text, p_asset uuid, p_props jsonb) returns integer
language sql stable set search_path = ''
as $$ select coalesce((select t.air_capacity from public.unit_templates t where t.id = private.template_for(p_map_id, p_kind, p_asset, p_props)), 0); $$;

create function private.base_capacity(f public.features) returns integer
language sql stable set search_path = ''
as $$ select private.template_capacity(f.map_id, f.kind, f.asset_id, f.props); $$;

-- A loadout fits the airframe (hardpoints, payload) and, for a player, uses only researched missiles.
create function private.check_loadout(p public.players, a public.airframes, l jsonb, n integer) returns void
language plpgsql stable set search_path = ''
as $$
declare
  e jsonb;
  w public.air_weapons;
  ti public.tech_items;
  slots integer := 0;
  weight float8 := 0;
  seen uuid[] := '{}';
begin
  if jsonb_typeof(l) <> 'array' or jsonb_array_length(l) > 20 then
    raise exception 'invalid loadout' using errcode = '22023';
  end if;
  for e in select * from jsonb_array_elements(l) loop
    if jsonb_typeof(e -> 'count') <> 'number' or (e ->> 'count')::integer < 1 or (e ->> 'count')::integer > 50 then
      raise exception 'invalid loadout' using errcode = '22023';
    end if;
    select * into w from public.air_weapons x where x.id = nullif(e ->> 'weapon', '')::uuid and x.map_id = a.map_id and x.deleted_at is null;
    if not found or w.id = any (seen) then
      raise exception 'unknown weapon in the loadout' using errcode = '22023';
    end if;
    seen := seen || w.id;
    if p.id is not null and w.tech_item_id is not null then
      select * into ti from public.tech_items x where x.id = w.tech_item_id;
      if found and not private.unlocked(p, ti, n) then
        raise exception '% is not researched yet', w.name using errcode = '42501';
      end if;
    end if;
    slots := slots + w.slots * (e ->> 'count')::integer;
    weight := weight + w.weight * (e ->> 'count')::integer;
  end loop;
  if slots > a.hardpoints then
    raise exception 'that loadout needs % hardpoints; the % has %', slots, a.name, a.hardpoints using errcode = '42501';
  end if;
  if weight > a.max_payload then
    raise exception 'that loadout weighs % kg; the % carries at most % kg', round(weight), a.name, round(a.max_payload) using errcode = '42501';
  end if;
end $$;

-- One mission per squadron per turn: strike (an enemy unit), patrol (a circle), escort (one of your strikes), recon (a point).
create function private.check_mission(p public.players, p_fid uuid, j jsonb, strict boolean) returns void
language plpgsql stable set search_path = ''
as $$
declare
  sq public.squadrons;
  base public.features;
  tgt public.features;
  s jsonb := private.combat_settings_for(p.map_id, private.current_turn_number(p.map_id));
  pos float8[];
  d float8;
  r float8;
  kind text := j ->> 'type';
begin
  select * into sq from public.squadrons x where x.id = p_fid and x.map_id = p.map_id;
  if not found or (strict and sq.owner_player_id is distinct from p.id) then
    raise exception 'that squadron is not yours' using errcode = '42501';
  end if;
  if kind is null or kind not in ('strike', 'patrol', 'escort', 'recon') then
    raise exception 'unknown mission type' using errcode = '22023';
  end if;
  if kind = 'escort' then
    if nullif(j ->> 'escort_of', '') is null or (j ->> 'escort_of')::uuid = p_fid then
      raise exception 'pick the strike to escort' using errcode = '22023';
    end if;
  elsif kind = 'strike' then
    select * into tgt from public.features x where x.id = nullif(j ->> 'target_unit', '')::uuid and x.map_id = p.map_id;
    if not found then raise exception 'pick an enemy unit to strike' using errcode = '22023'; end if;
    pos := private.anchor(tgt.geometry);
    if strict and tgt.owner_player_id = p.id then
      raise exception 'you cannot strike your own unit' using errcode = '42501';
    end if;
    if strict and not exists (select 1 from public.unit_templates x where x.id = private.template_for(tgt.map_id, tgt.kind, tgt.asset_id, tgt.props) and x.category = 'ground') then
      raise exception 'that target cannot be struck (ground units only for now)' using errcode = '42501';
    end if;
    if strict and not exists (select 1 from public.layers l where l.id = tgt.layer_id and l.visible and (p.visible_layers is null or l.id = any (p.visible_layers))) then
      raise exception 'that target is not visible to you' using errcode = '42501';
    end if;
  else
    if not private.valid_pos(j -> 'target') then raise exception 'pick a point on the map' using errcode = '22023'; end if;
    pos := array[(j -> 'target' ->> 0)::float8, (j -> 'target' ->> 1)::float8];
    if kind = 'patrol' and j ? 'radius_m' and not private.num_in(j -> 'radius_m', 1000, (s ->> 'patrol_radius_max_km')::float8 * 1000) then
      raise exception 'a patrol circle is between 1 and % km', (s ->> 'patrol_radius_max_km') using errcode = '22023';
    end if;
  end if;
  if not strict then return; end if;
  if sq.aircraft < 1 then
    raise exception '% has no aircraft left: buy replacements first', sq.name using errcode = '42501';
  end if;
  select * into base from public.features x where x.id = sq.base_feature_id;
  if not found then
    raise exception '% has no base (it was destroyed): ask the owner to rebase it', sq.name using errcode = '42501';
  end if;
  if pos is not null then
    d := private.dist_m(private.anchor(base.geometry), pos);
    r := private.squadron_radius(sq, s);
    if d > r * 1.001 + 1 then
      raise exception '% reaches % km with this loadout; that target is % km from its base', sq.name, round(r / 1000), round(d / 1000) using errcode = '42501';
    end if;
  end if;
end $$;

-- A player sets a squadron's loadout. Free and instant while the turn is open (or between turns).
create function public.set_loadout(p_player_id uuid, p_squadron_id uuid, p_loadout jsonb) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  p public.players := private.me(p_player_id);
  sq public.squadrons;
  a public.airframes;
  t public.turns;
begin
  if p.id is null then raise exception 'not a player on this map' using errcode = '42501'; end if;
  select * into sq from public.squadrons x where x.id = p_squadron_id and x.map_id = p.map_id and x.owner_player_id = p.id for update;
  if not found then raise exception 'that squadron is not yours' using errcode = '42501'; end if;
  t := private.active_turn(p.map_id);
  if t.status = 'locked' then raise exception 'the turn is locked for review' using errcode = 'P0001'; end if;
  select * into a from public.airframes where id = sq.airframe_id;
  perform private.check_loadout(p, a, coalesce(p_loadout, '[]'), private.current_turn_number(p.map_id));
  update public.squadrons set loadout = coalesce(p_loadout, '[]') where id = sq.id returning * into sq;
  return jsonb_build_object('radius_m', private.squadron_radius(sq, private.combat_settings_for(p.map_id, private.current_turn_number(p.map_id))),
                            'weight', private.loadout_weight(sq.loadout));
end $$;

-- ---- owner ----

create function public.get_air_admin(p_map_id uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare s jsonb;
begin
  perform private.need_map(p_map_id);
  s := private.combat_settings_for(p_map_id, private.current_turn_number(p_map_id));
  return jsonb_build_object(
    'airframes', coalesce((select jsonb_agg(to_jsonb(a) - 'map_id' order by a.created_at) from public.airframes a where a.map_id = p_map_id), '[]'::jsonb),
    'families', coalesce((select jsonb_agg(to_jsonb(f) - 'map_id' order by f.sort, f.created_at) from public.air_weapon_families f where f.map_id = p_map_id), '[]'::jsonb),
    'weapons', coalesce((select jsonb_agg((to_jsonb(w) - 'map_id') || jsonb_build_object('research_cost', ti.research_cost, 'release_turn', ti.release_turn)
                                          order by w.tier, w.created_at)
                         from public.air_weapons w left join public.tech_items ti on ti.id = w.tech_item_id where w.map_id = p_map_id), '[]'::jsonb),
    'squadrons', coalesce((select jsonb_agg((to_jsonb(q) - 'map_id') || jsonb_build_object('radius_m', private.squadron_radius(q, s),
                                            'weight', private.loadout_weight(q.loadout)) order by q.created_at)
                           from public.squadrons q where q.map_id = p_map_id), '[]'::jsonb),
    'bases', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'name', coalesce(nullif(f.props ->> 'name', ''), 'Airbase'), 'owner', f.owner_player_id,
                         'capacity', private.base_capacity(f), 'pos', to_jsonb(private.anchor(f.geometry)),
                         'used', (select count(*) from public.squadrons q where q.base_feature_id = f.id)))
                       from public.features f where f.map_id = p_map_id and f.kind in ('symbol', 'asset') and private.base_capacity(f) > 0), '[]'::jsonb));
end $$;

-- p: id, name, hp, hardpoints, max_payload, radius_m, radar_m, signature, ecm, flares, maneuver, gun_accuracy, gun_damage,
-- gun_range_m, squadron_size, cost_per_aircraft, asset_id or sidc, deleted.
create function public.save_airframe(p_map_id uuid, p jsonb) returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  aid uuid := coalesce(nullif(p ->> 'id', '')::uuid, gen_random_uuid());
  r public.airframes;
begin
  perform private.need_map(p_map_id);
  if exists (select 1 from public.airframes x where x.id = aid and x.map_id <> p_map_id) then
    raise exception 'airframe is on another map' using errcode = '42501';
  end if;
  r := jsonb_populate_record(null::public.airframes, (private.pick(p, array['name', 'hp', 'hardpoints', 'max_payload', 'radius_m', 'radar_m', 'signature',
         'ecm', 'flares', 'maneuver', 'gun_accuracy', 'gun_damage', 'gun_range_m', 'squadron_size', 'cost_per_aircraft', 'asset_id', 'sidc'])));
  insert into public.airframes (id, map_id, name, hp, hardpoints, max_payload, radius_m, radar_m, signature, ecm, flares, maneuver,
                                gun_accuracy, gun_damage, gun_range_m, squadron_size, cost_per_aircraft, asset_id, sidc, deleted_at)
  values (aid, p_map_id, trim(r.name), coalesce(r.hp, 100), coalesce(r.hardpoints, 6), coalesce(r.max_payload, 6000), coalesce(r.radius_m, 600000),
          coalesce(r.radar_m, 100000), coalesce(r.signature, 1), coalesce(r.ecm, 20), coalesce(r.flares, 20), coalesce(r.maneuver, 20),
          coalesce(r.gun_accuracy, 40), coalesce(r.gun_damage, 40), coalesce(r.gun_range_m, 1500), coalesce(r.squadron_size, 12),
          coalesce(r.cost_per_aircraft, 10), r.asset_id, case when r.asset_id is null then nullif(r.sidc, '') end,
          case when coalesce((p ->> 'deleted')::boolean, false) then now() end)
  on conflict (id) do update set name = excluded.name, hp = excluded.hp, hardpoints = excluded.hardpoints, max_payload = excluded.max_payload,
    radius_m = excluded.radius_m, radar_m = excluded.radar_m, signature = excluded.signature, ecm = excluded.ecm, flares = excluded.flares,
    maneuver = excluded.maneuver, gun_accuracy = excluded.gun_accuracy, gun_damage = excluded.gun_damage, gun_range_m = excluded.gun_range_m,
    squadron_size = excluded.squadron_size, cost_per_aircraft = excluded.cost_per_aircraft, asset_id = excluded.asset_id, sidc = excluded.sidc,
    deleted_at = case when p ? 'deleted' then excluded.deleted_at else public.airframes.deleted_at end;
  return aid;
end $$;

-- p: id, name, guidance, color, sort, deleted.
create function public.save_air_family(p_map_id uuid, p jsonb) returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare fid uuid := coalesce(nullif(p ->> 'id', '')::uuid, gen_random_uuid());
begin
  perform private.need_map(p_map_id);
  if exists (select 1 from public.air_weapon_families x where x.id = fid and x.map_id <> p_map_id) then
    raise exception 'family is on another map' using errcode = '42501';
  end if;
  insert into public.air_weapon_families (id, map_id, name, guidance, color, sort, deleted_at)
  values (fid, p_map_id, trim(p ->> 'name'), coalesce(p ->> 'guidance', 'radar'), nullif(p ->> 'color', ''), coalesce((p ->> 'sort')::integer, 0),
          case when coalesce((p ->> 'deleted')::boolean, false) then now() end)
  on conflict (id) do update set name = excluded.name, guidance = excluded.guidance, color = excluded.color, sort = excluded.sort,
    deleted_at = case when p ? 'deleted' then excluded.deleted_at else public.air_weapon_families.deleted_at end;
  return fid;
end $$;

-- The four standard families, for a quick start. Does nothing if the map already has families.
create function public.seed_air_families(p_map_id uuid) returns integer
language plpgsql volatile security definer set search_path = ''
as $$ begin
  perform private.need_map(p_map_id);
  if exists (select 1 from public.air_weapon_families where map_id = p_map_id) then return 0; end if;
  insert into public.air_weapon_families (map_id, name, guidance, color, sort) values
    (p_map_id, 'IR', 'ir', '#ff9f0a', 0), (p_map_id, 'ARH', 'radar', '#0a84ff', 1),
    (p_map_id, 'HARM', 'harm', '#bf5af2', 2), (p_map_id, 'AGM', 'agm', '#30d158', 3);
  return 4;
end $$;

-- A missile tier. Its research node in the tech tree is created and kept in step here: same name,
-- research cost and release turn, and it requires the tier below in the same family.
-- p: id, family_id, tier, name, guidance, accuracy, range_m, damage, ap, weight, slots, targets, research_cost, release_turn, deleted.
create function public.save_air_weapon(p_map_id uuid, p jsonb) returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  wid uuid := coalesce(nullif(p ->> 'id', '')::uuid, gen_random_uuid());
  w public.air_weapons;
  fam public.air_weapon_families;
  prev uuid;
  tid uuid;
  tg text[] := coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(p -> 'targets') = 'array' then p -> 'targets' else '["air"]' end)), '{air}');
begin
  perform private.need_map(p_map_id);
  select * into fam from public.air_weapon_families x where x.id = nullif(p ->> 'family_id', '')::uuid and x.map_id = p_map_id;
  if not found then raise exception 'pick a weapon family' using errcode = '22023'; end if;
  if exists (select 1 from public.air_weapons x where x.id = wid and x.map_id <> p_map_id) then
    raise exception 'weapon is on another map' using errcode = '42501';
  end if;
  if exists (select 1 from unnest(tg) x where x not in ('air', 'ground', 'ship', 'radar')) or cardinality(tg) = 0 then
    raise exception 'targets are air, ground, ship or radar' using errcode = '22023';
  end if;
  insert into public.air_weapons (id, map_id, family_id, tier, name, guidance, accuracy, range_m, damage, ap, weight, slots, targets, deleted_at)
  values (wid, p_map_id, fam.id, coalesce((p ->> 'tier')::integer, 1), trim(p ->> 'name'), coalesce(p ->> 'guidance', fam.guidance),
          coalesce((p ->> 'accuracy')::float8, 70), coalesce((p ->> 'range_m')::float8, 50000), coalesce((p ->> 'damage')::float8, 100),
          coalesce((p ->> 'ap')::float8, 10), coalesce((p ->> 'weight')::float8, 150), coalesce((p ->> 'slots')::integer, 1), tg,
          case when coalesce((p ->> 'deleted')::boolean, false) then now() end)
  on conflict (id) do update set family_id = excluded.family_id, tier = excluded.tier, name = excluded.name, guidance = excluded.guidance,
    accuracy = excluded.accuracy, range_m = excluded.range_m, damage = excluded.damage, ap = excluded.ap, weight = excluded.weight,
    slots = excluded.slots, targets = excluded.targets,
    deleted_at = case when p ? 'deleted' then excluded.deleted_at else public.air_weapons.deleted_at end
  returning * into w;

  if w.deleted_at is not null then
    -- A deleted missile leaves the tech tree (and loadouts); restoring it puts a fresh node back.
    if w.tech_item_id is not null then
      perform public.delete_tech_item(w.tech_item_id);
      update public.air_weapons set tech_item_id = null where id = w.id;
    end if;
    update public.squadrons q set loadout = coalesce((select jsonb_agg(l) from jsonb_array_elements(q.loadout) l where l ->> 'weapon' <> w.id::text), '[]')
     where q.map_id = p_map_id and q.loadout @> jsonb_build_array(jsonb_build_object('weapon', w.id::text));
    return w.id;
  end if;

  select x.tech_item_id into prev from public.air_weapons x
   where x.family_id = w.family_id and x.tier = w.tier - 1 and x.deleted_at is null and x.tech_item_id is not null order by x.created_at limit 1;
  tid := coalesce(w.tech_item_id, gen_random_uuid());
  insert into public.tech_items (id, map_id, name, description, tier, sort, research_cost, spawn_cost, prereqs, buyable, category,
                                 release_turn, pos_x, pos_y)
  values (tid, p_map_id, w.name, fam.name || ' missile, tier ' || w.tier, w.tier, 0, coalesce((p ->> 'research_cost')::integer, case when w.tier = 1 then 0 else 10 end),
          0, case when prev is null then '{}' else array[prev] end, false, 'weapon', (p ->> 'release_turn')::integer,
          1400 + fam.sort * 260, (w.tier - 1) * 200)
  on conflict (id) do update set name = excluded.name, description = excluded.description, tier = excluded.tier,
    research_cost = case when p ? 'research_cost' then excluded.research_cost else public.tech_items.research_cost end,
    release_turn = case when p ? 'release_turn' then excluded.release_turn else public.tech_items.release_turn end,
    -- Keep any extra prerequisites the owner added; the family link always points at the tier below.
    prereqs = (select coalesce(array_agg(x), '{}') from unnest(public.tech_items.prereqs) x
               where x not in (select y.tech_item_id from public.air_weapons y where y.family_id = w.family_id and y.tech_item_id is not null))
              || case when prev is null then '{}'::uuid[] else array[prev] end;
  update public.air_weapons set tech_item_id = tid where id = w.id and tech_item_id is distinct from tid;
  -- The tier above now requires this one.
  update public.tech_items ti set prereqs = (select coalesce(array_agg(x), '{}') from unnest(ti.prereqs) x
                                              where x not in (select y.tech_item_id from public.air_weapons y where y.family_id = w.family_id and y.tech_item_id is not null)) || tid
   from public.air_weapons up where up.family_id = w.family_id and up.tier = w.tier + 1 and up.deleted_at is null and ti.id = up.tech_item_id;
  return w.id;
end $$;

-- p: id, name, owner_player_id, airframe_id, base_feature_id, aircraft, max_aircraft, damage, loadout. The owner's loadouts skip research checks.
create function public.save_squadron(p_map_id uuid, p jsonb) returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  qid uuid := coalesce(nullif(p ->> 'id', '')::uuid, gen_random_uuid());
  a public.airframes;
  base public.features;
  owner uuid := nullif(p ->> 'owner_player_id', '')::uuid;
begin
  perform private.need_map(p_map_id);
  if exists (select 1 from public.squadrons x where x.id = qid and x.map_id <> p_map_id) then
    raise exception 'squadron is on another map' using errcode = '42501';
  end if;
  select * into a from public.airframes x where x.id = nullif(p ->> 'airframe_id', '')::uuid and x.map_id = p_map_id;
  if not found then raise exception 'pick an airframe' using errcode = '22023'; end if;
  if owner is not null and not exists (select 1 from public.players x where x.id = owner and x.map_id = p_map_id) then
    raise exception 'player is not on this map' using errcode = '22023';
  end if;
  if nullif(p ->> 'base_feature_id', '') is not null then
    select * into base from public.features x where x.id = (p ->> 'base_feature_id')::uuid and x.map_id = p_map_id;
    if not found or private.base_capacity(base) <= 0 then
      raise exception 'that unit is not an airbase (give its unit template an air capacity)' using errcode = '22023';
    end if;
  end if;
  perform private.check_loadout(null, a, coalesce(p -> 'loadout', '[]'), null);
  insert into public.squadrons (id, map_id, owner_player_id, name, airframe_id, base_feature_id, aircraft, max_aircraft, damage, loadout)
  values (qid, p_map_id, owner, trim(p ->> 'name'), a.id, base.id, greatest(0, coalesce((p ->> 'aircraft')::integer, a.squadron_size)),
          greatest(1, coalesce((p ->> 'max_aircraft')::integer, a.squadron_size)), greatest(0, coalesce((p ->> 'damage')::float8, 0)),
          coalesce(p -> 'loadout', '[]'))
  on conflict (id) do update set name = excluded.name, owner_player_id = excluded.owner_player_id, airframe_id = excluded.airframe_id,
    base_feature_id = excluded.base_feature_id, aircraft = least(excluded.aircraft, excluded.max_aircraft), max_aircraft = excluded.max_aircraft,
    damage = excluded.damage, loadout = excluded.loadout;
  return qid;
end $$;

create function public.delete_squadron(p_id uuid) returns void
language plpgsql volatile security definer set search_path = ''
as $$ begin
  perform private.need_admin();
  delete from public.squadrons where id = p_id;
end $$;


-- The air part of one player's combat report: their squadrons' losses, enemy aircraft they downed,
-- their strikes, and what their recon saw (exact, as of after this turn's fighting).
create function private.air_report(t public.turns, pl public.players, res jsonb, s jsonb) returns jsonb
language sql stable set search_path = ''
as $$
  select jsonb_build_object(
    'squadrons', coalesce((select jsonb_agg(jsonb_build_object('name', x ->> 'name', 'mission', x ->> 'mission', 'before', x -> 'before', 'after', x -> 'after', 'lost', x -> 'lost'))
                           from jsonb_array_elements(coalesce(res -> 'air' -> 'squadrons', '[]')) x
                           where x ->> 'owner' = pl.id::text and (x ->> 'mission' is not null or (x ->> 'lost')::integer > 0)), '[]'::jsonb),
    'downed', coalesce((select sum((k ->> 'count')::integer) from jsonb_array_elements(coalesce(res -> 'air' -> 'kills', '[]')) k where k ->> 'owner' = pl.id::text), 0),
    'strikes', coalesce((select jsonb_agg(jsonb_build_object('squadron', x ->> 'squadron_name', 'target', x ->> 'target_name', 'hits', x -> 'hits',
                           'shots', x -> 'shots', 'damage', x -> 'damage', 'destroyed', x -> 'destroyed', 'aborted', x ->> 'aborted'))
                         from jsonb_array_elements(coalesce(res -> 'air' -> 'strikes', '[]')) x where x ->> 'owner' = pl.id::text), '[]'::jsonb),
    'recon', coalesce((select jsonb_agg(jsonb_build_object('squadron', r ->> 'squadron_name', 'center', r -> 'center', 'radius_m', r -> 'radius_m',
                         'units', (select coalesce(jsonb_agg(jsonb_build_object('name', coalesce(nullif(f.props ->> 'name', ''), tp.name), 'type', tp.name,
                                      'strength', round(coalesce(st.strength, tp.max_strength)), 'max', tp.max_strength)), '[]'::jsonb)
                                   from public.features f
                                   join public.unit_templates tp on tp.id = private.template_for(f.map_id, f.kind, f.asset_id, f.props)
                                   left join public.unit_state st on st.feature_id = f.id
                                   where f.map_id = t.map_id and f.owner_player_id is distinct from pl.id
                                     and private.dist_m(private.anchor(f.geometry), array[(r -> 'center' ->> 0)::float8, (r -> 'center' ->> 1)::float8]) <= (r ->> 'radius_m')::float8),
                         'squadrons', (select coalesce(jsonb_agg(jsonb_build_object('name', q.name, 'airframe', a.name, 'aircraft', q.aircraft, 'max', q.max_aircraft)), '[]'::jsonb)
                                       from public.squadrons q join public.airframes a on a.id = q.airframe_id join public.features b on b.id = q.base_feature_id
                                       where q.map_id = t.map_id and q.owner_player_id is distinct from pl.id
                                         and private.dist_m(private.anchor(b.geometry), array[(r -> 'center' ->> 0)::float8, (r -> 'center' ->> 1)::float8]) <= (r ->> 'radius_m')::float8)))
                       from jsonb_array_elements(coalesce(res -> 'air' -> 'reveals', '[]')) r where r ->> 'owner' = pl.id::text), '[]'::jsonb));
$$;

-- Air state for one player: own squadrons and bases in full; missiles they can see in the tree (fit data
-- only: range, weight, slots, guidance, targets; never accuracy or damage); enemy squadrons at bases within
-- intel range as bands; and what last turn's recon revealed, exact, until the next push.
create function private.player_air(p public.players) returns jsonb
language sql stable set search_path = ''
as $$
  with s as (select private.combat_settings_for(p.map_id, private.current_turn_number(p.map_id)) as v),
  n as (select private.current_turn_number(p.map_id) as v),
  mine as (select private.anchor(f.geometry) as pos from public.features f where f.map_id = p.map_id and f.owner_player_id = p.id),
  rev as (select r.* from public.air_reveals r where r.player_id = p.id
            and r.turn_number = (select max(x.number) from public.turns x where x.map_id = p.map_id and x.status = 'pushed'))
  select jsonb_build_object(
    'squadrons', coalesce((select jsonb_agg(jsonb_build_object(
        'id', q.id, 'name', q.name, 'aircraft', q.aircraft, 'max', q.max_aircraft, 'damage', q.damage, 'loadout', q.loadout,
        'base', q.base_feature_id, 'base_name', (select coalesce(nullif(b.props ->> 'name', ''), 'Airbase') from public.features b where b.id = q.base_feature_id),
        'base_pos', (select to_jsonb(private.anchor(b.geometry)) from public.features b where b.id = q.base_feature_id),
        'radius_m', private.squadron_radius(q, (select v from s)), 'weight', private.loadout_weight(q.loadout),
        'airframe', jsonb_build_object('id', a.id, 'name', a.name, 'hp', a.hp, 'hardpoints', a.hardpoints, 'max_payload', a.max_payload,
                      'radius_m', a.radius_m, 'radar_m', a.radar_m, 'cost_per_aircraft', a.cost_per_aircraft, 'sidc', a.sidc, 'asset_id', a.asset_id))
        order by q.created_at)
      from public.squadrons q join public.airframes a on a.id = q.airframe_id where q.map_id = p.map_id and q.owner_player_id = p.id), '[]'::jsonb),
    'weapons', coalesce((select jsonb_agg(jsonb_build_object('id', w.id, 'name', w.name, 'family', fam.name, 'family_color', fam.color, 'tier', w.tier,
                           'guidance', w.guidance, 'range_m', w.range_m, 'weight', w.weight, 'slots', w.slots, 'targets', to_jsonb(w.targets),
                           'tech_item', w.tech_item_id, 'unlocked', ti.id is null or private.unlocked(p, ti, (select v from n)))
                           order by fam.sort, w.tier)
      from public.air_weapons w join public.air_weapon_families fam on fam.id = w.family_id and fam.deleted_at is null
      left join public.tech_items ti on ti.id = w.tech_item_id
      where w.map_id = p.map_id and w.deleted_at is null and (ti.id is null or private.released(ti, (select v from n)))), '[]'::jsonb),
    'bases', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'name', coalesce(nullif(f.props ->> 'name', ''), 'Airbase'),
                         'capacity', private.base_capacity(f), 'used', (select count(*) from public.squadrons q where q.base_feature_id = f.id),
                         'pos', to_jsonb(private.anchor(f.geometry))))
      from public.features f where f.map_id = p.map_id and f.owner_player_id = p.id and f.kind in ('symbol', 'asset') and private.base_capacity(f) > 0), '[]'::jsonb),
    'radius_penalty', (select (v ->> 'radius_penalty')::float8 from s),
    'patrol_radius_km', (select (v ->> 'patrol_radius_km')::float8 from s),
    'patrol_radius_max_km', (select (v ->> 'patrol_radius_max_km')::float8 from s),
    'recon_radius_km', (select (v ->> 'recon_radius_km')::float8 from s),
    'enemy_bases', coalesce((select jsonb_agg(jsonb_build_object('base', b.id, 'squadrons', (
        select jsonb_agg(private.band(q.aircraft::float8 / q.max_aircraft, (select v from s))) from public.squadrons q where q.base_feature_id = b.id)))
      from public.features b
      where b.map_id = p.map_id and b.owner_player_id is distinct from p.id
        and exists (select 1 from public.squadrons q where q.base_feature_id = b.id)
        and exists (select 1 from public.layers l where l.id = b.layer_id and l.visible and (p.visible_layers is null or l.id = any (p.visible_layers)))
        and exists (select 1 from mine m where private.dist_m(m.pos, private.anchor(b.geometry)) <= (select (v ->> 'intel_km')::float8 * 1000 from s))), '[]'::jsonb),
    'reveals', coalesce((select jsonb_agg(jsonb_build_object('center', to_jsonb(r.center), 'radius_m', r.radius_m)) from rev r), '[]'::jsonb),
    -- Exact stats of other units inside last turn's recon circles.
    'revealed', coalesce((select jsonb_object_agg(f.id, jsonb_build_object('type', tp.name, 'strength', round(coalesce(st.strength, tp.max_strength)), 'max', tp.max_strength))
      from public.features f
      join public.unit_templates tp on tp.id = private.template_for(f.map_id, f.kind, f.asset_id, f.props)
      left join public.unit_state st on st.feature_id = f.id
      where f.map_id = p.map_id and f.owner_player_id is distinct from p.id
        and exists (select 1 from rev r where private.dist_m(private.anchor(f.geometry), r.center) <= r.radius_m)), '{}'::jsonb),
    'revealed_squadrons', coalesce((select jsonb_agg(jsonb_build_object('base', q.base_feature_id, 'name', q.name, 'airframe', a.name, 'aircraft', q.aircraft, 'max', q.max_aircraft))
      from public.squadrons q join public.airframes a on a.id = q.airframe_id join public.features b on b.id = q.base_feature_id
      where q.map_id = p.map_id and q.owner_player_id is distinct from p.id
        and exists (select 1 from rev r where private.dist_m(private.anchor(b.geometry), r.center) <= r.radius_m)), '[]'::jsonb),
    -- Squadron-buying items this player can see (the tree decides price and research).
    'squadron_items', coalesce((select jsonb_agg(jsonb_build_object('id', ti.id, 'name', ti.name, 'spawn_cost', ti.spawn_cost, 'airframe', a.name,
                                 'size', a.squadron_size, 'unlocked', private.unlocked(p, ti, (select v from n))))
      from public.tech_items ti join public.airframes a on a.id = ti.airframe_id
      where ti.map_id = p.map_id and ti.category = 'squadron' and ti.buyable and private.released(ti, (select v from n))), '[]'::jsonb));
$$;

-- ---------------------------------------------------------------------------
-- 8. History, rollback, backup
-- ---------------------------------------------------------------------------

-- Any past turn, unfiltered. Admins only.
create function public.get_snapshot(p_map_id uuid, p_turn integer) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$ begin
  perform private.need_map(p_map_id);
  return (select private.filter_snapshot(s.payload, null, true) || jsonb_build_object('viewing', s.turn_number)
            from public.snapshots s where s.map_id = p_map_id and s.turn_number = p_turn);
end $$;

-- Put the map back to how it was after turn p_turn and open a new turn from there. Nothing is
-- erased: later snapshots stay in the history, and drafts of the abandoned turn are kept with it.
create function public.rollback_to(p_map_id uuid, p_turn integer) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  s public.snapshots;
  t public.turns;
  n integer;
  tid uuid;
begin
  perform private.need_map(p_map_id);
  select * into s from public.snapshots where map_id = p_map_id and turn_number = p_turn;
  if not found then raise exception 'no snapshot for turn %', p_turn using errcode = '22023'; end if;
  select * into t from public.turns where map_id = p_map_id and status in ('open', 'locked') for update;
  if found then
    update public.turns set status = 'rolled_back' where id = t.id;
  end if;
  perform private.restore_snapshot(p_map_id, s.payload);
  select greatest(coalesce((select max(number) from public.turns where map_id = p_map_id), 0),
                  (select max(turn_number) from public.snapshots where map_id = p_map_id)) + 1 into n;
  insert into public.turns (map_id, number, default_radius_m, conflict_m, carry_allocations, rollback_of)
  values (p_map_id, n, t.default_radius_m, t.conflict_m, coalesce(t.carry_allocations, false), p_turn) returning id into tid;
  perform private.log(p_map_id, private.actor(), 'rolled back', 'to turn ' || p_turn || '; turn ' || n || ' opened');
  return jsonb_build_object('turn', n, 'rollback_of', p_turn);
end $$;

-- Whole campaign as one JSON document. Holds invite and share tokens, so treat the file like a password.
create function public.export_campaign(p_map_id uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$ begin
  perform private.need_map(p_map_id);
  return jsonb_build_object(
    'format', 'tacmap-campaign', 'version', 1, 'schema', private.schema_version(), 'exported_at', now(),
    'map', (select to_jsonb(m) from public.maps m where m.id = p_map_id),
    'layers', coalesce((select jsonb_agg(to_jsonb(x)) from public.layers x where x.map_id = p_map_id), '[]'::jsonb),
    'assets', coalesce((select jsonb_agg(to_jsonb(x)) from public.assets x), '[]'::jsonb),
    'players', coalesce((select jsonb_agg(to_jsonb(x) - 'auth_uid' - 'pin_set') from public.players x where x.map_id = p_map_id), '[]'::jsonb),
    'features', coalesce((select jsonb_agg(to_jsonb(x)) from public.features x where x.map_id = p_map_id), '[]'::jsonb),
    'turns', coalesce((select jsonb_agg(to_jsonb(x)) from public.turns x where x.map_id = p_map_id), '[]'::jsonb),
    'rules', coalesce((select jsonb_agg(to_jsonb(x)) from public.turn_move_rules x join public.turns t on t.id = x.turn_id where t.map_id = p_map_id), '[]'::jsonb),
    'allocations', coalesce((select jsonb_agg(to_jsonb(x)) from public.allocations x join public.turns t on t.id = x.turn_id where t.map_id = p_map_id), '[]'::jsonb),
    'drafts', coalesce((select jsonb_agg(to_jsonb(x)) from public.drafts x join public.turns t on t.id = x.turn_id where t.map_id = p_map_id), '[]'::jsonb),
    'snapshots', coalesce((select jsonb_agg(to_jsonb(x)) from public.snapshots x where x.map_id = p_map_id), '[]'::jsonb),
    'share_links', coalesce((select jsonb_agg(to_jsonb(x)) from public.share_links x where x.map_id = p_map_id), '[]'::jsonb),
    'tech_items', coalesce((select jsonb_agg(to_jsonb(x)) from public.tech_items x where x.map_id = p_map_id), '[]'::jsonb),
    'spawn_zones', coalesce((select jsonb_agg(to_jsonb(x)) from public.spawn_zones x where x.map_id = p_map_id), '[]'::jsonb),
    'weapon_profiles', coalesce((select jsonb_agg(to_jsonb(x)) from public.weapon_profiles x where x.map_id = p_map_id), '[]'::jsonb),
    'unit_templates', coalesce((select jsonb_agg(to_jsonb(x)) from public.unit_templates x where x.map_id = p_map_id), '[]'::jsonb),
    'unit_state', coalesce((select jsonb_agg(to_jsonb(x)) from public.unit_state x where x.map_id = p_map_id), '[]'::jsonb),
    'engagements', coalesce((select jsonb_agg(to_jsonb(x)) from public.engagements x where x.map_id = p_map_id), '[]'::jsonb),
    'combat_settings', coalesce((select jsonb_agg(to_jsonb(x)) from public.combat_settings x where x.map_id = p_map_id), '[]'::jsonb),
    'combat_reports', coalesce((select jsonb_agg(to_jsonb(x)) from public.combat_reports x where x.map_id = p_map_id), '[]'::jsonb),
    'terrain', private.terrain_json(p_map_id),
    'airframes', coalesce((select jsonb_agg(to_jsonb(x)) from public.airframes x where x.map_id = p_map_id), '[]'::jsonb),
    'air_weapon_families', coalesce((select jsonb_agg(to_jsonb(x)) from public.air_weapon_families x where x.map_id = p_map_id), '[]'::jsonb),
    'air_weapons', coalesce((select jsonb_agg(to_jsonb(x)) from public.air_weapons x where x.map_id = p_map_id), '[]'::jsonb),
    'squadrons', coalesce((select jsonb_agg(to_jsonb(x)) from public.squadrons x where x.map_id = p_map_id), '[]'::jsonb),
    'terrain_meta', (select jsonb_build_object('area', extensions.st_asgeojson(m.area)::jsonb, 'source', m.source, 'options', m.options)
                     from public.terrain_meta m where m.map_id = p_map_id));
end $$;

-- Restore a backup under its original ids, so existing invite and share links keep working.
-- If the map already exists it is only replaced when p_replace is true.
create function public.import_campaign(p jsonb, p_replace boolean default false) returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare mid uuid;
begin
  perform private.need_admin();
  if p ->> 'format' is distinct from 'tacmap-campaign' or (p ->> 'version')::integer <> 1 then
    raise exception 'this file is not a Tacmap campaign backup' using errcode = '22023';
  end if;
  if (p ->> 'schema')::integer > private.schema_version() then
    raise exception 'this backup comes from a newer version: re-run setup.sql first' using errcode = 'P0001';
  end if;
  mid := (p -> 'map' ->> 'id')::uuid;
  if exists (select 1 from public.maps where id = mid) then
    if not p_replace then
      raise exception 'this campaign already exists here' using errcode = '23505';
    end if;
    delete from public.maps where id = mid;
  end if;

  insert into public.maps select * from jsonb_populate_record(null::public.maps, (p -> 'map') || jsonb_build_object('owner_id', (select auth.uid())));
  insert into public.assets
    select * from jsonb_populate_recordset(null::public.assets, (select coalesce(jsonb_agg(e - 'owner_id'), '[]'::jsonb) from jsonb_array_elements(p -> 'assets') e))
    on conflict do nothing;
  insert into public.layers select * from jsonb_populate_recordset(null::public.layers, p -> 'layers');
  insert into public.players (id, map_id, name, team, color, invite_token, visible_layers, target_layer_id, revoked, claimed_at, created_at, pin_salt, pin_hash,
                              spawn_points, research_points, tech_unlocked)
    select id, map_id, name, team, color, invite_token, visible_layers, target_layer_id, revoked, claimed_at, created_at, pin_salt, pin_hash,
           coalesce(spawn_points, 0), coalesce(research_points, 0), coalesce(tech_unlocked, '{}')
    from jsonb_populate_recordset(null::public.players, (select coalesce(jsonb_agg(e - 'pin_set'), '[]'::jsonb) from jsonb_array_elements(p -> 'players') e));
  insert into public.features
    select * from jsonb_populate_recordset(null::public.features, (
      select coalesce(jsonb_agg(case when exists (select 1 from public.assets a where a.id::text = e ->> 'asset_id') then e else e - 'asset_id' end), '[]'::jsonb)
      from jsonb_array_elements(p -> 'features') e));
  insert into public.turns select * from jsonb_populate_recordset(null::public.turns, p -> 'turns');
  insert into public.turn_move_rules select * from jsonb_populate_recordset(null::public.turn_move_rules, p -> 'rules');
  insert into public.allocations select * from jsonb_populate_recordset(null::public.allocations, p -> 'allocations');
  insert into public.drafts select * from jsonb_populate_recordset(null::public.drafts, p -> 'drafts');
  insert into public.snapshots select * from jsonb_populate_recordset(null::public.snapshots, p -> 'snapshots');
  insert into public.share_links select * from jsonb_populate_recordset(null::public.share_links, p -> 'share_links');
  -- Backups from before schema 4 have no tech tree.
  insert into public.tech_items select * from jsonb_populate_recordset(null::public.tech_items, coalesce(p -> 'tech_items', '[]'));
  insert into public.spawn_zones select * from jsonb_populate_recordset(null::public.spawn_zones, coalesce(p -> 'spawn_zones', '[]'));
  -- Backups from before schema 8 have no combat data.
  insert into public.weapon_profiles select * from jsonb_populate_recordset(null::public.weapon_profiles, coalesce(p -> 'weapon_profiles', '[]'));
  insert into public.unit_templates
    select * from jsonb_populate_recordset(null::public.unit_templates, (
      select coalesce(jsonb_agg(case when exists (select 1 from public.assets a where a.id::text = e ->> 'asset_id') then e else e - 'asset_id' end), '[]'::jsonb)
      from jsonb_array_elements(coalesce(p -> 'unit_templates', '[]')) e));
  insert into public.unit_state select * from jsonb_populate_recordset(null::public.unit_state, coalesce(p -> 'unit_state', '[]'))
    where feature_id in (select id from public.features where map_id = mid);
  insert into public.engagements select * from jsonb_populate_recordset(null::public.engagements, coalesce(p -> 'engagements', '[]'));
  insert into public.combat_settings select * from jsonb_populate_recordset(null::public.combat_settings, coalesce(p -> 'combat_settings', '[]'));
  insert into public.combat_reports select * from jsonb_populate_recordset(null::public.combat_reports, coalesce(p -> 'combat_reports', '[]'))
    where player_id in (select id from public.players where map_id = mid);
  -- Backups from before schema 10 have no air data.
  insert into public.airframes
    select * from jsonb_populate_recordset(null::public.airframes, (
      select coalesce(jsonb_agg(case when exists (select 1 from public.assets a where a.id::text = e ->> 'asset_id') then e else e - 'asset_id' end), '[]'::jsonb)
      from jsonb_array_elements(coalesce(p -> 'airframes', '[]')) e));
  insert into public.air_weapon_families select * from jsonb_populate_recordset(null::public.air_weapon_families, coalesce(p -> 'air_weapon_families', '[]'));
  insert into public.air_weapons select * from jsonb_populate_recordset(null::public.air_weapons, coalesce(p -> 'air_weapons', '[]'));
  insert into public.squadrons
    select * from jsonb_populate_recordset(null::public.squadrons, (
      select coalesce(jsonb_agg(case when exists (select 1 from public.features f where f.id::text = e ->> 'base_feature_id') then e else e - 'base_feature_id' end), '[]'::jsonb)
      from jsonb_array_elements(coalesce(p -> 'squadrons', '[]')) e));
  insert into public.terrain_zones (map_id, type, geom, area_km2)
    select mid, f -> 'properties' ->> 'type', extensions.st_multi(extensions.st_setsrid(extensions.st_geomfromgeojson((f -> 'geometry')::text), 4326)),
           coalesce((f -> 'properties' ->> 'area_km2')::float8, 0)
    from jsonb_array_elements(coalesce(p -> 'terrain' -> 'features', '[]')) f;
  if p -> 'terrain_meta' is not null and p -> 'terrain_meta' <> 'null'::jsonb then
    insert into public.terrain_meta (map_id, area, source, options)
    values (mid, case when p -> 'terrain_meta' -> 'area' <> 'null'::jsonb
                   then extensions.st_multi(extensions.st_setsrid(extensions.st_geomfromgeojson((p -> 'terrain_meta' -> 'area')::text), 4326)) end,
            p -> 'terrain_meta' ->> 'source', coalesce(p -> 'terrain_meta' -> 'options', '{}'));
  end if;
  -- Everything above must belong to the one map in the file.
  if exists (select 1 from jsonb_array_elements(p -> 'layers' || p -> 'players' || p -> 'features' || p -> 'turns' || p -> 'snapshots' || p -> 'share_links'
                                                || coalesce(p -> 'tech_items', '[]') || coalesce(p -> 'spawn_zones', '[]')
                                                || coalesce(p -> 'weapon_profiles', '[]') || coalesce(p -> 'unit_templates', '[]')
                                                || coalesce(p -> 'engagements', '[]') || coalesce(p -> 'combat_settings', '[]')
                                                || coalesce(p -> 'airframes', '[]') || coalesce(p -> 'air_weapon_families', '[]')
                                                || coalesce(p -> 'air_weapons', '[]') || coalesce(p -> 'squadrons', '[]')) e
                 where e ->> 'map_id' is distinct from mid::text)
     or exists (select 1 from jsonb_array_elements(p -> 'rules' || p -> 'allocations' || p -> 'drafts') e
                 where (e ->> 'turn_id')::uuid not in (select id from public.turns where map_id = mid)) then
    raise exception 'backup file is inconsistent' using errcode = '22023';
  end if;
  perform private.log(mid, private.actor(), 'restored backup', p ->> 'exported_at');
  return mid;
end $$;

-- ---------------------------------------------------------------------------
-- 9. Player and viewer RPCs
-- ---------------------------------------------------------------------------

-- Bind the calling session to an invite. The link is the credential: opening it on another device
-- moves the seat there. With a PIN set, the link alone is not enough, and five wrong tries lock the
-- seat for 15 minutes. Failures are returned, not raised, so the failure counter is not rolled back.
create function public.claim_invite(p_token text, p_pin text default null) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  p public.players;
  uid uuid := (select auth.uid());
begin
  if uid is null or p_token is null or char_length(p_token) <> 64 then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  select * into p from public.players where invite_token = p_token for update;
  if not found or p.revoked then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  if p.auth_uid is distinct from uid then
    if p.pin_locked_until is not null and p.pin_locked_until > now() then
      return jsonb_build_object('ok', false, 'reason', 'locked', 'until', p.pin_locked_until);
    end if;
    if p.pin_hash is not null then
      if p_pin is null then
        return jsonb_build_object('ok', false, 'reason', 'pin_required');
      end if;
      if private.pin_hash(p.pin_salt, p_pin) <> p.pin_hash then
        if p.pin_failures + 1 >= 5 then
          update public.players set pin_failures = 0, pin_locked_until = now() + interval '15 minutes' where id = p.id;
          perform private.log(p.map_id, p.name, 'PIN lockout', '5 wrong tries');
          return jsonb_build_object('ok', false, 'reason', 'locked', 'until', now() + interval '15 minutes');
        end if;
        update public.players set pin_failures = pin_failures + 1 where id = p.id;
        return jsonb_build_object('ok', false, 'reason', 'wrong_pin', 'left', 4 - p.pin_failures);
      end if;
    end if;
    -- One seat per browser per map: taking this one lets go of any other.
    update public.players set auth_uid = null where map_id = p.map_id and auth_uid = uid;
    update public.players set auth_uid = uid, claimed_at = coalesce(claimed_at, now()), last_seen_at = now(),
           pin_failures = 0, pin_locked_until = null where id = p.id;
    perform private.log(p.map_id, p.name, case when p.auth_uid is null then 'joined' else 'opened on another device' end);
  end if;
  return jsonb_build_object('ok', true, 'player_id', p.id);
end $$;

create function private.me(p_player_id uuid) returns public.players
language sql stable set search_path = ''
as $$
  select p from public.players p
  where p.id = p_player_id and p.auth_uid = (select auth.uid()) and (select auth.uid()) is not null and not p.revoked;
$$;

-- Everything the player page needs, in one call. Null when the session no longer holds this seat.
create function public.get_player_state(p_player_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  p public.players := private.me(p_player_id);
  m public.maps;
  t public.turns;
  n integer;   -- the turn tech releases are judged against: the open one, else the next one
begin
  if p.id is null then return null; end if;
  if p.last_seen_at is null or p.last_seen_at < now() - interval '1 minute' then
    update public.players set last_seen_at = now() where id = p.id;
  end if;
  select * into m from public.maps where id = p.map_id;
  t := private.active_turn(p.map_id);
  n := coalesce(t.number, (select max(x.number) + 1 from public.turns x where x.map_id = p.map_id), 1);

  return private.build_payload(p.map_id, p.visible_layers) || jsonb_build_object(
    'player', jsonb_build_object('id', p.id, 'name', p.name, 'team', p.team, 'color', p.color),
    'channel', m.live_channel,
    'server_time', now(),
    'turn', private.turn_json(t),
    'history', private.history(p.map_id),
    'mine', coalesce((select jsonb_agg(f.id) from public.features f where f.map_id = p.map_id and f.owner_player_id = p.id), '[]'::jsonb),
    -- Movement range per own unit, in metres. Absent or null means unlimited.
    'radii', coalesce((select jsonb_object_agg(f.id, private.radius_for(t.id, t.default_radius_m, f.id, f.asset_id, f.props ->> 'tech'))
                         from public.features f where f.map_id = p.map_id and f.owner_player_id = p.id and t.id is not null), '{}'::jsonb),
    'allocations', coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'asset_id', a.asset_id, 'sidc', a.sidc, 'props', a.props, 'quantity', a.quantity,
               'zone', a.zone, 'shared', a.team is not null, 'used_by_others', private.used_by_others(t.id, a.id, p.id)) order by a.created_at)
      from public.allocations a
      where a.turn_id = t.id and (a.player_id = p.id or (a.team is not null and a.team <> '' and a.team = p.team))), '[]'::jsonb),
    'allocation_assets', coalesce((
      select jsonb_agg(private.asset_json(x)) from public.assets x
      where x.id in (select a.asset_id from public.allocations a
                      where a.turn_id = t.id and (a.player_id = p.id or (a.team is not null and a.team <> '' and a.team = p.team)))), '[]'::jsonb),
    'draft', (select jsonb_build_object('changes', d.changes, 'ready', d.ready, 'updated_at', d.updated_at)
                from public.drafts d where d.turn_id = t.id and d.player_id = p.id),
    -- Tech tree: the whole tree is public to players; balances and research are their own.
    'economy', jsonb_build_object('spawn_points', p.spawn_points, 'research_points', p.research_points,
                                  'tech_unlocked', to_jsonb(p.tech_unlocked), 'income', private.income(p.id)),
    -- Items not released yet are left out entirely, until their turn.
    'tech', coalesce((select jsonb_agg(private.tech_json(x) order by x.tier, x.sort, x.name) from public.tech_items x
                       where x.map_id = p.map_id and private.released(x, n)), '[]'::jsonb),
    'tech_assets', coalesce((select jsonb_agg(private.asset_json(a)) from public.assets a
                               where a.id in (select x.asset_id from public.tech_items x where x.map_id = p.map_id and private.released(x, n))), '[]'::jsonb),
    'spawn_zones', coalesce((select jsonb_agg(jsonb_build_object('id', z.id, 'name', z.name, 'zone', z.zone) order by z.created_at)
                               from public.spawn_zones z
                              where z.map_id = p.map_id
                                and (z.player_id = p.id or (z.team is not null and z.team = p.team) or (z.player_id is null and z.team is null))), '[]'::jsonb),
    'combat', private.player_combat(p),
    'air', private.player_air(p),
    -- Own units that are spawn points, where they stand now (they may be on a layer this player cannot see).
    'spawn_points', coalesce((select jsonb_agg(jsonb_build_object('feature_id', f.id, 'center', to_jsonb(private.anchor(f.geometry)), 'radius_m', x.spawn_radius_m,
                                  'name', x.name, 'item_id', x.id))
                                from public.features f join public.tech_items x on x.id::text = f.props ->> 'tech' and x.map_id = f.map_id
                               where f.map_id = p.map_id and f.owner_player_id = p.id and x.spawn_radius_m is not null), '[]'::jsonb),
    -- Outcome of the most recent pushed turn: what was applied, what was turned down, and the owner's note.
    'last', (select jsonb_build_object('number', pt.number, 'applied', d.ready, 'changes', coalesce(d.owner_changes, d.changes),
                      'edited', d.owner_changes is not null, 'rejected', to_jsonb(d.rejected), 'owner_note', d.owner_note)
               from public.turns pt join public.drafts d on d.turn_id = pt.id and d.player_id = p.id
              where pt.map_id = p.map_id and pt.status = 'pushed' order by pt.number desc limit 1));
end $$;

-- A past turn, cut down to the layers this player may see.
create function public.get_player_history(p_player_id uuid, p_turn integer) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare p public.players := private.me(p_player_id);
begin
  if p.id is null then return null; end if;
  return (select private.filter_snapshot(s.payload, p.visible_layers) || jsonb_build_object('viewing', s.turn_number)
            from public.snapshots s where s.map_id = p.map_id and s.turn_number = p_turn);
end $$;

-- Save (replace) this player's draft for the open turn. Nothing touches the live map.
create function public.save_draft(p_player_id uuid, p_changes jsonb) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  p public.players := private.me(p_player_id);
  t public.turns;
  clean jsonb;
begin
  if p.id is null then
    raise exception 'not a player on this map' using errcode = '42501';
  end if;
  select * into t from public.turns where map_id = p.map_id and status in ('open', 'locked') for share;
  if not found then
    raise exception 'no turn is open yet' using errcode = 'P0001';
  end if;
  if t.status <> 'open' then
    raise exception 'the turn is locked for review' using errcode = 'P0001';
  end if;
  if t.deadline is not null and t.deadline <= now() then
    raise exception 'the deadline for this turn has passed' using errcode = 'P0001';
  end if;
  clean := private.normalise(p, t, p_changes, true);
  insert into public.drafts (turn_id, player_id, changes, updated_at) values (t.id, p.id, clean, now())
  on conflict (turn_id, player_id) do update
    set changes = excluded.changes, updated_at = now(), owner_changes = null, rejected = '{}';
  if not exists (select 1 from public.activity a where a.map_id = p.map_id and a.actor = p.name and a.kind = 'saved draft'
                   and a.at > now() - interval '30 minutes') then
    perform private.log(p.map_id, p.name, 'saved draft', 'Turn ' || t.number);
  end if;
  return jsonb_build_object('updated_at', now(), 'count', jsonb_array_length(clean));
end $$;

-- Ready / not ready. Allowed after the deadline, not after the lock.
create function public.set_ready(p_player_id uuid, p_ready boolean) returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  p public.players := private.me(p_player_id);
  t public.turns;
begin
  if p.id is null then
    raise exception 'not a player on this map' using errcode = '42501';
  end if;
  select * into t from public.turns where map_id = p.map_id and status in ('open', 'locked') for share;
  if not found or t.status <> 'open' then
    raise exception 'the turn is locked for review' using errcode = 'P0001';
  end if;
  insert into public.drafts (turn_id, player_id, ready) values (t.id, p.id, coalesce(p_ready, false))
  on conflict (turn_id, player_id) do update set ready = excluded.ready;
  perform private.log(p.map_id, p.name, case when p_ready then 'marked ready' else 'marked not ready' end, 'Turn ' || t.number);
end $$;

-- The only thing an anonymous viewer can call. Null for unknown, revoked and expired tokens alike.
-- p_turn asks for a past turn; it gets the same layer filtering as the live map.
create function public.get_shared_map(p_token text, p_turn integer default null) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  l public.share_links;
  payload jsonb;
begin
  if p_token is null or char_length(p_token) <> 64 then
    return null;
  end if;
  select * into l from public.share_links where token = p_token;
  if not found or l.revoked or (l.expires_at is not null and l.expires_at <= now()) then
    return null;
  end if;
  if l.mode = 'snapshot' then
    return l.snapshot || jsonb_build_object('mode', 'snapshot', 'expires_at', l.expires_at, 'created_at', l.created_at);
  end if;

  if p_turn is not null then
    select private.filter_snapshot(s.payload, l.visible_layers) || jsonb_build_object('viewing', s.turn_number) into payload
      from public.snapshots s where s.map_id = l.map_id and s.turn_number = p_turn;
  end if;
  payload := coalesce(payload, private.build_payload(l.map_id, l.visible_layers));
  return payload || jsonb_build_object(
    'mode', 'live', 'expires_at', l.expires_at, 'created_at', l.created_at,
    'channel', (select m.live_channel from public.maps m where m.id = l.map_id),
    'history', private.history(l.map_id),
    'turn', (private.active_turn(l.map_id)).number,
    'rollback_of', (private.active_turn(l.map_id)).rollback_of);
end $$;

-- ---------------------------------------------------------------------------
-- 10. Privileges and row level security
-- No client role can write maps, graphics, players, links, turns, allocations, drafts or snapshots
-- directly: those go through the functions above. Admins edit map content (layers and objects)
-- through RLS. Players and viewers have no table access of any kind.
-- ---------------------------------------------------------------------------

alter table public.players add column if not exists pin_set boolean generated always as (pin_hash is not null) stored;

revoke all on public.app_meta, public.maps, public.layers, public.features, public.assets, public.share_links, public.players,
  public.turns, public.turn_move_rules, public.allocations, public.drafts, public.snapshots, public.activity,
  public.tech_items, public.spawn_zones, public.weapon_profiles, public.unit_templates, public.unit_state, public.engagements,
  public.combat_settings, public.combat_previews, public.combat_reports, public.terrain_zones, public.terrain_meta,
  public.airframes, public.air_weapon_families, public.air_weapons, public.squadrons, public.air_reveals
  from public, anon, authenticated;
grant usage on schema public to anon, authenticated;
grant usage on schema private to authenticated;

grant select on public.maps, public.assets, public.share_links, public.turns, public.turn_move_rules, public.allocations, public.drafts to authenticated;
grant select, insert, update, delete on public.layers, public.features to authenticated;
grant delete on public.share_links to authenticated;
grant select (id, map_id, name, team, color, invite_token, visible_layers, target_layer_id, revoked, claimed_at, created_at,
              pin_set, pin_locked_until, last_seen_at) on public.players to authenticated;

do $$
declare t text;
begin
  foreach t in array array['app_meta','maps','layers','features','assets','share_links','players','turns','turn_move_rules',
                           'allocations','drafts','snapshots','activity','tech_items','spawn_zones','weapon_profiles','unit_templates',
                           'unit_state','engagements','combat_settings','combat_previews','combat_reports','terrain_zones','terrain_meta',
                           'airframes','air_weapon_families','air_weapons','squadrons','air_reveals'] loop
    execute format('alter table public.%I enable row level security', t);
    if t in ('maps','layers','features','assets','share_links','players','turns','turn_move_rules','allocations','drafts') then
      execute format('create policy %I on public.%I for all to authenticated using (private.is_admin()) with check (private.is_admin())', t || '_admin', t);
    end if;
  end loop;
end $$;
alter table private.admins enable row level security;
alter table private.admin_invites enable row level security;
alter table private.map_secrets enable row level security;

do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig, p.pronamespace::regnamespace::text as ns, p.proname from pg_proc p
            where p.pronamespace in ('private'::regnamespace, 'public'::regnamespace) loop
    if r.ns = 'private' then
      execute 'revoke all on function ' || r.sig || ' from public, anon, authenticated';
    elsif r.proname = any (array['app_status','keepalive','whoami','claim_owner','diagnostics','list_activity',
        'list_admins','invite_admin','cancel_admin_invite','accept_admin_invite','remove_admin','transfer_ownership',
        'create_map','update_map','add_asset','update_asset',
        'create_player','update_player','reset_player_invite','set_player_pin','clear_pin_lockout','assign_units','set_team_visibility',
        'open_turn','update_turn','set_move_rule','save_allocation','delete_allocation','lock_turn','unlock_turn','review_draft','push_turn','get_turn',
        'get_snapshot','rollback_to','export_campaign','import_campaign','create_share_link','update_share_link','get_shared_map',
        'get_settings','set_discord_webhook','test_discord_webhook','claim_invite','get_player_state','get_player_history','save_draft','set_ready',
        'get_economy','save_tech_item','delete_tech_item','save_spawn_zone','delete_spawn_zone','set_player_points','set_player_tech',
        'move_tech_items',
        'get_combat_admin','save_weapon','save_unit_template','save_combat_settings','set_unit_state','end_engagement',
        'get_combat_inputs','save_combat_preview','get_combat_preview','replace_terrain','get_terrain','get_player_terrain','get_shared_terrain',
        'get_air_admin','save_airframe','save_air_family','save_air_weapon','save_squadron','delete_squadron','seed_air_families','set_loadout']) then
      execute 'revoke all on function ' || r.sig || ' from public, anon';
      execute 'grant execute on function ' || r.sig || ' to authenticated';
      if r.proname in ('app_status', 'keepalive', 'get_shared_map', 'get_shared_terrain') then
        execute 'grant execute on function ' || r.sig || ' to anon';
      end if;
    end if;
  end loop;
end $$;
-- The one helper RLS policies call. It only ever answers about the caller.
grant execute on function private.is_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- 11. Storage (graphics), optional extensions
-- ---------------------------------------------------------------------------

do $$ begin
  if to_regclass('storage.objects') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('assets', 'assets', true, 2097152, array['image/png', 'image/webp', 'image/svg+xml'])
    on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
    execute 'drop policy if exists assets_select_own on storage.objects';
    execute 'drop policy if exists assets_insert_own on storage.objects';
    execute 'drop policy if exists assets_delete_own on storage.objects';
    execute 'drop policy if exists assets_owner_account_only on storage.objects';
    execute 'drop policy if exists tacmap_assets_admin on storage.objects';
    -- Admins only. Player sessions are signed in too, and must not be able to upload.
    -- Public buckets serve files by exact URL without a policy, and nobody else can list the bucket.
    execute $p$create policy tacmap_assets_admin on storage.objects for all to authenticated
      using (bucket_id = 'assets' and private.is_admin()) with check (bucket_id = 'assets' and private.is_admin())$p$;
  end if;
end $$;

-- pg_net lets the database post the "turn is live" message to Discord. Everything else works without it.
do $$ begin
  create extension if not exists pg_net;
exception when others then
  raise notice 'pg_net is not available here; Discord announcements are disabled';
end $$;

insert into public.app_meta (key, value) values ('schema_version', '10')
on conflict (key) do update set value = excluded.value, updated_at = now();

commit;

-- Owner recovery (only if every admin account is lost): run the one statement below, then open the
-- site and claim ownership again from the first-run page.
--   delete from private.admins;
