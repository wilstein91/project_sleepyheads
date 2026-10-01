// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalysisRequestView, CompanyRef, ResultObject } from "@/contracts";

// B1 GET·B2 PATCH /api/boards/:id (WU-401). 보드 ID = 분석 ID.
// - 남의 것·없는 것 404 (아무것도 계산·저장하지 않음), 결과 없는 분석 409
// - B2: 필터 검사(400·422) → 처리 한도(413, **계산 전**) → 다시 계산 → boards 저장 → "stale"
// - B2는 AI를 부르지 않고 질문 수도 쓰지 않는다
// - B1: 보드가 없으면 filters {} + 원래 결과 + "ready", 필터를 바꾼 뒤엔 "stale", Q9가 다시 쓰면 "ready"
// 실제 DB·전자공시는 부르지 않는다 (가짜 세션 클라이언트·가짜 실행기).

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const ANALYSIS = "22222222-2222-4222-8222-222222222222";
const VERSION = "44444444-4444-4444-8444-444444444444";

const company = (stockCode: string, name: string): CompanyRef => ({
  corpCode: `00${stockCode}`,
  stockCode,
  name,
  market: "KOSPI",
  sector: { name: "반도체", source: "manual", isFinancial: false },
  fiscalMonth: 12,
});
const TARGET = company("000660", "SK하이닉스");
const SAMSUNG = company("005930", "삼성전자");

const REQUEST: AnalysisRequestView = {
  intent: "trend",
  target: TARGET,
  peers: [],
  metrics: ["revenue", "operating_income"],
  period: { from: "2025Q3", to: "2026Q2", specified: false, reason: "기본", clipped: false },
  groupBy: "quarter",
  needsNews: false,
};

const resultFor = (label: string, points = 4): ResultObject =>
  ({
    basis: { flags: [], dataVersionId: VERSION, newerDataVersionAvailable: false, period: {} },
    figures: {},
    charts: [
      {
        id: "c1",
        type: "line",
        title: label,
        series: [
          {
            key: "revenue",
            label: "매출",
            unit: "KRW",
            points: Array.from({ length: points }, (_, i) => ({ x: `p${i}`, figureId: `f${i}` })),
          },
        ],
        footnotes: [],
        source: "",
      },
    ],
    disclosures: [],
    usedData: {},
  }) as unknown as ResultObject;

const ORIGINAL = resultFor("원래 결과");

const state = vi.hoisted(() => ({
  analysis: null as Record<string, unknown> | null,
  board: null as Record<string, unknown> | null,
  saved: [] as Record<string, unknown>[],
  runs: [] as { request: AnalysisRequestView; options: Record<string, unknown> }[],
  runResult: null as unknown,
  versionsSaved: 0,
  llmCalls: 0,
  quotaCalls: 0,
  resolved: [] as string[],
  /** 이미 확인한 보고서(report_fetch_state) "corp|year" — B2 새 보고서 한도. 그 해의 보고서 4종을 다 본 것으로 친다 */
  fetchedYears: [] as string[],
  /** get_peers 단계가 자동으로 고른 경쟁사 */
  autoPeers: [] as CompanyRef[],
}));

vi.mock("@/lib/supabase/server", () => ({
  createSessionClient: async () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: USER } }, error: null }) },
    from: (table: string) => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => {
          if (table === "profiles") return { data: { agreed_terms_at: "2026-09-29" }, error: null };
          if (table === "boards") return { data: state.board, error: null };
          return { data: state.analysis, error: null };
        },
      };
      return builder;
    },
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => ({
      upsert: async (rows: Record<string, unknown>[]) => {
        if (table === "boards") state.saved.push(...rows);
        return { error: null };
      },
      select: () => ({
        // analysis_steps: 자동 선택 경쟁사 (get_peers 단계 출력)
        eq: () => {
          const steps = {
            eq: () => steps,
            order: () => steps,
            limit: () => steps,
            maybeSingle: async () => ({
              data: state.autoPeers.length > 0 ? { output: { peers: state.autoPeers } } : null,
              error: null,
            }),
          };
          return steps;
        },
        in: async (_col: string, corps: string[]) => ({
          data:
            table === "report_fetch_state"
              ? state.fetchedYears
                  .map((key) => key.split("|"))
                  .filter(([corp]) => corps.includes(corp))
                  .flatMap(([corp, year]) =>
                    ["11013", "11012", "11014", "11011"].map((reprt_code) => ({
                      corp_code: corp,
                      bsns_year: Number(year),
                      reprt_code,
                    })),
                  )
              : [],
          error: null,
        }),
      }),
    }),
  }),
}));
vi.mock("@/lib/api/rate-limit", () => ({
  checkRequestRate: async () => ({ allowed: true, retryAfterSeconds: 0 }),
}));
vi.mock("@/lib/api/questions-remaining", () => ({
  withQuestionsRemaining: async (res: Response) => res,
}));

// AI·질문 수: 불리면 숫자가 올라간다 — B2 테스트는 0이어야 한다
vi.mock("@/lib/llm/client", () => ({
  llmCall: async () => {
    state.llmCalls += 1;
    throw new Error("B2는 AI를 부르면 안 된다");
  },
}));
vi.mock("@/lib/quota/question-quota", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/quota/question-quota")>()),
  consumeQuestionQuota: async () => {
    state.quotaCalls += 1;
    throw new Error("B2는 질문 수를 쓰면 안 된다");
  },
}));

vi.mock("@/lib/companies/resolve", () => ({
  resolveCompany: async (code: string) => {
    state.resolved.push(code);
    return code === SAMSUNG.stockCode
      ? { type: "resolved", company: SAMSUNG }
      : { type: "not_found" };
  },
}));

vi.mock("@/lib/runner/execute", () => ({
  CHANGE_LOOKBACK_QUARTERS: 4,
  runAnalysis: async (request: AnalysisRequestView, options: Record<string, unknown>) => {
    state.runs.push({ request, options });
    return {
      kind: "done",
      result: state.runResult,
      version: { sources: [], calcVersion: "v3", priceDate: null, decisions: {} },
      versionHash: "hash",
      diagnoses: [],
    };
  },
}));
vi.mock("@/lib/versions/store", () => ({
  loadDataVersion: async (_client: unknown, id: string) =>
    id === VERSION
      ? {
          id,
          ownerId: USER,
          hash: "h",
          sources: [{ corpCode: TARGET.corpCode, bsnsYear: 2026, reprtCode: "11012" }],
          calcVersion: "v3",
          priceDate: null,
          decisions: { missing_account: "show_blank" },
        }
      : null,
  saveDataVersion: async () => {
    state.versionsSaved += 1;
  },
  isNewerDataAvailable: async () => false,
}));

const { GET, PATCH } = await import("@/app/api/boards/[id]/route");

function knownYears(company: CompanyRef, from: number, to: number): string[] {
  return Array.from({ length: to - from + 1 }, (_, i) => `${company.corpCode}|${from + i}`);
}

function get() {
  return GET(new NextRequest(`http://localhost:3000/api/boards/${ANALYSIS}`), {
    params: Promise.resolve({ id: ANALYSIS }),
  });
}

function patch(body: unknown) {
  return PATCH(
    new NextRequest(`http://localhost:3000/api/boards/${ANALYSIS}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: ANALYSIS }) },
  );
}

beforeEach(() => {
  state.analysis = {
    id: ANALYSIS,
    owner_id: USER,
    status: "succeeded",
    analysis_request: REQUEST,
    result: ORIGINAL,
    dataset_version_id: VERSION,
    updated_at: "2026-09-30T10:00:00.000Z",
  };
  state.board = null;
  state.saved = [];
  state.runs = [];
  state.runResult = resultFor("다시 계산한 결과");
  state.versionsSaved = 0;
  state.llmCalls = 0;
  state.quotaCalls = 0;
  state.resolved = [];
  state.autoPeers = [];
  state.fetchedYears = knownYears(TARGET, 2014, 2026).concat(knownYears(SAMSUNG, 2014, 2026));
});

describe("B1 GET /api/boards/:id", () => {
  it("보드가 없으면 filters {} + 원래 결과 + ready (보드 ID = 분석 ID)", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({
      id: ANALYSIS,
      analysisId: ANALYSIS,
      filters: {},
      result: ORIGINAL,
      explanationStatus: "ready",
    });
  });

  it("필터를 바꾼 뒤(보드가 분석 글보다 나중)면 저장된 필터·결과 + stale, Q9가 다시 쓴 뒤면 ready", async () => {
    const boardResult = resultFor("보드 결과");
    state.board = {
      filters: { peers: [SAMSUNG.stockCode] },
      result: boardResult,
      updated_at: "2026-09-30T11:00:00.000Z",
    };
    let body = (await (await get()).json()).data;
    expect(body).toMatchObject({
      filters: { peers: [SAMSUNG.stockCode] },
      result: boardResult,
      explanationStatus: "stale",
    });

    // Q9(설명 다시 쓰기)가 analyses.updated_at을 올렸다
    state.analysis!.updated_at = "2026-09-30T12:00:00.000Z";
    body = (await (await get()).json()).data;
    expect(body.explanationStatus).toBe("ready");
  });

  it("분석 요청이 없는 옛 분석도 결과만 있으면 B1은 열린다 (B2는 다시 계산할 수 없어 409)", async () => {
    state.analysis!.analysis_request = null;
    expect((await get()).status).toBe(200);
    const res = await patch({ filters: {} });
    expect(res.status).toBe(409);
    expect(state.runs).toEqual([]);
  });

  it("남의 분석·없는 분석은 404, 결과가 없는 분석은 409", async () => {
    state.analysis!.owner_id = OTHER;
    expect((await get()).status).toBe(404);
    state.analysis = null;
    expect((await get()).status).toBe(404);
    state.analysis = {
      id: ANALYSIS,
      owner_id: USER,
      status: "running",
      analysis_request: REQUEST,
      result: null,
      dataset_version_id: null,
      updated_at: "2026-09-30T10:00:00.000Z",
    };
    const res = await get();
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("INVALID_STATE");
  });
});

describe("B2 PATCH /api/boards/:id", () => {
  it("필터만 덮어써 다시 계산하고 boards에 저장, stale — AI 0건·질문 차감 없음", async () => {
    const res = await patch({
      filters: { period: { from: "2024Q1", to: "2026Q2" }, peers: [SAMSUNG.stockCode] },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()).data;
    expect(body).toMatchObject({
      id: ANALYSIS,
      analysisId: ANALYSIS,
      filters: { period: { from: "2024Q1", to: "2026Q2" }, peers: [SAMSUNG.stockCode] },
      explanationStatus: "stale",
    });
    expect(body.result.charts[0].title).toBe("다시 계산한 결과");

    // 실행기에 넘긴 요청: 기간·비교 기업만 바뀌고 지표·묶음 단위는 원래 그대로
    expect(state.runs).toHaveLength(1);
    const { request, options } = state.runs[0];
    expect(request).toMatchObject({
      intent: "trend",
      target: TARGET,
      peers: [SAMSUNG],
      metrics: ["revenue", "operating_income"],
      groupBy: "quarter",
      period: { from: "2024Q1", to: "2026Q2", specified: true },
    });
    // 데이터 버전 규칙: 원래 버전의 출처·선택을 기반으로 다시 계산한다
    expect(options).toMatchObject({
      userId: USER,
      analysisId: ANALYSIS,
      base: { decisions: { missing_account: "show_blank" } },
      requireConfirmation: false,
      peerComparisonChart: true,
    });

    expect(state.saved).toEqual([
      expect.objectContaining({
        id: ANALYSIS,
        analysis_id: ANALYSIS,
        owner_id: USER,
        filters: { period: { from: "2024Q1", to: "2026Q2" }, peers: [SAMSUNG.stockCode] },
      }),
    ]);
    expect(state.versionsSaved).toBe(1);
    expect(state.llmCalls).toBe(0);
    expect(state.quotaCalls).toBe(0);
  });

  it("남의 분석은 본문을 보기 전에 404 — 계산·저장 없음", async () => {
    state.analysis!.owner_id = OTHER;
    const res = await patch({ filters: { peers: Array(9).fill("005930") } });
    expect(res.status).toBe(404);
    expect(state.runs).toEqual([]);
    expect(state.saved).toEqual([]);
  });

  it.each([
    ["비교 기업 6곳", { peers: ["000001", "000002", "000003", "000004", "000005", "000006"] }],
    ["종목코드 모양이 틀림", { peers: ["삼성전자"] }],
    ["시작이 끝보다 늦음", { period: { from: "2026Q2", to: "2025Q1" } }],
    ["분기 모양이 틀림", { period: { from: "2026-04", to: "2026Q2" } }],
    ["모르는 필드", { metrics: ["roe"] }],
  ])("%s → 400, 계산 없음", async (_name, filters) => {
    const res = await patch({ filters });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
    expect(state.runs).toEqual([]);
  });

  it("비교 기업 목록의 중복·대상 기업은 빼고 센다 (5곳 + 대상 + 중복은 통과)", async () => {
    const res = await patch({
      filters: { peers: [TARGET.stockCode, SAMSUNG.stockCode, SAMSUNG.stockCode] },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.filters).toEqual({ peers: [SAMSUNG.stockCode] });
  });

  it("없는 종목코드는 400", async () => {
    const res = await patch({ filters: { peers: ["123456"] } });
    expect(res.status).toBe(400);
    expect(state.runs).toEqual([]);
  });

  it.each([
    ["2016Q1 이전", { from: "2015Q4", to: "2016Q2" }],
    ["최신 분기 이후", { from: "2025Q1", to: "2099Q4" }],
  ])("기간 %s → 422 OUT_OF_RANGE, 계산 없음", async (_name, period) => {
    const res = await patch({ filters: { period } });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("OUT_OF_RANGE");
    expect(state.runs).toEqual([]);
  });

  it("처리 한도를 넘으면 계산 전에 413 TOO_LARGE (실행기를 부르지 않음)", async () => {
    const limits = await import("@/lib/limits/size");
    const spy = vi.spyOn(limits, "assertAggregateSize");
    const { HttpError } = await import("@/lib/api/errors");
    spy.mockImplementationOnce(() => {
      throw new HttpError("TOO_LARGE", "기간이나 비교 기업 수를 줄여 주세요.");
    });
    const res = await patch({ filters: { period: { from: "2016Q1", to: "2026Q2" } } });
    expect(res.status).toBe(413);
    // 문구 뒤에 예시가 붙을 수 있어 통째로 비교하지 않는다 — 코드 + "줄여"만
    const { error } = (await res.json()) as { error: { code: string; message: string } };
    expect(error.code).toBe("TOO_LARGE");
    expect(error.message).toContain("줄여");
    expect(state.runs).toEqual([]);
    expect(state.saved).toEqual([]);
    // 한도 함수에 넘긴 크기: 기업 1곳 × (42분기 + 증감률용 4분기) × 원자료 계정 8개
    expect(spy).toHaveBeenCalledWith({ companies: 1, quarters: 46, accounts: 8 });
    spy.mockRestore();
  });

  it("차트 점이 500개를 넘으면 결과의 분석 기준에 묶음 단위를 키우라는 안내", async () => {
    state.runResult = resultFor("점 많음", 501);
    const res = await patch({ filters: {} });
    const flags: string[] = (await res.json()).data.result.basis.flags;
    expect(flags.some((f) => f.includes("연도"))).toBe(true);
  });

  it("데이터 버전 없는 옛 분석은 빈 출처를 기반으로(모두 새로 받아) 다시 계산한다", async () => {
    state.analysis!.dataset_version_id = null;
    const res = await patch({ filters: {} });
    expect(res.status).toBe(200);
    expect(state.runs[0].options.base).toEqual({ sources: [], decisions: {} });
  });

  it("새로 받을 보고서가 60건을 넘으면 계산 전에 413 — 처음 보는 기업 (Phase 3 후속)", async () => {
    // 둘 다 처음 — 2019Q1~2026Q2 + 앞 4분기 = 2018Q1~2026Q2, 기업마다 보고서 34건 × 2 = 68건 > 60
    state.fetchedYears = [];
    const res = await patch({
      filters: { period: { from: "2019Q1", to: "2026Q2" }, peers: [SAMSUNG.stockCode] },
    });
    expect(res.status).toBe(413);
    const { error } = (await res.json()) as {
      error: { code: string; message: string; details: Record<string, number> };
    };
    expect(error.code).toBe("TOO_LARGE");
    expect(error.message).toContain("줄여");
    expect(error.message).toContain("SK하이닉스 34건, 삼성전자 34건");
    expect(error.details).toMatchObject({
      freshCompanies: 2,
      estimatedReports: 68,
      maxReports: 60,
    });
    expect(state.runs).toEqual([]);

    // SK하이닉스 보고서는 이미 다 있다 — 삼성전자 34건만 새로 받으면 되니 통과
    state.fetchedYears = knownYears(TARGET, 2014, 2026);
    const ok = await patch({
      filters: { period: { from: "2019Q1", to: "2026Q2" }, peers: [SAMSUNG.stockCode] },
    });
    expect(ok.status).toBe(200);
  });

  it("이미 본 기업도 기간을 크게 넓히면 새 보고서를 세어 413 (처음 보는 기업만 세지 않는다)", async () => {
    // 두 기업 모두 2025~2026년 보고서만 받아 두었다 (원래 분석이 최근 기간)
    state.fetchedYears = knownYears(TARGET, 2025, 2026).concat(knownYears(SAMSUNG, 2025, 2026));
    // 2016Q1~2026Q2 + 앞 4분기: 기업마다 2015~2024년 보고서 40건 × 2 = 80건이 새로 필요
    const res = await patch({
      filters: { period: { from: "2016Q1", to: "2026Q2" }, peers: [SAMSUNG.stockCode] },
    });
    expect(res.status).toBe(413);
    expect((await res.json()).error.details).toMatchObject({
      freshCompanies: 2,
      estimatedReports: 80,
    });
    expect(state.runs).toEqual([]);
  });

  it("보드 결과의 데이터 버전이 원래 분석과 다르면 분석 기준 맨 앞에 알린다 (Phase 3 후속)", async () => {
    const changed = resultFor("새 기간");
    changed.basis.dataVersionId = "55555555-5555-4555-8555-555555555555";
    state.runResult = changed;
    const res = await patch({ filters: { period: { from: "2024Q1", to: "2026Q2" } } });
    const flags: string[] = (await res.json()).data.result.basis.flags;
    expect(flags[0]).toBe(
      "보드 데이터 버전 55555555 — 원래 분석(44444444)과 다릅니다. 위 [같은 조건으로 재실행]은 원래 분석 기준입니다",
    );
  });

  it("같은 데이터 버전이면 알리지 않는다", async () => {
    const res = await patch({ filters: {} });
    const flags: string[] = (await res.json()).data.result.basis.flags;
    expect(flags.some((f) => f.startsWith("보드 데이터 버전"))).toBe(false);
  });

  it("합계에서 비교 기업을 모두 빼면 '합계 풀림' — 화면이 원래 groupBy를 들고 있어도 분석 기준으로 안다", async () => {
    state.analysis!.analysis_request = {
      ...REQUEST,
      peers: [SAMSUNG],
      aggregate: "sum",
      groupBy: "sector",
    };
    const res = await patch({ filters: { peers: [] } });
    expect(res.status).toBe(200);
    expect(state.runs[0].request).toMatchObject({ groupBy: "quarter", peers: [] });
    expect(state.runs[0].request.aggregate).toBeUndefined();
    const flags: string[] = (await res.json()).data.result.basis.flags;
    expect(flags[0]).toBe("합계 풀림 — 비교 기업을 모두 빼서 SK하이닉스 분기별 추이로 보여 줍니다");
  });

  it("경쟁사를 자동으로 고른 분석: 기간만 바꿔도 비교 기업이 사라지지 않고, 응답 filters.peers에 그 종목코드 (Phase 4 통합)", async () => {
    state.analysis!.analysis_request = { ...REQUEST, intent: "compare", groupBy: "company" };
    state.autoPeers = [SAMSUNG];
    const res = await patch({ filters: { period: { from: "2024Q1", to: "2026Q2" } } });
    expect(res.status).toBe(200);
    expect(state.runs[0].request.peers).toEqual([SAMSUNG]);
    expect((await res.json()).data.filters).toEqual({
      period: { from: "2024Q1", to: "2026Q2" },
      peers: [SAMSUNG.stockCode],
    });
  });

  it("자동 선택 경쟁사를 다 빼면(peers: []) 정말 빠진다 — 기본값은 필터에 비교 기업이 없을 때만", async () => {
    state.autoPeers = [SAMSUNG];
    const res = await patch({ filters: { peers: [] } });
    expect(res.status).toBe(200);
    expect(state.runs[0].request.peers).toEqual([]);
  });
});

describe("B1 자동 선택 경쟁사", () => {
  it("필터를 바꾼 적 없어도 filters.peers에 자동 선택 경쟁사 종목코드 — 화면 칩이 채워진다", async () => {
    state.autoPeers = [SAMSUNG];
    const body = (await (await get()).json()).data;
    expect(body.filters).toEqual({ peers: [SAMSUNG.stockCode] });
    expect(body.explanationStatus).toBe("ready");
  });

  it("질문에 경쟁사를 적은 분석은 그대로 filters {} (화면이 분석 요청에서 안다)", async () => {
    state.analysis!.analysis_request = { ...REQUEST, peers: [SAMSUNG] };
    state.autoPeers = [SAMSUNG];
    expect((await (await get()).json()).data.filters).toEqual({});
  });
});
