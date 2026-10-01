// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_MAP_SEED_ROWS } from "../fixtures/mock/account-map";
import { createFakeFinancialsDb } from "./helpers/fake-financials-db";

// 투자 리포트(Phase 5 후속)의 부품: 1년 시세 통계·사업보고서 계정 뽑기·최대주주/배당 읽기.
// 외부 API는 가짜 — 원문 모양은 2026-10-01 SK하이닉스 실제 응답에서 옮겼다
const { priceFetchMock, dartFetchMock } = vi.hoisted(() => ({
  priceFetchMock: vi.fn(),
  dartFetchMock: vi.fn(),
}));
vi.mock("@/lib/price/client", () => ({ priceFetch: priceFetchMock }));
vi.mock("@/lib/dart/client", () => ({ dartFetch: dartFetchMock }));

const { loadPriceHistory, priceStats, weeklyCloses } = await import("@/lib/report/price-history");
const { extractValues, loadAnnualFinancials } = await import("@/lib/report/annual");
const { parseDividend, parseShareholders, loadShareholder } = await import("@/lib/report/facts");
const { carryReport, isReportFigureId } = await import("@/lib/report/carry");

type Day = Parameters<typeof priceStats>[0][number];

/** date부터 하루씩, close 배열대로 (주말도 거래일로 친다 — 통계만 본다) */
function days(start: string, closes: number[], volume = 100): Day[] {
  return closes.map((close, i) => {
    const d = new Date(`${start}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return {
      date: d.toISOString().slice(0, 10),
      open: close,
      high: close * 1.01,
      low: close * 0.99,
      close,
      changeRate: 0,
      volume: i >= closes.length - 20 ? volume * 2 : volume,
      tradeValue: close * volume,
      listedShares: 1000,
      marketCap: close * 1000,
    };
  });
}

describe("priceStats — 1년 시세 통계", () => {
  // 2025-09-30부터 366일: 100에서 하루 1씩 올라 마지막 날 465
  const series = days(
    "2025-09-30",
    Array.from({ length: 366 }, (_, i) => 100 + i),
  );
  const s = priceStats(series)!;

  it("현재가·52주 최고/최저(고가·저가 기준)와 범위 위치", () => {
    expect(s.last.date).toBe("2026-09-30");
    expect(s.last.close).toBe(465);
    expect(s.high52.price).toBeCloseTo(465 * 1.01, 6);
    expect(s.low52.date).toBe("2025-10-01"); // 365일 안 (하루 전 행은 뺀다)
    expect(s.rangePosition).toBeGreaterThan(95);
  });

  it("기간 수익률: 기준일 이전 마지막 거래일 종가 대비", () => {
    // 1개월 전 2026-08-30 종가 = 100 + 334
    expect(s.returns.m1).toBeCloseTo(((465 - 434) / 434) * 100, 2);
    // 연초 대비: 2025-12-31 종가 = 100 + 92
    expect(s.returns.ytd).toBeCloseTo(((465 - 192) / 192) * 100, 2);
    expect(s.returns.y1).toBeCloseTo(((465 - 100) / 100) * 100, 2);
  });

  it("최근 20일 거래량이 1년 평균의 몇 배인지", () => {
    expect(s.volumeRatio20).toBeGreaterThan(1.8);
    expect(s.avgVolume20).toBe(200);
  });

  it("그만큼 기록이 없으면 수익률은 null (최근 상장)", () => {
    const short = priceStats(days("2026-09-01", [10, 11, 12]))!;
    expect(short.returns.y1).toBeNull();
    expect(short.returns.m1).toBeNull();
    expect(short.volatility).toBeNull(); // 20일 미만
  });

  it("기록이 없으면 null", () => {
    expect(priceStats([])).toBeNull();
  });

  it("주간 종가: 주마다 마지막 거래일, 거래량은 그 주 합", () => {
    const weeks = weeklyCloses(days("2026-09-21", [1, 2, 3, 4, 5, 6, 7, 8])); // 9/21(월)~9/28(월)
    expect(weeks.map((w) => [w.week, w.day.close, w.volume])).toEqual([
      ["2026-09-21", 7, 1400],
      ["2026-09-28", 8, 200],
    ]);
  });
});

describe("loadPriceHistory — 종목당 하루 1회", () => {
  const item = (basDt: string, clpr: string, srtnCd = "000660") => ({
    basDt,
    srtnCd,
    clpr,
    fltRt: ".62",
    mkp: clpr,
    hipr: clpr,
    lopr: clpr,
    trqu: "3280459",
    trPrc: "5876732083000",
    lstgStCnt: "730492365",
    mrktTotAmt: "1297354440240000",
  });
  beforeEach(() => {
    priceFetchMock.mockReset();
    priceFetchMock.mockResolvedValue({
      response: {
        header: { resultCode: "00", resultMsg: "OK" },
        body: {
          items: {
            item: [
              item("20260930", "1776000"),
              item("20260929", "1765000"),
              item("20260930", "9", "0006605"),
            ],
          },
        },
      },
    });
  });

  it("처음 1회 받아 저장, 같은 날 다시 부르면 0회 (다른 종목 코드는 뺀다)", async () => {
    const db = createFakeFinancialsDb({ stock_price_history: [] });
    const now = () => new Date("2026-10-01T03:00:00Z");
    const first = await loadPriceHistory("000660", { client: db.client, now });
    expect(first.externalCalls).toBe(1);
    expect(first.days.map((d) => [d.date, d.close, d.changeRate])).toEqual([
      ["2026-09-29", 1765000, 0.62],
      ["2026-09-30", 1776000, 0.62],
    ]);
    expect(priceFetchMock.mock.calls[0][1]).toMatchObject({ likeSrtnCd: "000660", numOfRows: 400 });
    const again = await loadPriceHistory("000660", { client: db.client, now });
    expect(again).toMatchObject({ externalCalls: 0 });
    expect(again.days).toHaveLength(2);
    const nextDay = await loadPriceHistory("000660", {
      client: db.client,
      now: () => new Date("2026-10-02T03:00:00Z"),
    });
    expect(nextDay.externalCalls).toBe(1);
  });
});

describe("extractValues — 사업보고서 원문에서 리포트용 계정", () => {
  const row = (
    sj_div: string,
    account_id: string,
    account_nm: string,
    thstrm_amount: string,
    add?: string,
  ) => ({
    rcept_no: "20260310000001",
    reprt_code: "11011",
    bsns_year: "2025",
    corp_code: "00164779",
    sj_div,
    sj_nm: "",
    account_id,
    account_nm,
    account_detail: "-",
    thstrm_nm: "",
    thstrm_amount,
    ...(add ? { thstrm_add_amount: add } : {}),
    frmtrm_nm: "",
    frmtrm_amount: "",
    bfefrmtrm_nm: "",
    bfefrmtrm_amount: "",
    ord: "",
    currency: "KRW",
  });

  it("표준 계정 + 현금흐름·유동성·EPS (계정 ID, 없으면 이름)", () => {
    const values = extractValues(
      [
        row("CIS", "ifrs-full_Revenue", "매출액", "97146675000000"),
        row("BS", "ifrs-full_CurrentAssets", "유동자산", "69458073000000"),
        row("BS", "-표준계정코드 미사용-", "유동부채", "37378999000000"),
        row(
          "CF",
          "ifrs-full_CashFlowsFromUsedInOperatingActivities",
          "영업활동 현금흐름",
          "53373126000000",
        ),
        row("CF", "-표준계정코드 미사용-", "유형자산의 취득", "27518924000000"),
        row("CIS", "ifrs-full_BasicEarningsLossPerShare", "기본주당순이익(손실)", "62044"),
        row(
          "CF",
          "ifrs-full_DividendsPaidClassifiedAsFinancingActivities",
          "배당금의 지급",
          "1,681,166",
        ),
      ],
      ACCOUNT_MAP_SEED_ROWS,
    );
    expect(values).toMatchObject({
      revenue: "97146675000000",
      current_assets: "69458073000000",
      current_liabilities: "37378999000000",
      operating_cash_flow: "53373126000000",
      capex_tangible: "27518924000000",
      eps: "62044",
    });
    // 금액 모양이 아니면 그 계정만 없는 것으로
    expect(values.dividends_paid).toBeUndefined();
  });

  it("분기 보고서 손익은 누적(thstrm_add_amount)", () => {
    const values = extractValues(
      [row("CIS", "ifrs-full_BasicEarningsLossPerShare", "기본주당반기순이익", "132126", "189546")],
      ACCOUNT_MAP_SEED_ROWS,
    );
    expect(values.eps).toBe("189546");
  });
});

describe("loadAnnualFinancials — 최근 사업보고서 + 최근 정기보고서", () => {
  beforeEach(() => {
    dartFetchMock.mockReset();
  });

  it("제출된 해만 모으고(013 건너뜀) 두 번째는 캐시로 0회, '아직 없음'은 하루 뒤 다시", async () => {
    // 2021~2025 사업보고서와 2026 반기보고서만 있다
    dartFetchMock.mockImplementation(async (_path: string, p: Record<string, unknown>) => {
      const year = Number(p.bsns_year);
      const has =
        (p.reprt_code === "11011" && year >= 2021 && year <= 2025) ||
        (p.reprt_code === "11012" && year === 2026);
      if (!has || p.fs_div !== "CFS") return { status: "013", message: "없음" };
      return {
        status: "000",
        message: "정상",
        list: [
          {
            rcept_no: `${year}${p.reprt_code}`,
            sj_div: "CIS",
            account_id: "ifrs-full_Revenue",
            account_nm: "매출액",
            account_detail: "-",
            thstrm_amount: String(year * 1000),
          },
        ],
      };
    });
    const db = createFakeFinancialsDb({ account_map: ACCOUNT_MAP_SEED_ROWS, report_extras: [] });
    const now = () => new Date("2026-10-01T03:00:00Z");
    const first = await loadAnnualFinancials("00164779", 12, { client: db.client, now });
    expect(first.annual.map((r) => [r.fiscalYear, r.values.revenue])).toEqual([
      [2021, "2021000"],
      [2022, "2022000"],
      [2023, "2023000"],
      [2024, "2024000"],
      [2025, "2025000"],
    ]);
    expect(first.latest).toMatchObject({ bsnsYear: 2026, reprtCode: "11012" });
    expect(first.externalCalls).toBeGreaterThan(9);

    dartFetchMock.mockClear();
    const again = await loadAnnualFinancials("00164779", 12, { client: db.client, now });
    expect(again.externalCalls).toBe(0);
    expect(again.annual).toHaveLength(5);

    // 하루 뒤: 값을 찾은 보고서는 그대로, "아직 없음"(3분기·1분기·2020 등)만 다시 확인
    const tomorrow = await loadAnnualFinancials("00164779", 12, {
      client: db.client,
      now: () => new Date("2026-10-02T04:00:00Z"),
    });
    const asked = dartFetchMock.mock.calls.map((c) => `${c[1].bsns_year}|${c[1].reprt_code}`);
    expect(asked).not.toContain("2025|11011");
    expect(asked).toContain("2026|11014");
    expect(tomorrow.annual).toHaveLength(5);
  });
});

describe("최대주주·배당 읽기", () => {
  it("최대주주 + 특수관계인 (보통주, '계' 행이 있으면 그 합)", () => {
    expect(
      parseShareholders([
        {
          nm: "SK스퀘어(주)",
          relate: "최대주주",
          stock_knd: "보통주",
          trmend_posesn_stock_qota_rt: "20.50",
        },
        {
          nm: "곽노정",
          relate: "특수관계인",
          stock_knd: "보통주",
          trmend_posesn_stock_qota_rt: "0.00",
        },
        { nm: "계", relate: "-", stock_knd: "보통주", trmend_posesn_stock_qota_rt: "20.51" },
      ]),
    ).toEqual({ name: "SK스퀘어(주)", ratio: 20.5, totalWithRelated: 20.51, relatedCount: 1 });
    expect(parseShareholders([])).toBeNull();
  });

  it("실제 응답 모양: stock_knd '의결권 있는 주식', '기타' 행은 뺀다", () => {
    expect(
      parseShareholders([
        {
          nm: "SK스퀘어(주)",
          relate: "최대주주",
          stock_knd: "의결권 있는 주식",
          trmend_posesn_stock_qota_rt: "20.50",
        },
        {
          nm: "안현",
          relate: "특수관계인",
          stock_knd: "의결권 있는 주식",
          trmend_posesn_stock_qota_rt: "0.00",
        },
        {
          nm: "계",
          relate: "-",
          stock_knd: "의결권 있는 주식",
          trmend_posesn_stock_qota_rt: "20.50",
        },
        { nm: "계", relate: "-", stock_knd: "기타", trmend_posesn_stock_qota_rt: "-" },
      ]),
    ).toEqual({ name: "SK스퀘어(주)", ratio: 20.5, totalWithRelated: 20.5, relatedCount: 1 });
  });

  it("배당: 보통주 주당 현금배당금·배당수익률·연결 배당성향 ('-'·쉼표 처리)", () => {
    expect(
      parseDividend([
        { se: "(연결)현금배당성향(%)", stock_knd: "-", thstrm: "4.90" },
        { se: "현금배당수익률(%)", stock_knd: "보통주", thstrm: "0.40" },
        { se: "현금배당수익률(%)", stock_knd: "우선주", thstrm: "-" },
        { se: "주당 현금배당금(원)", stock_knd: "보통주", thstrm: "3,000" },
      ]),
    ).toEqual({ dps: 3000, yieldRate: 0.4, payoutRatio: 4.9 });
    expect(
      parseDividend([{ se: "주당 현금배당금(원)", stock_knd: "보통주", thstrm: "-" }]),
    ).toBeNull();
  });

  it("같은 보고서로 받은 최대주주는 다시 부르지 않는다", async () => {
    dartFetchMock.mockReset();
    dartFetchMock.mockResolvedValue({
      status: "000",
      message: "정상",
      list: [
        { nm: "A", relate: "최대주주", stock_knd: "보통주", trmend_posesn_stock_qota_rt: "30" },
      ],
    });
    const db = createFakeFinancialsDb({ company_facts: [] });
    const ref = { bsnsYear: 2026, reprtCode: "11012" as const };
    const first = await loadShareholder("00164779", ref, { client: db.client });
    const again = await loadShareholder("00164779", ref, { client: db.client });
    expect(first).toMatchObject({ externalCalls: 1, fact: { name: "A", ratio: 30 } });
    expect(again).toMatchObject({ externalCalls: 0, fact: { name: "A" } });
    const newer = await loadShareholder(
      "00164779",
      { bsnsYear: 2026, reprtCode: "11014" },
      { client: db.client },
    );
    expect(newer.externalCalls).toBe(1);
  });
});

describe("carryReport — 재실행·보드 다시 계산은 원래 리포트를 그대로", () => {
  it("리포트와 리포트 숫자(f100001~)만 옮긴다", () => {
    expect(isReportFigureId("f100001")).toBe(true);
    expect(isReportFigureId("f12")).toBe(false);
    const from = {
      report: { company: {}, sections: [] },
      figures: { f1: { id: "f1" }, f100001: { id: "f100001" } },
    } as never;
    const to = { figures: { f1: { id: "f1", new: true } } } as never;
    const out = carryReport(from, to) as unknown as {
      report: unknown;
      figures: Record<string, unknown>;
    };
    expect(out.report).toBe((from as { report: unknown }).report);
    expect(out.figures).toEqual({ f1: { id: "f1", new: true }, f100001: { id: "f100001" } });
    expect(carryReport(null, to)).toBe(to);
  });
});
