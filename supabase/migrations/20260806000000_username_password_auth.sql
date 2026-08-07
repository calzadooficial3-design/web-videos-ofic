begin;

-- Habilita cuentas individuales (usuario + contraseña real de Supabase Auth)
-- en vez del código de acceso compartido por rol. `private.role_access_codes`
-- y sus RPC quedan sin uso pero no se eliminan en esta migración.
alter table public.profiles
  add column if not exists username text;

do $$
begin
  alter table public.profiles
    add constraint profiles_username_format_check
    check (username is null or username ~ '^[a-z0-9._-]{3,32}$');
exception
  when duplicate_object then null;
end
$$;

-- Permite múltiples perfiles sin username (los ya existentes) mientras exige
-- unicidad entre los que sí lo tienen.
create unique index if not exists profiles_username_unique_idx
  on public.profiles (username)
  where username is not null;

-- La migración 20260804010000 restringió current_role()/current_organization_id()/
-- get_my_access_context() a sesiones "otp" (login por código con magic link).
-- El login ahora usa signInWithPassword, cuyo JWT trae amr method "password",
-- así que ese candado bloquearía a todos los usuarios. Se reemplaza por un
-- candado equivalente para sesiones de contraseña.
create or replace function private.is_password_session()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1
    from jsonb_array_elements(
      coalesce((select auth.jwt()) -> 'amr', '[]'::jsonb)
    ) as authentication_method
    where authentication_method ->> 'method' = 'password'
  )
$$;

create or replace function private.current_role()
returns public.app_role
language sql
stable
security definer
set search_path = ''
as $$
  select p.role
  from public.profiles p
  where private.is_password_session()
    and p.user_id = (select auth.uid())
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
  where private.is_password_session()
    and p.user_id = (select auth.uid())
    and p.active
    and o.active
  limit 1
$$;

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
  where private.is_password_session()
    and p.user_id = (select auth.uid())
    and p.active
    and o.active
  limit 1
$$;

revoke all on function private.is_password_session() from public, anon;
grant execute on function private.is_password_session() to authenticated;

revoke all on function public.get_my_access_context() from public, anon;
grant execute on function public.get_my_access_context() to authenticated;

commit;
