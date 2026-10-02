// 투자 리포트 — 주가·거래 정보 (1년 일별 시세). 금융위원회_주식시세정보는 종목 하나의 1년 치(거래일 약 245일)를
// 한 번에 준다(약 1초). 받은 것은 `stock_price_history`에 종목당 한 행(jsonb)으로 두고 **하루 1회**만 다시 받는다.
// 통계(수익률·52주 고저·변동성 등)는 순수 함수 `priceStats`가 계산한다 — 테스트·재현이 쉽다.
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { priceFetch, type PriceEnvelope } from "@/lib/price/client";
import { addDays, PRICE_PATH } from "@/lib/price/daily";
import { todayKst } from "@/lib/quota/kst";

/** 1년 + 연초 대비(YTD)·1년 수익률 기준일을 찾을 여유 (설·추석 연휴) */
const HISTORY_DAYS = 380;
const MAX_ROWS = 400;

/** 하루 시세 (금액은 원, 수는 주) */
export interface DailyPrice {
  /** "2026-09-30" */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** 전일 대비 등락률 (%) */
  changeRate: number;
  volume: number;
  /** 거래대금 (원) */
  tradeValue: number;
  listedShares: number;
  marketCap: number;
}

interface PriceItem {
  basDt: string;
  srtnCd: string;
  clpr: string;
  fltRt: string;
  mkp: string;
  hipr: string;
  lopr: string;
  trqu: string;
  trPrc: string;
  lstgStCnt: string;
  mrktTotAmt: string;
}

interface PriceListResponse extends PriceEnvelope {
  response: PriceEnvelope["response"] & {
    body?: { items?: { item?: PriceItem[] | PriceItem } | "" };
  };
}

export interface LoadPriceHistoryOptions {
  client: SupabaseClient;
  userId?: string | null;
  analysisId?: string | null;
  now?: () => Date;
}

export interface PriceHistory {
  /** 날짜 오름차순 */
  days: DailyPrice[];
  /** 이번에 부른 주가 API 수 (오늘 받은 것이 있으면 0) */
  externalCalls: number;
  /** 주가 API가 실패해 예전에 받아 둔 시세를 대신 썼다 (리포트가 기준일과 함께 안내한다) */
  stale?: true;
}

/**
 * 종목 하나의 1년 일별 시세 — 오늘(KST) 받아 둔 것이 있으면 그대로 쓴다.
 * 주가 API가 실패하면(키 누락·한도·점검) 예전에 받아 둔 시세로 대신한다(`stale`) — 받아 둔 것도 없으면 오류를 던진다.
 * 2026-10-02 운영: 배포 환경에 주가 키가 없어 어제 받아 둔 시세가 있는데도 PER·PBR이 "계산 불가"였다.
 */
export async function loadPriceHistory(
  stockCode: string,
  options: LoadPriceHistoryOptions,
): Promise<PriceHistory> {
  const now = options.now?.() ?? new Date();
  const today = todayKst(now);
  const cached = await readCached(options.client, stockCode);
  if (cached && todayKst(new Date(cached.fetched_at)) === today) {
    return { days: cached.days, externalCalls: 0 };
  }

  let res: PriceListResponse;
  try {
    res = await fetchHistory(stockCode, today, options);
  } catch (err) {
    if (cached && cached.days.length > 0) {
      console.warn(
        `[report] 주가를 받지 못해 저장된 시세(${cached.days.at(-1)!.date})로 대신:`,
        err,
      );
      return { days: cached.days, externalCalls: 0, stale: true };
    }
    throw err;
  }
  const items = res.response.body?.items;
  const raw = items && typeof items === "object" ? items.item : undefined;
  const list = raw ? (Array.isArray(raw) ? raw : [raw]) : [];
  // likeSrtnCd는 "포함" 검색이라 다른 종목(우선주 등)이 섞일 수 있다 — 정확히 그 코드만
  const byDate = new Map<string, DailyPrice>();
  for (const item of list) {
    if (item.srtnCd !== stockCode || !/^\d{8}$/.test(item.basDt)) continue;
    const day = toDaily(item);
    if (day) byDate.set(day.date, day);
  }
  const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  await writeCached(options.client, stockCode, days, now);
  return { days, externalCalls: 1 };
}

function fetchHistory(
  stockCode: string,
  today: string,
  options: LoadPriceHistoryOptions,
): Promise<PriceListResponse> {
  return priceFetch<PriceListResponse>(
    PRICE_PATH,
    {
      numOfRows: MAX_ROWS,
      pageNo: 1,
      likeSrtnCd: stockCode,
      beginBasDt: addDays(today, -HISTORY_DAYS).replaceAll("-", ""),
    },
    {
      client: options.client,
      userId: options.userId ?? null,
      analysisId: options.analysisId ?? null,
    },
  );
}

function toDaily(i: PriceItem): DailyPrice | null {
  const num = (s: string) => (s === "" || s === undefined ? NaN : Number(s));
  const close = num(i.clpr);
  if (!Number.isFinite(close) || close <= 0) return null;
  return {
    date: `${i.basDt.slice(0, 4)}-${i.basDt.slice(4, 6)}-${i.basDt.slice(6, 8)}`,
    open: num(i.mkp) || close,
    high: num(i.hipr) || close,
    low: num(i.lopr) || close,
    close,
    changeRate: Number.isFinite(num(i.fltRt)) ? num(i.fltRt) : 0,
    volume: num(i.trqu) || 0,
    tradeValue: num(i.trPrc) || 0,
    listedShares: num(i.lstgStCnt) || 0,
    marketCap: num(i.mrktTotAmt) || 0,
  };
}

interface CachedRow {
  fetched_at: string;
  days: DailyPrice[];
}

/** 표가 없거나(마이그레이션 전) 읽지 못하면 캐시 없이 진행한다 */
async function readCached(client: SupabaseClient, stockCode: string): Promise<CachedRow | null> {
  const { data, error } = await client
    .from("stock_price_history")
    .select("fetched_at, days")
    .eq("stock_code", stockCode)
    .maybeSingle();
  if (error) {
    warnOnce(`[report] stock_price_history 조회 실패 — 캐시 없이 진행: ${error.message}`);
    return null;
  }
  return (data as CachedRow | null) ?? null;
}

async function writeCached(
  client: SupabaseClient,
  stockCode: string,
  days: DailyPrice[],
  now: Date,
) {
  const { error } = await client
    .from("stock_price_history")
    .upsert([{ stock_code: stockCode, days, fetched_at: now.toISOString() }], {
      onConflict: "stock_code",
    });
  if (error) warnOnce(`[report] stock_price_history 저장 실패: ${error.message}`);
}

let warned = false;
function warnOnce(message: string) {
  if (warned) return;
  warned = true;
  console.warn(message);
}

/** 기간 수익률: 기준일 이전(포함) 마지막 거래일 종가 대비 */
export interface PriceStats {
  last: DailyPrice;
  high52: { price: number; date: string };
  low52: { price: number; date: string };
  /** 현재가가 52주 범위에서 어디쯤인가 (0 = 최저, 100 = 최고) */
  rangePosition: number;
  /** 수익률 (%) — 그만큼 거래 기록이 없으면 null */
  returns: {
    m1: number | null;
    m3: number | null;
    m6: number | null;
    y1: number | null;
    ytd: number | null;
  };
  /** 일간 수익률 표준편차 × √252 (%) */
  volatility: number | null;
  /** 최근 20거래일 평균 거래량 ÷ 1년 평균 거래량 */
  volumeRatio20: number | null;
  avgVolume20: number | null;
  avgTradeValue20: number | null;
}

export function priceStats(days: readonly DailyPrice[]): PriceStats | null {
  if (days.length === 0) return null;
  const last = days[days.length - 1];
  const yearAgo = addDays(last.date, -365);
  const year = days.filter((d) => d.date > yearAgo);
  let high = year[0];
  let low = year[0];
  for (const d of year) {
    if (d.high > high.high) high = d;
    if (d.low < low.low) low = d;
  }

  const closeOnOrBefore = (date: string) => {
    let found: DailyPrice | null = null;
    for (const d of days) if (d.date <= date) found = d;
    return found;
  };
  const returnSince = (date: string) => {
    const base = closeOnOrBefore(date);
    // 기준일보다 한참 뒤에 상장했으면(기록이 그 날짜까지 안 닿으면) 계산하지 않는다
    if (!base || base === last || days[0].date > date) return null;
    return round2(((last.close - base.close) / base.close) * 100);
  };
  const monthsBack = (n: number) => {
    const d = new Date(`${last.date}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - n);
    return d.toISOString().slice(0, 10);
  };

  const dailyReturns: number[] = [];
  for (let i = 1; i < year.length; i += 1) {
    dailyReturns.push(Math.log(year[i].close / year[i - 1].close));
  }
  const volatility =
    dailyReturns.length >= 20 ? round2(stdev(dailyReturns) * Math.sqrt(252) * 100) : null;

  const recent = year.slice(-20);
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const avgVolumeYear = year.length > 0 ? avg(year.map((d) => d.volume)) : 0;
  const avgVolume20 = recent.length > 0 ? avg(recent.map((d) => d.volume)) : null;

  return {
    last,
    high52: { price: high.high, date: high.date },
    low52: { price: low.low, date: low.date },
    rangePosition:
      high.high === low.low ? 100 : round2(((last.close - low.low) / (high.high - low.low)) * 100),
    returns: {
      m1: returnSince(monthsBack(1)),
      m3: returnSince(monthsBack(3)),
      m6: returnSince(monthsBack(6)),
      y1: returnSince(monthsBack(12)),
      ytd: returnSince(`${Number(last.date.slice(0, 4)) - 1}-12-31`),
    },
    volatility,
    volumeRatio20:
      avgVolume20 !== null && avgVolumeYear > 0 ? round2(avgVolume20 / avgVolumeYear) : null,
    avgVolume20: avgVolume20 === null ? null : Math.round(avgVolume20),
    avgTradeValue20: recent.length > 0 ? Math.round(avg(recent.map((d) => d.tradeValue))) : null,
  };
}

/** 주마다 마지막 거래일 하나 (차트용 — 1년 약 52점). 주 = 월요일 시작 */
export function weeklyCloses(
  days: readonly DailyPrice[],
): { week: string; day: DailyPrice; volume: number }[] {
  const weeks = new Map<string, { week: string; day: DailyPrice; volume: number }>();
  for (const d of days) {
    const key = mondayOf(d.date);
    const w = weeks.get(key);
    weeks.set(key, { week: key, day: d, volume: (w?.volume ?? 0) + d.volume });
  }
  return [...weeks.values()];
}

function mondayOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // 월 = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

function stdev(xs: number[]): number {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
