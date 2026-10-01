// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { AnalysisRequestView, CompanyRef } from "@/contracts";
import { applyBoardFilters, parseBoardFilters } from "@/lib/boards/filters";

// WU-401 보드 필터: 본문 검사(400·422)와 "원래 분석 요청에 필터만 덮어쓰기" + 섹터 합계 DB 함수 부르기(WU-403)

const company = (stockCode: string): CompanyRef => ({
  corpCode: `00${stockCode}`,
  stockCode,
  name: stockCode,
  market: "KOSPI",
  sector: { name: "반도체", source: "manual", isFinancial: false },
  fiscalMonth: 12,
});
const TARGET = company("000660");
const PEER = company("005930");

const request: AnalysisRequestView = {
  intent: "compare",
  target: TARGET,
  peers: [PEER],
  metrics: ["revenue"],
  period: { from: "2025Q3", to: "2026Q2", specified: false, reason: "기본", clipped: false },
  groupBy: "year",
  needsNews: true,
  aggregate: "sum",
};

describe("parseBoardFilters", () => {
  it("빈 필터·기간·비교 기업을 받는다 (대상·중복은 뺌)", () => {
    expect(parseBoardFilters({ filters: {} }, TARGET.stockCode, "2026Q2")).toEqual({});
    expect(
      parseBoardFilters(
        {
          filters: {
            period: { from: "2016Q1", to: "2026Q2" },
            peers: ["005930", "000660", "005930"],
          },
        },
        TARGET.stockCode,
        "2026Q2",
      ),
    ).toEqual({ period: { from: "2016Q1", to: "2026Q2" }, peers: ["005930"] });
  });

  it.each([
    [null, "VALIDATION_ERROR"],
    [{}, "VALIDATION_ERROR"],
    [{ filters: { peers: "005930" } }, "VALIDATION_ERROR"],
    [{ filters: { period: { from: "2026Q1" } } }, "VALIDATION_ERROR"],
    [{ filters: { period: { from: "2026Q1", to: "2025Q1" } } }, "VALIDATION_ERROR"],
    [{ filters: { period: { from: "2015Q4", to: "2025Q1" } } }, "OUT_OF_RANGE"],
    [{ filters: { period: { from: "2026Q1", to: "2026Q3" } } }, "OUT_OF_RANGE"],
  ])("%j → %s", (body, code) => {
    expect(() => parseBoardFilters(body, TARGET.stockCode, "2026Q2")).toThrow(
      expect.objectContaining({ code }),
    );
  });

  it("범위 밖 422 문구는 조회 시작 분기(2016년 1분기)와 최신 분기를 알려 준다", () => {
    expect(() =>
      parseBoardFilters(
        { filters: { period: { from: "2015Q1", to: "2025Q1" } } },
        TARGET.stockCode,
        "2026Q2",
      ),
    ).toThrow(
      expect.objectContaining({
        code: "OUT_OF_RANGE",
        message: "조회할 수 있는 기간은 2016년 1분기부터 최신 보고서(2026Q2)까지입니다.",
      }),
    );
  });
});

describe("applyBoardFilters", () => {
  it("기간·비교 기업만 바꾸고 의도·지표·묶음 단위·뉴스 여부는 그대로", () => {
    const next = applyBoardFilters(
      request,
      { period: { from: "2021Q1", to: "2025Q4" }, peers: ["005380"] },
      [company("005380")],
    );
    expect(next).toEqual({
      ...request,
      peers: [company("005380")],
      period: {
        from: "2021Q1",
        to: "2025Q4",
        specified: true,
        reason: "보드 필터: 2021Q1~2025Q4",
        clipped: false,
      },
    });
  });

  it("필터에 없는 항목은 원래 값", () => {
    expect(applyBoardFilters(request, {}, [])).toEqual(request);
  });

  it("합계에서 비교 기업을 모두 빼면 합계를 풀고 대상 기업 추이로 (연도별은 연도별 그대로)", () => {
    const next = applyBoardFilters(request, { peers: [] }, []);
    expect(next.aggregate).toBeUndefined();
    expect(next.groupBy).toBe("year");
    expect(applyBoardFilters({ ...request, groupBy: "sector" }, { peers: [] }, []).groupBy).toBe(
      "quarter",
    );
  });
});

vi.mock("server-only", () => ({}));

describe("aggregateSectorMetrics (DB 함수 부르기)", () => {
  function fakeAdmin(
    companyCount: number,
    rows: unknown[],
    rpcResult?: { data: unknown; error: { code?: string; message: string } | null },
  ) {
    const calls: { fn: string; args: unknown }[] = [];
    const signals: AbortSignal[] = [];
    return {
      calls,
      signals,
      client: {
        from: () => ({
          select: async () => ({ count: companyCount, error: null }),
        }),
        rpc: (fn: string, args: unknown) => {
          calls.push({ fn, args });
          return {
            abortSignal: async (signal: AbortSignal) => {
              signals.push(signal);
              return rpcResult ?? { data: rows, error: null };
            },
          };
        },
      },
    };
  }

  it("한도 안이면 DB 함수 결과 행만 받아 원 단위 bigint로 바꾼다", async () => {
    const { aggregateSectorMetrics } = await import("@/lib/boards/sector-aggregate");
    const admin = fakeAdmin(2700, [
      {
        sector_name: "반도체",
        is_financial: false,
        period: "2025",
        metric: "revenue",
        total: "9007199254740993",
        company_count: 12,
      },
    ]);
    const rows = await aggregateSectorMetrics(admin.client as never, {
      from: "2015Q1",
      to: "2025Q4",
      metrics: ["revenue"],
      byYear: true,
    });
    expect(rows).toEqual([
      {
        sectorName: "반도체",
        isFinancial: false,
        period: "2025",
        metric: "revenue",
        total: BigInt("9007199254740993"),
        companyCount: 12,
      },
    ]);
    expect(admin.calls).toEqual([
      {
        fn: "aggregate_sector_metrics",
        args: {
          p_from: "2015Q1",
          p_to: "2025Q4",
          p_metrics: ["revenue"],
          p_by_year: true,
          p_calc_version: "v3",
        },
      },
    ]);
  });

  it("기업 × 분기가 한도를 넘으면 DB 함수를 부르기 전에 413", async () => {
    const { aggregateSectorMetrics } = await import("@/lib/boards/sector-aggregate");
    const admin = fakeAdmin(4000, []);
    await expect(
      aggregateSectorMetrics(admin.client as never, {
        from: "2015Q1",
        to: "2025Q4",
        metrics: ["revenue"],
      }),
    ).rejects.toMatchObject({ code: "TOO_LARGE", message: expect.stringContaining("줄여") });
    expect(admin.calls).toEqual([]);
  });

  it("DB 함수 호출에 30초 시간 제한을 건다", async () => {
    const { aggregateSectorMetrics, AGGREGATE_TIMEOUT_MS } =
      await import("@/lib/boards/sector-aggregate");
    const admin = fakeAdmin(10, []);
    await aggregateSectorMetrics(admin.client as never, {
      from: "2025Q1",
      to: "2025Q4",
      metrics: ["revenue"],
    });
    expect(AGGREGATE_TIMEOUT_MS).toBe(30_000);
    expect(admin.signals).toHaveLength(1);
    expect(admin.signals[0]).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["서버가 30초에서 끊음", { code: "", message: "TimeoutError: signal timed out" }],
    [
      "DB statement_timeout",
      { code: "57014", message: "canceling statement due to statement timeout" },
    ],
  ])("시간 상한에 걸리면(%s) 413 TOO_LARGE + 줄이라는 안내", async (_name, error) => {
    const { aggregateSectorMetrics } = await import("@/lib/boards/sector-aggregate");
    const admin = fakeAdmin(10, [], { data: null, error });
    await expect(
      aggregateSectorMetrics(admin.client as never, {
        from: "2025Q1",
        to: "2025Q4",
        metrics: ["revenue"],
      }),
    ).rejects.toMatchObject({ code: "TOO_LARGE", message: expect.stringContaining("줄여") });
  });

  it("그 밖의 DB 오류는 413이 아니라 그대로 실패", async () => {
    const { aggregateSectorMetrics } = await import("@/lib/boards/sector-aggregate");
    const admin = fakeAdmin(10, [], {
      data: null,
      error: { code: "22023", message: "더할 수 없는 지표" },
    });
    await expect(
      aggregateSectorMetrics(admin.client as never, {
        from: "2025Q1",
        to: "2025Q4",
        metrics: ["revenue"],
      }),
    ).rejects.toThrow(/섹터 합계 계산 실패/);
  });
});
