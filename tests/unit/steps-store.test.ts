// @vitest-environment node
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSupabaseEngineStore } from "@/lib/runner/steps/store";

// WU-302 실제 저장소가 PostgREST에 보내는 조건 — 동시 요청 중 하나만 단계를 맡는 근거 (리뷰 반영)

interface Call {
  table: string;
  op: string;
  args: unknown[];
}

let calls: Call[] = [];
let result: { data: unknown; error: unknown } = { data: [], error: null };

function builder(table: string) {
  const record =
    (op: string) =>
    (...args: unknown[]) => {
      calls.push({ table, op, args });
      return q;
    };
  const q: Record<string, unknown> = {
    select: record("select"),
    insert: record("insert"),
    update: record("update"),
    eq: record("eq"),
    in: record("in"),
    is: record("is"),
    order: record("order"),
    not: record("not"),
    limit: record("limit"),
    maybeSingle: async () => result,
    then: (resolve: (v: unknown) => unknown) => resolve(result),
  };
  return q;
}

const client = { from: (table: string) => builder(table) } as unknown as SupabaseClient;
const store = createSupabaseEngineStore(client, client);
const ops = () => calls.map((c) => [c.op, ...c.args]);

beforeEach(() => {
  calls = [];
  result = { data: [], error: null };
});

describe("createSupabaseEngineStore", () => {
  it("updateStep은 기대한 상태·시작 시각(없으면 is null)일 때만 바꾸고, 바뀐 줄이 없으면 false", async () => {
    result = { data: [], error: null };
    const changed = await store.updateStep(
      "a1",
      2,
      { status: "running", startedAt: "2026-09-30T00:00:00Z" },
      { status: "pending", startedAt: null },
    );
    expect(changed).toBe(false);
    expect(ops()).toEqual(
      expect.arrayContaining([
        ["eq", "analysis_id", "a1"],
        ["eq", "seq", 2],
        ["eq", "status", "pending"],
        ["is", "started_at", null],
        ["select", "seq"],
      ]),
    );
    const update = calls.find((c) => c.op === "update")!;
    expect(update.args[0]).toEqual({ status: "running", started_at: "2026-09-30T00:00:00Z" });
  });

  it("updateStep은 한 줄이 바뀌면 true, 시작 시각을 기대하면 eq started_at", async () => {
    result = { data: [{ seq: 1 }], error: null };
    const changed = await store.updateStep(
      "a1",
      1,
      { retries: 1 },
      { status: "running", startedAt: "2026-09-30T00:00:00Z" },
    );
    expect(changed).toBe(true);
    expect(ops()).toContainEqual(["eq", "started_at", "2026-09-30T00:00:00Z"]);
  });

  it("insertStep은 같은 (analysis_id, seq)가 있으면(23505) false, 다른 오류는 던진다", async () => {
    const row = {
      seq: 1,
      tool: "get_financials" as const,
      status: "running" as const,
      retries: 0,
      inputSummary: "x",
      outputSummary: null,
      output: null,
      durationMs: null,
      errorReason: null,
      externalCalls: 0,
      llmCostUsd: 0,
      startedAt: null,
    };
    result = { data: null, error: { code: "23505", message: "duplicate" } };
    expect(await store.insertStep("a1", "u1", row)).toBe(false);
    result = { data: null, error: { code: "42P01", message: "no table" } };
    await expect(store.insertStep("a1", "u1", row)).rejects.toMatchObject({ code: "42P01" });
    result = { data: null, error: null };
    expect(await store.insertStep("a1", "u1", row)).toBe(true);
    expect(calls.find((c) => c.op === "insert")!.args[0]).toMatchObject({
      analysis_id: "a1",
      owner_id: "u1",
      seq: 1,
      input_summary: "x",
    });
  });

  it("updateAnalysis는 onlyIf 상태일 때만 (in status), 바뀐 줄 수로 결과", async () => {
    result = { data: [{ id: "a1" }], error: null };
    expect(await store.updateAnalysis("a1", { status: "running" }, ["queued"])).toBe(true);
    expect(ops()).toContainEqual(["in", "status", ["queued"]]);
    result = { data: [], error: null };
    expect(await store.updateAnalysis("a1", { status: "running" }, ["queued"])).toBe(false);
  });

  it("상한은 quota_config에서, 없거나 숫자가 아니면 기본값", async () => {
    result = {
      data: [
        { key: "max_steps_per_question", value: "6" },
        { key: "max_seconds_per_question", value: "abc" },
      ],
      error: null,
    };
    expect(await store.loadLimits()).toEqual({
      maxSteps: 6,
      maxRetries: 2,
      maxSeconds: 90,
      maxLlmCostUsd: 0.1,
    });
  });
});

const versions = vi.hoisted(() => ({ version: null as unknown, newer: false }));
vi.mock("@/lib/versions/store", () => ({
  saveDataVersion: async () => undefined,
  findReusableExplanation: async () => null,
  loadDataVersion: async () => versions.version,
  isNewerDataAvailable: async () => versions.newer,
}));

describe("hasReusableCandidate (뉴스 건너뛰기 판단)", () => {
  const params = { ownerId: "u1", requestHash: "h", excludeAnalysisId: "a-now" };

  beforeEach(() => {
    versions.version = { sources: [{ corpCode: "1" }] };
    versions.newer = false;
  });

  it("같은 요청으로 끝난 분석(분석 글 ready)이 있고 그 뒤 새 공시가 없으면 true", async () => {
    result = {
      data: [{ id: "a-old", dataset_version_id: "v1", explanation: { status: "ready" } }],
      error: null,
    };
    expect(await store.hasReusableCandidate(params)).toBe(true);
    expect(ops()).toEqual(
      expect.arrayContaining([
        ["eq", "owner_id", "u1"],
        ["eq", "request_hash", "h"],
        ["eq", "status", "succeeded"],
        ["not", "dataset_version_id", "is", null],
      ]),
    );
  });

  it("새 공시가 있거나, 분석 글이 실패였거나, 지금 분석뿐이면 false", async () => {
    result = {
      data: [{ id: "a-old", dataset_version_id: "v1", explanation: { status: "ready" } }],
      error: null,
    };
    versions.newer = true;
    expect(await store.hasReusableCandidate(params)).toBe(false);
    versions.newer = false;
    result = {
      data: [{ id: "a-old", dataset_version_id: "v1", explanation: { status: "failed" } }],
      error: null,
    };
    expect(await store.hasReusableCandidate(params)).toBe(false);
    result = {
      data: [{ id: "a-now", dataset_version_id: "v1", explanation: { status: "ready" } }],
      error: null,
    };
    expect(await store.hasReusableCandidate(params)).toBe(false);
  });
});
