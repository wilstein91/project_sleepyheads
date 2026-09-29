-- WU-101 시드 데이터
-- `supabase db reset` 실행 시 자동으로 적용된다 (sleepyheads-dev 전용, prod에는 별도 검토 후 적용).

-- ============================================================
-- quota_config (TECH §13 표 10개 + §4.7 질문당 상한 6개 = 16개)
-- ============================================================
insert into quota_config (key, value, description) values
  ('questions_per_day', 20, '회원별 새 질문·후속 질문·설명 다시 쓰기'),
  ('question_requests_per_minute', 10, '회원별 질문 관련 요청(ask·clarify·rewrite·rerun) 분당 수'),
  ('requests_per_minute', 120, '회원별 전체 요청 분당 수'),
  ('dart_calls_per_user_per_day', 400, '회원별 OpenDART 소모 상한'),
  ('dart_global_soft_limit', 16000, '넘으면 회원의 새 수집 중단'),
  ('dart_global_hard_limit', 19000, '넘으면 시스템 수집도 중단'),
  ('price_calls_per_day', 8000, '주가 API 전체 상한'),
  ('naver_calls_per_day', 20000, '네이버 검색 API 전체 상한'),
  ('llm_questions_per_day_global', 300, '서비스 전체 하루 AI 사용 질문 수'),
  ('max_declines_per_day', 10, '회원별 하루 범위 밖 거절 횟수 상한'),
  ('max_steps_per_question', 8, '질문당 최대 실행 단계 수'),
  ('max_retries_per_step', 2, '단계당 재시도 횟수 (외부 API 오류·시간 초과만)'),
  ('max_seconds_per_question', 90, '질문당 최대 실행 시간(초)'),
  ('max_llm_cost_usd_per_question', 0.01, '질문당 AI 비용 상한(USD)'),
  ('max_news_search_calls', 3, '질문당 뉴스 검색 호출 상한'),
  ('max_news_bodies', 5, '질문당 뉴스 본문 확인 상한');

-- ============================================================
-- decline_messages (PRD §6.3.1 문구, 글자 그대로)
-- ============================================================
insert into decline_messages (category, message, suggestions) values
  (
    'out_of_scope',
    '죄송합니다. 이 서비스는 국내 상장 주식회사의 실적·재무·공시·주가 지표 등 기업 분석에 관한 질문에만 답변드릴 수 있어요. 문의하신 내용은 서비스 범위를 벗어나 답변드리기 어렵습니다.',
    '["SK하이닉스 최근 실적 어때?", "삼성전자 최근 유상증자 있었어?", "KB금융 PER이 경쟁사보다 높아?"]'::jsonb
  ),
  (
    'manipulation',
    '죄송합니다. 이 서비스는 국내 상장 주식회사의 실적·재무·공시·주가 지표 등 기업 분석에 관한 질문에만 답변드릴 수 있어요. 문의하신 내용은 서비스 범위를 벗어나 답변드리기 어렵습니다.',
    '["SK하이닉스 최근 실적 어때?", "삼성전자 최근 유상증자 있었어?", "KB금융 PER이 경쟁사보다 높아?"]'::jsonb
  ),
  (
    'advice_request',
    '죄송합니다. 이 서비스는 매수·매도 판단이나 목표주가 같은 투자 권유는 드릴 수 없어요. 대신 공시 자료를 바탕으로 한 사실 분석은 도와드릴 수 있습니다.',
    '["○○ 최근 4개 분기 실적과 주요 공시 알려줘"]'::jsonb
  );

-- ============================================================
-- scope_block_patterns (서버 1차 필터 — 명백한 조작 문구)
-- 실제 매칭은 애플리케이션 레이어에서 소문자·공백 정규화 후 부분일치로 수행한다.
-- ============================================================
insert into scope_block_patterns (pattern, category) values
  ('이전 지시 무시', 'manipulation'),
  ('앞의 지시 무시', 'manipulation'),
  ('ignore previous', 'manipulation'),
  ('ignore all previous instructions', 'manipulation'),
  ('시스템 프롬프트', 'manipulation'),
  ('system prompt', 'manipulation'),
  ('너는 이제', 'manipulation'),
  ('역할을 바꿔', 'manipulation'),
  ('api 키 알려줘', 'manipulation'),
  ('api key', 'manipulation');

-- ============================================================
-- sectors (TECH §8) — 금융 4개만 is_financial = true
-- ============================================================
insert into sectors (name, is_financial) values
  ('반도체', false), ('디스플레이', false), ('전자부품·장비', false), ('2차전지', false),
  ('인터넷/플랫폼', false), ('게임', false), ('엔터/미디어', false), ('통신', false),
  ('자동차/부품', false), ('조선', false), ('방산', false), ('기계/로봇', false),
  ('건설', false), ('운송/물류', false), ('항공/해운', false),
  ('화학', false), ('철강/비철금속', false), ('정유/에너지', false), ('전력/유틸리티', false),
  ('제약', false), ('바이오', false), ('의료기기', false),
  ('음식료', false), ('화장품', false), ('유통', false), ('의류/생활', false), ('여행/레저', false),
  ('은행', true), ('증권', true), ('보험', true), ('금융지주', true),
  ('지주회사', false), ('기타', false);

-- ============================================================
-- sector_rules (TECH §8 업종코드 앞자리 예시)
-- ⚠️ 초기 예시만 채움. 전체 KSIC 매핑표는 WU-104에서 보강한다.
-- ============================================================
insert into sector_rules (induty_prefix, sector_id)
select r.prefix, s.id
from (values
  ('261', '반도체'),
  ('21', '제약'),
  ('30', '자동차/부품'),
  ('311', '조선'),
  ('64', '은행'),
  ('65', '보험')
) as r(prefix, sector_name)
join sectors s on s.name = r.sector_name;

-- ============================================================
-- sector_overrides (수동 지정 — SK하이닉스 포함)
-- ⚠️ corp_code는 companies 동기화(WU-103) 이후 채워지는 값이라 여기서는
--    실제 OpenDART 고유번호로 갱신해야 한다. 자리표시자로 비워둔다.
-- ============================================================
-- insert into sector_overrides (corp_code, sector_id)
-- select '<SK하이닉스_corp_code>', s.id from sectors s where s.name = '반도체';

-- ============================================================
-- account_map (TECH §6.5 표준 계정 ID -> 계정명 대체 목록)
-- ============================================================
insert into account_map (metric, priority, account_id, account_nm, industry_type) values
  ('revenue', 1, 'ifrs-full_Revenue', '매출액', null),
  ('revenue', 2, 'ifrs-full_Revenue', '영업수익', 'financial'),
  ('operating_income', 1, 'dart_OperatingIncomeLoss', '영업이익', null),
  ('net_income', 1, 'ifrs-full_ProfitLoss', '당기순이익', null),
  ('owners_net_income', 1, 'ifrs-full_ProfitLossAttributableToOwnersOfParent', '지배기업소유주지분순이익', null),
  ('equity', 1, 'ifrs-full_Equity', '자본총계', null),
  ('owners_equity', 1, 'ifrs-full_EquityAttributableToOwnersOfParent', '지배기업소유주지분', null),
  ('liabilities', 1, 'ifrs-full_Liabilities', '부채총계', null),
  ('assets', 1, 'ifrs-full_Assets', '자산총계', null);

-- ============================================================
-- issue_rules (TECH §15.5 중요 공시 분류표)
-- ============================================================
insert into issue_rules (tag, keyword, importance) values
  ('자금조달', '유상증자결정', 'high'),
  ('자금조달', '전환사채권발행결정', 'high'),
  ('자금조달', '신주인수권부사채권발행결정', 'high'),
  ('자금조달', '교환사채권발행결정', 'high'),
  ('주주환원', '자기주식취득결정', 'high'),
  ('주주환원', '자기주식소각결정', 'high'),
  ('주주환원', '현금ㆍ현물배당결정', 'high'),
  ('구조변화', '회사합병결정', 'high'),
  ('구조변화', '회사분할결정', 'high'),
  ('구조변화', '영업양수', 'high'),
  ('구조변화', '영업양도', 'high'),
  ('구조변화', '타법인주식및출자증권취득결정', 'high'),
  ('자본감소', '감자결정', 'high'),
  ('위험', '부도발생', 'high'),
  ('위험', '영업정지', 'high'),
  ('위험', '회생절차개시신청', 'high'),
  ('위험', '해산사유발생', 'high'),
  ('위험', '소송등의제기', 'high'),
  ('지배구조', '최대주주변경', 'high'),
  ('실적', '매출액또는손익구조', 'mid'),
  ('실적', '영업(잠정)실적', 'mid'),
  ('계약', '단일판매ㆍ공급계약체결', 'mid'),
  ('지분변동', '주식등의대량보유상황보고서', 'low'),
  ('지분변동', '임원ㆍ주요주주특정증권등소유상황보고서', 'low');
