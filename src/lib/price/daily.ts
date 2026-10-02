// WU-502 종목별 주가 (TECH §3.2·§6.6). 받은 가격은 `stock_prices`에 넣어 두고 다시 쓴다:
// - 지금 기준(latest): 오늘(KST) 이미 받은 종목은 주가 API를 부르지 않는다 → **종목마다 하루 1회**.
//   경쟁사 순서용 전체 목록(`sector/market-cap.ts`)을 오늘 받았으면 그것도 오늘 받은 것으로 친다.
// - 과거 기준(asOf): 그 날짜가 지난 뒤에 받아 둔 가격이 있으면 부르지 않는다 (지난 가격은 바뀌지 않는다).
// API에서 받은 행은 결합 검사(`join.ts`)를 위해 받은 그대로 돌려주고, 저장은 키(종목·기준일)가 겹치지 않는 행만 한다.
// 받을 때마다 `price_fetch_state`에 "이 종목·기간 끝을 받았다"를 남긴다 — 기간 안 가격이 없는 종목(거래정지 등)도
// 같은 날·같은 기준일에 다시 부르지 않게 (Phase 5, Phase 4 남긴 리뷰 ①).
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createConcurrencyGate } from "@/lib/quota/concurrency";
import { todayKst } from "@/lib/quota/kst";
import { priceFetch, type PriceEnvelope } from "./client";
import type { PriceRow } from "./join";

/** V2 주소 (TECH §3.2). 공통 호출기의 기본 주소를 덮어쓴다 */
export const PRICE_PATH = "/1160100/GetStockSecuritiesInfoService_V2/getStockPriceInfo_V2";
/** 기준일을 찾을 때 거슬러 올라가는 날 수 (설·추석 연휴 포함) */
export const PRICE_LOOKBACK_DAYS = 14;
/** 한 종목 14일 치(거래일 10일 안팎)가 한 쪽에 다 들어오게 */
const ROWS_PER_STOCK = 50;
/** 공공데이터포털에 한꺼번에 보내는 요청 수 */
const FETCH_CONCURRENCY = 4;

export type PriceWindow =
  /** 조회 시점의 가장 최근 거래일 (현재 지표) */
  | { kind: "latest" }
  /** `date` 이전(포함) 마지막 거래일 (과거 분기 지표·재실행) */
  | { kind: "asOf"; date: string };

export interface LoadPricesOptions {
  client: SupabaseClient;
  userId?: string | null;
  analysisId?: string | null;
  now?: () => Date;
}

export interface LoadedPrices {
  /** 결합 기준일 — 기간 안에 가격이 하나도 없으면 null */
  baseDate: string | null;
  /** 기간 안의 가격 행 (API에서 받았으면 받은 그대로 — 우선주·중복 행 포함) */
  rows: PriceRow[];
  /** 이번에 부른 주가 API 수 (저장된 가격을 쓰면 0) */
  externalCalls: number;
  /** 주가 API가 실패해 기간 안에 저장된 (더 이른) 가격으로 대신한 종목 */
  staleCodes?: string[];
}

interface PriceItem {
  basDt: string;
  srtnCd: string;
  itmsNm?: string;
  clpr: string;
  lstgStCnt: string;
}

interface PriceListResponse extends PriceEnvelope {
  response: PriceEnvelope["response"] & {
    body?: { totalCount?: number; items?: { item?: PriceItem[] | PriceItem } | "" };
  };
}

interface FetchState {
  stock_code: string;
  fetched_at: string;
  row_count: number;
}

/** 마이그레이션 적용 전 경고는 프로세스마다 한 번만 (요청마다 찍으면 진짜 주가 오류가 묻힌다) */
let warnedFetchState = false;
function warnFetchStateOnce(message: string) {
  if (warnedFetchState) return;
  warnedFetchState = true;
  console.warn(message);
}

interface StoredPrice {
  stock_code: string;
  base_date: string;
  close_price: number | string;
  listed_shares: number | string | null;
  fetched_at: string;
}

/**
 * `stockCodes`의 기간 안 가격과 결합 기준일. 기준일은 기간 안 가장 늦은 거래일이다(여러 기업이면 그중 가장 늦은 날 —
 * 그날 가격이 없는 기업은 거래정지 등으로 보고 `NO_PRICE`가 된다).
 * 주가 API가 실패하면(키 누락·한도·점검) 기간 안에 저장된 가격이 있는 종목은 그 가격으로 대신하고(`staleCodes`),
 * 저장된 가격도 없으면 오류를 그대로 던진다.
 */
export async function loadPrices(
  stockCodes: readonly string[],
  window: PriceWindow,
  options: LoadPricesOptions,
): Promise<LoadedPrices> {
  const now = options.now?.() ?? new Date();
  const today = todayKst(now);
  const to = window.kind === "latest" ? today : window.date;
  const from = addDays(to, -PRICE_LOOKBACK_DAYS);
  const codes = [...new Set(stockCodes)];

  const [stored, fetchedAt] = await Promise.all([
    readStored(options.client, codes, from, to),
    readFetchState(options.client, codes, to),
  ]);
  const gate = createConcurrencyGate(FETCH_CONCURRENCY);
  let externalCalls = 0;
  const staleCodes: string[] = [];
  const perCode = await Promise.all(
    codes.map(async (code) => {
      const mine = stored.filter((r) => r.stock_code === code);
      // 받은 기록은 "받았지만 기간 안 가격 0행"일 때만 쓴다 — 행이 있었는데 저장된 게 없으면(같은 종목·기준일 2행)
      // 다시 받아 결합 검사가 경고하게 둔다
      const state = fetchedAt.get(code);
      const fetchedEmpty = state?.row_count === 0 && isFetched(state.fetched_at, window, today);
      if (isFresh(mine, window, today) || fetchedEmpty) {
        return mine.map(fromStored);
      }
      externalCalls += 1;
      let items: PriceItem[];
      try {
        items = await gate.run(() => fetchStock(code, from, to, window, options));
      } catch (err) {
        if (mine.length === 0) throw err;
        console.warn(`[price] 주가를 받지 못해 저장된 가격으로 대신 (${code}):`, err);
        staleCodes.push(code);
        return mine.map(fromStored);
      }
      await store(options.client, items, now);
      const rows = items.map(fromItem).filter((r) => r.baseDate >= from && r.baseDate <= to);
      await recordFetch(options.client, code, from, to, rows, now);
      return rows;
    }),
  );
  const rows = perCode.flat();
  const dates = rows.filter((r) => codes.includes(r.stockCode)).map((r) => r.baseDate);
  return {
    baseDate: dates.length > 0 ? dates.sort().at(-1)! : null,
    rows,
    externalCalls,
    ...(staleCodes.length > 0 ? { staleCodes } : {}),
  };
}

/**
 * 저장된 가격으로 충분한가. latest: 오늘(KST) 받은 행이 있다. asOf: 그날 가격이 있거나, 그 날짜가 지난 뒤(KST 다음 날
 * 이후)에 받은 행이 있다 — 그때 받은 기간 안 가격은 더 바뀌지 않는다.
 * 기간 안 가격이 하나도 없는 종목(거래정지 등)은 남는 행이 없다 — 그건 {@link isFetched}가 받은 기록으로 본다.
 */
function isFresh(rows: readonly StoredPrice[], window: PriceWindow, today: string): boolean {
  return rows.some((r) => {
    // 그날 가격이 이미 있으면 그날이 "그날 이전 마지막 거래일"이다 (오후에 받은 당일 가격으로 만든 분석의 재실행)
    if (window.kind === "asOf" && r.base_date === window.date) return true;
    return isFetched(r.fetched_at, window, today);
  });
}

/** 그 시각에 받은 것으로 충분한가 — latest: 오늘(KST) 받았다. asOf: 기준일이 지난 뒤(KST 다음 날 이후)에 받았다 */
function isFetched(fetchedAt: string | undefined, window: PriceWindow, today: string): boolean {
  if (!fetchedAt) return false;
  const fetchedDay = todayKst(new Date(fetchedAt));
  return window.kind === "latest" ? fetchedDay === today : fetchedDay > window.date;
}

/**
 * 종목별로 이 기간 끝(`to`)을 마지막으로 받은 시각. 마이그레이션(`price_fetch_state`) 적용 전이거나 조회가 실패해도
 * 분석을 멈추지 않는다 — 기록이 없는 것으로 보고 예전처럼 주가 API를 부른다.
 */
async function readFetchState(
  client: SupabaseClient,
  codes: readonly string[],
  to: string,
): Promise<Map<string, FetchState>> {
  if (codes.length === 0) return new Map();
  const { data, error } = await client
    .from("price_fetch_state")
    .select("stock_code, fetched_at, row_count")
    .in("stock_code", [...codes])
    .eq("range_to", to);
  if (error) {
    warnFetchStateOnce(
      `[price] price_fetch_state 조회 실패 — 받은 기록 없이 진행: ${error.message}`,
    );
    return new Map();
  }
  return new Map(((data ?? []) as FetchState[]).map((r) => [r.stock_code, r]));
}

/** 받은 기록 — 가격이 없었어도(0행) 남긴다. 실패해도 분석은 계속한다(다음 요청이 다시 부를 뿐) */
async function recordFetch(
  client: SupabaseClient,
  code: string,
  from: string,
  to: string,
  rows: readonly PriceRow[],
  now: Date,
) {
  const { error } = await client.from("price_fetch_state").upsert(
    [
      {
        stock_code: code,
        range_to: to,
        range_from: from,
        row_count: rows.filter((r) => r.stockCode === code).length,
        fetched_at: now.toISOString(),
      },
    ],
    { onConflict: "stock_code,range_to" },
  );
  if (error) warnFetchStateOnce(`[price] price_fetch_state 저장 실패 (${code}): ${error.message}`);
}

async function readStored(
  client: SupabaseClient,
  codes: readonly string[],
  from: string,
  to: string,
): Promise<StoredPrice[]> {
  if (codes.length === 0) return [];
  const { data, error } = await client
    .from("stock_prices")
    .select("stock_code, base_date, close_price, listed_shares, fetched_at")
    .in("stock_code", [...codes])
    .gte("base_date", from)
    .lte("base_date", to);
  if (error) throw new Error(`stock_prices 조회 실패: ${error.message}`);
  return (data ?? []) as StoredPrice[];
}

async function fetchStock(
  code: string,
  from: string,
  to: string,
  window: PriceWindow,
  options: LoadPricesOptions,
): Promise<PriceItem[]> {
  const res = await priceFetch<PriceListResponse>(
    PRICE_PATH,
    {
      numOfRows: ROWS_PER_STOCK,
      pageNo: 1,
      likeSrtnCd: code,
      beginBasDt: compactDate(from),
      // endBasDt는 "그날 미만"이라 하루 뒤를 준다
      endBasDt: window.kind === "asOf" ? compactDate(addDays(to, 1)) : undefined,
    },
    {
      client: options.client,
      userId: options.userId ?? null,
      analysisId: options.analysisId ?? null,
    },
  );
  const items = res.response.body?.items;
  const item = items && typeof items === "object" ? items.item : undefined;
  if (!item) return [];
  return (Array.isArray(item) ? item : [item]).filter(
    (i) => /^\d{8}$/.test(i.basDt) && /^\d+$/.test(i.clpr),
  );
}

/** 키(종목·기준일)가 한 번만 나온 행만 저장한다 — 겹친 행은 결합 검사가 경고로 알린다 */
async function store(client: SupabaseClient, items: readonly PriceItem[], now: Date) {
  const count = new Map<string, number>();
  for (const i of items)
    count.set(`${i.srtnCd}|${i.basDt}`, (count.get(`${i.srtnCd}|${i.basDt}`) ?? 0) + 1);
  const rows = items
    .filter((i) => count.get(`${i.srtnCd}|${i.basDt}`) === 1)
    .map((i) => ({
      stock_code: i.srtnCd,
      base_date: isoDate(i.basDt),
      close_price: Number(i.clpr),
      listed_shares: /^\d+$/.test(i.lstgStCnt) ? Number(i.lstgStCnt) : null,
      fetched_at: now.toISOString(),
    }));
  if (rows.length === 0) return;
  const { error } = await client
    .from("stock_prices")
    .upsert(rows, { onConflict: "stock_code,base_date" });
  if (error) throw new Error(`stock_prices 저장 실패: ${error.message}`);
}

function fromStored(r: StoredPrice): PriceRow {
  return {
    stockCode: r.stock_code,
    baseDate: r.base_date,
    closePrice: BigInt(r.close_price),
    listedShares: r.listed_shares == null ? null : BigInt(r.listed_shares),
  };
}

function fromItem(i: PriceItem): PriceRow {
  return {
    stockCode: i.srtnCd,
    baseDate: isoDate(i.basDt),
    closePrice: BigInt(i.clpr),
    listedShares: /^\d+$/.test(i.lstgStCnt) ? BigInt(i.lstgStCnt) : null,
    ...(i.itmsNm ? { name: i.itmsNm } : {}),
  };
}

/** "2026-09-30" + n일 → "2026-10-01" */
export function addDays(isoDay: string, days: number): string {
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function compactDate(isoDay: string): string {
  return isoDay.replaceAll("-", "");
}

function isoDate(compact: string): string {
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}
