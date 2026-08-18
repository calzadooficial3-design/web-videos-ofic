begin;

-- Historial de intentos de cuestionario: antes solo se guardaba el último
-- intento (`video_quiz_results.last_answers`). Ahora cada envío también
-- inserta una fila aquí, con el detalle de cada pregunta (qué marcó el
-- usuario, si acertó, y cuál era la opción correcta) para que el admin pueda
-- revisar "intento 1", "intento 2", etc. de forma independiente. Es
-- append-only: nunca se actualiza ni se borra un intento ya guardado.
create table if not exists public.video_quiz_attempts (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references public.videos(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  attempt_number integer not null check (attempt_number >= 1),
  score_percent integer not null check (score_percent between 0 and 100),
  passed boolean not null default false,
  answers jsonb not null default '[]'::jsonb check (jsonb_typeof(answers) = 'array'),
  created_at timestamptz not null default now(),
  unique (video_id, user_id, attempt_number)
);

create index if not exists video_quiz_attempts_user_video_idx
  on public.video_quiz_attempts(user_id, video_id, attempt_number);
create index if not exists video_quiz_attempts_org_idx
  on public.video_quiz_attempts(organization_id);

alter table public.video_quiz_attempts enable row level security;

drop policy if exists video_quiz_attempts_read_self_or_admin on public.video_quiz_attempts;
create policy video_quiz_attempts_read_self_or_admin
on public.video_quiz_attempts for select to authenticated
using (
  user_id = (select auth.uid())
  or (select private.is_admin_for(organization_id))
);

revoke all on public.video_quiz_attempts from anon, authenticated;
grant select on public.video_quiz_attempts to authenticated;
grant all on public.video_quiz_attempts to service_role;

-- Reemplaza la versión anterior: ahora arma el detalle por pregunta con una
-- sola consulta (en vez de un bucle) y lo guarda tanto en el nuevo historial
-- de intentos como en el resumen de `video_quiz_results`.
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
    video_id, user_id, organization_id, attempt_number, score_percent, passed, answers
  )
  values (
    p_video_id, v_user_id, v_organization_id, v_next_attempt_number,
    v_score_percent, v_passed, coalesce(v_answers_detail, '[]'::jsonb)
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

-- Cargo y área: datos del rol de la persona dentro de la empresa, capturados
-- al crear el usuario (además de nombre completo y rol de acceso operante/jefe
-- que ya existían).
alter table public.profiles add column if not exists job_title text
  check (job_title is null or length(trim(job_title)) between 1 and 120);
alter table public.profiles add column if not exists department text
  check (department is null or length(trim(department)) between 1 and 120);

commit;
