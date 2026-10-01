// WU-110: `aggregate`·`compute_metric`·`change` 도구 — 계산된 달력 분기 지표(WU-106)를
// 요청된 묶음(groupBy)에 맞는 Series로 바꾼다. 차트와 표는 여기서 만든 Figure를 그대로 같이 쓴다.
import type { CompanyRef, MetricId, NullReason, PeriodRange, Quarter, Series } from "@/contracts";
import type { FsDiv } from "@/lib/financials/types";
import { calendarAnnualFlow } from "@/lib/metrics/calendar-quarter";
import { type ChangeComputed, qoq as computeQoq, yoy as computeYoy } from "@/lib/metrics/formulas";
import type { CalendarQuarterMetricsRow } from "@/lib/metrics/persist";
import type { Computed } from "@/lib/metrics/types";
import { addQuarters, compareQuarters, parseQuarter } from "@/lib/ask/quarter";
import type { CompanyFinancials } from "./company-financials";
import { reportsForFiscalQuarter } from "@/lib/financials/period";
import { reportDisplayName } from "./format";
import type { FigureAllocator } from "./figures";
import {
  FLOW_METRICS,
  METRIC_LABEL,
  METRIC_UNIT,
  RATIO_METRIC_INPUTS,
  metricLabelFor,
  type DirectMetricId,
  type FlowMetricId,
} from "./metric-info";

/** 요청된 metrics 중 revenue > operating_income > net_income 순으로 첫 번째를 YoY/QoQ 기준으로 쓴다. */
function primaryChangeMetric(metrics: MetricId[]): FlowMetricId {
  const priority: FlowMetricId[] = ["revenue", "operating_income", "net_income"];
  return priority.find((m) => metrics.includes(m)) ?? "revenue";
}

export function quartersInRange(period: PeriodRange): Quarter[] {
  const quarters: Quarter[] = [];
  let q = period.from;
  while (compareQuarters(q, period.to) <= 0) {
    quarters.push(q);
    q = addQuarters(q, 1);
  }
  return quarters;
}

/** 달력 분기 값의 근거 보고서 이름. 연도는 OpenDART 연도(보고서 기간이 끝난 해)로 보여 준다 */
export function reportBasis(quarter: Quarter, financials: CompanyFinancials): string {
  const ref = financials.fiscalRefByQuarter.get(quarter);
  if (!ref) return "알 수 없음";
  const reports = reportsForFiscalQuarter(ref.bsnsYear, ref.quarter, financials.accMt ?? 12);
  return reports.map((r) => reportDisplayName(r.bsnsYear, r.reprtCode)).join("·");
}

export interface BuildQuarterlyResult {
  series: Series[];
  reportsUsed: Set<string>;
}

/** groupBy = "quarter": 요청 범위의 분기마다 Figure를 만들고, 지표별 Series 하나씩 돌려준다. */
export function buildQuarterlySeries(
  financials: CompanyFinancials,
  fsDiv: FsDiv,
  quarters: Quarter[],
  metrics: MetricId[],
  allocator: FigureAllocator,
): BuildQuarterlyResult {
  const series: Series[] = [];
  const reportsUsed = new Set<string>();
  const directMetrics = metrics.filter(
    (m): m is DirectMetricId =>
      m !== "yoy" && m !== "qoq" && m in METRIC_LABEL && METRIC_UNIT[m] !== undefined,
  );

  for (const metric of directMetrics) {
    const points: Series["points"] = [];
    let footnoteMark: "※" | undefined;

    for (const quarter of quarters) {
      const computed = metricAt(financials, quarter, metric);
      const report = reportBasis(quarter, financials);
      reportsUsed.add(report);
      const footnote = (computed as { footnoteMark?: "※" }).footnoteMark;
      if (footnote) footnoteMark = footnote;

      const figure = allocator.add({
        label: `${METRIC_LABEL[metric]} ${quarter}`,
        unit: METRIC_UNIT[metric],
        value: computed.value,
        reason: computed.reason,
        basis: { report, fsDiv },
      });
      points.push({ x: quarter, figureId: figure.id });
    }

    series.push({
      key: metric,
      label: METRIC_LABEL[metric],
      unit: METRIC_UNIT[metric],
      points,
      footnoteMark,
    });
  }

  for (const changeOp of (["yoy", "qoq"] as const).filter((m) => metrics.includes(m))) {
    const base = primaryChangeMetric(metrics);
    const lag = changeOp === "yoy" ? 4 : 1;
    const points: Series["points"] = [];

    for (const quarter of quarters) {
      const current = metricAt(financials, quarter, base);
      const previous = financials.metricsByQuarter.get(addQuarters(quarter, -lag))?.metrics[base];
      // 흑자전환·적자전환 글자는 이익 지표에만 (매출이 0으로 줄어든 것은 적자전환이 아니다)
      const isProfit = base !== "revenue";
      const computed: ChangeComputed =
        changeOp === "yoy"
          ? computeYoy(current, previous, isProfit)
          : computeQoq(current, previous, isProfit);
      const report = reportBasis(quarter, financials);

      const figure = allocator.add({
        label: `${METRIC_LABEL[base]} ${METRIC_LABEL[changeOp]} ${quarter}`,
        unit: "PERCENT",
        value: computed.value,
        reason: computed.reason,
        displayText: "signChange" in computed ? computed.signChange : undefined,
        basis: { report, fsDiv },
      });
      points.push({ x: quarter, figureId: figure.id });
    }

    series.push({
      key: changeOp,
      label: `${METRIC_LABEL[base]} ${METRIC_LABEL[changeOp]}`,
      unit: "PERCENT",
      points,
    });
  }

  return { series, reportsUsed };
}

/**
 * 한 분기의 지표 값. 비어 있을 때 그 분기 보고서 자체가 없으면(013) "보고서 없음",
 * 보고서는 있는데 계정을 못 찾았으면 "계정 값 없음"으로 구분한다.
 */
function metricAt<M extends keyof CalendarQuarterMetricsRow["metrics"]>(
  financials: CompanyFinancials,
  quarter: Quarter,
  metric: M,
): NonNullable<CalendarQuarterMetricsRow["metrics"][M]> {
  type Value = NonNullable<CalendarQuarterMetricsRow["metrics"][M]>;
  const computed = financials.metricsByQuarter.get(quarter)?.metrics[metric];
  if (computed && computed.value !== null) return computed as Value;
  if (financials.quartersWithoutReport?.has(quarter)) {
    return { value: null, reason: "NO_REPORT" } as Value;
  }
  return (computed ?? { value: null, reason: "MISSING_ACCOUNT" }) as Value;
}

/** groupBy = "year": 연간 값은 분기 합(흐름)·4분기말 값(저량)이다 — 분기 비율의 평균이 아니다(§6.3). */
export function buildAnnualSeries(
  financials: CompanyFinancials,
  fsDiv: FsDiv,
  quarters: Quarter[],
  metrics: MetricId[],
  allocator: FigureAllocator,
): BuildQuarterlyResult {
  const allYears = [...new Set(quarters.map((q) => parseQuarter(q).year))].sort((a, b) => a - b);
  // 요청 범위 안에 4개 분기가 다 들어 있는 연도만 연간 값으로 낸다 — 반쪽 연도는 합계가 틀리고,
  // 범위 밖 분기(증감률 계산용으로 더 불러온 앞 분기)로 채운 연도는 요청하지 않은 연도다.
  const requested = new Set(quarters);
  const completeYears = allYears.filter((year) =>
    ([1, 2, 3, 4] as const).every((q) => requested.has(`${year}Q${q}` as Quarter)),
  );
  const years = completeYears.length > 0 ? completeYears : allYears;
  const series: Series[] = [];
  const reportsUsed = new Set<string>();

  const flowValueByYear = (year: number, metric: FlowMetricId): Computed<bigint> => {
    const values = ([1, 2, 3, 4] as const).map((q) => {
      const key = `${year}Q${q}` as Quarter;
      reportsUsed.add(reportBasis(key, financials));
      return metricAt(financials, key, metric);
    });
    const total = calendarAnnualFlow(values.map((v) => v.value));
    if (total !== null) return { value: total };
    return {
      value: null,
      reason: values.some((v) => v.reason === "NO_REPORT") ? "NO_REPORT" : "MISSING_ACCOUNT",
    };
  };

  for (const metric of metrics) {
    if (metric === "yoy" || metric === "qoq" || !(metric in METRIC_LABEL)) continue;

    if ((FLOW_METRICS as readonly MetricId[]).includes(metric)) {
      const points: Series["points"] = [];
      for (const year of years) {
        const computed = flowValueByYear(year, metric as FlowMetricId);
        const figure = allocator.add({
          label: `${METRIC_LABEL[metric]} ${year}년`,
          unit: METRIC_UNIT[metric],
          value: computed.value,
          reason: computed.reason,
          basis: { report: `${year}년 연간 (분기 합)`, fsDiv },
        });
        points.push({ x: `${year}`, figureId: figure.id });
      }
      series.push({ key: metric, label: METRIC_LABEL[metric], unit: METRIC_UNIT[metric], points });
      continue;
    }

    const ratioInputs = RATIO_METRIC_INPUTS[metric as DirectMetricId];
    if (ratioInputs) {
      const points: Series["points"] = [];
      for (const year of years) {
        const numerator = flowValueByYear(year, ratioInputs.numerator);
        const denominator = flowValueByYear(year, ratioInputs.denominator);
        const computed = percentageOf(numerator, denominator);
        const figure = allocator.add({
          label: `${METRIC_LABEL[metric]} ${year}년`,
          unit: "PERCENT",
          value: computed.value,
          reason: computed.reason,
          basis: { report: `${year}년 연간 (분기 합)`, fsDiv },
        });
        points.push({ x: `${year}`, figureId: figure.id });
      }
      series.push({ key: metric, label: METRIC_LABEL[metric], unit: "PERCENT", points });
      continue;
    }

    // 그 밖 지표(ROE·부채비율·TTM 등)는 이미 분기말 기준 4분기 합/평균이라 연간 재계산 없이 그 해 4분기 값을 쓴다.
    const points: Series["points"] = [];
    let footnoteMark: "※" | undefined;
    for (const year of years) {
      const key = `${year}Q4` as Quarter;
      const computed = metricAt(financials, key, metric as DirectMetricId);
      const footnote = (computed as { footnoteMark?: "※" }).footnoteMark;
      if (footnote) footnoteMark = footnote;
      const figure = allocator.add({
        label: `${METRIC_LABEL[metric]} ${year}년 (연말 기준)`,
        unit: METRIC_UNIT[metric],
        value: computed.value,
        reason: computed.reason,
        basis: { report: reportBasis(key, financials), fsDiv },
      });
      points.push({ x: `${year}`, figureId: figure.id });
    }
    series.push({
      key: metric,
      label: METRIC_LABEL[metric],
      unit: METRIC_UNIT[metric],
      points,
      footnoteMark,
    });
  }

  return { series, reportsUsed };
}

function percentageOf(
  numerator: Computed<bigint>,
  denominator: Computed<bigint>,
): Computed<number> {
  if (numerator.value == null) return { value: null, reason: numerator.reason };
  if (denominator.value == null) return { value: null, reason: denominator.reason };
  if (denominator.value === BigInt(0)) return { value: null, reason: "ZERO_DENOMINATOR" };
  return { value: (Number(numerator.value) / Number(denominator.value)) * 100 };
}

export interface CompanyMetricSample {
  company: CompanyRef;
  financials: CompanyFinancials;
  fsDiv: FsDiv;
}

/**
 * groupBy = "quarter" | "year"인데 기업이 여럿 ("삼성전자와 SK하이닉스 최근 4분기 영업이익 비교해줘"):
 * 같은 분기(연도) 축에 기업마다 선 하나씩 — 대상 기업만 그리면 비교 기업 값이 답에서 빠진다.
 * Series key는 `지표:corpCode`(차트·표 칸 이름이 겹치지 않게), 이름과 숫자 이름 앞에 기업명을 붙인다.
 * 순서는 지표 → 기업 (같은 지표의 기업들이 나란히). 분기는 기업마다 자기가 뺀 분기만 뺀다.
 */
export function buildMultiCompanyPeriodSeries(
  samples: CompanyMetricSample[],
  quartersOf: (corpCode: string) => Quarter[],
  metrics: MetricId[],
  allocator: FigureAllocator,
  byYear: boolean,
): BuildQuarterlyResult {
  const reportsUsed = new Set<string>();
  const perCompany = samples.map((sample) => {
    const { name } = sample.company;
    const named: FigureAllocator = {
      figures: allocator.figures,
      add: (input) => allocator.add({ ...input, label: `${name} ${input.label}` }),
    };
    const build = byYear ? buildAnnualSeries : buildQuarterlySeries;
    const built = build(
      sample.financials,
      sample.fsDiv,
      quartersOf(sample.company.corpCode),
      metrics,
      named,
    );
    for (const report of built.reportsUsed) reportsUsed.add(report);
    return built.series.map((s): Series => ({
      ...s,
      key: `${s.key}:${sample.company.corpCode}`,
      label: `${name} ${s.label}`,
    }));
  });

  const series: Series[] = [];
  const metricCount = Math.max(0, ...perCompany.map((list) => list.length));
  for (let i = 0; i < metricCount; i++) {
    for (const list of perCompany) if (list[i]) series.push(list[i]);
  }
  return { series, reportsUsed };
}

export interface BuildComparisonResult extends BuildQuarterlyResult {
  /** 비교 그래프에 그릴 Series — 금융사가 있으면 부채비율 대신 자기자본비율 (TECH §7). 표는 `series` 전부 */
  chartSeries: Series[];
  /** 기업(corpCode) → 비교에 쓴 분기. 기업마다 다를 수 있다 ("기준 분기 다름") */
  quarterByCorp: Map<string, Quarter>;
  /** 비교 기업 중 금융사가 있는가 */
  hasFinancial: boolean;
  /** 금융사 기업명·부채비율에 ※를 달았는가 (표에 부채비율이 있을 때만) → 표 아래 §7 주석 */
  financialFootnote: boolean;
  /** 비교 그래프의 안정성 지표를 부채비율 → 자기자본비율로 바꿨는가 */
  stabilitySwitched: boolean;
  /** 표 행 이름 (기업 순서대로, 금융사는 ※가 붙을 수 있다) — 차트 x와 같다 */
  rowKeys: string[];
}

const STABILITY_METRICS: readonly DirectMetricId[] = ["debt_ratio", "equity_ratio"];

function isFinancialSample(sample: CompanyMetricSample, quarter: Quarter): boolean {
  if (sample.company.sector.isFinancial) return true;
  // 섹터 정보가 없던 옛 요청도 계산 엔진이 단 부채비율 ※(sectors.is_financial)로 알아본다
  const debt = sample.financials.metricsByQuarter.get(quarter)?.metrics.debt_ratio as
    { footnoteMark?: "※" } | undefined;
  return debt?.footnoteMark === "※";
}

/**
 * 비교 표·그래프의 행 이름. 표에 부채비율이 있으면 금융사 이름에 ※ (TECH §7 "기업명·부채비율에 ※").
 * 차트 x·표 행·"사용된 데이터" 행이 이 이름 하나로 맞물린다.
 */
export function comparisonRowLabel(company: CompanyRef, marked: boolean): string {
  return marked ? `${company.name}※` : company.name;
}

/**
 * groupBy = "company" | "sector": 비교 대상마다 한 분기의 값을 나란히 놓는다 (TECH §4.4 `compare`, §7).
 * - `quarter`: 모든 기업에 같은 분기, 또는 기업(corpCode)별 분기 — 한 기업의 보고서가 늦거나 결측 분기를
 *   뺐다고 다른 기업의 비교 분기까지 밀리지 않게 기업마다 따로 정한다 (`comparisonQuarters`).
 * - 금융업 변환 (§7): 금융사의 매출은 영업수익, 영업이익률은 영업이익 ÷ 영업수익 (계산식은 같고 계정만 다르다
 *   — account_map 2순위). 안정성 지표를 물으면 **표에는 부채비율·자기자본비율 둘 다**, 금융사가 1곳이라도
 *   있으면 **그래프는 모든 기업 자기자본비율**, 금융사 이름·부채비율에 ※.
 */
export function buildCompanyComparisonSeries(
  samples: CompanyMetricSample[],
  quarter: Quarter | ReadonlyMap<string, Quarter>,
  metrics: MetricId[],
  allocator: FigureAllocator,
): BuildComparisonResult {
  const quarterByCorp = new Map<string, Quarter>();
  for (const sample of samples) {
    const q = typeof quarter === "string" ? quarter : quarter.get(sample.company.corpCode);
    if (q) quarterByCorp.set(sample.company.corpCode, q);
  }
  const quarterOf = (sample: CompanyMetricSample) => quarterByCorp.get(sample.company.corpCode)!;

  const requested = metrics.filter(
    (m): m is DirectMetricId => m !== "yoy" && m !== "qoq" && m in METRIC_LABEL,
  );
  // 비교표에는 안정성 지표를 둘 다 (TECH §7 "비교표: 부채비율·자기자본비율 모두 표시")
  const tableMetrics: DirectMetricId[] = [...requested];
  if (requested.some((m) => STABILITY_METRICS.includes(m))) {
    for (const m of STABILITY_METRICS) if (!tableMetrics.includes(m)) tableMetrics.push(m);
  }

  const financialCorps = new Set(
    samples.filter((s) => isFinancialSample(s, quarterOf(s))).map((s) => s.company.corpCode),
  );
  const hasFinancial = financialCorps.size > 0;
  const financialFootnote = hasFinancial && tableMetrics.includes("debt_ratio");
  const rowLabel = (sample: CompanyMetricSample) =>
    comparisonRowLabel(
      sample.company,
      financialFootnote && financialCorps.has(sample.company.corpCode),
    );

  const series: Series[] = [];
  const reportsUsed = new Set<string>();
  for (const metric of tableMetrics) {
    const points: Series["points"] = [];
    let footnoteMark: "※" | undefined;
    for (const sample of samples) {
      const q = quarterOf(sample);
      const computed = metricAt(sample.financials, q, metric);
      const isFinancial = financialCorps.has(sample.company.corpCode);
      if (metric === "debt_ratio" && isFinancial) footnoteMark = "※";
      const report = reportBasis(q, sample.financials);
      reportsUsed.add(`${sample.company.name} ${report}`);

      const figure = allocator.add({
        label: `${sample.company.name} ${metricLabelFor(metric, isFinancial)} ${q}`,
        unit: METRIC_UNIT[metric],
        value: computed.value,
        reason: computed.reason,
        basis: { report, fsDiv: sample.fsDiv },
      });
      points.push({ x: rowLabel(sample), figureId: figure.id });
    }
    series.push({
      key: metric,
      label: METRIC_LABEL[metric],
      unit: METRIC_UNIT[metric],
      points,
      footnoteMark,
    });
  }

  // 증감률(QoQ·YoY)을 물었으면 기업마다 그 기업 비교 분기 기준으로 — 수업 Step 3 통과 테스트
  // "직전 분기 대비 영업이익 변화와 감소한 경쟁사 비교" (2026-09-30 WU-399 운영 확인에서 빠진 것을 찾음)
  const changeOps = (["qoq", "yoy"] as const).filter((m) => metrics.includes(m));
  for (const changeOp of changeOps) {
    const base = primaryChangeMetric(metrics);
    const lag = changeOp === "yoy" ? 4 : 1;
    const points: Series["points"] = [];
    for (const sample of samples) {
      const q = quarterOf(sample);
      const current = metricAt(sample.financials, q, base);
      const previous = sample.financials.metricsByQuarter.get(addQuarters(q, -lag))?.metrics[base];
      const isProfit = base !== "revenue";
      const computed: ChangeComputed =
        changeOp === "yoy"
          ? computeYoy(current, previous, isProfit)
          : computeQoq(current, previous, isProfit);
      const figure = allocator.add({
        label: `${sample.company.name} ${METRIC_LABEL[base]} ${METRIC_LABEL[changeOp]} ${q}`,
        unit: "PERCENT",
        value: computed.value,
        reason: computed.reason,
        displayText: "signChange" in computed ? computed.signChange : undefined,
        basis: { report: reportBasis(q, sample.financials), fsDiv: sample.fsDiv },
      });
      points.push({ x: rowLabel(sample), figureId: figure.id });
    }
    series.push({
      key: changeOp,
      label: `${METRIC_LABEL[base]} ${METRIC_LABEL[changeOp]}`,
      unit: "PERCENT",
      points,
    });
  }

  // 비교 그래프: 금융사가 있으면 부채비율을 빼고 자기자본비율로. 없으면 물은 지표 그대로(덧붙인 것은 표에만)
  const chartKeys = new Set<string>([...requested, ...changeOps]);
  let stabilitySwitched = false;
  if (hasFinancial && chartKeys.has("debt_ratio")) {
    chartKeys.delete("debt_ratio");
    chartKeys.add("equity_ratio");
    stabilitySwitched = true;
  }
  const chartSeries = series.filter((s) => chartKeys.has(s.key));

  return {
    series,
    chartSeries,
    reportsUsed,
    quarterByCorp,
    hasFinancial,
    financialFootnote,
    stabilitySwitched,
    rowKeys: samples.map(rowLabel),
  };
}

/**
 * 기업마다 비교에 쓸 분기: 요청 범위 안에서 그 기업이 쓸 수 있는 분기(`allowed`, 결측 제외 반영) 중
 * **보고서가 있는 가장 최근 분기**. 아직 제출 전(013)인 분기 때문에 비교가 빈칸이 되지 않게 한다.
 * 쓸 분기가 하나도 없으면 요청 범위의 마지막 분기(계산 불가로 보인다).
 */
export function comparisonQuarter(
  financials: CompanyFinancials,
  allowed: readonly Quarter[],
  fallback: Quarter,
): Quarter {
  for (let i = allowed.length - 1; i >= 0; i -= 1) {
    if (!financials.quartersWithoutReport?.has(allowed[i])) return allowed[i];
  }
  return allowed[allowed.length - 1] ?? fallback;
}

export interface BuildSumResult extends BuildQuarterlyResult {
  /** 모든 기간에 값이 없어 합계에서 뺀 기업·지표 ("KB금융 매출" — 금융사는 매출 계정이 없다) */
  excluded: string[];
}

/** 합계의 한 칸: 분기 하나("2026Q2") 또는 연도 하나("2025" = 그 해 1~4분기) */
export interface SumPeriod {
  x: string;
  quarters: Quarter[];
}

/** 분기별 합계는 분기마다, 연도별 합계는 1~4분기가 다 요청된 해마다 한 칸 */
export function sumPeriods(quarters: Quarter[], byYear: boolean): SumPeriod[] {
  if (!byYear) return quarters.map((q) => ({ x: q, quarters: [q] }));
  const years = [...new Set(quarters.map((q) => parseQuarter(q).year))];
  const complete = years.filter((y) =>
    ([1, 2, 3, 4] as const).every((n) => quarters.includes(`${y}Q${n}` as Quarter)),
  );
  if (complete.length === 0) return quarters.map((q) => ({ x: q, quarters: [q] }));
  return complete.map((y) => ({
    x: String(y),
    quarters: ([1, 2, 3, 4] as const).map((n) => `${y}Q${n}` as Quarter),
  }));
}

/**
 * 합계 (PRD F-N3, WU-199 "전체 매출(합계)·섹터별 합계"): 질문에 나온 기업들의 흐름 지표
 * (매출·영업이익·순이익)를 기간마다 더한다. `bySector`면 기업의 섹터별로 따로 더한다.
 * - 비율 지표(이익률·ROE·부채비율 등)는 더하면 뜻이 없어 넣지 않는다.
 * - **모든 기간에** 값이 없는 기업(예: 금융사 매출)만 빼고 `excluded`로 알린다 — 0으로 치지 않는다.
 * - 일부 기간만 비는 기업(보고서 제출 전 등)이 있으면 그 기간 합계는 계산 불가로 둔다. 기간마다 더한
 *   기업이 달라지면 추이가 뛰는 것처럼 잘못 읽히기 때문이다.
 */
export function buildSumSeries(
  samples: CompanyMetricSample[],
  periods: SumPeriod[],
  metrics: MetricId[],
  bySector: boolean,
  allocator: FigureAllocator,
): BuildSumResult {
  const series: Series[] = [];
  const reportsUsed = new Set<string>();
  const excluded: string[] = [];
  const flowMetrics = (FLOW_METRICS as readonly MetricId[]).filter((m) => metrics.includes(m));
  const summed = flowMetrics.length > 0 ? (flowMetrics as FlowMetricId[]) : (["revenue"] as const);

  for (const sample of samples) {
    for (const period of periods) {
      for (const q of period.quarters) {
        reportsUsed.add(`${sample.company.name} ${reportBasis(q, sample.financials)}`);
      }
    }
  }

  const periodValue = (
    sample: CompanyMetricSample,
    period: SumPeriod,
    metric: FlowMetricId,
  ): Computed<bigint> => {
    let total = BigInt(0);
    for (const q of period.quarters) {
      const computed = metricAt(sample.financials, q, metric);
      if (computed.value === null) return computed;
      total += computed.value;
    }
    return { value: total };
  };

  for (const metric of summed) {
    const groups = new Map<string, CompanyMetricSample[]>();
    for (const sample of samples) {
      const values = periods.map((period) => periodValue(sample, period, metric));
      if (values.every((v) => v.value === null)) {
        excluded.push(`${sample.company.name} ${METRIC_LABEL[metric]}`);
        continue;
      }
      const key = bySector ? sample.company.sector.name || "기타" : "합계";
      groups.set(key, [...(groups.get(key) ?? []), sample]);
    }

    for (const [group, members] of groups) {
      const label = bySector ? `${group} ${METRIC_LABEL[metric]}` : `${METRIC_LABEL[metric]} 합계`;
      const points: Series["points"] = [];
      for (const period of periods) {
        let total: bigint | null = BigInt(0);
        let reason: NullReason | undefined;
        for (const sample of members) {
          const value = periodValue(sample, period, metric);
          if (value.value === null) {
            total = null;
            reason = value.reason;
            break;
          }
          total += value.value;
        }
        const figure = allocator.add({
          label: `${label} ${period.x} (${members.length}곳 합산)`,
          unit: "KRW",
          value: total,
          reason,
          basis: { report: `기업별 보고서 ${members.length}곳 합산`, fsDiv: members[0].fsDiv },
        });
        points.push({ x: period.x, figureId: figure.id });
      }
      series.push({
        key: bySector ? `${metric}:${group}` : `${metric}_sum`,
        label,
        unit: "KRW",
        points,
      });
    }
  }

  return { series, reportsUsed, excluded };
}
