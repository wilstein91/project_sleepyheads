// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Explanation } from "@/contracts";
import { findReusableExplanation } from "@/lib/versions/store";

// 분석 글 재사용 + 투자 리포트 (Phase 5 후속): 리포트가 붙은 결과면 같은 주가 기준일의 리포트로 쓴 글(관점 있음)만
// 재사용한다 — 리포트 전 글(질문 숫자만 해설)이나 다른 날 주가로 쓴 글을 다시 보여 주지 않게

function explanation(themed: boolean): Explanation {
  return {
    status: "ready",
    conclusion: ["결론"],
    insights: [
      {
        kind: "positive",
        text: "t",
        figureIds: ["f1"],
        newsIds: [],
        chartRef: null,
        inferred: false,
        ...(themed ? { theme: "growth" as const } : {}),
      },
    ],
    evidence: [],
    newsClues: [],
    // 공시 원문 근거 칸이 있는 글만 재사용한다 (versions-reuse.test.ts)
    filingClues: [],
    caveats: [],
    label: "AI 작성",
  };
}

/** select·eq·order·limit 다음 await → rows (조회 열 이름을 기록) */
function client(rows: Record<string, unknown>[]) {
  const seen: { select?: string } = {};
  const builder = {
    select: (cols: string) => ((seen.select = cols), builder),
    eq: () => builder,
    order: () => builder,
    limit: () => builder,
    then: (resolve: (v: unknown) => void) => resolve({ data: rows, error: null }),
  };
  return { c: { from: () => builder } as never, seen };
}

const params = { ownerId: "u", dataVersionId: "v", requestHash: "h", excludeAnalysisId: "now" };

describe("findReusableExplanation — 투자 리포트", () => {
  it("리포트가 없으면 예전처럼 같은 요청·같은 데이터 버전의 글을 재사용", async () => {
    const { c } = client([{ id: "a", explanation: explanation(false), report_price_date: null }]);
    expect(await findReusableExplanation(c, params)).not.toBeNull();
  });

  it("리포트가 있으면 같은 주가 기준일 + 관점이 붙은 글만", async () => {
    const { c, seen } = client([
      { id: "old", explanation: explanation(false), report_price_date: null }, // 리포트 전 글
      { id: "yesterday", explanation: explanation(true), report_price_date: "2026-09-29" },
      {
        id: "today",
        explanation: { ...explanation(true), conclusion: ["오늘"] },
        report_price_date: "2026-09-30",
      },
    ]);
    const found = await findReusableExplanation(c, { ...params, reportPriceDate: "2026-09-30" });
    expect(found?.conclusion).toEqual(["오늘"]);
    expect(seen.select).toContain("result->report->>priceDate");

    const { c: c2 } = client([
      { id: "old", explanation: explanation(false), report_price_date: null },
      { id: "yesterday", explanation: explanation(true), report_price_date: "2026-09-29" },
    ]);
    expect(
      await findReusableExplanation(c2, { ...params, reportPriceDate: "2026-09-30" }),
    ).toBeNull();
  });
});
