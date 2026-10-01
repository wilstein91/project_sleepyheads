// @vitest-environment node
import { describe, expect, it } from "vitest";
import { findReusableExplanation } from "@/lib/versions/store";

// 같은 요청·같은 데이터 버전의 분석 글 재사용 — 공시 원문 근거(filingClues)가 생기기 전의 글은 쓰지 않는다 (2026-10-01)

function fakeClient(rows: unknown[]) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: async () => ({ data: rows, error: null }),
  };
  return { from: () => chain } as never;
}

const params = { ownerId: "u1", dataVersionId: "v1", requestHash: "h1", excludeAnalysisId: "now" };

describe("findReusableExplanation", () => {
  it("공시 원문 칸이 없는 옛 분석 글은 건너뛰고, 있는 글(빈 배열 포함)만 쓴다", async () => {
    const old = { status: "ready", conclusion: ["옛 글"] };
    const fresh = { status: "ready", conclusion: ["새 글"], filingClues: [] };
    await expect(
      findReusableExplanation(
        fakeClient([
          { id: "a2", explanation: old },
          { id: "a1", explanation: fresh },
        ]),
        params,
      ),
    ).resolves.toEqual(fresh);
    await expect(
      findReusableExplanation(fakeClient([{ id: "a2", explanation: old }]), params),
    ).resolves.toBeNull();
  });

  it("지금 분석 자신·실패한 글은 쓰지 않는다", async () => {
    await expect(
      findReusableExplanation(
        fakeClient([
          { id: "now", explanation: { status: "ready", filingClues: [] } },
          { id: "a1", explanation: { status: "failed", filingClues: [] } },
        ]),
        params,
      ),
    ).resolves.toBeNull();
  });
});
