-- Phase 5 (Phase 4 남긴 리뷰 ①): 종목별 주가를 "받아 본 기록" — 추가만, 여러 번 적용해도 같다.
--
-- stock_prices는 가격이 있을 때만 행이 생긴다(close_price not null). 거래정지처럼 기간 안 가격이 하나도 없는 종목은
-- 남는 행이 없어 "오늘 이미 받았다"를 알 수 없었고, 그 종목을 묻는 요청마다 주가 API를 다시 불렀다
-- (report_fetch_state가 재무 보고서에 대해 같은 문제를 푼 것과 같은 방식). 받은 결과와 상관없이 종목 + 기간 끝으로
-- "받았다"만 남긴다 (src/lib/price/daily.ts).
create table if not exists price_fetch_state (
  stock_code text not null,
  -- 받은 기간의 끝: 지금 기준(latest)이면 그날(KST), 과거 기준(asOf)이면 그 기준일
  range_to date not null,
  range_from date not null,
  -- 그 종목 코드로 받은 기간 안 가격 행 수 (0 = 받았지만 없음 — 거래정지 등)
  row_count integer not null default 0 check (row_count >= 0),
  fetched_at timestamptz not null default now(),
  primary key (stock_code, range_to)
);

-- stock_prices와 같다: 정책 없음 = 서버(관리자 클라이언트)만 읽고 쓴다
alter table price_fetch_state enable row level security;
