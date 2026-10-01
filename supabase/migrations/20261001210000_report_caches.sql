-- 투자 리포트(Phase 5 후속) 캐시 3개 — 추가만, 여러 번 적용해도 같다. 모두 공유 캐시(🗄️): 정책 없음 = 서버만 읽고 쓴다.
-- 적용 전에도 리포트는 만들어진다(캐시 없이 매번 받는다) — src/lib/report/*.ts

-- 종목별 1년 일별 시세 (금융위원회_주식시세정보, 하루 1회). days = [{date, open, high, low, close, changeRate,
-- volume, tradeValue, listedShares, marketCap}] 날짜 오름차순
create table if not exists stock_price_history (
  stock_code text primary key,
  days jsonb not null default '[]'::jsonb,
  fetched_at timestamptz not null default now()
);
alter table stock_price_history enable row level security;

-- 보고서별 리포트용 계정 (표준 8개 + 현금흐름·유동자산·유동부채·현금·EPS·배당금 지급). fs_div가 null이면
-- CFS·OFS 모두 013(아직 없음) — 하루 뒤 다시 확인한다
create table if not exists report_extras (
  corp_code text not null references companies (corp_code),
  bsns_year integer not null,
  reprt_code text not null check (reprt_code in ('11013', '11012', '11014', '11011')),
  fs_div text check (fs_div in ('CFS', 'OFS')),
  rcept_no text,
  values jsonb not null default '{}'::jsonb,
  fetched_at timestamptz not null default now(),
  primary key (corp_code, bsns_year, reprt_code)
);
alter table report_extras enable row level security;

-- 최대주주(hyslrSttus)·배당(alotMatter) — 기업·종류마다 마지막으로 받은 보고서 기준 한 행
create table if not exists company_facts (
  corp_code text not null references companies (corp_code),
  kind text not null check (kind in ('shareholder', 'dividend')),
  bsns_year integer not null,
  reprt_code text not null,
  data jsonb,
  fetched_at timestamptz not null default now(),
  primary key (corp_code, kind)
);
alter table company_facts enable row level security;
