// @vitest-environment node
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it } from "vitest";

import type { AnalysisRequestView, Explanation } from "@/contracts";
import {
  AnalysisCanceledError,
  runOneStep,
  NEWS_SKIPPED_FOR_REUSE,
  runStepRequest,
  SIMPLE_PROGRESS_RETURN_MS,
  STALE_RUNNING_MS,
  type ToolTable,
} from "@/lib/runner/steps/engine";
import { buildStoredPlan } from "@/lib/runner/steps/plan";
import type { EngineAnalysis } from "@/lib/runner/steps/store";
import type { ToolContext, ToolName, ToolOutcome } from "@/lib/runner/tools/types";

import { skhynixRecent } from "../fixtures/mock/skhynix-recent";
import { createMemoryStore, type MemoryState } from "./steps-memory-store";

// WU-302 단계 실행 엔진 — 가짜 TOOLS와 메모리 저장소로 확인한다 (PHASE2_PLAN §3.3)

const ID = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const VERSION = "44444444-4444-8444-8444-444444444444";

const simpleRequest: AnalysisRequestView = skhynixRecent.request!;
const newsRequest: AnalysisRequestView = { ...simpleRequest, intent: "cause", needsNews: true };

const EXPLANATION = { status: "ready", label: "AI 작성", conclusion: ["새 설명"] } as Explanation;

let clock = 0;
let calls: { tool: ToolName; ctx: ToolContext }[] = [];
let scripted: Partial<Record<ToolName, ToolOutcome[]>> = {};
let onRun: Partial<Record<ToolName, () => void>> = {};
let memory: MemoryState;
let store: ReturnType<typeof createMemoryStore>["store"];
/** 도구 한 번에 걸리는 가짜 시간(ms) */
let toolMs = 1000;

function ok(tool: ToolName): ToolOutcome {
  const outputs: Record<ToolName, unknown> = {
    get_peers: { peers: [] },
    get_financials: { companies: [simpleRequest.target], sources: [{ rceptNo: "r1" }] },
    get_disclosures: { disclosures: [] },
    search_news: { clues: [], notes: [] },
    build_result: {
      result: { basis: { dataVersionId: VERSION }, figures: { f1: {} }, charts: [] },
      version: { sources: [], calcVersion: "v2", priceDate: null, decisions: {} },
      versionHash: "hash",
      diagnoses: [],
    },
    write_explanation: { explanation: EXPLANATION },
  };
  return {
    status: "succeeded",
    output: outputs[tool],
    inputSummary: `${tool} 입력`,
    outputSummary: `${tool} 결과`,
    usage: { externalCalls: 1, llmCostUsd: 0 },
  } as ToolOutcome;
}

const tools = Object.fromEntries(
  (
    [
      "get_peers",
      "get_financials",
      "get_disclosures",
      "search_news",
      "build_result",
      "write_explanation",
    ] as ToolName[]
  ).map((tool) => [
    tool,
    async (_input: unknown, ctx: ToolContext) => {
      calls.push({
        tool,
        ctx: structuredClone({ ...ctx, client: null }) as unknown as ToolContext,
      });
      clock += toolMs;
      onRun[tool]?.();
      return scripted[tool]?.shift() ?? ok(tool);
    },
  ]),
) as unknown as ToolTable;

function setup(request: AnalysisRequestView, overrides: Partial<EngineAnalysis> = {}) {
  const created = createMemoryStore({
    id: ID,
    ownerId: USER,
    status: "queued",
    question: "SK하이닉스 최근 실적 어때?",
    mixedScope: false,
    request,
    decisions: null,
    plan: buildStoredPlan(request, new Date(0)),
    ...overrides,
  });
  memory = created.state;
  store = created.store;
}

const deps = () => ({
  store,
  tools,
  client: {} as SupabaseClient,
  now: () => clock,
});

function approve() {
  memory.analysis.plan = { ...memory.analysis.plan!, approvedAt: new Date(0).toISOString() };
}

beforeEach(() => {
  clock = 1_000_000;
  toolMs = 1000;
  calls = [];
  scripted = {};
  onRun = {};
  setup(simpleRequest);
});

describe("단순 질문 — 한 요청 안에서 끝까지 (지금과 같은 동작)", () => {
  it("재무 → 결과 → 분석 글을 차례로 실행하고, 앞 단계 결과를 ctx.previous로 넘긴다", async () => {
    const res = await runStepRequest(ID, deps());
    expect(res).toMatchObject({ status: "succeeded", next: "done" });
    expect(calls.map((c) => c.tool)).toEqual([
      "get_financials",
      "build_result",
      "write_explanation",
    ]);
    expect(calls[1].ctx.previous.map((p) => p.tool)).toEqual(["get_financials"]);
    expect(calls[2].ctx.previous.map((p) => p.tool)).toEqual(["get_financials", "build_result"]);
    expect(memory.steps.map((s) => [s.seq, s.status])).toEqual([
      [1, "succeeded"],
      [2, "succeeded"],
      [3, "succeeded"],
    ]);
  });

  it("실행 기록에 입력 요약·결과 요약·시간이 남는다", async () => {
    await runStepRequest(ID, deps());
    expect(memory.steps[0]).toMatchObject({
      tool: "get_financials",
      inputSummary: "get_financials 입력",
      outputSummary: "get_financials 결과",
      durationMs: 1000,
      errorReason: null,
      externalCalls: 1,
    });
  });

  it("끝나면 데이터 버전을 저장하고 분석에 결과·설명·버전 ID·요청 해시를 남긴다 (WU-202)", async () => {
    await runStepRequest(ID, deps());
    expect(memory.savedVersions).toEqual([
      {
        id: VERSION,
        ownerId: USER,
        hash: "hash",
        content: { sources: [], calcVersion: "v2", priceDate: null, decisions: {} },
      },
    ]);
    const final = memory.patches.at(-1)!;
    expect(final).toMatchObject({
      status: "succeeded",
      dataset_version_id: VERSION,
      explanation: EXPLANATION,
    });
    expect(typeof final.request_hash).toBe("string");
  });

  it("같은 요청 + 같은 데이터 버전의 설명이 있으면 write_explanation을 부르지 않고 재사용한다", async () => {
    memory.reusable = { ...EXPLANATION, conclusion: ["저장된 설명"] };
    await runStepRequest(ID, deps());
    expect(calls.map((c) => c.tool)).not.toContain("write_explanation");
    expect(memory.patches.at(-1)!.explanation).toEqual(memory.reusable);
    expect(memory.steps[2].outputSummary).toContain("재사용");
    expect(memory.reuseQueries[0]).toMatchObject({ dataVersionId: VERSION, excludeAnalysisId: ID });
  });

  it("단순 질문에는 실행 시간 상한을 걸지 않는다 (처음 조회 기업의 긴 수집도 끝까지)", async () => {
    toolMs = 120_000;
    let res = await runStepRequest(ID, deps());
    for (let i = 0; i < 5 && res.next === "step"; i++) res = await runStepRequest(ID, deps());
    expect(res.status).toBe("succeeded");
    expect(memory.analysis.stop_reason).toBeNull();
  });

  it("오래 걸리는 단순 질문은 중간에 돌아가 진행 상태를 보여 준다 (WU-399 §2.1, 빠르면 한 요청에서 끝)", async () => {
    toolMs = SIMPLE_PROGRESS_RETURN_MS + 1;
    const first = await runStepRequest(ID, deps());
    expect(first).toMatchObject({ status: "running", next: "step" });
    expect(first.progress).toMatchObject({ current: 1, total: 3 });
    expect(calls.map((c) => c.tool)).toEqual(["get_financials"]);
  });
});

describe("복합 질문 — 승인 전 0건, 승인 뒤 한 요청에 한 단계", () => {
  beforeEach(() => setup(newsRequest));

  it("승인 전이면 도구를 하나도 부르지 않고 awaiting_approval로 돌린다", async () => {
    const res = await runOneStep(ID, deps());
    expect(res).toMatchObject({ status: "awaiting_approval", next: "done" });
    expect(calls).toEqual([]);
    expect(memory.steps).toEqual([]);
  });

  it("계획 없이 queued가 된 복합 분석(되묻기 답·재분석)도 계획을 만들고 승인을 기다린다", async () => {
    setup(newsRequest, { plan: null });
    const res = await runOneStep(ID, deps());
    expect(res.status).toBe("awaiting_approval");
    expect(memory.analysis.plan?.complex).toBe(true);
    expect(calls).toEqual([]);
  });

  it("승인 뒤에는 Q4마다 한 단계씩, 진행 상태 '1/4단계 — …'를 돌려준다", async () => {
    approve();
    const first = await runStepRequest(ID, deps());
    expect(calls.map((c) => c.tool)).toEqual(["get_financials"]);
    expect(first).toMatchObject({ status: "running", next: "step" });
    expect(first.progress).toEqual({
      current: 1,
      total: 4,
      label: "1/4단계 — SK하이닉스 관련 뉴스 찾기 중",
    });
    expect(first.lastStep).toMatchObject({ seq: 1, tool: "get_financials", status: "succeeded" });

    for (let i = 0; i < 3; i++) await runStepRequest(ID, deps());
    expect(calls.map((c) => c.tool)).toEqual([
      "get_financials",
      "search_news",
      "build_result",
      "write_explanation",
    ]);
    expect(memory.analysis.status).toBe("succeeded");
  });

  it("복구: 앞 단계가 이미 성공해 있으면 다음 단계부터, 앞 결과를 그대로 쓴다", async () => {
    approve();
    await runStepRequest(ID, deps());
    calls = [];
    // 창을 닫았다 다시 열어 Q4가 다시 시작된 것과 같다
    await runStepRequest(ID, deps());
    expect(calls.map((c) => c.tool)).toEqual(["search_news"]);
    expect(calls[0].ctx.previous.map((p) => p.tool)).toEqual(["get_financials"]);
  });

  it("실행 시간 상한(90초)에 닿으면 결과(build_result)까지 만들고 분석 글 앞에서 멈춘다 — 부분 결과(TIMEOUT)", async () => {
    approve();
    toolMs = 50_000;
    await runStepRequest(ID, deps()); // 50초
    await runStepRequest(ID, deps()); // 100초 — 상한 넘음
    // 결과 계산은 받아 둔 보고서로만 해서(AI·외부 호출 없음) 상한과 상관없이 한다 — 질문 수를 쓰고 결과가 없으면 안 된다
    await runStepRequest(ID, deps());
    const res = await runStepRequest(ID, deps());
    expect(res).toMatchObject({ status: "partial", next: "done" });
    expect(memory.analysis.stop_reason).toBe("TIMEOUT");
    expect(calls.map((c) => c.tool)).toEqual(["get_financials", "search_news", "build_result"]);
    expect(memory.analysis.result).not.toBeNull();
    expect(memory.steps.find((s) => s.tool === "write_explanation")).toMatchObject({
      status: "skipped",
      errorReason: "실행 시간 상한에 닿아 멈춤",
    });
  });
});

describe("재시도 (최대 2회, 외부 API 오류·시간 초과만)", () => {
  const upstream: ToolOutcome = {
    status: "failed",
    retryable: true,
    errorReason: "OpenDART 응답 없음",
  };

  it("계속 실패하면 처음 1회 + 재시도 2회만 부르고 실패로 끝내며 사유를 남긴다", async () => {
    scripted.get_financials = [upstream, upstream, upstream, upstream];
    const res = await runStepRequest(ID, deps());
    expect(calls.filter((c) => c.tool === "get_financials")).toHaveLength(3);
    expect(res.status).toBe("failed");
    expect(memory.analysis.stop_reason).toBe("UPSTREAM_ERROR");
    expect(memory.steps[0]).toMatchObject({ status: "failed", retries: 2 });
    expect(memory.steps[0].errorReason).toContain("재시도 2회 후 중단");
    expect(calls.map((c) => c.tool)).not.toContain("build_result");
  });

  it("한 번 실패 뒤 성공하면 이어서 끝까지 (재시도 1회 기록)", async () => {
    scripted.get_financials = [upstream];
    const res = await runStepRequest(ID, deps());
    expect(res.status).toBe("succeeded");
    expect(memory.steps[0]).toMatchObject({ status: "succeeded", retries: 1 });
  });

  it("재시도 대상이 아닌 실패는 곧바로 끝낸다", async () => {
    scripted.get_financials = [{ status: "failed", retryable: false, errorReason: "기업 없음" }];
    const res = await runStepRequest(ID, deps());
    expect(calls).toHaveLength(1);
    expect(res.status).toBe("failed");
    expect(memory.analysis.stop_reason).toBeNull();
  });

  it("도구가 계약과 달리 던져도 500이 아니라 실패로 기록한다", async () => {
    onRun.get_financials = () => {
      throw new Error("예상 못 한 오류");
    };
    const res = await runStepRequest(ID, deps());
    expect(res.status).toBe("failed");
    expect(memory.steps[0]).toMatchObject({ status: "failed", errorReason: "예상 못 한 오류" });
  });

  it("맡은 요청이 끊겨(시간 초과) running으로 남은 단계는 다음 요청이 재시도 1회로 세고 다시 한다", async () => {
    memory.steps.push({
      seq: 1,
      tool: "get_financials",
      status: "running",
      retries: 0,
      inputSummary: "",
      outputSummary: null,
      output: null,
      durationMs: null,
      errorReason: null,
      externalCalls: 0,
      llmCostUsd: 0,
      startedAt: new Date(clock - STALE_RUNNING_MS - 1).toISOString(),
    });
    memory.analysis.status = "running";
    const res = await runStepRequest(ID, deps());
    expect(res.status).toBe("succeeded");
    expect(memory.steps[0]).toMatchObject({ status: "succeeded", retries: 1 });
  });

  it("끊긴 채 재시도를 다 쓴 단계는 '시간 초과'로 실패 처리한다", async () => {
    memory.steps.push({
      seq: 1,
      tool: "get_financials",
      status: "running",
      retries: 2,
      inputSummary: "",
      outputSummary: null,
      output: null,
      durationMs: null,
      errorReason: null,
      externalCalls: 0,
      llmCostUsd: 0,
      startedAt: new Date(clock - STALE_RUNNING_MS - 1).toISOString(),
    });
    memory.analysis.status = "running";
    const res = await runOneStep(ID, deps());
    expect(calls).toEqual([]);
    expect(res.status).toBe("failed");
    expect(memory.steps[0].errorReason).toContain("시간 초과");
  });
});

describe("리뷰 반영 — 끊긴 단계", () => {
  function staleRow(retries: number) {
    return {
      seq: 1,
      tool: "get_financials" as const,
      status: "running" as const,
      retries,
      inputSummary: "",
      outputSummary: null,
      output: null,
      durationMs: 5000,
      errorReason: null,
      externalCalls: 0,
      llmCostUsd: 0,
      startedAt: new Date(clock - STALE_RUNNING_MS - 1).toISOString(),
    };
  }

  it("재시도를 다 쓴 끊긴 단계라도 다른 요청이 먼저 다시 맡았으면 분석을 실패로 끝내지 않는다", async () => {
    memory.steps.push(staleRow(2));
    memory.analysis.status = "running";
    // 이 요청이 실패로 표시하려는 순간 다른 요청이 이미 맡아 시작 시각이 바뀐 것과 같다
    const original = store.updateStep;
    store.updateStep = async (id, seq, patch, expect) => {
      memory.steps[0].startedAt = new Date(clock).toISOString();
      return original(id, seq, patch, expect);
    };
    const res = await runOneStep(ID, deps());
    expect(res).toMatchObject({ status: "running", next: "step" });
    expect(memory.analysis.status).toBe("running");
  });

  it("끊긴 시도가 쓴 시간도 실행 기록 시간·실행 시간 상한에 더한다", async () => {
    memory.steps.push(staleRow(0));
    memory.analysis.status = "running";
    await runOneStep(ID, deps());
    // 앞선 기록 5초 + 끊긴 시도(STALE_RUNNING_MS 이상) + 이번 시도 1초
    expect(memory.steps[0].durationMs).toBeGreaterThanOrEqual(5000 + STALE_RUNNING_MS + 1000);
  });
});

describe("동시 요청 — 같은 단계는 하나만", () => {
  it("다른 요청이 방금 맡은 단계면 실행하지 않고 진행 상태만 (next: step)", async () => {
    memory.steps.push({
      seq: 1,
      tool: "get_financials",
      status: "running",
      retries: 0,
      inputSummary: "SK하이닉스 재무 수집",
      outputSummary: null,
      output: null,
      durationMs: null,
      errorReason: null,
      externalCalls: 0,
      llmCostUsd: 0,
      startedAt: new Date(clock - 1000).toISOString(),
    });
    memory.analysis.status = "running";
    const res = await runStepRequest(ID, deps());
    expect(calls).toEqual([]);
    expect(res).toMatchObject({ status: "running", next: "step" });
    expect(res.lastStep).toMatchObject({ seq: 1, status: "running" });
  });
});

describe("취소 (Q8)", () => {
  it("취소된 분석의 Q4는 도구를 하나도 부르지 않고 거부한다", async () => {
    memory.analysis.status = "canceled";
    await expect(runOneStep(ID, deps())).rejects.toBeInstanceOf(AnalysisCanceledError);
    expect(calls).toEqual([]);
  });

  it("실행 중에 취소되면 그 단계 결과를 버리고 다음 단계로 가지 않는다", async () => {
    onRun.get_financials = () => {
      memory.analysis.status = "canceled";
    };
    const res = await runStepRequest(ID, deps());
    expect(res).toMatchObject({ status: "canceled", next: "done" });
    expect(calls).toHaveLength(1);
    expect(memory.steps[0]).toMatchObject({
      status: "skipped",
      errorReason: "취소되어 결과를 버림",
    });
    expect(memory.savedVersions).toEqual([]);
  });
});

describe("상한 (단계 수·AI 비용)", () => {
  it("단계 수 상한에 닿으면 멈추고 부분 결과(STEP_LIMIT) — 결과 단계가 끝났으면 결과는 남긴다", async () => {
    memory.limits.maxSteps = 2;
    const res = await runStepRequest(ID, deps());
    expect(res.status).toBe("partial");
    expect(memory.analysis.stop_reason).toBe("STEP_LIMIT");
    expect(calls.map((c) => c.tool)).toEqual(["get_financials", "build_result"]);
    expect(memory.patches.at(-1)).toMatchObject({ status: "partial", dataset_version_id: VERSION });
    expect(memory.steps.find((s) => s.seq === 3)?.errorReason).toBe("단계 수 상한에 닿아 멈춤");
  });

  it("AI 비용 상한에 닿으면 다음 단계 전에 멈춘다 (COST_LIMIT)", async () => {
    scripted.get_financials = [
      {
        ...(ok("get_financials") as object),
        usage: { externalCalls: 1, llmCostUsd: 0.11 }, // 기본 상한 $0.10을 넘는다
      } as ToolOutcome,
    ];
    const res = await runStepRequest(ID, deps());
    expect(res.status).toBe("partial");
    expect(memory.analysis.stop_reason).toBe("COST_LIMIT");
    // 결과 계산(AI 비용 없음)까지는 하고 분석 글(AI) 앞에서 멈춘다
    expect(calls.map((c) => c.tool)).toEqual(["get_financials", "build_result"]);
  });
});

describe("전처리 확인 (needs_preprocess → Q5 → build_result부터)", () => {
  it("멈췄다가 Q5 뒤에는 재무 수집을 다시 하지 않고 결과 단계부터, 고른 선택을 넘긴다", async () => {
    const diagnoses = [{ id: "missing_account", kind: "missing_account", needsConfirmation: true }];
    scripted.build_result = [{ status: "needs_preprocess", diagnoses } as unknown as ToolOutcome];
    const first = await runStepRequest(ID, deps());
    expect(first).toMatchObject({ status: "awaiting_preprocess", next: "wait_preprocess" });
    expect(memory.analysis.status).toBe("awaiting_preprocess");
    expect(memory.patches.at(-1)).toMatchObject({ diagnoses });
    expect(memory.steps[1]).toMatchObject({ tool: "build_result", status: "pending" });

    // 대기 중 Q4는 아무것도 하지 않는다
    calls = [];
    expect((await runOneStep(ID, deps())).next).toBe("wait_preprocess");
    expect(calls).toEqual([]);

    // Q5(예림)가 하는 일: 선택 저장 + queued
    memory.analysis.status = "queued";
    memory.analysis.decisions = { missing_account: "show_blank" };
    const res = await runStepRequest(ID, deps());
    expect(res.status).toBe("succeeded");
    expect(calls.map((c) => c.tool)).toEqual(["build_result", "write_explanation"]);
    expect(calls[0].ctx.decisions).toEqual({ missing_account: "show_blank" });
    expect(calls[0].ctx.previous.map((p) => p.tool)).toEqual(["get_financials"]);
  });
});

describe("설명 재사용이 거의 확실하면 뉴스를 건너뛴다 (Phase 2 후속)", () => {
  beforeEach(() => {
    setup(newsRequest);
    approve();
  });

  async function runAll() {
    for (
      let i = 0;
      i < 6 && !["succeeded", "partial", "failed"].includes(memory.analysis.status);
      i++
    ) {
      await runStepRequest(ID, deps());
    }
  }

  it("같은 요청의 저장된 분석이 있고 새 공시가 없으면 search_news를 부르지 않고, 분석 글은 재사용", async () => {
    memory.reuseCandidate = true;
    memory.reusable = { ...EXPLANATION, conclusion: ["저장된 설명"] };
    await runAll();
    expect(calls.map((c) => c.tool)).toEqual(["get_financials", "build_result"]);
    const news = memory.steps.find((s) => s.tool === "search_news")!;
    expect(news).toMatchObject({ status: "succeeded", externalCalls: 0 });
    expect(news.outputSummary).toContain("뉴스 검색 건너뜀");
    expect(memory.analysis.status).toBe("succeeded");
  });

  it("건너뛰었는데 결국 재사용하지 못하면 분석 글 직전에 뉴스를 찾아 넘긴다", async () => {
    memory.reuseCandidate = true;
    memory.reusable = null;
    await runAll();
    expect(calls.map((c) => c.tool)).toEqual([
      "get_financials",
      "build_result",
      "search_news",
      "write_explanation",
    ]);
    const writer = calls.find((c) => c.tool === "write_explanation")!;
    const news = writer.ctx.previous.find((p) => p.tool === "search_news")!;
    expect((news.output as { notes: string[] }).notes).not.toContain(NEWS_SKIPPED_FOR_REUSE);
    // 뉴스 단계 기록을 실제 결과로 바꿔 둔다 — 외부 호출·비용이 맞고, 분석 글을 다시 해도 뉴스를 또 찾지 않는다
    const row = memory.steps.find((s) => s.tool === "search_news")!;
    expect(row.outputSummary).toContain("분석 글 직전에 찾음");
    expect(row.externalCalls).toBe(1);
    expect((row.output as { notes: string[] }).notes).not.toContain(NEWS_SKIPPED_FOR_REUSE);
  });

  it("후보가 없으면 지금처럼 뉴스를 검색한다", async () => {
    await runAll();
    expect(calls.map((c) => c.tool)).toContain("search_news");
    expect(calls.findIndex((c) => c.tool === "search_news")).toBe(1);
  });
});

describe("선택 단계 실패 — 없으면 그 부분만 빠진 결과", () => {
  it("뉴스 단계가 실패해도 결과·분석 글까지 가고, 실행 기록에 실패 사유가 남는다", async () => {
    setup(newsRequest);
    approve();
    scripted.search_news = [{ status: "failed", retryable: false, errorReason: "뉴스 준비 중" }];
    for (let i = 0; i < 4; i++) await runStepRequest(ID, deps());
    expect(memory.analysis.status).toBe("succeeded");
    expect(memory.steps.find((s) => s.tool === "search_news")).toMatchObject({
      status: "failed",
      errorReason: "뉴스 준비 중",
    });
  });
});
