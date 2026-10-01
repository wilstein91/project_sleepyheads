// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalysisRequestView, CompanyRef } from "@/contracts";
import type { ToolContext } from "@/lib/runner/tools/types";
import { ACCOUNT_MAP_SEED_ROWS } from "../fixtures/mock/account-map";
import { createFakeFinancialsDb } from "./helpers/fake-financials-db";

// WU-502 주가 지표가 실행기를 끝까지 지나는 모양: "SK하이닉스 PER 알려줘" → 카드(시가총액·PER·PBR) + 기준일,
// 결합 중단 경고, 실행 기록의 결합 전후 행 수, 데이터 버전의 주가 기준일, 재실행은 그날 가격으로.
const { dartFetchMock, priceFetchMock } = vi.hoisted(() => ({
  dartFetchMock: vi.fn(),
  priceFetchMock: vi.fn(),
}));
vi.mock("@/lib/dart/client", () => ({ dartFetch: dartFetchMock }));
vi.mock("@/lib/price/client", () => ({ priceFetch: priceFetchMock }));
// Phase 5: 분석 글(현준 explain/**)이 PER·PBR 숫자를 자리표시자로 쓰는지 — 가짜 AI로만 확인한다
const { llmCallMock } = vi.hoisted(() => ({ llmCallMock: vi.fn() }));
vi.mock("@/lib/llm/client", () => ({ llmCall: llmCallMock }));
vi.mock("@/lib/explain/model", () => ({ chooseExplainModel: async () => ({ model: "fake" }) }));

const { runAnalysis } = await import("@/lib/runner/execute");
const { generateExplanationWithUsage } = await import("@/lib/explain/generate");
const { buildResult } = await import("@/lib/runner/tools/data-tools");

const JO = 1_000_000_000_000;

const SK: CompanyRef = {
  corpCode: "00164779",
  stockCode: "000660",
  name: "SK하이닉스",
  market: "KOSPI",
  sector: { name: "반도체", source: "manual", isFinancial: false },
  fiscalMonth: 12,
};
const LOSS: CompanyRef = {
  corpCode: "10000009",
  stockCode: "900090",
  name: "가상적자",
  market: "KOSDAQ",
  sector: { name: "반도체", source: "manual", isFinancial: false },
  fiscalMonth: 12,
};

/** 2024년 분기별 지배주주 순이익(3개월, 조 원)과 분기말 지배주주지분 */
const NI: Record<string, number[]> = { "00164779": [1, 2, 3, 4], "10000009": [-1, -1, 0.5, 0.2] };
const EQUITY: Record<string, number> = { "00164779": 50, "10000009": -2 };
const REPRT_ORDER = ["11013", "11012", "11014", "11011"];

function mockDart() {
  dartFetchMock.mockImplementation(async (path: string, params: Record<string, unknown>) => {
    const corp = String(params.corp_code);
    const idx = REPRT_ORDER.indexOf(String(params.reprt_code));
    if (path !== "fnlttSinglAcntAll.json" || params.bsns_year !== 2024 || idx < 0) {
      return { status: "013", message: "없음" };
    }
    if (params.fs_div !== "CFS" || !NI[corp]) return { status: "013", message: "없음" };
    const quarters = NI[corp];
    const cumulative = quarters.slice(0, idx + 1).reduce((a, b) => a + b, 0);
    // 사업보고서는 연간 값, 그 밖은 3개월(thstrm_amount)·누적(thstrm_add_amount)
    const thstrm = idx === 3 ? cumulative : quarters[idx];
    const row = (sj: string, id: string, nm: string, amount: number, add?: number) => ({
      rcept_no: `2024${params.reprt_code}${corp.slice(-2)}`,
      reprt_code: String(params.reprt_code),
      bsns_year: "2024",
      corp_code: corp,
      sj_div: sj,
      sj_nm: "",
      account_id: id,
      account_nm: nm,
      account_detail: "-",
      thstrm_nm: "",
      thstrm_amount: String(Math.round(amount * JO)),
      thstrm_add_amount: add === undefined ? "" : String(Math.round(add * JO)),
      frmtrm_nm: "",
      frmtrm_amount: "",
      bfefrmtrm_nm: "",
      bfefrmtrm_amount: "",
      ord: "",
      currency: "KRW",
    });
    return {
      status: "000",
      message: "정상",
      list: [
        row(
          "CIS",
          "ifrs-full_ProfitLossAttributableToOwnersOfParent",
          "지배기업의 소유주에게 귀속되는 당기순이익",
          thstrm,
          idx === 3 ? undefined : cumulative,
        ),
        row(
          "BS",
          "ifrs-full_EquityAttributableToOwnersOfParent",
          "지배기업의 소유주에게 귀속되는 자본",
          EQUITY[corp],
        ),
      ],
    };
  });
}

function priceItem(srtnCd: string, basDt: string, clpr: number, shares: number, itmsNm = "") {
  return { basDt, srtnCd, itmsNm, clpr: String(clpr), lstgStCnt: String(shares) };
}

function mockPrices(items: ReturnType<typeof priceItem>[]) {
  priceFetchMock.mockImplementation(async (_path: string, params: Record<string, unknown>) => ({
    response: {
      header: { resultCode: "00", resultMsg: "OK" },
      body: { items: { item: items.filter((i) => i.srtnCd.includes(String(params.likeSrtnCd))) } },
    },
  }));
}

function db(extraCompanies: Record<string, unknown>[] = []) {
  return createFakeFinancialsDb({
    account_map: ACCOUNT_MAP_SEED_ROWS,
    issue_rules: [],
    stock_prices: [],
    companies: [
      ...[SK, LOSS].map((c) => ({
        corp_code: c.corpCode,
        stock_code: c.stockCode,
        acc_mt: 12,
        sectors: { is_financial: false },
      })),
      ...extraCompanies,
    ],
  });
}

function request(extra: Partial<AnalysisRequestView> = {}): AnalysisRequestView {
  return {
    intent: "recent",
    target: SK,
    peers: [],
    metrics: ["per"],
    period: { from: "2024Q1", to: "2024Q4", specified: false, reason: "최근", clipped: false },
    groupBy: "quarter",
    needsNews: false,
    ...extra,
  };
}

/** 2025-04-15 KST — 2024Q4(사업보고서 기한 3/31)가 "최신 분기"라 지금 주가를 쓴다 */
const NOW = () => new Date("2025-04-15T03:00:00Z");

beforeEach(() => {
  dartFetchMock.mockReset();
  priceFetchMock.mockReset();
  mockDart();
});

describe("SK하이닉스 PER 알려줘 (WU-502)", () => {
  it("카드에 시가총액·PER·PBR + 기준일, 시가총액 = 종가 × 상장주식수", async () => {
    mockPrices([priceItem("000660", "20250414", 180_000, 728_002_365, "SK하이닉스")]);
    const outcome = await runAnalysis(request(), { client: db().client, now: NOW });
    if (outcome.kind !== "done") throw new Error(outcome.kind);
    const { result } = outcome;

    const [card] = result.charts;
    expect(card).toMatchObject({ id: "c1", type: "card" });
    expect(card.title).toBe("SK하이닉스 주가 지표 (2025-04-14 종가 기준)");
    expect(card.series.map((s) => [s.key, s.unit])).toEqual([
      ["market_cap", "KRW"],
      ["per", "TIMES"],
      ["pbr", "TIMES"],
    ]);
    const fig = (key: string) =>
      result.figures[card.series.find((s) => s.key === key)!.points[0].figureId];

    const cap = 180_000 * 728_002_365;
    expect(fig("market_cap")).toMatchObject({ value: cap, unit: "KRW", display: "131조 404억 원" });
    // TTM = 1+2+3+4 = 10조, 지배주주지분 50조
    expect(fig("per").value).toBeCloseTo(cap / (10 * JO), 10);
    expect(fig("per").display).toBe(`${(cap / (10 * JO)).toFixed(2)}배`);
    expect(fig("pbr").value).toBeCloseTo(cap / (50 * JO), 10);
    for (const key of ["market_cap", "per", "pbr"]) {
      expect(fig(key).basis.priceDate).toBe("2025-04-14");
    }
    expect(fig("per").basis.report).toBe("2024 사업보고서·2024 3분기보고서");

    // ⓘ 계산식 (TECH §6.4) — 표 주석
    expect(card.footnotes).toEqual([
      "시가총액 = 기준일 종가 × 상장주식수 (보통주만)",
      "PER = 시가총액 ÷ TTM 지배주주 순이익 (최근 4개 분기 합, 0 이하면 적자) — TTM 2024Q1~2024Q4",
      "PBR = 시가총액 ÷ 최근 분기말 지배주주지분 (0 이하면 자본잠식) — 2024Q4말",
    ]);

    expect(result.basis.priceDate).toBe("2025-04-14");
    expect(outcome.version.priceDate).toBe("2025-04-14");
    // 재무 차트는 없다 (PER만 물음) — 사용된 데이터는 주가 지표 표
    expect(result.charts).toHaveLength(1);
    expect(result.usedData.columns.map((c) => c.name)).toEqual(["기업", "시가총액", "PER", "PBR"]);
    expect(result.usedData.rows).toBe(1);

    // 실행 기록: 결합 전후 행 수 (정상 결합에서 행이 늘지 않는다)
    expect(outcome.priceJoin?.summary).toBe(
      "주가 결합: 재무 1행 + 주가 1행 → 1행, 제외 0행(우선주 0), 기준일 2025-04-14, 주가 호출 1건",
    );
  });

  it("TTM ≤ 0 → PER '적자', 지배주주지분 ≤ 0 → PBR '자본잠식' (값 null + 사유)", async () => {
    mockPrices([priceItem("900090", "20250414", 1_000, 10_000_000)]);
    const outcome = await runAnalysis(request({ target: LOSS }), { client: db().client, now: NOW });
    if (outcome.kind !== "done") throw new Error(outcome.kind);
    const [card] = outcome.result.charts;
    const fig = (key: string) =>
      outcome.result.figures[card.series.find((s) => s.key === key)!.points[0].figureId];
    // TTM = -1 -1 +0.5 +0.2 = -1.3조
    expect(fig("per")).toMatchObject({
      value: null,
      reason: "DEFICIT",
      display: "적자",
      unit: "TIMES",
    });
    expect(fig("pbr")).toMatchObject({
      value: null,
      reason: "CAPITAL_IMPAIRMENT",
      display: "자본잠식",
    });
    expect(fig("market_cap").value).toBe(1_000 * 10_000_000);
  });

  it("같은 종목·기준일 가격 2행 → 결합 중단: 지표는 null, 분석 기준에 경고, 실행 기록에 결합 중단", async () => {
    mockPrices([
      priceItem("000660", "20250414", 180_000, 728_002_365),
      priceItem("000660", "20250414", 181_000, 728_002_365),
    ]);
    const outcome = await runAnalysis(request(), { client: db().client, now: NOW });
    if (outcome.kind !== "done") throw new Error(outcome.kind);
    const { result } = outcome;
    expect(result.basis.flags[0]).toBe(
      "주가 결합 중단 — 같은 종목·기준일 가격 2행 이상: 000660 2025-04-14 (2행)",
    );
    const figures = Object.values(result.figures);
    expect(figures.every((f) => f.value === null && f.reason === "NO_PRICE")).toBe(true);
    expect(outcome.priceJoin?.summary).toContain("재무 1행 + 주가 2행 → 2행");
    expect(outcome.priceJoin?.summary).toContain("결합 중단");
  });

  it("보통주 종목코드 중복(기업 목록에 같은 기업 코드 둘) → 결합 중단 + 경고", async () => {
    mockPrices([priceItem("000660", "20250414", 180_000, 728_002_365)]);
    const fake = db([{ corp_code: SK.corpCode, stock_code: "000670", acc_mt: 12 }]);
    const outcome = await runAnalysis(request(), { client: fake.client, now: NOW });
    if (outcome.kind !== "done") throw new Error(outcome.kind);
    expect(outcome.result.basis.flags[0]).toBe(
      "주가 결합 중단 — 보통주 종목코드 중복: SK하이닉스 000660·000670",
    );
    expect(Object.values(outcome.result.figures).every((f) => f.value === null)).toBe(true);
  });

  it("두 기업(비교)이면 표, 기업마다 한 행. 지난 분기를 물으면 그 분기말 이전 마지막 거래일 가격", async () => {
    mockPrices([
      priceItem("000660", "20241227", 170_000, 728_002_365),
      priceItem("000660", "20241230", 173_900, 728_002_365),
      priceItem("900090", "20241230", 1_000, 10_000_000),
    ]);
    // 2026-10-01이면 2024Q4는 지난 분기 → 2024-12-31 이전 마지막 거래일(12/30)
    const outcome = await runAnalysis(
      request({ peers: [LOSS], groupBy: "company", intent: "compare" }),
      { client: db().client, now: () => new Date("2026-10-01T03:00:00Z") },
    );
    if (outcome.kind !== "done") throw new Error(outcome.kind);
    const [table] = outcome.result.charts;
    expect(table).toMatchObject({
      type: "table",
      title: "기업별 주가 지표 (2024-12-30 종가 기준)",
    });
    expect(table.series[0].points.map((p) => p.x)).toEqual(["SK하이닉스", "가상적자"]);
    expect(outcome.result.basis.priceDate).toBe("2024-12-30");
    const [, params] = priceFetchMock.mock.calls[0];
    expect(params).toMatchObject({ endBasDt: "20250101" });
  });

  it("재실행(같은 조건)은 데이터 버전의 기준일 가격(저장된 것)으로 — 주가 API를 다시 부르지 않고 같은 숫자", async () => {
    mockPrices([priceItem("000660", "20250414", 180_000, 728_002_365)]);
    const fake = db();
    const first = await runAnalysis(request(), { client: fake.client, now: NOW });
    if (first.kind !== "done") throw new Error(first.kind);

    priceFetchMock.mockClear();
    // 한참 뒤(가격이 바뀌었을 날)에 같은 조건으로
    const rerun = await runAnalysis(request(), {
      client: fake.client,
      now: () => new Date("2025-06-01T03:00:00Z"),
      version: first.version,
    });
    if (rerun.kind !== "done") throw new Error(rerun.kind);
    expect(priceFetchMock).not.toHaveBeenCalled();
    expect(rerun.versionHash).toBe(first.versionHash);
    expect(rerun.result.figures).toEqual(first.result.figures);
  });

  it("재무 지표와 함께 물으면 주가 지표 카드가 첫 차트(c1), 재무 차트는 그 뒤로", async () => {
    mockPrices([priceItem("000660", "20250414", 180_000, 728_002_365)]);
    const outcome = await runAnalysis(request({ metrics: ["ttm_owners_ni", "per"] }), {
      client: db().client,
      now: NOW,
    });
    if (outcome.kind !== "done") throw new Error(outcome.kind);
    expect(outcome.result.charts.map((c) => [c.id, c.type])).toEqual([
      ["c1", "card"],
      ["c2", "line"],
    ]);
    // 사용된 데이터는 재무 표 그대로
    expect(outcome.result.usedData.columns[0].name).toBe("분기");
  });
});

describe("주가 API가 안 될 때", () => {
  it("재무 숫자는 그대로 내고 주가 지표만 NO_PRICE + 분석 기준에 안내 (분석 전체가 실패하지 않는다)", async () => {
    priceFetchMock.mockRejectedValue(
      new Error("주가 API 오류 (30: SERVICE_KEY_IS_NOT_REGISTERED_ERROR)"),
    );
    const outcome = await runAnalysis(request({ metrics: ["ttm_owners_ni", "per"] }), {
      client: db().client,
      now: NOW,
    });
    if (outcome.kind !== "done") throw new Error(outcome.kind);
    const { result } = outcome;
    expect(result.basis.flags[0]).toBe(
      "주가를 받지 못해 시가총액·PER·PBR을 계산하지 못했습니다 — 잠시 후 다시 시도해 주세요",
    );
    const [card, trend] = result.charts;
    expect(
      card.series.every((s) => result.figures[s.points[0].figureId].reason === "NO_PRICE"),
    ).toBe(true);
    // TTM 지배주주 순이익(재무)은 계산된다
    expect(result.figures[trend.series[0].points.at(-1)!.figureId].value).toBe(10 * JO);
    expect(result.basis.priceDate).toBeNull();
  });
});

describe("build_result 실행 기록", () => {
  it("outputSummary에 결합 전후 행 수, usage에 주가 호출 수", async () => {
    mockPrices([
      priceItem("000660", "20241230", 173_900, 728_002_365, "SK하이닉스"),
      priceItem("000665", "20241230", 100_000, 1_000, "SK하이닉스우"),
    ]);
    const ctx: ToolContext = {
      request: request(),
      question: "SK하이닉스 2024년 PER",
      mixedScope: false,
      analysisId: "a1",
      userId: null,
      client: db().client,
      decisions: null,
      previous: [],
    };
    // likeSrtnCd=000660 검색에 우선주(000665)는 안 걸린다 — 응답에 섞여 와도 빼는지 보려고 그대로 돌려준다
    priceFetchMock.mockImplementation(async () => ({
      response: {
        header: { resultCode: "00", resultMsg: "OK" },
        body: {
          items: {
            item: [
              priceItem("000660", "20241230", 173_900, 728_002_365, "SK하이닉스"),
              priceItem("000665", "20241230", 100_000, 1_000, "SK하이닉스우"),
            ],
          },
        },
      },
    }));
    const outcome = await buildResult({}, ctx);
    if (outcome.status !== "succeeded") throw new Error(outcome.status);
    expect(outcome.outputSummary).toContain(
      "주가 결합: 재무 1행 + 주가 2행 → 1행, 제외 1행(우선주 1), 기준일 2024-12-30, 주가 호출 1건",
    );
    // 외부 호출 = 주가 결합 1건 + 투자 리포트가 받은 것 (리포트 요약 줄에 따로 센다, Phase 5 후속). AI 0
    expect(outcome.outputSummary).toMatch(/투자 리포트: .*외부 호출 (\d+)건/);
    const reportCalls = Number(/투자 리포트: .*외부 호출 (\d+)건/.exec(outcome.outputSummary)![1]);
    expect(outcome.usage).toEqual({ externalCalls: 1 + reportCalls, llmCostUsd: 0 });
  });
});

describe("기업 재무를 함께 받는다 (Phase 3 후속: 보드 B2 새 비교 기업)", () => {
  it("두 기업의 보고서 요청이 동시에 진행된다 — 한 곳씩 차례로 받지 않는다", async () => {
    const inFlight = new Set<string>();
    let overlapped = false;
    const real = dartFetchMock.getMockImplementation()!;
    dartFetchMock.mockImplementation(async (path: string, params: Record<string, unknown>) => {
      const corp = String(params.corp_code);
      inFlight.add(corp);
      if (inFlight.size > 1) overlapped = true;
      await new Promise((r) => setTimeout(r, 5));
      inFlight.delete(corp);
      return real(path, params);
    });
    const outcome = await runAnalysis(
      request({ peers: [LOSS], groupBy: "company", intent: "compare", metrics: ["ttm_owners_ni"] }),
      { client: db().client, now: NOW },
    );
    expect(outcome.kind).toBe("done");
    expect(overlapped).toBe(true);
  });
});

describe("분석 글이 주가 지표 숫자(TIMES)를 자리표시자로 쓴다 (Phase 5 확인, 가짜 AI)", () => {
  async function valuationResult(stockCode = "000660", target = SK) {
    mockPrices([
      priceItem(stockCode, "20250414", stockCode === "000660" ? 180_000 : 1_000, 10_000_000),
    ]);
    const outcome = await runAnalysis(request({ target }), { client: db().client, now: NOW });
    if (outcome.kind !== "done") throw new Error(outcome.kind);
    const card = outcome.result.charts[0];
    const idOf = (key: string) => card.series.find((s) => s.key === key)!.points[0].figureId;
    return { result: outcome.result, per: idOf("per"), pbr: idOf("pbr"), cap: idOf("market_cap") };
  }

  function aiSays(conclusion: string[], insights: { text: string; figure_ids: string[] }[] = []) {
    llmCallMock.mockResolvedValue({
      output: {
        conclusion,
        insights: insights.map((i) => ({
          kind: "watch",
          news_ids: [],
          chart_ref: "c1",
          inferred: false,
          ...i,
        })),
        evidence: [],
        news_clues: [],
        caveats: [],
      },
    });
  }

  beforeEach(() => llmCallMock.mockReset());

  it("AI가 받는 숫자 목록에 PER·PBR이 표시 글자('…배') 그대로 있다 — 숫자를 지어낼 필요가 없다", async () => {
    const { result, per, pbr } = await valuationResult();
    aiSays(["PER을 확인했습니다."]);
    await generateExplanationWithUsage({
      question: "SK하이닉스 PER 알려줘",
      result,
      mixedScope: false,
    });
    const prompt = JSON.stringify(llmCallMock.mock.calls[0][0].input);
    expect(prompt).toContain(result.figures[per].display);
    expect(prompt).toContain(result.figures[pbr].display);
    expect(result.figures[per].display).toMatch(/^\d+\.\d{2}배$/);
  });

  it("{{PER}} 자리표시자는 서버가 '…배'로 채운다 (결론·투자 포인트)", async () => {
    const { result, per, pbr } = await valuationResult();
    aiSays(
      [`SK하이닉스의 PER은 {{${per}}}, PBR은 {{${pbr}}}입니다.`],
      [
        {
          text: `이익 대비 주가 수준(PER {{${per}}})을 같은 업종과 견줘 볼 만합니다.`,
          figure_ids: [per],
        },
      ],
    );
    const { explanation } = await generateExplanationWithUsage({
      question: "SK하이닉스 PER 알려줘",
      result,
      mixedScope: false,
    });
    expect(explanation.conclusion[0]).toBe(
      `SK하이닉스의 PER은 ${result.figures[per].display}, PBR은 ${result.figures[pbr].display}입니다.`,
    );
    expect(explanation.insights[0].text).toContain(`PER ${result.figures[per].display})`);
  });

  it("AI가 PER 숫자를 직접 쓰면(자리표시자 아님) 그 문장은 버린다", async () => {
    const { result, per } = await valuationResult();
    aiSays([`PER은 13배 수준입니다.`, `PER은 {{${per}}}입니다.`]);
    const { explanation } = await generateExplanationWithUsage({
      question: "SK하이닉스 PER 알려줘",
      result,
      mixedScope: false,
    });
    expect(explanation.conclusion).toEqual([`PER은 ${result.figures[per].display}입니다.`]);
  });

  it("적자 PER('적자')·자본잠식 PBR을 가리키는 문장은 지금 버려진다 (값이 null — 다른 트랙에 알림)", async () => {
    const { result, per, pbr } = await valuationResult("900090", LOSS);
    expect([result.figures[per].display, result.figures[pbr].display]).toEqual([
      "적자",
      "자본잠식",
    ]);
    aiSays([`가상적자는 PER이 {{${per}}}입니다.`, "이익이 나지 않아 PER을 계산할 수 없습니다."]);
    const { explanation } = await generateExplanationWithUsage({
      question: "가상적자 PER 알려줘",
      result,
      mixedScope: false,
    });
    expect(explanation.conclusion).toEqual(["이익이 나지 않아 PER을 계산할 수 없습니다."]);
  });
});
