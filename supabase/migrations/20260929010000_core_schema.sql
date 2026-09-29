-- WU-101: Step 1 코어 스키마
-- 범위: TECH_SPEC.md §15.1(회원·사용량), §15.3(기업·섹터), §15.4(수집 데이터),
--       projects·analyses(Step 1 최소 컬럼), guest_examples,
--       서비스 범위 판정·거절 정책(TECH §4.11) 테이블
-- Step 2 이후 컬럼(dataset_version_id, analysis_steps, dataset_versions, boards, news_clues 등)은
-- 해당 WU(WU-201/202/301/304)의 마이그레이션에서 ALTER TABLE / CREATE TABLE로 추가한다.

create extension if not exists pg_trgm;

-- ============================================================
-- §15.1 회원·사용량
-- ============================================================

create table profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  nickname text,
  email text not null,
  agreed_terms_at timestamptz,
  created_at timestamptz not null default now()
);

create table usage_daily (
  user_id uuid not null references profiles (id) on delete cascade,
  day_kst date not null,
  questions integer not null default 0,
  dart_calls integer not null default 0,
  -- declines: 회원별 하루 거절(declined) 횟수. decline_stats_daily는 전체(글로벌) 유형별
  -- 집계만 갖고 있어 F-U8/max_declines_per_day(회원별 상한)를 판정할 수 없다 -- 여기 보강.
  declines integer not null default 0,
  primary key (user_id, day_kst)
);

create table quota_config (
  key text primary key,
  value numeric not null,
  description text
);

create table api_usage_daily (
  day_kst date not null,
  provider text not null check (provider in ('dart', 'price', 'naver', 'llm')),
  calls integer not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cost_usd numeric not null default 0,
  blocked_at timestamptz,
  primary key (day_kst, provider)
);

-- ============================================================
-- 서비스 범위 판정·거절 정책 (TECH §4.11, v0.2.2 신규)
-- ============================================================

create table scope_block_patterns (
  id uuid primary key default gen_random_uuid(),
  pattern text not null,
  category text not null default 'manipulation',
  created_at timestamptz not null default now()
);

create table decline_messages (
  category text primary key check (category in ('out_of_scope', 'advice_request', 'manipulation')),
  message text not null,
  suggestions jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

create table decline_stats_daily (
  day_kst date not null,
  category text not null check (category in ('out_of_scope', 'advice_request', 'manipulation')),
  count integer not null default 0,
  primary key (day_kst, category)
);

-- ============================================================
-- 기업·섹터 (§15.3)
-- ============================================================

create table sectors (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  is_financial boolean not null default false
);

create table sector_rules (
  id uuid primary key default gen_random_uuid(),
  induty_prefix text not null unique, -- KSIC 업종코드 앞자리 (예: "261", "64")
  sector_id uuid not null references sectors (id)
);

create table sector_overrides (
  corp_code text primary key, -- 수동 지정 (예: SK하이닉스 -> 반도체)
  sector_id uuid not null references sectors (id)
);

create table companies (
  corp_code text primary key, -- OpenDART 고유번호 8자리
  stock_code text not null unique, -- 종목코드 6자리
  corp_name text not null,
  market text check (market in ('KOSPI', 'KOSDAQ')),
  induty_code text,
  sector_id uuid references sectors (id),
  sector_source text check (sector_source in ('manual', 'induty_code', 'other')),
  acc_mt integer check (acc_mt between 1 and 12), -- 결산월
  updated_at timestamptz not null default now()
);

create index companies_corp_name_idx on companies using gin (corp_name gin_trgm_ops);

-- ============================================================
-- 수집 데이터 (§15.4)
-- ============================================================

create table company_sync_state (
  corp_code text primary key references companies (corp_code) on delete cascade,
  last_checked_at timestamptz,
  last_rcept_dt date
);

create table account_map (
  id uuid primary key default gen_random_uuid(),
  metric text not null, -- 표준 계정 ID (예: ifrs-full_Revenue)
  priority integer not null default 0,
  account_id text not null, -- DART 계정 ID
  account_nm text not null, -- 계정명 대체 목록 (예: "영업수익")
  industry_type text -- null = 일반, 'financial' = 금융업 전용 등
);

create table report_values (
  id uuid primary key default gen_random_uuid(),
  corp_code text not null references companies (corp_code),
  bsns_year integer not null,
  reprt_code text not null check (reprt_code in ('11013', '11012', '11014', '11011')),
  fs_div text not null check (fs_div in ('CFS', 'OFS')),
  account_id text not null, -- account_map.account_id
  period_end date,
  amount_3m bigint, -- 당기 3개월 값 (손익계산서 항목)
  amount_cum bigint, -- 당기 누적 값 / 재무상태표는 분기말 값
  source_rcept_no text not null,
  superseded_by uuid references report_values (id), -- 정정 공시로 대체된 경우
  fetched_at timestamptz not null default now()
);

create index report_values_lookup_idx
  on report_values (corp_code, bsns_year, reprt_code, fs_div, account_id);

create table calendar_quarter_metrics (
  id uuid primary key default gen_random_uuid(),
  corp_code text not null references companies (corp_code),
  cal_year integer not null,
  cal_quarter integer not null check (cal_quarter between 1 and 4),
  fs_div text not null check (fs_div in ('CFS', 'OFS')),
  metrics jsonb not null default '{}'::jsonb, -- { "revenue": 123, "operating_income": 45, ... }
  boundary_mismatch boolean not null default false,
  calc_version text not null default 'v1',
  dataset_hash text,
  created_at timestamptz not null default now(),
  unique (corp_code, cal_year, cal_quarter, fs_div, calc_version)
);

create table issue_rules (
  id uuid primary key default gen_random_uuid(),
  tag text not null, -- TECH §15.5: 자금조달·주주환원·구조변화·자본감소·위험·지배구조·실적·계약·지분변동
  keyword text not null, -- 공시 제목에 포함되는 문구 (예: "유상증자결정")
  importance text not null check (importance in ('high', 'mid', 'low'))
);

create table disclosures (
  rcept_no text primary key,
  corp_code text not null references companies (corp_code),
  report_nm text not null,
  rcept_dt date not null,
  pblntf_ty text,
  issue_tag text, -- TECH §15.5 태그 (자금조달, 주주환원, ...)
  importance text check (importance in ('high', 'mid', 'low')),
  is_correction boolean not null default false
);

create index disclosures_corp_date_idx on disclosures (corp_code, rcept_dt desc);

create table stock_prices (
  stock_code text not null,
  base_date date not null,
  close_price bigint not null,
  listed_shares bigint,
  fetched_at timestamptz not null default now(),
  primary key (stock_code, base_date)
);

create table news_search_cache (
  query_hash text primary key,
  items jsonb not null, -- [{title, originallink, link, description, pubDate}, ...] 본문 없음
  fetched_at timestamptz not null default now()
);

create table robots_cache (
  domain text primary key,
  rules jsonb not null,
  fetched_at timestamptz not null default now()
);

create table data_issues (
  id uuid primary key default gen_random_uuid(),
  corp_code text references companies (corp_code),
  kind text not null,
  detail text,
  created_at timestamptz not null default now()
);

-- ============================================================
-- 프로젝트·분석 (§15.2, Step 1 최소 컬럼만)
-- ============================================================

create table projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references profiles (id) on delete cascade,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table analyses (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  owner_id uuid not null references profiles (id) on delete cascade,
  question text not null,
  analysis_request jsonb, -- AnalysisRequestView, 해석 전/거절이면 null
  status text not null check (
    status in (
      'declined', 'needs_clarification', 'awaiting_approval', 'awaiting_preprocess',
      'queued', 'running', 'succeeded', 'partial', 'failed', 'canceled'
    )
  ),
  decline_category text check (decline_category in ('out_of_scope', 'advice_request', 'manipulation')),
  result jsonb, -- ResultObject (차트·표·숫자 ID)
  explanation jsonb, -- Explanation
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique (owner_id, idempotency_key)
);

create index analyses_project_idx on analyses (project_id, created_at desc);

create table guest_examples (
  id uuid primary key default gen_random_uuid(),
  question text not null,
  result jsonb not null,
  explanation jsonb not null,
  generated_at timestamptz not null default now()
);
