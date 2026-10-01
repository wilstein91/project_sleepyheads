// 투자 리포트 — 최대주주(hyslrSttus)·배당(alotMatter). 정기보고서마다 바뀌는 값이라 보고서 하나를 정해 부르고,
// `company_facts`에 기업·종류마다 한 행(jsonb)으로 둔다. 같은 보고서로 이미 받았으면 다시 부르지 않는다.
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { dartFetch, type DartEnvelope } from "@/lib/dart/client";
import type { ReprtCode } from "@/lib/financials/types";

export interface ShareholderFact {
  /** 최대주주 이름 */
  name: string;
  /** 최대주주 지분율 (%) */
  ratio: number | null;
  /** 최대주주 + 특수관계인 지분율 합 (%) */
  totalWithRelated: number | null;
  /** 특수관계인 수 (최대주주 제외) */
  relatedCount: number;
}

export interface DividendFact {
  /** 보통주 주당 현금배당금 (원) */
  dps: number | null;
  /** 보통주 현금배당수익률 (%, 보고서 기준) */
  yieldRate: number | null;
  /** 연결 현금배당성향 (%) */
  payoutRatio: number | null;
}

export interface FactRef {
  bsnsYear: number;
  reprtCode: ReprtCode;
  rceptNo?: string;
}

export interface FactsOptions {
  client: SupabaseClient;
  userId?: string | null;
  analysisId?: string | null;
  now?: () => Date;
}

interface DartListResponse<T> extends DartEnvelope {
  list?: T[];
}

interface HolderRow {
  nm: string;
  relate?: string;
  stock_knd?: string;
  trmend_posesn_stock_qota_rt?: string;
}

interface DividendRow {
  se: string;
  stock_knd?: string;
  thstrm?: string;
}

/** 최대주주 현황 — `ref` 보고서 기준. 없으면(013) null */
export async function loadShareholder(
  corpCode: string,
  ref: FactRef,
  options: FactsOptions,
): Promise<{ fact: ShareholderFact | null; externalCalls: number }> {
  return cachedFact(corpCode, "shareholder", ref, options, async () => {
    const res = await dartFetch<DartListResponse<HolderRow>>(
      "hyslrSttus.json",
      { corp_code: corpCode, bsns_year: ref.bsnsYear, reprt_code: ref.reprtCode },
      {
        userId: options.userId ?? null,
        analysisId: options.analysisId ?? null,
        client: options.client,
      },
    );
    return res.status === "013" ? null : parseShareholders(res.list ?? []);
  });
}

/** 배당 — 사업보고서 기준이 정확하다(분기 보고서에는 중간배당만) */
export async function loadDividend(
  corpCode: string,
  ref: FactRef,
  options: FactsOptions,
): Promise<{ fact: DividendFact | null; externalCalls: number }> {
  return cachedFact(corpCode, "dividend", ref, options, async () => {
    const res = await dartFetch<DartListResponse<DividendRow>>(
      "alotMatter.json",
      { corp_code: corpCode, bsns_year: ref.bsnsYear, reprt_code: ref.reprtCode },
      {
        userId: options.userId ?? null,
        analysisId: options.analysisId ?? null,
        client: options.client,
      },
    );
    return res.status === "013" ? null : parseDividend(res.list ?? []);
  });
}

export function parseShareholders(rows: HolderRow[]): ShareholderFact | null {
  // 보통주(의결권 있는 주식) 행만 — 우선주·"기타" 행이 따로 온다 (2026-10-01 SK하이닉스 실측: stock_knd
  // "의결권 있는 주식"·"기타"). "계" 행은 합계
  const common = rows.filter(
    (r) => !r.stock_knd || (/보통|의결권\s*있는/.test(r.stock_knd) && !/없는/.test(r.stock_knd)),
  );
  const total = common.find((r) => r.nm.trim() === "계");
  const holders = common.filter((r) => r.nm.trim() !== "계");
  const top = holders.find((r) => r.relate?.includes("최대주주")) ?? holders[0];
  if (!top) return null;
  const others = holders.filter((r) => r !== top);
  const sum = holders.reduce((a, r) => a + (ratioOf(r.trmend_posesn_stock_qota_rt) ?? 0), 0);
  return {
    name: top.nm.trim(),
    ratio: ratioOf(top.trmend_posesn_stock_qota_rt),
    totalWithRelated: ratioOf(total?.trmend_posesn_stock_qota_rt) ?? round2(sum),
    relatedCount: others.length,
  };
}

export function parseDividend(rows: DividendRow[]): DividendFact | null {
  const pick = (re: RegExp, common = true) =>
    rows.find((r) => re.test(r.se) && (!common || !r.stock_knd || /보통/.test(r.stock_knd)))
      ?.thstrm;
  const fact = {
    dps: numberOf(pick(/주당\s*현금배당금/)),
    yieldRate: numberOf(pick(/현금배당수익률/)),
    payoutRatio: numberOf(pick(/\(연결\)\s*현금배당성향/, false) ?? pick(/현금배당성향/, false)),
  };
  return fact.dps === null && fact.yieldRate === null && fact.payoutRatio === null ? null : fact;
}

function ratioOf(raw: string | undefined): number | null {
  return numberOf(raw);
}

function numberOf(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw.replace(/,/g, "").trim());
  return raw.trim() === "-" || !Number.isFinite(n) ? null : n;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

interface FactRow {
  bsns_year: number;
  reprt_code: string;
  data: unknown;
  fetched_at: string;
}

/** 같은 보고서(연도·종류)로 받은 것이 있으면 그대로. 표가 없으면(마이그레이션 전) 매번 부른다 */
async function cachedFact<T>(
  corpCode: string,
  kind: "shareholder" | "dividend",
  ref: FactRef,
  options: FactsOptions,
  fetch: () => Promise<T | null>,
): Promise<{ fact: T | null; externalCalls: number }> {
  const { data, error } = await options.client
    .from("company_facts")
    .select("bsns_year, reprt_code, data, fetched_at")
    .eq("corp_code", corpCode)
    .eq("kind", kind)
    .maybeSingle();
  const row = error ? null : (data as FactRow | null);
  if (row && row.bsns_year === ref.bsnsYear && row.reprt_code === ref.reprtCode) {
    return { fact: (row.data as T | null) ?? null, externalCalls: 0 };
  }
  const fact = await fetch();
  const now = options.now?.() ?? new Date();
  if (!error) {
    const { error: writeError } = await options.client.from("company_facts").upsert(
      [
        {
          corp_code: corpCode,
          kind,
          bsns_year: ref.bsnsYear,
          reprt_code: ref.reprtCode,
          data: fact,
          fetched_at: now.toISOString(),
        },
      ],
      { onConflict: "corp_code,kind" },
    );
    if (writeError) console.warn(`[report] company_facts 저장 실패: ${writeError.message}`);
  }
  return { fact, externalCalls: 1 };
}
