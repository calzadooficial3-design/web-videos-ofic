begin;

-- Cuestionario opcional por video: el admin lo arma con preguntas de opción
-- múltiple (una respuesta correcta cada una) para comprobar que el usuario
-- realmente entendió el contenido, no solo que dejó el video reproduciéndose.
--
-- Las preguntas y opciones viven en el esquema `private` (igual que
-- `private.role_access_codes`) porque nunca deben leerse directamente desde
-- el cliente: si el usuario pudiera hacer `select` sobre las opciones vería
-- cuál está marcada como correcta antes de responder. Todo el acceso pasa por
-- funciones `security definer` que exponen solo lo que corresponde a cada rol.
create table if not exists public.video_quizzes (
  video_id uuid primary key references public.videos(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  passing_score_percent integer not null default 70
    check (passing_score_percent between 1 and 100),
  question_count integer not null default 0 check (question_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists private.quiz_questions (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references public.video_quizzes(video_id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  prompt text not null check (length(trim(prompt)) between 1 and 500),
  sort_order integer not null default 0 check (sort_order >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists private.quiz_question_options (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references private.quiz_questions(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  label text not null check (length(trim(label)) between 1 and 240),
  is_correct boolean not null default false,
  sort_order integer not null default 0 check (sort_order >= 0),
  created_at timestamptz not null default now()
);

-- Resultado del cuestionario por usuario y video. Igual que
-- `video_watch_progress`, es un upsert que nunca retrocede: el mejor puntaje
-- y el estado "aprobado" se conservan aunque un intento posterior sea peor.
create table if not exists public.video_quiz_results (
  video_id uuid not null references public.videos(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  attempts_count integer not null default 0 check (attempts_count >= 0),
  best_score_percent integer not null default 0 check (best_score_percent between 0 and 100),
  passed boolean not null default false,
  last_answers jsonb not null default '[]'::jsonb check (jsonb_typeof(last_answers) = 'array'),
  last_attempt_at timestamptz,
  first_passed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (video_id, user_id)
);

create index if not exists quiz_questions_video_idx on private.quiz_questions(video_id, sort_order);
create index if not exists quiz_question_options_question_idx on private.quiz_question_options(question_id, sort_order);
create index if not exists video_quiz_results_org_idx on public.video_quiz_results(organization_id, passed);
create index if not exists video_quiz_results_user_idx on public.video_quiz_results(user_id, passed);

-- Construye y valida el cuestionario completo de un video en una sola
-- operación atómica: borra las preguntas anteriores y reinserta las nuevas,
-- para que el editor administrativo nunca deje un cuestionario a medias.
create or replace function public.admin_save_video_quiz(
  p_video_id uuid,
  p_passing_score_percent integer,
  p_questions jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_organization_id uuid;
  v_question jsonb;
  v_option jsonb;
  v_question_id uuid;
  v_question_index integer := 0;
  v_option_index integer;
  v_correct_count integer;
begin
  select v.organization_id into v_organization_id
  from public.videos v
  where v.id = p_video_id;

  if v_organization_id is null or not (select private.is_admin_for(v_organization_id)) then
    raise exception 'No autorizado' using errcode = '42501';
  end if;

  if p_passing_score_percent is null or p_passing_score_percent < 1 or p_passing_score_percent > 100 then
    raise exception 'El puntaje mínimo para aprobar debe estar entre 1 y 100.' using errcode = '22023';
  end if;

  if jsonb_typeof(p_questions) <> 'array' or jsonb_array_length(p_questions) < 1 then
    raise exception 'El cuestionario necesita al menos una pregunta.' using errcode = '22023';
  end if;

  delete from public.video_quizzes where video_id = p_video_id;

  insert into public.video_quizzes (video_id, organization_id, passing_score_percent, question_count)
  values (p_video_id, v_organization_id, p_passing_score_percent, jsonb_array_length(p_questions));

  for v_question in select * from jsonb_array_elements(p_questions)
  loop
    if coalesce(length(trim(v_question ->> 'prompt')), 0) not between 1 and 500 then
      raise exception 'Cada pregunta necesita un enunciado de hasta 500 caracteres.' using errcode = '22023';
    end if;

    if jsonb_typeof(v_question -> 'options') <> 'array' or jsonb_array_length(v_question -> 'options') < 2 then
      raise exception 'Cada pregunta necesita al menos 2 opciones.' using errcode = '22023';
    end if;

    select count(*) into v_correct_count
    from jsonb_array_elements(v_question -> 'options') opt
    where (opt ->> 'isCorrect')::boolean is true;

    if v_correct_count <> 1 then
      raise exception 'Cada pregunta necesita exactamente una respuesta correcta.' using errcode = '22023';
    end if;

    v_question_id := gen_random_uuid();
    insert into private.quiz_questions (id, video_id, organization_id, prompt, sort_order)
    values (v_question_id, p_video_id, v_organization_id, trim(v_question ->> 'prompt'), v_question_index);

    v_option_index := 0;
    for v_option in select * from jsonb_array_elements(v_question -> 'options')
    loop
      if coalesce(length(trim(v_option ->> 'label')), 0) not between 1 and 240 then
        raise exception 'Cada opción necesita un texto de hasta 240 caracteres.' using errcode = '22023';
      end if;

      insert into private.quiz_question_options (
        id, question_id, organization_id, label, is_correct, sort_order
      )
      values (
        gen_random_uuid(),
        v_question_id,
        v_organization_id,
        trim(v_option ->> 'label'),
        coalesce((v_option ->> 'isCorrect')::boolean, false),
        v_option_index
      );
      v_option_index := v_option_index + 1;
    end loop;

    v_question_index := v_question_index + 1;
  end loop;

  return jsonb_build_object('ok', true, 'questionCount', v_question_index);
end
$$;

-- Devuelve el cuestionario completo (incluida la respuesta correcta) solo
-- para el administrador que lo está editando.
create or replace function public.admin_get_video_quiz(p_video_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_organization_id uuid;
  v_result jsonb;
begin
  select v.organization_id into v_organization_id
  from public.videos v
  where v.id = p_video_id;

  if v_organization_id is null or not (select private.is_admin_for(v_organization_id)) then
    raise exception 'No autorizado' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'videoId', vq.video_id,
    'passingScorePercent', vq.passing_score_percent,
    'questions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', q.id,
        'prompt', q.prompt,
        'options', (
          select jsonb_agg(
            jsonb_build_object('id', o.id, 'label', o.label, 'isCorrect', o.is_correct)
            order by o.sort_order
          )
          from private.quiz_question_options o
          where o.question_id = q.id
        )
      ) order by q.sort_order)
      from private.quiz_questions q
      where q.video_id = vq.video_id
    ), '[]'::jsonb)
  )
  into v_result
  from public.video_quizzes vq
  where vq.video_id = p_video_id;

  return v_result;
end
$$;

create or replace function public.admin_delete_video_quiz(p_video_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_organization_id uuid;
begin
  select v.organization_id into v_organization_id
  from public.videos v
  where v.id = p_video_id;

  if v_organization_id is null or not (select private.is_admin_for(v_organization_id)) then
    raise exception 'No autorizado' using errcode = '42501';
  end if;

  delete from public.video_quizzes where video_id = p_video_id;
end
$$;

-- Cuestionario "jugable": mismas preguntas y opciones, sin `is_correct`, y
-- solo si el video es reproducible para el rol actual.
create or replace function public.get_playable_video_quiz(p_video_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not (select private.can_play_video(p_video_id)) then
    raise exception 'No autorizado' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'videoId', vq.video_id,
    'passingScorePercent', vq.passing_score_percent,
    'questions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', q.id,
        'prompt', q.prompt,
        'options', (
          select jsonb_agg(jsonb_build_object('id', o.id, 'label', o.label) order by o.sort_order)
          from private.quiz_question_options o
          where o.question_id = q.id
        )
      ) order by q.sort_order)
      from private.quiz_questions q
      where q.video_id = vq.video_id
    ), '[]'::jsonb)
  )
  into v_result
  from public.video_quizzes vq
  where vq.video_id = p_video_id;

  return v_result;
end
$$;

-- Corrige las respuestas en el servidor (nunca confía en un puntaje
-- calculado por el navegador) y actualiza el resultado del usuario sin
-- perder nunca su mejor intento previo.
create or replace function public.submit_video_quiz_attempt(
  p_video_id uuid,
  p_answers jsonb
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
  v_total_questions integer;
  v_correct_questions integer := 0;
  v_answer jsonb;
  v_question_id uuid;
  v_option_id uuid;
  v_is_correct boolean;
  v_score_percent integer;
  v_passed boolean;
  v_previous_attempts integer := 0;
  v_previous_best integer := 0;
  v_previous_passed boolean := false;
  v_previous_first_passed_at timestamptz;
  v_next_first_passed_at timestamptz;
  v_answered_question_ids uuid[];
  v_unanswered_count integer;
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

  select count(*) into v_total_questions from private.quiz_questions q where q.video_id = p_video_id;

  if jsonb_typeof(p_answers) <> 'array' then
    raise exception 'Respuestas inválidas.' using errcode = '22023';
  end if;

  select array_agg(distinct nullif(answer ->> 'questionId', '')::uuid)
  into v_answered_question_ids
  from jsonb_array_elements(p_answers) answer;

  select count(*) into v_unanswered_count
  from private.quiz_questions q
  where q.video_id = p_video_id
    and not (q.id = any(coalesce(v_answered_question_ids, array[]::uuid[])));

  if v_unanswered_count > 0 then
    raise exception 'Debes responder todas las preguntas.' using errcode = '22023';
  end if;

  for v_answer in select * from jsonb_array_elements(p_answers)
  loop
    v_question_id := nullif(v_answer ->> 'questionId', '')::uuid;
    v_option_id := nullif(v_answer ->> 'optionId', '')::uuid;

    select o.is_correct into v_is_correct
    from private.quiz_question_options o
    join private.quiz_questions q on q.id = o.question_id
    where o.id = v_option_id
      and q.id = v_question_id
      and q.video_id = p_video_id;

    if v_is_correct is true then
      v_correct_questions := v_correct_questions + 1;
    end if;
  end loop;

  v_score_percent := case when v_total_questions > 0
    then floor((v_correct_questions::numeric / v_total_questions) * 100)
    else 0 end;
  v_passed := v_score_percent >= v_passing_score;

  select attempts_count, best_score_percent, passed, first_passed_at
  into v_previous_attempts, v_previous_best, v_previous_passed, v_previous_first_passed_at
  from public.video_quiz_results
  where video_id = p_video_id and user_id = v_user_id;

  v_next_first_passed_at := case
    when coalesce(v_previous_passed, false) then v_previous_first_passed_at
    when v_passed then now()
    else null
  end;

  insert into public.video_quiz_results (
    video_id, user_id, organization_id, attempts_count, best_score_percent,
    passed, last_answers, last_attempt_at, first_passed_at, updated_at
  )
  values (
    p_video_id, v_user_id, v_organization_id,
    coalesce(v_previous_attempts, 0) + 1,
    greatest(coalesce(v_previous_best, 0), v_score_percent),
    coalesce(v_previous_passed, false) or v_passed,
    p_answers,
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
    'attemptsCount', coalesce(v_previous_attempts, 0) + 1,
    'bestScorePercent', greatest(coalesce(v_previous_best, 0), v_score_percent)
  );
end
$$;

revoke all on function public.admin_save_video_quiz(uuid, integer, jsonb) from public, anon;
revoke all on function public.admin_get_video_quiz(uuid) from public, anon;
revoke all on function public.admin_delete_video_quiz(uuid) from public, anon;
revoke all on function public.get_playable_video_quiz(uuid) from public, anon;
revoke all on function public.submit_video_quiz_attempt(uuid, jsonb) from public, anon;

grant execute on function public.admin_save_video_quiz(uuid, integer, jsonb) to authenticated;
grant execute on function public.admin_get_video_quiz(uuid) to authenticated;
grant execute on function public.admin_delete_video_quiz(uuid) to authenticated;
grant execute on function public.get_playable_video_quiz(uuid) to authenticated;
grant execute on function public.submit_video_quiz_attempt(uuid, jsonb) to authenticated;

alter table public.video_quizzes enable row level security;
alter table private.quiz_questions enable row level security;
alter table private.quiz_question_options enable row level security;
alter table public.video_quiz_results enable row level security;

-- `video_quizzes` solo expone metadatos (puntaje mínimo, número de
-- preguntas), nunca las preguntas ni las respuestas, así que es seguro
-- leerlo directamente desde el cliente para mostrar insignias.
drop policy if exists video_quizzes_read_allowed on public.video_quizzes;
create policy video_quizzes_read_allowed
on public.video_quizzes for select to authenticated
using (
  (select private.is_admin_for(organization_id))
  or (select private.can_view_video_card(video_id))
);

drop policy if exists video_quiz_results_read_self_or_admin on public.video_quiz_results;
create policy video_quiz_results_read_self_or_admin
on public.video_quiz_results for select to authenticated
using (
  user_id = (select auth.uid())
  or (select private.is_admin_for(organization_id))
);

-- `private.quiz_questions` y `private.quiz_question_options` no reciben
-- ninguna política ni permiso directo: solo son accesibles a través de las
-- funciones `security definer` de arriba (mismo patrón que
-- `private.role_access_codes`).

revoke all on public.video_quizzes from anon, authenticated;
grant select on public.video_quizzes to authenticated;
grant all on public.video_quizzes to service_role;

revoke all on public.video_quiz_results from anon, authenticated;
grant select on public.video_quiz_results to authenticated;
grant all on public.video_quiz_results to service_role;

revoke all on private.quiz_questions, private.quiz_question_options from public, anon, authenticated;
grant all on private.quiz_questions, private.quiz_question_options to service_role;

commit;
