begin;

-- Progreso de reproducción por usuario individual. Un video cuenta como
-- "visto" cuando el usuario alcanza al menos la mitad de su duración
-- (videos.duration_seconds). El cliente solo reporta segundos alcanzados;
-- el trigger decide "completed" con la duración real guardada en videos,
-- para que el admin no dependa de un cálculo hecho en el navegador.
create table public.video_watch_progress (
  video_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  max_progress_seconds integer not null default 0 check (max_progress_seconds >= 0),
  completed boolean not null default false,
  first_watched_at timestamptz not null default now(),
  last_watched_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (video_id, user_id),
  foreign key (video_id) references public.videos(id) on delete cascade
);

create index if not exists video_watch_progress_org_idx
  on public.video_watch_progress(organization_id, completed);

create index if not exists video_watch_progress_user_idx
  on public.video_watch_progress(user_id, completed);

create or replace function private.set_video_watch_progress_fields()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_organization_id uuid;
  v_duration_seconds integer;
  v_previous_max integer := 0;
  v_previous_completed boolean := false;
  v_previous_first_watched_at timestamptz;
begin
  select v.organization_id, v.duration_seconds
  into v_organization_id, v_duration_seconds
  from public.videos v
  where v.id = new.video_id;

  if v_organization_id is null then
    raise exception 'Unknown video' using errcode = '23503';
  end if;

  if tg_op = 'UPDATE' then
    v_previous_max := old.max_progress_seconds;
    v_previous_completed := old.completed;
    v_previous_first_watched_at := old.first_watched_at;
  end if;

  new.organization_id := v_organization_id;
  new.max_progress_seconds := greatest(new.max_progress_seconds, v_previous_max);
  new.completed := v_previous_completed or (
    v_duration_seconds is not null
    and v_duration_seconds > 0
    and new.max_progress_seconds >= ceil(v_duration_seconds / 2.0)
  );
  new.first_watched_at := coalesce(v_previous_first_watched_at, now());
  new.last_watched_at := now();
  new.updated_at := now();

  return new;
end
$$;

drop trigger if exists video_watch_progress_set_fields on public.video_watch_progress;
create trigger video_watch_progress_set_fields
before insert or update on public.video_watch_progress
for each row execute function private.set_video_watch_progress_fields();

-- Sin trigger de auditoría a propósito: los reportes de progreso llegan cada
-- pocos segundos por cada video en reproducción y saturarían audit_events,
-- que está pensado para acciones administrativas, no telemetría de vistas.
alter table public.video_watch_progress enable row level security;

drop policy if exists video_watch_progress_read_self_or_admin on public.video_watch_progress;
create policy video_watch_progress_read_self_or_admin
on public.video_watch_progress for select to authenticated
using (
  user_id = (select auth.uid())
  or (select private.is_admin_for(organization_id))
);

drop policy if exists video_watch_progress_insert_self on public.video_watch_progress;
create policy video_watch_progress_insert_self
on public.video_watch_progress for insert to authenticated
with check (
  user_id = (select auth.uid())
  and (select private.can_play_video(video_id))
);

drop policy if exists video_watch_progress_update_self on public.video_watch_progress;
create policy video_watch_progress_update_self
on public.video_watch_progress for update to authenticated
using (user_id = (select auth.uid()))
with check (
  user_id = (select auth.uid())
  and (select private.can_play_video(video_id))
);

revoke all on public.video_watch_progress from anon;
grant select, insert, update on public.video_watch_progress to authenticated;
grant all on public.video_watch_progress to service_role;

commit;
