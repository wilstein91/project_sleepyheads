// @vitest-environment node
import { describe, expect, it } from "vitest";
import { extractFiling, findSection, xmlToText } from "@/lib/filings/extract";
import {
  chunkSection,
  noteTitleTerms,
  queryTerms,
  selectPassages,
  type FilingSource,
} from "@/lib/filings/passages";

// 공시 원문(document.xml) 추출·단락 고르기 — 실제 SK하이닉스 보고서 구조를 줄여 옮긴 가짜 원문 (외부 호출 없음).
// 실제 보고서 5건(SK하이닉스·삼성전자·카카오·ISC 사업보고서, SK하이닉스 반기보고서) 측정은 TECH §3.1 메모.

const XML = `<?xml version="1.0" encoding="utf-8"?>
<DOCUMENT><BODY>
<SECTION-1 ACLASS="MANDATORY"><TITLE ATOC="Y" ATOCID="3">I. 회사의 개요</TITLE><P>개요 글</P></SECTION-1>
<SECTION-1 ACLASS="MANDATORY">
<TITLE ATOC="Y" AASSOCNOTE="D-0-2-0-0" ATOCID="9">II. 사업의 내용</TITLE>
<SECTION-2><TITLE ATOC="Y" AASSOCNOTE="L-0-2-1-L1">1. 사업의 개요</TITLE>
<P>당사는 DRAM과 NAND Flash를 주력으로 생산하는 글로벌 반도체 기업입니다. 메모리 반도체 수요는 AI 서버를 중심으로 늘고 있습니다.</P>
</SECTION-2>
<SECTION-2><TITLE ATOC="Y" AASSOCNOTE="L-0-2-4-L1">4. 매출 및 수주상황</TITLE>
<TABLE><TBODY>
<TR><TH>구분</TH><TH>제79기</TH><TH></TH></TR>
<TR><TD>DRAM &amp; HBM</TD><TD><P>1,234</P></TD><TD></TD></TR>
</TBODY></TABLE>
<P>2분기는 고부가 제품 판매가 늘며 가격 상승세가 이어졌습니다. 회사는 원가 절감도 함께 추진하였습니다.</P>
</SECTION-2>
</SECTION-1>
<SECTION-1 ACLASS="MANDATORY"><TITLE ATOC="Y" AASSOCNOTE="D-0-3-0-0">III. 재무에 관한 사항</TITLE>
<SECTION-2><TITLE ATOC="Y" AASSOCNOTE="D-0-3-3-0">3. 연결재무제표 주석</TITLE>
<TABLE-GROUP><TITLE ATOC="Y">4. 영업부문 (연결)</TITLE>
<P>연결회사는 반도체 제품의 제조 및 판매의 단일영업부문으로 구성되어 있습니다. 지역별 매출은 미국이 가장 큽니다.</P></TABLE-GROUP>
<TABLE-GROUP><TITLE ATOC="Y">16. 차입금 (연결)</TITLE>
<P>차입금은 은행 차입과 사채로 구성되어 있으며, 일부는 유형자산을 담보로 제공하고 있습니다. 만기는 다양합니다.</P></TABLE-GROUP>
<TABLE-GROUP><TITLE ATOC="Y">27. 금융수익 및 금융비용 (연결)</TITLE>
<P>금융수익은 이자수익과 외환차이로 구성되며, 금융비용은 이자비용과 외환차손으로 구성되어 있습니다.</P></TABLE-GROUP>
</SECTION-2>
</SECTION-1>
<SECTION-1 ACLASS="MANDATORY"><TITLE ATOC="Y" AASSOCNOTE="D-0-4-0-0">IV. 이사의 경영진단 및 분석의견</TITLE>
<P>※ 기업공시서식 작성기준에 따라 반기보고서에는 본 항목을 기재하지 아니하였습니다.</P>
</SECTION-1>
</BODY></DOCUMENT>`;

describe("xmlToText", () => {
  it("표 한 행을 '칸 | 칸' 한 줄로, 빈 칸·칸 안 문단 줄바꿈은 정리하고 &amp;를 푼다", () => {
    const text = xmlToText(
      "<TABLE><TR><TD>DRAM &amp; HBM</TD><TD><P>1,234</P></TD><TD></TD></TR></TABLE><P>문단</P>",
    );
    expect(text).toBe("DRAM & HBM | 1,234\n문단");
  });

  it("빈 칸이 아주 많은 행도 금방 끝난다 (정규식 되돌아가기 폭발 방지)", () => {
    const row = `<TR>${"<TD> </TD>".repeat(5_000)}<TD>값</TD></TR>`;
    const started = Date.now();
    expect(xmlToText(row)).toBe("값");
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("extractFiling", () => {
  it("목차 코드로 사업의 내용·연결 주석을 뽑고, 같은 단계 다음 SECTION에서 끊는다", () => {
    const filing = extractFiling(XML);
    expect(filing.business?.title).toBe("II. 사업의 내용");
    expect(filing.business?.text).toContain("1. 사업의 개요");
    expect(filing.business?.text).toContain("DRAM & HBM | 1,234");
    expect(filing.business?.text).not.toContain("III. 재무에 관한 사항");
    expect(filing.notes.map((n) => n.title)).toEqual([
      "4. 영업부문 (연결)",
      "16. 차입금 (연결)",
      "27. 금융수익 및 금융비용 (연결)",
    ]);
  });

  it("'기재하지 아니하였습니다'만 있는 경영진단(반기보고서)은 없음으로 본다", () => {
    expect(extractFiling(XML).mdna).toBeNull();
  });

  it("없는 목차 코드는 null", () => {
    expect(findSection(XML, "D-9-9-9-9")).toBeNull();
    expect(extractFiling("<DOCUMENT></DOCUMENT>")).toEqual({
      business: null,
      mdna: null,
      notes: [],
    });
  });
});

describe("단락 나누기·고르기", () => {
  const source: FilingSource = {
    rceptNo: "20260814003509",
    reportName: "2026 반기보고서",
    filing: extractFiling(XML),
  };

  it("하위 제목마다 새 단락, 단락 이름에 상위 제목을 붙인다", () => {
    const chunks = chunkSection(source.filing.business!);
    expect(chunks.map((c) => c.heading)).toEqual([
      "II. 사업의 내용 › 1. 사업의 개요",
      "II. 사업의 내용 › 4. 매출 및 수주상황",
    ]);
  });

  it("질문 낱말에서 조사를 떼고 관련 낱말로 넓힌다", () => {
    const terms = queryTerms("영업이익이 왜 늘었어?", ["영업이익"]);
    expect(terms).toContain("영업이익");
    expect(terms).toContain("원가");
    expect(terms).not.toContain("영업이익이");
  });

  it("주석은 지표에 맞는 제목만 — 영업이익이면 영업부문, 금융비용·차입금은 빠진다", () => {
    const passages = selectPassages([source], {
      terms: queryTerms("영업이익이 왜 늘었어?", ["영업이익"]),
      noteTitles: noteTitleTerms(["operating_income"]),
    });
    const sections = passages.map((p) => p.section);
    expect(sections).toContain("주석 4. 영업부문 (연결)");
    expect(sections.some((s) => s.includes("차입금") || s.includes("금융비용"))).toBe(false);
    // 원문 순서대로 d1부터, 출처 보고서·접수번호가 붙는다
    expect(passages.map((p) => p.id)).toEqual(passages.map((_, i) => `d${i + 1}`));
    expect(passages[0]).toMatchObject({ reportName: "2026 반기보고서", rceptNo: "20260814003509" });
  });

  it("부채비율 질문이면 차입금 주석을 읽는다", () => {
    const passages = selectPassages([source], {
      terms: queryTerms("부채비율 알려줘", ["부채비율"]),
      noteTitles: noteTitleTerms(["debt_ratio"]),
    });
    expect(passages.map((p) => p.section)).toContain("주석 16. 차입금 (연결)");
  });

  it("글자 수 예산을 넘지 않는다", () => {
    const passages = selectPassages(
      [source],
      { terms: ["반도체", "가격", "원가"], noteTitles: ["영업부문", "차입금", "금융수익"] },
      150,
    );
    expect(passages.reduce((n, p) => n + p.text.length, 0)).toBeLessThanOrEqual(150);
  });
});

describe("pickFilingReports", () => {
  it("대상 기업의 가장 최근 보고서와 가장 최근 사업보고서 (같으면 하나)", async () => {
    const { pickFilingReports } = await import("@/lib/filings");
    const src = (corpCode: string, bsnsYear: number, reprtCode: string, rceptNo: string | null) =>
      ({ corpCode, bsnsYear, reprtCode, fsDiv: "CFS", rceptNo }) as never;
    const sources = [
      src("A", 2025, "11011", "20260317000635"),
      src("A", 2026, "11013", "20260515002287"),
      src("A", 2026, "11012", "20260814003509"),
      src("B", 2026, "11012", "20260814999999"),
      src("A", 2026, "11014", null),
    ];
    expect(pickFilingReports(sources, "A").map((s) => (s as { rceptNo: string }).rceptNo)).toEqual([
      "20260814003509",
      "20260317000635",
    ]);
    expect(pickFilingReports([sources[0]], "A")).toHaveLength(1);
    expect(pickFilingReports(sources, "C")).toEqual([]);
  });
});
