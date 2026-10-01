// 분석 글(AI ③)의 추론 분량. 환경변수 OPENAI_EXPLAIN_REASONING = low|medium|high|default (없으면 low).
// low인 이유 (2026-10-01 실측, 같은 입력): gpt-6-sol 기본 13.7~14.8초 → low 7.6~7.7초, gpt-6-luna 13.6초 → 5.7초.
// 결론·투자 포인트·인용 단락이 같은 수준으로 나왔다. "default"면 필드를 보내지 않아 모델 기본값을 쓴다.

export type ReasoningEffort = "low" | "medium" | "high";

export function explainReasoningEffort(): ReasoningEffort | undefined {
  const raw = process.env.OPENAI_EXPLAIN_REASONING?.trim().toLowerCase();
  if (raw === "default") return undefined;
  return raw === "medium" || raw === "high" ? raw : "low";
}
