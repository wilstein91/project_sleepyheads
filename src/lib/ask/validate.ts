// TECH §4.5 분석 요청 검사 (서버). AI 출력(snake_case)을 확정된 AnalysisRequestView(camelCase)로 바꾼다.
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AnalysisRequestView, Clarification, CompanyRef, MetricId } from "@/contracts";
import { resolveCompany } from "@/lib/companies/resolve";
import { METRIC_LABEL } from "@/lib/runner/metric-info";
import type { AiAnalysisRequest } from "./ai-request";
import { resolvePeriod } from "./period";
import { EARLIEST_QUARTER_LABEL } from "./quarter";

/** 지원하는 지표 (TECH §6.4). 시가총액·PER·PBR은 주가 결합(WU-502, Step 5)으로 계산한다. */
const SUPPORTED_METRICS: readonly MetricId[] = [
  "revenue",
  "operating_income",
  "net_income",
  "operating_margin",
  "net_margin",
  "yoy",
  "qoq",
  "ttm_owners_ni",
  "roe",
  "debt_ratio",
  "equity_ratio",
  "market_cap",
  "per",
  "pbr",
];

/** 질문이 지표를 지정하지 않았을 때(§4.2 예시) 기본으로 보여줄 실적 지표. */
const DEFAULT_METRICS: readonly MetricId[] = ["revenue", "operating_income", "net_income"];

/** 화면에 그대로 나가는 문구라 지표 ID(영문) 대신 한글 이름으로 쓴다 */
const UNSUPPORTED_METRIC_MESSAGE = `아직 지원하지 않는 지표입니다. 확인할 수 있는 지표: ${SUPPORTED_METRICS.filter(
  (m) => m !== "yoy" && m !== "qoq",
)
  .map((m) => METRIC_LABEL[m])
  .join(", ")}, 전년·전분기 대비 증감률`;

const MAX_COMPANIES = 6;
const MAX_PEERS = 5;

export type FinishValidationResult =
  | { type: "unsupported_question"; message: string }
  | { type: "out_of_range"; message: string }
  // 기업 수 초과 (TECH §4.5 "기업 수 ≤ 6 — 초과 오류") → 413 TOO_LARGE
  | { type: "too_large"; message: string }
  // hasOutOfScopePart: 범위 안 질문에 범위 밖 요청이 섞였는가 (TECH §4.11.1) — AnalysisRequestView에는
  // 없는 필드라 여기서 따로 들고 다니다, WU-111이 분석 글 끝에 안내 문구를 붙일 때 쓴다(§4.11.1, PRD F-U6).
  | { type: "resolved"; request: AnalysisRequestView; hasOutOfScopePart: boolean };

export type ValidateResult =
  { type: "needs_clarification"; clarification: Clarification } | FinishValidationResult;

export interface ValidateOptions {
  client?: SupabaseClient;
}

/**
 * 되묻기가 필요하면(§4.11 ② 후검사 포함) `needs_clarification`, 지원 불가/기간 밖이면 그에 맞는
 * 결과를, 모두 통과하면 확정된 `AnalysisRequestView`를 돌려준다.
 */
export async function validateAnalysisRequest(
  ai: AiAnalysisRequest,
  options: ValidateOptions = {},
): Promise<ValidateResult> {
  const targetQuery = ai.companies.find((c) => c.role === "target") ?? ai.companies[0];

  if (!targetQuery) {
    return {
      type: "needs_clarification",
      clarification: { question: "어느 기업에 대해 궁금하신가요?", options: [] },
    };
  }

  const targetResolved = await resolveCompany(targetQuery.query, options);
  if (targetResolved.type === "candidates") {
    return {
      type: "needs_clarification",
      clarification: {
        question: `"${targetQuery.query}"에 해당하는 기업이 여러 곳입니다. 어느 회사를 말씀하신 건가요?`,
        options: targetResolved.candidates.map((company, i) => ({
          id: `opt${i + 1}`,
          label: `${company.name} (${company.stockCode})`,
          company,
        })),
      },
    };
  }
  if (targetResolved.type === "not_found") {
    return {
      type: "unsupported_question",
      message: `"${targetQuery.query}"는 조회 가능한 상장사 목록에 없습니다. 다른 기업명이나 종목코드로 다시 질문해 주세요.`,
    };
  }

  return finishValidation(ai, targetResolved.company, options);
}

/** 되묻기(§4.11 ②)로 기업이 이미 확정된 뒤 나머지 검사를 이어간다 (`POST /clarify`에서 재사용). */
export async function finishValidation(
  ai: AiAnalysisRequest,
  target: CompanyRef,
  options: ValidateOptions = {},
): Promise<FinishValidationResult> {
  // 대상까지 합쳐 서로 다른 기업 이름이 6곳을 넘으면 안내한다 (조용히 앞 몇 곳만 쓰면 빠진 기업을 모른다).
  // AI가 대상 표시(role=target)를 안 하면 첫 기업이 대상이 되므로, role이 아니라 서로 다른 이름 수로 센다
  const distinctQueries = new Set(ai.companies.map((c) => c.query.trim()).filter(Boolean));
  if (distinctQueries.size > MAX_COMPANIES) {
    return {
      type: "too_large",
      message: `한 번에 비교할 수 있는 기업은 대상 포함 ${MAX_COMPANIES}곳까지입니다. 비교할 기업을 ${MAX_PEERS}곳 이하로 줄여 다시 물어봐 주세요.`,
    };
  }
  const isSum = ai.operations.some((o) => o.op === "sum");
  const peers: CompanyRef[] = [];
  const unresolved: string[] = [];
  // 대상은 validateAnalysisRequest와 같은 규칙(첫 target, 없으면 첫 기업)으로 정하고, 나머지는 role과
  // 상관없이 모두 비교 기업으로 쓴다 — AI가 "A와 B 합계"에서 두 기업을 다 target으로 내면 B가 빠졌다
  const targetQuery = ai.companies.find((c) => c.role === "target") ?? ai.companies[0];
  for (const peerQuery of ai.companies.filter((c) => c !== targetQuery)) {
    if (peers.length + 1 >= MAX_COMPANIES) break;
    const resolved = await resolveCompany(peerQuery.query, options);
    if (resolved.type !== "resolved") {
      unresolved.push(peerQuery.query);
      continue;
    }
    // 대상 기업이 비교 목록에도 들어 있거나(대상 표시 없는 "A와 B 합계") 두 이름이 같은 기업이면
    // 한 번만 쓴다 — 그대로 두면 합계에서 같은 기업이 두 번 더해진다
    const corpCode = resolved.company.corpCode;
    if (corpCode === target.corpCode || peers.some((p) => p.corpCode === corpCode)) continue;
    peers.push(resolved.company);
  }
  // 비교는 확정된 기업만 쓰고 못 찾은 기업은 뺀다(TECH §4.4). 합계는 하나라도 빠지면 틀린 합이 되므로 묻는다
  if (isSum && unresolved.length > 0) {
    return {
      type: "unsupported_question",
      message: `합계에 넣을 기업 중 "${unresolved.join(", ")}"을(를) 상장사 목록에서 찾지 못했습니다. 정확한 회사 이름으로 다시 물어봐 주세요.`,
    };
  }

  const periodResult = resolvePeriod(ai.period, ai.intent, undefined, { groupBy: ai.group_by });
  if (!periodResult.ok) {
    return {
      type: "out_of_range",
      message: `조회 가능한 기간(${EARLIEST_QUARTER_LABEL}~최신 보고서)을 벗어났습니다. 기간을 좁혀 다시 질문해 주세요.`,
    };
  }

  // ai.metrics = []는 "지정 안 함(기본 지표로 추론)"과 "목록에 없는 지표를 콕 집어 물음" 둘 다에서
  // 나올 수 있어 metrics 배열만으로는 구분이 안 된다 — AI가 따로 표시한 unsupported_metric_requested로
  // 후자를 가려낸다. 이 검사가 없으면 "직원 만족도" 같은 질문이 조용히 기본 지표로 대체돼 버린다.
  // 지원하는 지표를 함께 물었으면("매출이랑 시장점유율") 그 부분은 답한다 — 전부 목록 밖일 때만 거절.
  if (ai.unsupported_metric_requested && ai.metrics.length === 0) {
    return { type: "unsupported_question", message: UNSUPPORTED_METRIC_MESSAGE };
  }

  const requestedMetrics = ai.metrics.length > 0 ? ai.metrics : [...DEFAULT_METRICS];
  const metrics = requestedMetrics.filter((m): m is MetricId =>
    SUPPORTED_METRICS.includes(m as MetricId),
  );
  if (requestedMetrics.length > 0 && metrics.length === 0) {
    return { type: "unsupported_question", message: UNSUPPORTED_METRIC_MESSAGE };
  }

  const request: AnalysisRequestView = {
    intent: ai.intent,
    target,
    peers,
    metrics,
    period: periodResult.period,
    groupBy: ai.group_by,
    needsNews: ai.needs_news,
    // 합계는 더할 기업이 2곳 이상일 때만 뜻이 있다 (1곳이면 그 기업 값 그대로라 일반 분석으로 둔다)
    ...(isSum && peers.length > 0 ? { aggregate: "sum" as const } : {}),
  };

  return { type: "resolved", request, hasOutOfScopePart: ai.has_out_of_scope_part };
}
