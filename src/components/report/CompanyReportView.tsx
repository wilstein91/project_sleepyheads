"use client";

import type { CompanyReport, Figure, ReportFact, ReportSection } from "@/contracts";
import { ChartPanel } from "@/components/charts/ChartPanel";
import { TermText } from "@/components/glossary/Term";
import { DisclosureList } from "@/components/result/DisclosureList";

/** 숫자 칸 글자 — 값이 없으면 사유("적자"·"자본잠식"은 그 자체가 답) */
function factValue(fact: ReportFact, figures: Record<string, Figure>): string {
  if (fact.text) return fact.text;
  const figure = fact.figureId ? figures[fact.figureId] : undefined;
  if (!figure) return "—";
  return figure.display;
}

/** 부호가 뜻 있는 %(등락률·수익률·증감률)는 국내 관습대로 상승 빨강·하락 파랑 */
function tone(fact: ReportFact, figures: Record<string, Figure>): string {
  const figure = fact.figureId ? figures[fact.figureId] : undefined;
  if (!figure || figure.unit !== "PERCENT" || figure.value === null) return "";
  if (!/^[+-]/.test(figure.display)) return "";
  return figure.value > 0 ? "text-[var(--up)]" : figure.value < 0 ? "text-[var(--down)]" : "";
}

/** 맨 위 핵심 지표 띠 — 현재가·시가총액·PER·PBR·ROE·배당수익률·1년 수익률·52주 범위·최대주주 */
export function ReportHighlights({
  report,
  figures,
}: {
  report: CompanyReport;
  figures: Record<string, Figure>;
}) {
  if (report.highlights.length === 0) return null;
  return (
    <section
      aria-labelledby="report-highlights-title"
      className="rounded-xl border border-line bg-surface p-4 sm:p-5"
      data-testid="report-highlights"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="report-highlights-title" className="text-lg font-semibold">
          {report.company.name} 투자 리포트
        </h2>
        <p className="text-xs text-muted">
          {report.company.stockCode} · {report.company.market} ·{" "}
          {report.company.sector?.name ?? "미분류"}
          {report.priceDate ? ` · 주가 기준일 ${report.priceDate}` : ""}
        </p>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {report.highlights.map((fact) => (
          <div key={fact.label} className="rounded-lg bg-paper px-3 py-2.5">
            <dt className="text-xs text-muted">
              <TermText text={fact.label} />
            </dt>
            <dd className={`mt-1 text-lg font-semibold leading-6 ${tone(fact, figures)}`}>
              {factValue(fact, figures)}
            </dd>
            {fact.note && <dd className="mt-0.5 text-xs text-muted">{fact.note}</dd>}
          </div>
        ))}
      </dl>
      {report.notes.length > 0 && (
        <ul className="mt-3 space-y-0.5 text-xs leading-5 text-muted" data-testid="report-notes">
          {report.notes.map((note) => (
            <li key={note}>※ {note}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** 리포트 칸 하나 — 항목 표 + 차트 + 계산 메모 */
function SectionCard({
  section,
  figures,
  highlighted,
  report,
}: {
  section: ReportSection;
  figures: Record<string, Figure>;
  highlighted: string | null;
  report: CompanyReport;
}) {
  if (section.id === "events") {
    return (
      <div className="space-y-2" data-testid="report-section-events">
        {report.disclosures.length > 0 ? (
          <DisclosureList disclosures={report.disclosures} />
        ) : (
          <section className="rounded-xl border border-line bg-surface p-4 sm:p-5">
            <h3 className="font-semibold">{section.title}</h3>
            <p className="mt-2 text-sm text-muted">{section.notes[0] ?? "중요 공시가 없습니다"}</p>
          </section>
        )}
      </div>
    );
  }
  if (section.facts.length === 0 && section.charts.length === 0 && section.notes.length === 0)
    return null;
  return (
    <section
      aria-labelledby={`report-${section.id}-title`}
      className="space-y-4 rounded-xl border border-line bg-surface p-4 sm:p-5"
      data-testid={`report-section-${section.id}`}
    >
      <h3 id={`report-${section.id}-title`} className="text-base font-semibold">
        {section.title}
      </h3>
      {section.facts.length > 0 && (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
          {section.facts.map((fact) => (
            <div
              key={fact.label}
              className="flex items-baseline justify-between gap-3 border-b border-line/60 pb-1.5"
            >
              <dt className="text-sm text-muted">
                <TermText text={fact.label} />
                {fact.note && <span className="block text-xs text-muted/80">{fact.note}</span>}
              </dt>
              <dd className={`shrink-0 text-right text-sm font-semibold ${tone(fact, figures)}`}>
                {factValue(fact, figures)}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {section.charts.map((chart) => (
        <ChartPanel
          key={chart.id}
          chart={chart}
          figures={figures}
          highlighted={highlighted === chart.id}
        />
      ))}
      {section.notes.length > 0 && (
        <ul className="space-y-0.5 text-xs leading-5 text-muted">
          {section.notes.map((note) => (
            <li key={note}>※ {note}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** 투자 리포트 칸들 (기본정보 → 주가·거래 → 재무·실적 → 밸류에이션 → 공시) */
export function ReportSections({
  report,
  figures,
  highlighted,
}: {
  report: CompanyReport;
  figures: Record<string, Figure>;
  highlighted: string | null;
}) {
  return (
    <div className="space-y-4" aria-label="투자 리포트" data-testid="report-sections">
      {report.sections.map((section) => (
        <SectionCard
          key={section.id}
          section={section}
          figures={figures}
          highlighted={highlighted}
          report={report}
        />
      ))}
    </div>
  );
}
