import { vi } from "vitest";
import type { CompanyRow } from "@/lib/companies/row";

/**
 * `companies` 테이블(+ 임베드된 `sectors`)만 흉내 내는 가짜 Supabase 클라이언트.
 * `resolveCompany`·`searchCompanies`가 실제로 쓰는 체인(`select→eq/ilike/filter(imatch)→order→limit→maybeSingle`)만
 * 지원한다. ILIKE 패턴은 정규식으로 바꿔 메모리 배열을 그대로 필터링한다.
 */
export function createFakeCompaniesClient(rows: CompanyRow[]) {
  const from = vi.fn(() => makeBuilder(rows));
  return { client: { from } as unknown as import("@supabase/supabase-js").SupabaseClient };
}

function makeBuilder(allRows: CompanyRow[]) {
  let rows = allRows;

  const builder = {
    select: () => builder,
    eq: (column: keyof CompanyRow, value: unknown) => {
      rows = rows.filter((row) => row[column] === value);
      return builder;
    },
    in: (column: keyof CompanyRow, values: unknown[]) => {
      rows = rows.filter((row) => values.includes(row[column]));
      return builder;
    },
    ilike: (column: keyof CompanyRow, pattern: string) => {
      const regex = ilikePatternToRegExp(pattern);
      rows = rows.filter((row) => regex.test(String(row[column] ?? "")));
      return builder;
    },
    // PostgREST 정규식 필터 (`imatch` = Postgres `~*`). 띄어쓰기 무시 검색이 쓰는 `\s*`는 JS 정규식과 같다
    filter: (column: keyof CompanyRow, operator: string, pattern: string) => {
      if (operator !== "imatch") throw new Error(`지원하지 않는 필터: ${operator}`);
      const regex = new RegExp(pattern, "i");
      rows = rows.filter((row) => regex.test(String(row[column] ?? "")));
      return builder;
    },
    order: (column: keyof CompanyRow, opts: { ascending?: boolean } = {}) => {
      const sign = opts.ascending === false ? -1 : 1;
      rows = [...rows].sort((a, b) => sign * String(a[column]).localeCompare(String(b[column])));
      return builder;
    },
    limit: (count: number) => {
      rows = rows.slice(0, count);
      return builder;
    },
    maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
    then: (resolve: (result: { data: CompanyRow[]; error: null }) => void) =>
      resolve({ data: rows, error: null }),
  };

  return builder;
}

function ilikePatternToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "\\" && i + 1 < pattern.length) {
      i += 1;
      out += escapeRegExpChar(pattern[i]);
    } else if (char === "%") {
      out += ".*";
    } else if (char === "_") {
      out += ".";
    } else {
      out += escapeRegExpChar(char);
    }
  }
  return new RegExp(`^${out}$`, "i");
}

function escapeRegExpChar(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
