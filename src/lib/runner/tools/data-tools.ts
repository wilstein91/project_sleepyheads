// [Phase 2 — 담당: 데이터/서버(예림)] 재무·공시·경쟁사·결과 만들기 도구 (계약: ./types.ts).
// 계산은 Step 1·2 실행기(runAnalysis)를 그대로 쓴다 — 단계로 나눠도 숫자가 한 번에 실행할 때와 같다.
// 도구는 던지지 않는다: 외부 API의 일시적 오류·시간 초과만 `retryable: true` (PHASE2_PLAN §3.1).
import "server-only";
import type { AnalysisRequestView, CompanyRef, ResultObject } from "@/contracts";
import { ensureDisclosures } from "@/lib/disclosures/sync";
import { UpstreamApiError } from "@/lib/quota/errors";
import { pickPeers } from "@/lib/sector/peers";
import { ensureCompanyFinancials } from "../company-financials";
import { fetchEventDisclosures } from "../disclosures-tool";
import { runAnalysis } from "../execute";
import { buildCompanyReport } from "@/lib/report/build";
import { isReportFigureId } from "@/lib/report/ids";
import { outputsOf, type Tool, type ToolContext, type ToolOutcome } from "./types";

const NO_USAGE = { externalCalls: 0, llmCostUsd: 0 };

/**
 * 재시도해서 나아질 수 있는 오류인가: 외부 API의 네트워크 오류·시간 초과·5xx·점검(공통 호출기가
 * `retryable`로 표시) 또는 시간 초과로 끊긴 요청. 키 오류·한도 초과·데이터 없음·경쟁사 없음은 아니다.
 */
function isRetryable(err: unknown): boolean {
  if (err instanceof UpstreamApiError) return err.retryable;
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

/** 예상 못 한 오류도 던지지 않고 실패로 */
function failure(err: unknown): Extract<ToolOutcome, { status: "failed" }> {
  return {
    status: "failed",
    retryable: isRetryable(err),
    errorReason: err instanceof Error ? err.message : String(err),
  };
}

/** 이번 분석에서 비교할 기업: 질문에 나온 경쟁사, 없으면 get_peers가 고른 경쟁사 */
function peersOf(
  previous: Parameters<Tool<"build_result">>[1]["previous"],
  fallback: CompanyRef[],
) {
  const picked = outputsOf(previous, "get_peers").flatMap((o) => o.peers);
  return fallback.length > 0 ? fallback : picked;
}

const SKIP_SYNC = Symbol("skip-disclosure-sync");

/** 이 기업의 재무 보고서를 한 번이라도 받아 둔 적이 있는가 (정정 공시로 다시 받을 대상이 있는가) */
async function hasStoredReports(corpCode: string, client: ToolContext["client"]): Promise<boolean> {
  const { data, error } = await client
    .from("report_fetch_state")
    .select("corp_code")
    .eq("corp_code", corpCode)
    .limit(1);
  if (error) throw new Error(`report_fetch_state 조회 실패: ${error.message}`);
  return (data ?? []).length > 0;
}

export const getPeers: Tool<"get_peers"> = async (input, ctx) => {
  try {
    const picked = await pickPeers(input.target, input.count, {
      client: ctx.client,
      userId: ctx.userId,
      analysisId: ctx.analysisId,
    });
    return {
      status: "succeeded",
      output: { peers: picked.peers },
      inputSummary: `${input.target.name} (${input.target.sector.name}), 최대 ${input.count}곳`,
      outputSummary: `${picked.peers.map((p) => p.name).join("·")} — ${picked.order}, 같은 섹터 후보 ${picked.candidateCount}곳`,
      usage: { externalCalls: picked.externalCalls, llmCostUsd: 0 },
    };
  } catch (err) {
    return failure(err);
  }
};

export const getFinancials: Tool<"get_financials"> = async (input, ctx) => {
  let externalCalls = 0;
  try {
    const companies =
      "companies" in input ? input.companies : peersOf(ctx.previous, ctx.request.peers);
    const options = { userId: ctx.userId, analysisId: ctx.analysisId, client: ctx.client };
    const sources = [];
    const corrected: string[] = [];
    for (const company of companies) {
      // 공시 목록(24시간 캐시)에서 정기보고서 [기재정정]을 보면 받아 둔 그 보고서를 먼저 다시 받는다.
      // 받아 둔 보고서가 없는 기업(처음 조회)은 고칠 값이 없으니 건너뛴다 — 1년 치 공시 목록을 받느라
      // 첫 질문이 느려지지 않게. 공시 확인이 실패해도 재무 값은 받는다(정정 반영은 다음 확인 때로)
      try {
        if (!(await hasStoredReports(company.corpCode, ctx.client))) throw SKIP_SYNC;
        const synced = await ensureDisclosures(company.corpCode, options);
        externalCalls += synced.externalCalls;
        corrected.push(...synced.correctedReports.map((r) => `${company.name} ${r}`));
      } catch (err) {
        if (err !== SKIP_SYNC) {
          console.warn(
            `[get_financials] ${company.name} 공시 확인 실패 — 정정 반영은 다음에:`,
            err,
          );
        }
      }
      const financials = await ensureCompanyFinancials(company, input.from, input.to, options);
      externalCalls += financials.externalCalls ?? 0;
      sources.push(...(financials.sources ?? []));
    }
    const found = sources.filter((s) => s.rceptNo).length;
    return {
      status: "succeeded",
      output: { companies, sources },
      inputSummary: `${companies.map((c) => c.name).join("·")}, ${input.from}~${input.to}`,
      outputSummary: [
        `보고서 ${sources.length}건 확인 (값 있음 ${found}건)`,
        `외부 호출 ${externalCalls}건`,
        ...(corrected.length > 0 ? [`정정 공시 반영: ${corrected.join(", ")}`] : []),
      ].join(", "),
      usage: { externalCalls, llmCostUsd: 0 },
    };
  } catch (err) {
    return { ...failure(err), usage: { externalCalls, llmCostUsd: 0 } };
  }
};

export const getDisclosures: Tool<"get_disclosures"> = async (input, ctx) => {
  try {
    const disclosures = await fetchEventDisclosures(input.company, input.period, {
      userId: ctx.userId,
      analysisId: ctx.analysisId,
      client: ctx.client,
    });
    return {
      status: "succeeded",
      output: { disclosures },
      inputSummary: `${input.company.name}, ${input.period.from}~${input.period.to}`,
      outputSummary: `중요 공시 ${disclosures.length}건`,
      usage: NO_USAGE,
    };
  } catch (err) {
    return failure(err);
  }
};

export const buildResult: Tool<"build_result"> = async (_input, ctx) => {
  try {
    // 앞 get_financials 단계가 보고서를 이미 받아 두어 여기서는 외부 호출 없이 캐시로 끝난다
    // (주가 지표를 물었으면 주가 API만 — 종목마다 하루 1회)
    const request = { ...ctx.request, peers: peersOf(ctx.previous, ctx.request.peers) };
    const outcome = await runAnalysis(request, {
      userId: ctx.userId,
      analysisId: ctx.analysisId,
      client: ctx.client,
      requireConfirmation: true,
      decisions: ctx.decisions,
    });
    if (outcome.kind === "needs_preprocess") {
      return { status: "needs_preprocess", diagnoses: outcome.diagnoses };
    }
    // 투자 리포트 (Phase 5 후속): 질문이 무엇이든 대상 기업의 기본정보·주가·재무·밸류에이션·공시를 붙인다.
    // 이 단계는 시간·비용 상한에 걸리지 않는다(결과의 일부). 리포트가 실패해도 질문의 답은 그대로 낸다
    const report = await attachReport(outcome.result, request, ctx);
    // 질문 결과의 숫자만 센다 (리포트 숫자는 리포트 요약 줄에)
    const own = Object.entries(outcome.result.figures).filter(([id]) => !isReportFigureId(id));
    const unavailable = own.filter(([, f]) => f.reason).length;
    return {
      status: "succeeded",
      output: {
        result: outcome.result,
        version: outcome.version,
        versionHash: outcome.versionHash,
        diagnoses: outcome.diagnoses,
      },
      inputSummary: `${request.metrics.join("·")}, ${request.groupBy} 묶음${request.peers.length > 0 ? `, 비교 ${request.peers.length}곳` : ""}`,
      outputSummary: [
        `차트 ${outcome.result.charts.length}개, 숫자 ${own.length}개${unavailable > 0 ? ` (계산 불가 ${unavailable}개)` : ""}`,
        // 주가 결합 전후 행 수 (WU-502, TECH §6.6 "기록")
        ...(outcome.priceJoin ? [outcome.priceJoin.summary] : []),
        `투자 리포트: ${report.summary}`,
      ].join(" · "),
      usage: {
        externalCalls: (outcome.priceJoin?.externalCalls ?? 0) + report.externalCalls,
        llmCostUsd: 0,
      },
    };
  } catch (err) {
    return failure(err);
  }
};

/** 리포트를 만들어 결과에 붙인다 (숫자 ID는 f100001부터라 질문 결과와 겹치지 않는다) */
async function attachReport(
  result: ResultObject,
  request: AnalysisRequestView,
  ctx: ToolContext,
): Promise<{ summary: string; externalCalls: number }> {
  try {
    const built = await buildCompanyReport(request.target, {
      client: ctx.client,
      userId: ctx.userId,
      analysisId: ctx.analysisId,
      peers: request.peers.length > 0 ? request.peers : undefined,
    });
    result.report = built.report;
    result.figures = { ...result.figures, ...built.figures };
    return { summary: built.summary, externalCalls: built.externalCalls };
  } catch (err) {
    console.error(`[report] 투자 리포트 실패 (${request.target.name})`, err);
    return {
      summary: `만들지 못함 (${err instanceof Error ? err.message : String(err)})`,
      externalCalls: 0,
    };
  }
}
