import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompanyRef } from "@/contracts";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { canonicalCompanyName } from "./aliases";
import {
  COMPANY_SELECT_COLUMNS,
  type CompanyRow,
  escapeIlikePattern,
  rankCompanyRowsByRelevance,
  spaceInsensitivePattern,
  toCompanyRef,
} from "./row";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 10;
// 랭킹에서 밀려나는 기업까지 고려해 요청 limit보다 넉넉히 가져온 뒤 앱에서 자른다.
const FETCH_MULTIPLIER = 3;

export interface SearchCompaniesOptions {
  /** 테스트에서 가짜 Supabase 클라이언트를 주입할 때만 쓴다. */
  client?: SupabaseClient;
}

/**
 * 이름 자동완성 (WU-103, API_SPEC S1 `GET /api/search?q=`). DB(`companies`)만 조회한다 —
 * **외부 호출 0건**.
 */
export async function searchCompanies(
  query: string,
  limit = DEFAULT_LIMIT,
  options: SearchCompaniesOptions = {},
): Promise<CompanyRef[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const boundedLimit = Math.min(Math.max(Math.trunc(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const admin = options.client ?? getSupabaseAdmin();

  const find = async (text: string) => {
    const { data, error } = await admin
      .from("companies")
      .select(COMPANY_SELECT_COLUMNS)
      .ilike("corp_name", `%${escapeIlikePattern(text)}%`)
      .order("corp_name", { ascending: true })
      .limit(boundedLimit * FETCH_MULTIPLIER);
    if (error) throw new Error(`기업 검색 실패: ${error.message}`);
    const rows = (data ?? []) as unknown as CompanyRow[];
    if (rows.length > 0 || !text.replace(/\s+/g, "")) return rows;
    // 그대로는 없으면 띄어쓰기를 무시하고 다시 ("SK 하이닉스" → SK하이닉스, "CJENM" → CJ ENM)
    const spaceless = await admin
      .from("companies")
      .select(COMPANY_SELECT_COLUMNS)
      .filter("corp_name", "imatch", spaceInsensitivePattern(text))
      .order("corp_name", { ascending: true })
      .limit(boundedLimit * FETCH_MULTIPLIER);
    if (spaceless.error) throw new Error(`기업 검색 실패: ${spaceless.error.message}`);
    return (spaceless.data ?? []) as unknown as CompanyRow[];
  };

  // 종목코드(6자리)면 코드가 같은 기업 (Phase 4 통합: 보드가 비교 기업 칩 이름을 종목코드로 찾는다 — STEP4_PASS_TEST §1.2 #2,
  // 입력창 안내 "이름이나 종목코드로 찾기")
  if (/^[0-9A-Z]{6}$/.test(trimmed)) {
    const { data, error } = await admin
      .from("companies")
      .select(COMPANY_SELECT_COLUMNS)
      .eq("stock_code", trimmed)
      .limit(1);
    if (error) throw new Error(`기업 검색 실패: ${error.message}`);
    const byCode = ((data ?? []) as unknown as CompanyRow[])
      .map(toCompanyRef)
      .filter((company): company is CompanyRef => company !== null);
    if (byCode.length > 0) return byCode;
  }

  // 줄임말("현대차")이면 정식 이름(현대자동차)을 맨 앞에 — 이름에 "현대차"가 든 현대차증권만 뜨지 않게
  const canonical = canonicalCompanyName(trimmed);
  const rows = await find(trimmed);
  if (canonical !== trimmed) {
    const preferred = rankCompanyRowsByRelevance(await find(canonical), canonical);
    const seen = new Set(preferred.map((r) => r.corp_code));
    return [
      ...preferred,
      ...rankCompanyRowsByRelevance(rows, trimmed).filter((r) => !seen.has(r.corp_code)),
    ]
      .map(toCompanyRef)
      .filter((company): company is CompanyRef => company !== null)
      .slice(0, boundedLimit);
  }
  return rankCompanyRowsByRelevance(rows, trimmed)
    .map(toCompanyRef)
    .filter((company): company is CompanyRef => company !== null)
    .slice(0, boundedLimit);
}
