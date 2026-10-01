-- Phase 5 (Phase 4 남긴 리뷰 ②): 기업개황 미리 채우기(cron C3)가 영구 실패하는 기업을 매일 다시 시도하지 않게
-- 마지막 실패 시각을 남긴다 — 추가만, 여러 번 적용해도 같다.
-- prefill(src/lib/companies/prefill.ts)은 7일 안에 실패한 기업을 건너뛴다. 질문에서 그 기업을 처음 확정할 때의
-- 기업개황 조회(src/lib/companies/profile.ts)는 이 칸을 보지 않는다 — 회원 질문은 그대로 시도한다.
alter table companies add column if not exists profile_failed_at timestamptz;
