// 뽑은 공시 원문(extract.ts)을 작은 단락 묶음으로 나누고, 질문에 맞는 것만 글자 수 예산 안에서 고른다.
// 순수 함수만 둔다. 임베딩(유료 AI) 없이 낱말 겹침으로 고른다 — 추가 비용·시간 0.
import type { MetricId } from "@/contracts";
import type { ExtractedFiling, FilingSection, FilingSectionKind } from "./extract";

/** AI에 주는 공시 원문 단락 하나. 화면에도 이 글자를 그대로 보여 준다 (AI가 바꾸지 않는다) */
export interface FilingPassage {
  /** "d1"부터 — 분석 글이 근거로 가리키는 ID */
  id: string;
  kind: FilingSectionKind;
  /** "사업보고서 (2025.12)" */
  reportName: string;
  rceptNo: string;
  /** "II. 사업의 내용 › 4. 매출 및 수주상황" */
  section: string;
  text: string;
}

export interface FilingSource {
  rceptNo: string;
  reportName: string;
  filing: ExtractedFiling;
}

/** 한 단락 묶음의 최대 글자 수 — 표 몇 줄과 설명 문단이 함께 들어갈 만큼 */
export const PASSAGE_MAX_CHARS = 1_200;
/** AI에 주는 공시 원문 전체 예산 (기본). 실측: 한글 1자 ≈ 0.6~0.7토큰 */
export const DEFAULT_FILING_BUDGET_CHARS = 12_000;

/** 지표·질문 낱말 → 원문에서 함께 찾을 낱말 (재무 용어가 원문에서 쓰이는 이름) */
const RELATED_TERMS: Record<string, string[]> = {
  매출: ["매출", "수주", "판매", "가격", "수요", "출하", "제품", "고객"],
  영업이익: ["영업이익", "원가", "판매비", "수익성", "마진", "비용", "가동률", "가격"],
  순이익: ["순이익", "법인세", "금융수익", "금융비용", "영업외", "환율", "지분법"],
  이익률: ["이익률", "원가", "수익성", "판매비", "가격", "제품 믹스"],
  부채: ["부채", "차입금", "사채", "자금조달", "유동성", "이자", "우발부채", "담보"],
  자본: ["자본", "자기자본", "배당", "자기주식", "유상증자"],
  현금: ["현금흐름", "현금", "유동성", "자금", "투자활동", "설비투자"],
  투자: ["설비투자", "투자", "CAPEX", "증설", "생산능력", "연구개발"],
  주가: ["주가", "배당", "자기주식", "주주환원"],
  per: ["순이익", "주당이익", "배당"],
  pbr: ["자본", "순자산", "배당"],
  위험: ["위험", "리스크", "불확실", "환율", "소송", "우발", "규제"],
  경쟁: ["경쟁", "점유율", "시장", "경쟁사"],
  전망: ["전망", "계획", "예상", "향후", "목표", "추진"],
  연구개발: ["연구개발", "R&D", "기술", "특허", "개발"],
};

/** 지표와 상관없이 늘 먼저 넣는 부분 (회사가 무엇을 하는지·경영진이 실적을 어떻게 설명하는지) */
const ALWAYS_SECTIONS = [/사업의 개요/, /^2\. 개요/, /재무상태 및 영업실적/, /영업부문/];

/** 지표 → 함께 읽을 주석 제목 낱말. 주석은 수십 개라 제목으로만 고른다 (본문 낱말로 고르면 "비용"이 금융비용·법인세비용까지 끌어온다) */
const NOTE_TITLES: Partial<Record<MetricId, string[]>> = {
  revenue: ["매출", "영업부문", "수익"],
  operating_income: ["영업부문", "비용의 성격", "판매비"],
  operating_margin: ["영업부문", "비용의 성격", "판매비"],
  net_income: ["금융수익", "법인세", "기타영업외", "관계기업"],
  net_margin: ["금융수익", "법인세", "기타영업외"],
  ttm_owners_ni: ["법인세", "금융수익", "비지배"],
  roe: ["자본금", "이익잉여금"],
  debt_ratio: ["차입금", "사채", "우발부채", "금융위험"],
  equity_ratio: ["차입금", "자본금", "우발부채"],
  per: ["주당이익"],
  pbr: ["자본금", "이익잉여금"],
};

/** 지표들에 맞는 주석 제목 낱말 */
export function noteTitleTerms(metrics: readonly MetricId[]): string[] {
  return [...new Set(metrics.flatMap((m) => NOTE_TITLES[m] ?? []))];
}

/** 낱말 끝의 조사("영업이익이"→"영업이익")를 떼어 낸다 — 두 글자 이하가 되면 그대로 */
function stripParticle(w: string): string {
  const cut = w.replace(/(이|가|은|는|을|를|의|에|도|과|와|로|으로|에서|이랑)$/u, "");
  return cut.length >= 2 ? cut : w;
}

/** 문장에서 낱말(한글·영문 2자 이상)을 뽑는다 */
function words(text: string): string[] {
  return (text.match(/[가-힣A-Za-z&]{2,}/g) ?? []).map((w) => stripParticle(w.toLowerCase()));
}

/** 질문과 지표 이름으로 찾을 낱말 목록 */
export function queryTerms(question: string, metricLabels: readonly string[]): string[] {
  const base = [...words(question), ...metricLabels.flatMap(words)];
  const expanded = new Set<string>();
  for (const w of base) {
    expanded.add(w);
    for (const [key, related] of Object.entries(RELATED_TERMS)) {
      if (w.includes(key) || key.includes(w)) related.forEach((r) => expanded.add(r.toLowerCase()));
    }
  }
  // 질문에 흔히 붙는 말은 원문 어디에나 있어 고르는 데 도움이 안 된다
  const stops = [
    "분석",
    "어때",
    "어떤",
    "알려줘",
    "최근",
    "분기",
    "변화",
    "회사",
    "기업",
    "이렇게",
    "얼마나",
  ];
  for (const stop of stops) {
    expanded.delete(stop);
  }
  return [...expanded].filter((w) => w.length >= 2);
}

/** 한 부분(사업의 내용 등)을 하위 제목·문단 경계에서 PASSAGE_MAX_CHARS 이하 묶음으로 */
export function chunkSection(section: FilingSection): { heading: string; text: string }[] {
  const lines = section.text.split("\n");
  const chunks: { heading: string; text: string }[] = [];
  let heading = section.title;
  let buf: string[] = [];
  let size = 0;
  const flush = () => {
    const text = buf.join("\n").trim();
    if (text.length >= 40) chunks.push({ heading, text });
    buf = [];
    size = 0;
  };
  for (const line of lines) {
    // "3. 원재료 및 생산설비"·"가. 주요 제품" 같은 하위 제목 → 새 묶음 시작
    const isHeading = line.length <= 60 && /^(\d{1,2}|[가-하])\.\s/.test(line);
    if (isHeading) {
      flush();
      heading = /^\d/.test(line)
        ? `${section.title} › ${line}`
        : `${heading.split(" · ")[0]} · ${line}`;
      continue;
    }
    // 아주 긴 한 줄(문단)은 잘라 넣는다
    for (let i = 0; i < line.length; i += PASSAGE_MAX_CHARS) {
      const piece = line.slice(i, i + PASSAGE_MAX_CHARS);
      if (size + piece.length > PASSAGE_MAX_CHARS) flush();
      buf.push(piece);
      size += piece.length + 1;
    }
  }
  flush();
  return chunks;
}

/** "반기보고서에는 본 항목을 기재하지 아니하였습니다" 같은 빈 안내 */
function isOmitted(text: string): boolean {
  return text.length < 300 && /기재하지 아니|기재를 생략|기재 생략|해당사항 없/.test(text);
}

interface Candidate {
  source: FilingSource;
  kind: FilingSectionKind;
  heading: string;
  text: string;
  score: number;
  order: number;
}

function scoreOf(text: string, heading: string, terms: readonly string[]): number {
  const lower = text.toLowerCase();
  const head = heading.toLowerCase();
  let score = 0;
  for (const t of terms) {
    // 제목에 있으면 크게, 본문에는 등장 횟수만큼(최대 3) — 긴 단락이 무조건 이기지 않게 길이로 나눈다
    if (head.includes(t)) score += 3;
    let n = 0;
    for (let i = lower.indexOf(t); i >= 0 && n < 3; i = lower.indexOf(t, i + t.length)) n++;
    score += n;
  }
  // 숫자만 가득한 표 조각보다 설명 문장이 있는 단락을 앞에
  const sentences = (text.match(/니다\./g) ?? []).length;
  return (score + Math.min(sentences, 4) * 0.5) / Math.sqrt(Math.max(text.length, 200) / 600);
}

/**
 * 공시 원문 단락 고르기. 순서: ① 늘 넣는 부분(사업의 개요·경영진단 개요·영업실적·영업부문) 앞 단락
 * ② 질문 낱말과 많이 겹치는 단락 — 예산(budgetChars)이 찰 때까지. 주석은 제목이 질문과 겹칠 때만.
 */
export function selectPassages(
  sources: readonly FilingSource[],
  query: { terms: readonly string[]; noteTitles: readonly string[] },
  budgetChars = DEFAULT_FILING_BUDGET_CHARS,
): FilingPassage[] {
  const { terms, noteTitles } = query;
  const candidates: Candidate[] = [];
  let order = 0;
  for (const source of sources) {
    const sections = [source.filing.business, source.filing.mdna].filter(
      (s): s is FilingSection => s !== null,
    );
    for (const section of sections) {
      for (const chunk of chunkSection(section)) {
        if (isOmitted(chunk.text)) continue;
        candidates.push({
          source,
          kind: section.kind,
          ...chunk,
          score: scoreOf(chunk.text, chunk.heading, terms),
          order: order++,
        });
      }
    }
    for (const note of source.filing.notes) {
      const titleHit = noteTitles.some((t) => note.title.includes(t));
      const always = ALWAYS_SECTIONS.some((re) => re.test(note.title));
      if (!titleHit && !always) continue;
      for (const chunk of chunkSection({ ...note, title: `주석 ${note.title}` })) {
        candidates.push({
          source,
          kind: "notes",
          ...chunk,
          score: scoreOf(chunk.text, chunk.heading, terms) + (titleHit ? 2 : 0),
          order: order++,
        });
      }
    }
  }

  const picked = new Set<Candidate>();
  let used = 0;
  const take = (c: Candidate) => {
    if (picked.has(c) || used + c.text.length > budgetChars) return;
    picked.add(c);
    used += c.text.length;
  };

  // ① 늘 넣는 부분: 그 제목의 첫 단락 하나씩
  for (const re of ALWAYS_SECTIONS) {
    const first = candidates.find((c) => re.test(c.heading.split(" › ").at(-1) ?? ""));
    if (first) take(first);
  }
  // ② 점수 순
  for (const c of [...candidates].sort((a, b) => b.score - a.score)) {
    if (c.score <= 0) break;
    take(c);
  }

  // 원문 순서대로 돌려준다 (읽기 쉽게) — ID도 이 순서로
  return [...picked]
    .sort((a, b) => a.order - b.order)
    .map((c, i) => ({
      id: `d${i + 1}`,
      kind: c.kind,
      reportName: c.source.reportName,
      rceptNo: c.source.rceptNo,
      section: c.heading,
      text: c.text,
    }));
}
