// 가짜 모드: 공시 원문 근거가 붙은 분석 글 (2026-10-01). 질문에 "원문"이 들어가면 SK하이닉스 결과에 붙는다.
// 단락 글자는 SK하이닉스 2026 반기보고서(접수번호 20260814003509) 원문을 줄여 옮긴 것이다.
import type { Explanation, FilingClue } from "@/contracts";

export const MOCK_FILING_CLUES: FilingClue[] = [
  {
    filingId: "d1",
    reportName: "2026 반기보고서",
    section: "II. 사업의 내용 › 2. 주요 제품 및 서비스 · 나. 주요 제품 등의 가격변동추이",
    excerpt:
      "DRAM은 HBM3E와 AI향 서버 DRAM 제품 중심으로 판매를 확대하여 출하량이 소폭 증가하였으며, ASP는 일반 DRAM 가격 강세 지속으로 상승하였습니다.\nNAND는 AI향 데이터센터에 필요한 고용량 기업용 SSD 판매가 늘었습니다.",
    url: "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260814003509",
    relevance: "회사가 주요 메모리 제품의 판매 확대와 가격 상승을 설명합니다.",
  },
  {
    filingId: "d2",
    reportName: "2026 반기보고서",
    section: "II. 사업의 내용 › 7. 기타 참고사항 · 나. 회사의 현황",
    excerpt:
      "(가) 영업개황\n2분기는 AI 인프라 투자 확대에 따른 수요 강세와 제한된 공급 환경 지속으로 가격 상승세가 이어졌습니다.",
    url: "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260814003509",
    relevance: "회사가 AI 관련 수요와 공급 환경을 분기 실적의 배경으로 설명합니다.",
  },
];

/** 분석 글에 공시 원문 근거를 붙인다. 긍정 요인 하나를 원문 근거 문장으로 바꾼다 (근거 연결: filingIds) */
export function withMockFilingClues(explanation: Explanation): Explanation {
  const insights = explanation.insights.map((insight, i) =>
    i === 0
      ? {
          ...insight,
          text: "회사는 반기보고서에서 HBM·서버 DRAM 판매 확대와 메모리 가격 상승을 실적 배경으로 설명합니다.",
          filingIds: ["d1", "d2"],
          inferred: false,
        }
      : insight,
  );
  return { ...explanation, insights, filingClues: structuredClone(MOCK_FILING_CLUES) };
}
