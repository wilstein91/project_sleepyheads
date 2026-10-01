// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanyRef, Figure } from "@/contracts";

// 투자 리포트 조립 (src/lib/report/build.ts): 수집 부품은 가짜로 바꾸고, 칸·숫자·계산·빠진 것 안내를 본다.
// 계산식은 TECH §6.4와 같다 — PER = 시가총액 ÷ TTM 지배주주 순이익, PBR = 시가총액 ÷ 지배주주지분.
const m = vi.hoisted(() => ({
  financials: vi.fn(),
  history: vi.fn(),
  annual: vi.fn(),
  disclosures: vi.fn(),
  shareholder: vi.fn(),
  dividend: vi.fn(),
  prices: vi.fn(),
  peers: vi.fn(),
}));
vi.mock("@/lib/runner/company-financials", () => ({ ensureCompanyFinancials: m.financials }));
vi.mock("@/lib/report/price-history", async (orig) => ({
  ...(await orig<typeof import("@/lib/report/price-history")>()),
  loadPriceHistory: m.history,
}));
vi.mock("@/lib/report/annual", () => ({ loadAnnualFinancials: m.annual }));
vi.mock("@/lib/report/facts", () => ({ loadShareholder: m.shareholder, loadDividend: m.dividend }));
vi.mock("@/lib/runner/disclosures-tool", () => ({ fetchEventDisclosures: m.disclosures }));
vi.mock("@/lib/price/daily", async (orig) => ({
  ...(await orig<typeof import("@/lib/price/daily")>()),
  loadPrices: m.prices,
}));
vi.mock("@/lib/sector/peers", () => ({ pickPeers: m.peers }));
vi.mock("@/lib/llm/client", () => {
  throw new Error("리포트는 AI를 부르지 않는다");
});

const { buildCompanyReport, fiscalYearEnd, koreanCount } = await import("@/lib/report/build");

const SK: CompanyRef = {
  corpCode: "00164779",
  stockCode: "000660",
  name: "SK하이닉스",
  market: "KOSPI",
  sector: { name: "반도체", source: "manual", isFinancial: false },
  fiscalMonth: 12,
};
const SS: CompanyRef = { ...SK, corpCode: "00126380", stockCode: "005930", name: "삼성전자" };
const JO = BigInt(1_000_000_000_000);
const NOW = () => new Date("2026-10-01T03:00:00Z");
const won = (n: number) => ({ value: BigInt(Math.round(n * 1e12)) });

/** 분기 지표 한 줄 (조 원) */
function quarter(rev: number, op: number, ni: number, ttm: number, eq: number) {
  return {
    revenue: won(rev),
    operating_income: won(op),
    net_income: won(ni),
    owners_net_income: won(ni),
    assets: won(eq * 2),
    liabilities: won(eq * 0.3),
    equity: won(eq),
    owners_equity: won(eq),
    operating_margin: { value: (op / rev) * 100 },
    net_margin: { value: (ni / rev) * 100 },
    equity_ratio: { value: 50 },
    debt_ratio: { value: 30 },
    ttm_owners_ni: won(ttm),
    roe: { value: 40 },
  };
}

function financialsFor(rows: Record<string, ReturnType<typeof quarter>>) {
  return {
    metricsByQuarter: new Map(
      Object.entries(rows).map(([q, metrics]) => [q, { fs_div: "CFS", metrics }]),
    ),
    fiscalRefByQuarter: new Map(),
    externalCalls: 2,
  };
}

const QUARTERS = {
  "2025Q2": quarter(22, 9, 7, 20, 100),
  "2025Q3": quarter(24, 11, 12, 25, 110),
  "2025Q4": quarter(30, 15, 13, 35, 130),
  "2026Q1": quarter(52, 37, 40, 70, 160),
  "2026Q2": quarter(79, 60, 94, 160, 260),
};

/** 2025-10-01부터 하루씩 종가 100 → 마지막 날 1,000 (상장주식수 1조 주 → 시가총액 = 종가 × 1조) */
function priceDays() {
  return Array.from({ length: 365 }, (_, i) => {
    const d = new Date(Date.UTC(2025, 9, 1 + i));
    const close = i === 364 ? 1000 : 100 + i;
    return {
      date: d.toISOString().slice(0, 10),
      open: close,
      high: close,
      low: close,
      close,
      changeRate: 1.5,
      volume: 10,
      tradeValue: close * 10,
      listedShares: 1e12,
      marketCap: close * 1e12,
    };
  });
}

function annualReport(fiscalYear: number, rev: number, ni: number, eq: number) {
  const s = (n: number) => String(BigInt(Math.round(n * 1e12)));
  return {
    fiscalYear,
    bsnsYear: fiscalYear,
    reprtCode: "11011",
    fsDiv: "CFS",
    rceptNo: `${fiscalYear}0310`,
    values: {
      revenue: s(rev),
      operating_income: s(rev * 0.4),
      net_income: s(ni),
      owners_net_income: s(ni),
      equity: s(eq),
      owners_equity: s(eq),
      assets: s(eq * 1.5),
      liabilities: s(eq * 0.5),
      current_assets: s(eq * 0.6),
      current_liabilities: s(eq * 0.3),
      operating_cash_flow: s(ni * 1.2),
      capex_tangible: s(ni * 0.5),
      capex_intangible: s(ni * 0.1),
      eps: "62044",
    },
  };
}

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  m.financials.mockImplementation(async (c: CompanyRef) =>
    financialsFor(
      c.corpCode === SK.corpCode ? QUARTERS : { "2026Q2": quarter(170, 90, 80, 240, 400) },
    ),
  );
  m.history.mockResolvedValue({ days: priceDays(), externalCalls: 1 });
  m.annual.mockResolvedValue({
    annual: [
      annualReport(2023, 33, -9, 50),
      annualReport(2024, 66, 20, 70),
      annualReport(2025, 97, 43, 100),
    ],
    latest: { ...annualReport(2026, 0, 0, 0), reprtCode: "11012" },
    externalCalls: 6,
  });
  m.disclosures.mockResolvedValue([
    {
      rceptNo: "1",
      title: "자기주식취득결정",
      date: "2026-08-01",
      tag: "자사주",
      importance: "high",
      isCorrection: false,
      url: "u",
    },
    {
      rceptNo: "2",
      title: "옛 공시",
      date: "2025-01-01",
      tag: "기타",
      importance: "mid",
      isCorrection: false,
      url: "u",
    },
  ]);
  m.shareholder.mockResolvedValue({
    fact: { name: "SK스퀘어(주)", ratio: 20.5, totalWithRelated: 20.51, relatedCount: 7 },
    externalCalls: 1,
  });
  m.dividend.mockResolvedValue({
    fact: { dps: 3000, yieldRate: 0.4, payoutRatio: 4.9 },
    externalCalls: 1,
  });
  // 사업연도 말 종가: 매년 500 (상장주식수 1조)
  m.prices.mockImplementation(async (codes: string[], window: { kind: string; date?: string }) => ({
    baseDate: window.date ?? "2026-09-30",
    rows: codes.map((code) => ({
      stockCode: code,
      baseDate: window.kind === "asOf" ? window.date! : "2026-09-30",
      closePrice: BigInt(code === SK.stockCode && window.kind === "latest" ? 1000 : 500),
      listedShares: BigInt(1e12),
    })),
    externalCalls: 1,
  }));
  m.peers.mockResolvedValue({
    peers: [SS],
    order: "시가총액 순",
    candidateCount: 3,
    externalCalls: 0,
  });
});

function byLabel(figures: Record<string, Figure>, label: string): Figure {
  const f = Object.values(figures).find((x) => x.label === label);
  if (!f) throw new Error(`없는 숫자: ${label}`);
  return f;
}

describe("buildCompanyReport", () => {
  it("다섯 칸(기본정보·주가·재무·밸류에이션·공시)과 핵심 지표, 숫자 ID는 f100001부터", async () => {
    const { report, figures, summary } = await buildCompanyReport(SK, {
      client: {} as never,
      now: NOW,
    });
    expect(report.sections.map((s) => s.id)).toEqual([
      "profile",
      "price",
      "financials",
      "valuation",
      "events",
    ]);
    expect(Object.keys(figures).every((id) => Number(id.slice(1)) > 100_000)).toBe(true);
    expect(report.highlights.map((h) => h.label)).toEqual([
      "현재가",
      "시가총액",
      "PER",
      "PBR",
      "ROE",
      "배당수익률",
      "1년 수익률",
      "52주 범위",
      "최대주주",
    ]);
    expect(report.priceDate).toBe("2026-09-30");
    // 차트 ID는 r1부터 (질문 차트 c1…과 겹치지 않는다)
    const chartIds = report.sections.flatMap((s) => s.charts.map((c) => c.id));
    expect(chartIds[0]).toBe("r1");
    expect(new Set(chartIds).size).toBe(chartIds.length);
    // 1년 넘은 공시는 빼고 최근 것부터
    expect(report.disclosures.map((d) => d.rceptNo)).toEqual(["1"]);
    expect(summary).toContain("경쟁사 2곳");
    expect(report.notes).toEqual([]);
  });

  it("PER·PBR·PSR = 시가총액(1,000조) ÷ TTM 순이익·지분·TTM 매출, 과거 평균(사업연도 말)과 비교", async () => {
    const { figures } = await buildCompanyReport(SK, { client: {} as never, now: NOW });
    expect(byLabel(figures, "SK하이닉스 PER").value).toBeCloseTo(1000 / 160, 6);
    expect(byLabel(figures, "SK하이닉스 PBR").value).toBeCloseTo(1000 / 260, 6);
    expect(byLabel(figures, "SK하이닉스 PSR").value).toBeCloseTo(1000 / (24 + 30 + 52 + 79), 6);
    // 2023은 적자라 PER 평균에서 빠진다: (500/20 + 500/43) / 2
    const avgPer = (500 / 20 + 500 / 43) / 2;
    expect(byLabel(figures, "SK하이닉스 과거 평균 PER (2개 사업연도 말)").value).toBeCloseTo(
      avgPer,
      6,
    );
    expect(byLabel(figures, "SK하이닉스 현재 PER의 과거 평균 대비 차이").value).toBeCloseTo(
      ((1000 / 160 - avgPer) / avgPer) * 100,
      6,
    );
    // 배당수익률 = 주당 배당금 ÷ 현재가 (원 단위 종가 1,000원)
    expect(byLabel(figures, "SK하이닉스 배당수익률 (현재가 기준)").value).toBeCloseTo(300, 6);
    // 경쟁사 비교 표 + 중앙값
    const peerPer = byLabel(figures, "경쟁사 1곳 PER 중앙값");
    expect(peerPer.value).toBeCloseTo(500 / 240, 6);
  });

  it("주가는 원 단위 그대로 (만 원 아래를 버리지 않는다), 주식 수는 '억·만 주'", async () => {
    m.history.mockResolvedValue({
      days: priceDays().map((d, i, all) =>
        i === all.length - 1 ? { ...d, close: 1776000, listedShares: 730492365 } : d,
      ),
      externalCalls: 1,
    });
    const { figures } = await buildCompanyReport(SK, { client: {} as never, now: NOW });
    expect(byLabel(figures, "SK하이닉스 현재가").display).toBe("1,776,000원");
    expect(byLabel(figures, "SK하이닉스 상장주식수").display).toBe("7억 3,049만 주");
    expect(koreanCount(3280459)).toBe("328만 ");
  });

  it("영업이익 YoY 부호 전환은 '흑자전환' 글자로", async () => {
    m.financials.mockImplementation(async () =>
      financialsFor({
        ...QUARTERS,
        "2025Q2": { ...QUARTERS["2025Q2"], operating_income: { value: -JO } },
      }),
    );
    const { figures } = await buildCompanyReport(SK, { client: {} as never, now: NOW });
    expect(byLabel(figures, "SK하이닉스 영업이익 YoY 2026Q2").display).toBe("흑자전환");
  });

  it("부품이 실패해도 나머지는 만들고 무엇이 빠졌는지 적는다", async () => {
    m.history.mockRejectedValue(new Error("주가 API 오류"));
    m.annual.mockRejectedValue(new Error("OpenDART 오류"));
    m.peers.mockRejectedValue(new Error("섹터 없음"));
    const { report, figures } = await buildCompanyReport(SK, { client: {} as never, now: NOW });
    expect(report.notes).toEqual(
      expect.arrayContaining([
        "주가를 받지 못해 주가·밸류에이션 일부를 계산하지 못했습니다",
        "사업보고서 재무를 받지 못했습니다",
        expect.stringContaining("경쟁사를 고르지 못해"),
      ]),
    );
    // 분기 재무는 있으니 재무 칸은 남는다, PER은 주가가 없어 계산 불가
    expect(report.sections.find((s) => s.id === "financials")!.facts.length).toBeGreaterThan(5);
    expect(byLabel(figures, "SK하이닉스 PER").reason).toBe("NO_PRICE");
    expect(report.priceDate).toBeNull();
  });

  it("경쟁사 비교가 오래 걸리면 빼고 끝낸다 (25초)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    m.peers.mockImplementation(() => new Promise(() => {})); // 끝나지 않는다
    const pending = buildCompanyReport(SK, { client: {} as never, now: NOW });
    await vi.advanceTimersByTimeAsync(25_001);
    const { report } = await pending;
    vi.useRealTimers();
    expect(report.notes).toContain(
      "경쟁사 비교는 시간이 오래 걸려 이번에는 빼었습니다 (다음 조회 때 나옵니다)",
    );
  });

  it("질문에 비교 기업이 있으면 그 기업들과 비교한다 (경쟁사를 새로 고르지 않음)", async () => {
    await buildCompanyReport(SK, { client: {} as never, now: NOW, peers: [SS] });
    expect(m.peers).not.toHaveBeenCalled();
  });

  it("결산일: 12월은 그해 12/31, 3월 결산은 다음 해 3/31", () => {
    expect(fiscalYearEnd(2025, 12)).toBe("2025-12-31");
    expect(fiscalYearEnd(2025, 3)).toBe("2026-03-31");
  });
});
