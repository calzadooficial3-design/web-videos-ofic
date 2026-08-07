begin;

-- La duración es opcional al crear un video: si el admin la deja en blanco,
-- `videos.duration_seconds` queda en NULL y el trigger de progreso nunca
-- puede calcular "la mitad del video" sin importar cuánto se reproduzca.
-- Cuando el reproductor sí conoce la duración real (archivo nativo o
-- YouTube, vía su API oficial), la reporta junto al progreso; el trigger la
-- usa para autocompletar videos.duration_seconds una sola vez.
alter table public.video_watch_progress
  add column if not exists reported_duration_seconds integer;

do $$
begin
  alter table public.video_watch_progress
    add constraint video_watch_progress_reported_duration_check
    check (reported_duration_seconds is null or reported_duration_seconds > 0);
exception
  when duplicate_object then null;
end
$$;

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

  if v_duration_seconds is null
    and new.reported_duration_seconds is not null
    and new.reported_duration_seconds > 0 then
    update public.videos
    set duration_seconds = new.reported_duration_seconds
    where id = new.video_id
      and duration_seconds is null;
    v_duration_seconds := new.reported_duration_seconds;
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

commit;
