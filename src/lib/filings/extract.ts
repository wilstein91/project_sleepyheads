// 공시 원문(OpenDART `document.xml`, dart4.xsd 형식)에서 정성 분석에 쓸 부분만 글자로 뽑는다.
// 순수 함수만 둔다 — 외부 호출·DB 없음. 보고서마다 제목 글자는 조금씩 달라도 목차 코드(AASSOCNOTE)는
// 금융감독원 서식이라 회사·보고서 종류와 관계없이 같다 (2026-10-01 SK하이닉스·삼성전자·카카오·ISC 사업보고서,
// SK하이닉스 반기보고서로 확인).

/** 뽑는 부분과 그 목차 코드 */
export const FILING_SECTION_CODES = {
  /** II. 사업의 내용 */
  business: "D-0-2-0-0",
  /** IV. 이사의 경영진단 및 분석의견 (분기·반기보고서는 대개 "기재 생략") */
  mdna: "D-0-4-0-0",
  /** III-3. 연결재무제표 주석 */
  notesConsolidated: "D-0-3-3-0",
  /** III-5. (별도)재무제표 주석 — 연결 주석이 없는 회사용 */
  notesSeparate: "D-0-3-5-0",
} as const;

export type FilingSectionKind = "business" | "mdna" | "notes";

export interface FilingSection {
  kind: FilingSectionKind;
  /** 보고서에 적힌 제목 ("II. 사업의 내용", "24. 매출액 (연결)") */
  title: string;
  text: string;
}

export interface ExtractedFiling {
  business: FilingSection | null;
  mdna: FilingSection | null;
  /** 주석 하나하나 (연결 주석, 없으면 별도 주석) */
  notes: FilingSection[];
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code =
        name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/**
 * 원문 조각 → 읽을 수 있는 글자. 표는 한 행을 "칸 | 칸 | 칸" 한 줄로, 문단은 줄바꿈으로 남긴다
 * (숫자가 어느 항목의 값인지 AI가 알 수 있게). 빈 행·빈 칸·연속 공백은 버린다.
 */
export function xmlToText(xml: string): string {
  const withBreaks = xml
    // 표 한 행 → "칸 | 칸 | 칸" 한 줄 (칸 안의 문단 줄바꿈은 공백으로)
    .replace(/<TR\b[^>]*>([\s\S]*?)<\/TR>/gi, (_row, inner: string) => {
      const cells: string[] = [];
      const cellRe = /<(TD|TH|TE|TU)\b[^>]*>([\s\S]*?)<\/\1>/gi;
      for (let m = cellRe.exec(inner); m; m = cellRe.exec(inner)) {
        cells.push(m[2].replace(/<[^>]+>/g, " "));
      }
      return `${cells.join(" | ")}\n`;
    })
    // 문단·제목 끝 → 줄바꿈
    .replace(/<\/(P|TITLE|SPAN-BLOCK|LIBRARY)>/gi, "\n")
    .replace(/<BR\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "");

  // 칸 정리는 정규식 대신 나눠서 한다 — 빈 칸이 많은 행에서 "(\s*\|\s*)+" 같은 식은 되돌아가기가 폭발한다
  return decodeEntities(withBreaks)
    .split("\n")
    .map((line) =>
      line
        .split("|")
        .map((cell) => cell.replace(/[\s 　]+/g, " ").trim())
        .filter((cell) => cell.length > 0)
        .join(" | "),
    )
    .filter((line) => line.length > 0)
    .join("\n");
}

/** 목차 코드가 `code`인 SECTION-n 하나의 원문 (없으면 null) */
export function findSection(xml: string, code: string): { title: string; body: string } | null {
  const titleRe = new RegExp(`<TITLE[^>]*AASSOCNOTE="${code}"[^>]*>([\\s\\S]*?)</TITLE>`, "i");
  const titleMatch = titleRe.exec(xml);
  if (!titleMatch) return null;

  // 제목 바로 앞의 <SECTION-n ...> 를 찾아 같은 단계의 닫는 태그까지 (같은 단계 SECTION은 겹쳐 열리지 않는다)
  const before = xml.slice(0, titleMatch.index);
  const openRe = /<SECTION-(\d+)\b[^>]*>/gi;
  let level: string | null = null;
  for (let m = openRe.exec(before); m; m = openRe.exec(before)) level = m[1];
  if (!level) return null;

  const start = titleMatch.index + titleMatch[0].length;
  const end = xml.indexOf(`</SECTION-${level}>`, start);
  return {
    title: xmlToText(titleMatch[1]),
    body: xml.slice(start, end < 0 ? undefined : end),
  };
}

/** 주석 구역 원문 → 주석 하나씩 (각 주석은 `<TITLE ATOC="Y">n. 제목</TITLE>`으로 시작) */
export function splitNotes(body: string): { title: string; body: string }[] {
  const re = /<TITLE[^>]*ATOC="Y"[^>]*>([\s\S]*?)<\/TITLE>/gi;
  const marks: { title: string; start: number; end: number }[] = [];
  for (let m = re.exec(body); m; m = re.exec(body)) {
    marks.push({ title: xmlToText(m[1]), start: m.index, end: m.index + m[0].length });
  }
  return marks.map((mark, i) => ({
    title: mark.title,
    body: body.slice(mark.end, i + 1 < marks.length ? marks[i + 1].start : undefined),
  }));
}

/** "기재 생략"·"해당사항 없음"처럼 내용이 없는 부분인가 */
function isEmptySection(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  if (compact.length < 40) return true;
  // 반기보고서의 경영진단은 하위 항목마다 "…기재하지 아니하였습니다" 한 줄씩이라 길이만으로는 못 거른다 (실측 362자)
  return text.length < 600 && /기재하지 아니|기재를 생략|기재 생략|해당사항 없/.test(text);
}

/** 원문 XML 전체 → 사업의 내용·경영진단·주석 */
export function extractFiling(xml: string): ExtractedFiling {
  const business = findSection(xml, FILING_SECTION_CODES.business);
  const mdna = findSection(xml, FILING_SECTION_CODES.mdna);
  const notesRaw =
    findSection(xml, FILING_SECTION_CODES.notesConsolidated) ??
    findSection(xml, FILING_SECTION_CODES.notesSeparate);

  const section = (kind: FilingSectionKind, found: { title: string; body: string } | null) => {
    if (!found) return null;
    const text = xmlToText(found.body);
    return isEmptySection(text) ? null : { kind, title: found.title, text };
  };

  const notes: FilingSection[] = notesRaw
    ? splitNotes(notesRaw.body)
        .map((n) => ({ kind: "notes" as const, title: n.title, text: xmlToText(n.body) }))
        .filter((n) => !isEmptySection(n.text))
    : [];

  return { business: section("business", business), mdna: section("mdna", mdna), notes };
}
