// 회귀 r18 (2026-10-01 운영 분석 67d15836…): "삼성전자와 SK하이닉스 최근 4분기 영업이익 비교해줘"는 AI가
// group_by를 "quarter"로 준다. 계산(runAnalysis)이 분기별 경로에서 대상 기업만 그려 차트·사용된 데이터에
// SK하이닉스가 빠졌고, 분석 글이 "SK하이닉스의 분기별 영업이익이 제공되지 않아 비교할 수 없다"고 썼다.
//
// regression.test.ts는 질문 해석까지만 본다. 여기서는 **질문 해석 → 실제 계산(runAnalysis)** 을 끝까지 돌린다:
// AI = 고정 응답(ai-fixed/r18-…json), DB·전자공시 = 가짜(원문 fixture), 해석·계산 코드는 진짜.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import type { ResultObject } from "@/contracts";
import type { CompanyRow } from "@/lib/companies/row";

const FIXED_NOW = new Date("2026-10-01T03:00:00.000Z");
const DIR = resolve(__dirname);
const CASE_ID = "r18-compare-recent4";

const state = vi.hoisted(() => ({ aiOutput: null as unknown }));
vi.mock("@/lib/llm/client", () => ({
  llmCall: async () => ({
    output: state.aiOutput,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  }),
}));
vi.mock("@/lib/ask/scope-filter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ask/scope-filter")>()),
  fetchScopeBlockPatterns: async () => [],
}));
const { dartFetchMock } = vi.hoisted(() => ({ dartFetchMock: vi.fn() }));
vi.mock("@/lib/dart/client", () => ({ dartFetch: dartFetchMock }));

const { interpretQuestion } = await import("@/lib/ask/interpret");
const { runAnalysis } = await import("@/lib/runner/execute");
const { createFakeCompaniesClient } = await import("../unit/helpers/fake-companies-table");
const { createFakeFinancialsDb } = await import("../unit/helpers/fake-financials-db");
const { ACCOUNT_MAP_SEED_ROWS } = await import("../fixtures/mock/account-map");
const { FIXTURES, engineValue, fakeDartResponse } = await import("./engine");

const SEMI = { name: "반도체", is_financial: false };
const COMPANIES: CompanyRow[] = [
  {
    corp_code: "00126380",
    stock_code: "005930",
    corp_name: "삼성전자",
    market: "KOSPI",
    acc_mt: 12,
    sector_source: "manual",
    sectors: SEMI,
  },
  {
    corp_code: "00164779",
    stock_code: "000660",
    corp_name: "SK하이닉스",
    market: "KOSPI",
    acc_mt: 12,
    sector_source: "manual",
    sectors: SEMI,
  },
];
const QUARTERS = ["2025Q3", "2025Q4", "2026Q1", "2026Q2"];
// 손 계산 (answers/skhynix.json#trend_2025q3_2026q2, answers/samsung.json#operating_income-2026Q2)
const SK_HAND = [11383390000000, 19169574000000, 37610283000000, 60542608000000];
const SAMSUNG_2026Q2_HAND = 89492412000000;

const BASE_AI = {
  scope: "in_scope",
  has_out_of_scope_part: false,
  unsupported_metric_requested: false,
  needs_news: false,
  news_keywords: [] as string[],
  charts: [] as unknown[],
};

let result: ResultObject;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXED_NOW);
  dartFetchMock.mockImplementation(async (_path: string, params: Record<string, string>) =>
    fakeDartResponse(params),
  );
  const fixed = JSON.parse(readFileSync(join(DIR, "ai-fixed", `${CASE_ID}.json`), "utf8"));
  const question = JSON.parse(readFileSync(join(DIR, "cases", `${CASE_ID}.json`), "utf8"))
    .question as string;
  state.aiOutput = { ...BASE_AI, ...fixed };

  const { client } = createFakeCompaniesClient(COMPANIES) as { client: SupabaseClient };
  const interpreted = await interpretQuestion({ question, userId: null, client });
  if (interpreted.type !== "resolved") throw new Error(`해석 실패: ${interpreted.type}`);
  // 운영과 같은 해석: 분기별(quarter) 묶음 + 비교 기업 1곳
  expect(interpreted.request.groupBy).toBe("quarter");
  expect(interpreted.request.peers.map((p) => p.name)).toEqual(["SK하이닉스"]);

  const db = createFakeFinancialsDb({
    account_map: ACCOUNT_MAP_SEED_ROWS,
    companies: Object.values(FIXTURES).map((f) => ({
      corp_code: f.corp_code,
      acc_mt: f.acc_mt,
      sectors: { is_financial: f.is_financial },
    })),
  });
  const outcome = await runAnalysis(interpreted.request, {
    client: db.client,
    requireConfirmation: false,
  });
  if (outcome.kind !== "done") throw new Error("진단에서 멈춤");
  result = outcome.result;
});
afterAll(() => vi.useRealTimers());

function valuesOf(seriesLabel: string): (number | null)[] {
  const series = result.charts[0].series.find((s) => s.label === seriesLabel);
  if (!series) throw new Error(`차트에 "${seriesLabel}" 선이 없습니다`);
  return QUARTERS.map((q) => {
    const point = series.points.find((p) => p.x === q);
    return point ? result.figures[point.figureId].value : null;
  });
}

describe(`${CASE_ID}: 두 회사 최근 4분기 비교 — 실제 계산까지`, () => {
  it("차트 하나에 두 회사 선이 모두 있고, 제목에 두 회사 이름", () => {
    expect(result.charts).toHaveLength(1);
    const chart = result.charts[0];
    expect(chart.type).toBe("line");
    expect(chart.title).toBe("삼성전자·SK하이닉스 분기별 실적 (2025Q3~2026Q2)");
    expect(chart.series.map((s) => s.label)).toEqual(["삼성전자 영업이익", "SK하이닉스 영업이익"]);
    // 차트·표 칸 key가 겹치면 한 회사 값이 다른 회사 값을 덮는다
    expect(new Set(chart.series.map((s) => s.key)).size).toBe(2);
    for (const s of chart.series) expect(s.points.map((p) => p.x)).toEqual(QUARTERS);
  });

  it("SK하이닉스 값 = 손 계산, 삼성전자 값 = 엔진 값 (2026Q2는 손 계산)", async () => {
    expect(valuesOf("SK하이닉스 영업이익")).toEqual(SK_HAND);
    const samsung = valuesOf("삼성전자 영업이익");
    expect(samsung[3]).toBe(SAMSUNG_2026Q2_HAND);
    for (const [i, q] of QUARTERS.entries()) {
      const engine = await engineValue("samsung", "operating_income", q);
      expect(samsung[i]).toBe(Number(engine.value));
    }
  });

  it("사용된 데이터: 4행 × (분기 + 두 회사) 3열", () => {
    expect(result.usedData.rows).toBe(4);
    expect(result.usedData.columns.map((c) => c.name)).toEqual([
      "분기",
      "삼성전자 영업이익",
      "SK하이닉스 영업이익",
    ]);
    expect(result.usedData.preview.map((r) => r["분기"])).toEqual(QUARTERS);
    expect(result.usedData.preview.map((r) => r["SK하이닉스 영업이익"])).toEqual(SK_HAND);
  });

  it("숫자 이름에 기업명이 붙어 분석 글이 두 회사 값을 구분한다", () => {
    const labels = Object.values(result.figures).map((f) => f.label);
    expect(labels).toContain("SK하이닉스 영업이익 2026Q2");
    expect(labels).toContain("삼성전자 영업이익 2026Q2");
  });
});
