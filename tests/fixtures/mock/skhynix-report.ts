// 가짜 모드: SK하이닉스 투자 리포트 (Phase 5 후속). 숫자는 실제 전자공시·주가 API를 한 번 돌린 결과(2026-10-01 조회,
// skhynix-report.json)라 화면에서 실제와 같은 모양을 본다. 숫자 ID는 f100001부터 — 질문 결과(f1…)와 겹치지 않는다.
import type { Analysis, CompanyReport, Figure } from "@/contracts";
import data from "./skhynix-report.json";

const fixture = data as unknown as { report: CompanyReport; figures: Record<string, Figure> };

export const MOCK_REPORT = fixture.report;

/** 결과가 있는 분석에 리포트를 붙인다 (원본 고정 데이터는 바꾸지 않는다) */
export function withMockReport(analysis: Analysis): Analysis {
  if (!analysis.result) return analysis;
  return {
    ...analysis,
    result: {
      ...analysis.result,
      report: { ...fixture.report, company: analysis.result.basis.target },
      figures: { ...analysis.result.figures, ...fixture.figures },
    },
  };
}
