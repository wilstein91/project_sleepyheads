import { describe, expect, it } from "vitest";
import { canonicalCompanyName, resolveCompany } from "@/lib/companies/resolve";
import type { CompanyRow } from "@/lib/companies/row";
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

const SAMSUNG: CompanyRow = {
  corp_code: "00126380",
  stock_code: "005930",
  corp_name: "삼성전자",
  market: "KOSPI",
  acc_mt: 12,
  sector_source: "induty_code",
  sectors: SEMICONDUCTOR,
};

const SAMSUNG_PREFERRED: CompanyRow = {
  corp_code: "00126381",
  stock_code: "005935",
  corp_name: "삼성전자우",
  market: "KOSPI",
  acc_mt: 12,
  sector_source: "induty_code",
  sectors: SEMICONDUCTOR,
};

const HYUNDAI_MOTOR: CompanyRow = {
  corp_code: "00164742",
  stock_code: "005380",
  // 운영 DB의 정식 이름 (2026-09-30 확인 — 예전 가짜 데이터는 "현대차"였다)
  corp_name: "현대자동차",
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

/** WU-104(기업개황)가 아직 채우지 않은 기업 — market·섹터·결산월이 없다. */
const NOT_YET_ENRICHED: CompanyRow = {
  corp_code: "00999999",
  stock_code: "999999",
  corp_name: "새싹기업",
  market: null,
  acc_mt: null,
  sector_source: null,
  sectors: null,
};

const ALL_ROWS = [
  SK_HYNIX,
  SAMSUNG,
  SAMSUNG_PREFERRED,
  HYUNDAI_MOTOR,
  HYUNDAI_ENGINEERING,
  NOT_YET_ENRICHED,
];

describe("resolveCompany (WU-103, TECH §4.4)", () => {
  it("6자리 종목코드는 정확히 확정한다 — 005930 → 삼성전자", async () => {
    const { client } = createFakeCompaniesClient(ALL_ROWS);
    const result = await resolveCompany("005930", { client });
    expect(result).toEqual({
      type: "resolved",
      company: expect.objectContaining({ name: "삼성전자" }),
    });
  });

  it("흔한 줄임말(부분일치)이 하나뿐이면 확정한다 — 하이닉스 → SK하이닉스", async () => {
    const { client } = createFakeCompaniesClient(ALL_ROWS);
    const result = await resolveCompany("하이닉스", { client });
    expect(result).toEqual({
      type: "resolved",
      company: expect.objectContaining({ name: "SK하이닉스" }),
    });
  });

  it("후보가 여럿이면 후보 목록을 돌려준다 — 현대", async () => {
    const { client } = createFakeCompaniesClient(ALL_ROWS);
    const result = await resolveCompany("현대", { client });
    expect(result.type).toBe("candidates");
    if (result.type === "candidates") {
      expect(result.candidates.map((c) => c.name).sort()).toEqual(["현대건설", "현대자동차"]);
    }
  });

  it("정확히 일치하는 이름이 있으면 부분일치로 더 걸리더라도 그것만 확정한다 — 삼성전자", async () => {
    const { client } = createFakeCompaniesClient(ALL_ROWS);
    const result = await resolveCompany("삼성전자", { client });
    expect(result).toEqual({
      type: "resolved",
      company: expect.objectContaining({ name: "삼성전자", stockCode: "005930" }),
    });
  });

  it("띄어쓰기·대소문자가 달라도 같은 이름이면 확정한다 — 'SK 하이닉스'·'sk 하이닉스' → SK하이닉스", async () => {
    const { client } = createFakeCompaniesClient(ALL_ROWS);
    for (const query of ["SK 하이닉스", "sk 하이닉스", "S K하이 닉스"]) {
      expect(await resolveCompany(query, { client })).toEqual({
        type: "resolved",
        company: expect.objectContaining({ name: "SK하이닉스" }),
      });
    }
  });

  it("정식 이름에 띄어쓰기가 있어도 붙여 쓴 입력으로 찾는다 — 'CJENM' → CJ ENM", async () => {
    const cjEnm: CompanyRow = {
      ...SAMSUNG,
      corp_code: "00265324",
      stock_code: "035760",
      corp_name: "CJ ENM",
      sectors: { name: "미디어", is_financial: false },
    };
    const { client } = createFakeCompaniesClient([...ALL_ROWS, cjEnm]);
    expect(await resolveCompany("CJENM", { client })).toEqual({
      type: "resolved",
      company: expect.objectContaining({ name: "CJ ENM" }),
    });
  });

  it("띄어쓰기 무시 검색도 정규식 특수문자는 글자 그대로 — 'S.K하이닉스'는 not_found", async () => {
    const { client } = createFakeCompaniesClient(ALL_ROWS);
    expect(await resolveCompany("S.K하이닉스", { client })).toEqual({ type: "not_found" });
  });

  it("존재하지 않는 이름은 not_found", async () => {
    const { client } = createFakeCompaniesClient(ALL_ROWS);
    const result = await resolveCompany("존재하지않는기업이름", { client });
    expect(result).toEqual({ type: "not_found" });
  });

  it("존재하지 않는 종목코드는 not_found", async () => {
    const { client } = createFakeCompaniesClient(ALL_ROWS);
    const result = await resolveCompany("123456", { client });
    expect(result).toEqual({ type: "not_found" });
  });

  it("아직 기업개황이 채워지지 않은 기업은 확정하지 않는다(not_found)", async () => {
    const { client } = createFakeCompaniesClient(ALL_ROWS);
    const result = await resolveCompany("새싹기업", { client });
    expect(result).toEqual({ type: "not_found" });
  });

  it("빈 문자열은 외부 조회 없이 not_found", async () => {
    const { client } = createFakeCompaniesClient(ALL_ROWS);
    const result = await resolveCompany("   ", { client });
    expect(result).toEqual({ type: "not_found" });
  });
});

// 2026-09-30 실제 API: "현대차 최근 4분기 매출과 영업이익" → 이름에 "현대차"가 든 현대차증권만 걸려 그대로 확정되던 버그
describe("자주 쓰는 줄임말 (COMPANY_ALIASES)", () => {
  const HYUNDAI_SECURITIES: CompanyRow = {
    corp_code: "00137997",
    stock_code: "001500",
    corp_name: "현대차증권",
    market: "KOSPI",
    acc_mt: 12,
    sector_source: "induty_code",
    sectors: { name: "증권", is_financial: true },
  };

  it("'현대차'는 현대차증권이 아니라 현대자동차", async () => {
    const { client } = createFakeCompaniesClient([...ALL_ROWS, HYUNDAI_SECURITIES]);
    const result = await resolveCompany("현대차", { client });
    expect(result).toMatchObject({ type: "resolved", company: { name: "현대자동차" } });
  });

  it("줄임말은 띄어쓰기·대소문자를 무시하고, 줄임말이 아니면 그대로", () => {
    expect(canonicalCompanyName("현대 차")).toBe("현대자동차");
    expect(canonicalCompanyName("SKT")).toBe("SK텔레콤");
    expect(canonicalCompanyName("하이닉스")).toBe("SK하이닉스");
    expect(canonicalCompanyName("현대차증권")).toBe("현대차증권");
  });
});
