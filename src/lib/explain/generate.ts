// TECH §11.2 ③ 설명 작성 오케스트레이션. WU-111.
// 실패해도 절대 던지지 않는다 — 호출부(WU-110 실행 흐름)는 차트·표는 그대로 보여주고
// "설명 생성 실패"만 표시한다(§11.5, F-N7). 실패 처리는 이 함수 안에서 끝낸다.
import "server-only";
import type { Explanation, NewsClue, ResultObject } from "@/contracts";
import type { FilingPassage } from "@/lib/filings/passages";
import { llmCall, type LlmUsage } from "@/lib/llm/client";
import { AI_EXPLANATION_JSON_SCHEMA, aiExplanationSchema } from "./ai-explanation";
import { buildExplanation, failedExplanation } from "./build-explanation";
import { chooseExplainModel } from "./model";
import { buildExplainPrompt, summarizeCharts, summarizeFigures } from "./prompt";
import { explainReasoningEffort } from "./reasoning";

export interface GenerateExplanationInput {
  question: string;
  result: ResultObject;
  /** 앞 단계 search_news가 고른 단서 (없으면 빈 배열) — 뉴스 근거 없이는 원인 추정을 하지 않는다. */
  newsClues?: NewsClue[];
  /** 공시 원문 단락 (src/lib/filings, 없으면 빈 배열) — 회사가 직접 쓴 사업·실적 설명 */
  filings?: FilingPassage[];
  /** TECH §4.11.1 — 범위 안 질문에 범위 밖 요청이 섞였는가 (analyses.mixed_scope). */
  mixedScope: boolean;
  userId?: string | null;
  analysisId?: string | null;
}

/** 트랙 B `unavailableFlags`(src/lib/runner/present.ts)가 만드는 줄의 머리말 */
const UNAVAILABLE_PREFIX = "계산 불가 (";

export interface GeneratedExplanation {
  explanation: Explanation;
  /** 이번 설명 작성 AI 비용 (부르기 전에 실패했으면 0) — 질문당 상한 max_llm_cost_usd_per_question 판정용 */
  llmCostUsd: number;
}

export async function generateExplanation(input: GenerateExplanationInput): Promise<Explanation> {
  return (await generateExplanationWithUsage(input)).explanation;
}

/** generateExplanation과 같고, AI 비용을 함께 돌려준다 (실행기 write_explanation 도구용) */
export async function generateExplanationWithUsage(
  input: GenerateExplanationInput,
): Promise<GeneratedExplanation> {
  const newsClues = input.newsClues ?? [];
  const filings = input.filings ?? [];
  let llmCostUsd = 0;

  try {
    // T4: 분석 글만 상위 모델 — 오늘 AI 예산을 넘었으면 기본 모델 (시연용 토큰 보호, ./model.ts)
    const choice = await chooseExplainModel();
    if (choice.fallbackReason && choice.fallbackReason !== "disabled") {
      console.info(
        `[explain:${input.analysisId ?? "unknown"}] 기본 모델로 작성 (${choice.fallbackReason})`,
      );
    }
    const effort = explainReasoningEffort();
    const { output, usage } = await llmCall<unknown>({
      ...(choice.model ? { model: choice.model } : {}),
      ...(effort ? { reasoningEffort: effort } : {}),
      userId: input.userId ?? null,
      analysisId: input.analysisId ?? null,
      input: buildExplainPrompt({
        question: input.question,
        figures: summarizeFigures(input.result.figures),
        charts: summarizeCharts(input.result.charts),
        newsClues: newsClues.map((n) => ({
          newsId: n.newsId,
          title: n.title,
          gist: n.gist,
          press: n.press,
          publishedAt: n.publishedAt,
        })),
        filings,
      }),
      schema: { name: "explanation", schema: AI_EXPLANATION_JSON_SCHEMA, strict: true },
    });
    // 사용량이 빠진 응답(가짜 AI 등)은 0으로 본다
    llmCostUsd = (usage as LlmUsage | undefined)?.costUsd ?? 0;

    const parsed = aiExplanationSchema.safeParse(output);
    if (!parsed.success) return { explanation: failedExplanation(), llmCostUsd };

    const explanation = buildExplanation({
      ai: parsed.data,
      figures: input.result.figures,
      charts: input.result.charts,
      newsClues,
      hasNews: newsClues.length > 0,
      filings,
      mixedScope: input.mixedScope,
      unavailableNotes: (input.result.basis?.flags ?? []).filter((f) =>
        f.startsWith(UNAVAILABLE_PREFIX),
      ),
    });
    return { explanation, llmCostUsd };
  } catch (err) {
    console.error(`[explain:${input.analysisId ?? "unknown"}] 설명 작성 실패`, err);
    return { explanation: failedExplanation(), llmCostUsd };
  }
}
