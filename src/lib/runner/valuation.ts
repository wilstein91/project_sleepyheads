// WU-502 주가 지표 (시가총액·PER·PBR, TECH §6.4·§6.6) — 재무 계산 결과에 주가를 결합해 카드(기업 하나) 또는
// 표(여러 기업)를 만든다. 순서: 기업마다 기준 분기 → 주가 기준일·가격 → 결합 검사(`price/join.ts`) → 계산(`formulas.ts`).
// 데이터 버전에는 주가 기준일이 들어간다(`DataVersionContent.priceDate`) — 재실행은 그날 가격(저장된 것)으로 다시 계산한다.
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Chart, CompanyRef, MetricId, PeriodRange, Quarter, Series } from "@/contracts";
import {
  addQuarters,
  compareQuarters,
  latestAvailableQuarter,
  quarterDateRange,
} from "@/lib/ask/quarter";
import type { FsDiv } from "@/lib/financials/types";
import { marketCap, pbr as computePbr, per as computePer } from "@/lib/metrics/formulas";
import type { Computed } from "@/lib/metrics/types";
import { loadPrices, type LoadedPrices, type PriceWindow } from "@/lib/price/daily";
import {
  joinFinancialsWithPrices,
  type JoinCounts,
  type ListingRow,
  type PriceRow,
} from "@/lib/price/join";
import type { CompanyFinancials } from "./company-financials";
import type { FigureAllocator } from "./figures";
import { reportBasis } from "./series-builders";

export const PRICE_METRICS: readonly MetricId[] = ["market_cap", "per", "pbr"];

export function isPriceMetric(metric: MetricId): boolean {
  return PRICE_METRICS.includes(metric);
}

/** 화면 ⓘ·표 주석에 쓰는 계산식 (TECH §6.4 글자 그대로) */
export const VALUATION_FORMULAS = {
  market_cap: "시가총액 = 기준일 종가 × 상장주식수 (보통주만)",
  per: "PER = 시가총액 ÷ TTM 지배주주 순이익 (최근 4개 분기 합, 0 이하면 적자)",
  pbr: "PBR = 시가총액 ÷ 최근 분기말 지배주주지분 (0 이하면 자본잠식)",
} as const;

export const PRICE_SOURCE = "금융위원회_주식시세정보(공공데이터포털)";

/** 주가 API 오류로 주가 지표를 비웠을 때 분석 기준 한 줄 */
export const PRICE_UNAVAILABLE_FLAG =
  "주가를 받지 못해 시가총액·PER·PBR을 계산하지 못했습니다 — 잠시 후 다시 시도해 주세요";

interface ValuationInputRow {
  corpCode: string;
  stockCode: string;
  name: string;
  company: CompanyRef;
  /** 재무 쪽 기준 분기 (TTM의 마지막 분기·지배주주지분 분기말) */
  quarter: Quarter;
  report: string;
  fsDiv: FsDiv;
  ttm: Computed<bigint>;
  ownersEquity: Computed<bigint>;
}

export interface PreparedValuation {
  /** 결합 기준일 ("2026-09-30") — 가격이 하나도 없으면 null */
  priceDate: string | null;
  rows: {
    input: ValuationInputRow;
    price: PriceRow | null;
    cap: Computed<bigint>;
    per: Computed<number>;
    pbr: Computed<number>;
  }[];
  /** 결합 중단 경고 (`result.basis.flags`에 그대로) */
  warnings: string[];
  counts: JoinCounts;
  externalCalls: number;
}

export interface PrepareValuationInput {
  companies: readonly CompanyRef[];
  financialsByCorp: ReadonlyMap<string, CompanyFinancials>;
  /** 기업 → 기준 분기 (요청 범위 안에서 보고서가 있는 가장 최근 분기) */
  quarterByCorp: ReadonlyMap<string, Quarter>;
  period: PeriodRange;
  /** 재실행: 저장된 데이터 버전의 주가 기준일 — 그날 가격으로만 계산한다 */
  priceDate?: string | null;
  client: SupabaseClient;
  userId?: string | null;
  analysisId?: string | null;
  now?: () => Date;
}

/**
 * 주가 기준일 (TECH §6.6): 요청 범위 끝이 지금 쓸 수 있는 최신 분기면 조회 시점의 가장 최근 거래일,
 * 더 옛날이면 그 분기말 이전 마지막 거래일. 재실행은 저장된 날짜.
 */
export function priceWindowFor(
  period: PeriodRange,
  priceDate: string | null | undefined,
  now: Date,
): PriceWindow {
  if (priceDate) return { kind: "asOf", date: priceDate };
  if (compareQuarters(period.to, latestAvailableQuarter(now)) >= 0) return { kind: "latest" };
  return { kind: "asOf", date: quarterDateRange(period.to).to };
}

export async function prepareValuation(input: PrepareValuationInput): Promise<PreparedValuation> {
  const now = input.now?.() ?? new Date();
  const rows: ValuationInputRow[] = input.companies.map((company) => {
    const financials = input.financialsByCorp.get(company.corpCode)!;
    const quarter = input.quarterByCorp.get(company.corpCode) ?? input.period.to;
    const anyRow = [...financials.metricsByQuarter.values()][0];
    return {
      corpCode: company.corpCode,
      stockCode: company.stockCode,
      name: company.name,
      company,
      quarter,
      report: reportBasis(quarter, financials),
      fsDiv: financials.metricsByQuarter.get(quarter)?.fs_div ?? anyRow?.fs_div ?? "CFS",
      ttm: valueAt(financials, quarter, "ttm_owners_ni"),
      ownersEquity: valueAt(financials, quarter, "owners_equity"),
    };
  });

  const window = priceWindowFor(input.period, input.priceDate, now);
  // 주가 API가 안 되면(키·한도·점검) 재무 숫자까지 잃지 않게 주가 지표만 비운다 (TECH §6.6 "가격이 없으면 NO_PRICE")
  const priceWarnings: string[] = [];
  const [loaded, listings] = await Promise.all([
    loadPrices(
      rows.map((r) => r.stockCode),
      window,
      {
        client: input.client,
        userId: input.userId ?? null,
        analysisId: input.analysisId ?? null,
        now: () => now,
      },
    ).catch((err: unknown): LoadedPrices => {
      console.warn("[valuation] 주가를 받지 못함 — 주가 지표를 비운다:", err);
      priceWarnings.push(PRICE_UNAVAILABLE_FLAG);
      return { baseDate: null, rows: [], externalCalls: 0 };
    }),
    loadListings(input.client, rows),
  ]);
  if (loaded.staleCodes?.length && loaded.baseDate) {
    priceWarnings.push(
      `주가를 새로 받지 못해 저장된 ${loaded.baseDate}까지의 종가로 시가총액·PER·PBR을 계산했습니다`,
    );
  }
  // 재실행은 저장된 날짜 그대로 (그날 가격이 없으면 NO_PRICE — 다른 날 가격으로 바꾸지 않는다)
  const baseDate = input.priceDate ?? loaded.baseDate;
  const joined = joinFinancialsWithPrices({
    financials: rows,
    listings,
    prices: loaded.rows,
    baseDate,
  });

  return {
    priceDate: baseDate,
    rows: joined.rows.map(({ financial, price }) => {
      const cap = marketCap(price?.closePrice, price?.listedShares);
      return {
        input: financial,
        price,
        cap,
        per: computePer(cap, financial.ttm),
        pbr: computePbr(cap, financial.ownersEquity),
      };
    }),
    warnings: [...priceWarnings, ...joined.warnings],
    counts: joined.counts,
    externalCalls: loaded.externalCalls,
  };
}

function valueAt(
  financials: CompanyFinancials,
  quarter: Quarter,
  field: "ttm_owners_ni" | "owners_equity",
): Computed<bigint> {
  const computed = financials.metricsByQuarter.get(quarter)?.metrics[field];
  if (computed && computed.value !== null) return computed;
  if (financials.quartersWithoutReport?.has(quarter)) return { value: null, reason: "NO_REPORT" };
  return computed ?? { value: null, reason: "MISSING_ACCOUNT" };
}

/** 기업 목록에서 결합할 기업들의 종목코드 (보통주 키 중복 검사). 표가 없거나 실패하면 재무 쪽 코드만으로 검사한다 */
async function loadListings(
  client: SupabaseClient,
  rows: readonly ValuationInputRow[],
): Promise<ListingRow[]> {
  const corpCodes = rows.map((r) => r.corpCode);
  const stockCodes = rows.map((r) => r.stockCode);
  // 기업코드 또는 종목코드가 겹치는 행 (값은 기업·종목 코드라 영문·숫자뿐 — PostgREST or 문법에 그대로 넣어도 된다)
  const { data, error } = await client
    .from("companies")
    .select("corp_code, stock_code")
    .or(`corp_code.in.(${corpCodes.join(",")}),stock_code.in.(${stockCodes.join(",")})`);
  if (error) throw new Error(`companies 조회 실패: ${error.message}`);
  return (data ?? [])
    .filter((r): r is { corp_code: string; stock_code: string } => Boolean(r?.stock_code))
    .map((r) => ({ corpCode: r.corp_code, stockCode: r.stock_code }));
}

/** 실행 기록(`outputSummary`)에 남기는 결합 전후 행 수 (TECH §6.6 "기록") */
export function valuationSummary(prepared: PreparedValuation): string {
  const c = prepared.counts;
  return [
    `주가 결합: 재무 ${c.financialRows}행 + 주가 ${c.priceRows}행 → ${c.joinedRows}행`,
    `제외 ${c.excludedPriceRows}행(우선주 ${c.preferredRows})`,
    `기준일 ${prepared.priceDate ?? "없음"}`,
    `주가 호출 ${prepared.externalCalls}건`,
    ...(prepared.warnings.length > 0 ? ["결합 중단"] : []),
  ].join(", ");
}

const DISPLAY_BY_REASON = { DEFICIT: "적자", CAPITAL_IMPAIRMENT: "자본잠식" } as const;

/**
 * 주가 지표 차트: 기업 하나면 카드(시가총액·PER·PBR), 여럿이면 표. 질문이 셋 중 하나만 물어도 셋 다 보여 준다
 * (PER을 물으면 시가총액·PBR이 함께 있어야 읽힌다 — PHASE4_PLAN WU-502 "결과 카드에 PER·PBR·시가총액").
 */
export function buildValuationChart(
  prepared: PreparedValuation,
  allocator: FigureAllocator,
  chartId: string,
): { chart: Chart; series: Series[]; rowKeys: string[] } {
  const multiple = prepared.rows.length > 1;
  const date = prepared.priceDate ?? undefined;
  const series: Series[] = (
    [
      { key: "market_cap", label: "시가총액", unit: "KRW" },
      { key: "per", label: "PER", unit: "TIMES" },
      { key: "pbr", label: "PBR", unit: "TIMES" },
    ] as const
  ).map(({ key, label, unit }) => ({
    key,
    label,
    unit,
    points: prepared.rows.map((row) => {
      const computed = key === "market_cap" ? row.cap : key === "per" ? row.per : row.pbr;
      const reason = computed.reason;
      const figure = allocator.add({
        label: `${row.input.name} ${label}`,
        unit,
        value: computed.value,
        reason,
        displayText:
          reason === "DEFICIT" || reason === "CAPITAL_IMPAIRMENT"
            ? DISPLAY_BY_REASON[reason]
            : undefined,
        basis: {
          report: key === "market_cap" ? "금융위원회 주식시세" : row.input.report, // 기준일은 화면이 basis.priceDate로 붙인다
          fsDiv: row.input.fsDiv,
          ...(date ? { priceDate: date } : {}),
        },
      });
      return { x: row.input.name, figureId: figure.id };
    }),
  }));

  const quarters = [...new Set(prepared.rows.map((r) => r.input.quarter))];
  const ttmRange = quarters.map((q) => `${addQuarters(q, -3)}~${q}`).join(", ");
  const subject = multiple ? "기업별 주가 지표" : `${prepared.rows[0]?.input.name ?? ""} 주가 지표`;
  const chart: Chart = {
    id: chartId,
    type: multiple ? "table" : "card",
    title: `${subject} (${date ? `${date} 종가 기준` : "주가 없음"})`,
    series,
    footnotes: [
      VALUATION_FORMULAS.market_cap,
      `${VALUATION_FORMULAS.per} — TTM ${ttmRange}`,
      `${VALUATION_FORMULAS.pbr} — ${quarters.join(", ")}말`,
    ],
    source: `출처: ${PRICE_SOURCE} · DART ${prepared.rows[0]?.input.report ?? ""}`.trim(),
  };
  return { chart, series, rowKeys: prepared.rows.map((r) => r.input.name) };
}
