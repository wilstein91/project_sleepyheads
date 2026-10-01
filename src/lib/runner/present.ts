// WU-110: 계산된 Series·Figure를 ResultObject의 화면용 조각(Chart·DataBasis·UsedData)으로 묶는다.
import type {
  AnalysisRequestView,
  Chart,
  CompanyRef,
  DataBasis,
  Figure,
  NullReason,
  PeriodRange,
  Quarter,
  Series,
  Unit,
} from "@/contracts";
import type { FsDiv } from "@/lib/financials/types";
import { NULL_REASON_LABEL } from "@/components/charts/chartData";
import { CALC_VERSION } from "@/lib/metrics/types";
import type { BuildComparisonResult, CompanyMetricSample } from "./series-builders";

/** "출처: DART 2026 반기보고서 외 3건" (API_SPEC §2.5 예시 형식). */
export function formatSource(reports: ReadonlySet<string>): string {
  const list = [...reports];
  if (list.length === 0) return "출처: DART";
  if (list.length === 1) return `출처: DART ${list[0]}`;
  return `출처: DART ${list[0]} 외 ${list.length - 1}건`;
}

function pickKrwAxisLabel(series: readonly Series[], figures: Record<string, Figure>): string {
  let maxAbs = 0;
  for (const s of series) {
    for (const point of s.points) {
      const value = figures[point.figureId]?.value;
      if (value != null) maxAbs = Math.max(maxAbs, Math.abs(value));
    }
  }
  if (maxAbs >= 1e12) return "조 원";
  if (maxAbs >= 1e8) return "억 원";
  if (maxAbs >= 1e4) return "만 원";
  return "원";
}

function axisLabelFor(
  unit: Unit,
  series: readonly Series[],
  figures: Record<string, Figure>,
): string | undefined {
  switch (unit) {
    case "KRW":
      return pickKrwAxisLabel(series, figures);
    case "PERCENT":
      return "%";
    case "TIMES":
      return "배";
    default:
      return undefined;
  }
}

function chartTitle(request: AnalysisRequestView, unit: Unit, name = request.target.name): string {
  const isComparison = request.groupBy === "company" || request.groupBy === "sector";
  const subject = isComparison ? "기업별 비교" : request.groupBy === "year" ? "연도별" : "분기별";
  const range = isComparison ? request.period.to : `${request.period.from}~${request.period.to}`;
  const suffix = unit === "KRW" ? "실적" : "지표";
  return `${name} ${subject} ${suffix} (${range})`;
}

/** TECH §7 금융사 부채비율 표 아래 주석 — **글자 그대로** (WU-303 완료조건) */
export const FINANCIAL_FOOTNOTE =
  "※ 금융회사는 고객 예금·보험계약 등이 부채로 잡히는 구조라 일반 기업보다 부채비율이 높게 나타날 수 있습니다.";

/** 여러 기업 중 금융사가 섞였을 때 분석 기준 표시 (API_SPEC §2.5 DataBasis.flags 예시) */
export const FINANCIAL_CONVERSION_FLAG = "금융업 포함 — 공통 지표로 변환";

/** 비교 그래프의 안정성 지표를 바꿨을 때 (TECH §7 "비교 그래프") */
export const STABILITY_SWITCH_NOTE =
  "금융사가 포함되어 비교 그래프의 안정성 지표는 모든 기업 자기자본비율로 표시합니다 (부채비율은 표에서 확인).";

export interface ChartOptions {
  /** 없으면 단위별 기본 제목 */
  title?: string;
  type: Chart["type"];
  footnotes: string[];
  /** 기본 제목 앞의 이름 — 없으면 대상 기업명 (여러 기업 분기·연도별은 "삼성전자·SK하이닉스") */
  subject?: string;
}

/** 합계 차트의 제목·모양·주석 (PRD F-N3). 분기가 3개 이상이면 추이(선), 그보다 적으면 막대 */
export function sumChartOptions(
  request: AnalysisRequestView,
  companies: readonly CompanyRef[],
  periodCount: number,
  excluded: readonly string[],
): ChartOptions {
  const range = `${request.period.from}~${request.period.to}`;
  const subject = request.groupBy === "sector" ? "섹터별 합계" : `${companies.length}개 기업 합계`;
  return {
    title: `${subject} (${range})`,
    type: request.groupBy === "sector" || periodCount < 3 ? "bar" : "line",
    footnotes: [
      `더한 기업: ${companies.map((c) => c.name).join(", ")}`,
      ...(excluded.length > 0
        ? [`모든 기간에 값이 없어 합계에서 뺀 항목: ${excluded.join(", ")}`]
        : []),
    ],
  };
}

/** 기업 비교 차트의 주석 (TECH §7): 안정성 지표를 바꿨으면 그 사실, 금융사 이름에 ※가 있으면 §7 주석 */
export function comparisonChartOptions(
  comparison: Pick<BuildComparisonResult, "stabilitySwitched" | "financialFootnote">,
): ChartOptions {
  return {
    type: "bar",
    footnotes: [
      ...(comparison.stabilitySwitched ? [STABILITY_SWITCH_NOTE] : []),
      ...(comparison.financialFootnote ? [FINANCIAL_FOOTNOTE] : []),
    ],
  };
}

/**
 * 비교 기준 분기 표시: 기업마다 분기가 다르면 "기준 분기 다름 — …", 모두 같지만 요청한 마지막 분기가 아니면
 * (보고서 제출 전 등) 그 분기를 알린다.
 */
export function comparisonFlags(
  samples: readonly CompanyMetricSample[],
  quarterByCorp: ReadonlyMap<string, Quarter>,
  requestedTo?: Quarter,
  /** 기업 → 결측 "해당 분기 제외"로 뺀 분기 (마지막 분기를 뺀 이유를 바르게 적으려고) */
  excludedByCorp?: ReadonlyMap<string, ReadonlySet<Quarter>>,
): string[] {
  const used = samples.map((s) => ({
    name: s.company.name,
    q: quarterByCorp.get(s.company.corpCode),
  }));
  const distinct = new Set(used.map((u) => u.q));
  if (distinct.size > 1) {
    return [`기준 분기 다름 — ${used.map((u) => `${u.name} ${u.q}`).join(", ")}`];
  }
  const only = used[0]?.q;
  if (!only || !requestedTo || only === requestedTo) return [];
  const allExcluded = samples.every((s) =>
    excludedByCorp?.get(s.company.corpCode)?.has(requestedTo),
  );
  return [
    allExcluded
      ? `비교 기준 분기 ${only} — ${requestedTo}는 계정 값이 비어 제외했습니다`
      : `비교 기준 분기 ${only} — ${requestedTo} 보고서가 아직 없습니다`,
  ];
}

const UNAVAILABLE_LABELS_SHOWN = 3;

/**
 * 계산 불가 사유 (TECH §6.4 "화면·분석 글에 사유를 쓴다", WU-302 완료조건): 사유마다 한 줄.
 * "계산 불가 (비교할 직전 기간 없음): 영업이익 QoQ 증감률 2025Q3" — 분석 기준·사용된 데이터 주석에 들어가고,
 * 분석 글(설명 작성)도 이 줄을 본다.
 */
export function unavailableFlags(figures: Record<string, Figure>): string[] {
  const byReason = new Map<NullReason, string[]>();
  for (const f of Object.values(figures)) {
    if (f.value !== null || !f.reason) continue;
    byReason.set(f.reason, [...(byReason.get(f.reason) ?? []), f.label]);
  }
  return [...byReason].map(([reason, labels]) => {
    const shown = labels.slice(0, UNAVAILABLE_LABELS_SHOWN).join(", ");
    const more =
      labels.length > UNAVAILABLE_LABELS_SHOWN
        ? ` 외 ${labels.length - UNAVAILABLE_LABELS_SHOWN}개`
        : "";
    return `계산 불가 (${NULL_REASON_LABEL[reason]}): ${shown}${more}`;
  });
}

/** 단위별로 시리즈를 묶어 차트 1개 이상을 만든다 (KRW·PERCENT가 섞이면 축이 달라 차트를 나눈다). */
export function buildCharts(
  request: AnalysisRequestView,
  series: readonly Series[],
  figures: Record<string, Figure>,
  reportsUsed: ReadonlySet<string>,
  options?: ChartOptions,
): Chart[] {
  const byUnit = new Map<Unit, Series[]>();
  for (const s of series) {
    const list = byUnit.get(s.unit) ?? [];
    list.push(s);
    byUnit.set(s.unit, list);
  }

  const charts: Chart[] = [];
  let seq = 0;
  for (const [unit, group] of byUnit) {
    seq += 1;
    const hasFootnote = group.some((s) => s.footnoteMark);
    charts.push({
      id: `c${seq}`,
      type:
        options?.type ??
        (request.groupBy === "company" || request.groupBy === "sector" ? "bar" : "line"),
      title: options?.title ?? chartTitle(request, unit, options?.subject),
      yAxisLabel: axisLabelFor(unit, group, figures),
      series: group,
      footnotes: [
        ...new Set([...(options?.footnotes ?? []), ...(hasFootnote ? [FINANCIAL_FOOTNOTE] : [])]),
      ],
      source: formatSource(reportsUsed),
    });
  }
  return charts;
}

export function buildDataBasis(
  request: AnalysisRequestView,
  reportsUsed: ReadonlySet<string>,
  targetFsDiv: FsDiv,
  /** 데이터 버전 ID (WU-202 `dataVersionIdFor`) */
  dataVersionId: string,
): DataBasis {
  const flags: string[] = [];
  if (request.target.fiscalMonth !== 12) {
    flags.push(`${request.target.fiscalMonth}월 결산 — 달력 분기로 환산`);
  }
  if (targetFsDiv === "OFS") flags.push("별도 기준");
  if (
    request.groupBy === "year" &&
    (request.metrics.includes("yoy") || request.metrics.includes("qoq"))
  ) {
    flags.push("연도별 보기에서는 증감률(YoY·QoQ)을 표시하지 않습니다 — 분기별로 봐 주세요");
  }

  return {
    target: request.target,
    period: request.period,
    reports: [...reportsUsed],
    priceDate: null,
    calcVersion: CALC_VERSION,
    dataVersionId,
    // 방금 최신 보고서로 계산했으니 false. 나중에 새 공시가 들어오면 조회(analysis-view) 때 다시 판정한다
    newerDataVersionAvailable: false,
    flags,
  };
}

export interface UsedDataInput {
  rowLabelColumn: { name: string; type: "quarter" | "date" | "text" };
  rowKeys: string[];
  series: readonly Series[];
  figures: Record<string, Figure>;
  period: PeriodRange;
  notes: string[];
}

const UNIT_TO_COLUMN_TYPE: Record<Unit, "krw" | "percent" | "times" | "text"> = {
  KRW: "krw",
  PERCENT: "percent",
  TIMES: "times",
  COUNT: "text",
};

/** 표 열 이름 — 금융사 부채비율 열은 "부채비율※" (TECH §7, 차트 "표로 보기"와 같게) */
function columnName(s: Series): string {
  return `${s.label}${s.footnoteMark ?? ""}`;
}

/** "사용된 데이터" 미리보기 (API_SPEC §2.5 UsedData) — 차트와 같은 Figure에서 뽑아 표를 어긋나지 않게 한다. */
export function buildUsedData(input: UsedDataInput): {
  rows: number;
  columns: { name: string; type: "quarter" | "date" | "krw" | "percent" | "times" | "text" }[];
  period: PeriodRange;
  preview: Record<string, string | number | null>[];
  notes: string[];
} {
  const columns = [
    input.rowLabelColumn,
    ...input.series.map((s) => ({ name: columnName(s), type: UNIT_TO_COLUMN_TYPE[s.unit] })),
  ];

  const preview = input.rowKeys.slice(0, 10).map((rowKey) => {
    const record: Record<string, string | number | null> = { [input.rowLabelColumn.name]: rowKey };
    for (const s of input.series) {
      const point = s.points.find((p) => p.x === rowKey);
      const figure = point ? input.figures[point.figureId] : undefined;
      // 부호 전환("흑자전환" 등)은 숫자 대신 글자가 값이다
      record[columnName(s)] = figure
        ? (figure.value ?? (figure.reason ? null : figure.display))
        : null;
    }
    return record;
  });

  return { rows: input.rowKeys.length, columns, period: input.period, preview, notes: input.notes };
}
