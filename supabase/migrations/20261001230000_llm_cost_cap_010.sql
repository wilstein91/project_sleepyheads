-- 분석 글 인사이트 강화(2026-10-01 예림 결정): 결론 최대 15문장 + 관점별 투자 포인트 — 분석 글 1건 비용이 커져
-- 질문당 AI 비용 상한을 $0.05 → $0.10으로 올린다. 데이터 값만 바꾼다 (표·컬럼 변경 없음). 되돌리기: value = 0.05.
-- 시연용 토큰 보호는 코드 쪽 하루 예산(OPENAI_EXPLAIN_DAILY_BUDGET_USD, src/lib/explain/model.ts)이 맡는다.
update quota_config
  set value = 0.10
  where key = 'max_llm_cost_usd_per_question';
