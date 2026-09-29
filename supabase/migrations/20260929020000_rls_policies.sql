-- WU-101: RLS
-- 🔒 = 본인 행만 (owner_id / id = auth.uid())
-- 🗄️ = 공유 캐시·설정 테이블. RLS는 켜되 정책은 두지 않는다 -> anon/authenticated로는 0행, 관리자 클라이언트(service_role)만 접근

-- ============================================================
-- 🔒 회원 소유 테이블
-- ============================================================

alter table profiles enable row level security;

create policy "profiles_select_own" on profiles
  for select using (id = auth.uid());

create policy "profiles_update_own" on profiles
  for update using (id = auth.uid());

-- INSERT는 서버(관리자 클라이언트)가 최초 로그인 시 생성한다. 회원 본인의 직접 insert는 막는다.

alter table usage_daily enable row level security;

create policy "usage_daily_select_own" on usage_daily
  for select using (user_id = auth.uid());

-- 쓰기는 DB 함수(consume_quota 등, SECURITY DEFINER)로만 한다. 별도 write policy 없음.

alter table projects enable row level security;

create policy "projects_all_own" on projects
  for all using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

alter table analyses enable row level security;

create policy "analyses_all_own" on analyses
  for all using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- ============================================================
-- 🗄️ 공유 캐시·설정 테이블 (RLS 켜고 정책 없음)
-- ============================================================

alter table quota_config enable row level security;
alter table api_usage_daily enable row level security;
alter table scope_block_patterns enable row level security;
alter table decline_messages enable row level security;
alter table decline_stats_daily enable row level security;
alter table sectors enable row level security;
alter table sector_rules enable row level security;
alter table sector_overrides enable row level security;
alter table companies enable row level security;
alter table company_sync_state enable row level security;
alter table account_map enable row level security;
alter table issue_rules enable row level security;
alter table report_values enable row level security;
alter table calendar_quarter_metrics enable row level security;
alter table disclosures enable row level security;
alter table stock_prices enable row level security;
alter table news_search_cache enable row level security;
alter table robots_cache enable row level security;
alter table data_issues enable row level security;
alter table guest_examples enable row level security;

-- guest_examples는 비로그인 사용자도 "읽기"는 가능해야 한다 (F-G1).
-- 단, 관리자 클라이언트를 통해서만 제공한다 (브라우저가 Supabase를 직접 쿼리하지 않는다는 HANDOFF §2.1 원칙 유지).
-- 따라서 여기서도 anon 대상 정책은 추가하지 않는다. /api/guest/example 라우트가 관리자 클라이언트로 조회해 내려준다.
