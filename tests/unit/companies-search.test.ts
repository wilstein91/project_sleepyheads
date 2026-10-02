import { describe, expect, it, vi } from "vitest";
import { searchCompanies } from "@/lib/companies/search";
import type { CompanyRow } from "@/lib/companies/row";
import { createFakeCompaniesClient } from "./helpers/fake-companies-table";

function company(
  overrides: Partial<CompanyRow> & { corp_name: string; stock_code: string },
): CompanyRow {
  return {
    corp_code: `code-${overrides.stock_code}`,
    market: "KOSPI",
    acc_mt: 12,
    sector_source: "manual",
    sectors: { name: "기타", is_financial: false },
    ...overrides,
  };
}

const ROWS: CompanyRow[] = [
  company({ corp_name: "삼성전자", stock_code: "005930" }),
  company({ corp_name: "삼성SDI", stock_code: "006400" }),
  company({ corp_name: "삼성물산", stock_code: "028260" }),
  company({ corp_name: "SK하이닉스", stock_code: "000660" }),
  company({
    corp_name: "미확정기업",
    stock_code: "111111",
    market: null,
    acc_mt: null,
    sector_source: null,
    sectors: null,
  }),
];

describe("searchCompanies (WU-103, API_SPEC S1)", () => {
  it("6자리 종목코드로도 찾는다 — 보드 비교 기업 칩이 숫자 대신 이름 (Phase 4 통합)", async () => {
    const { client } = createFakeCompaniesClient(ROWS);
    const result = await searchCompanies("000660", 10, { client });
    expect(result.map((c) => c.name)).toEqual(["SK하이닉스"]);
    // 개황이 아직 없는 기업은 코드로도 나오지 않는다 (이름 검색과 같은 규칙)
    expect(await searchCompanies("111111", 10, { client })).toEqual([]);
  });

  it("이름이 포함된 기업을 자동완성으로 돌려준다", async () => {
    const { client } = createFakeCompaniesClient(ROWS);
    const result = await searchCompanies("삼성", 10, { client });
    expect(result.map((c) => c.name).sort()).toEqual(["삼성SDI", "삼성물산", "삼성전자"]);
  });

  it("완전히 같음 > 접두어 > 부분일치 순으로 정렬한다", async () => {
    const { client } = createFakeCompaniesClient(ROWS);
    const result = await searchCompanies("삼성전자", 10, { client });
    expect(result[0].name).toBe("삼성전자");
  });

  it("limit은 최대 10으로 잘린다", async () => {
    const many = Array.from({ length: 15 }, (_, i) =>
      company({ corp_name: `테스트기업${i}`, stock_code: String(100000 + i) }),
    );
    const { client } = createFakeCompaniesClient(many);
    const result = await searchCompanies("테스트기업", 50, { client });
    expect(result).toHaveLength(10);
  });

  it("띄어쓰기가 달라도 찾는다 — 'SK 하이닉스' → SK하이닉스", async () => {
    const { client } = createFakeCompaniesClient(ROWS);
    const result = await searchCompanies("SK 하이닉스", 10, { client });
    expect(result.map((c) => c.name)).toContain("SK하이닉스");
  });

  it("빈 질의는 조회 없이 빈 배열", async () => {
    const { client } = createFakeCompaniesClient(ROWS);
    const result = await searchCompanies("   ", 10, { client });
    expect(result).toEqual([]);
  });

  it("아직 기업개황이 채워지지 않은 기업은 검색 결과에서 뺀다", async () => {
    const { client } = createFakeCompaniesClient(ROWS);
    const result = await searchCompanies("미확정", 10, { client });
    expect(result).toEqual([]);
  });

  it("외부 API 호출 없이 DB만 조회한다", async () => {
    const { client } = createFakeCompaniesClient(ROWS);
    const fetchSpy = vi.spyOn(global, "fetch");
    await searchCompanies("삼성", 10, { client });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

// 2026-09-30: 보드 비교 기업 찾기에서 "현대차"를 치면 현대차증권만 뜨던 문제 (줄임말 표 COMPANY_ALIASES)
describe("searchCompanies — 줄임말", () => {
  it("'현대차'는 정식 이름 현대자동차를 맨 앞에, 이름에 '현대차'가 든 기업은 그 뒤에", async () => {
    const { client } = createFakeCompaniesClient([
      company({ corp_name: "현대자동차", stock_code: "005380" }),
      company({ corp_name: "현대차증권", stock_code: "001500" }),
      company({ corp_name: "현대건설", stock_code: "000720" }),
    ]);
    const result = await searchCompanies("현대차", 10, { client });
    expect(result.map((c) => c.name)).toEqual(["현대자동차", "현대차증권"]);
  });
});
