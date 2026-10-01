import { describe, expect, it } from "vitest";
import { EXPLANATION_LIMITS, type Analysis } from "@/contracts";
import { samsungRevenueTrend } from "../fixtures/mock/samsung-revenue-trend";
import { skhynixRecent } from "../fixtures/mock/skhynix-recent";

// 분석 글 규칙 (PRD F-V11~F-V13, TECH §11.3·§11.5). 가짜 데이터도 실제 서버와 같은 규칙을 지켜야
// 화면이 규칙에 맞게 만들어졌는지 확인할 수 있다. 서버 쪽 검사(WU-111)도 같은 상한을 쓴다.
const BANNED =
  /매수|매도|보유 의견|추천|목표\s?주가|사야|팔아|저평가|고평가|오를 것|내릴 것|상승할 전망|하락할 전망/;

const fixtures: Analysis[] = [samsungRevenueTrend, skhynixRecent];

for (const analysis of fixtures) {
  const { explanation, result } = analysis;

  describe(`분석 글 규칙 — ${analysis.question}`, () => {
    it(`결론 ${EXPLANATION_LIMITS.conclusionSentences}문장 이내, 투자 포인트 ${EXPLANATION_LIMITS.insightsMin}~${EXPLANATION_LIMITS.insightsMax}개`, () => {
      expect(explanation!.conclusion.length).toBeGreaterThanOrEqual(1);
      expect(explanation!.conclusion.length).toBeLessThanOrEqual(
        EXPLANATION_LIMITS.conclusionSentences,
      );
      expect(explanation!.insights.length).toBeGreaterThanOrEqual(EXPLANATION_LIMITS.insightsMin);
      expect(explanation!.insights.length).toBeLessThanOrEqual(EXPLANATION_LIMITS.insightsMax);
    });

    it(`결론 + 투자 포인트 ${EXPLANATION_LIMITS.mainMaxChars}자 이내, 투자 포인트 한 개 ${EXPLANATION_LIMITS.insightMaxChars}자 이내`, () => {
      const main = [...explanation!.conclusion, ...explanation!.insights.map((i) => i.text)];
      expect(main.join("").length).toBeLessThanOrEqual(EXPLANATION_LIMITS.mainMaxChars);
      for (const insight of explanation!.insights) {
        expect(insight.text.length, insight.text).toBeLessThanOrEqual(
          EXPLANATION_LIMITS.insightMaxChars,
        );
      }
    });

    it("투자 포인트마다 근거(숫자 ID 또는 뉴스)가 있고, 가리키는 숫자·차트가 실제로 있다", () => {
      const chartIds = result!.charts.map((c) => c.id);
      for (const insight of explanation!.insights) {
        expect(insight.figureIds.length + insight.newsIds.length, insight.text).toBeGreaterThan(0);
        for (const id of insight.figureIds) expect(result!.figures[id], id).toBeDefined();
        if (insight.chartRef) expect(chartIds).toContain(insight.chartRef);
      }
    });

    it("긍정 요인과 위험 요인이 함께 있다 (한쪽으로 치우치지 않기)", () => {
      const kinds = explanation!.insights.map((i) => i.kind);
      expect(kinds).toContain("positive");
      expect(kinds).toContain("risk");
    });

    it("권유·가격 판단 표현이 없다", () => {
      const all = [...explanation!.conclusion, ...explanation!.insights.map((i) => i.text)];
      for (const sentence of all) expect(sentence).not.toMatch(BANNED);
    });

    it("뉴스 근거가 없으면 원인(왜)을 단정하지 않는다", () => {
      for (const insight of explanation!.insights.filter((i) => i.newsIds.length === 0)) {
        expect(insight.text).not.toMatch(/때문|덕분|영향으로/);
      }
    });
  });
}
