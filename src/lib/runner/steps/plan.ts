// WU-301 계획: 분석 요청 → 실행 단계(PlannedStep[]) + 복합 판별 + 계획 카드 (TECH §4.6, PHASE2_PLAN §3.2).
// 순수 함수만 둔다 — DB·외부 호출 없음 (승인 전에는 아무것도 부르지 않는다).
import type { AnalysisRequestView, MetricId, Plan } from "@/contracts";
import { addQuarters, quarterSpan } from "@/lib/ask/quarter";
import { METRIC_LABEL } from "@/lib/runner/metric-info";
import type { PlannedStep, ToolName } from "@/lib/runner/tools/types";

/** 경쟁사 자동 선택 개수 (기업 수 ≤ 6 = 대상 1 + 경쟁사 5, TECH §4.5) */
export const AUTO_PEER_COUNT = 3;

/** `analyses.plan`에 저장하는 모양. 화면용 `Plan`(계약)은 여기서 만든다 */
export interface StoredPlan {
  steps: PlannedStep[];
  /** 복합 질문이면 true → 승인(Q7) 전에는 실행하지 않는다 */
  complex: boolean;
  /** 승인한 시각. 단순 질문은 만들 때 바로 채운다 */
  approvedAt: string | null;
  estimatedExternalCalls: number;
  estimatedSeconds: number;
}

// 단계별 예상 (처음 조회하는 기업 기준의 넉넉한 값 — 한 번 받은 보고서는 캐시라 실제로는 더 적다)
const SECONDS: Record<ToolName, number> = {
  get_peers: 1,
  get_financials: 12,
  get_disclosures: 3,
  search_news: 8,
  build_result: 2,
  write_explanation: 8,
};

function isComparison(request: AnalysisRequestView): boolean {
  return (
    request.intent === "compare" || request.groupBy === "company" || request.groupBy === "sector"
  );
}

/**
 * 재무는 요청 시작보다 4분기 앞부터 받는다 — `runAnalysis`가 YoY·QoQ용으로 그만큼 앞을 읽는다
 * (`execute.ts` CHANGE_LOOKBACK_QUARTERS). 안 받아 두면 build_result 단계 안에서 보고서를 받게 되어
 * 실행 기록의 외부 호출 수·시간이 어긋난다 (통합 검토, 트랙 B 부탁)
 */
const LOOKBACK_QUARTERS = 4;

function fetchFrom(request: AnalysisRequestView) {
  return addQuarters(request.period.from, -LOOKBACK_QUARTERS);
}

/** 보고서 수(분기마다 1개, 앞 4분기 포함) + 기업개황 1 — 캐시가 없을 때의 최대 호출 수 */
function reportCalls(request: AnalysisRequestView): number {
  return quarterSpan(fetchFrom(request), request.period.to) + 1;
}

/** 증감률·파생 지표는 기사 제목에 거의 나오지 않는 이름이라 뉴스 핵심어에서 뺀다 ("YoY 증감률" 등) */
const DERIVED_METRICS: ReadonlySet<MetricId> = new Set(["yoy", "qoq", "ttm_owners_ni"]);
/** 뉴스 검색 핵심어 수 (src/lib/news: 0~3개) */
export const MAX_NEWS_KEYWORDS = 3;

/** 뉴스 핵심어 = 요청 지표 중 기본 지표의 한글 이름 (최대 3개). 없으면 "실적" */
export function newsKeywords(request: AnalysisRequestView): string[] {
  const names = request.metrics.filter((m) => !DERIVED_METRICS.has(m)).map((m) => METRIC_LABEL[m]);
  const unique = [...new Set(names)].slice(0, MAX_NEWS_KEYWORDS);
  return unique.length > 0 ? unique : ["실적"];
}

/** 계획 규칙 (PHASE2_PLAN §3.2). 순서: 경쟁사 → 재무(대상) → 재무(경쟁사) → 공시 → 뉴스 → 결과 → 분석 글 */
export function planSteps(request: AnalysisRequestView): PlannedStep[] {
  const { target, period } = request;
  const steps: Omit<PlannedStep, "seq">[] = [];
  const range = `${period.from}~${period.to}`;
  const from = fetchFrom(request);
  const autoPeers = isComparison(request) && request.peers.length === 0;

  if (autoPeers) {
    steps.push({
      tool: "get_peers",
      label: `${target.name} 경쟁사 고르기`,
      input: { target, count: AUTO_PEER_COUNT },
    });
  }
  steps.push({
    tool: "get_financials",
    label: `${target.name} 재무 수집 (${range})`,
    input: { companies: [target], from, to: period.to },
  });
  if (request.peers.length > 0) {
    steps.push({
      tool: "get_financials",
      label: `${request.peers.map((p) => p.name).join("·")} 재무 수집`,
      input: { companies: request.peers, from, to: period.to },
    });
  } else if (autoPeers) {
    steps.push({
      tool: "get_financials",
      label: "경쟁사 재무 수집",
      input: { fromPeers: true, from, to: period.to },
    });
  }
  if (request.intent === "event") {
    steps.push({
      tool: "get_disclosures",
      label: `${target.name} 중요 공시 확인`,
      input: { company: target, period },
    });
  }
  if (request.needsNews) {
    steps.push({
      tool: "search_news",
      label: `${target.name} 관련 뉴스 찾기`,
      input: { company: target, period, keywords: newsKeywords(request) },
    });
  }
  steps.push({ tool: "build_result", label: "차트·표 계산", input: {} });
  steps.push({ tool: "write_explanation", label: "분석 글 작성", input: {} });

  return steps.map((step, i) => ({ ...step, seq: i + 1 }) as PlannedStep);
}

/** 복합 = 마지막 둘(결과·분석 글)을 뺀 단계가 3개 이상이거나 뉴스 단계가 있다 (TECH §4.6) */
export function isComplexPlan(steps: readonly PlannedStep[]): boolean {
  const work = steps.filter((s) => s.tool !== "build_result" && s.tool !== "write_explanation");
  return work.length >= 3 || steps.some((s) => s.tool === "search_news");
}

function companyCount(step: PlannedStep): number {
  if (step.tool !== "get_financials") return 1;
  const input = step.input as PlannedStep<"get_financials">["input"];
  return "companies" in input ? input.companies.length : AUTO_PEER_COUNT;
}

/** 예상 외부 호출 수 (OpenDART·뉴스·AI). 캐시가 없을 때의 최대값 */
export function estimateExternalCalls(
  steps: readonly PlannedStep[],
  request: AnalysisRequestView,
): number {
  return steps.reduce((sum, step) => {
    switch (step.tool) {
      case "get_financials":
        return sum + companyCount(step) * reportCalls(request);
      case "get_disclosures":
        return sum + 1;
      case "search_news":
        // 검색 1회 + 본문 최대 5건 (TECH §4.7 max_news_bodies) + 요지 AI 1회
        return sum + 7;
      case "write_explanation":
        // AI 1회 + 공시 원문 최대 2건 (최근 보고서·최근 사업보고서, src/lib/filings)
        return sum + 3;
      default:
        return sum;
    }
  }, 0);
}

export function estimateSeconds(steps: readonly PlannedStep[]): number {
  return steps.reduce((sum, step) => sum + SECONDS[step.tool] * companyCount(step), 0);
}

/** 분석 요청으로 저장할 계획을 만든다. 단순 질문은 승인이 필요 없어 approvedAt을 바로 채운다 */
export function buildStoredPlan(request: AnalysisRequestView, now = new Date()): StoredPlan {
  const steps = planSteps(request);
  const complex = isComplexPlan(steps);
  return {
    steps,
    complex,
    approvedAt: complex ? null : now.toISOString(),
    estimatedExternalCalls: estimateExternalCalls(steps, request),
    estimatedSeconds: estimateSeconds(steps),
  };
}

/** 계획 카드·실행 기록용 계약 모양 (API_SPEC §2.4 Plan) */
export function toPlanView(plan: StoredPlan): Plan {
  return {
    steps: plan.steps.map(({ seq, tool, label }) => ({ seq, tool, label })),
    estimatedExternalCalls: plan.estimatedExternalCalls,
    estimatedSeconds: plan.estimatedSeconds,
  };
}
