create extension if not exists pgcrypto;

create type public.app_role as enum ('admin', 'operator', 'boss');
create type public.video_provider as enum (
  'youtube',
  'google_drive',
  'vimeo',
  'loom',
  'direct',
  'supabase_storage'
);

create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role public.app_role not null,
  display_name text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.sections (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(trim(title)) between 1 and 100),
  slug text not null unique,
  icon text not null default 'layers',
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.section_roles (
  section_id uuid not null references public.sections(id) on delete cascade,
  role public.app_role not null check (role <> 'admin'),
  visible boolean not null default true,
  primary key (section_id, role)
);

create table public.videos (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(trim(title)) between 1 and 180),
  description text not null default '',
  provider public.video_provider not null,
  source_ref text not null,
  duration_label text,
  thumbnail_url text,
  featured boolean not null default false,
  active boolean not null default true,
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.video_assignments (
  video_id uuid not null references public.videos(id) on delete cascade,
  section_id uuid not null,
  role public.app_role not null check (role <> 'admin'),
  sort_order integer not null default 0,
  visible boolean not null default true,
  primary key (video_id, section_id, role),
  foreign key (section_id, role)
    references public.section_roles(section_id, role)
    on delete cascade
);

create index video_assignments_role_video_idx
  on public.video_assignments(role, video_id)
  where visible;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

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

create or replace function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    private.current_role() = 'admin'::public.app_role,
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
  select
    private.is_admin()
    or exists (
      select 1
      from public.section_roles sr
      join public.sections s on s.id = sr.section_id
      where sr.section_id = p_section_id
        and sr.role = private.current_role()
        and sr.visible
        and s.active
    )
$$;

create or replace function private.can_view_video(p_video_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    private.is_admin()
    or exists (
      select 1
      from public.video_assignments va
      join public.section_roles sr
        on sr.section_id = va.section_id
       and sr.role = va.role
      join public.sections s on s.id = va.section_id
      where va.video_id = p_video_id
        and va.role = private.current_role()
        and va.visible
        and sr.visible
        and s.active
    )
$$;

revoke execute on function private.current_role() from public, anon;
revoke execute on function private.is_admin() from public, anon;
revoke execute on function private.can_view_section(uuid) from public, anon;
revoke execute on function private.can_view_video(uuid) from public, anon;

grant execute on function private.current_role() to authenticated;
grant execute on function private.is_admin() to authenticated;
grant execute on function private.can_view_section(uuid) to authenticated;
grant execute on function private.can_view_video(uuid) to authenticated;

alter table public.profiles enable row level security;
alter table public.sections enable row level security;
alter table public.section_roles enable row level security;
alter table public.videos enable row level security;
alter table public.video_assignments enable row level security;

create policy profiles_read_self_or_admin
on public.profiles
for select to authenticated
using (
  user_id = (select auth.uid())
  or (select private.is_admin())
);

create policy sections_read_allowed
on public.sections
for select to authenticated
using (private.can_view_section(id));

create policy section_roles_read_allowed
on public.section_roles
for select to authenticated
using (
  (select private.is_admin())
  or (
    role = (select private.current_role())
    and visible
    and private.can_view_section(section_id)
  )
);

create policy videos_read_allowed
on public.videos
for select to authenticated
using (
  (select private.is_admin())
  or (active and private.can_view_video(id))
);

create policy assignments_read_allowed
on public.video_assignments
for select to authenticated
using (
  (select private.is_admin())
  or (
    role = (select private.current_role())
    and visible
    and private.can_view_section(section_id)
  )
);

create policy sections_admin_write
on public.sections
for all to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));

create policy section_roles_admin_write
on public.section_roles
for all to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));

create policy videos_admin_write
on public.videos
for all to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));

create policy assignments_admin_write
on public.video_assignments
for all to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));

grant select on public.profiles to authenticated;
grant select, insert, update, delete on public.sections to authenticated;
grant select, insert, update, delete on public.section_roles to authenticated;
grant select, insert, update, delete on public.videos to authenticated;
grant select, insert, update, delete on public.video_assignments to authenticated;
