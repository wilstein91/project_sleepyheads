import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanyReport, Figure, ResultObject } from "@/contracts";
import { skhynixRecent } from "../fixtures/mock/skhynix-recent";

// 분석 글 + 투자 리포트 (Phase 5 후속): AI에는 리포트 요약과 핵심 숫자만(주간 차트 점 100여 개는 빼고) 보내고,
// 리포트 차트("r1")도 근거 차트로 가리킬 수 있고, 투자 포인트에 관점(theme)이 붙는다. AI는 가짜
const { llmCallMock } = vi.hoisted(() => ({ llmCallMock: vi.fn() }));
vi.mock("@/lib/llm/client", () => ({ llmCall: llmCallMock }));
vi.mock("@/lib/explain/model", () => ({ chooseExplainModel: async () => ({ model: "fake" }) }));

const { generateExplanationWithUsage } = await import("@/lib/explain/generate");

const fig = (id: string, label: string, display: string, value = 1): Figure => ({
  id,
  label,
  value,
  unit: "TIMES",
  display,
  basis: { report: "금융위원회 주식시세", fsDiv: "CFS", priceDate: "2026-09-30" },
});

const base = skhynixRecent.result!;
const report: CompanyReport = {
  company: base.basis.target,
  asOf: "2026-10-01T03:00:00.000Z",
  priceDate: "2026-09-30",
  highlights: [{ label: "PER", figureId: "f100001" }],
  sections: [
    {
      id: "valuation",
      title: "밸류에이션",
      facts: [
        { label: "PER", figureId: "f100001", note: "시가총액 ÷ TTM" },
        { label: "과거 평균 PER", figureId: "f100002" },
      ],
      charts: [
        {
          id: "r1",
          type: "line",
          title: "SK하이닉스 주가 (최근 1년, 주간 종가)",
          series: [
            {
              key: "close",
              label: "종가",
              unit: "KRW",
              points: [{ x: "26.09.28", figureId: "f100003" }],
            },
          ],
          footnotes: [],
          source: "출처: 금융위원회 주식시세",
        },
      ],
      notes: ["EV/EBITDA는 제공하지 않습니다"],
    },
  ],
  keyFigureIds: ["f100001", "f100002"],
  disclosures: [
    {
      rceptNo: "9",
      title: "자기주식취득결정",
      date: "2026-08-01",
      tag: "자사주",
      importance: "high",
      isCorrection: false,
      url: "u",
    },
  ],
  notes: [],
};
const result: ResultObject = {
  ...base,
  report,
  figures: {
    ...base.figures,
    f100001: fig("f100001", "SK하이닉스 PER", "8.01배", 8.01),
    f100002: fig("f100002", "SK하이닉스 과거 평균 PER", "12.97배", 12.97),
    f100003: fig("f100003", "SK하이닉스 주간 종가 2026-09-30", "1,776,000원", 1776000),
  },
};

beforeEach(() => llmCallMock.mockReset());

function aiReturns(output: unknown) {
  llmCallMock.mockResolvedValue({ output, usage: { costUsd: 0.02 } });
}

describe("분석 글 — 투자 리포트를 함께 읽는다", () => {
  it("AI 입력: 리포트 요약(칸·항목·숫자 ID·공시) + 핵심 숫자만, 주간 차트 점은 빼고, 리포트 차트는 차트 목록에", async () => {
    aiReturns({
      conclusion: ["결론입니다."],
      insights: [],
      evidence: [],
      news_clues: [],
      caveats: [],
    });
    await generateExplanationWithUsage({
      question: "SK하이닉스 최근 실적 어때?",
      result,
      mixedScope: false,
    });
    const data = JSON.parse(llmCallMock.mock.calls[0][0].input[1].content);
    const ids = data.숫자_목록.map((f: { id: string }) => f.id);
    expect(ids).toContain("f100001");
    expect(ids).toContain("f100002");
    expect(ids).not.toContain("f100003");
    // 질문 결과의 숫자는 전부 그대로
    for (const id of Object.keys(base.figures)) expect(ids).toContain(id);
    expect(data.차트_목록.map((c: { id: string }) => c.id)).toContain("r1");
    expect(data.투자_리포트).toMatchObject({
      기준일: "2026-09-30",
      칸: [
        {
          제목: "밸류에이션",
          항목: [
            { 이름: "PER", 숫자_id: "f100001", 메모: "시가총액 ÷ TTM" },
            { 이름: "과거 평균 PER" },
          ],
        },
      ],
      최근_공시: [{ 날짜: "2026-08-01", 제목: "자기주식취득결정", 분류: "자사주" }],
    });
    // 지시문에 관점별 해석 요구
    const system = llmCallMock.mock.calls[0][0].input[0].content as string;
    expect(system).toContain("valuation(밸류에이션)");
    expect(system).toContain("인사이트");
    expect(system).toContain("예상됩니다");
  });

  it("투자 포인트에 관점이 붙고, 리포트 숫자·차트를 근거로 쓸 수 있다. 조사는 값에 맞춘다", async () => {
    aiReturns({
      conclusion: [
        "PER {{f100001}}은 과거 평균 {{f100002}}보다 낮습니다.",
        "실적이 좋아졌습니다.",
        "변동성에 주의해야 합니다.",
      ],
      insights: [
        {
          kind: "watch",
          theme: "valuation",
          text: "PER {{f100001}}은 과거 평균 {{f100002}}과 비교해 낮은 수준입니다.",
          figure_ids: ["f100001", "f100002"],
          news_ids: [],
          chart_ref: "r1",
          inferred: false,
        },
        {
          kind: "risk",
          theme: "price",
          text: "주가 흐름을 확인할 필요가 있습니다.",
          figure_ids: ["f100003"],
          news_ids: [],
          chart_ref: "r9",
          inferred: false,
        },
      ],
      evidence: [],
      news_clues: [],
      caveats: [],
    });
    const { explanation } = await generateExplanationWithUsage({
      question: "SK하이닉스 최근 실적 어때?",
      result,
      mixedScope: false,
    });
    expect(explanation.conclusion).toEqual([
      "PER 8.01배는 과거 평균 12.97배보다 낮습니다.",
      "실적이 좋아졌습니다.",
      "변동성에 주의해야 합니다.",
    ]);
    expect(explanation.insights[0]).toMatchObject({
      theme: "valuation",
      text: "PER 8.01배는 과거 평균 12.97배와 비교해 낮은 수준입니다.",
      chartRef: "r1",
    });
    // 없는 차트 ID는 비운다
    expect(explanation.insights[1]).toMatchObject({ theme: "price", chartRef: null });
  });

  it("관점이 없는 옛 응답(회귀 고정 응답)은 general", async () => {
    aiReturns({
      conclusion: ["결론입니다."],
      insights: [
        {
          kind: "positive",
          text: "PER은 {{f100001}}입니다.",
          figure_ids: ["f100001"],
          news_ids: [],
          chart_ref: null,
          inferred: false,
        },
      ],
      evidence: [],
      news_clues: [],
      caveats: [],
    });
    const { explanation } = await generateExplanationWithUsage({
      question: "q",
      result,
      mixedScope: false,
    });
    expect(explanation.insights[0].theme).toBe("general");
  });

  it("'저평가' 같은 가격 판정 문장은 여전히 버린다", async () => {
    aiReturns({
      conclusion: ["PER {{f100001}}로 저평가 구간입니다.", "결론입니다."],
      insights: [],
      evidence: [],
      news_clues: [],
      caveats: [],
    });
    const { explanation } = await generateExplanationWithUsage({
      question: "q",
      result,
      mixedScope: false,
    });
    expect(explanation.conclusion).toEqual(["결론입니다."]);
  });
});
