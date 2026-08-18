begin;

-- Ajuste de organización: exige (o no) tomarse una foto justo antes de
-- responder el cuestionario de un video, para dejar evidencia de quién lo
-- respondió. Se guarda junto al resto de la configuración general.
alter table public.app_settings
  add column if not exists require_quiz_photo boolean not null default false;

-- Cada intento de cuestionario puede llevar asociada la foto tomada al
-- iniciarlo (null si la organización no exige foto).
alter table public.video_quiz_attempts
  add column if not exists photo_path text;

-- Bucket privado para las fotos: solo el propio usuario (al subirla) y los
-- administradores de su organización pueden leerlas; nadie puede navegarlo
-- públicamente.
insert into storage.buckets (id, name, public)
values ('quiz-photos', 'quiz-photos', false)
on conflict (id) do nothing;

-- La ruta de cada objeto es "{organization_id}/{user_id}/{video_id}/archivo.jpg",
-- así que basta con leer los dos primeros segmentos de la ruta para aplicar
-- el mismo criterio de "propio o admin" que el resto de las tablas.
drop policy if exists quiz_photos_insert_own on storage.objects;
create policy quiz_photos_insert_own
on storage.objects for insert to authenticated
with check (
  bucket_id = 'quiz-photos'
  and (storage.foldername(name))[1] = (private.current_organization_id())::text
  and (storage.foldername(name))[2] = (auth.uid())::text
);

drop policy if exists quiz_photos_read_own_or_admin on storage.objects;
create policy quiz_photos_read_own_or_admin
on storage.objects for select to authenticated
using (
  bucket_id = 'quiz-photos'
  and (
    (storage.foldername(name))[2] = (auth.uid())::text
    or private.is_admin_for(((storage.foldername(name))[1])::uuid)
  )
);

-- Reemplaza save_admin_snapshot solo para sumar require_quiz_photo al bloque
-- de configuración general; el resto de la función queda igual (mismo
-- comportamiento y garantías de la versión anterior).
create or replace function public.save_admin_snapshot(
  p_snapshot jsonb,
  p_expected_revision bigint
)
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_organization_id uuid := private.current_organization_id();
  v_organization_name text := nullif(btrim(p_snapshot ->> 'organization'), '');
  v_logo_url text := nullif(btrim(p_snapshot ->> 'logo_url'), '');
  v_current_revision bigint;
begin
  if v_organization_id is null
    or not private.is_admin_for(v_organization_id) then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;

  -- Serializa guardados simultáneos de la misma organización para que dos
  -- pestañas nunca intercalen operaciones dentro del snapshot.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_organization_id::text, 0)
  );

  select o.content_revision
  into v_current_revision
  from public.organizations o
  where o.id = v_organization_id
  for update;

  if v_current_revision is null
    or p_expected_revision is null
    or p_expected_revision <> v_current_revision then
    raise exception 'STALE_SNAPSHOT'
      using errcode = '40001',
            detail = 'The organization changed after this snapshot was loaded.';
  end if;

  if p_snapshot is null
    or coalesce(jsonb_typeof(p_snapshot -> 'sections'), '') <> 'array'
    or coalesce(jsonb_typeof(p_snapshot -> 'section_roles'), '') <> 'array'
    or coalesce(jsonb_typeof(p_snapshot -> 'videos'), '') <> 'array'
    or coalesce(jsonb_typeof(p_snapshot -> 'video_sources'), '') <> 'array'
    or coalesce(jsonb_typeof(p_snapshot -> 'video_assignments'), '') <> 'array' then
    raise exception 'Invalid admin snapshot' using errcode = '22023';
  end if;

  if jsonb_array_length(p_snapshot -> 'sections') > 500
    or jsonb_array_length(p_snapshot -> 'section_roles') > 1000
    or jsonb_array_length(p_snapshot -> 'videos') > 5000
    or jsonb_array_length(p_snapshot -> 'video_sources') > 5000
    or jsonb_array_length(p_snapshot -> 'video_assignments') > 10000 then
    raise exception 'Admin snapshot exceeds safe limits' using errcode = '54000';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_snapshot -> 'sections') as desired_section(id uuid)
    where (
      select count(distinct desired_role.role)
      from jsonb_to_recordset(p_snapshot -> 'section_roles') as desired_role(
        section_id uuid,
        role public.app_role
      )
      where desired_role.section_id = desired_section.id
        and desired_role.role in ('operator', 'boss')
    ) <> 2
  ) or exists (
    select 1
    from jsonb_to_recordset(p_snapshot -> 'section_roles') as desired_role(
      section_id uuid,
      role public.app_role
    )
    where not exists (
      select 1
      from jsonb_to_recordset(p_snapshot -> 'sections') as desired_section(id uuid)
      where desired_section.id = desired_role.section_id
    )
  ) then
    raise exception 'Section roles do not match the snapshot sections'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_snapshot -> 'videos') as desired_video(id uuid)
    where (
      select count(*)
      from jsonb_to_recordset(p_snapshot -> 'video_sources') as desired_source(video_id uuid)
      where desired_source.video_id = desired_video.id
    ) <> 1
  ) or exists (
    select 1
    from jsonb_to_recordset(p_snapshot -> 'video_sources') as desired_source(video_id uuid)
    where not exists (
      select 1
      from jsonb_to_recordset(p_snapshot -> 'videos') as desired_video(id uuid)
      where desired_video.id = desired_source.video_id
    )
  ) then
    raise exception 'Video sources do not match the snapshot videos'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_snapshot -> 'video_assignments') as desired_assignment(
      video_id uuid,
      section_id uuid
    )
    where not exists (
      select 1
      from jsonb_to_recordset(p_snapshot -> 'videos') as desired_video(id uuid)
      where desired_video.id = desired_assignment.video_id
    )
    or not exists (
      select 1
      from jsonb_to_recordset(p_snapshot -> 'sections') as desired_section(id uuid)
      where desired_section.id = desired_assignment.section_id
    )
  ) then
    raise exception 'Video assignments reference rows outside the snapshot'
      using errcode = '22023';
  end if;

  if v_organization_name is not null then
    update public.organizations o
    set name = v_organization_name,
        logo_url = v_logo_url
    where o.id = v_organization_id
      and (o.name, o.logo_url) is distinct from (v_organization_name, v_logo_url);
  end if;

  if jsonb_typeof(p_snapshot -> 'settings') = 'object' then
    insert into public.app_settings (
      organization_id,
      product_name,
      welcome_title,
      welcome_message,
      support_message,
      allow_light_mode,
      require_quiz_photo
    )
    values (
      v_organization_id,
      coalesce(nullif(btrim(p_snapshot #>> '{settings,product_name}'), ''), 'Video Hub'),
      coalesce(nullif(btrim(p_snapshot #>> '{settings,welcome_title}'), ''), 'Video Hub'),
      coalesce(btrim(p_snapshot #>> '{settings,welcome_message}'), ''),
      coalesce(btrim(p_snapshot #>> '{settings,support_message}'), ''),
      coalesce((p_snapshot #>> '{settings,allow_light_mode}')::boolean, true),
      coalesce((p_snapshot #>> '{settings,require_quiz_photo}')::boolean, false)
    )
    on conflict (organization_id) do update
    set product_name = excluded.product_name,
        welcome_title = excluded.welcome_title,
        welcome_message = excluded.welcome_message,
        support_message = excluded.support_message,
        allow_light_mode = excluded.allow_light_mode,
        require_quiz_photo = excluded.require_quiz_photo
    where (
      app_settings.product_name,
      app_settings.welcome_title,
      app_settings.welcome_message,
      app_settings.support_message,
      app_settings.allow_light_mode,
      app_settings.require_quiz_photo
    ) is distinct from (
      excluded.product_name,
      excluded.welcome_title,
      excluded.welcome_message,
      excluded.support_message,
      excluded.allow_light_mode,
      excluded.require_quiz_photo
    );
  end if;

  insert into public.sections (
    id, organization_id, name, slug, icon, sort_order, active
  )
  select
    row_data.id,
    v_organization_id,
    row_data.name,
    row_data.slug,
    coalesce(nullif(btrim(row_data.icon), ''), 'layers'),
    coalesce(row_data.sort_order, 0),
    coalesce(row_data.active, true)
  from jsonb_to_recordset(p_snapshot -> 'sections') as row_data(
    id uuid,
    name text,
    slug text,
    icon text,
    sort_order integer,
    active boolean
  )
  on conflict (id) do update
  set name = excluded.name,
      slug = excluded.slug,
      icon = excluded.icon,
      sort_order = excluded.sort_order,
      active = excluded.active
  where (
    sections.name,
    sections.slug,
    sections.icon,
    sections.sort_order,
    sections.active
  ) is distinct from (
    excluded.name,
    excluded.slug,
    excluded.icon,
    excluded.sort_order,
    excluded.active
  );

  insert into public.section_roles (
    section_id, organization_id, role, visible
  )
  select
    row_data.section_id,
    v_organization_id,
    row_data.role,
    coalesce(row_data.visible, false)
  from jsonb_to_recordset(p_snapshot -> 'section_roles') as row_data(
    section_id uuid,
    role public.app_role,
    visible boolean
  )
  on conflict (section_id, role) do update
  set visible = excluded.visible
  where section_roles.visible is distinct from excluded.visible;

  insert into public.videos (
    id,
    organization_id,
    title,
    description,
    duration_label,
    duration_seconds,
    featured,
    active,
    created_at
  )
  select
    row_data.id,
    v_organization_id,
    row_data.title,
    coalesce(row_data.description, ''),
    row_data.duration_label,
    row_data.duration_seconds,
    coalesce(row_data.featured, false),
    coalesce(row_data.active, true),
    coalesce(row_data.created_at, now())
  from jsonb_to_recordset(p_snapshot -> 'videos') as row_data(
    id uuid,
    title text,
    description text,
    duration_label text,
    duration_seconds integer,
    featured boolean,
    active boolean,
    created_at timestamptz
  )
  on conflict (id) do update
  set title = excluded.title,
      description = excluded.description,
      duration_label = excluded.duration_label,
      duration_seconds = excluded.duration_seconds,
      featured = excluded.featured,
      active = excluded.active
  where (
    videos.title,
    videos.description,
    videos.duration_label,
    videos.duration_seconds,
    videos.featured,
    videos.active
  ) is distinct from (
    excluded.title,
    excluded.description,
    excluded.duration_label,
    excluded.duration_seconds,
    excluded.featured,
    excluded.active
  );

  insert into public.video_sources (
    video_id,
    provider,
    source_ref,
    source_url,
    thumbnail_url,
    storage_bucket,
    storage_object_path,
    metadata
  )
  select
    row_data.video_id,
    row_data.provider,
    row_data.source_ref,
    row_data.source_url,
    row_data.thumbnail_url,
    row_data.storage_bucket,
    row_data.storage_object_path,
    coalesce(row_data.metadata, '{}'::jsonb)
  from jsonb_to_recordset(p_snapshot -> 'video_sources') as row_data(
    video_id uuid,
    provider public.video_provider,
    source_ref text,
    source_url text,
    thumbnail_url text,
    storage_bucket text,
    storage_object_path text,
    metadata jsonb
  )
  on conflict (video_id) do update
  set provider = excluded.provider,
      source_ref = excluded.source_ref,
      source_url = excluded.source_url,
      thumbnail_url = excluded.thumbnail_url,
      storage_bucket = excluded.storage_bucket,
      storage_object_path = excluded.storage_object_path,
      metadata = excluded.metadata
  where (
    video_sources.provider,
    video_sources.source_ref,
    video_sources.source_url,
    video_sources.thumbnail_url,
    video_sources.storage_bucket,
    video_sources.storage_object_path,
    video_sources.metadata
  ) is distinct from (
    excluded.provider,
    excluded.source_ref,
    excluded.source_url,
    excluded.thumbnail_url,
    excluded.storage_bucket,
    excluded.storage_object_path,
    excluded.metadata
  );

  insert into public.video_assignments (
    video_id,
    organization_id,
    role,
    section_id,
    visible,
    is_locked,
    sort_order
  )
  select
    row_data.video_id,
    v_organization_id,
    row_data.role,
    row_data.section_id,
    coalesce(row_data.visible, true),
    coalesce(row_data.is_locked, false),
    coalesce(row_data.sort_order, 0)
  from jsonb_to_recordset(p_snapshot -> 'video_assignments') as row_data(
    video_id uuid,
    role public.app_role,
    section_id uuid,
    visible boolean,
    is_locked boolean,
    sort_order integer
  )
  on conflict (video_id, role) do update
  set section_id = excluded.section_id,
      visible = excluded.visible,
      is_locked = excluded.is_locked,
      sort_order = excluded.sort_order
  where (
    video_assignments.section_id,
    video_assignments.visible,
    video_assignments.is_locked,
    video_assignments.sort_order
  ) is distinct from (
    excluded.section_id,
    excluded.visible,
    excluded.is_locked,
    excluded.sort_order
  );

  delete from public.video_assignments assignment
  using public.videos video
  where assignment.organization_id = v_organization_id
    and video.id = assignment.video_id
    and video.organization_id = v_organization_id
    and video.active
    and exists (
      select 1
      from jsonb_to_recordset(p_snapshot -> 'videos') as desired_video(id uuid)
      where desired_video.id = video.id
    )
    and not exists (
      select 1
      from jsonb_to_recordset(p_snapshot -> 'video_assignments') as desired(
        video_id uuid,
        role public.app_role
      )
      where desired.video_id = assignment.video_id
        and desired.role = assignment.role
    );

  update public.videos video
  set active = false
  where video.organization_id = v_organization_id
    and video.active
    and not exists (
      select 1
      from jsonb_to_recordset(p_snapshot -> 'videos') as desired(id uuid)
      where desired.id = video.id
    );

  update public.sections section
  set active = false
  where section.organization_id = v_organization_id
    and section.active
    and not exists (
      select 1
      from jsonb_to_recordset(p_snapshot -> 'sections') as desired(id uuid)
      where desired.id = section.id
    );

  update public.organizations o
  set content_revision = o.content_revision + 1
  where o.id = v_organization_id
  returning o.content_revision into v_current_revision;

  return v_current_revision;
end
$$;

-- submit_video_quiz_attempt suma un tercer parámetro (p_photo_path) para
-- guardar, si la organización lo exige, evidencia de que la foto se tomó
-- justo antes de este intento (objeto real en el bucket quiz-photos, dentro
-- de la carpeta de este usuario/organización, subido en los últimos 15
-- minutos). Se recrea la función completa porque cambia su firma.
drop function if exists public.submit_video_quiz_attempt(uuid, jsonb);

create function public.submit_video_quiz_attempt(
  p_video_id uuid,
  p_answers jsonb,
  p_photo_path text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_organization_id uuid;
  v_user_id uuid := auth.uid();
  v_passing_score integer;
  v_require_photo boolean := false;
  v_total_questions integer;
  v_correct_questions integer;
  v_unanswered_count integer;
  v_answers_detail jsonb;
  v_score_percent integer;
  v_passed boolean;
  v_previous_attempts integer := 0;
  v_previous_best integer := 0;
  v_previous_passed boolean := false;
  v_previous_first_passed_at timestamptz;
  v_next_first_passed_at timestamptz;
  v_next_attempt_number integer;
begin
  if v_user_id is null then
    raise exception 'Sesión requerida' using errcode = '28000';
  end if;

  if not (select private.can_play_video(p_video_id)) then
    raise exception 'No autorizado' using errcode = '42501';
  end if;

  select v.organization_id into v_organization_id from public.videos v where v.id = p_video_id;

  select vq.passing_score_percent into v_passing_score
  from public.video_quizzes vq
  where vq.video_id = p_video_id;

  if v_passing_score is null then
    raise exception 'Este video no tiene cuestionario.' using errcode = '22023';
  end if;

  select coalesce(s.require_quiz_photo, false) into v_require_photo
  from public.app_settings s
  where s.organization_id = v_organization_id;

  if v_require_photo then
    if p_photo_path is null or btrim(p_photo_path) = '' then
      raise exception 'Debes tomarte una foto antes de responder el cuestionario.' using errcode = '22023';
    end if;

    if not exists (
      select 1
      from storage.objects so
      where so.bucket_id = 'quiz-photos'
        and so.name = p_photo_path
        and so.name like (v_organization_id::text || '/' || v_user_id::text || '/%')
        and so.created_at >= now() - interval '15 minutes'
    ) then
      raise exception 'La foto del cuestionario no es válida o expiró. Vuelve a tomarla.' using errcode = '22023';
    end if;
  end if;

  if jsonb_typeof(p_answers) <> 'array' then
    raise exception 'Respuestas inválidas.' using errcode = '22023';
  end if;

  select
    count(*),
    count(*) filter (where so.is_correct is true),
    count(*) filter (where ans.option_id is null),
    jsonb_agg(
      jsonb_build_object(
        'questionId', q.id,
        'prompt', q.prompt,
        'selectedOptionId', ans.option_id,
        'selectedLabel', so.label,
        'isCorrect', coalesce(so.is_correct, false),
        'correctLabel', co.label
      ) order by q.sort_order
    )
  into v_total_questions, v_correct_questions, v_unanswered_count, v_answers_detail
  from private.quiz_questions q
  left join lateral (
    select nullif(a ->> 'optionId', '')::uuid as option_id
    from jsonb_array_elements(p_answers) a
    where nullif(a ->> 'questionId', '')::uuid = q.id
    limit 1
  ) ans on true
  left join private.quiz_question_options so
    on so.id = ans.option_id and so.question_id = q.id
  left join private.quiz_question_options co
    on co.question_id = q.id and co.is_correct = true
  where q.video_id = p_video_id;

  if coalesce(v_unanswered_count, 1) > 0 then
    raise exception 'Debes responder todas las preguntas.' using errcode = '22023';
  end if;

  v_score_percent := case when v_total_questions > 0
    then floor((v_correct_questions::numeric / v_total_questions) * 100)
    else 0 end;
  v_passed := v_score_percent >= v_passing_score;

  select attempts_count, best_score_percent, passed, first_passed_at
  into v_previous_attempts, v_previous_best, v_previous_passed, v_previous_first_passed_at
  from public.video_quiz_results
  where video_id = p_video_id and user_id = v_user_id;

  v_next_attempt_number := coalesce(v_previous_attempts, 0) + 1;
  v_next_first_passed_at := case
    when coalesce(v_previous_passed, false) then v_previous_first_passed_at
    when v_passed then now()
    else null
  end;

  insert into public.video_quiz_attempts (
    video_id, user_id, organization_id, attempt_number, score_percent, passed, answers, photo_path
  )
  values (
    p_video_id, v_user_id, v_organization_id, v_next_attempt_number,
    v_score_percent, v_passed, coalesce(v_answers_detail, '[]'::jsonb), p_photo_path
  );

  insert into public.video_quiz_results (
    video_id, user_id, organization_id, attempts_count, best_score_percent,
    passed, last_answers, last_attempt_at, first_passed_at, updated_at
  )
  values (
    p_video_id, v_user_id, v_organization_id,
    v_next_attempt_number,
    greatest(coalesce(v_previous_best, 0), v_score_percent),
    coalesce(v_previous_passed, false) or v_passed,
    coalesce(v_answers_detail, '[]'::jsonb),
    now(),
    v_next_first_passed_at,
    now()
  )
  on conflict (video_id, user_id) do update
  set attempts_count = excluded.attempts_count,
      best_score_percent = excluded.best_score_percent,
      passed = excluded.passed,
      last_answers = excluded.last_answers,
      last_attempt_at = excluded.last_attempt_at,
      first_passed_at = excluded.first_passed_at,
      updated_at = now();

  return jsonb_build_object(
    'scorePercent', v_score_percent,
    'correctCount', v_correct_questions,
    'totalQuestions', v_total_questions,
    'passed', v_passed,
    'passingScorePercent', v_passing_score,
    'attemptsCount', v_next_attempt_number,
    'bestScorePercent', greatest(coalesce(v_previous_best, 0), v_score_percent)
  );
end
$$;

revoke all on function public.submit_video_quiz_attempt(uuid, jsonb, text) from public, anon;
grant execute on function public.submit_video_quiz_attempt(uuid, jsonb, text) to authenticated;

commit;
