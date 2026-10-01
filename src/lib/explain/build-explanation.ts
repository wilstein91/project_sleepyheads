// TECH §11.3~11.5: AI 호출 ③의 원본 출력을 검사·조립해 최종 Explanation으로 만든다.
// 여기를 통과하지 못한 문장·투자 포인트는 통째로 버린다 — 절반만 채워지거나 지어낸 숫자가
// 섞인 문장을 내보내지 않는다.
import type { Chart, Explanation, Figure, FilingClue, Insight, NewsClue } from "@/contracts";
import { EXPLANATION_LIMITS } from "@/contracts";
import { buildDartDisclosureUrl } from "@/lib/disclosures/url";
import type { FilingPassage } from "@/lib/filings/passages";
import { containsBannedWord } from "./banned-words";
import { containsLeak } from "./output-guard";
import type { AiExplanation } from "./ai-explanation";
import { hasDisallowedRawNumber, resolveText } from "./placeholders";

const FIXED_DISCLAIMER = "본 분석은 투자 권유가 아닙니다.";
/** PRD §6.3.1 — 섞인 질문(범위 안 부분만 분석)일 때 분석 글 끝에 그대로 붙이는 고정 문구. */
const MIXED_SCOPE_NOTICE =
  "질문 중 기업 분석과 관련 없는 부분은 이 서비스의 범위를 벗어나 답변드리지 않았습니다. 양해 부탁드립니다.";

/** "때문", "원인", "영향으로" 등 — 뉴스 근거 없이 원인을 추정했는지 보는 실용적 신호(완전한 검사는 아니다). */
const CAUSAL_KEYWORDS = ["때문", "원인", "영향으로", "탓에", "덕분에", "여파로"];
/**
 * "원인을 다음 보고서에서 확인할 필요"처럼 원인을 단정하지 않고 앞으로 확인할 거리로 남기는 표현은 추정이 아니다.
 * "원인은 …로 확인됩니다"(단정)는 빼지 않도록 앞으로 할 일 형태(확인할·살펴볼…)만, 사이에 다른 원인 표현이 없을 때만.
 */
// "원인을 설명하지 않아 …특정하기 어렵다"처럼 원인을 **모른다고** 밝히는 표현도 같다 (2026-09-30 WU-305 실측).
const CAUSE_TO_CHECK =
  /원인(?:(?!때문|탓에|덕분에|여파로|영향으로)[^.?!])*?(확인할|확인이 필요|확인해야|파악할|점검할|살펴볼|지켜볼|설명하지 않|밝히지 않|특정하기 어렵|특정할 수 없|알 수 없)/g;
function looksLikeCausalClaim(text: string): boolean {
  const claim = text.replace(CAUSE_TO_CHECK, "");
  return CAUSAL_KEYWORDS.some((kw) => claim.includes(kw));
}

/**
 * 추론임을 드러내는 표현 (2026-10-01 예림 결정): 주어진 자료(API 숫자·뉴스 RSS) 안에서 추론해도 되지만,
 * 원인·전망을 말하는 문장은 반드시 "~로 예상됩니다·보입니다·추정됩니다·가능성이 있습니다"처럼 추론임을 밝힌다.
 */
const HEDGE_RE =
  /(예상됩니다|예상된다|예상돼|보입니다|보인다|보여|추정됩니다|추정된다|추정돼|가능성이|가능성도|풀이됩니다|해석됩니다|짐작됩니다|여겨집니다|전망됩니다)/;
export function isHedged(text: string): boolean {
  return HEDGE_RE.test(text);
}

/** 원인·전망 문장 검사: 추론 표현이 있어야 하고 근거(숫자 또는 뉴스)가 있어야 남는다. 남으면 추론 문장이다 */
function inferenceCheck(text: string, hasGround: boolean): { keep: boolean; inferred: boolean } {
  if (!looksLikeCausalClaim(text)) return { keep: true, inferred: isHedged(text) };
  return { keep: hasGround && isHedged(text), inferred: true };
}

/** 권유 금지어(§11.5) 또는 링크 주소·비밀 값(WU-504 주입 방어)이 든 문장은 버린다 */
function rejected(text: string): boolean {
  return containsBannedWord(text) || containsLeak(text);
}

function chartRefOrNull(ref: string | null, chartIds: ReadonlySet<string>): string | null {
  return ref && chartIds.has(ref) ? ref : null;
}

export function failedExplanation(): Explanation {
  return {
    status: "failed",
    conclusion: [],
    insights: [],
    evidence: [],
    newsClues: [],
    caveats: [],
    label: "AI 작성",
    failureMessage: "설명 생성 실패",
  };
}

export interface BuildExplanationInput {
  ai: AiExplanation;
  figures: Record<string, Figure>;
  charts: Chart[];
  newsClues: NewsClue[];
  hasNews: boolean;
  /** AI에 준 공시 원문 단락 (없으면 빈 배열) — 원인 문장은 뉴스 또는 이것을 근거로 달아야 남는다 */
  filings?: FilingPassage[];
  mixedScope: boolean;
  /**
   * 서버가 만든 "계산 불가 (사유): 지표 분기" 줄 (`result.basis.flags`, 트랙 B `unavailableFlags`) — 그대로 주의사항에.
   * AI는 값이 비어 있는 숫자를 쓸 수 없어(자리표시자 검사) 사유를 글에 못 쓰므로 서버가 붙인다 (WU-302·TECH §6.4)
   */
  unavailableNotes?: string[];
}

export function buildExplanation(input: BuildExplanationInput): Explanation {
  const chartIds = new Set(input.charts.map((c) => c.id));
  const newsClueById = new Map(input.newsClues.map((n) => [n.newsId, n]));
  // AI가 인용했다고 밝힌 뉴스 중 실제로 있는 것 (결론의 원인 문장은 이것이 있어야 남는다)
  const citedNewsIds = input.hasNews
    ? input.ai.news_clues.map((n) => n.news_id).filter((id) => newsClueById.has(id))
    : [];
  // 공시 원문도 같다 — 회사가 보고서에 직접 쓴 설명이라 원인 문장의 근거가 된다
  const filingById = new Map((input.filings ?? []).map((f) => [f.id, f]));
  const citedFilingIds = (input.ai.filing_clues ?? [])
    .map((f) => f.filing_id)
    .filter((id) => filingById.has(id));
  const conclusionSources = citedNewsIds.length + citedFilingIds.length;

  // 결론은 앞에서부터 최대 conclusionSentences문장, 합계가 mainMaxChars를 넘지 않게 (§11.5, EXPLANATION_LIMITS)
  const conclusion: string[] = [];
  let conclusionChars = 0;
  let conclusionUsesNews = false;
  for (const raw of input.ai.conclusion) {
    if (conclusion.length >= EXPLANATION_LIMITS.conclusionSentences) break;
    const text = resolveText(raw, input.figures);
    if (text === null || rejected(text)) continue;
    // 결론의 원인 문장도 추론 표현이 있어야 남는다 — 근거는 결과·리포트 숫자 자체 (TECH §11.5, 2026-10-01 개정)
    const causal = looksLikeCausalClaim(text);
    // 공시 원문을 인용한 결론은 회사가 직접 밝힌 설명이라 추론 표현 없이도 남는다
    if (causal && !isHedged(text) && conclusionSources === 0) continue;
    if (conclusionChars + text.length > EXPLANATION_LIMITS.mainMaxChars) continue;
    if (causal) conclusionUsesNews = true;
    conclusion.push(text);
    conclusionChars += text.length;
  }

  if (conclusion.length === 0) {
    return failedExplanation();
  }

  const insights: Insight[] = [];
  for (const raw of input.ai.insights) {
    const text = resolveText(raw.text, input.figures);
    if (text === null || rejected(text)) continue;
    if (text.length > EXPLANATION_LIMITS.insightMaxChars) continue;

    const figureIds = raw.figure_ids.filter((id) => id in input.figures);
    const newsIds = input.hasNews ? raw.news_ids.filter((id) => newsClueById.has(id)) : [];
    const filingIds = (raw.filing_ids ?? []).filter((id) => filingById.has(id));
    if (figureIds.length === 0 && newsIds.length === 0 && filingIds.length === 0) continue; // 근거 연결 검사
    // 원인·전망 추론은 근거(숫자·뉴스) + 추론 표현이 있어야 남는다 — `inferred` 자가 신고와 무관하게 문장 자체를 검사(우회 방지).
    // 공시 원문을 근거로 단 원인 문장은 회사가 보고서에 직접 쓴 설명이라 추론 표현 없이도 남는다.
    // AI가 추론이라고 밝힌(inferred) 문장도 추론 표현이 없으면 버린다
    const check =
      filingIds.length > 0 && looksLikeCausalClaim(text)
        ? { keep: true, inferred: isHedged(text) }
        : inferenceCheck(text, figureIds.length + newsIds.length > 0);
    if (!check.keep) continue;
    if (raw.inferred && !isHedged(text)) continue;

    insights.push({
      kind: raw.kind,
      theme: raw.theme ?? "general",
      text,
      figureIds,
      newsIds,
      filingIds,
      chartRef: chartRefOrNull(raw.chart_ref, chartIds),
      // 추론 표현이 있으면 화면에 "(추정)" 표시
      inferred: raw.inferred || check.inferred,
    });
  }

  // 분량 검사(§11.5): 결론+투자 포인트 합계가 mainMaxChars를 넘으면 뒤쪽 투자 포인트부터 폐기.
  let totalChars = conclusionChars;
  const keptInsights: Insight[] = [];
  for (const insight of insights) {
    if (keptInsights.length >= EXPLANATION_LIMITS.insightsMax) break;
    if (totalChars + insight.text.length > EXPLANATION_LIMITS.mainMaxChars) continue;
    keptInsights.push(insight);
    totalChars += insight.text.length;
  }

  const evidence = input.ai.evidence
    .map((e) => {
      const text = resolveText(e.text, input.figures);
      return text && !rejected(text)
        ? { text, chartRef: chartRefOrNull(e.chart_ref, chartIds) }
        : null;
    })
    .filter((e): e is { text: string; chartRef: string | null } => e !== null);

  // 화면의 뉴스 단서 = 찾은 기사 **전부**, 분석 글이 근거로 쓴 것을 앞에 (2026-09-30 WU-399: 기사가 모두 실적 전망이라
  // AI가 하나도 인용하지 않으면 뉴스 칸이 통째로 사라져 "뉴스가 안 된다"로 보였다). 근거로 쓴 기사는 화면이
  // 투자 포인트의 newsIds로 "분석 글 근거" 표시를 한다 — 인용하지 않은 기사는 참고용 목록일 뿐이다
  const referencedNewsIds = new Set([
    ...keptInsights.flatMap((i) => i.newsIds),
    ...(conclusionUsesNews ? citedNewsIds : []),
  ]);
  const newsClues = [
    ...input.newsClues.filter((n) => referencedNewsIds.has(n.newsId)),
    ...input.newsClues.filter((n) => !referencedNewsIds.has(n.newsId)),
  ];

  // 공시 원문 근거 = 남은 투자 포인트가 가리킨 단락 + AI가 인용했다고 밝힌 단락(결론은 "회사는 보고서에서 …"처럼
  // 원인 낱말 없이도 원문을 쓴다), 원문 순서대로. 글자는 원문 그대로(서버가 가진 것), 주소는 접수번호로 서버가 만든
  // DART 주소만. AI의 한 줄 설명은 숫자·금지어·주소가 있으면 뺀다
  const usedFilingIds = new Set([
    ...keptInsights.flatMap((i) => i.filingIds ?? []),
    ...citedFilingIds,
  ]);
  const relevanceById = new Map(
    (input.ai.filing_clues ?? []).map((f) => [f.filing_id, f.relevance]),
  );
  const filingClues: FilingClue[] = (input.filings ?? [])
    .filter((f) => usedFilingIds.has(f.id))
    .map((f) => {
      const relevance = (relevanceById.get(f.id) ?? "").trim();
      const safe = relevance && !hasDisallowedRawNumber(relevance) && !rejected(relevance);
      return {
        filingId: f.id,
        reportName: f.reportName,
        section: f.section,
        excerpt: f.text,
        url: buildDartDisclosureUrl(f.rceptNo),
        relevance: safe ? relevance : "",
      };
    });

  const caveats = [
    FIXED_DISCLAIMER,
    ...input.ai.caveats
      .map((raw) => resolveText(raw, input.figures))
      .filter((text): text is string => text !== null && !rejected(text)),
    ...(input.unavailableNotes ?? []),
    ...(input.mixedScope ? [MIXED_SCOPE_NOTICE] : []),
  ];

  return {
    status: "ready",
    conclusion,
    insights: keptInsights,
    evidence,
    newsClues,
    filingClues,
    caveats,
    label: "AI 작성",
  };
}
