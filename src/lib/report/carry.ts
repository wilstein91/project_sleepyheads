// 투자 리포트를 다른 결과로 옮긴다 — 같은 조건 재실행(Q6)·보드 다시 계산(B2)은 단계 엔진을 거치지 않아
// 리포트를 새로 만들지 않는다. 리포트는 "그 분석을 한 시점"의 스냅숏이라 원래 것을 그대로 붙인다
// (같은 조건 재실행이 "숫자가 모두 같다"를 지키는 것도 이 덕분이다).
import type { ResultObject } from "@/contracts";
import { isReportFigureId } from "./ids";

export { isReportFigureId };

export function carryReport(from: ResultObject | null | undefined, to: ResultObject): ResultObject {
  if (!from?.report) return to;
  to.report = from.report;
  for (const [id, figure] of Object.entries(from.figures)) {
    if (isReportFigureId(id)) to.figures[id] = figure;
  }
  return to;
}
