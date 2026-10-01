// WU-302 단계 실행 엔진 (TECH §4.7~4.9). Q4마다 계획의 **한 단계**만 TOOLS[도구](입력, ctx)로 실행하고
// analysis_steps에 남긴다. 단순 질문은 runUntilPause가 한 요청 안에서 끝까지 돌린다(Step 1과 같은 동작).
//
// - 다음 단계 = 계획에서 아직 끝나지 않은(성공·건너뜀·선택 단계 실패가 아닌) 첫 단계. ctx.previous = 성공한 앞 단계들
// - 재시도: 도구가 retryable 실패를 주면 그 단계를 pending으로 돌리고(재시도 +1) 다음 Q4가 다시 한다. max_retries까지
// - 요청 끊김(Vercel 시간 초과): running인 채 오래된 단계는 다음 Q4가 재시도 1회로 세고 다시 맡는다
// - 동시 요청: 단계 줄 만들기(고유 키)·조건부 갱신으로 하나만 맡고, 나머지는 진행 상태만 돌려준다
// - 상한: 단계 수·AI 비용은 모든 질문, 실행 시간은 복합 질문만 (단순 질문은 Step 1처럼 Q4 300초 한도 안에서 끝까지 —
//   처음 조회하는 기업은 보고서 수집만 60초를 넘길 수 있어 90초 상한을 걸면 결과 없이 끝난다)
// - needs_preprocess: build_result 단계를 pending으로 두고 awaiting_preprocess → Q5 뒤 그 단계부터 (앞 결과 재사용)
// - 끝나면 WU-202처럼 데이터 버전 저장·요청 해시·같은 요청+버전 설명 재사용
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AnalysisStatus, Progress, StepRecord, StopReason } from "@/contracts";
import {
  outputsOf,
  type CompletedStep,
  type PlannedStep,
  type Tool,
  type ToolName,
  type ToolOutcome,
  type ToolOutputs,
} from "@/lib/runner/tools/types";
import { hashAnalysisRequest } from "@/lib/versions/version";
import { buildStoredPlan, type StoredPlan } from "./plan";
import type { EngineAnalysis, EngineLimits, EngineStore, StepRow } from "./store";

export type ToolTable = { [T in ToolName]: Tool<T> };

/** 실패해도 분석을 멈추지 않는 단계 — 없으면 그 부분만 빠진 결과를 낸다 (실행 기록에 실패 사유) */
const OPTIONAL_TOOLS: ReadonlySet<ToolName> = new Set([
  "get_peers",
  "get_disclosures",
  "search_news",
]);

/** running인 채 이보다 오래되면 맡은 요청이 끊긴 것 (Q4 maxDuration 300초 + 여유) */
export const STALE_RUNNING_MS = 320_000;

export interface StepResult {
  status: AnalysisStatus;
  progress: Progress | null;
  lastStep: StepRecord | null;
  next: "step" | "done" | "wait_preprocess";
}

export interface EngineDeps {
  store: EngineStore;
  tools: ToolTable;
  /** 도구에 넘길 관리자 클라이언트 */
  client: SupabaseClient;
  now?: () => number;
}

/** 취소된 분석에 Q4가 오면 (경로가 409 INVALID_STATE로 바꾼다 — 외부 호출 없음) */
export class AnalysisCanceledError extends Error {
  constructor() {
    super("취소된 분석입니다.");
    this.name = "AnalysisCanceledError";
  }
}

export class AnalysisNotRunnableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalysisNotRunnableError";
  }
}

function isFinished(row: StepRow | undefined): boolean {
  if (!row) return false;
  if (row.status === "succeeded" || row.status === "skipped") return true;
  return row.status === "failed" && OPTIONAL_TOOLS.has(row.tool);
}

export function toStepRecord(row: StepRow): StepRecord {
  return {
    seq: row.seq,
    tool: row.tool,
    inputSummary: row.inputSummary,
    outputSummary: row.outputSummary,
    status: row.status,
    retries: row.retries,
    durationMs: row.durationMs,
    errorReason: row.errorReason,
  };
}

/** "3/5단계 — 분기 집계 중" (current = 끝난 단계 수) */
export function progressOf(plan: StoredPlan, rows: readonly StepRow[]): Progress {
  const bySeq = new Map(rows.map((r) => [r.seq, r]));
  const total = plan.steps.length;
  const current = plan.steps.filter((s) => isFinished(bySeq.get(s.seq))).length;
  const next = plan.steps.find((s) => !isFinished(bySeq.get(s.seq)));
  return {
    current,
    total,
    label: next ? `${current}/${total}단계 — ${next.label} 중` : `${total}/${total}단계 — 완료`,
  };
}

function completedSteps(rows: readonly StepRow[]): CompletedStep[] {
  return rows
    .filter((r) => r.status === "succeeded" && r.output != null)
    .map((r) => ({ seq: r.seq, tool: r.tool, output: r.output as ToolOutputs[ToolName] }));
}

function limitReached(
  plan: StoredPlan,
  next: PlannedStep,
  rows: readonly StepRow[],
  limits: EngineLimits,
): StopReason | null {
  if (next.seq > limits.maxSteps) return "STEP_LIMIT";
  // build_result는 받아 둔 보고서로 계산만 한다(AI·외부 호출 없음) — 시간·비용 상한으로 여기서 멈추면
  // 질문 수를 쓰고도 결과가 하나도 없다. 상한에 닿았으면 결과까지 만들고 분석 글 앞에서 멈춘다 (통합 검토)
  if (next.tool === "build_result") return null;
  const cost = rows.reduce((sum, r) => sum + r.llmCostUsd, 0);
  if (cost >= limits.maxLlmCostUsd) return "COST_LIMIT";
  const ms = rows.reduce((sum, r) => sum + (r.durationMs ?? 0), 0);
  if (plan.complex && ms >= limits.maxSeconds * 1000) return "TIMEOUT";
  return null;
}

const STOP_MESSAGE: Record<string, string> = {
  STEP_LIMIT: "단계 수 상한에 닿아 멈춤",
  COST_LIMIT: "AI 비용 상한에 닿아 멈춤",
  TIMEOUT: "실행 시간 상한에 닿아 멈춤",
};

/**
 * 한 단계를 실행한다 (Q4). 소유자 검사는 부르는 쪽(경로)이 했다.
 * @throws AnalysisCanceledError 취소된 분석 — 외부 호출 없이 거부
 */
export async function runOneStep(analysisId: string, deps: EngineDeps): Promise<StepResult> {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const analysis = await store.loadAnalysis(analysisId);
  if (!analysis) throw new AnalysisNotRunnableError("분석이 없습니다.");
  if (analysis.status === "canceled") throw new AnalysisCanceledError();
  if (analysis.status === "awaiting_preprocess") return pause(analysis.status, "wait_preprocess");
  if (analysis.status !== "queued" && analysis.status !== "running") {
    return pause(analysis.status, "done");
  }
  if (!analysis.request) throw new AnalysisNotRunnableError("분석 요청이 없습니다.");

  // 계획이 없는 분석(되묻기 답·최신 데이터 재분석으로 queued가 된 것)은 여기서 만든다.
  // 복합이면 승인 전이라 실행하지 않고 계획 카드로 돌린다 (승인 전 외부 호출·계산 0건)
  let plan = analysis.plan;
  if (!plan) {
    plan = buildStoredPlan(analysis.request, new Date(now()));
    await store.updateAnalysis(analysis.id, { plan }, ["queued", "running"]);
  }
  if (plan.complex && !plan.approvedAt) {
    await store.updateAnalysis(analysis.id, { status: "awaiting_approval" }, ["queued"]);
    return pause("awaiting_approval", "done");
  }
  if (analysis.status === "queued") {
    await store.updateAnalysis(analysis.id, { status: "running" }, ["queued"]);
  }

  const rows = await store.listSteps(analysis.id);
  const bySeq = new Map(rows.map((r) => [r.seq, r]));
  const next = plan.steps.find((s) => !isFinished(bySeq.get(s.seq)));
  if (!next) return finish(analysis, plan, rows, deps, null);

  const limits = await store.loadLimits();
  const stop = limitReached(plan, next, rows, limits);
  if (stop) return finish(analysis, plan, rows, deps, stop);

  // ── 단계 맡기 ──
  const existing = bySeq.get(next.seq);
  const startedAt = new Date(now()).toISOString();
  let retries = existing?.retries ?? 0;
  // 이 단계에 이미 쓴 시간 (앞선 시도들). 실행 기록의 시간과 실행 시간 상한은 모든 시도를 합한다
  let priorMs = existing?.durationMs ?? 0;
  if (!existing) {
    const claimed = await store.insertStep(analysis.id, analysis.ownerId, {
      seq: next.seq,
      tool: next.tool,
      status: "running",
      retries: 0,
      inputSummary: next.label,
      outputSummary: null,
      output: null,
      durationMs: null,
      errorReason: null,
      externalCalls: 0,
      llmCostUsd: 0,
      startedAt,
    });
    if (!claimed) return busy(plan, analysis.id, deps);
  } else if (existing.status === "running") {
    const stale = !existing.startedAt || now() - Date.parse(existing.startedAt) > STALE_RUNNING_MS;
    if (!stale) return busy(plan, analysis.id, deps, existing);
    // 맡았던 요청이 끊겼다(시간 초과 등) → 재시도 1회로 센다. 끊긴 시도가 쓴 시간도 더한다
    const killedMs = existing.startedAt ? now() - Date.parse(existing.startedAt) : 0;
    priorMs += Math.max(0, Math.round(killedMs));
    if (existing.retries >= limits.maxRetries) {
      const marked = await store.updateStep(
        analysis.id,
        next.seq,
        {
          status: "failed",
          errorReason: `시간 초과 — 재시도 ${existing.retries}회 후 중단`,
          durationMs: priorMs,
          finishedAt: startedAt,
        },
        { status: "running", startedAt: existing.startedAt },
      );
      // 다른 요청이 먼저 이 단계를 다시 맡았으면 실패로 끝내지 않는다
      if (!marked) return busy(plan, analysis.id, deps);
      if (OPTIONAL_TOOLS.has(next.tool)) return afterProgress(analysis.id, deps);
      return afterFinalFailure(analysis, plan, next, deps, true);
    }
    retries = existing.retries + 1;
    const claimed = await store.updateStep(
      analysis.id,
      next.seq,
      { startedAt, retries, durationMs: priorMs, errorReason: "요청이 끊겨 다시 실행" },
      { status: "running", startedAt: existing.startedAt },
    );
    if (!claimed) return busy(plan, analysis.id, deps);
  } else {
    // pending(재시도 대기·전처리 뒤 다시) 또는 필수 단계 실패 뒤 다시 시도
    const claimed = await store.updateStep(
      analysis.id,
      next.seq,
      { status: "running", startedAt },
      { status: existing.status, startedAt: existing.startedAt },
    );
    if (!claimed) return busy(plan, analysis.id, deps);
  }

  // ── 실행 ──
  const previous = completedSteps(rows);
  const t0 = now();
  const outcome = await executeTool(next, analysis, previous, deps);
  const durationMs = priorMs + Math.max(0, Math.round(now() - t0));
  const finishedAt = new Date(now()).toISOString();

  // 실행 중에 취소됐으면 결과를 버린다 (API_SPEC Q8)
  const current = await store.loadAnalysis(analysis.id);
  if (!current || current.status === "canceled") {
    await store.updateStep(analysis.id, next.seq, {
      status: "skipped",
      durationMs,
      errorReason: "취소되어 결과를 버림",
      finishedAt,
    });
    return pause("canceled", "done");
  }

  const usage = "usage" in outcome && outcome.usage ? outcome.usage : null;
  const cost = { externalCalls: usage?.externalCalls ?? 0, llmCostUsd: usage?.llmCostUsd ?? 0 };

  if (outcome.status === "succeeded") {
    await store.updateStep(analysis.id, next.seq, {
      status: "succeeded",
      inputSummary: outcome.inputSummary,
      outputSummary: outcome.outputSummary,
      output: outcome.output,
      durationMs,
      errorReason: null,
      finishedAt,
      ...cost,
    });
    return afterProgress(analysis.id, deps);
  }

  if (outcome.status === "needs_preprocess") {
    // 이 단계를 다시 할 수 있게 pending으로 두고, 진단 카드(Q5)를 기다린다
    await store.updateStep(analysis.id, next.seq, {
      status: "pending",
      outputSummary: `확인이 필요한 데이터 ${outcome.diagnoses.filter((d) => d.needsConfirmation).length}건`,
      durationMs,
      startedAt: null,
      finishedAt,
    });
    await store.updateAnalysis(
      analysis.id,
      { status: "awaiting_preprocess", diagnoses: outcome.diagnoses },
      ["running"],
    );
    return pause("awaiting_preprocess", "wait_preprocess", progressOf(plan, rows));
  }

  // 실패
  if (outcome.retryable && retries < limits.maxRetries) {
    await store.updateStep(analysis.id, next.seq, {
      status: "pending",
      retries: retries + 1,
      errorReason: `${outcome.errorReason} — 다시 시도 (${retries + 1}/${limits.maxRetries})`,
      durationMs,
      startedAt: null,
      finishedAt,
      ...cost,
    });
    return afterProgress(analysis.id, deps);
  }
  await store.updateStep(analysis.id, next.seq, {
    status: "failed",
    errorReason:
      outcome.retryable && retries > 0
        ? `${outcome.errorReason} (재시도 ${retries}회 후 중단)`
        : outcome.errorReason,
    durationMs,
    finishedAt,
    ...cost,
  });
  if (OPTIONAL_TOOLS.has(next.tool)) return afterProgress(analysis.id, deps);
  return afterFinalFailure(analysis, plan, next, deps, outcome.retryable);
}

/** 뉴스 단계를 "분석 글 재사용 예정"으로 건너뛰었다는 표시 (search_news 결과 notes) */
export const NEWS_SKIPPED_FOR_REUSE = "저장된 분석 글을 다시 쓸 예정이라 뉴스 검색을 건너뜀";

/**
 * Phase 2 후속: 같은 요청으로 끝난 분석이 있고 그 뒤 새 공시가 없으면, 분석 글을 재사용해 뉴스 단서를 쓰지 않으므로
 * 뉴스 검색·요지(RSS·AI 비용)를 건너뛴다. 판단이 실패하면 건너뛰지 않는다(원래대로 검색).
 */
async function skipNewsForReuse(
  analysis: EngineAnalysis,
  deps: EngineDeps,
): Promise<ToolOutcome | null> {
  const likely = await deps.store
    .hasReusableCandidate({
      ownerId: analysis.ownerId,
      requestHash: requestHashOf(analysis),
      excludeAnalysisId: analysis.id,
    })
    .catch(() => false);
  if (!likely) return null;
  return {
    status: "succeeded",
    output: { clues: [], notes: [NEWS_SKIPPED_FOR_REUSE] },
    inputSummary: "같은 질문·같은 데이터의 저장된 분석 글 있음",
    outputSummary: "뉴스 검색 건너뜀 — 저장된 분석 글 재사용 예정 (외부 호출 없음)",
    usage: { externalCalls: 0, llmCostUsd: 0 },
  };
}

function runTool(
  step: PlannedStep,
  analysis: EngineAnalysis,
  previous: CompletedStep[],
  deps: EngineDeps,
): Promise<ToolOutcome> {
  const tool = deps.tools[step.tool] as Tool<ToolName>;
  return tool(step.input, {
    request: analysis.request!,
    question: analysis.question,
    mixedScope: analysis.mixedScope,
    analysisId: analysis.id,
    userId: analysis.ownerId,
    client: deps.client,
    decisions: analysis.decisions,
    previous,
  });
}

/**
 * 재사용할 줄 알고 뉴스를 건너뛰었는데 결국 재사용하지 못하면(데이터 버전이 달라짐), 분석 글을 쓰기 전에
 * 뉴스를 지금 찾는다 — 뉴스 단서 없는 분석 글이 되지 않게
 */
async function withLateNews(
  analysis: EngineAnalysis,
  previous: CompletedStep[],
  deps: EngineDeps,
): Promise<CompletedStep[]> {
  const skipped = previous.find(
    (p) =>
      p.tool === "search_news" &&
      (p.output as { notes?: string[] }).notes?.includes(NEWS_SKIPPED_FOR_REUSE),
  );
  const planned = analysis.plan?.steps.find((s) => s.seq === skipped?.seq);
  if (!skipped || !planned) return previous;
  const now = deps.now ?? Date.now;
  const t0 = now();
  const fresh = await runTool(planned, analysis, previous, deps).catch(() => null);
  if (fresh?.status !== "succeeded") return previous;
  // 뉴스 단계 줄을 실제 결과로 바꿔 둔다 — 실행 기록·외부 호출·AI 비용(상한)이 맞고, 분석 글 단계를 다시 해도
  // (재시도·복구) 뉴스를 또 찾지 않는다
  await deps.store.updateStep(analysis.id, skipped.seq, {
    output: fresh.output,
    inputSummary: fresh.inputSummary,
    outputSummary: `${fresh.outputSummary} (분석 글을 다시 쓸 수 없어 분석 글 직전에 찾음)`,
    durationMs: Math.max(0, Math.round(now() - t0)),
    externalCalls: fresh.usage.externalCalls,
    llmCostUsd: fresh.usage.llmCostUsd,
  });
  return previous.map((p) => (p === skipped ? { ...p, output: fresh.output } : p));
}

async function executeTool(
  step: PlannedStep,
  analysis: EngineAnalysis,
  previous: CompletedStep[],
  deps: EngineDeps,
): Promise<ToolOutcome> {
  if (step.tool === "search_news") {
    const skipped = await skipNewsForReuse(analysis, deps);
    if (skipped) return skipped;
  }
  // WU-202: 같은 요청 + 같은 데이터 버전의 설명이 있으면 AI를 다시 부르지 않는다 (TECH §4.10)
  if (step.tool === "write_explanation") {
    const built = outputsOf(previous, "build_result").at(-1);
    if (built) {
      const reused = await deps.store
        .findReusableExplanation({
          ownerId: analysis.ownerId,
          dataVersionId: built.result.basis.dataVersionId,
          requestHash: requestHashOf(analysis),
          excludeAnalysisId: analysis.id,
          // 투자 리포트(Phase 5 후속)가 붙은 결과면 같은 주가 기준일의 리포트로 쓴 글만
          ...(built.result.report ? { reportPriceDate: built.result.report.priceDate } : {}),
        })
        .catch(() => null);
      if (reused) {
        return {
          status: "succeeded",
          output: { explanation: reused },
          inputSummary: `숫자 ${Object.keys(built.result.figures).length}개`,
          outputSummary: "저장된 분석 글 재사용 (같은 요청·같은 데이터, AI 호출 없음)",
          usage: { externalCalls: 0, llmCostUsd: 0 },
        };
      }
    }
  }

  try {
    const context =
      step.tool === "write_explanation" ? await withLateNews(analysis, previous, deps) : previous;
    return await runTool(step, analysis, context, deps);
  } catch (err) {
    // 도구는 던지지 않기로 했지만(계약), 던져도 분석 전체가 500이 되지 않게 실패로 기록한다
    return {
      status: "failed",
      retryable: false,
      errorReason: err instanceof Error ? err.message : String(err),
    };
  }
}

function requestHashOf(analysis: EngineAnalysis): string {
  return hashAnalysisRequest({ request: analysis.request, mixedScope: analysis.mixedScope });
}

function pause(
  status: AnalysisStatus,
  next: StepResult["next"],
  progress: Progress | null = null,
): StepResult {
  return { status, progress, lastStep: null, next };
}

/** 다른 요청이 이 단계를 실행 중 — 진행 상태만 돌려준다 (Q4 "같은 단계를 동시에 부르면 하나만") */
async function busy(
  plan: StoredPlan,
  analysisId: string,
  deps: EngineDeps,
  row?: StepRow,
): Promise<StepResult> {
  const rows = await deps.store.listSteps(analysisId);
  const running = row ?? rows.find((r) => r.status === "running");
  return {
    status: "running",
    progress: progressOf(plan, rows),
    lastStep: running ? toStepRecord(running) : null,
    next: "step",
  };
}

/** 단계 하나를 마친 뒤: 남은 단계가 있으면 step, 없으면 마무리 */
async function afterProgress(analysisId: string, deps: EngineDeps): Promise<StepResult> {
  const analysis = await deps.store.loadAnalysis(analysisId);
  if (!analysis?.plan) return pause("failed", "done");
  const rows = await deps.store.listSteps(analysisId);
  const plan = analysis.plan;
  const bySeq = new Map(rows.map((r) => [r.seq, r]));
  const last = [...rows].sort((a, b) => b.seq - a.seq).find((r) => r.status !== "running");
  if (plan.steps.every((s) => isFinished(bySeq.get(s.seq)))) {
    const done = await finish(analysis, plan, rows, deps, null);
    return { ...done, lastStep: last ? toStepRecord(last) : null };
  }
  return {
    status: "running",
    progress: progressOf(plan, rows),
    lastStep: last ? toStepRecord(last) : null,
    next: "step",
  };
}

/** 필수 단계가 끝내 실패 → 분석 실패 (결과가 이미 있으면 부분 결과) */
async function afterFinalFailure(
  analysis: EngineAnalysis,
  plan: StoredPlan,
  failed: PlannedStep,
  deps: EngineDeps,
  retryable: boolean,
): Promise<StepResult> {
  const rows = await deps.store.listSteps(analysis.id);
  const built = outputsOf(completedSteps(rows), "build_result").at(-1);
  const failedRow = rows.find((r) => r.seq === failed.seq);
  if (built) {
    const done = await finish(analysis, plan, rows, deps, "UPSTREAM_ERROR");
    return { ...done, lastStep: failedRow ? toStepRecord(failedRow) : null };
  }
  await deps.store.updateAnalysis(
    analysis.id,
    { status: "failed", stop_reason: retryable ? "UPSTREAM_ERROR" : null },
    ["running", "queued"],
  );
  return {
    status: "failed",
    progress: progressOf(plan, rows),
    lastStep: failedRow ? toStepRecord(failedRow) : null,
    next: "done",
  };
}

/**
 * 마무리: 모든 단계가 끝났거나(stop = null) 상한에 닿았다(stop). 결과가 있으면 WU-202처럼
 * 데이터 버전을 저장하고 버전 ID·요청 해시를 남긴다. 결과 없이 상한이면 부분 결과(표시만).
 */
async function finish(
  analysis: EngineAnalysis,
  plan: StoredPlan,
  rows: StepRow[],
  deps: EngineDeps,
  stop: StopReason | null,
  /** 실행 기록의 멈춘 이유 (없으면 상한 문구) */
  note?: string,
  /** 마지막 조건부 갱신의 기대 상태 (오래된 실행 정리는 먼저 partial로 바꿔 둔 뒤 부른다) */
  fromStatuses: AnalysisStatus[] = ["running", "queued"],
): Promise<StepResult> {
  const completed = completedSteps(rows);
  const built = outputsOf(completed, "build_result").at(-1);
  const explanation = outputsOf(completed, "write_explanation").at(-1)?.explanation ?? null;

  if (stop && stop !== "UPSTREAM_ERROR") {
    // 멈춘 곳을 실행 기록에 남긴다: 다음에 하려던 단계
    const bySeq = new Map(rows.map((r) => [r.seq, r]));
    const nextStep = plan.steps.find((s) => !isFinished(bySeq.get(s.seq)));
    if (nextStep && !bySeq.has(nextStep.seq)) {
      await deps.store.insertStep(analysis.id, analysis.ownerId, {
        seq: nextStep.seq,
        tool: nextStep.tool,
        status: "skipped",
        retries: 0,
        inputSummary: nextStep.label,
        outputSummary: null,
        output: null,
        durationMs: null,
        errorReason: note ?? STOP_MESSAGE[stop] ?? stop,
        externalCalls: 0,
        llmCostUsd: 0,
        startedAt: null,
      });
    }
  }

  if (!built) {
    const status: AnalysisStatus = stop ? "partial" : "failed";
    await deps.store.updateAnalysis(analysis.id, { status, stop_reason: stop }, fromStatuses);
    return { status, progress: progressOf(plan, rows), lastStep: null, next: "done" };
  }

  const dataVersionId = built.result.basis.dataVersionId;
  await deps.store.saveDataVersion({
    id: dataVersionId,
    ownerId: analysis.ownerId,
    hash: built.versionHash,
    content: built.version,
  });
  const status: AnalysisStatus = stop ? "partial" : "succeeded";
  await deps.store.updateAnalysis(
    analysis.id,
    {
      status,
      stop_reason: stop,
      result: built.result,
      explanation,
      diagnoses: built.diagnoses,
      dataset_version_id: dataVersionId,
      request_hash: requestHashOf(analysis),
    },
    fromStatuses,
  );
  return { status, progress: progressOf(plan, rows), lastStep: null, next: "done" };
}

/**
 * 단순 질문(승인이 필요 없는 계획)은 한 요청 안에서 끝까지 (TECH §4.9), 복합 질문은 한 단계만 하고 돌아간다.
 * 단순 질문이라도 한 요청이 이만큼 걸리면 남은 단계 전에 돌아가 화면이 진행 상태를 보여 준다
 * (WU-399 §2.1: 처음 조회하는 기업은 재무 수집만 수십 초라 진행 칸이 첫 단계에 머물렀다). 화면이 Q4를 이어 부른다
 */
export const SIMPLE_PROGRESS_RETURN_MS = 8_000;

export async function runStepRequest(analysisId: string, deps: EngineDeps): Promise<StepResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  let result = await runOneStep(analysisId, deps);
  // 재시도까지 넉넉히: 단계 상한 × (1 + 재시도 2회)
  for (let i = 0; i < 30 && result.next === "step"; i++) {
    const analysis = await deps.store.loadAnalysis(analysisId);
    if (!analysis?.plan || analysis.plan.complex) break;
    // 다른 요청이 맡아 실행 중이면 기다리지 않고 진행 상태를 돌려준다
    if (result.lastStep?.status === "running") break;
    // 오래 걸리는 단순 질문은 중간에 돌아가 진행 상태를 보여 준다 (빠른 질문은 지금처럼 한 요청에서 끝)
    if (now() - started >= SIMPLE_PROGRESS_RETURN_MS) break;
    result = await runOneStep(analysisId, deps);
  }
  return result;
}

/**
 * WU-501: 이만큼 아무 단계도 시작·진행하지 않은 실행 대기·실행 중 분석은 끊긴 것으로 본다 (창을 닫고 돌아오지 않음 등).
 * 이 시간 안에 다시 열면 지금처럼 마지막 성공 단계 다음부터 이어서 한다(복구). HANDOFF §0.4 "오래된 running 정리"
 */
export const IDLE_RUN_EXPIRE_MS = 60 * 60_000;

const IDLE_NOTE = "오래 진행되지 않아 정리함 (창을 닫은 뒤 1시간 넘게 이어지지 않음)";

/**
 * 이 회원의 오래 멈춘 `queued`·`running` 분석을 끝낸다: 결과 단계까지 했으면 부분 결과, 아니면 실패(TIMEOUT).
 * 실행 중인 단계(최근에 시작했거나 아직 시간이 남은 단계)가 있으면 건드리지 않는다. 상태 조건부 갱신이라
 * 그사이 다른 요청이 이어서 실행하면(복구) 그쪽이 이긴다. 질문(Q1) 때마다 그 회원 것만 본다.
 * @returns 정리한 분석 수
 */
export async function expireIdleRuns(
  ownerId: string,
  // 도구는 부르지 않는다 — 질문 경로(Q1)가 도구 모듈(무거운 수집·AI 코드)을 불러오지 않게 저장소만 받는다
  options: Pick<EngineDeps, "store" | "now">,
  idleMs = IDLE_RUN_EXPIRE_MS,
): Promise<number> {
  const deps = { ...options, tools: {} as ToolTable, client: {} as SupabaseClient };
  const now = deps.now ?? Date.now;
  const cutoff = now() - idleMs;
  const ids = await deps.store.listIdleRuns(ownerId, new Date(cutoff).toISOString());
  let expired = 0;
  for (const id of ids) {
    const analysis = await deps.store.loadAnalysis(id);
    if (!analysis || (analysis.status !== "queued" && analysis.status !== "running")) continue;
    const rows = await deps.store.listSteps(id);
    // 최근에 시작한 단계가 있으면 아직 실행 중일 수 있다 (긴 수집 단계 — Q4 최대 300초)
    const active = rows.some(
      (r) =>
        r.startedAt &&
        Date.parse(r.startedAt) + Math.max(r.durationMs ?? 0, STALE_RUNNING_MS) > cutoff,
    );
    if (active) continue;
    const plan = analysis.plan ?? (analysis.request ? buildStoredPlan(analysis.request) : null);
    const built = outputsOf(completedSteps(rows), "build_result").length > 0;
    if (plan && built) {
      // 결과까지 만들었으면 그 결과를 살려 부분 결과로 (분석 글 앞에서 끊긴 경우).
      // 상태부터 조건부로 바꿔 "이긴" 뒤에만 실행 기록·결과를 쓴다 — 그사이 다시 열려 이어서 실행하는 요청(복구)과 겹치면
      // 그쪽이 이기고, 여기서 남긴 "건너뜀" 줄이 이어지는 실행을 막지 않게
      const won = await deps.store.updateAnalysis(
        id,
        { status: "partial", stop_reason: "TIMEOUT" },
        ["queued", "running"],
      );
      if (!won) continue;
      await finish(analysis, plan, rows, deps, "TIMEOUT", IDLE_NOTE, ["partial"]);
      expired += 1;
      continue;
    }
    // 결과가 없으면 실패로 — "부분 결과"인데 보여 줄 것이 없는 화면이 되지 않게
    const done = await deps.store.updateAnalysis(id, { status: "failed", stop_reason: "TIMEOUT" }, [
      "queued",
      "running",
    ]);
    if (done) expired += 1;
  }
  return expired;
}
