// 투자 리포트 — 최근 사업연도 재무 (사업보고서 5개 + 가장 최근 정기보고서 1개).
// 분기 엔진(report_values)은 표준 계정 8개만 저장한다. 리포트에는 현금흐름·유동비율·EPS가 더 필요해,
// 같은 원문(fnlttSinglAcntAll)에서 **리포트용 계정**을 뽑아 `report_extras`에 보고서마다 한 행(jsonb)으로 둔다.
// 값을 찾은 보고서는 다시 부르지 않고, "아직 없음"(013)은 하루 뒤 다시 확인한다(제출 전 보고서).
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { dartFetch, type DartEnvelope } from "@/lib/dart/client";
import {
  loadAccountMap,
  matchAccountValue,
  type AccountMapRow,
} from "@/lib/financials/account-map";
import { parseAmount } from "@/lib/financials/amounts";
import { dartBsnsYear } from "@/lib/financials/period";
import {
  STANDARD_METRICS,
  type DartFinancialStatementItem,
  type FsDiv,
  type ReprtCode,
} from "@/lib/financials/types";
import { createConcurrencyGate } from "@/lib/quota/concurrency";

/** 리포트가 쓰는 계정 — 표준 8개 + 현금흐름·유동성·주당 */
export const EXTRA_METRICS = [
  "current_assets",
  "current_liabilities",
  "cash",
  "operating_cash_flow",
  "capex_tangible",
  "capex_intangible",
  "dividends_paid",
  "eps",
] as const;
export type ExtraMetric = (typeof EXTRA_METRICS)[number];
export type ReportMetric = (typeof STANDARD_METRICS)[number] | ExtraMetric;

/** 표준 계정 ID 먼저, 없으면 계정명(띄어쓰기 무시) */
const EXTRA_ACCOUNTS: Record<ExtraMetric, { divs: string[]; ids: string[]; names: RegExp }> = {
  current_assets: { divs: ["BS"], ids: ["ifrs-full_CurrentAssets"], names: /^유동자산$/ },
  current_liabilities: { divs: ["BS"], ids: ["ifrs-full_CurrentLiabilities"], names: /^유동부채$/ },
  cash: { divs: ["BS"], ids: ["ifrs-full_CashAndCashEquivalents"], names: /^현금및현금성자산$/ },
  operating_cash_flow: {
    divs: ["CF"],
    ids: ["ifrs-full_CashFlowsFromUsedInOperatingActivities"],
    names: /^영업활동(으로인한)?현금흐름$/,
  },
  capex_tangible: {
    divs: ["CF"],
    ids: ["ifrs-full_PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities"],
    names: /^유형자산의취득$/,
  },
  capex_intangible: {
    divs: ["CF"],
    ids: ["ifrs-full_PurchaseOfIntangibleAssetsClassifiedAsInvestingActivities"],
    names: /^무형자산의취득$/,
  },
  dividends_paid: {
    divs: ["CF"],
    ids: ["ifrs-full_DividendsPaidClassifiedAsFinancingActivities"],
    names: /^배당금의?지급$/,
  },
  eps: { divs: ["IS", "CIS"], ids: ["ifrs-full_BasicEarningsLossPerShare"], names: /^기본주당/ },
};

/** 보고서 하나에서 뽑은 값 (원 단위 정수 글자, EPS는 원). 없는 계정은 빠진다 */
export type ReportValues = Partial<Record<ReportMetric, string>>;

export interface AnnualReport {
  /** 회계연도 (시작한 해) */
  fiscalYear: number;
  bsnsYear: number;
  reprtCode: ReprtCode;
  fsDiv: FsDiv;
  rceptNo: string;
  values: ReportValues;
}

export interface AnnualFinancials {
  /** 사업보고서 — 회계연도 오름차순, 제출된 것만 */
  annual: AnnualReport[];
  /** 가장 최근 정기보고서 (재무상태표 시점 값용 — 유동비율 등). 사업보고서가 가장 최근이면 그것 */
  latest: AnnualReport | null;
  externalCalls: number;
}

export interface LoadAnnualOptions {
  client: SupabaseClient;
  userId?: string | null;
  analysisId?: string | null;
  now?: () => Date;
  /** 사업보고서 몇 개 (기본 5) */
  years?: number;
}

const RECHECK_EMPTY_MS = 24 * 60 * 60 * 1000;
const CONCURRENCY = 4;

interface StatementResponse extends DartEnvelope {
  list?: DartFinancialStatementItem[];
}

interface ExtrasRow {
  bsns_year: number;
  reprt_code: ReprtCode;
  fs_div: FsDiv | null;
  rcept_no: string | null;
  values: ReportValues;
  fetched_at: string;
}

/**
 * 최근 사업보고서 `years`개와 그 뒤 가장 최근 정기보고서. 회계연도는 지금 연도부터 거슬러 올라가며 찾는다
 * (아직 안 낸 해는 013 → 건너뜀). 12월 외 결산도 `dartBsnsYear`로 OpenDART 연도를 맞춘다.
 */
export async function loadAnnualFinancials(
  corpCode: string,
  accMt: number,
  options: LoadAnnualOptions,
): Promise<AnnualFinancials> {
  const now = options.now?.() ?? new Date();
  const years = options.years ?? 5;
  const thisYear = now.getUTCFullYear();
  // 사업보고서: 올해 회계연도는 아직 끝나지 않았다 — 작년부터 years+1개(작년 것이 아직 안 나왔을 수 있다)
  const annualRefs = Array.from({ length: years + 1 }, (_, i) => {
    const fiscalYear = thisYear - 1 - i;
    return {
      fiscalYear,
      bsnsYear: dartBsnsYear(fiscalYear, 4, accMt),
      reprtCode: "11011" as const,
    };
  });
  // 올해 회계연도의 분기 보고서 (최근 것부터) — 유동비율 등 최신 재무상태표
  const periodicRefs = (["11014", "11012", "11013"] as const).map((reprtCode) => {
    const q = reprtCode === "11014" ? 3 : reprtCode === "11012" ? 2 : 1;
    return { fiscalYear: thisYear, bsnsYear: dartBsnsYear(thisYear, q, accMt), reprtCode };
  });
  const refs = [...periodicRefs, ...annualRefs];

  const cached = await readExtras(options.client, corpCode);
  const accountMap = await loadAccountMap(options.client);
  const gate = createConcurrencyGate(CONCURRENCY);
  let externalCalls = 0;

  const loaded = await Promise.all(
    refs.map((ref) =>
      gate.run(async (): Promise<AnnualReport | null> => {
        const hit = cached.get(`${ref.bsnsYear}|${ref.reprtCode}`);
        const fresh =
          hit &&
          (hit.fs_div !== null || now.getTime() - Date.parse(hit.fetched_at) < RECHECK_EMPTY_MS);
        let row = fresh ? hit : null;
        if (!row) {
          const fetched = await fetchExtras(
            corpCode,
            ref.bsnsYear,
            ref.reprtCode,
            accountMap,
            options,
          );
          externalCalls += fetched.calls;
          row = { ...fetched.row, fetched_at: now.toISOString() };
          await writeExtras(options.client, corpCode, row);
        }
        if (!row.fs_div || !row.rcept_no) return null;
        return {
          fiscalYear: ref.fiscalYear,
          bsnsYear: ref.bsnsYear,
          reprtCode: ref.reprtCode,
          fsDiv: row.fs_div,
          rceptNo: row.rcept_no,
          values: row.values,
        };
      }),
    ),
  );

  const periodic = loaded
    .slice(0, periodicRefs.length)
    .filter((r): r is AnnualReport => r !== null);
  const annual = loaded
    .slice(periodicRefs.length)
    .filter((r): r is AnnualReport => r !== null)
    .sort((a, b) => a.fiscalYear - b.fiscalYear)
    .slice(-years);
  // periodicRefs가 최근 순이라 첫 번째가 가장 최근 분기 보고서
  const latest = periodic[0] ?? annual.at(-1) ?? null;
  return { annual, latest, externalCalls };
}

async function fetchExtras(
  corpCode: string,
  bsnsYear: number,
  reprtCode: ReprtCode,
  accountMap: AccountMapRow[],
  options: LoadAnnualOptions,
): Promise<{ row: Omit<ExtrasRow, "fetched_at">; calls: number }> {
  let calls = 0;
  for (const fsDiv of ["CFS", "OFS"] as const) {
    calls += 1;
    const res = await dartFetch<StatementResponse>(
      "fnlttSinglAcntAll.json",
      { corp_code: corpCode, bsns_year: bsnsYear, reprt_code: reprtCode, fs_div: fsDiv },
      {
        userId: options.userId ?? null,
        analysisId: options.analysisId ?? null,
        client: options.client,
      },
    );
    if (res.status === "013" || !res.list?.length) continue;
    return {
      row: {
        bsns_year: bsnsYear,
        reprt_code: reprtCode,
        fs_div: fsDiv,
        rcept_no: res.list[0].rcept_no,
        values: extractValues(res.list, accountMap),
      },
      calls,
    };
  }
  return {
    row: { bsns_year: bsnsYear, reprt_code: reprtCode, fs_div: null, rcept_no: null, values: {} },
    calls,
  };
}

/** 원문 항목 → 리포트용 값. 손익·현금흐름은 그 보고서의 당기 값(분기 보고서면 누적이 아니라 thstrm_amount) */
export function extractValues(
  items: DartFinancialStatementItem[],
  accountMap: AccountMapRow[],
): ReportValues {
  const values: ReportValues = {};
  for (const metric of STANDARD_METRICS) {
    const match = matchAccountValue(items, accountMap, metric);
    const amount = match ? safeAmount(amountOf(match.item)) : null;
    if (amount !== null) values[metric] = amount;
  }
  for (const metric of EXTRA_METRICS) {
    const spec = EXTRA_ACCOUNTS[metric];
    const scoped = items.filter((i) => spec.divs.includes(i.sj_div));
    const item =
      scoped.find((i) => spec.ids.includes(i.account_id)) ??
      scoped.find((i) => spec.names.test(i.account_nm.replace(/\s/g, "")));
    const amount = item ? safeAmount(amountOf(item)) : null;
    if (amount !== null) values[metric] = amount;
  }
  return values;
}

/** 금액 모양이 아니면(드물게 "1,234"·"-") 그 계정만 없는 것으로 — 리포트 전체를 멈추지 않는다 */
function safeAmount(raw: string | undefined): string | null {
  try {
    return parseAmount(raw);
  } catch {
    return null;
  }
}

/** 분기·반기 손익은 누적(thstrm_add_amount)이 있으면 누적을 쓴다 — 현금흐름표는 원래 누적이다 */
function amountOf(item: DartFinancialStatementItem): string | undefined {
  if ((item.sj_div === "IS" || item.sj_div === "CIS") && item.thstrm_add_amount) {
    return item.thstrm_add_amount;
  }
  return item.thstrm_amount;
}

async function readExtras(
  client: SupabaseClient,
  corpCode: string,
): Promise<Map<string, ExtrasRow>> {
  const { data, error } = await client
    .from("report_extras")
    .select("bsns_year, reprt_code, fs_div, rcept_no, values, fetched_at")
    .eq("corp_code", corpCode);
  if (error) {
    warnOnce(`[report] report_extras 조회 실패 — 캐시 없이 진행: ${error.message}`);
    return new Map();
  }
  return new Map(((data ?? []) as ExtrasRow[]).map((r) => [`${r.bsns_year}|${r.reprt_code}`, r]));
}

async function writeExtras(client: SupabaseClient, corpCode: string, row: ExtrasRow) {
  const { error } = await client
    .from("report_extras")
    .upsert([{ corp_code: corpCode, ...row }], { onConflict: "corp_code,bsns_year,reprt_code" });
  if (error) warnOnce(`[report] report_extras 저장 실패: ${error.message}`);
}

let warned = false;
function warnOnce(message: string) {
  if (warned) return;
  warned = true;
  console.warn(message);
}
