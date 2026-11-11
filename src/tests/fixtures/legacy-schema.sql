-- Tactical Map Editor: schema, row level security, share-link RPCs.
-- Run in the Supabase SQL editor (or `supabase db push`). Safe to run once on a fresh project.

create schema if not exists private;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.maps (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name         text not null default 'Untitled map' check (char_length(name) between 1 and 120),
  basemap      text not null default 'dark' check (basemap in ('satellite', 'topo', 'dark')),
  center       double precision[] not null default '{0,20}' check (array_length(center, 1) = 2),
  zoom         double precision not null default 2,
  -- Random id of the realtime broadcast channel. Only ever handed to holders of a valid live link.
  live_channel uuid not null default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index maps_owner_idx on public.maps (owner_id);

create table public.layers (
  id      uuid primary key default gen_random_uuid(),
  map_id  uuid not null references public.maps (id) on delete cascade,
  name    text not null default 'Layer' check (char_length(name) between 1 and 80),
  visible boolean not null default true,
  locked  boolean not null default false,
  z       integer not null default 0,
  unique (id, map_id)
);
create index layers_map_idx on public.layers (map_id);

create table public.assets (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 120),
  path       text not null unique,
  mime       text not null check (mime in ('image/png', 'image/webp', 'image/svg+xml')),
  width      integer not null check (width > 0),
  height     integer not null check (height > 0),
  created_at timestamptz not null default now()
);
create index assets_owner_idx on public.assets (owner_id);

create table public.features (
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
  -- A feature's layer must belong to the same map as the feature.
  foreign key (layer_id, map_id) references public.layers (id, map_id) on delete cascade
);
create index features_map_idx on public.features (map_id);
create index features_layer_idx on public.features (layer_id);

create function private.new_token() returns text
language sql volatile set search_path = ''
as $$
  -- Two v4 UUIDs = 244 random bits from the server CSPRNG, hex encoded.
  select replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
$$;

create table public.share_links (
  id             uuid primary key default gen_random_uuid(),
  map_id         uuid not null references public.maps (id) on delete cascade,
  token          text not null unique default private.new_token(),
  mode           text not null default 'live' check (mode in ('live', 'snapshot')),
  visible_layers uuid[],              -- null = every layer
  expires_at     timestamptz,         -- null = never
  revoked        boolean not null default false,
  snapshot       jsonb,               -- frozen payload for snapshot links
  label          text check (label is null or char_length(label) <= 120),
  created_at     timestamptz not null default now(),
  check ((mode = 'snapshot') = (snapshot is not null))
);
create index share_links_map_idx on public.share_links (map_id);

create function private.touch() returns trigger
language plpgsql set search_path = ''
as $$ begin new.updated_at := now(); return new; end $$;

create trigger maps_touch before update on public.maps for each row execute function private.touch();
create trigger features_touch before update on public.features for each row execute function private.touch();

-- ---------------------------------------------------------------------------
-- Privileges: anon gets nothing on tables. The owner works through RLS.
-- ---------------------------------------------------------------------------

revoke all on public.maps, public.layers, public.features, public.assets, public.share_links from public, anon, authenticated;

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.maps, public.layers, public.features, public.assets to authenticated;
-- Share links are created only through create_share_link(); the token and snapshot are never client-writable.
grant select, delete on public.share_links to authenticated;
grant update (revoked, expires_at, label, visible_layers) on public.share_links to authenticated;

alter table public.maps        enable row level security;
alter table public.layers      enable row level security;
alter table public.features    enable row level security;
alter table public.assets      enable row level security;
alter table public.share_links enable row level security;

create policy maps_owner on public.maps for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy layers_owner on public.layers for all to authenticated
  using (exists (select 1 from public.maps m where m.id = map_id and m.owner_id = (select auth.uid())))
  with check (exists (select 1 from public.maps m where m.id = map_id and m.owner_id = (select auth.uid())));

create policy assets_owner on public.assets for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy features_owner on public.features for all to authenticated
  using (exists (select 1 from public.maps m where m.id = map_id and m.owner_id = (select auth.uid())))
  with check (
    exists (select 1 from public.maps m where m.id = map_id and m.owner_id = (select auth.uid()))
    and (asset_id is null or exists (select 1 from public.assets a where a.id = asset_id and a.owner_id = (select auth.uid())))
  );

create policy share_links_owner on public.share_links for all to authenticated
  using (exists (select 1 from public.maps m where m.id = map_id and m.owner_id = (select auth.uid())))
  with check (exists (select 1 from public.maps m where m.id = map_id and m.owner_id = (select auth.uid())));

-- ---------------------------------------------------------------------------
-- Viewer payload. Lives in a schema PostgREST does not expose.
-- ---------------------------------------------------------------------------

create function private.build_payload(p_map_id uuid, p_visible uuid[]) returns jsonb
language sql stable set search_path = ''
as $$
  with vis as (
    select l.id, l.name, l.z
    from public.layers l
    where l.map_id = p_map_id               -- layer ids from other maps can never match
      and l.visible                         -- hiding a layer in the editor hides it from every viewer
      and (p_visible is null or l.id = any (p_visible))
  ),
  feats as (
    select f.id, f.layer_id, f.kind, f.geometry, f.props, f.style, f.asset_id, f.z
    from public.features f
    join vis on vis.id = f.layer_id
    where f.map_id = p_map_id
  )
  select jsonb_build_object(
    'map', (
      select jsonb_build_object('name', m.name, 'basemap', m.basemap, 'center', to_jsonb(m.center), 'zoom', m.zoom)
      from public.maps m where m.id = p_map_id
    ),
    'layers', coalesce((select jsonb_agg(to_jsonb(vis) order by vis.z) from vis), '[]'::jsonb),
    'features', coalesce((select jsonb_agg(to_jsonb(feats)) from feats), '[]'::jsonb),
    'assets', coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'path', a.path, 'mime', a.mime, 'width', a.width, 'height', a.height))
      from public.assets a
      where a.id in (select feats.asset_id from feats where feats.asset_id is not null)
    ), '[]'::jsonb)
  );
$$;

-- The only thing an anonymous viewer can call. Returns null for unknown, revoked and expired tokens alike.
create function public.get_shared_map(p_token text) returns jsonb
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

  payload := private.build_payload(l.map_id, l.visible_layers);
  return payload || jsonb_build_object(
    'mode', 'live',
    'expires_at', l.expires_at,
    'created_at', l.created_at,
    'channel', (select m.live_channel from public.maps m where m.id = l.map_id)
  );
end $$;

create function public.create_share_link(
  p_map_id uuid,
  p_mode text default 'live',
  p_visible_layers uuid[] default null,
  p_expires_at timestamptz default null,
  p_label text default null
) returns public.share_links
language plpgsql volatile security definer set search_path = ''
as $$
declare
  r public.share_links;
begin
  if (select auth.uid()) is null
     or not exists (select 1 from public.maps m where m.id = p_map_id and m.owner_id = (select auth.uid())) then
    raise exception 'map not found' using errcode = '42501';
  end if;
  if p_mode not in ('live', 'snapshot') then
    raise exception 'invalid mode' using errcode = '22023';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'expiry must be in the future' using errcode = '22023';
  end if;

  insert into public.share_links (map_id, mode, visible_layers, expires_at, label, snapshot)
  values (
    p_map_id, p_mode, p_visible_layers, p_expires_at, nullif(trim(p_label), ''),
    case when p_mode = 'snapshot' then private.build_payload(p_map_id, p_visible_layers) end
  )
  returning * into r;
  return r;
end $$;

revoke all on function public.get_shared_map(text) from public;
grant execute on function public.get_shared_map(text) to anon, authenticated;

revoke all on function public.create_share_link(uuid, text, uuid[], timestamptz, text) from public, anon;
grant execute on function public.create_share_link(uuid, text, uuid[], timestamptz, text) to authenticated;

revoke all on function private.build_payload(uuid, uuid[]) from public, anon, authenticated;
revoke all on function private.new_token() from public, anon, authenticated;
-- Player submissions with owner approval.
-- Run after 0001_schema.sql and 0002_storage.sql. Then run 0004_storage_owner_only.sql.
--
-- Roles after this migration:
--   owner   a non-anonymous account on the owner allowlist. Full edit through RLS, as before.
--   player  an anonymous-auth session bound to one invite. No table writes at all. Reads and
--           writes go through the RPCs at the bottom; nothing reaches `features` until the
--           owner approves it through review_submission().
--   viewer  unchanged (get_shared_map only).

-- ---------------------------------------------------------------------------
-- 1. Owner accounts
-- Anonymous sign-in must be on for players, and anonymous users get the `authenticated` role.
-- Without this section any of them could create their own maps and upload files on your quota.
-- ---------------------------------------------------------------------------

create table private.owners (
  uid uuid primary key references auth.users (id) on delete cascade
);
insert into private.owners select distinct owner_id from public.maps on conflict do nothing;

grant usage on schema private to authenticated;

create function private.is_owner_account() returns boolean
language sql stable security definer set search_path = ''
as $$
  select (select auth.uid()) is not null
    and not coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
    and (
      exists (select 1 from private.owners o where o.uid = (select auth.uid()))
      -- Fresh project: the first real account to create a map becomes the owner (trigger below).
      or not exists (select 1 from private.owners)
    );
$$;

create function private.claim_ownership() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into private.owners values (new.owner_id) on conflict do nothing;
  return new;
end $$;
create trigger maps_claim_ownership after insert on public.maps
  for each row execute function private.claim_ownership();

-- Restrictive policies AND with the owner policies from 0001.
create policy maps_owner_account on public.maps as restrictive for all to authenticated
  using (private.is_owner_account()) with check (private.is_owner_account());
create policy layers_owner_account on public.layers as restrictive for all to authenticated
  using (private.is_owner_account()) with check (private.is_owner_account());
create policy features_owner_account on public.features as restrictive for all to authenticated
  using (private.is_owner_account()) with check (private.is_owner_account());
create policy assets_owner_account on public.assets as restrictive for all to authenticated
  using (private.is_owner_account()) with check (private.is_owner_account());
create policy share_links_owner_account on public.share_links as restrictive for all to authenticated
  using (private.is_owner_account()) with check (private.is_owner_account());

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------

alter table public.maps
  add column palette_assets  uuid[]  not null default '{}',   -- graphics players may place
  add column palette_symbols boolean not null default true;   -- may players place NATO symbols

create table public.players (
  id              uuid primary key default gen_random_uuid(),
  map_id          uuid not null references public.maps (id) on delete cascade,
  auth_uid        uuid references auth.users (id) on delete set null,   -- null until the invite is opened
  name            text not null check (char_length(name) between 1 and 60),
  team            text not null default '' check (char_length(team) <= 40),
  color           text check (color is null or color ~ '^#[0-9a-fA-F]{6}$'),
  invite_token    text not null unique default private.new_token(),
  visible_layers  uuid[],                                               -- null = every layer
  target_layer_id uuid references public.layers (id) on delete set null, -- where approved new objects go
  revoked         boolean not null default false,
  claimed_at      timestamptz,
  created_at      timestamptz not null default now(),
  unique (id, map_id),
  unique (map_id, auth_uid)
);
create index players_map_idx on public.players (map_id);
create index players_auth_idx on public.players (auth_uid);

alter table public.features add column owner_player_id uuid;
alter table public.features add constraint features_owner_player_fk
  foreign key (owner_player_id, map_id) references public.players (id, map_id)
  on delete set null (owner_player_id);
create index features_owner_player_idx on public.features (owner_player_id) where owner_player_id is not null;

create table public.submissions (
  id          uuid primary key default gen_random_uuid(),
  map_id      uuid not null references public.maps (id) on delete cascade,
  player_id   uuid not null,
  status      text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'withdrawn')),
  note        text check (note is null or char_length(note) <= 1000),             -- from the player
  owner_note  text check (owner_note is null or char_length(owner_note) <= 1000), -- from the owner
  edited      boolean not null default false,                                     -- owner changed it before approving
  created_at  timestamptz not null default now(),
  reviewed_at timestamptz,
  foreign key (player_id, map_id) references public.players (id, map_id) on delete cascade
);
create index submissions_map_idx on public.submissions (map_id, status, created_at);
create index submissions_player_idx on public.submissions (player_id, created_at);

create table public.submission_changes (
  submission_id uuid not null references public.submissions (id) on delete cascade,
  seq           integer not null,
  op            text not null check (op in ('create', 'update', 'delete')),
  feature_id    uuid not null,
  payload       jsonb not null default '{}' check (octet_length(payload::text) < 120000),
  primary key (submission_id, seq),
  unique (submission_id, feature_id)   -- one change per object per turn
);

-- ---------------------------------------------------------------------------
-- 3. Privileges and RLS
-- No insert or update grant exists on submissions or submission_changes for any client role.
-- A turn is a bundle (one submission + N changes) that has to be validated and written
-- atomically, which an insert policy cannot do, so writing goes through submit_turn().
-- ---------------------------------------------------------------------------

revoke all on public.players, public.submissions, public.submission_changes from public, anon, authenticated;

grant select, delete on public.players to authenticated;
grant update (name, team, color, visible_layers, target_layer_id, revoked) on public.players to authenticated;
grant select, delete on public.submissions to authenticated;
grant select on public.submission_changes to authenticated;

alter table public.players            enable row level security;
alter table public.submissions        enable row level security;
alter table public.submission_changes enable row level security;

create function private.my_player_ids() returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select p.id from public.players p where p.auth_uid = (select auth.uid()) and not p.revoked;
$$;

create policy players_owner on public.players for all to authenticated
  using (exists (select 1 from public.maps m where m.id = map_id and m.owner_id = (select auth.uid())))
  with check (exists (select 1 from public.maps m where m.id = map_id and m.owner_id = (select auth.uid())));

create policy submissions_owner_read on public.submissions for select to authenticated
  using (exists (select 1 from public.maps m where m.id = map_id and m.owner_id = (select auth.uid())));
create policy submissions_owner_delete on public.submissions for delete to authenticated
  using (exists (select 1 from public.maps m where m.id = map_id and m.owner_id = (select auth.uid())));
-- Players read their own submissions and nothing else.
create policy submissions_player_read on public.submissions for select to authenticated
  using (player_id in (select private.my_player_ids()));

-- Visible exactly when the parent submission is (the subquery runs under the caller's RLS).
create policy submission_changes_read on public.submission_changes for select to authenticated
  using (exists (select 1 from public.submissions s where s.id = submission_id));

-- Revoking a player closes their open submissions.
create function private.on_player_revoked() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.revoked and not old.revoked then
    update public.submissions
       set status = 'rejected', owner_note = 'Player access revoked', reviewed_at = now()
     where player_id = new.id and status = 'pending';
  end if;
  return new;
end $$;
create trigger players_revoked after update of revoked on public.players
  for each row execute function private.on_player_revoked();

-- ---------------------------------------------------------------------------
-- 4. Validation, shared by submit_turn() and review_submission()
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
     and private.str_ok(style -> 'color', 7, '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$')
     and private.str_ok(style -> 'dash', 5, '^(solid|dash|dot)$')
     and private.num_in(style -> 'width', 1, 16)
     and private.num_in(style -> 'fillOpacity', 0, 1);
$$;

-- Strip a change down to the fields a player is allowed to send.
create function private.clean_payload(p_op text, j jsonb) returns jsonb
language sql immutable set search_path = ''
as $$
  select case p_op
    when 'create' then private.pick(j, array['kind', 'geometry', 'asset_id']) || jsonb_build_object(
      'props', private.pick(j -> 'props', array['name', 'type', 'heading', 'speed', 'notes', 'timestamp', 'sidc',
                                                'sizeMode', 'sizePx', 'sizeM', 'tint', 'showLabel', 'radius', 'fontSize']),
      'style', private.pick(j -> 'style', array['color', 'width', 'dash', 'fillOpacity']))
    when 'update' then private.pick(j, array['geometry', 'heading', 'order'])
    else '{}'::jsonb
  end;
$$;

-- Raises unless player p may make this change right now. Called at submit time and again at
-- approval time, because assignments, the palette and the map itself can change in between.
create function private.check_change(p public.players, p_op text, p_fid uuid, j jsonb) returns void
language plpgsql stable set search_path = ''
as $$
declare
  f public.features;
  m public.maps;
  k text;
  want text;
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
    select * into m from public.maps where id = p.map_id;
    if k = 'symbol' and not m.palette_symbols then
      raise exception 'NATO symbols are not enabled for players on this map' using errcode = '42501';
    end if;
    if k = 'asset' and (
      j ->> 'asset_id' is null
      or not ((j ->> 'asset_id')::uuid = any (m.palette_assets))
      or not exists (select 1 from public.assets a where a.id = (j ->> 'asset_id')::uuid and a.owner_id = m.owner_id)
    ) then
      raise exception 'graphic is not in the palette for this map' using errcode = '42501';
    end if;

  elsif p_op in ('update', 'delete') then
    select * into f from public.features where id = p_fid and map_id = p.map_id;
    if not found or f.owner_player_id is distinct from p.id then
      raise exception 'object is not assigned to this player' using errcode = '42501';
    end if;
    if p_op = 'update' then
      if j = '{}'::jsonb or exists (select 1 from jsonb_object_keys(j) key where key not in ('geometry', 'heading', 'order')) then
        raise exception 'players can change position, heading and orders only' using errcode = '42501';
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
    end if;

  else
    raise exception 'invalid op' using errcode = '22023';
  end if;
end $$;

-- Validate a JSON array of changes and store it as the content of a submission.
create function private.store_changes(p public.players, p_submission_id uuid, p_changes jsonb) returns void
language plpgsql volatile set search_path = ''
as $$
declare
  c jsonb;
  i integer := 0;
  clean jsonb;
begin
  if jsonb_typeof(p_changes) is distinct from 'array' or jsonb_array_length(p_changes) not between 1 and 50 then
    raise exception 'a turn needs between 1 and 50 changes' using errcode = '22023';
  end if;
  if octet_length(p_changes::text) > 600000 then
    raise exception 'turn is too large' using errcode = '22023';
  end if;
  for c in select * from jsonb_array_elements(p_changes) loop
    clean := private.clean_payload(c ->> 'op', c -> 'payload');
    perform private.check_change(p, c ->> 'op', (c ->> 'feature_id')::uuid, clean);
    insert into public.submission_changes (submission_id, seq, op, feature_id, payload)
    values (p_submission_id, i, c ->> 'op', (c ->> 'feature_id')::uuid, clean);
    i := i + 1;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Owner RPCs
-- ---------------------------------------------------------------------------

create function private.owns_map(p_map_id uuid) returns boolean
language sql stable set search_path = ''
as $$
  select private.is_owner_account()
    and exists (select 1 from public.maps m where m.id = p_map_id and m.owner_id = (select auth.uid()));
$$;

create function public.create_player(
  p_map_id uuid,
  p_name text,
  p_team text default '',
  p_color text default null,
  p_visible_layers uuid[] default null,
  p_target_layer_id uuid default null
) returns public.players
language plpgsql volatile security definer set search_path = ''
as $$
declare
  r public.players;
begin
  if not private.owns_map(p_map_id) then
    raise exception 'map not found' using errcode = '42501';
  end if;
  if p_target_layer_id is not null
     and not exists (select 1 from public.layers l where l.id = p_target_layer_id and l.map_id = p_map_id) then
    raise exception 'layer not found' using errcode = '22023';
  end if;
  if (select count(*) from public.players where map_id = p_map_id) >= 100 then
    raise exception 'player limit reached for this map' using errcode = 'P0001';
  end if;
  insert into public.players (map_id, name, team, color, visible_layers, target_layer_id)
  values (p_map_id, trim(p_name), coalesce(trim(p_team), ''), p_color, p_visible_layers, p_target_layer_id)
  returning * into r;
  return r;
end $$;

-- New link, old link dead, session unbound. Use when a player changes device or a link leaks.
create function public.reset_player_invite(p_player_id uuid) returns public.players
language plpgsql volatile security definer set search_path = ''
as $$
declare
  r public.players;
begin
  update public.players p
     set invite_token = private.new_token(), auth_uid = null, claimed_at = null
   where p.id = p_player_id and private.owns_map(p.map_id)
  returning * into r;
  if not found then
    raise exception 'player not found' using errcode = '42501';
  end if;
  return r;
end $$;

-- Approve or reject. Approval applies every change in one transaction or none of them.
--   p_changes   optional replacement for the player's changes (edit-then-approve). Same rules apply.
--   p_layer_id  optional layer for newly created objects; defaults to the player's target layer,
--               then the map's top layer.
create function public.review_submission(
  p_submission_id uuid,
  p_action text,
  p_note text default null,
  p_changes jsonb default null,
  p_layer_id uuid default null
) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  s public.submissions;
  p public.players;
  c public.submission_changes;
  lid uuid;
  top_z integer;
  n integer := 0;
  v_note text := nullif(left(trim(coalesce(p_note, '')), 1000), '');
begin
  select s0.* into s
    from public.submissions s0
   where s0.id = p_submission_id and private.owns_map(s0.map_id)
     for update;
  if not found then
    raise exception 'submission not found' using errcode = '42501';
  end if;
  if s.status <> 'pending' then
    raise exception 'submission is already %', s.status using errcode = 'P0001';
  end if;

  if p_action = 'reject' then
    update public.submissions set status = 'rejected', owner_note = v_note, reviewed_at = now() where id = s.id;
    return jsonb_build_object('status', 'rejected', 'applied', 0);
  elsif p_action is distinct from 'approve' then
    raise exception 'invalid action' using errcode = '22023';
  end if;

  select * into p from public.players where id = s.player_id;
  if p.revoked then
    raise exception 'player access is revoked' using errcode = 'P0001';
  end if;

  if p_changes is not null then
    delete from public.submission_changes where submission_id = s.id;
    perform private.store_changes(p, s.id, p_changes);
    update public.submissions set edited = true where id = s.id;
  end if;

  select l.id into lid from public.layers l
   where l.map_id = s.map_id and l.id = coalesce(p_layer_id, p.target_layer_id);
  if lid is null then
    if p_layer_id is not null then
      raise exception 'layer not found' using errcode = '22023';
    end if;
    select l.id into lid from public.layers l where l.map_id = s.map_id order by l.z desc limit 1;
  end if;
  select coalesce(max(z), 0) into top_z from public.features where map_id = s.map_id;

  for c in select * from public.submission_changes where submission_id = s.id order by seq loop
    -- Re-check against the map as it is now, not as it was when the player submitted.
    perform private.check_change(p, c.op, c.feature_id, c.payload);

    if c.op = 'create' then
      if lid is null then
        raise exception 'map has no layer to put new objects on' using errcode = 'P0001';
      end if;
      top_z := top_z + 1;
      insert into public.features (id, map_id, layer_id, kind, geometry, props, style, asset_id, z, owner_player_id)
      values (
        c.feature_id, s.map_id, lid, c.payload ->> 'kind', c.payload -> 'geometry',
        coalesce(c.payload -> 'props', '{}'), coalesce(c.payload -> 'style', '{}'),
        case when c.payload ->> 'kind' = 'asset' then (c.payload ->> 'asset_id')::uuid end,
        top_z, p.id
      );
    elsif c.op = 'update' then
      update public.features ft set
        geometry = coalesce(c.payload -> 'geometry', ft.geometry),
        props = ft.props
          || case when c.payload ? 'heading' then jsonb_build_object('heading', c.payload -> 'heading') else '{}'::jsonb end
          || case when c.payload ? 'order' then jsonb_build_object('notes', left(concat_ws(E'\n',
               nullif(ft.props ->> 'notes', ''), '[' || p.name || '] ' || (c.payload ->> 'order')), 4000)) else '{}'::jsonb end
      where ft.id = c.feature_id;
    else
      delete from public.features where id = c.feature_id;
    end if;
    n := n + 1;
  end loop;

  update public.submissions set status = 'approved', owner_note = v_note, reviewed_at = now() where id = s.id;
  return jsonb_build_object('status', 'approved', 'applied', n);
end $$;

-- ---------------------------------------------------------------------------
-- 6. Player RPCs
-- ---------------------------------------------------------------------------

-- Bind the calling session to an invite. One invite, one session: a second browser is refused
-- until the owner resets the link. Unknown, revoked and taken invites all fail the same way.
create function public.claim_invite(p_token text) returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  p public.players;
  uid uuid := (select auth.uid());
begin
  if uid is null or p_token is null or char_length(p_token) <> 64 then
    raise exception 'invalid invite' using errcode = '42501';
  end if;
  select * into p from public.players where invite_token = p_token for update;
  if not found or p.revoked or (p.auth_uid is not null and p.auth_uid <> uid) then
    raise exception 'invalid invite' using errcode = '42501';
  end if;
  if p.auth_uid is null then
    if exists (select 1 from public.players x where x.map_id = p.map_id and x.auth_uid = uid) then
      raise exception 'this browser already holds another invite for this map' using errcode = 'P0001';
    end if;
    update public.players set auth_uid = uid, claimed_at = now() where id = p.id;
  end if;
  return p.id;
end $$;

-- Everything the player page needs, in one call. Null when the session is not (or no longer) this player.
create function public.get_player_state(p_player_id uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  p public.players;
  m public.maps;
begin
  if (select auth.uid()) is null then
    return null;
  end if;
  select * into p from public.players
   where id = p_player_id and auth_uid = (select auth.uid()) and not revoked;
  if not found then
    return null;
  end if;
  select * into m from public.maps where id = p.map_id;

  return private.build_payload(p.map_id, p.visible_layers) || jsonb_build_object(
    'player', jsonb_build_object('id', p.id, 'name', p.name, 'team', p.team, 'color', p.color),
    'channel', m.live_channel,
    'mine', coalesce((
      select jsonb_agg(f.id) from public.features f where f.map_id = p.map_id and f.owner_player_id = p.id
    ), '[]'::jsonb),
    'palette', jsonb_build_object(
      'symbols', m.palette_symbols,
      'assets', coalesce((
        select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'path', a.path, 'mime', a.mime,
                                            'width', a.width, 'height', a.height) order by a.name)
        from public.assets a where a.id = any (m.palette_assets) and a.owner_id = m.owner_id
      ), '[]'::jsonb)
    ),
    'submissions', coalesce((
      select jsonb_agg(t.j order by t.created_at desc)
      from (
        select s.created_at, jsonb_build_object(
          'id', s.id, 'status', s.status, 'note', s.note, 'owner_note', s.owner_note, 'edited', s.edited,
          'created_at', s.created_at, 'reviewed_at', s.reviewed_at,
          'changes', coalesce((
            select jsonb_agg(jsonb_build_object('op', c.op, 'feature_id', c.feature_id, 'payload', c.payload) order by c.seq)
            from public.submission_changes c where c.submission_id = s.id
          ), '[]'::jsonb)
        ) as j
        from public.submissions s
        where s.player_id = p.id
        order by s.created_at desc
        limit 30
      ) t
    ), '[]'::jsonb)
  );
end $$;

-- Submit a turn: one submission holding 1 to 50 changes. Nothing touches the live map.
-- Limits per player: 5 submissions a minute, 20 pending at once.
create function public.submit_turn(p_player_id uuid, p_note text, p_changes jsonb) returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  p public.players;
  sid uuid;
begin
  select * into p from public.players
   where id = p_player_id and auth_uid = (select auth.uid()) and not revoked;
  if not found or (select auth.uid()) is null then
    raise exception 'not a player on this map' using errcode = '42501';
  end if;

  -- Serialise per player so two parallel requests cannot both slip under the cap.
  perform pg_advisory_xact_lock(hashtextextended(p.id::text, 0));
  if (select count(*) from public.submissions
       where player_id = p.id and created_at > clock_timestamp() - interval '1 minute') >= 5 then
    raise exception 'rate limit: wait a minute before submitting again' using errcode = 'P0001';
  end if;
  if (select count(*) from public.submissions where player_id = p.id and status = 'pending') >= 20 then
    raise exception 'too many pending submissions: wait for a review or withdraw one' using errcode = 'P0001';
  end if;

  insert into public.submissions (map_id, player_id, note, created_at)
  values (p.map_id, p.id, nullif(left(trim(coalesce(p_note, '')), 1000), ''), clock_timestamp())
  returning id into sid;
  perform private.store_changes(p, sid, p_changes);
  return sid;
end $$;

create function public.withdraw_submission(p_submission_id uuid) returns void
language plpgsql volatile security definer set search_path = ''
as $$
begin
  update public.submissions
     set status = 'withdrawn', reviewed_at = now()
   where id = p_submission_id and status = 'pending'
     and player_id in (select private.my_player_ids());
  if not found then
    raise exception 'submission not found or already reviewed' using errcode = '42501';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 7. Function privileges
-- ---------------------------------------------------------------------------

revoke all on function
  public.create_player(uuid, text, text, text, uuid[], uuid),
  public.reset_player_invite(uuid),
  public.review_submission(uuid, text, text, jsonb, uuid),
  public.claim_invite(text),
  public.get_player_state(uuid),
  public.submit_turn(uuid, text, jsonb),
  public.withdraw_submission(uuid)
from public, anon;
grant execute on function
  public.create_player(uuid, text, text, text, uuid[], uuid),
  public.reset_player_invite(uuid),
  public.review_submission(uuid, text, text, jsonb, uuid),
  public.claim_invite(text),
  public.get_player_state(uuid),
  public.submit_turn(uuid, text, jsonb),
  public.withdraw_submission(uuid)
to authenticated;

revoke all on function
  private.claim_ownership(), private.on_player_revoked(),
  private.valid_pos(jsonb), private.valid_line(jsonb, integer), private.valid_geom(jsonb, text),
  private.num_in(jsonb, float8, float8), private.str_ok(jsonb, integer, text), private.valid_props(jsonb, jsonb),
  private.pick(jsonb, text[]), private.clean_payload(text, jsonb),
  private.check_change(public.players, text, uuid, jsonb),
  private.store_changes(public.players, uuid, jsonb),
  private.owns_map(uuid), private.is_owner_account(), private.my_player_ids()
from public, anon, authenticated;
-- The two helpers that RLS policies call. Both only ever answer about the caller.
grant execute on function private.is_owner_account(), private.my_player_ids() to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Realtime
-- The owner's review badge and the player's status list listen for row changes on `submissions`.
-- Realtime applies the RLS policies above per subscriber, so the owner hears about their maps
-- and a player hears about their own turns only. Row contents are never trusted from the event:
-- both pages re-read through the normal queries.
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'submissions') then
    alter publication supabase_realtime add table public.submissions;
  end if;
end $$;
