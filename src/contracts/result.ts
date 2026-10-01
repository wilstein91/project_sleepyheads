// API_SPEC §2.5 결과 객체 (좌측 차트 영역) — 기획/화면이 가장 많이 쓰는 타입
import type { CompanyRef, NullReason, PeriodRange, Unit, UUID } from "./common";

/** 화면의 모든 숫자 */
export interface Figure {
  /** "f3" — 분석 글의 {{f3}}와 연결 */
  id: string;
  /** "영업이익 QoQ" */
  label: string;
  value: number | null;
  unit: Unit;
  /** "+12.3%" / "5조 4,210억 원" (서버가 포맷) */
  display: string;
  /** value가 null일 때 */
  reason?: NullReason;
  /** report 예: "2026 반기보고서" */
  basis: { report: string; fsDiv: "CFS" | "OFS"; priceDate?: string };
}

export interface Series {
  /** "operating_income" */
  key: string;
  /** "영업이익" */
  label: string;
  unit: Unit;
  /** x = "2026Q2" 또는 기업명 */
  points: { x: string; figureId: string }[];
  /** 금융사 부채비율 등 */
  footnoteMark?: "※";
}

export interface Chart {
  /** "c1" — 분석 글의 chartRef와 연결 */
  id: string;
  type: "card" | "bar" | "line" | "table";
  /** "SK하이닉스 분기별 영업이익 (2025Q3~2026Q2)" */
  title: string;
  xAxisLabel?: string;
  /** "억 원" */
  yAxisLabel?: string;
  series: Series[];
  /** TECH §7 금융사 주석 문구 등 */
  footnotes: string[];
  /** "출처: DART 2026 반기보고서 외 3건" */
  source: string;
  // 표로 보기: series + figures로 화면이 표를 만든다 (차트와 같은 데이터)
}

export interface Disclosure {
  rceptNo: string;
  title: string;
  date: string;
  /** "자금조달" */
  tag: string;
  importance: "high" | "mid";
  isCorrection: boolean;
  /** DART 원문 */
  url: string;
}

/** "사용된 데이터" 미리보기 */
export interface UsedData {
  rows: number;
  columns: {
    name: string;
    type: "quarter" | "date" | "krw" | "percent" | "times" | "text";
  }[];
  period: PeriodRange;
  /** 앞 10행 */
  preview: Record<string, string | number | null>[];
  /** "3월 결산 — 달력 분기로 환산", "별도 기준" */
  notes: string[];
}

/** 분석 기준 바 */
export interface DataBasis {
  target: CompanyRef;
  period: PeriodRange;
  /** ["2026 반기보고서", "2026 1분기보고서", ...] */
  reports: string[];
  priceDate: string | null;
  /** "v1" */
  calcVersion: string;
  dataVersionId: UUID;
  newerDataVersionAvailable: boolean;
  /** "금융업 포함 — 공통 지표로 변환", "기준 분기 다름" */
  flags: string[];
}

/** 투자 리포트 칸 하나 — 숫자면 figureId, 숫자가 아니면(업종·최대주주 이름 등) text */
export interface ReportFact {
  /** "현재가" */
  label: string;
  /** figures의 ID (숫자) */
  figureId?: string;
  /** 숫자가 아닌 값 */
  text?: string;
  /** 한 줄 보충 ("52주 범위의 78% 위치", "2026-09-30 종가") */
  note?: string;
}

export type ReportSectionId = "profile" | "price" | "financials" | "valuation" | "events";

export interface ReportSection {
  id: ReportSectionId;
  /** "주가·거래" */
  title: string;
  facts: ReportFact[];
  /** 이 칸의 차트 (숫자는 ResultObject.figures) — ID는 "r1"처럼 질문 차트와 겹치지 않는다 */
  charts: Chart[];
  /** 계산 방법·한계 ("PCR은 최근 사업연도 영업현금흐름 기준") */
  notes: string[];
}

/**
 * 투자 리포트 (Phase 5 후속): 질문이 무엇이든 대상 기업 하나의 기본정보·주가·재무·밸류에이션·공시를 함께 보여 준다.
 * 숫자는 모두 `ResultObject.figures`에 있다 — 분석 글이 {{f…}}로 가리킬 수 있다.
 */
export interface CompanyReport {
  company: CompanyRef;
  /** 리포트를 만든 시각 (ISO) — 주가·최근 보고서는 이 시점 기준이다 */
  asOf: string;
  /** 주가 기준일 (마지막 거래일) */
  priceDate: string | null;
  /** 맨 위 핵심 지표 (현재가·시가총액·PER·PBR·ROE·배당수익률·52주 범위·최대주주) */
  highlights: ReportFact[];
  sections: ReportSection[];
  /** 분석 글 AI에 넘기는 핵심 숫자 (일별·주별 차트 점은 빼고) */
  keyFigureIds: string[];
  /** 최근 12개월 중요 공시 */
  disclosures: Disclosure[];
  /** 받지 못한 부분 안내 */
  notes: string[];
}

export interface ResultObject {
  basis: DataBasis;
  /** id → Figure */
  figures: Record<string, Figure>;
  charts: Chart[];
  disclosures: Disclosure[];
  usedData: UsedData;
  /** 투자 리포트 — 기업 하나가 대상인 분석에만 (옛 분석·비로그인 예시에는 없을 수 있다) */
  report?: CompanyReport;
}
