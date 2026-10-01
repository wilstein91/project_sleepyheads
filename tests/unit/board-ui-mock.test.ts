import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Analysis } from "@/contracts";
import { addQuarters, EARLIEST_QUARTER, latestAvailableQuarter } from "@/lib/ask/quarter";
import { skhynixRecent } from "../fixtures/mock/skhynix-recent";

// WU-401 가짜 모드 보드(B1·B2)·설명 다시 쓰기(Q9) — 화면 개발용 흉내가 서버 계약(API_SPEC B1·B2·Q9)대로 답하는지.
// 브라우저 sessionStorage 대신 가짜 저장소를 쓰고, 응답 지연은 없앤다.

vi.mock("@/lib/api-client/mock-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-client/mock-store")>()),
  mockDelay: async () => {},
}));

const { mockGetBoard, mockRewriteExplanation, mockUpdateBoardFilters, MOCK_LLM_DOWN_KEY } =
  await import("@/lib/api-client/mock-boards");
const { readMockState, updateMockState } = await import("@/lib/api-client/mock-store");

const ID = "mock-board-analysis";

function storage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

beforeEach(() => {
  vi.stubGlobal("window", { sessionStorage: storage() });
  updateMockState((s) => {
    s.analyses[ID] = { ...structuredClone(skhynixRecent), id: ID } as Analysis;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (e) {
    return e as { code: string; httpStatus: number };
  }
  throw new Error("오류가 나야 한다");
}

describe("B1 mockGetBoard", () => {
  it("필터를 바꾼 적 없으면 빈 필터 + 원래 결과 + ready, 보드 ID = 분석 ID", async () => {
    const { data } = await mockGetBoard(ID);
    expect(data).toMatchObject({ id: ID, analysisId: ID, filters: {}, explanationStatus: "ready" });
    expect(data.result).toEqual(skhynixRecent.result);
  });

  it("없는 분석은 404", async () => {
    expect((await errorOf(mockGetBoard("nope"))).httpStatus).toBe(404);
  });
});

describe("B2 mockUpdateBoardFilters", () => {
  it("기간을 바꾸면 분기 차트 모두가 새 기간으로 바뀌고 stale, 질문 수는 그대로", async () => {
    const latest = latestAvailableQuarter();
    const from = addQuarters(latest, -7);
    const { data } = await mockUpdateBoardFilters(ID, { period: { from, to: latest } });

    expect(data.explanationStatus).toBe("stale");
    expect(data.result.basis.period).toMatchObject({ from, to: latest });
    const timeCharts = data.result.charts.filter((c) => c.type !== "card");
    expect(timeCharts.length).toBeGreaterThan(0);
    for (const chart of timeCharts) {
      expect(chart.title).toContain(`(${from}~${latest})`);
      for (const s of chart.series) {
        expect(s.points.map((p) => p.x)).toHaveLength(8);
        // 모든 점이 figures에 있어야 차트·표가 그려진다
        for (const p of s.points) expect(data.result.figures[p.figureId]).toBeDefined();
      }
    }
    expect(readMockState().questionsUsed).toBe(0);
  });

  it("같은 필터면 같은 숫자 (가짜라도 흔들리지 않는다)", async () => {
    const a = await mockUpdateBoardFilters(ID, { peers: ["005930"] });
    const b = await mockUpdateBoardFilters(ID, { peers: ["005930"] });
    expect(a.data.result).toEqual(b.data.result);
  });

  it("비교 기업을 넣으면 기업 비교 차트가 생기고, 빼면 사라진다", async () => {
    const added = await mockUpdateBoardFilters(ID, { peers: ["005930", "035420"] });
    const compare = added.data.result.charts.find((c) => c.id === "board-peers");
    expect(compare?.series[0].points.map((p) => p.x)).toEqual(["SK하이닉스", "삼성전자", "NAVER"]);

    const removed = await mockUpdateBoardFilters(ID, { peers: [] });
    expect(removed.data.result.charts.find((c) => c.id === "board-peers")).toBeUndefined();
  });

  it("다시 열면(B1) 마지막 필터와 결과가 유지된다", async () => {
    await mockUpdateBoardFilters(ID, { peers: ["005930"] });
    const { data } = await mockGetBoard(ID);
    expect(data.filters).toEqual({ peers: ["005930"] });
    expect(data.explanationStatus).toBe("stale");
  });

  it("비교 기업 6곳 이상은 400", async () => {
    const six = ["005930", "006400", "207940", "028260", "005380", "012330"];
    const e = await errorOf(mockUpdateBoardFilters(ID, { peers: six }));
    expect([e.code, e.httpStatus]).toEqual(["VALIDATION_ERROR", 400]);
  });

  it("시작 분기가 끝 분기보다 늦으면 400", async () => {
    const e = await errorOf(
      mockUpdateBoardFilters(ID, { period: { from: "2026Q1", to: "2025Q1" } }),
    );
    expect(e.httpStatus).toBe(400);
  });

  it.each([
    ["2015Q1 이전", { from: "2014Q4", to: "2016Q1" }],
    ["최신 분기 이후", { from: "2025Q1", to: addQuarters(latestAvailableQuarter(), 1) }],
  ] as const)("%s 기간은 422 OUT_OF_RANGE", async (_name, period) => {
    const e = await errorOf(mockUpdateBoardFilters(ID, { period }));
    expect([e.code, e.httpStatus]).toEqual(["OUT_OF_RANGE", 422]);
  });

  it("긴 기간 + 비교 기업 여러 곳이면 413 TOO_LARGE, 보드는 바뀌지 않는다", async () => {
    const e = await errorOf(
      mockUpdateBoardFilters(ID, {
        period: { from: EARLIEST_QUARTER, to: latestAvailableQuarter() },
        peers: ["005930", "035420"],
      }),
    );
    expect([e.code, e.httpStatus]).toEqual(["TOO_LARGE", 413]);
    expect((await mockGetBoard(ID)).data.filters).toEqual({});
  });
});

describe("Q9 mockRewriteExplanation", () => {
  it("질문 1회를 쓰고 새 설명을 돌려주며, 보드는 ready로 돌아온다", async () => {
    await mockUpdateBoardFilters(ID, { peers: ["005930"] });
    const { data } = await mockRewriteExplanation(ID);
    expect(data.explanation.status).toBe("ready");
    expect(data.explanation.conclusion[0]).toContain("비교 기업 1곳");
    expect(readMockState().questionsUsed).toBe(1);
    expect(readMockState().analyses[ID].explanation).toEqual(data.explanation);
    expect((await mockGetBoard(ID)).data.explanationStatus).toBe("ready");
  });

  it("AI 장애면 503 — 차감 없음, 기존 설명·stale 그대로", async () => {
    await mockUpdateBoardFilters(ID, { peers: ["005930"] });
    window.sessionStorage.setItem(MOCK_LLM_DOWN_KEY, "1");
    const e = await errorOf(mockRewriteExplanation(ID));
    expect([e.code, e.httpStatus]).toEqual(["LLM_UNAVAILABLE", 503]);
    expect(readMockState().questionsUsed).toBe(0);
    expect(readMockState().analyses[ID].explanation).toEqual(skhynixRecent.explanation);
    expect((await mockGetBoard(ID)).data.explanationStatus).toBe("stale");
  });
});
