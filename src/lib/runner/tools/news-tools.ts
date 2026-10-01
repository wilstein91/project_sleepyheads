// [Phase 2 — 담당: 기획/화면·검증(현준)] 뉴스 검색·분석 글 도구 (계약: ./types.ts).
// search_news: findNewsClues(src/lib/news)로 기사 0~5건과 요지를 고르고, 회원 분석이면 news_clues에 남긴다 (WU-304).
// write_explanation: 설명 작성(generateExplanation) — 앞 단계 뉴스 단서가 있으면 함께 넘긴다 (WU-305).
//   대상 기업의 공시 원문(사업의 내용·경영진단·주석)에서 질문에 맞는 단락도 골라 넘긴다 (정성 분석, 2026-10-01).
//   별도 단계로 두지 않는다 — 받기·고르기가 1초 안팎이라 단계를 늘리면 단계 사이 대기(DB 왕복)가 더 길다.
import "server-only";
import { generateExplanationWithUsage } from "@/lib/explain/generate";
import { findFilingPassages } from "@/lib/filings";
import { findNewsClues } from "@/lib/news";
import { saveNewsClues } from "@/lib/news/store";
import { outputsOf, type Tool } from "./types";

export const searchNews: Tool<"search_news"> = async (input, ctx) => {
  const companyName = input.company?.name?.trim();
  if (!companyName) {
    return { status: "failed", retryable: false, errorReason: "뉴스를 찾을 기업이 없습니다" };
  }
  const period = input.period ? { from: input.period.from, to: input.period.to } : null;
  const keywords = input.keywords ?? [];

  try {
    // findNewsClues는 던지지 않는다 — RSS가 막혀도 clues: [] + 사유(notes)로 돌아온다
    const found = await findNewsClues({
      company: { name: companyName },
      period,
      keywords,
      userId: ctx.userId,
      analysisId: ctx.analysisId,
    });
    const notes = [...found.notes];

    // 비로그인 예시(userId 없음)는 회원 데이터가 아니라 저장하지 않는다 — 분석 글에는 그대로 붙는다
    if (ctx.userId) {
      const saved = await saveNewsClues(ctx.client, {
        ownerId: ctx.userId,
        analysisId: ctx.analysisId,
        clues: found.clues,
      });
      if (!saved) notes.push("뉴스 단서 저장 실패 — 이번 분석 글에만 표시");
    }

    // 실행 기록(StepRecord)에는 건수와 사유만 — 기사 제목·요지는 넣지 않는다
    const count = found.clues.length > 0 ? `뉴스 ${found.clues.length}건` : "뉴스 0건";
    return {
      status: "succeeded",
      output: { clues: found.clues, notes },
      inputSummary: [
        companyName,
        period ? `${period.from}~${period.to}` : "최근 30일",
        keywords.length > 0 ? `핵심어 ${keywords.join("·")}` : "핵심어 없음",
      ].join(", "),
      outputSummary: [count, ...notes].join(" · "),
      // 외부 호출 = 캐시를 못 써 실제로 부른 RSS 수. 요지 AI 1회는 비용(llmCostUsd)으로 센다
      usage: { externalCalls: found.rssCalls, llmCostUsd: found.gistUsage?.costUsd ?? 0 },
    };
  } catch (error) {
    // 저장 도우미·모듈 모두 던지지 않지만, 계약상 도구는 어떤 경우에도 던지지 않는다
    console.error(`[tool:search_news:${ctx.analysisId}] 예상 못 한 오류`, error);
    return { status: "failed", retryable: false, errorReason: "뉴스 단서 처리 중 오류" };
  }
};

export const writeExplanation: Tool<"write_explanation"> = async (_input, ctx) => {
  const built = outputsOf(ctx.previous, "build_result").at(-1);
  if (!built) {
    return {
      status: "failed",
      retryable: false,
      errorReason: "앞 단계에 결과(build_result)가 없습니다",
    };
  }
  // 뉴스 ID(n1~n5)는 단계마다 새로 매긴다 — 같은 ID가 겹치면 앞 단계 것만 쓴다 (인용 링크가 엇갈리지 않게)
  const seen = new Set<string>();
  const newsClues = outputsOf(ctx.previous, "search_news")
    .flatMap((o) => o.clues)
    .filter((clue) => !seen.has(clue.newsId) && Boolean(seen.add(clue.newsId)));
  // 공시 원문: 재무 수집이 확인한 보고서(같은 접수번호)만 읽는다. 실패해도 단락 없이 쓴다(던지지 않음)
  // (입력을 만드는 것까지 안에 둔다 — 요청 정보가 비어 있어도 던지지 않게)
  const filings = await (async () =>
    findFilingPassages({
      corpCode: ctx.request.target.corpCode,
      sources: outputsOf(ctx.previous, "get_financials").flatMap((o) => o.sources),
      question: ctx.question,
      metrics: ctx.request.metrics,
      userId: ctx.userId,
      analysisId: ctx.analysisId,
      client: ctx.client,
    }))().catch((error: unknown) => {
    console.warn(`[tool:write_explanation:${ctx.analysisId}] 공시 원문 처리 실패`, error);
    return { passages: [], externalCalls: 0, note: "공시 원문 처리 실패 — 숫자만으로 작성" };
  });
  // 던지지 않는다 — 실패하면 status: "failed" 설명(차트·표는 그대로)
  const { explanation, llmCostUsd } = await generateExplanationWithUsage({
    question: ctx.question,
    result: built.result,
    mixedScope: ctx.mixedScope,
    newsClues,
    filings: filings.passages,
    userId: ctx.userId,
    analysisId: ctx.analysisId,
  });
  const cited = explanation.filingClues?.length ?? 0;
  return {
    status: "succeeded",
    output: { explanation },
    inputSummary: `숫자 ${Object.keys(built.result.figures).length}개, 뉴스 ${newsClues.length}건, ${filings.note}`,
    outputSummary:
      explanation.status === "ready"
        ? `분석 글 작성${cited > 0 ? ` (공시 원문 ${cited}단락 근거)` : ""}`
        : "설명 생성 실패 (차트·표는 그대로)",
    // AI는 외부 호출 수가 아니라 비용으로 센다 (질문당 상한 max_llm_cost_usd_per_question). 원문 받기는 외부 호출
    usage: { externalCalls: filings.externalCalls, llmCostUsd },
  };
};
