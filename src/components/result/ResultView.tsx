"use client";

import { useEffect, useRef, useState } from "react";
import type { Explanation, ResultObject } from "@/contracts";
import { ChartPanel } from "@/components/charts/ChartPanel";
import { ReportHighlights, ReportSections } from "@/components/report/CompanyReportView";
import { BasisBar } from "./BasisBar";
import { DisclosureList } from "./DisclosureList";
import { ExplanationPanel } from "./ExplanationPanel";
import { UsedDataPanel } from "./UsedDataPanel";

/**
 * 결과 화면: 분석 기준 바 + (투자 리포트 핵심 지표) + 왼쪽 차트(약 60%) / 오른쪽 분석 글(약 40%).
 * 왼쪽은 질문에 대한 차트 다음에 투자 리포트 칸(기본정보·주가·재무·밸류에이션·공시)이 이어진다(Phase 5 후속).
 * 1024px 미만은 차트 → 글 순서. 회원 분석(/p/…)과 비로그인 예시(/)가 함께 쓴다.
 */
export function ResultView({
  result,
  explanation,
  groupBy,
}: {
  result: ResultObject;
  explanation: Explanation | null;
  groupBy?: string;
}) {
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  // "해당 차트 보기": 왼쪽 차트로 이동해 잠깐 강조한다 (TECH §12.2)
  function showChart(chartId: string) {
    const el = document.getElementById(`chart-${chartId}`);
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    el.focus({ preventScroll: true });
    setHighlighted(chartId);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setHighlighted(null), 1800);
  }

  return (
    <div className="space-y-6">
      <BasisBar result={result} groupBy={groupBy} />
      {result.report && <ReportHighlights report={result.report} figures={result.figures} />}

      <div className="grid gap-6 lg:grid-cols-[3fr_2fr] lg:items-start">
        <div className="min-w-0 space-y-4" aria-label="근거 차트">
          {result.charts.map((chart) => (
            <ChartPanel
              key={chart.id}
              chart={chart}
              figures={result.figures}
              highlighted={highlighted === chart.id}
            />
          ))}
          <DisclosureList disclosures={result.disclosures} />
          <UsedDataPanel usedData={result.usedData} />
          {result.report && (
            <ReportSections
              report={result.report}
              figures={result.figures}
              highlighted={highlighted}
            />
          )}
        </div>

        <div className="min-w-0 rounded-xl border border-line bg-surface p-4 sm:p-6 lg:sticky lg:top-6">
          <ExplanationPanel
            explanation={explanation}
            charts={[...result.charts, ...(result.report?.sections.flatMap((s) => s.charts) ?? [])]}
            onShowChart={showChart}
          />
        </div>
      </div>
    </div>
  );
}
