// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

// Phase 2 도구 계약(src/lib/runner/tools) — 목록이 빠짐없고, 도구가 던지지 않고 실패를 돌려주는지
vi.mock("@/lib/explain/generate", () => ({
  generateExplanation: async () => ({ status: "ready", label: "AI 작성", conclusion: ["글"] }),
  generateExplanationWithUsage: async () => ({
    explanation: { status: "ready", label: "AI 작성", conclusion: ["글"] },
    llmCostUsd: 0.0004,
  }),
}));

const { TOOLS } = await import("@/lib/runner/tools/registry");
const { outputsOf } = await import("@/lib/runner/tools/types");

const ctx = {
  request: { peers: [] },
  question: "질문",
  mixedScope: false,
  analysisId: "a1",
  userId: "u1",
  client: {},
  decisions: null,
  previous: [],
} as never;

describe("Phase 2 도구 목록", () => {
  it("TECH §4.4에서 한 단계로 실행하는 도구 6개가 모두 있다", () => {
    expect(Object.keys(TOOLS).sort()).toEqual(
      [
        "build_result",
        "get_disclosures",
        "get_financials",
        "get_peers",
        "search_news",
        "write_explanation",
      ].sort(),
    );
  });

  it("준비 중인 도구·잘못된 입력은 던지지 않고 재시도 없는 실패를 돌려준다", async () => {
    await expect(TOOLS.get_peers({ target: {} as never, count: 3 }, ctx)).resolves.toMatchObject({
      status: "failed",
      retryable: false,
    });
    await expect(
      TOOLS.search_news({ company: {} as never, period: {} as never, keywords: [] }, ctx),
    ).resolves.toMatchObject({ status: "failed", retryable: false });
  });

  it("write_explanation은 앞 단계 결과가 없으면 실패, 있으면 뉴스 단서와 함께 설명을 만든다", async () => {
    await expect(TOOLS.write_explanation({}, ctx)).resolves.toMatchObject({ status: "failed" });
    const previous = [
      { seq: 1, tool: "build_result", output: { result: { figures: {} } } },
      { seq: 2, tool: "search_news", output: { clues: [{ newsId: "n1" }], notes: [] } },
    ];
    const outcome = await TOOLS.write_explanation({}, { ...(ctx as object), previous } as never);
    expect(outcome).toMatchObject({
      status: "succeeded",
      inputSummary: expect.stringContaining("숫자 0개, 뉴스 1건"),
    });
    expect(outputsOf(previous as never, "search_news")).toHaveLength(1);
  });
});
