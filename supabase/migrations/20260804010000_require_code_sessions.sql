-- Solo las sesiones emitidas por login-with-code (magic link/OTP) pueden usar
-- los roles del Video Hub. Esto bloquea un posible signInWithPassword directo,
-- aunque un usuario autenticado intentara establecer su propia contraseña.

create or replace function private.is_code_session()
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
    where authentication_method ->> 'method' = 'otp'
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
  where private.is_code_session()
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
  where private.is_code_session()
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
  where private.is_code_session()
    and p.user_id = (select auth.uid())
    and p.active
    and o.active
  limit 1
$$;

-- Reaplica la función para instalaciones que ejecutaron la migración base
-- antes del hardening: toda rotación reactiva el código y elimina expiraciones
-- anteriores que podrían impedir un inicio de sesión válido.
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

revoke all on function private.is_code_session() from public, anon;
grant execute on function private.is_code_session() to authenticated;

revoke all on function public.get_my_access_context() from public, anon;
grant execute on function public.get_my_access_context() to authenticated;

revoke all on function public.service_upsert_access_code(uuid, public.app_role, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.service_rotate_access_codes(uuid, uuid, text, uuid, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.service_upsert_access_code(uuid, public.app_role, uuid, text, text)
  to service_role;
grant execute on function public.service_rotate_access_codes(uuid, uuid, text, uuid, text, uuid, text)
  to service_role;
