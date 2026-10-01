// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeFinancialsDb } from "./helpers/fake-financials-db";

// Phase 5 시연 데이터 미리 받기 (src/lib/runner/warm-demo.ts, scripts/warm-demo.mjs): 질문이 쓰는 캐시 우선 수집을
// 그대로 불러 시연 기업의 보고서·주가를 미리 받는다. AI는 부르지 않는다 — 여기서는 수집 함수들을 가짜로 바꿔
// 무엇을 어떤 범위로 부르는지, 두 번째 실행이 "이미 있음"인지, 경쟁사가 시연 목록과 다르면 알리는지 본다.
const { financialsMock, pricesMock, peersMock, profileMock } = vi.hoisted(() => ({
  financialsMock: vi.fn(),
  pricesMock: vi.fn(),
  peersMock: vi.fn(),
  profileMock: vi.fn(),
}));
vi.mock("@/lib/runner/company-financials", () => ({ ensureCompanyFinancials: financialsMock }));
vi.mock("@/lib/price/daily", () => ({ loadPrices: pricesMock }));
vi.mock("@/lib/sector/peers", () => ({ pickPeers: peersMock }));
vi.mock("@/lib/companies/profile", () => ({ ensureCompanyProfile: profileMock }));
// 투자 리포트 캐시 채우기 — 여기서는 부르는지만 본다 (조립은 report-build.test.ts)
const { reportMock } = vi.hoisted(() => ({ reportMock: vi.fn() }));
vi.mock("@/lib/report/build", () => ({ buildCompanyReport: reportMock }));
vi.mock("@/lib/llm/client", () => {
  throw new Error("warm-demo는 AI를 부르지 않는다");
});

const { DEMO_TARGETS, WARM_QUARTERS, warmDemoData } = await import("@/lib/runner/warm-demo");

/** 2026-10-01 KST 12시 — 최신 분기 2026Q2 (3분기보고서 기한 11/14 전) */
const NOW = () => new Date("2026-10-01T03:00:00Z");
const SEMI = { name: "반도체", is_financial: false };

function row(corp: string, stock: string, name: string, profiled = true) {
  return {
    corp_code: corp,
    stock_code: stock,
    corp_name: name,
    market: profiled ? "KOSPI" : null,
    acc_mt: profiled ? 12 : null,
    sector_source: profiled ? "manual" : null,
    sectors: profiled ? SEMI : null,
  };
}

function db(rows = DEMO_ROWS) {
  return createFakeFinancialsDb({ companies: rows.map((r) => ({ ...r })) });
}

const DEMO_ROWS = [
  row("00164779", "000660", "SK하이닉스"),
  row("00126380", "005930", "삼성전자"),
  row("00161383", "042700", "한미반도체"),
  row("00117212", "000990", "DB하이텍"),
];

function peer(stockCode: string, name: string) {
  return { stockCode, name };
}

beforeEach(() => {
  for (const m of [financialsMock, pricesMock, peersMock, profileMock, reportMock]) m.mockReset();
  reportMock.mockResolvedValue({ externalCalls: 0 });
  financialsMock.mockResolvedValue({ externalCalls: 14, quartersWithoutReport: new Set() });
  pricesMock.mockResolvedValue({
    baseDate: "2026-09-30",
    externalCalls: 4,
    rows: [
      { stockCode: "000660", baseDate: "2026-09-29", closePrice: BigInt(1700000) },
      { stockCode: "000660", baseDate: "2026-09-30", closePrice: BigInt(1776000) },
      { stockCode: "005930", baseDate: "2026-09-30", closePrice: BigInt(84000) },
    ],
  });
  peersMock.mockResolvedValue({
    peers: [peer("005930", "삼성전자"), peer("042700", "한미반도체"), peer("000990", "DB하이텍")],
    order: "시가총액 순 (2026-09-30 종가)",
    externalCalls: 2,
  });
});

describe("warmDemoData", () => {
  it("시연 기업마다 최신 분기부터 12분기 재무를 받고, 주가는 한 번에, 경쟁사 순서용 목록도 받는다", async () => {
    const { client } = db();
    const result = await warmDemoData(DEMO_TARGETS, { client, now: NOW });

    expect(WARM_QUARTERS).toBe(12);
    expect(result.period).toEqual({ from: "2023Q3", to: "2026Q2" });
    expect(financialsMock.mock.calls.map((c) => [c[0].name, c[1], c[2]])).toEqual([
      ["SK하이닉스", "2023Q3", "2026Q2"],
      ["삼성전자", "2023Q3", "2026Q2"],
      ["한미반도체", "2023Q3", "2026Q2"],
      ["DB하이텍", "2023Q3", "2026Q2"],
    ]);
    expect(pricesMock).toHaveBeenCalledTimes(1);
    expect(pricesMock.mock.calls[0][0]).toEqual(["000660", "005930", "042700", "000990"]);
    expect(pricesMock.mock.calls[0][1]).toEqual({ kind: "latest" });
    expect(peersMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "SK하이닉스" }),
      3,
      expect.objectContaining({ client }),
    );

    expect(result.companies.map((c) => [c.name, c.status, c.dartCalls])).toEqual([
      ["SK하이닉스", "받음", 14],
      ["삼성전자", "받음", 14],
      ["한미반도체", "받음", 14],
      ["DB하이텍", "받음", 14],
    ]);
    // 가장 늦은 거래일 종가, 가격이 없는 종목은 비운다
    expect(result.companies[0].price).toEqual({ baseDate: "2026-09-30", close: "1776000" });
    expect(result.companies[2].price).toBeUndefined();
    expect(result).toMatchObject({ priceDate: "2026-09-30", priceCalls: 6 });
    expect(result.peers).toMatchObject({ same: true, order: "시가총액 순 (2026-09-30 종가)" });
  });

  it("두 번째 실행은 캐시만 쓴다 — 외부 호출 0건이면 '이미 있음'", async () => {
    financialsMock.mockResolvedValue({ externalCalls: 0, quartersWithoutReport: new Set() });
    pricesMock.mockResolvedValue({ baseDate: "2026-09-30", externalCalls: 0, rows: [] });
    peersMock.mockResolvedValue({
      peers: [],
      order: "시가총액 순 (2026-09-30 종가)",
      externalCalls: 0,
    });
    const result = await warmDemoData(DEMO_TARGETS, { client: db().client, now: NOW });
    expect(result.companies.every((c) => c.status === "이미 있음" && c.dartCalls === 0)).toBe(true);
    expect(result.priceCalls).toBe(0);
  });

  it("11/15부터는 3분기보고서까지 — 최신 분기가 2026Q3로 넘어간다", async () => {
    const result = await warmDemoData([DEMO_TARGETS[0]], {
      client: db().client,
      now: () => new Date("2026-11-15T03:00:00Z"),
      quarters: 4,
    });
    expect(result.period).toEqual({ from: "2025Q4", to: "2026Q3" });
  });

  it("자동 선택 경쟁사가 시연 목록과 다르면 알린다", async () => {
    peersMock.mockResolvedValue({
      peers: [peer("005930", "삼성전자"), peer("058470", "리노공업"), peer("042700", "한미반도체")],
      order: "시가총액 순 (2026-09-30 종가)",
      externalCalls: 0,
    });
    const result = await warmDemoData(DEMO_TARGETS, { client: db().client, now: NOW });
    expect(result.peers).toMatchObject({
      same: false,
      picked: ["삼성전자(005930)", "리노공업(058470)", "한미반도체(042700)"],
      expected: ["005930", "042700", "000990"],
    });
  });

  it("기업개황이 아직 없는 기업은 먼저 채운다 (질문에서 처음 확정할 때와 같다)", async () => {
    const rows = [row("00117212", "000990", "DB하이텍", false)];
    const fake = db(rows);
    profileMock.mockImplementation(async () => {
      Object.assign(fake.tables.companies[0], row("00117212", "000990", "DB하이텍"));
      return { fromCache: false };
    });
    const result = await warmDemoData([{ stockCode: "000990", name: "000990" }], {
      client: fake.client,
      now: NOW,
    });
    expect(profileMock).toHaveBeenCalledWith("00117212", { client: fake.client });
    expect(result.companies[0]).toMatchObject({ name: "DB하이텍", status: "받음", dartCalls: 15 });
    expect(result.peers).toBeUndefined();
  });

  it("목록에 없는 종목·수집 실패는 그 기업만 '실패'로 두고 나머지는 계속한다", async () => {
    financialsMock.mockImplementation(async (company: { name: string }) => {
      if (company.name === "삼성전자") throw new Error("OpenDART 요청 실패(네트워크·시간 초과)");
      return { externalCalls: 0, quartersWithoutReport: new Set(["2023Q3"]) };
    });
    const result = await warmDemoData(
      [...DEMO_TARGETS.slice(0, 2), { stockCode: "999999", name: "없는종목" }],
      { client: db().client, now: NOW },
    );
    expect(result.companies.map((c) => [c.name, c.status])).toEqual([
      ["SK하이닉스", "이미 있음"],
      ["삼성전자", "실패"],
      ["없는종목", "실패"],
    ]);
    expect(result.companies[0].quartersWithoutReport).toEqual(["2023Q3"]);
    expect(result.companies[2].error).toContain("기업 목록에 없는 종목코드");
    // 주가는 찾은 기업만
    expect(pricesMock.mock.calls[0][0]).toEqual(["000660", "005930"]);
  });

  it("주가 API가 안 되면 재무는 그대로 두고 주가 실패를 적는다", async () => {
    pricesMock.mockRejectedValue(new Error("주가 API 오류 (30: SERVICE_KEY_IS_NOT_REGISTERED)"));
    const result = await warmDemoData([DEMO_TARGETS[1]], { client: db().client, now: NOW });
    expect(result.priceDate).toBeNull();
    expect(result.companies[0]).toMatchObject({ status: "받음" });
    expect(result.companies[0].error).toContain("주가를 받지 못함");
  });
});

describe("warmDemoData — 투자 리포트 캐시", () => {
  it("기업마다 리포트를 한 번 만들어 캐시를 채운다 (경쟁사 = 나머지 시연 기업, AI 0)", async () => {
    reportMock.mockResolvedValue({ externalCalls: 20 });
    financialsMock.mockResolvedValue({ externalCalls: 0, quartersWithoutReport: new Set() });
    const result = await warmDemoData(DEMO_TARGETS, { client: db().client, now: NOW });
    expect(reportMock).toHaveBeenCalledTimes(4);
    expect(reportMock.mock.calls[0][0]).toMatchObject({ name: "SK하이닉스" });
    expect(reportMock.mock.calls[0][1].peers.map((p: { name: string }) => p.name)).toEqual([
      "삼성전자",
      "한미반도체",
      "DB하이텍",
    ]);
    expect(result.companies[0]).toMatchObject({ status: "받음", reportCalls: 20 });
  });

  it("리포트가 실패해도 재무·주가 결과는 그대로, 사유만 적는다", async () => {
    reportMock.mockRejectedValue(new Error("주가 API 오류"));
    const result = await warmDemoData([DEMO_TARGETS[1]], { client: db().client, now: NOW });
    expect(result.companies[0]).toMatchObject({ status: "받음" });
    expect(result.companies[0].error).toContain("투자 리포트를 미리 만들지 못함");
  });
});
