// Phase 5 시연 데이터 미리 받기 (`scripts/warm-demo.mjs`). 시연 질문(DevelopDoc/DEMO_SCRIPT.md §2)에 나오는 기업의
// 정기보고서·주가를 **전자공시·주가 API로만** 미리 받아 둔다 — AI는 부르지 않는다. 받는 길은 질문이 쓰는 것과 같다
// (`ensureCompanyFinancials` → report_values·report_fetch_state·calendar_quarter_metrics, `loadPrices` → stock_prices,
// `pickPeers` → 경쟁사 순서용 전체 시가총액). 모두 캐시 우선이라 몇 번 돌려도 같고, 두 번째부터는 외부 호출 0건이다.
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompanyRef, Quarter } from "@/contracts";
import { addQuarters, latestAvailableQuarter } from "@/lib/ask/quarter";
import { ensureCompanyProfile } from "@/lib/companies/profile";
import { COMPANY_SELECT_COLUMNS, toCompanyRef, type CompanyRow } from "@/lib/companies/row";
import { loadPrices } from "@/lib/price/daily";
import { buildCompanyReport } from "@/lib/report/build";
import { pickPeers } from "@/lib/sector/peers";
import { ensureCompanyFinancials } from "./company-financials";

export interface WarmTarget {
  stockCode: string;
  /** 표에 보일 이름 (기업 목록 이름이 우선) */
  name: string;
  /** 시연에서 경쟁사를 자동으로 고르는 기업 — 고른 경쟁사가 목록과 같은지 알려 준다 */
  pickPeers?: boolean;
}

/** DEMO_SCRIPT §2 (현준, 2026-10-01). 질문을 바꾸면 그 문서와 이 목록을 함께 고친다 */
export const DEMO_TARGETS: readonly WarmTarget[] = [
  { stockCode: "000660", name: "SK하이닉스", pickPeers: true },
  { stockCode: "005930", name: "삼성전자" },
  { stockCode: "042700", name: "한미반도체" },
  { stockCode: "000990", name: "DB하이텍" },
];

/** Q3 "직전 분기 대비 … 경쟁사 비교"가 자동으로 고르는 경쟁사 수 (DEMO_SCRIPT §2 표의 셋) */
const DEMO_PEER_COUNT = 3;

/**
 * 받아 둘 분기 수 (최신 분기 포함). 8분기 추이(Q2)의 첫 분기 전년 동기까지 = 12분기 — 보드 기간을 넓혀도
 * 3년 안이면 첫 조회 지연이 없다. 처음 받는 기업 하나에 보고서 약 13~16건(전자공시 호출 13~32건).
 */
export const WARM_QUARTERS = 12;

export interface WarmOptions {
  client: SupabaseClient;
  now?: () => Date;
  quarters?: number;
}

export interface WarmCompanyResult {
  stockCode: string;
  name: string;
  /** 재무 기준 — "이미 있음" = 전자공시 호출 0건, "받음" = 이번에 받음, "실패" = 이유는 `error` (주가는 `priceCalls`) */
  status: "이미 있음" | "받음" | "실패";
  period?: { from: Quarter; to: Quarter };
  /** 이번에 부른 전자공시 호출 수 (기업개황 포함) */
  dartCalls: number;
  /** 투자 리포트 캐시를 채우느라 부른 외부 호출 수 */
  reportCalls?: number;
  /** 전자공시에 보고서가 없는(013) 분기 */
  quartersWithoutReport: Quarter[];
  /** 기준일 종가 (원) — 가격이 없으면(거래정지 등) 없음 */
  price?: { baseDate: string; close: string };
  error?: string;
}

export interface WarmResult {
  companies: WarmCompanyResult[];
  /** 주가 결합 기준일 (모든 기업 중 가장 늦은 거래일) */
  priceDate: string | null;
  /** 이번에 부른 주가 API 수 (종목별 + 경쟁사 순서용 전체 목록) */
  priceCalls: number;
  /** 자동 선택 경쟁사 확인 — 시연 목록과 다르면 DEMO_SCRIPT §2를 고치라고 알린다 */
  peers?: { target: string; order: string; picked: string[]; expected: string[]; same: boolean };
  /** 받아 둔 범위 */
  period: { from: Quarter; to: Quarter };
}

export async function warmDemoData(
  targets: readonly WarmTarget[],
  options: WarmOptions,
): Promise<WarmResult> {
  const now = options.now?.() ?? new Date();
  const to = latestAvailableQuarter(now);
  const from = addQuarters(to, -((options.quarters ?? WARM_QUARTERS) - 1));
  const { client } = options;

  const companies: WarmCompanyResult[] = [];
  const refs = new Map<string, CompanyRef>();
  // 한 기업씩 — 기업 안에서 보고서 4개씩 동시에 받는다(전자공시 동시 5개 안쪽)
  for (const target of targets) {
    const result: WarmCompanyResult = {
      stockCode: target.stockCode,
      name: target.name,
      status: "이미 있음",
      dartCalls: 0,
      quartersWithoutReport: [],
    };
    try {
      const { company, profileCalls } = await companyOf(client, target.stockCode);
      refs.set(target.stockCode, company);
      result.name = company.name;
      const financials = await ensureCompanyFinancials(company, from, to, { client });
      result.dartCalls = profileCalls + (financials.externalCalls ?? 0);
      result.period = { from, to };
      result.quartersWithoutReport = [...(financials.quartersWithoutReport ?? [])].sort();
      if (result.dartCalls > 0) result.status = "받음";
    } catch (err) {
      result.status = "실패";
      result.error = err instanceof Error ? err.message : String(err);
    }
    companies.push(result);
  }

  let priceCalls = 0;
  let priceDate: string | null = null;
  const codes = [...refs.keys()];
  if (codes.length > 0) {
    try {
      const loaded = await loadPrices(codes, { kind: "latest" }, { client, now: () => now });
      priceCalls += loaded.externalCalls;
      priceDate = loaded.baseDate;
      for (const c of companies) {
        const row = loaded.rows
          .filter((r) => r.stockCode === c.stockCode)
          .sort((a, b) => b.baseDate.localeCompare(a.baseDate))[0];
        if (row) c.price = { baseDate: row.baseDate, close: row.closePrice.toString() };
      }
    } catch (err) {
      const message = `주가를 받지 못함: ${err instanceof Error ? err.message : String(err)}`;
      for (const c of companies) if (c.status !== "실패") c.error = message;
    }
  }

  let peers: WarmResult["peers"];
  const peerTarget = targets.find((t) => t.pickPeers && refs.has(t.stockCode));
  if (peerTarget) {
    const target = refs.get(peerTarget.stockCode)!;
    const expected = targets.filter((t) => t !== peerTarget).map((t) => t.stockCode);
    try {
      const picked = await pickPeers(target, DEMO_PEER_COUNT, { client, now: () => now });
      priceCalls += picked.externalCalls;
      const pickedCodes = picked.peers.map((p) => p.stockCode);
      peers = {
        target: target.name,
        order: picked.order,
        picked: picked.peers.map((p) => `${p.name}(${p.stockCode})`),
        expected,
        same: [...pickedCodes].sort().join() === [...expected].sort().join(),
      };
    } catch (err) {
      peers = {
        target: target.name,
        order: `경쟁사를 고르지 못함: ${err instanceof Error ? err.message : String(err)}`,
        picked: [],
        expected,
        same: false,
      };
    }
  }

  // 투자 리포트 캐시(1년 시세·사업보고서 계정·최대주주·배당·사업연도 말 주가)도 미리 — 시연 질문마다 리포트가 붙는다
  for (const c of companies) {
    const company = refs.get(c.stockCode);
    if (!company) continue;
    try {
      const others = [...refs.values()].filter((r) => r.stockCode !== company.stockCode);
      const built = await buildCompanyReport(company, {
        client,
        now: () => now,
        peers: others.slice(0, 3),
      });
      c.reportCalls = built.externalCalls;
      if (built.externalCalls > 0 && c.status === "이미 있음") c.status = "받음";
    } catch (err) {
      c.error = `투자 리포트를 미리 만들지 못함: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return { companies, priceDate, priceCalls, peers, period: { from, to } };
}

/** 기업 목록에서 종목코드로 찾고, 기업개황이 아직 없으면 채운다 (질문에서 처음 확정할 때와 같다) */
async function companyOf(
  client: SupabaseClient,
  stockCode: string,
): Promise<{ company: CompanyRef; profileCalls: number }> {
  // 같은 종목코드 행이 둘 이상이면(재상장 등) 개황이 채워진 것을 쓴다 — maybeSingle처럼 오류로 끝나지 않게
  const read = async () => {
    const { data, error } = await client
      .from("companies")
      .select(COMPANY_SELECT_COLUMNS)
      .eq("stock_code", stockCode);
    if (error) throw new Error(`기업 조회 실패: ${error.message}`);
    const rows = (data ?? []) as unknown as CompanyRow[];
    return rows.find((r) => toCompanyRef(r) !== null) ?? rows[0] ?? null;
  };
  const row = await read();
  if (!row) throw new Error(`기업 목록에 없는 종목코드입니다: ${stockCode}`);
  const ref = toCompanyRef(row);
  if (ref) return { company: ref, profileCalls: 0 };

  const profile = await ensureCompanyProfile(row.corp_code, { client });
  const filled = toCompanyRef((await read())!);
  if (!filled) throw new Error(`기업개황을 채우지 못했습니다: ${row.corp_name}`);
  return { company: filled, profileCalls: profile.fromCache ? 0 : 1 };
}
