// 투자 리포트 만들기 (Phase 5 후속) — 질문이 무엇이든 대상 기업 하나의
// ① 기본정보 ② 주가·거래 ③ 재무·실적 ④ 밸류에이션 ⑤ 공시를 계산해 `CompanyReport` + 숫자(Figure)로 돌려준다.
// AI는 부르지 않는다. 숫자는 모두 원문(전자공시·주가 API)에서 계산하고, 분석 글은 이 숫자를 {{f…}}로 가리켜 해석만 한다.
// 부분이 실패해도(주가 API 오류·경쟁사 시간 초과 등) 나머지는 만들고 `notes`에 무엇이 빠졌는지 적는다.
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Chart,
  CompanyRef,
  CompanyReport,
  Disclosure,
  Figure,
  Quarter,
  ReportFact,
  ReportSection,
  Unit,
} from "@/contracts";
import { addQuarters, formatQuarter, latestAvailableQuarter } from "@/lib/ask/quarter";
import type { CalendarQuarterMetrics } from "@/lib/metrics/persist";
import { marketCap, pbr, per, qoq, yoy } from "@/lib/metrics/formulas";
import type { Computed } from "@/lib/metrics/types";
import { loadPrices } from "@/lib/price/daily";
import { todayKst } from "@/lib/quota/kst";
import { ensureCompanyFinancials, type CompanyFinancials } from "@/lib/runner/company-financials";
import { fetchEventDisclosures } from "@/lib/runner/disclosures-tool";
import { createFigureAllocator, type AddFigureInput } from "@/lib/runner/figures";
import { pickPeers } from "@/lib/sector/peers";
import { loadAnnualFinancials, type AnnualFinancials, type AnnualReport } from "./annual";
import { loadDividend, loadShareholder, type DividendFact, type ShareholderFact } from "./facts";
import {
  loadPriceHistory,
  priceStats,
  weeklyCloses,
  type DailyPrice,
  type PriceStats,
} from "./price-history";

import { REPORT_FIGURE_START } from "./ids";
/** 분기 실적 추이 (최근 8분기 + YoY용 앞 4분기) */
const QUARTERS = 12;
const SHOWN_QUARTERS = 8;
/** 경쟁사 비교는 처음 조회하는 기업이면 오래 걸린다 — 이 시간이 지나면 빼고 끝낸다 */
const PEER_TIME_BUDGET_MS = 25_000;
const PEER_COUNT = 3;

const PRICE_BASIS = "금융위원회 주식시세";

export interface BuildReportOptions {
  client: SupabaseClient;
  userId?: string | null;
  analysisId?: string | null;
  now?: () => Date;
  /** 질문에 이미 비교 기업이 있으면 그 기업들로 경쟁사 비교 (없으면 같은 섹터 시가총액 순 3곳) */
  peers?: CompanyRef[];
}

export interface BuiltReport {
  report: CompanyReport;
  /** 리포트 숫자 — 결과의 figures에 합친다 */
  figures: Record<string, Figure>;
  externalCalls: number;
  /** 실행 기록 한 줄 */
  summary: string;
}

export async function buildCompanyReport(
  company: CompanyRef,
  options: BuildReportOptions,
): Promise<BuiltReport> {
  const now = options.now?.() ?? new Date();
  const clock = () => now;
  const io = {
    client: options.client,
    userId: options.userId ?? null,
    analysisId: options.analysisId ?? null,
  };
  const latest = latestAvailableQuarter(now);
  const notes: string[] = [];
  let externalCalls = 0;

  // 서로 기다리지 않는 수집은 함께 — 전자공시 동시 호출 상한은 공통 호출기가 지킨다
  const [quarterly, history, annual, disclosures] = await Promise.all([
    attempt(
      () => ensureCompanyFinancials(company, addQuarters(latest, -(QUARTERS - 1)), latest, io),
      notes,
      "분기 재무를 받지 못했습니다",
    ),
    attempt(
      () => loadPriceHistory(company.stockCode, { ...io, now: clock }),
      notes,
      "주가를 받지 못해 주가·밸류에이션 일부를 계산하지 못했습니다",
    ),
    attempt(
      () => loadAnnualFinancials(company.corpCode, company.fiscalMonth, { ...io, now: clock }),
      notes,
      "사업보고서 재무를 받지 못했습니다",
    ),
    attempt(() => recentDisclosures(company, now, io), notes, "최근 공시를 받지 못했습니다"),
  ]);
  externalCalls +=
    (quarterly?.externalCalls ?? 0) + (history?.externalCalls ?? 0) + (annual?.externalCalls ?? 0);

  const latestAnnual = annual?.annual.at(-1) ?? null;
  const [shareholder, dividend, yearEnd, peers] = await Promise.all([
    annual?.latest
      ? attempt(
          () => loadShareholder(company.corpCode, annual.latest!, { ...io, now: clock }),
          notes,
          "최대주주 현황을 받지 못했습니다",
        )
      : null,
    latestAnnual
      ? attempt(
          () => loadDividend(company.corpCode, latestAnnual, { ...io, now: clock }),
          notes,
          "배당 정보를 받지 못했습니다",
        )
      : null,
    annual
      ? attempt(
          () => yearEndValuations(company, annual.annual, { ...io, now: clock }),
          notes,
          "과거 사업연도 말 주가를 받지 못했습니다",
        )
      : null,
    withTimeout(
      peerValuations(company, latest, options.peers, { ...io, now: clock }).catch((err) => {
        console.warn(`[report] 경쟁사 비교 실패 (${company.name})`, err);
        const error = err instanceof Error ? err.message : String(err);
        return { rows: [] as PeerRow[], externalCalls: 0, error };
      }),
      PEER_TIME_BUDGET_MS,
    ),
  ]);
  externalCalls +=
    (shareholder?.externalCalls ?? 0) +
    (dividend?.externalCalls ?? 0) +
    (yearEnd?.externalCalls ?? 0) +
    (peers?.externalCalls ?? 0);
  if (peers === null) {
    notes.push("경쟁사 비교는 시간이 오래 걸려 이번에는 빼었습니다 (다음 조회 때 나옵니다)");
  } else if (peers.error) {
    notes.push(`경쟁사를 고르지 못해 경쟁사 비교를 빼었습니다 — ${peers.error}`);
  }

  const stats = history ? priceStats(history.days) : null;
  if (history && !stats) notes.push("최근 1년 거래 기록이 없습니다 (거래정지 등)");
  if (history?.stale && stats) {
    notes.push(
      `주가를 새로 받지 못해 저장된 ${stats.last.date} 종가로 주가·밸류에이션을 계산했습니다`,
    );
  }

  const builder = new ReportBuilder(company, stats);
  const profile = builder.profile(shareholder?.fact ?? null, dividend?.fact ?? null);
  const price = builder.price(history?.days ?? [], stats);
  const fin = builder.financials(quarterly, latest, annual);
  const valuation = builder.valuation({
    fin,
    dividend: dividend?.fact ?? null,
    yearEnd: yearEnd?.points ?? [],
    peers: peers?.rows ?? [],
  });
  const events: ReportSection = {
    id: "events",
    title: "최근 12개월 중요 공시",
    facts: [],
    charts: [],
    notes: disclosures && disclosures.length === 0 ? ["최근 12개월 중요 공시가 없습니다"] : [],
  };

  const report: CompanyReport = {
    company,
    asOf: now.toISOString(),
    priceDate: stats?.last.date ?? null,
    highlights: builder.highlights(fin, valuation.figures, shareholder?.fact ?? null),
    sections: [profile, price, fin.section, valuation.section, events],
    keyFigureIds: builder.keyFigureIds(),
    disclosures: (disclosures ?? []).slice(0, 12),
    notes,
  };

  const summary = [
    `주가 ${history?.days.length ?? 0}거래일`,
    `사업보고서 ${annual?.annual.length ?? 0}개`,
    `분기 ${fin.quarterCount}개`,
    `경쟁사 ${peers?.rows.length ?? 0}곳`,
    `공시 ${report.disclosures.length}건`,
    `숫자 ${Object.keys(builder.figures).length}개`,
    `외부 호출 ${externalCalls}건`,
    ...(notes.length > 0 ? [`빠진 것 ${notes.length}`] : []),
  ].join(" · ");
  return { report, figures: builder.figures, externalCalls, summary };
}

// ── 수집 보조 ───────────────────────────────────────────────────────────────

async function attempt<T>(fn: () => Promise<T>, notes: string[], note: string): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    console.warn(`[report] ${note}`, err);
    notes.push(note);
    return null;
  }
}

/** 시간 안에 끝나지 않으면 null (진행 중인 수집은 그대로 끝까지 돌아 캐시를 채운다) */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

interface Io {
  client: SupabaseClient;
  userId: string | null;
  analysisId: string | null;
  now: () => Date;
}

/** 오늘까지 최근 4개 달력 분기의 중요 공시 */
async function recentDisclosures(
  company: CompanyRef,
  now: Date,
  io: Omit<Io, "now">,
): Promise<Disclosure[]> {
  const kst = new Date(now.getTime() + 9 * 3_600_000);
  const current = formatQuarter(
    kst.getUTCFullYear(),
    (Math.floor(kst.getUTCMonth() / 3) + 1) as 1 | 2 | 3 | 4,
  );
  const list = await fetchEventDisclosures(
    company,
    {
      from: addQuarters(current, -3),
      to: current,
      specified: false,
      reason: "투자 리포트",
      clipped: false,
    },
    io,
  );
  const cutoff = todayKst(new Date(now.getTime() - 365 * 86_400_000));
  return list.filter((d) => d.date >= cutoff).sort((a, b) => b.date.localeCompare(a.date));
}

interface YearEndPoint {
  fiscalYear: number;
  date: string;
  cap: bigint;
  per: number | null;
  pbr: number | null;
}

/** 지난 사업연도 말(결산일 이전 마지막 거래일) 시가총액으로 그해 PER·PBR — 과거 평균과 비교하려고 */
async function yearEndValuations(
  company: CompanyRef,
  annual: AnnualReport[],
  io: Io,
): Promise<{ points: YearEndPoint[]; externalCalls: number }> {
  // 사업연도마다 한 번 (처음이면 주가 API 1회씩 — 함께 부른다. 지난 날짜 가격은 저장해 두고 다시 부르지 않는다)
  const loaded = await Promise.all(
    annual.map(async (report) => {
      const date = fiscalYearEnd(report.fiscalYear, company.fiscalMonth);
      return {
        report,
        date,
        prices: await loadPrices([company.stockCode], { kind: "asOf", date }, io),
      };
    }),
  );
  let externalCalls = 0;
  const points: YearEndPoint[] = [];
  for (const { report, date, prices } of loaded) {
    externalCalls += prices.externalCalls;
    const row = prices.rows
      .filter((r) => r.stockCode === company.stockCode && r.baseDate <= date)
      .sort((a, b) => a.baseDate.localeCompare(b.baseDate))
      .at(-1);
    if (!row || row.listedShares == null) continue;
    const cap = row.closePrice * row.listedShares;
    const ni = big(report.values.owners_net_income ?? report.values.net_income);
    const eq = big(report.values.owners_equity ?? report.values.equity);
    points.push({
      fiscalYear: report.fiscalYear,
      date: row.baseDate,
      cap,
      per: ni !== null && ni > BigInt(0) ? Number(cap) / Number(ni) : null,
      pbr: eq !== null && eq > BigInt(0) ? Number(cap) / Number(eq) : null,
    });
  }
  return { points, externalCalls };
}

/** 회계연도(시작한 해)의 결산일 "YYYY-MM-DD" */
export function fiscalYearEnd(fiscalYear: number, accMt: number): string {
  const endYear = accMt === 12 ? fiscalYear : fiscalYear + 1;
  const d = new Date(Date.UTC(endYear, accMt, 0));
  return d.toISOString().slice(0, 10);
}

interface PeerRow {
  company: CompanyRef;
  cap: Computed<bigint>;
  per: Computed<number>;
  pbr: Computed<number>;
  roe: Computed<number>;
  operatingMargin: Computed<number>;
  quarter: Quarter | null;
}

async function peerValuations(
  company: CompanyRef,
  latest: Quarter,
  given: CompanyRef[] | undefined,
  io: Io,
): Promise<{ rows: PeerRow[]; externalCalls: number; error?: string }> {
  let externalCalls = 0;
  let peers = (given ?? []).slice(0, PEER_COUNT);
  if (peers.length === 0) {
    const picked = await pickPeers(company, PEER_COUNT, io);
    externalCalls += picked.externalCalls;
    peers = picked.peers;
  }
  if (peers.length === 0) return { rows: [], externalCalls };
  const all = [company, ...peers];
  const [financials, prices] = await Promise.all([
    Promise.all(all.map((c) => ensureCompanyFinancials(c, addQuarters(latest, -4), latest, io))),
    loadPrices(
      all.map((c) => c.stockCode),
      { kind: "latest" },
      io,
    ),
  ]);
  externalCalls +=
    prices.externalCalls + financials.reduce((n, f) => n + (f.externalCalls ?? 0), 0);
  const rows = all.map((c, i) => {
    const q = latestWith(financials[i], latest, 5, (m) => m.ttm_owners_ni.value !== null);
    const m = q ? financials[i].metricsByQuarter.get(q)!.metrics : null;
    const price = prices.rows
      .filter((r) => r.stockCode === c.stockCode)
      .sort((a, b) => a.baseDate.localeCompare(b.baseDate))
      .at(-1);
    const cap = marketCap(price?.closePrice, price?.listedShares);
    const missing = { value: null, reason: "MISSING_ACCOUNT" as const };
    return {
      company: c,
      cap,
      per: per(cap, m?.ttm_owners_ni ?? missing),
      pbr: pbr(cap, m?.owners_equity ?? missing),
      roe: m?.roe ?? missing,
      operatingMargin: m?.operating_margin ?? missing,
      quarter: q,
    };
  });
  return { rows, externalCalls };
}

/** `latest`부터 거슬러 올라가며 조건을 만족하는 가장 최근 분기 (보고서가 아직 없는 분기는 건너뛴다) */
function latestWith(
  financials: CompanyFinancials,
  latest: Quarter,
  lookback: number,
  ok: (m: CalendarQuarterMetrics) => boolean,
): Quarter | null {
  for (let i = 0; i < lookback; i += 1) {
    const q = addQuarters(latest, -i);
    const row = financials.metricsByQuarter.get(q);
    if (row && ok(row.metrics)) return q;
  }
  return null;
}

function big(v: string | undefined): bigint | null {
  return v === undefined ? null : BigInt(v);
}

// ── 숫자·칸 만들기 ──────────────────────────────────────────────────────────

interface FinancialsPart {
  section: ReportSection;
  quarterCount: number;
  /** 밸류에이션에 쓰는 값 */
  ttmRevenue: Computed<bigint>;
  ttmOwnersNi: Computed<bigint>;
  ownersEquity: Computed<bigint>;
  operatingCashFlow: bigint | null;
  latestEps: number | null;
  roe: Figure | null;
  /** 기준 분기·사업연도 (각주용) */
  baseQuarter: Quarter | null;
  baseFiscalYear: number | null;
  fsDiv: "CFS" | "OFS";
}

class ReportBuilder {
  private readonly allocator = createFigureAllocator(REPORT_FIGURE_START);
  private readonly keyIds = new Set<string>();
  private chartSeq = 0;

  constructor(
    private readonly company: CompanyRef,
    private readonly stats: PriceStats | null,
  ) {}

  get figures(): Record<string, Figure> {
    return this.allocator.figures;
  }

  keyFigureIds(): string[] {
    return [...this.keyIds];
  }

  private add(input: AddFigureInput, key = true): Figure {
    const figure = this.allocator.add(input);
    if (key) this.keyIds.add(figure.id);
    return figure;
  }

  private priceBasis(): Figure["basis"] {
    return {
      report: PRICE_BASIS,
      fsDiv: "CFS",
      ...(this.stats ? { priceDate: this.stats.last.date } : {}),
    };
  }

  private chartId(): string {
    this.chartSeq += 1;
    return `r${this.chartSeq}`;
  }

  /** 원 단위 가격 "1,776,000원" (formatKrw는 만 원 아래를 버린다) */
  private won(label: string, value: number | null, basis: Figure["basis"], key = true): Figure {
    return this.add(
      {
        label,
        unit: "KRW",
        value: value === null ? null : Math.round(value),
        ...(value === null
          ? { reason: "NO_PRICE" as const }
          : { displayText: `${Math.round(value).toLocaleString("ko-KR")}원` }),
        basis,
      },
      key,
    );
  }

  private krw(
    label: string,
    value: bigint | null,
    basis: Figure["basis"],
    reason: AddFigureInput["reason"] = "MISSING_ACCOUNT",
    key = true,
  ): Figure {
    return this.add(
      value === null
        ? { label, unit: "KRW", value: null, reason, basis }
        : { label, unit: "KRW", value, basis },
      key,
    );
  }

  /** 증감·수익률처럼 부호가 뜻 있는 % */
  private change(
    label: string,
    value: number | null,
    basis: Figure["basis"],
    reason: AddFigureInput["reason"] = "NO_PREV_PERIOD",
    key = true,
  ): Figure {
    return this.add(
      value === null
        ? { label, unit: "PERCENT", value: null, reason, basis }
        : { label, unit: "PERCENT", value, basis },
      key,
    );
  }

  /** 비율 % (부호 없이 "12.34%") */
  private ratio(
    label: string,
    value: number | null,
    basis: Figure["basis"],
    reason: AddFigureInput["reason"] = "MISSING_ACCOUNT",
    key = true,
  ): Figure {
    return this.add(
      value === null
        ? { label, unit: "PERCENT", value: null, reason, basis }
        : {
            label,
            unit: "PERCENT",
            value,
            displayText: `${round(value, 2).toLocaleString("ko-KR")}%`,
            basis,
          },
      key,
    );
  }

  private times(label: string, c: Computed<number>, basis: Figure["basis"], key = true): Figure {
    return this.add(
      c.value === null
        ? {
            label,
            unit: "TIMES",
            value: null,
            reason: c.reason,
            ...(c.reason === "DEFICIT"
              ? { displayText: "적자" }
              : c.reason === "CAPITAL_IMPAIRMENT"
                ? { displayText: "자본잠식" }
                : {}),
            basis,
          }
        : { label, unit: "TIMES", value: c.value, basis },
      key,
    );
  }

  private shares(
    label: string,
    value: number | null,
    basis: Figure["basis"],
    unitWord = "주",
    key = true,
  ): Figure {
    return this.add(
      value === null
        ? { label, unit: "COUNT", value: null, reason: "NO_PRICE", basis }
        : { label, unit: "COUNT", value, displayText: `${koreanCount(value)}${unitWord}`, basis },
      key,
    );
  }

  private fact(label: string, figure: Figure, note?: string): ReportFact {
    return { label, figureId: figure.id, ...(note ? { note } : {}) };
  }

  // ① 기본정보
  profile(shareholder: ShareholderFact | null, dividend: DividendFact | null): ReportSection {
    const c = this.company;
    const facts: ReportFact[] = [
      { label: "종목", text: `${c.name} (${c.stockCode})` },
      { label: "시장", text: c.market },
      {
        label: "업종(섹터)",
        text: c.sector?.name ?? "미분류",
        note: c.sector?.source === "manual" ? "직접 지정" : "업종코드 기준",
      },
      { label: "결산월", text: `${c.fiscalMonth}월` },
    ];
    const s = this.stats;
    if (s) {
      facts.push(
        this.fact(
          "시가총액",
          this.krw(`${c.name} 시가총액`, BigInt(Math.round(s.last.marketCap)), this.priceBasis()),
        ),
      );
      facts.push(
        this.fact(
          "상장주식수",
          this.shares(`${c.name} 상장주식수`, s.last.listedShares, this.priceBasis()),
        ),
      );
    }
    if (shareholder) {
      const basis = { report: "최대주주 현황 (정기보고서)", fsDiv: "CFS" as const };
      facts.push({ label: "최대주주", text: shareholder.name });
      facts.push(
        this.fact("최대주주 지분율", this.ratio("최대주주 지분율", shareholder.ratio, basis)),
      );
      if (shareholder.totalWithRelated !== null) {
        facts.push(
          this.fact(
            "특수관계인 포함 지분율",
            this.ratio("최대주주·특수관계인 지분율", shareholder.totalWithRelated, basis),
            shareholder.relatedCount > 0
              ? `특수관계인 ${shareholder.relatedCount}명 포함`
              : undefined,
          ),
        );
      }
    }
    if (dividend?.dps != null) {
      facts.push(
        this.fact(
          "주당 현금배당금",
          this.won("주당 현금배당금", dividend.dps, {
            report: "배당에 관한 사항 (사업보고서)",
            fsDiv: "CFS",
          }),
        ),
      );
    }
    return { id: "profile", title: "기본 정보", facts, charts: [], notes: [] };
  }

  // ② 주가·거래
  price(days: readonly DailyPrice[], s: PriceStats | null): ReportSection {
    const c = this.company;
    if (!s)
      return {
        id: "price",
        title: "주가·거래",
        facts: [],
        charts: [],
        notes: ["주가 정보가 없습니다"],
      };
    const b = this.priceBasis();
    const l = s.last;
    const facts: ReportFact[] = [
      this.fact("현재가", this.won(`${c.name} 현재가`, l.close, b), `${l.date} 종가`),
      this.fact("등락률", this.change(`${c.name} 전일 대비 등락률`, l.changeRate, b)),
      this.fact(
        "시가 / 고가 / 저가",
        this.won(`${c.name} 시가`, l.open, b, false),
        `고가 ${l.high.toLocaleString("ko-KR")}원 · 저가 ${l.low.toLocaleString("ko-KR")}원`,
      ),
      this.fact("거래량", this.shares(`${c.name} 거래량`, l.volume, b)),
      this.fact("거래대금", this.krw(`${c.name} 거래대금`, BigInt(Math.round(l.tradeValue)), b)),
      this.fact("52주 최고가", this.won(`${c.name} 52주 최고가`, s.high52.price, b), s.high52.date),
      this.fact("52주 최저가", this.won(`${c.name} 52주 최저가`, s.low52.price, b), s.low52.date),
      this.fact(
        "52주 범위 위치",
        this.ratio(`${c.name} 52주 범위 위치`, s.rangePosition, b),
        "0% = 52주 최저, 100% = 52주 최고",
      ),
      this.fact(
        "연율 변동성",
        this.ratio(`${c.name} 연율 변동성`, s.volatility, b, "NO_PREV_PERIOD"),
        "최근 1년 일간 수익률 표준편차 × √252",
      ),
    ];
    if (s.volumeRatio20 !== null) {
      facts.push(
        this.fact(
          "최근 20일 거래량",
          this.times(`${c.name} 최근 20일 평균 거래량 ÷ 1년 평균`, { value: s.volumeRatio20 }, b),
          "1년 평균 거래량 대비 배수",
        ),
      );
    }

    const weeks = weeklyCloses(days);
    const big = l.close >= 10_000;
    const closeSeries = weeks.map((w) => ({
      x: w.week.slice(2).replaceAll("-", "."),
      figureId: this.won(
        `${c.name} 주간 종가 ${w.day.date}`,
        w.day.close,
        { ...b, priceDate: w.day.date },
        false,
      ).id,
    }));
    const volumeSeries = weeks.map((w) => ({
      x: w.week.slice(2).replaceAll("-", "."),
      figureId: this.shares(`${c.name} 주간 거래량 ${w.week}`, w.volume, b, "주", false).id,
    }));
    const returnLabels: [keyof PriceStats["returns"], string][] = [
      ["m1", "1개월"],
      ["m3", "3개월"],
      ["m6", "6개월"],
      ["y1", "1년"],
      ["ytd", "연초 대비"],
    ];
    const returnPoints = returnLabels.map(([key, label]) => ({
      x: label,
      figureId: this.change(`${c.name} ${label} 수익률`, s.returns[key], b).id,
    }));
    const charts: Chart[] = [
      lineChart(
        this.chartId(),
        `${c.name} 주가 (최근 1년, 주간 종가)`,
        [{ key: "close", label: "종가", unit: "KRW", points: closeSeries }],
        big ? "만 원" : "원",
        "주",
      ),
      barChart(
        this.chartId(),
        `${c.name} 기간 수익률`,
        [{ key: "change_return", label: "수익률", unit: "PERCENT", points: returnPoints }],
        "%",
        "기간",
      ),
      barChart(
        this.chartId(),
        `${c.name} 주간 거래량 (최근 1년)`,
        [{ key: "volume", label: "거래량", unit: "COUNT", points: volumeSeries }],
        // 주간 거래량은 수백만~수억 주라 축 글자가 잘린다 — 만 주 단위로
        Math.max(0, ...weeks.map((w) => w.volume)) >= 100_000 ? "만 주" : "주",
        "주",
      ),
    ];
    return {
      id: "price",
      title: "주가·거래",
      facts,
      charts,
      notes: ["외국인·기관 순매수, 공매도는 제공하지 않습니다 (무료 공공 데이터에 없음)"],
    };
  }

  // ③ 재무·실적
  financials(
    quarterly: CompanyFinancials | null,
    latest: Quarter,
    annual: AnnualFinancials | null,
  ): FinancialsPart {
    const c = this.company;
    const facts: ReportFact[] = [];
    const charts: Chart[] = [];
    const notes: string[] = [];
    const missing = { value: null, reason: "MISSING_ACCOUNT" as const };

    // 분기 실적 — 보고서가 있는 가장 최근 분기
    const baseQuarter = quarterly
      ? latestWith(
          quarterly,
          latest,
          4,
          (m) => m.revenue.value !== null || m.operating_income.value !== null,
        )
      : null;
    const at = (q: Quarter) => quarterly?.metricsByQuarter.get(q)?.metrics;
    const fsDiv = (baseQuarter && quarterly?.metricsByQuarter.get(baseQuarter)?.fs_div) || "CFS";
    let quarterCount = 0;
    let ttmRevenue: Computed<bigint> = missing;
    let ttmOwnersNi: Computed<bigint> = missing;
    let ownersEquity: Computed<bigint> = missing;
    let roeFigure: Figure | null = null;

    if (quarterly && baseQuarter) {
      const qb = { report: `${baseQuarter} 분기 실적 (정기보고서)`, fsDiv: fsDiv as "CFS" | "OFS" };
      const m = at(baseQuarter)!;
      const prevQ = at(addQuarters(baseQuarter, -1));
      const lastYear = at(addQuarters(baseQuarter, -4));
      const changeFigure = (label: string, r: ReturnType<typeof yoy>) =>
        "signChange" in r
          ? this.add({ label, unit: "PERCENT", value: null, displayText: r.signChange, basis: qb })
          : this.change(label, r.value, qb, r.reason ?? "NO_PREV_PERIOD");
      facts.push(
        this.fact(
          `매출 (${baseQuarter})`,
          this.krw(`${c.name} 매출 ${baseQuarter}`, m.revenue.value, qb, m.revenue.reason),
        ),
      );
      facts.push(
        this.fact(
          "매출 YoY",
          changeFigure(`${c.name} 매출 YoY ${baseQuarter}`, yoy(m.revenue, lastYear?.revenue)),
        ),
      );
      facts.push(
        this.fact(
          `영업이익 (${baseQuarter})`,
          this.krw(
            `${c.name} 영업이익 ${baseQuarter}`,
            m.operating_income.value,
            qb,
            m.operating_income.reason,
          ),
        ),
      );
      facts.push(
        this.fact(
          "영업이익 YoY",
          changeFigure(
            `${c.name} 영업이익 YoY ${baseQuarter}`,
            yoy(m.operating_income, lastYear?.operating_income, true),
          ),
        ),
      );
      facts.push(
        this.fact(
          "영업이익 QoQ",
          changeFigure(
            `${c.name} 영업이익 QoQ ${baseQuarter}`,
            qoq(m.operating_income, prevQ?.operating_income, true),
          ),
        ),
      );
      facts.push(
        this.fact(
          `순이익 (${baseQuarter})`,
          this.krw(
            `${c.name} 당기순이익 ${baseQuarter}`,
            m.net_income.value,
            qb,
            m.net_income.reason,
          ),
        ),
      );
      facts.push(
        this.fact(
          "순이익 YoY",
          changeFigure(
            `${c.name} 당기순이익 YoY ${baseQuarter}`,
            yoy(m.net_income, lastYear?.net_income, true),
          ),
        ),
      );
      facts.push(
        this.fact(
          "영업이익률",
          this.ratio(
            `${c.name} 영업이익률 ${baseQuarter}`,
            m.operating_margin.value,
            qb,
            m.operating_margin.reason,
          ),
        ),
      );
      roeFigure = this.ratio(`${c.name} ROE (TTM)`, m.roe.value, qb, m.roe.reason);
      facts.push(
        this.fact("ROE (최근 4개 분기)", roeFigure, "TTM 지배주주 순이익 ÷ 평균 지배주주지분"),
      );
      facts.push(
        this.fact(
          "부채비율",
          this.ratio(
            `${c.name} 부채비율 ${baseQuarter}말`,
            m.debt_ratio.value,
            qb,
            m.debt_ratio.reason,
          ),
        ),
      );

      // TTM (밸류에이션용)
      const four = [0, 1, 2, 3].map((i) => at(addQuarters(baseQuarter, -i)));
      ttmRevenue = sumComputed(four.map((x) => x?.revenue));
      ttmOwnersNi = m.ttm_owners_ni;
      ownersEquity = m.owners_equity;

      // 분기 추이 차트 (최근 8분기)
      const shown = Array.from({ length: SHOWN_QUARTERS }, (_, i) =>
        addQuarters(baseQuarter, -(SHOWN_QUARTERS - 1 - i)),
      );
      const qRev = shown.map((q) => ({
        x: q,
        figureId: this.krw(
          `${c.name} 매출 ${q}`,
          at(q)?.revenue.value ?? null,
          qb,
          at(q)?.revenue.reason ?? "NO_REPORT",
          false,
        ).id,
      }));
      const qOp = shown.map((q) => ({
        x: q,
        figureId: this.krw(
          `${c.name} 영업이익 ${q}`,
          at(q)?.operating_income.value ?? null,
          qb,
          at(q)?.operating_income.reason ?? "NO_REPORT",
          false,
        ).id,
      }));
      const qMargin = shown.map((q) => ({
        x: q,
        figureId: this.ratio(
          `${c.name} 영업이익률 ${q}`,
          at(q)?.operating_margin.value ?? null,
          qb,
          at(q)?.operating_margin.reason ?? "NO_REPORT",
          false,
        ).id,
      }));
      quarterCount = shown.filter((q) => at(q)?.revenue.value != null).length;
      const scale = krwAxis([...qRev, ...qOp].map((p) => this.figures[p.figureId].value));
      charts.push(
        barChart(
          this.chartId(),
          `${c.name} 분기 실적 (최근 ${SHOWN_QUARTERS}분기)`,
          [
            { key: "revenue", label: "매출", unit: "KRW", points: qRev },
            { key: "operating_income", label: "영업이익", unit: "KRW", points: qOp },
          ],
          scale,
          "분기",
        ),
      );
      charts.push(
        lineChart(
          this.chartId(),
          `${c.name} 분기 영업이익률`,
          [{ key: "operating_margin", label: "영업이익률", unit: "PERCENT", points: qMargin }],
          "%",
          "분기",
        ),
      );
    } else {
      notes.push("분기 실적이 없습니다");
    }

    // 사업연도 추이 (최근 5개 사업보고서) — 손익·현금흐름·재무 안정성
    let operatingCashFlow: bigint | null = null;
    let latestEps: number | null = null;
    let baseFiscalYear: number | null = null;
    const years = annual?.annual ?? [];
    if (years.length > 0) {
      const label = (r: AnnualReport) =>
        c.fiscalMonth === 12 ? `${r.fiscalYear}` : `FY${r.fiscalYear}`;
      const ab = (r: AnnualReport) => ({ report: `${r.bsnsYear} 사업보고서`, fsDiv: r.fsDiv });
      const series = (key: keyof AnnualReport["values"], name: string) =>
        years.map((r) => ({
          x: label(r),
          figureId: this.krw(`${c.name} ${name} ${label(r)}`, big(r.values[key]), ab(r)).id,
        }));
      const rev = series("revenue", "연간 매출");
      const op = series("operating_income", "연간 영업이익");
      const ni = series("net_income", "연간 당기순이익");
      charts.push(
        barChart(
          this.chartId(),
          `${c.name} 연간 실적 (최근 ${years.length}개 사업연도)`,
          [
            { key: "revenue", label: "매출", unit: "KRW", points: rev },
            { key: "operating_income", label: "영업이익", unit: "KRW", points: op },
            { key: "net_income", label: "당기순이익", unit: "KRW", points: ni },
          ],
          krwAxis([...rev, ...op, ...ni].map((p) => this.figures[p.figureId].value)),
          "사업연도",
        ),
      );

      // 수익성·안정성 (사업연도)
      const pct = (num: bigint | null, den: bigint | null) =>
        num === null || den === null || den === BigInt(0)
          ? null
          : (Number(num) / Number(den)) * 100;
      const avg = (a: bigint | null, b: bigint | null) =>
        a === null ? null : b === null ? a : (a + b) / BigInt(2);
      const margins = years.map((r, i) => {
        const prev = years[i - 1];
        const v = r.values;
        return {
          r,
          op: pct(big(v.operating_income), big(v.revenue)),
          net: pct(big(v.net_income), big(v.revenue)),
          roe: pct(
            big(v.owners_net_income ?? v.net_income),
            avg(
              big(v.owners_equity ?? v.equity),
              prev ? big(prev.values.owners_equity ?? prev.values.equity) : null,
            ),
          ),
          roa: pct(big(v.net_income), avg(big(v.assets), prev ? big(prev.values.assets) : null)),
          debt: pct(big(v.liabilities), big(v.equity)),
          current: pct(big(v.current_assets), big(v.current_liabilities)),
        };
      });
      const line = (
        key: "op" | "net" | "roe" | "roa" | "debt" | "current",
        name: string,
        keyFigure = false,
      ) =>
        margins.map((m) => ({
          x: label(m.r),
          figureId: this.ratio(
            `${c.name} ${name} ${label(m.r)}`,
            m[key],
            ab(m.r),
            "MISSING_ACCOUNT",
            keyFigure,
          ).id,
        }));
      charts.push(
        lineChart(
          this.chartId(),
          `${c.name} 수익성 (사업연도)`,
          [
            {
              key: "operating_margin",
              label: "영업이익률",
              unit: "PERCENT",
              points: line("op", "영업이익률", true),
            },
            {
              key: "net_margin",
              label: "순이익률",
              unit: "PERCENT",
              points: line("net", "순이익률"),
            },
            { key: "roe", label: "ROE", unit: "PERCENT", points: line("roe", "ROE", true) },
          ],
          "%",
          "사업연도",
        ),
      );

      // 현금흐름: 영업현금흐름·설비투자(유형+무형)·잉여현금흐름
      const capexOf = (r: AnnualReport) => {
        const t = big(r.values.capex_tangible);
        const i = big(r.values.capex_intangible);
        return t === null && i === null ? null : (t ?? BigInt(0)) + (i ?? BigInt(0));
      };
      const ocf = years.map((r) => ({
        x: label(r),
        figureId: this.krw(
          `${c.name} 영업현금흐름 ${label(r)}`,
          big(r.values.operating_cash_flow),
          ab(r),
        ).id,
      }));
      const capex = years.map((r) => ({
        x: label(r),
        figureId: this.krw(`${c.name} 설비투자 ${label(r)}`, capexOf(r), ab(r)).id,
      }));
      const fcf = years.map((r) => {
        const o = big(r.values.operating_cash_flow);
        const cx = capexOf(r);
        return {
          x: label(r),
          figureId: this.krw(
            `${c.name} 잉여현금흐름 ${label(r)}`,
            o === null || cx === null ? null : o - cx,
            ab(r),
          ).id,
        };
      });
      charts.push(
        barChart(
          this.chartId(),
          `${c.name} 현금흐름 (사업연도)`,
          [
            { key: "operating_cash_flow", label: "영업현금흐름", unit: "KRW", points: ocf },
            { key: "capex", label: "설비투자", unit: "KRW", points: capex },
            { key: "fcf", label: "잉여현금흐름", unit: "KRW", points: fcf },
          ],
          krwAxis([...ocf, ...capex, ...fcf].map((p) => this.figures[p.figureId].value)),
          "사업연도",
        ),
      );

      const currentPoints = line("current", "유동비율", true);
      charts.push(
        lineChart(
          this.chartId(),
          `${c.name} 재무 안정성 (사업연도 말)`,
          [
            {
              key: "debt_ratio",
              label: "부채비율",
              unit: "PERCENT",
              points: line("debt", "부채비율", true),
            },
            { key: "current_ratio", label: "유동비율", unit: "PERCENT", points: currentPoints },
          ],
          "%",
          "사업연도",
        ),
      );

      const last = years.at(-1)!;
      baseFiscalYear = last.fiscalYear;
      operatingCashFlow = big(last.values.operating_cash_flow);
      latestEps = last.values.eps !== undefined ? Number(last.values.eps) : null;
      const lb = ab(last);
      if (latestEps !== null)
        facts.push(
          this.fact(
            `EPS (${label(last)})`,
            this.won(`${c.name} EPS ${label(last)}`, latestEps, lb),
            "기본주당순이익",
          ),
        );
      const lastM = margins.at(-1)!;
      facts.push(
        this.fact(
          `ROA (${label(last)})`,
          this.ratio(`${c.name} ROA ${label(last)}`, lastM.roa, lb),
        ),
      );
      if (lastM.current !== null) {
        facts.push(
          this.fact(`유동비율 (${label(last)}말)`, this.figures[currentPoints.at(-1)!.figureId]),
        );
      }
      // 매출 성장 (첫 해 → 마지막 해 연평균)
      const first = years[0];
      const r0 = big(first.values.revenue);
      const r1 = big(last.values.revenue);
      const span = last.fiscalYear - first.fiscalYear;
      if (r0 !== null && r1 !== null && r0 > BigInt(0) && r1 > BigInt(0) && span > 0) {
        const cagr = (Math.pow(Number(r1) / Number(r0), 1 / span) - 1) * 100;
        facts.push(
          this.fact(
            `매출 연평균 성장률 (${label(first)}→${label(last)})`,
            this.change(`${c.name} 매출 연평균 성장률 ${label(first)}~${label(last)}`, cagr, lb),
          ),
        );
      }
      // 최근 재무상태표 (분기 보고서) 유동비율
      const recent = annual?.latest;
      if (
        recent &&
        recent !== last &&
        recent.values.current_assets &&
        recent.values.current_liabilities
      ) {
        const cr = pct(big(recent.values.current_assets), big(recent.values.current_liabilities));
        facts.push(
          this.fact(
            "유동비율 (최근 분기말)",
            this.ratio(`${c.name} 유동비율 최근 분기말`, cr, {
              report: `${recent.bsnsYear} 정기보고서`,
              fsDiv: recent.fsDiv,
            }),
          ),
        );
      }
      if (c.sector?.isFinancial)
        notes.push(
          "금융업은 유동비율·영업이익률이 일반 기업과 뜻이 달라 비교에 주의하세요 (TECH §7)",
        );
    } else {
      notes.push("사업보고서 재무가 없어 연간 추이·현금흐름을 계산하지 못했습니다");
    }
    notes.push("사업부문별 매출 비중은 보고서 본문에만 있어 제공하지 않습니다");

    return {
      section: { id: "financials", title: "재무·실적", facts, charts, notes },
      quarterCount,
      ttmRevenue,
      ttmOwnersNi,
      ownersEquity,
      operatingCashFlow,
      latestEps,
      roe: roeFigure,
      baseQuarter,
      baseFiscalYear,
      fsDiv: fsDiv as "CFS" | "OFS",
    };
  }

  // ④ 밸류에이션
  valuation(input: {
    fin: FinancialsPart;
    dividend: DividendFact | null;
    yearEnd: YearEndPoint[];
    peers: PeerRow[];
  }): { section: ReportSection; figures: Record<string, Figure> } {
    const c = this.company;
    const s = this.stats;
    const { fin } = input;
    const facts: ReportFact[] = [];
    const charts: Chart[] = [];
    const notes: string[] = [];
    const named: Record<string, Figure> = {};
    const b = { ...this.priceBasis(), report: `${PRICE_BASIS} · ${fin.baseQuarter ?? "-"} 재무` };
    const cap: Computed<bigint> = s
      ? { value: BigInt(Math.round(s.last.marketCap)) }
      : { value: null, reason: "NO_PRICE" };

    named.per = this.times(`${c.name} PER`, per(cap, fin.ttmOwnersNi), b);
    named.pbr = this.times(`${c.name} PBR`, pbr(cap, fin.ownersEquity), b);
    named.psr = this.times(`${c.name} PSR`, multipleOf(cap, fin.ttmRevenue), b);
    named.pcr = this.times(
      `${c.name} PCR`,
      multipleOf(
        cap,
        fin.operatingCashFlow === null
          ? { value: null, reason: "MISSING_ACCOUNT" }
          : { value: fin.operatingCashFlow },
      ),
      b,
    );
    facts.push(this.fact("PER", named.per, "시가총액 ÷ 최근 4개 분기 지배주주 순이익"));
    facts.push(this.fact("PBR", named.pbr, "시가총액 ÷ 최근 분기말 지배주주지분"));
    facts.push(this.fact("PSR", named.psr, "시가총액 ÷ 최근 4개 분기 매출"));
    facts.push(
      this.fact(
        "PCR",
        named.pcr,
        `시가총액 ÷ ${fin.baseFiscalYear ?? "최근"} 사업연도 영업현금흐름`,
      ),
    );
    const dps = input.dividend?.dps ?? null;
    if (s && dps !== null) {
      named.dividendYield = this.ratio(
        `${c.name} 배당수익률 (현재가 기준)`,
        (dps / s.last.close) * 100,
        b,
      );
      facts.push(
        this.fact(
          "배당수익률",
          named.dividendYield,
          `최근 사업연도 주당 배당금 ${dps.toLocaleString("ko-KR")}원 ÷ 현재가`,
        ),
      );
    }
    if (input.dividend?.payoutRatio != null) {
      facts.push(
        this.fact(
          "배당성향",
          this.ratio(`${c.name} 배당성향`, input.dividend.payoutRatio, {
            report: "배당에 관한 사항 (사업보고서)",
            fsDiv: "CFS",
          }),
          "연결 현금배당성향",
        ),
      );
    }

    // 과거 사업연도 말 PER·PBR과 비교
    const yearsWithPer = input.yearEnd.filter((p) => p.per !== null);
    const yearsWithPbr = input.yearEnd.filter((p) => p.pbr !== null);
    const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
    if (yearsWithPer.length >= 2) {
      const avgPer = mean(yearsWithPer.map((p) => p.per!));
      named.avgPer = this.times(
        `${c.name} 과거 평균 PER (${yearsWithPer.length}개 사업연도 말)`,
        { value: avgPer },
        b,
      );
      facts.push(
        this.fact(
          `과거 평균 PER (${yearsWithPer.length}년)`,
          named.avgPer,
          "흑자였던 사업연도 말 PER 평균",
        ),
      );
      if (named.per.value !== null) {
        named.perVsAvg = this.change(
          `${c.name} 현재 PER의 과거 평균 대비 차이`,
          ((named.per.value - avgPer) / avgPer) * 100,
          b,
        );
        facts.push(this.fact("현재 PER vs 과거 평균", named.perVsAvg));
      }
    }
    if (yearsWithPbr.length >= 2) {
      const avgPbr = mean(yearsWithPbr.map((p) => p.pbr!));
      named.avgPbr = this.times(
        `${c.name} 과거 평균 PBR (${yearsWithPbr.length}개 사업연도 말)`,
        { value: avgPbr },
        b,
      );
      facts.push(this.fact(`과거 평균 PBR (${yearsWithPbr.length}년)`, named.avgPbr));
      if (named.pbr.value !== null) {
        named.pbrVsAvg = this.change(
          `${c.name} 현재 PBR의 과거 평균 대비 차이`,
          ((named.pbr.value - avgPbr) / avgPbr) * 100,
          b,
        );
        facts.push(this.fact("현재 PBR vs 과거 평균", named.pbrVsAvg));
      }
    }
    if (input.yearEnd.length > 0) {
      const label = (p: YearEndPoint) =>
        c.fiscalMonth === 12 ? `${p.fiscalYear}` : `FY${p.fiscalYear}`;
      const perPoints = input.yearEnd.map((p) => ({
        x: label(p),
        figureId: this.times(
          `${c.name} PER ${label(p)}말`,
          p.per === null ? { value: null, reason: "DEFICIT" } : { value: p.per },
          { ...b, priceDate: p.date },
          false,
        ).id,
      }));
      const pbrPoints = input.yearEnd.map((p) => ({
        x: label(p),
        figureId: this.times(
          `${c.name} PBR ${label(p)}말`,
          p.pbr === null ? { value: null, reason: "CAPITAL_IMPAIRMENT" } : { value: p.pbr },
          { ...b, priceDate: p.date },
          false,
        ).id,
      }));
      perPoints.push({ x: "현재", figureId: named.per.id });
      pbrPoints.push({ x: "현재", figureId: named.pbr.id });
      charts.push(
        lineChart(
          this.chartId(),
          `${c.name} PER·PBR 추이 (사업연도 말 → 현재)`,
          [
            { key: "per", label: "PER", unit: "TIMES", points: perPoints },
            { key: "pbr", label: "PBR", unit: "TIMES", points: pbrPoints },
          ],
          "배",
          "사업연도",
        ),
      );
    } else {
      notes.push("과거 사업연도 말 주가가 없어 과거 평균과 비교하지 못했습니다");
    }

    // 경쟁사 비교
    if (input.peers.length > 1) {
      const pb = (row: PeerRow) => ({
        report: `${PRICE_BASIS} · ${row.quarter ?? "-"} 재무`,
        fsDiv: "CFS" as const,
        ...(s ? { priceDate: s.last.date } : {}),
      });
      const own = input.peers[0];
      const rows = input.peers;
      const series = [
        {
          key: "market_cap",
          label: "시가총액",
          unit: "KRW" as Unit,
          points: rows.map((r) => ({
            x: r.company.name,
            figureId: this.krw(
              `${r.company.name} 시가총액 (비교)`,
              r.cap.value,
              pb(r),
              r.cap.reason ?? "NO_PRICE",
              r !== own,
            ).id,
          })),
        },
        {
          key: "per",
          label: "PER",
          unit: "TIMES" as Unit,
          points: rows.map((r) => ({
            x: r.company.name,
            figureId: this.times(`${r.company.name} PER (비교)`, r.per, pb(r), r !== own).id,
          })),
        },
        {
          key: "pbr",
          label: "PBR",
          unit: "TIMES" as Unit,
          points: rows.map((r) => ({
            x: r.company.name,
            figureId: this.times(`${r.company.name} PBR (비교)`, r.pbr, pb(r), r !== own).id,
          })),
        },
        {
          key: "roe",
          label: "ROE",
          unit: "PERCENT" as Unit,
          points: rows.map((r) => ({
            x: r.company.name,
            figureId: this.ratio(
              `${r.company.name} ROE (비교)`,
              r.roe.value,
              pb(r),
              r.roe.reason ?? "MISSING_ACCOUNT",
              r !== own,
            ).id,
          })),
        },
        {
          key: "operating_margin",
          label: "영업이익률",
          unit: "PERCENT" as Unit,
          points: rows.map((r) => ({
            x: r.company.name,
            figureId: this.ratio(
              `${r.company.name} 영업이익률 (비교)`,
              r.operatingMargin.value,
              pb(r),
              r.operatingMargin.reason ?? "MISSING_ACCOUNT",
              r !== own,
            ).id,
          })),
        },
      ];
      charts.push({
        id: this.chartId(),
        type: "table",
        title: `${c.name}와 경쟁사 밸류에이션 비교`,
        xAxisLabel: "기업",
        series,
        footnotes: [
          "경쟁사 = 질문의 비교 기업, 없으면 같은 섹터 시가총액 상위 3곳",
          "PER·PBR·ROE는 기업마다 최근 보고서 분기 기준",
        ],
        source: `${PRICE_BASIS} · DART 정기보고서`,
      });
      const peerOnly = rows.slice(1);
      // 평균은 배수가 아주 큰 한 곳(이익이 작은 기업)에 끌려가서 중앙값을 쓴다 — 적자·자본잠식은 뺀다
      const medianOf = (xs: (number | null)[]) => {
        const ok = xs.filter((x): x is number => x !== null).sort((a, b) => a - b);
        if (ok.length === 0) return null;
        const mid = Math.floor(ok.length / 2);
        return ok.length % 2 === 1 ? ok[mid] : (ok[mid - 1] + ok[mid]) / 2;
      };
      const peerPer = medianOf(peerOnly.map((r) => r.per.value));
      const peerPbr = medianOf(peerOnly.map((r) => r.pbr.value));
      const names = peerOnly.map((r) => r.company.name).join("·");
      if (peerPer !== null) {
        named.peerPer = this.times(`경쟁사 ${peerOnly.length}곳 PER 중앙값`, { value: peerPer }, b);
        facts.push(this.fact("경쟁사 PER 중앙값", named.peerPer, names));
      }
      if (peerPbr !== null) {
        named.peerPbr = this.times(`경쟁사 ${peerOnly.length}곳 PBR 중앙값`, { value: peerPbr }, b);
        facts.push(this.fact("경쟁사 PBR 중앙값", named.peerPbr, names));
      }
    }
    notes.push(
      "EV/EBITDA·컨센서스·목표주가·투자의견은 제공하지 않습니다 (무료 데이터에 없고, 투자 권유를 하지 않는 서비스 원칙)",
    );
    return {
      section: { id: "valuation", title: "밸류에이션", facts, charts, notes },
      figures: named,
    };
  }

  highlights(
    fin: FinancialsPart,
    v: Record<string, Figure>,
    shareholder: ShareholderFact | null,
  ): ReportFact[] {
    const find = (label: string) => Object.values(this.figures).find((f) => f.label === label);
    const c = this.company;
    const out: ReportFact[] = [];
    const push = (label: string, f: Figure | undefined | null, note?: string) => {
      if (f) out.push(this.fact(label, f, note));
    };
    const s = this.stats;
    push(
      "현재가",
      find(`${c.name} 현재가`),
      s
        ? `${s.last.changeRate >= 0 ? "+" : ""}${s.last.changeRate.toFixed(2)}% · ${s.last.date}`
        : undefined,
    );
    push("시가총액", find(`${c.name} 시가총액`));
    push("PER", v.per);
    push("PBR", v.pbr);
    push("ROE", fin.roe);
    push("배당수익률", v.dividendYield);
    push("1년 수익률", find(`${c.name} 1년 수익률`));
    if (s)
      out.push({
        label: "52주 범위",
        text: `${s.low52.price.toLocaleString("ko-KR")} ~ ${s.high52.price.toLocaleString("ko-KR")}원`,
        note: `현재 ${s.rangePosition.toFixed(0)}% 위치`,
      });
    if (shareholder)
      out.push({
        label: "최대주주",
        text: shareholder.name,
        ...(shareholder.ratio !== null ? { note: `${shareholder.ratio.toFixed(2)}%` } : {}),
      });
    return out;
  }
}

function multipleOf(cap: Computed<bigint>, denominator: Computed<bigint>): Computed<number> {
  if (cap.value === null) return { value: null, reason: cap.reason };
  if (denominator.value === null) return { value: null, reason: denominator.reason };
  if (denominator.value <= BigInt(0)) return { value: null, reason: "DEFICIT" };
  return { value: Number(cap.value) / Number(denominator.value) };
}

function sumComputed(xs: (Computed<bigint> | undefined)[]): Computed<bigint> {
  if (xs.some((x) => !x || x.value === null)) return { value: null, reason: "NO_PREV_PERIOD" };
  return { value: xs.reduce((a, x) => a + (x!.value as bigint), BigInt(0)) };
}

/** 금액 축 단위 — 가장 큰 값이 1조를 넘으면 "조 원", 1억을 넘으면 "억 원" */
function krwAxis(values: (number | null)[]): string {
  const max = Math.max(0, ...values.map((v) => Math.abs(v ?? 0)));
  if (max >= 1e12) return "조 원";
  if (max >= 1e8) return "억 원";
  return "원";
}

type SeriesInput = Chart["series"][number];

function barChart(
  id: string,
  title: string,
  series: SeriesInput[],
  yAxisLabel: string,
  xAxisLabel: string,
): Chart {
  return {
    id,
    type: "bar",
    title,
    xAxisLabel,
    yAxisLabel,
    series,
    footnotes: [],
    source: sourceOf(series),
  };
}

function lineChart(
  id: string,
  title: string,
  series: SeriesInput[],
  yAxisLabel: string,
  xAxisLabel: string,
): Chart {
  return {
    id,
    type: "line",
    title,
    xAxisLabel,
    yAxisLabel,
    series,
    footnotes: [],
    source: sourceOf(series),
  };
}

function sourceOf(series: SeriesInput[]): string {
  const price = series.some((s) => ["close", "volume", "change_return"].includes(s.key));
  return price ? `출처: ${PRICE_BASIS}` : "출처: DART 정기보고서";
}

/** 7억 3,049만 / 328만 / 9,876 */
export function koreanCount(n: number): string {
  const v = Math.round(n);
  const eok = Math.floor(v / 1e8);
  const man = Math.floor((v % 1e8) / 1e4);
  if (eok > 0)
    return `${eok.toLocaleString("ko-KR")}억${man > 0 ? ` ${man.toLocaleString("ko-KR")}만` : ""} `;
  if (man > 0) return `${man.toLocaleString("ko-KR")}만 `;
  return `${v.toLocaleString("ko-KR")}`;
}

function round(x: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}
