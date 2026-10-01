-- 투자 리포트(Phase 5 후속): 분석 글이 리포트 요약까지 읽어 1건 약 $0.02~0.03 (2026-10-01 실측 $0.024, gpt-6-sol).
-- 해석·뉴스 요지와 합치면 $0.03에 닿을 수 있어 질문당 AI 비용 상한을 $0.03 → $0.05로 올린다 (2026-10-01 예림 결정).
-- 데이터 값만 바꾼다 (표·컬럼 변경 없음). 되돌리기: 같은 문장으로 value = 0.03.
-- 시연용 토큰 보호는 코드 쪽 하루 예산(OPENAI_EXPLAIN_DAILY_BUDGET_USD, src/lib/explain/model.ts)이 맡는다.
update quota_config
  set value = 0.05
  where key = 'max_llm_cost_usd_per_question';
