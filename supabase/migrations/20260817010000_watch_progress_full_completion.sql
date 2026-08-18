begin;

-- Antes, un video contaba como "visto" al alcanzar la mitad de su duración.
-- Ahora se exige el 100%. Además de comparar segundos contra
-- `videos.duration_seconds` (que el admin pudo escribir a mano y quedar unos
-- segundos desalineado con la duración real del archivo), el cliente reporta
-- explícitamente cuándo el reproductor emitió su evento de fin de
-- reproducción (`ended` nativo / `ENDED` de YouTube). Esa señal es la fuente
-- de verdad más confiable de "se vio completo" y nunca depende de que la
-- duración guardada coincida al segundo.
alter table public.video_watch_progress
  add column if not exists reported_ended boolean not null default false;

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
  v_previous_ended boolean := false;
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
    v_previous_ended := old.reported_ended;
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
  new.reported_ended := v_previous_ended or new.reported_ended;
  new.completed := v_previous_completed or new.reported_ended or (
    v_duration_seconds is not null
    and v_duration_seconds > 0
    and new.max_progress_seconds >= v_duration_seconds
  );
  new.first_watched_at := coalesce(v_previous_first_watched_at, now());
  new.last_watched_at := now();
  new.updated_at := now();

  return new;
end
$$;

commit;
