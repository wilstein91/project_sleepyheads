// 차트와 "표로 보기"가 같은 데이터에서 나오게 하는 변환 (TECH §12.3, PRD F-V5).
// 차트용 숫자와 표용 글자 모두 같은 Figure에서 꺼내므로 둘이 어긋날 수 없다.
import type { Chart, Figure, NullReason, Unit } from "@/contracts";

export const NULL_REASON_LABEL: Record<NullReason, string> = {
  NO_PREV_PERIOD: "비교할 직전 기간 없음",
  ZERO_DENOMINATOR: "기준 값이 0",
  MISSING_ACCOUNT: "공시에 계정 값 없음",
  NO_REPORT: "보고서 없음 (제출 전이거나 공시 없음)",
  NO_PRICE: "주가 없음",
  DEFICIT: "적자",
  CAPITAL_IMPAIRMENT: "자본잠식",
};

/** Y축 단위 글자에 맞춰 원 단위 금액(·주 수)을 나눌 값 ("조 원" → 1조, "만 주" → 1만) */
export function unitDivisor(unit: Unit, yAxisLabel?: string): number {
  if ((unit !== "KRW" && unit !== "COUNT") || !yAxisLabel) return 1;
  if (yAxisLabel.includes("조")) return 1e12;
  if (yAxisLabel.includes("억")) return 1e8;
  if (yAxisLabel.includes("만")) return 1e4;
  return 1;
}

export interface ChartCell {
  figureId: string;
  /** 차트에 그릴 값 (Y축 단위로 나눈 값). 계산 불가면 null */
  plotValue: number | null;
  /** 표·툴팁에 쓸 글자 (서버가 포맷한 Figure.display) */
  display: string;
  reason: NullReason | null;
  figure: Figure | null;
}

export interface ChartRow {
  x: string;
  cells: Record<string, ChartCell>;
}

/** Chart.series + figures → x축 값별 행. 계열 순서·x 순서는 서버가 준 순서를 지킨다 */
export function buildChartRows(chart: Chart, figures: Record<string, Figure>): ChartRow[] {
  const rows = new Map<string, ChartRow>();
  for (const series of chart.series) {
    const divisor = unitDivisor(series.unit, chart.yAxisLabel);
    for (const point of series.points) {
      const figure = figures[point.figureId] ?? null;
      const row = rows.get(point.x) ?? { x: point.x, cells: {} };
      row.cells[series.key] = {
        figureId: point.figureId,
        plotValue: figure?.value == null ? null : figure.value / divisor,
        display: figure ? figure.display : "값 없음",
        reason: figure?.reason ?? null,
        figure,
      };
      rows.set(point.x, row);
    }
  }
  return [...rows.values()];
}

/** Recharts가 읽는 평평한 모양: { x, [계열 key]: 값 } */
export function toRechartsData(rows: ChartRow[]): Record<string, string | number | null>[] {
  return rows.map((row) => {
    const flat: Record<string, string | number | null> = { x: row.x };
    for (const [key, cell] of Object.entries(row.cells)) flat[key] = cell.plotValue;
    return flat;
  });
}

/** 증감(%) 계열인가 — 국내 관습대로 상승 빨강·하락 파랑으로 칠한다 */
export function isChangeSeries(key: string, label: string): boolean {
  return /yoy|qoq|change/i.test(key) || /대비|증감/.test(label);
}

/** 값이 없어도 그 자체가 답인 사유 — PER "적자", PBR "자본잠식" (TECH §6.4). 표에 "계산 불가"를 붙이지 않는다 */
const VERDICT_REASONS: ReadonlySet<NullReason> = new Set(["DEFICIT", "CAPITAL_IMPAIRMENT"]);

/** 표 한 칸에 쓸 글자 */
export function cellText(cell: ChartCell | undefined): string {
  if (!cell) return "—";
  if (cell.plotValue === null && cell.reason) {
    if (VERDICT_REASONS.has(cell.reason)) return NULL_REASON_LABEL[cell.reason];
    return `계산 불가 (${NULL_REASON_LABEL[cell.reason]})`;
  }
  return cell.display;
}

/** 주가 기준일 "2026-09-30" → "기준일 9월 30일 종가" (PHASE4_PLAN §3.1). 모양이 다르면 받은 글자 그대로 */
export function priceDateLabel(priceDate: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(priceDate);
  if (!m) return `기준일 ${priceDate} 종가`;
  return `기준일 ${Number(m[1])}월 ${Number(m[2])}일 종가`;
}

/** "2025Q3" → "2025년 3분기", "2025" → "2025년" (그 밖은 그대로) */
export function periodLabel(x: string): string {
  const q = /^(\d{4})Q([1-4])$/.exec(x);
  if (q) return `${q[1]}년 ${q[2]}분기`;
  if (/^\d{4}$/.test(x)) return `${x}년`;
  return x;
}

/** 선 표시점 모양 — 색을 못 구분해도 계열을 알아보게 (TECH §12.3 "색상 + 선 모양/무늬") */
export type MarkerShape = "circle" | "square" | "triangle" | "diamond";
/** 막대 무늬 — 첫 계열은 채움, 다음부터 빗금·점·격자 */
export type BarPattern = "solid" | "hatch" | "dots" | "grid";

export interface SeriesStyle {
  color: string;
  /** SVG stroke-dasharray (실선이면 undefined) */
  dash: string | undefined;
  marker: MarkerShape;
  pattern: BarPattern;
}

const SERIES_COLORS = ["var(--series-1)", "var(--series-2)", "var(--series-3)"];
const DASHES = [undefined, "6 4", "2 3", "10 3 2 3"];
const MARKERS: MarkerShape[] = ["circle", "square", "triangle", "diamond"];
const PATTERNS: BarPattern[] = ["solid", "hatch", "dots", "grid"];

/**
 * 계열 순서별 모양. 선 모양·표시점·무늬가 계열마다 달라서(4계열까지), 흑백으로 보거나 색을 구분하기
 * 어려운 사람도 범례와 차트를 맞춰 볼 수 있다. 색은 globals.css 토큰이라 밝은·어두운 화면 둘 다 맞는다.
 */
export function seriesStyle(index: number): SeriesStyle {
  return {
    color: SERIES_COLORS[index % SERIES_COLORS.length],
    dash: DASHES[index % DASHES.length],
    marker: MARKERS[index % MARKERS.length],
    pattern: PATTERNS[index % PATTERNS.length],
  };
}

/** X축 제목: 서버가 안 줬으면 x 값 모양으로 정한다 (분기 / 연도 / 구분) */
export function xAxisTitle(chart: Chart): string {
  if (chart.xAxisLabel) return chart.xAxisLabel;
  const xs = chart.series.flatMap((s) => s.points.map((p) => p.x));
  if (xs.length > 0 && xs.every((x) => /^\d{4}Q[1-4]$/.test(x))) return "분기";
  if (xs.length > 0 && xs.every((x) => /^\d{4}$/.test(x))) return "연도";
  return "구분";
}

const UNIT_AXIS: Record<Unit, string> = { KRW: "원", PERCENT: "%", TIMES: "배", COUNT: "개" };

/** Y축 단위: 서버가 안 줬으면 첫 계열 단위로 ("%", "배", "원") */
export function yAxisTitle(chart: Chart): string {
  return chart.yAxisLabel ?? (chart.series[0] ? UNIT_AXIS[chart.series[0].unit] : "");
}

/** 출처 줄: 비어 있으면 "출처: DART", "출처"로 시작하지 않으면 붙인다 */
export function sourceText(chart: Chart): string {
  const source = chart.source.trim();
  if (!source) return "출처: DART";
  return source.startsWith("출처") ? source : `출처: ${source}`;
}
