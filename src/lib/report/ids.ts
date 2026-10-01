// 투자 리포트 숫자 ID — f100001부터 써서 질문 결과의 숫자(f1…)와 겹치지 않는다. 서버·화면 어디서나 쓴다 (의존성 없음)
export const REPORT_FIGURE_START = 100_000;

export function isReportFigureId(id: string): boolean {
  const n = Number(/^f(\d+)$/.exec(id)?.[1]);
  return Number.isFinite(n) && n > REPORT_FIGURE_START;
}
