import { describe, expect, it } from "vitest";
import type { CompanyRow } from "@/lib/companies/row";
import { validateAnalysisRequest } from "@/lib/ask/validate";
import type { AiAnalysisRequest } from "@/lib/ask/ai-request";
import { createFakeCompaniesClient } from "./helpers/fake-companies-table";

const SEMICONDUCTOR = { name: "반도체", is_financial: false };

const SK_HYNIX: CompanyRow = {
  corp_code: "00164779",
  stock_code: "000660",
  corp_name: "SK하이닉스",
  market: "KOSPI",
  acc_mt: 12,
  sector_source: "manual",
  sectors: SEMICONDUCTOR,
};

const HYUNDAI_MOTOR: CompanyRow = {
  corp_code: "00164742",
  stock_code: "005380",
  corp_name: "현대자동차", // 운영 정식 이름 — 질문의 "현대차"는 줄임말 표(COMPANY_ALIASES)로 찾는다
  market: "KOSPI",
  acc_mt: 12,
  sector_source: "induty_code",
  sectors: { name: "자동차/부품", is_financial: false },
};

const HYUNDAI_ENGINEERING: CompanyRow = {
  corp_code: "00164780",
  stock_code: "000720",
  corp_name: "현대건설",
  market: "KOSPI",
  acc_mt: 12,
  sector_source: "induty_code",
  sectors: { name: "건설", is_financial: false },
};

function baseAiRequest(overrides: Partial<AiAnalysisRequest> = {}): AiAnalysisRequest {
  return {
    scope: "in_scope",
    has_out_of_scope_part: false,
    intent: "recent",
    companies: [{ query: "SK하이닉스", role: "target" }],
    metrics: [],
    unsupported_metric_requested: false,
    period: { specified: false, from: null, to: null, text: null },
    group_by: "quarter",
    operations: [],
    needs_news: false,
    news_keywords: [],
    charts: [],
    ...overrides,
  };
}

describe("validateAnalysisRequest (TECH §4.5)", () => {
  it("확정 기업 + 지표 미지정 → 기본 지표로 확정된다", async () => {
    const { client } = createFakeCompaniesClient([SK_HYNIX]);
    const result = await validateAnalysisRequest(baseAiRequest(), { client });
    expect(result.type).toBe("resolved");
    if (result.type === "resolved") {
      expect(result.request.target.name).toBe("SK하이닉스");
      expect(result.request.metrics).toEqual(["revenue", "operating_income", "net_income"]);
      expect(result.request.period.specified).toBe(false);
    }
  });

  it("질문에 기업이 없으면 되묻기", async () => {
    const { client } = createFakeCompaniesClient([SK_HYNIX]);
    const result = await validateAnalysisRequest(baseAiRequest({ companies: [] }), { client });
    expect(result).toEqual({
      type: "needs_clarification",
      clarification: { question: "어느 기업에 대해 궁금하신가요?", options: [] },
    });
  });

  it("후보가 여럿인 회사명은 되묻기 (예: 현대)", async () => {
    const { client } = createFakeCompaniesClient([HYUNDAI_MOTOR, HYUNDAI_ENGINEERING]);
    const result = await validateAnalysisRequest(
      baseAiRequest({ companies: [{ query: "현대", role: "target" }] }),
      { client },
    );
    expect(result.type).toBe("needs_clarification");
    if (result.type === "needs_clarification") {
      expect(result.clarification.options).toHaveLength(2);
      expect(result.clarification.options.map((o) => o.company?.name).sort()).toEqual([
        "현대건설",
        "현대자동차",
      ]);
    }
  });

  it("상장사 목록에 없는 기업은 지원 불가", async () => {
    const { client } = createFakeCompaniesClient([SK_HYNIX]);
    const result = await validateAnalysisRequest(
      baseAiRequest({ companies: [{ query: "없는회사", role: "target" }] }),
      { client },
    );
    expect(result.type).toBe("unsupported_question");
  });

  it("WU-502: 주가 지표(PER·PBR·시가총액)는 이제 지원한다 — 'SK하이닉스 PER 알려줘'가 거절되지 않는다", async () => {
    const { client } = createFakeCompaniesClient([SK_HYNIX]);
    const result = await validateAnalysisRequest(
      baseAiRequest({ metrics: ["per", "pbr", "market_cap"] }),
      { client },
    );
    expect(result.type).toBe("resolved");
    expect(result.type === "resolved" && result.request.metrics).toEqual([
      "per",
      "pbr",
      "market_cap",
    ]);
  });

  it("목록에 아예 없는 지표(예: 직원 만족도)를 물으면 기본 지표로 조용히 대체하지 않고 지원 불가로 거절한다", async () => {
    const { client } = createFakeCompaniesClient([SK_HYNIX]);
    // AI는 이런 지표를 metrics 배열로 표현할 수 없어 metrics: []를 내고 대신 이 플래그로 알린다
    // (실측 회귀에서 이 플래그가 없어 "SK하이닉스 직원 만족도 어때?"가 매출·영업이익·순이익으로
    // 조용히 대체된 문제를 확인했다).
    const result = await validateAnalysisRequest(
      baseAiRequest({ metrics: [], unsupported_metric_requested: true }),
      { client },
    );
    expect(result.type).toBe("unsupported_question");
  });

  it("지원하는 지표와 목록 밖 지표를 함께 물으면 지원하는 부분은 답한다 (매출 + 시장점유율)", async () => {
    const { client } = createFakeCompaniesClient([SK_HYNIX]);
    const result = await validateAnalysisRequest(
      baseAiRequest({ metrics: ["revenue"], unsupported_metric_requested: true }),
      { client },
    );
    expect(result.type).toBe("resolved");
    if (result.type === "resolved") expect(result.request.metrics).toEqual(["revenue"]);
  });

  it("지원 불가 안내는 영문 지표 ID 대신 한글 이름으로 보여 준다", async () => {
    const { client } = createFakeCompaniesClient([SK_HYNIX]);
    const result = await validateAnalysisRequest(
      baseAiRequest({ metrics: [], unsupported_metric_requested: true }),
      { client },
    );
    expect(result.type === "unsupported_question" && result.message).toContain("영업이익");
    expect(result.type === "unsupported_question" && result.message).not.toContain("revenue");
  });

  it("비교 기업이 5곳을 넘으면 조용히 자르지 않고 기업 수 초과로 안내한다 (TECH §4.5)", async () => {
    const { client } = createFakeCompaniesClient([SK_HYNIX]);
    const peers = ["삼성전자", "LG전자", "현대차", "기아", "NAVER", "카카오"].map((query) => ({
      query,
      role: "peer" as const,
    }));
    const result = await validateAnalysisRequest(
      baseAiRequest({ companies: [{ query: "SK하이닉스", role: "target" }, ...peers] }),
      { client },
    );
    expect(result.type).toBe("too_large");
  });

  it("'합계'를 물으면 기업이 2곳 이상일 때 aggregate: sum (PRD F-N3)", async () => {
    const { client } = createFakeCompaniesClient([SK_HYNIX, HYUNDAI_MOTOR]);
    const sumOp = { op: "sum" as const, metric: "revenue" as const, base: null, peers: null };
    const two = await validateAnalysisRequest(
      baseAiRequest({
        companies: [
          { query: "SK하이닉스", role: "target" },
          { query: "현대차", role: "peer" },
        ],
        operations: [sumOp],
      }),
      { client },
    );
    expect(two.type === "resolved" && two.request.aggregate).toBe("sum");

    const one = await validateAnalysisRequest(baseAiRequest({ operations: [sumOp] }), { client });
    expect(one.type === "resolved" && one.request.aggregate).toBeUndefined();
  });

  it("대상 표시 없는 'A와 B 합계'에서 같은 기업을 두 번 더하지 않는다", async () => {
    const { client } = createFakeCompaniesClient([SK_HYNIX, HYUNDAI_MOTOR]);
    const result = await validateAnalysisRequest(
      baseAiRequest({
        companies: [
          { query: "SK하이닉스", role: "peer" },
          { query: "현대차", role: "peer" },
        ],
        operations: [{ op: "sum", metric: "revenue", base: null, peers: null }],
      }),
      { client },
    );
    expect(result.type).toBe("resolved");
    if (result.type !== "resolved") return;
    expect(result.request.target.name).toBe("SK하이닉스");
    expect(result.request.peers.map((p) => p.name)).toEqual(["현대자동차"]);
    expect(result.request.aggregate).toBe("sum");
  });

  it("AI가 두 기업을 모두 대상(target)으로 내도 두 번째 기업을 빠뜨리지 않는다 (합계 실측)", async () => {
    const { client } = createFakeCompaniesClient([SK_HYNIX, HYUNDAI_MOTOR]);
    const result = await validateAnalysisRequest(
      baseAiRequest({
        companies: [
          { query: "SK하이닉스", role: "target" },
          { query: "현대차", role: "target" },
        ],
        operations: [{ op: "sum", metric: "revenue", base: null, peers: null }],
      }),
      { client },
    );
    expect(result.type === "resolved" && result.request.peers.map((p) => p.name)).toEqual([
      "현대자동차",
    ]);
    expect(result.type === "resolved" && result.request.aggregate).toBe("sum");
  });

  it("대상 표시 없이 6곳을 물으면 초과가 아니다 (첫 기업이 대상, 나머지 5곳이 비교)", async () => {
    const { client } = createFakeCompaniesClient([SK_HYNIX]);
    const names = ["SK하이닉스", "A", "B", "C", "D", "E"];
    const result = await validateAnalysisRequest(
      baseAiRequest({ companies: names.map((query) => ({ query, role: "peer" as const })) }),
      { client },
    );
    expect(result.type).not.toBe("too_large");
  });

  it("합계에 넣을 기업을 못 찾으면 빼고 더하지 않고 다시 물어 달라고 안내한다", async () => {
    const { client } = createFakeCompaniesClient([SK_HYNIX]);
    const result = await validateAnalysisRequest(
      baseAiRequest({
        companies: [
          { query: "SK하이닉스", role: "target" },
          { query: "없는회사", role: "peer" },
        ],
        operations: [{ op: "sum", metric: "revenue", base: null, peers: null }],
      }),
      { client },
    );
    expect(result.type).toBe("unsupported_question");
    if (result.type === "unsupported_question") expect(result.message).toContain("없는회사");
  });

  it("'2013년 매출'은 기간 밖", async () => {
    const { client } = createFakeCompaniesClient([SK_HYNIX]);
    const result = await validateAnalysisRequest(
      baseAiRequest({ period: { specified: true, from: null, to: null, text: "2013년" } }),
      { client },
    );
    expect(result.type).toBe("out_of_range");
    if (result.type === "out_of_range") expect(result.message).toContain("2016년 1분기");
  });
});
