import type { Chart, Explanation, InsightKind } from "@/contracts";
import { RewriteSlot } from "@/components/board/rewrite-context";
import { TermText } from "@/components/glossary/Term";
import { isGoogleNewsUrl } from "@/lib/news/web-url";

const KIND: Record<InsightKind, { label: string; className: string }> = {
  positive: { label: "긍정 요인", className: "bg-accent-soft text-accent" },
  risk: { label: "위험 요인", className: "bg-notice-bg text-notice-ink" },
  watch: { label: "확인할 점", className: "border border-line text-muted" },
};

/** 기사 발행 시각(UTC) → 한국 날짜 "2026. 9. 29." — 서버·브라우저 어디서 그려도 같은 값 */
const KST_DATE = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "numeric",
  day: "numeric",
});

/** 공시 원문 링크는 DART 뷰어 주소만 (서버가 접수번호로 만든 것, TECH §10.2와 같은 원칙) */
function isDartViewerUrl(url: string): boolean {
  return url.startsWith("https://dart.fss.or.kr/dsaf001/main.do?rcpNo=");
}

function kstDate(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? "" : KST_DATE.format(time);
}

/**
 * 오른쪽 분석 글 (PRD F-V6, F-V11~F-V13): 결론 → 투자 포인트 → 근거 숫자(접힘) → 공시 원문 근거 → 뉴스 단서 → 주의사항.
 * 결론 + 투자 포인트는 스마트폰 한 화면 안에 들어가야 한다 (data-testid="explanation-main").
 */
export function ExplanationPanel({
  explanation,
  charts,
  onShowChart,
}: {
  explanation: Explanation | null;
  charts: Chart[];
  onShowChart: (chartId: string) => void;
}) {
  const header = (
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-lg font-semibold">분석 글</h2>
      <span className="rounded-md border border-line px-2 py-0.5 text-xs font-medium text-muted">
        AI 작성
      </span>
    </div>
  );

  if (!explanation || explanation.status === "failed") {
    return (
      <article className="space-y-3">
        {header}
        <div
          role="status"
          className="rounded-xl border border-line border-l-4 border-l-danger bg-surface p-4"
        >
          <p className="font-semibold">{explanation?.failureMessage ?? "설명 생성 실패"}</p>
          <p className="mt-1 text-sm leading-6 text-muted">
            AI가 분석 글을 쓰지 못했습니다. 왼쪽 차트와 표는 서버가 공시 자료로 계산한 값
            그대로입니다.
          </p>
        </div>
      </article>
    );
  }

  const chartButton = (chartRef: string | null, label: string) =>
    chartRef && (
      <button
        type="button"
        onClick={() => onShowChart(chartRef)}
        className="ml-1.5 whitespace-nowrap text-sm text-accent underline underline-offset-4"
        aria-label={`${label}: ${charts.find((c) => c.id === chartRef)?.title ?? "차트"}`}
      >
        {label}
      </button>
    );

  // 투자 포인트가 근거로 단 뉴스 → 아래 "뉴스 단서"의 몇 번째 기사인지 (화면 번호 1부터)
  const newsOrder = new Map(explanation.newsClues.map((n, i) => [n.newsId, i + 1]));
  // 투자 포인트가 근거로 단 기사 — 나머지는 찾기만 한 참고용 기사 (서버가 근거 기사를 앞에 둔다)
  const citedNews = new Set(explanation.insights.flatMap((i) => i.newsIds));
  const showNews = (newsId: string) => {
    const item = document.getElementById(`news-clue-${newsId}`);
    item?.scrollIntoView({ behavior: "smooth", block: "center" });
    item?.focus({ preventScroll: true });
  };
  // 투자 포인트가 근거로 단 공시 원문 단락 → 아래 "공시 원문 근거"의 몇 번째인지
  const filingClues = explanation.filingClues ?? [];
  const filingOrder = new Map(filingClues.map((f, i) => [f.filingId, i + 1]));
  const showFiling = (filingId: string) => {
    const item = document.getElementById(`filing-clue-${filingId}`);
    item?.scrollIntoView({ behavior: "smooth", block: "center" });
    item?.focus({ preventScroll: true });
  };
  const filingButtons = (filingIds: string[] | undefined) =>
    (filingIds ?? [])
      .filter((id) => filingOrder.has(id))
      .map((id) => (
        <button
          key={id}
          type="button"
          onClick={() => showFiling(id)}
          className="ml-1.5 whitespace-nowrap text-sm text-accent underline underline-offset-4"
          aria-label={`근거 공시 원문 ${filingOrder.get(id)}번 보기`}
        >
          원문 {filingOrder.get(id)}
        </button>
      ));
  // 링크(a)가 아니라 버튼 — 분석 글 안의 링크는 RSS가 준 기사 주소뿐이어야 한다 (TECH §10.2)
  const newsButtons = (newsIds: string[]) =>
    newsIds
      .filter((id) => newsOrder.has(id))
      .map((id) => (
        <button
          key={id}
          type="button"
          onClick={() => showNews(id)}
          className="ml-1.5 whitespace-nowrap text-sm text-accent underline underline-offset-4"
          aria-label={`근거 뉴스 ${newsOrder.get(id)}번 보기`}
        >
          뉴스 {newsOrder.get(id)}
        </button>
      ));

  return (
    <article className="space-y-5">
      <div data-testid="explanation-main" className="space-y-4">
        {header}

        {explanation.status === "stale" && (
          <div
            className="rounded-lg bg-notice-bg px-3 py-2 text-sm text-notice-ink"
            data-testid="explanation-stale"
          >
            <p>원래 조건 기준 설명입니다.</p>
            {/* 보드 화면에서만 [설명 다시 쓰기]가 붙는다 (WU-401, BoardPanel이 context로 넘김) */}
            <RewriteSlot />
          </div>
        )}

        <section aria-labelledby="exp-conclusion">
          <h3 id="exp-conclusion" className="sr-only">
            결론
          </h3>
          <div className="space-y-1.5 text-[17px] font-medium leading-7 sm:text-lg sm:leading-8">
            {explanation.conclusion.map((sentence) => (
              // 재무 용어에 한 줄 설명 (WU-402 — Phase 3 통합 때 분석 글에도)
              <p key={sentence}>
                <TermText text={sentence} />
              </p>
            ))}
          </div>
        </section>

        {explanation.insights.length > 0 && (
          <section aria-labelledby="exp-insights">
            <h3 id="exp-insights" className="font-semibold">
              투자 포인트
            </h3>
            <ul className="mt-2 space-y-2.5">
              {explanation.insights.map((insight) => (
                <li key={insight.text} className="leading-7">
                  {/* 라벨을 문장 앞에 붙여 휴대폰 폭을 다 쓴다 (한 화면 분량, PRD F-V11) */}
                  <p>
                    <span
                      className={`mr-1.5 inline-block rounded px-1.5 text-xs font-semibold leading-5 ${KIND[insight.kind].className}`}
                    >
                      {KIND[insight.kind].label}
                    </span>
                    <TermText text={insight.text} />
                    {insight.inferred && (
                      <span
                        className="ml-1.5 whitespace-nowrap text-xs text-muted"
                        title={
                          insight.newsIds.length > 0
                            ? "뉴스 보도를 바탕으로 한 추정입니다 — 확인된 사실이 아닙니다"
                            : (insight.filingIds?.length ?? 0) > 0
                              ? "회사 공시 내용을 바탕으로 한 해석입니다"
                              : "숫자를 바탕으로 한 해석이 들어간 문장입니다"
                        }
                      >
                        (추정)
                      </span>
                    )}
                    {chartButton(insight.chartRef, "차트 보기")}
                    {filingButtons(insight.filingIds)}
                    {newsButtons(insight.newsIds)}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      {explanation.evidence.length > 0 && (
        <details className="group rounded-lg border border-line">
          <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-sm font-medium">
            근거 숫자 {explanation.evidence.length}개
            <span aria-hidden="true" className="transition-transform group-open:rotate-180">
              ▾
            </span>
          </summary>
          <ul className="space-y-2 border-t border-line px-3 py-3 text-sm leading-6">
            {explanation.evidence.map((e) => (
              <li key={e.text}>
                {e.text}
                {chartButton(e.chartRef, "해당 차트 보기")}
              </li>
            ))}
          </ul>
        </details>
      )}

      {filingClues.length > 0 && (
        <section aria-labelledby="exp-filings" data-testid="filing-clues">
          <h3 id="exp-filings" className="font-semibold">
            공시 원문 근거
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted">
            회사가 금융감독원 전자공시(DART)에 낸 보고서의 원문 그대로입니다. 분석 글은 이 내용을
            요약·해석한 것입니다.
          </p>
          <ul className="mt-2 space-y-3">
            {filingClues.map((f, i) => (
              <li
                key={f.filingId}
                id={`filing-clue-${f.filingId}`}
                tabIndex={-1}
                data-testid="filing-clue"
                className="scroll-mt-4 rounded-md outline-offset-4 focus:outline-2 focus:outline-accent"
              >
                <p className="text-sm font-medium">
                  <span className="mr-1.5 inline-block rounded bg-accent-soft px-1.5 text-xs font-semibold leading-5 text-accent">
                    원문 {i + 1}
                  </span>
                  {f.reportName} · {f.section}
                </p>
                {f.relevance && <p className="mt-1 text-sm leading-6">{f.relevance}</p>}
                <details className="group mt-1">
                  <summary className="cursor-pointer text-sm text-muted underline underline-offset-4">
                    원문 단락 보기
                  </summary>
                  <p className="mt-1 max-h-64 overflow-y-auto whitespace-pre-line break-words rounded-md border border-line bg-surface p-3 text-sm leading-6">
                    {f.excerpt}
                  </p>
                </details>
                {isDartViewerUrl(f.url) && (
                  <a
                    href={f.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 inline-block text-sm text-accent underline underline-offset-4"
                  >
                    DART에서 보고서 전체 보기
                    <span className="sr-only"> (새 탭에서 열림)</span>
                  </a>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {explanation.newsClues.length > 0 && (
        <section aria-labelledby="exp-news" data-testid="news-clues">
          <h3 id="exp-news" className="font-semibold">
            뉴스 단서
          </h3>
          {/* PRD F-W3·F-W4: 뉴스는 근거 숫자와 구분되는 "참고용 단서"다 (WU-305) */}
          <p className="mt-1 text-xs leading-5 text-muted">
            뉴스는 참고용 단서입니다. 기사 속 숫자·의견은 언론사 보도를 옮긴 것이고, 분석 숫자는
            차트(공시 자료)만 씁니다.
            {citedNews.size === 0 &&
              " 이번 분석 글은 기사를 근거로 쓰지 않았습니다 — 찾은 기사 목록입니다."}
          </p>
          <ul className="mt-2 space-y-3">
            {explanation.newsClues.map((n, i) => (
              <li
                key={n.newsId}
                id={`news-clue-${n.newsId}`}
                tabIndex={-1}
                data-testid="news-clue"
                className="scroll-mt-4 rounded-md outline-offset-4 focus:outline-2 focus:outline-accent"
              >
                <span className="sr-only">{i + 1}번 뉴스. </span>
                {citedNews.has(n.newsId) && (
                  <span
                    data-testid="news-cited"
                    className="mr-1.5 inline-block rounded bg-accent-soft px-1.5 text-xs font-semibold leading-5 text-accent"
                  >
                    분석 글 근거
                  </span>
                )}
                {/* 링크는 RSS가 준 주소 그대로 (TECH §10.2). Google 뉴스 주소가 아니면 링크로 만들지 않는다 (WU-504) */}
                {isGoogleNewsUrl(n.url) ? (
                  <a
                    href={n.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium underline underline-offset-4"
                  >
                    {n.title}
                    <span className="sr-only"> (새 탭에서 열림)</span>
                  </a>
                ) : (
                  <p className="font-medium">{n.title}</p>
                )}
                <p className="text-sm text-muted">
                  {n.press} · <time dateTime={n.publishedAt}>{kstDate(n.publishedAt)}</time>
                </p>
                {n.gist && <p className="mt-1 text-sm leading-6">{n.gist}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {explanation.caveats.length > 0 && (
        <section aria-labelledby="exp-caveats">
          <h3 id="exp-caveats" className="text-xs font-semibold text-muted">
            주의사항
          </h3>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs leading-5 text-muted">
            {explanation.caveats.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
