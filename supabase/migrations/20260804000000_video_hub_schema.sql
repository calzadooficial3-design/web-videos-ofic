begin;

create extension if not exists pgcrypto;

do $$
begin
  create type public.app_role as enum ('admin', 'operator', 'boss');
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  create type public.video_provider as enum (
    'youtube',
    'google_drive',
    'vimeo',
    'loom',
    'direct',
    'supabase_storage'
  );
exception
  when duplicate_object then null;
end
$$;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated, service_role;

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  logo_url text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organizations_logo_url_check check (
    logo_url is null or logo_url ~* '^https://' or logo_url like '/%'
  )
);

create table public.app_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  product_name text not null default 'Video Hub'
    check (length(trim(product_name)) between 1 and 80),
  welcome_title text not null default 'Todo lo que necesitas aprender, en un solo lugar.'
    check (length(trim(welcome_title)) between 1 and 180),
  welcome_message text not null default '',
  support_message text not null default 'Contacta a tu administrador',
  allow_light_mode boolean not null default true,
  updated_at timestamptz not null default now()
);

create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  role public.app_role not null,
  display_name text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.sections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 100),
  slug text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  icon text not null default 'layers'
    check (length(trim(icon)) between 1 and 50),
  sort_order integer not null default 0 check (sort_order >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, slug),
  unique (id, organization_id)
);

create table public.section_roles (
  section_id uuid not null,
  organization_id uuid not null,
  role public.app_role not null check (role in ('operator', 'boss')),
  visible boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (section_id, role),
  unique (section_id, role, organization_id),
  foreign key (section_id, organization_id)
    references public.sections(id, organization_id)
    on delete cascade
);

create table public.videos (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  title text not null check (length(trim(title)) between 1 and 180),
  description text not null default '',
  duration_label text check (
    duration_label is null or length(trim(duration_label)) between 1 and 20
  ),
  duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
  featured boolean not null default false,
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id)
);

create table public.video_sources (
  video_id uuid primary key references public.videos(id) on delete cascade,
  provider public.video_provider not null,
  source_ref text not null check (length(trim(source_ref)) between 1 and 2048),
  source_url text,
  thumbnail_url text,
  storage_bucket text,
  storage_object_path text,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint video_sources_url_check check (
    source_url is null or source_url ~* '^https://'
  ),
  constraint video_sources_thumbnail_check check (
    thumbnail_url is null or thumbnail_url ~* '^https://'
  ),
  constraint video_sources_provider_check check (
    (
      provider = 'supabase_storage'
      and storage_bucket is not null
      and storage_object_path is not null
    )
    or
    (
      provider <> 'supabase_storage'
      and source_url is not null
    )
  )
);

create table public.video_assignments (
  video_id uuid not null,
  organization_id uuid not null,
  role public.app_role not null check (role in ('operator', 'boss')),
  section_id uuid not null,
  visible boolean not null default true,
  is_locked boolean not null default false,
  sort_order integer not null default 0 check (sort_order >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (video_id, role),
  foreign key (video_id, organization_id)
    references public.videos(id, organization_id)
    on delete cascade,
  foreign key (section_id, role, organization_id)
    references public.section_roles(section_id, role, organization_id)
    on delete cascade
);

create table public.audit_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null check (length(trim(action)) between 1 and 80),
  entity_type text not null check (length(trim(entity_type)) between 1 and 80),
  entity_id text,
  details jsonb not null default '{}'::jsonb
    check (jsonb_typeof(details) = 'object'),
  created_at timestamptz not null default now()
);

create table private.role_access_codes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  role public.app_role not null,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  code_fingerprint text not null unique
    check (code_fingerprint ~ '^[a-f0-9]{64}$'),
  code_hint text,
  active boolean not null default true,
  expires_at timestamptz,
  rotated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, role)
);

create table private.access_attempts (
  id bigint generated always as identity primary key,
  organization_id uuid references public.organizations(id) on delete cascade,
  code_fingerprint text,
  ip_fingerprint text,
  succeeded boolean not null default false,
  attempted_at timestamptz not null default now()
);

create index if not exists profiles_org_role_idx
  on public.profiles(organization_id, role)
  where active;

create index if not exists sections_org_order_idx
  on public.sections(organization_id, active, sort_order);

create index if not exists section_roles_role_visible_idx
  on public.section_roles(organization_id, role, visible);

create index if not exists videos_org_created_idx
  on public.videos(organization_id, active, created_at desc);

create index if not exists video_sources_provider_idx
  on public.video_sources(provider);

create index if not exists assignments_role_section_idx
  on public.video_assignments(organization_id, role, section_id, visible, sort_order);

create index if not exists assignments_video_playable_idx
  on public.video_assignments(video_id, role)
  where visible and not is_locked;

create index if not exists audit_events_org_created_idx
  on public.audit_events(organization_id, created_at desc);

create index if not exists access_attempts_recent_idx
  on private.access_attempts(code_fingerprint, ip_fingerprint, attempted_at desc);

create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

create or replace function private.set_video_audit_fields()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then
      new.created_by := auth.uid();
      new.updated_by := auth.uid();
    end if;
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.updated_by := auth.uid();
  end if;

  new.updated_at := now();
  return new;
end
$$;

create or replace function private.create_default_section_roles()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.section_roles (section_id, organization_id, role, visible)
  values
    (new.id, new.organization_id, 'operator'::public.app_role, false),
    (new.id, new.organization_id, 'boss'::public.app_role, false)
  on conflict (section_id, role) do nothing;

  return new;
end
$$;

create or replace function private.record_audit_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  row_data jsonb;
  event_organization_id uuid;
  event_entity_id text;
begin
  row_data := case
    when tg_op = 'DELETE' then to_jsonb(old)
    else to_jsonb(new)
  end;

  if tg_table_name = 'organizations' then
    event_organization_id := nullif(row_data ->> 'id', '')::uuid;
  elsif tg_table_name = 'video_sources' then
    select v.organization_id
    into event_organization_id
    from public.videos v
    where v.id = nullif(row_data ->> 'video_id', '')::uuid;
  else
    event_organization_id := nullif(row_data ->> 'organization_id', '')::uuid;
  end if;

  event_entity_id := coalesce(
    row_data ->> 'id',
    row_data ->> 'video_id',
    row_data ->> 'section_id',
    row_data ->> 'user_id',
    row_data ->> 'organization_id'
  );

  if event_organization_id is not null then
    insert into public.audit_events (
      organization_id,
      actor_user_id,
      action,
      entity_type,
      entity_id
    )
    values (
      event_organization_id,
      auth.uid(),
      lower(tg_op),
      tg_table_name,
      event_entity_id
    );
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$$;

drop trigger if exists organizations_set_updated_at on public.organizations;
create trigger organizations_set_updated_at
before update on public.organizations
for each row execute function private.set_updated_at();

drop trigger if exists app_settings_set_updated_at on public.app_settings;
create trigger app_settings_set_updated_at
before update on public.app_settings
for each row execute function private.set_updated_at();

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function private.set_updated_at();

drop trigger if exists sections_set_updated_at on public.sections;
create trigger sections_set_updated_at
before update on public.sections
for each row execute function private.set_updated_at();

drop trigger if exists sections_create_default_roles on public.sections;
create trigger sections_create_default_roles
after insert on public.sections
for each row execute function private.create_default_section_roles();

drop trigger if exists section_roles_set_updated_at on public.section_roles;
create trigger section_roles_set_updated_at
before update on public.section_roles
for each row execute function private.set_updated_at();

drop trigger if exists videos_set_audit_fields on public.videos;
create trigger videos_set_audit_fields
before insert or update on public.videos
for each row execute function private.set_video_audit_fields();

drop trigger if exists video_sources_set_updated_at on public.video_sources;
create trigger video_sources_set_updated_at
before update on public.video_sources
for each row execute function private.set_updated_at();

drop trigger if exists video_assignments_set_updated_at on public.video_assignments;
create trigger video_assignments_set_updated_at
before update on public.video_assignments
for each row execute function private.set_updated_at();

drop trigger if exists role_access_codes_set_updated_at on private.role_access_codes;
create trigger role_access_codes_set_updated_at
before update on private.role_access_codes
for each row execute function private.set_updated_at();

drop trigger if exists organizations_audit on public.organizations;
create trigger organizations_audit
after insert or update on public.organizations
for each row execute function private.record_audit_event();

drop trigger if exists app_settings_audit on public.app_settings;
create trigger app_settings_audit
after insert or update or delete on public.app_settings
for each row execute function private.record_audit_event();

drop trigger if exists profiles_audit on public.profiles;
create trigger profiles_audit
after insert or update or delete on public.profiles
for each row execute function private.record_audit_event();

drop trigger if exists sections_audit on public.sections;
create trigger sections_audit
after insert or update or delete on public.sections
for each row execute function private.record_audit_event();

drop trigger if exists section_roles_audit on public.section_roles;
create trigger section_roles_audit
after insert or update or delete on public.section_roles
for each row execute function private.record_audit_event();

drop trigger if exists videos_audit on public.videos;
create trigger videos_audit
after insert or update or delete on public.videos
for each row execute function private.record_audit_event();

drop trigger if exists video_sources_audit on public.video_sources;
create trigger video_sources_audit
after insert or update or delete on public.video_sources
for each row execute function private.record_audit_event();

drop trigger if exists video_assignments_audit on public.video_assignments;
create trigger video_assignments_audit
after insert or update or delete on public.video_assignments
for each row execute function private.record_audit_event();

create or replace function private.current_role()
returns public.app_role
language sql
stable
security definer
set search_path = ''
as $$
  select p.role
  from public.profiles p
  where p.user_id = (select auth.uid())
    and p.active
  limit 1
$$;

create or replace function private.current_organization_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.organization_id
  from public.profiles p
  join public.organizations o on o.id = p.organization_id
  where p.user_id = (select auth.uid())
    and p.active
    and o.active
  limit 1
$$;

create or replace function private.is_admin_for(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    p_organization_id = private.current_organization_id()
    and private.current_role() = 'admin'::public.app_role,
    false
  )
$$;

create or replace function private.can_view_section(p_section_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    exists (
      select 1
      from public.sections s
      where s.id = p_section_id
        and (
          private.is_admin_for(s.organization_id)
          or (
            s.organization_id = private.current_organization_id()
            and s.active
            and exists (
              select 1
              from public.section_roles sr
              where sr.section_id = s.id
                and sr.organization_id = s.organization_id
                and sr.role = private.current_role()
                and sr.visible
            )
          )
        )
    ),
    false
  )
$$;

create or replace function private.can_view_video_card(p_video_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    exists (
      select 1
      from public.videos v
      where v.id = p_video_id
        and (
          private.is_admin_for(v.organization_id)
          or (
            v.organization_id = private.current_organization_id()
            and v.active
            and exists (
              select 1
              from public.video_assignments va
              join public.sections s
                on s.id = va.section_id
               and s.organization_id = va.organization_id
              join public.section_roles sr
                on sr.section_id = va.section_id
               and sr.organization_id = va.organization_id
               and sr.role = va.role
              where va.video_id = v.id
                and va.organization_id = v.organization_id
                and va.role = private.current_role()
                and va.visible
                and s.active
                and sr.visible
            )
          )
        )
    ),
    false
  )
$$;

create or replace function private.can_play_video(p_video_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    exists (
      select 1
      from public.videos v
      where v.id = p_video_id
        and (
          private.is_admin_for(v.organization_id)
          or (
            v.organization_id = private.current_organization_id()
            and v.active
            and exists (
              select 1
              from public.video_assignments va
              join public.sections s
                on s.id = va.section_id
               and s.organization_id = va.organization_id
              join public.section_roles sr
                on sr.section_id = va.section_id
               and sr.organization_id = va.organization_id
               and sr.role = va.role
              where va.video_id = v.id
                and va.organization_id = v.organization_id
                and va.role = private.current_role()
                and va.visible
                and not va.is_locked
                and s.active
                and sr.visible
            )
          )
        )
    ),
    false
  )
$$;

create or replace function private.storage_video_id(p_object_name text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
begin
  return split_part(p_object_name, '/', 1)::uuid;
exception
  when invalid_text_representation then return null;
end
$$;

create or replace function private.can_read_storage_object(
  p_bucket_id text,
  p_object_name text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    exists (
      select 1
      from public.video_sources vs
      where vs.provider = 'supabase_storage'::public.video_provider
        and vs.storage_bucket = p_bucket_id
        and vs.storage_object_path = p_object_name
        and private.can_play_video(vs.video_id)
    ),
    false
  )
$$;

revoke execute on function private.current_role() from public, anon;
revoke execute on function private.current_organization_id() from public, anon;
revoke execute on function private.is_admin_for(uuid) from public, anon;
revoke execute on function private.can_view_section(uuid) from public, anon;
revoke execute on function private.can_view_video_card(uuid) from public, anon;
revoke execute on function private.can_play_video(uuid) from public, anon;
revoke execute on function private.storage_video_id(text) from public, anon;
revoke execute on function private.can_read_storage_object(text, text) from public, anon;

grant execute on function private.current_role() to authenticated;
grant execute on function private.current_organization_id() to authenticated;
grant execute on function private.is_admin_for(uuid) to authenticated;
grant execute on function private.can_view_section(uuid) to authenticated;
grant execute on function private.can_view_video_card(uuid) to authenticated;
grant execute on function private.can_play_video(uuid) to authenticated;
grant execute on function private.storage_video_id(text) to authenticated;
grant execute on function private.can_read_storage_object(text, text) to authenticated;

create or replace function public.get_my_access_context()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'userId', p.user_id,
    'organizationId', p.organization_id,
    'organization', o.name,
    'role', p.role,
    'displayName', p.display_name,
    'active', p.active
  )
  from public.profiles p
  join public.organizations o on o.id = p.organization_id
  where p.user_id = (select auth.uid())
    and p.active
    and o.active
  limit 1
$$;

create or replace function public.service_lookup_access_code(p_code_fingerprint text)
returns table (
  auth_user_id uuid,
  organization_id uuid,
  role public.app_role
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.auth_user_id, c.organization_id, c.role
  from private.role_access_codes c
  join public.organizations o on o.id = c.organization_id
  join public.profiles p
    on p.user_id = c.auth_user_id
   and p.organization_id = c.organization_id
   and p.role = c.role
  where c.code_fingerprint = p_code_fingerprint
    and c.active
    and p.active
    and (c.expires_at is null or c.expires_at > now())
    and o.active
  limit 1
$$;

create or replace function public.service_upsert_access_code(
  p_organization_id uuid,
  p_role public.app_role,
  p_auth_user_id uuid,
  p_code_fingerprint text,
  p_code_hint text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.profiles p
    where p.user_id = p_auth_user_id
      and p.organization_id = p_organization_id
      and p.role = p_role
      and p.active
  ) then
    raise exception 'Access-code user must match the active organization and role'
      using errcode = '23514';
  end if;

  insert into private.role_access_codes (
    organization_id,
    role,
    auth_user_id,
    code_fingerprint,
    code_hint,
    active,
    expires_at,
    rotated_at
  )
  values (
    p_organization_id,
    p_role,
    p_auth_user_id,
    p_code_fingerprint,
    p_code_hint,
    true,
    null,
    now()
  )
  on conflict (organization_id, role) do update
  set auth_user_id = excluded.auth_user_id,
      code_fingerprint = excluded.code_fingerprint,
      code_hint = excluded.code_hint,
      active = true,
      expires_at = null,
      rotated_at = now(),
      updated_at = now();
end
$$;

-- Rota las tres huellas como una sola operación de base de datos: si una
-- validación o escritura falla, PostgreSQL revierte las tres. Las contraseñas
-- de Supabase Auth viven fuera de esta transacción y deben coordinarse desde el
-- servicio que invoca esta RPC.
create or replace function public.service_rotate_access_codes(
  p_organization_id uuid,
  p_admin_auth_user_id uuid,
  p_admin_code_fingerprint text,
  p_operator_auth_user_id uuid,
  p_operator_code_fingerprint text,
  p_boss_auth_user_id uuid,
  p_boss_code_fingerprint text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fingerprints text[] := array[
    p_admin_code_fingerprint,
    p_operator_code_fingerprint,
    p_boss_code_fingerprint
  ];
begin
  if exists (
    select 1
    from unnest(v_fingerprints) as fingerprint(value)
    where fingerprint.value is null
       or fingerprint.value !~ '^[a-f0-9]{64}$'
  ) then
    raise exception 'Invalid code fingerprint' using errcode = '22023';
  end if;

  if (
    select count(distinct fingerprint.value)
    from unnest(v_fingerprints) as fingerprint(value)
  ) <> 3 then
    raise exception 'Access-code fingerprints must be unique'
      using errcode = '23505';
  end if;

  -- Libera primero las huellas únicas actuales dentro de la misma transacción.
  -- Así también se permite intercambiar códigos entre roles sin una colisión
  -- intermedia; estos valores temporales nunca son visibles tras un rollback.
  update private.role_access_codes c
  set code_fingerprint =
        replace(gen_random_uuid()::text, '-', '')
        || replace(gen_random_uuid()::text, '-', ''),
      updated_at = now()
  where c.organization_id = p_organization_id
    and c.role in ('admin', 'operator', 'boss');

  perform public.service_upsert_access_code(
    p_organization_id,
    'admin'::public.app_role,
    p_admin_auth_user_id,
    p_admin_code_fingerprint,
    null
  );
  perform public.service_upsert_access_code(
    p_organization_id,
    'operator'::public.app_role,
    p_operator_auth_user_id,
    p_operator_code_fingerprint,
    null
  );
  perform public.service_upsert_access_code(
    p_organization_id,
    'boss'::public.app_role,
    p_boss_auth_user_id,
    p_boss_code_fingerprint,
    null
  );
end
$$;

comment on function public.service_rotate_access_codes(
  uuid, uuid, text, uuid, text, uuid, text
) is 'Atomically rotates the admin, operator, and boss database fingerprints; Auth password changes are external.';

create or replace function public.service_record_access_attempt(
  p_organization_id uuid,
  p_code_fingerprint text,
  p_ip_fingerprint text,
  p_succeeded boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_code_fingerprint is not null
    and p_code_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid code fingerprint' using errcode = '22023';
  end if;

  insert into private.access_attempts (
    organization_id,
    code_fingerprint,
    ip_fingerprint,
    succeeded
  )
  values (
    p_organization_id,
    p_code_fingerprint,
    p_ip_fingerprint,
    p_succeeded
  );
end
$$;

create or replace function public.service_count_recent_failures(
  p_code_fingerprint text,
  p_ip_fingerprint text,
  p_window_seconds integer default 900
)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
  from private.access_attempts a
  where not a.succeeded
    and a.attempted_at >= now() - make_interval(
      secs => greatest(60, least(coalesce(p_window_seconds, 900), 86400))
    )
    and (
      (p_code_fingerprint is not null and a.code_fingerprint = p_code_fingerprint)
      or
      (p_ip_fingerprint is not null and a.ip_fingerprint = p_ip_fingerprint)
    )
$$;

revoke all on function public.get_my_access_context() from public, anon;
grant execute on function public.get_my_access_context() to authenticated;

revoke all on function public.service_lookup_access_code(text)
  from public, anon, authenticated;
revoke all on function public.service_upsert_access_code(uuid, public.app_role, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.service_rotate_access_codes(uuid, uuid, text, uuid, text, uuid, text)
  from public, anon, authenticated;
revoke all on function public.service_record_access_attempt(uuid, text, text, boolean)
  from public, anon, authenticated;
revoke all on function public.service_count_recent_failures(text, text, integer)
  from public, anon, authenticated;
grant execute on function public.service_lookup_access_code(text) to service_role;
grant execute on function public.service_upsert_access_code(uuid, public.app_role, uuid, text, text)
  to service_role;
grant execute on function public.service_rotate_access_codes(uuid, uuid, text, uuid, text, uuid, text)
  to service_role;
grant execute on function public.service_record_access_attempt(uuid, text, text, boolean)
  to service_role;
grant execute on function public.service_count_recent_failures(text, text, integer)
  to service_role;

alter table public.organizations enable row level security;
alter table public.app_settings enable row level security;
alter table public.profiles enable row level security;
alter table public.sections enable row level security;
alter table public.section_roles enable row level security;
alter table public.videos enable row level security;
alter table public.video_sources enable row level security;
alter table public.video_assignments enable row level security;
alter table public.audit_events enable row level security;
alter table private.role_access_codes enable row level security;
alter table private.access_attempts enable row level security;

drop policy if exists organizations_read_current on public.organizations;
create policy organizations_read_current
on public.organizations for select to authenticated
using (id = (select private.current_organization_id()));

drop policy if exists organizations_admin_update on public.organizations;
create policy organizations_admin_update
on public.organizations for update to authenticated
using ((select private.is_admin_for(id)))
with check ((select private.is_admin_for(id)));

drop policy if exists app_settings_read_current on public.app_settings;
create policy app_settings_read_current
on public.app_settings for select to authenticated
using (organization_id = (select private.current_organization_id()));

drop policy if exists app_settings_admin_write on public.app_settings;
create policy app_settings_admin_write
on public.app_settings for all to authenticated
using ((select private.is_admin_for(organization_id)))
with check ((select private.is_admin_for(organization_id)));

drop policy if exists profiles_read_self_or_admin on public.profiles;
create policy profiles_read_self_or_admin
on public.profiles for select to authenticated
using (
  user_id = (select auth.uid())
  or (select private.is_admin_for(organization_id))
);

drop policy if exists sections_read_allowed on public.sections;
create policy sections_read_allowed
on public.sections for select to authenticated
using ((select private.can_view_section(id)));

drop policy if exists sections_admin_write on public.sections;
create policy sections_admin_write
on public.sections for all to authenticated
using ((select private.is_admin_for(organization_id)))
with check ((select private.is_admin_for(organization_id)));

drop policy if exists section_roles_read_allowed on public.section_roles;
create policy section_roles_read_allowed
on public.section_roles for select to authenticated
using (
  (select private.is_admin_for(organization_id))
  or (
    organization_id = (select private.current_organization_id())
    and role = (select private.current_role())
    and visible
    and (select private.can_view_section(section_id))
  )
);

drop policy if exists section_roles_admin_write on public.section_roles;
create policy section_roles_admin_write
on public.section_roles for all to authenticated
using ((select private.is_admin_for(organization_id)))
with check ((select private.is_admin_for(organization_id)));

drop policy if exists videos_read_allowed on public.videos;
create policy videos_read_allowed
on public.videos for select to authenticated
using ((select private.can_view_video_card(id)));

drop policy if exists videos_admin_write on public.videos;
create policy videos_admin_write
on public.videos for all to authenticated
using ((select private.is_admin_for(organization_id)))
with check ((select private.is_admin_for(organization_id)));

drop policy if exists video_assignments_read_allowed on public.video_assignments;
create policy video_assignments_read_allowed
on public.video_assignments for select to authenticated
using (
  (select private.is_admin_for(organization_id))
  or (
    organization_id = (select private.current_organization_id())
    and role = (select private.current_role())
    and (select private.can_view_video_card(video_id))
  )
);

drop policy if exists video_assignments_admin_write on public.video_assignments;
create policy video_assignments_admin_write
on public.video_assignments for all to authenticated
using ((select private.is_admin_for(organization_id)))
with check ((select private.is_admin_for(organization_id)));

drop policy if exists video_sources_read_playable on public.video_sources;
create policy video_sources_read_playable
on public.video_sources for select to authenticated
using ((select private.can_play_video(video_id)));

drop policy if exists video_sources_admin_write on public.video_sources;
create policy video_sources_admin_write
on public.video_sources for all to authenticated
using (
  exists (
    select 1 from public.videos v
    where v.id = video_id
      and (select private.is_admin_for(v.organization_id))
  )
)
with check (
  exists (
    select 1 from public.videos v
    where v.id = video_id
      and (select private.is_admin_for(v.organization_id))
  )
);

drop policy if exists audit_events_admin_read on public.audit_events;
create policy audit_events_admin_read
on public.audit_events for select to authenticated
using ((select private.is_admin_for(organization_id)));

revoke all on public.organizations,
  public.app_settings,
  public.profiles,
  public.sections,
  public.section_roles,
  public.videos,
  public.video_sources,
  public.video_assignments,
  public.audit_events
from anon;

grant select, update on public.organizations to authenticated;
grant select, insert, update, delete on public.app_settings to authenticated;
grant select on public.profiles to authenticated;
grant select, insert, update, delete on public.sections to authenticated;
grant select, insert, update, delete on public.section_roles to authenticated;
grant select, insert, update, delete on public.videos to authenticated;
grant select, insert, update, delete on public.video_sources to authenticated;
grant select, insert, update, delete on public.video_assignments to authenticated;
grant select on public.audit_events to authenticated;

grant all on public.organizations,
  public.app_settings,
  public.profiles,
  public.sections,
  public.section_roles,
  public.videos,
  public.video_sources,
  public.video_assignments,
  public.audit_events
to service_role;

grant all on private.role_access_codes,
  private.access_attempts
to service_role;

grant usage, select on sequence public.audit_events_id_seq to service_role;
grant usage, select on sequence private.access_attempts_id_seq to service_role;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'video-assets',
  'video-assets',
  false,
  524288000,
  array[
    'video/mp4',
    'video/webm',
    'video/ogg',
    'image/jpeg',
    'image/png',
    'image/webp'
  ]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists video_assets_read_playable on storage.objects;
create policy video_assets_read_playable
on storage.objects for select to authenticated
using (
  bucket_id = 'video-assets'
  and (select private.can_read_storage_object(bucket_id, name))
);

drop policy if exists video_assets_admin_insert on storage.objects;
create policy video_assets_admin_insert
on storage.objects for insert to authenticated
with check (
  bucket_id = 'video-assets'
  and exists (
    select 1
    from public.videos v
    where v.id = private.storage_video_id(name)
      and (select private.is_admin_for(v.organization_id))
  )
);

drop policy if exists video_assets_admin_update on storage.objects;
create policy video_assets_admin_update
on storage.objects for update to authenticated
using (
  bucket_id = 'video-assets'
  and exists (
    select 1
    from public.videos v
    where v.id = private.storage_video_id(name)
      and (select private.is_admin_for(v.organization_id))
  )
)
with check (
  bucket_id = 'video-assets'
  and exists (
    select 1
    from public.videos v
    where v.id = private.storage_video_id(name)
      and (select private.is_admin_for(v.organization_id))
  )
);

drop policy if exists video_assets_admin_delete on storage.objects;
create policy video_assets_admin_delete
on storage.objects for delete to authenticated
using (
  bucket_id = 'video-assets'
  and exists (
    select 1
    from public.videos v
    where v.id = private.storage_video_id(name)
      and (select private.is_admin_for(v.organization_id))
  )
);

commit;
