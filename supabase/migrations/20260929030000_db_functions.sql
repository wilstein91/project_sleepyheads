-- WU-101: DB 함수 (API_SPEC §7.3)
-- 모두 SECURITY DEFINER + anon/authenticated 실행 권한 회수.
-- 서버의 관리자 클라이언트(service_role)만 호출한다.

-- ------------------------------------------------------------
-- consume_quota: 질문 한도 확인·차감을 한 트랜잭션으로.
-- 같은 idempotency_key로 이미 만들어진 analyses 행이 있으면 재차감하지 않는다 (재요청 안전).
-- ------------------------------------------------------------
create or replace function consume_quota(
  p_user_id uuid,
  p_kind text,
  p_idempotency_key text
) returns table (allowed boolean, remaining integer, reset_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day date := (now() at time zone 'Asia/Seoul')::date;
  v_limit integer;
  v_used integer;
  v_already boolean;
begin
  if p_kind <> 'question' then
    raise exception 'unsupported quota kind: %', p_kind;
  end if;

  select exists (
    select 1 from analyses
    where owner_id = p_user_id and idempotency_key = p_idempotency_key
  ) into v_already;

  select value::integer into v_limit from quota_config where key = 'questions_per_day';

  insert into usage_daily (user_id, day_kst, questions, dart_calls)
    values (p_user_id, v_day, 0, 0)
  on conflict (user_id, day_kst) do nothing;

  select questions into v_used
    from usage_daily
    where user_id = p_user_id and day_kst = v_day
    for update;

  if v_already then
    allowed := true;
  elsif v_used >= v_limit then
    allowed := false;
  else
    update usage_daily set questions = questions + 1
      where user_id = p_user_id and day_kst = v_day;
    v_used := v_used + 1;
    allowed := true;
  end if;

  remaining := greatest(v_limit - v_used, 0);
  reset_at := ((v_day + 1)::timestamp at time zone 'Asia/Seoul');
  return next;
end;
$$;

revoke all on function consume_quota(uuid, text, text) from public, anon, authenticated;

-- ------------------------------------------------------------
-- refund_quota: AI 장애 등으로 질문 해석 자체가 실패했을 때 차감을 되돌린다.
-- analyses 행이 이미 생겼다면(= 정상적으로 소비된 질문) 환불하지 않는다.
-- ------------------------------------------------------------
create or replace function refund_quota(
  p_user_id uuid,
  p_idempotency_key text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day date := (now() at time zone 'Asia/Seoul')::date;
begin
  if not exists (
    select 1 from analyses
    where owner_id = p_user_id and idempotency_key = p_idempotency_key
  ) then
    update usage_daily
      set questions = greatest(questions - 1, 0)
      where user_id = p_user_id and day_kst = v_day;
  end if;
end;
$$;

revoke all on function refund_quota(uuid, text) from public, anon, authenticated;

-- ------------------------------------------------------------
-- check_and_record_api_usage: 외부 API 전체·회원별 상한을 확인한 뒤 사용량을 기록한다.
-- provider별 전체 상한 키:
--   dart  -> dart_global_hard_limit (soft limit은 서버 애플리케이션 레이어에서 별도 경고 처리)
--   price -> price_calls_per_day
--   naver -> naver_calls_per_day
--   llm   -> llm_questions_per_day_global
-- ------------------------------------------------------------
create or replace function check_and_record_api_usage(
  p_provider text,
  p_user_id uuid default null,
  p_calls integer default 1,
  p_input_tokens bigint default 0,
  p_output_tokens bigint default 0,
  p_cost_usd numeric default 0
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day date := (now() at time zone 'Asia/Seoul')::date;
  v_global_limit_key text;
  v_global_limit numeric;
  v_global_used integer;
  v_user_limit numeric;
  v_user_used integer;
  v_allowed boolean := true;
begin
  v_global_limit_key := case p_provider
    when 'dart' then 'dart_global_hard_limit'
    when 'price' then 'price_calls_per_day'
    when 'naver' then 'naver_calls_per_day'
    when 'llm' then 'llm_questions_per_day_global'
    else null
  end;

  if v_global_limit_key is not null then
    select value into v_global_limit from quota_config where key = v_global_limit_key;
    -- api_usage_daily는 (day_kst, provider) 단일 행이라 집계가 아니라 단일 행 조회로 잠근다.
    -- 행이 아직 없으면(그날 첫 호출) 0으로 취급 — 동시 첫 호출끼리는 드물게 살짝 초과될 수 있음(허용 오차).
    select calls into v_global_used
      from api_usage_daily
      where day_kst = v_day and provider = p_provider
      for update;
    if coalesce(v_global_used, 0) + p_calls > v_global_limit then
      v_allowed := false;
    end if;
  end if;

  if p_provider = 'dart' and p_user_id is not null and v_allowed then
    select value into v_user_limit from quota_config where key = 'dart_calls_per_user_per_day';
    select dart_calls into v_user_used
      from usage_daily
      where user_id = p_user_id and day_kst = v_day
      for update;
    if coalesce(v_user_used, 0) + p_calls > v_user_limit then
      v_allowed := false;
    end if;
  end if;

  if v_allowed then
    insert into api_usage_daily (day_kst, provider, calls, input_tokens, output_tokens, cost_usd)
      values (v_day, p_provider, p_calls, p_input_tokens, p_output_tokens, p_cost_usd)
    on conflict (day_kst, provider) do update
      set calls = api_usage_daily.calls + excluded.calls,
          input_tokens = api_usage_daily.input_tokens + excluded.input_tokens,
          output_tokens = api_usage_daily.output_tokens + excluded.output_tokens,
          cost_usd = api_usage_daily.cost_usd + excluded.cost_usd;

    if p_provider = 'dart' and p_user_id is not null then
      insert into usage_daily (user_id, day_kst, questions, dart_calls)
        values (p_user_id, v_day, 0, p_calls)
      on conflict (user_id, day_kst) do update
        set dart_calls = usage_daily.dart_calls + excluded.dart_calls;
    end if;
  else
    update api_usage_daily set blocked_at = now()
      where day_kst = v_day and provider = p_provider;
  end if;

  return v_allowed;
end;
$$;

revoke all on function check_and_record_api_usage(text, uuid, integer, bigint, bigint, numeric)
  from public, anon, authenticated;

-- ------------------------------------------------------------
-- acquire_step_lock: 같은 분석의 같은 단계가 동시에 두 번 실행되지 않도록 막는다.
-- 트랜잭션 종료 시 자동 해제되는 advisory lock을 쓰므로 analysis_steps 테이블이
-- 아직 없는 Step 1 시점에도 바로 쓸 수 있다. 호출부는 반드시 같은 트랜잭션 안에서
-- 단계 실행까지 마쳐야 한다.
-- ------------------------------------------------------------
create or replace function acquire_step_lock(
  p_analysis_id uuid,
  p_seq integer
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  return pg_try_advisory_xact_lock(hashtextextended(p_analysis_id::text || ':' || p_seq::text, 0));
end;
$$;

revoke all on function acquire_step_lock(uuid, integer) from public, anon, authenticated;

-- ------------------------------------------------------------
-- delete_my_data: 탈퇴 시 개인 데이터 일괄 삭제.
-- ⚠️ Step 2 이후 analysis_steps·dataset_versions·boards·news_clues 테이블이 생기면
-- 이 함수를 CREATE OR REPLACE로 갱신해 삭제 대상에 포함해야 한다 (WU-204 참고).
-- ------------------------------------------------------------
create or replace function delete_my_data(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from analyses where owner_id = p_user_id;
  delete from projects where owner_id = p_user_id;
  delete from usage_daily where user_id = p_user_id;
  delete from profiles where id = p_user_id;
end;
$$;

revoke all on function delete_my_data(uuid) from public, anon, authenticated;
