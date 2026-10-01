// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NewsClue } from "@/contracts";

// WU-304 search_news · WU-305 write_explanation 도구 — 가짜 ctx·가짜 뉴스 모듈로 (실제 RSS·AI·DB 없음).
// 실제 RSS 처리는 news-find.test.ts, 저장 표는 tests/unit/db/news-clues.test.ts.

const { findNewsCluesMock, saveNewsCluesMock, generateMock, findFilingsMock } = vi.hoisted(() => ({
  findNewsCluesMock: vi.fn(),
  saveNewsCluesMock: vi.fn(),
  generateMock: vi.fn(),
  findFilingsMock: vi.fn(),
}));
vi.mock("@/lib/news", () => ({ findNewsClues: findNewsCluesMock }));
vi.mock("@/lib/news/store", () => ({ saveNewsClues: saveNewsCluesMock }));
vi.mock("@/lib/explain/generate", () => ({ generateExplanationWithUsage: generateMock }));
vi.mock("@/lib/filings", () => ({ findFilingPassages: findFilingsMock }));

const { searchNews, writeExplanation } = await import("@/lib/runner/tools/news-tools");

const CLUES: NewsClue[] = [
  {
    newsId: "n1",
    title: "SK하이닉스, HBM 공급 확대로 2분기 영업이익 급증",
    press: "한국경제",
    publishedAt: "2026-07-24T01:00:00.000Z",
    url: "https://news.google.com/rss/articles/abc?oc=5",
    gist: "한국경제는 HBM 공급 확대가 2분기 이익 증가로 이어졌다고 보도했다.",
  },
  {
    newsId: "n2",
    title: "SK하이닉스 실적 발표",
    press: "연합뉴스",
    publishedAt: "2026-07-24T02:00:00.000Z",
    url: "https://news.google.com/rss/articles/def?oc=5",
    gist: "",
  },
];

const INPUT = {
  company: { name: "SK하이닉스", corpCode: "00164779" },
  period: { from: "2025Q3", to: "2026Q2", specified: true, reason: "", clipped: false },
  keywords: ["영업이익"],
} as never;

const client = { tag: "admin-client" };
function ctx(overrides: Record<string, unknown> = {}) {
  return {
    request: {
      peers: [],
      target: { name: "SK하이닉스", corpCode: "00164779" },
      metrics: ["operating_income"],
    },
    question: "SK하이닉스 영업이익 왜 늘었어?",
    mixedScope: false,
    analysisId: "an-1",
    userId: "user-1",
    client,
    decisions: null,
    previous: [],
    ...overrides,
  } as never;
}

beforeEach(() => {
  findFilingsMock.mockReset();
  findFilingsMock.mockResolvedValue({ passages: [], externalCalls: 0, note: "공시 원문 없음" });
  findNewsCluesMock.mockReset();
  saveNewsCluesMock.mockReset();
  generateMock.mockReset();
  saveNewsCluesMock.mockResolvedValue(true);
});

describe("search_news (WU-304)", () => {
  it("findNewsClues에 기업·분석 기간·핵심어를 넘기고, 단서를 그대로 돌려주며 news_clues에 저장한다", async () => {
    findNewsCluesMock.mockResolvedValue({
      clues: CLUES,
      notes: [
        "본문 미확인 2건 — Google 경유 링크라 원문 주소를 알 수 없음 (T8) (제목으로 요지 작성)",
      ],
      searches: 1,
      rssCalls: 1,
      gistUsage: { inputTokens: 659, outputTokens: 645, costUsd: 0.00039 },
    });

    const outcome = await searchNews(INPUT, ctx());

    expect(findNewsCluesMock).toHaveBeenCalledWith({
      company: { name: "SK하이닉스" },
      period: { from: "2025Q3", to: "2026Q2" },
      keywords: ["영업이익"],
      userId: "user-1",
      analysisId: "an-1",
    });
    expect(saveNewsCluesMock).toHaveBeenCalledWith(client, {
      ownerId: "user-1",
      analysisId: "an-1",
      clues: CLUES,
    });
    expect(outcome).toMatchObject({
      status: "succeeded",
      output: { clues: CLUES },
      inputSummary: "SK하이닉스, 2025Q3~2026Q2, 핵심어 영업이익",
      // 요지 AI 비용이 질문당 상한 판정에 들어간다. 외부 호출은 실제 RSS 호출 수 (캐시 적중 제외)
      usage: { externalCalls: 1, llmCostUsd: 0.00039 },
    });
  });

  it("실행 기록 요약에는 건수와 사유만 — 기사 제목·요지는 넣지 않는다 (본문 실패 사유는 여기에 남는다)", async () => {
    findNewsCluesMock.mockResolvedValue({
      clues: CLUES,
      notes: [
        "본문 미확인 2건 — Google 경유 링크라 원문 주소를 알 수 없음 (T8) (제목으로 요지 작성)",
      ],
      searches: 1,
      rssCalls: 0,
      gistUsage: null,
    });

    const outcome = await searchNews(INPUT, ctx());
    if (outcome.status !== "succeeded") throw new Error("성공이어야 한다");

    expect(outcome.outputSummary).toBe(
      "뉴스 2건 · 본문 미확인 2건 — Google 경유 링크라 원문 주소를 알 수 없음 (T8) (제목으로 요지 작성)",
    );
    for (const clue of CLUES) {
      expect(outcome.outputSummary).not.toContain(clue.title);
      expect(outcome.inputSummary).not.toContain(clue.title);
    }
    expect(outcome.usage).toEqual({ externalCalls: 0, llmCostUsd: 0 });
  });

  it("RSS가 막히면 실패가 아니라 뉴스 0건 성공 + 사유 — 분석은 뉴스 없이 끝까지 간다", async () => {
    findNewsCluesMock.mockResolvedValue({
      clues: [],
      notes: ["뉴스 RSS 호출 실패 — 뉴스 없이 진행"],
      searches: 1,
      rssCalls: 1,
      gistUsage: null,
    });

    const outcome = await searchNews(INPUT, ctx());

    expect(outcome).toMatchObject({
      status: "succeeded",
      output: { clues: [], notes: ["뉴스 RSS 호출 실패 — 뉴스 없이 진행"] },
      outputSummary: "뉴스 0건 · 뉴스 RSS 호출 실패 — 뉴스 없이 진행",
    });
  });

  it("비로그인 예시(userId 없음)는 저장하지 않는다 — 단서는 분석 글에 그대로", async () => {
    findNewsCluesMock.mockResolvedValue({
      clues: CLUES,
      notes: [],
      searches: 1,
      rssCalls: 1,
      gistUsage: null,
    });

    const outcome = await searchNews(INPUT, ctx({ userId: null }));

    expect(saveNewsCluesMock).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ status: "succeeded", output: { clues: CLUES } });
  });

  it("저장이 실패해도 단서는 돌려주고, 사유를 실행 기록에 남긴다", async () => {
    findNewsCluesMock.mockResolvedValue({
      clues: CLUES,
      notes: [],
      searches: 1,
      rssCalls: 1,
      gistUsage: null,
    });
    saveNewsCluesMock.mockResolvedValue(false);

    const outcome = await searchNews(INPUT, ctx());

    expect(outcome).toMatchObject({
      status: "succeeded",
      output: { clues: CLUES, notes: ["뉴스 단서 저장 실패 — 이번 분석 글에만 표시"] },
      outputSummary: "뉴스 2건 · 뉴스 단서 저장 실패 — 이번 분석 글에만 표시",
    });
  });

  it("기간이 없으면 최근 30일, 핵심어가 없으면 '핵심어 없음'", async () => {
    findNewsCluesMock.mockResolvedValue({
      clues: [],
      notes: ["관련 뉴스 없음"],
      searches: 2,
      rssCalls: 2,
      gistUsage: null,
    });

    const outcome = await searchNews(
      { company: { name: "하이브" }, period: null, keywords: [] } as never,
      ctx(),
    );

    expect(findNewsCluesMock).toHaveBeenCalledWith(expect.objectContaining({ period: null }));
    expect(outcome).toMatchObject({ inputSummary: "하이브, 최근 30일, 핵심어 없음" });
  });

  it("기업 이름이 없으면 재시도 없는 실패 (뉴스 모듈을 부르지 않는다)", async () => {
    const outcome = await searchNews(
      { company: { name: "  " }, period: null, keywords: [] } as never,
      ctx(),
    );
    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    expect(findNewsCluesMock).not.toHaveBeenCalled();
  });

  it("예상 못 한 오류도 던지지 않고 실패로 돌려준다", async () => {
    findNewsCluesMock.mockRejectedValue(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(searchNews(INPUT, ctx())).resolves.toMatchObject({
      status: "failed",
      retryable: false,
    });
  });
});

describe("write_explanation (WU-305)", () => {
  const built = {
    seq: 5,
    tool: "build_result",
    output: { result: { figures: { f1: {}, f2: {} }, charts: [] } },
  };

  it("앞 단계 뉴스 단서를 설명 작성에 넘기고, 실제 AI 비용을 사용량에 담는다", async () => {
    generateMock.mockResolvedValue({
      explanation: { status: "ready", label: "AI 작성" },
      llmCostUsd: 0.0021,
    });
    const previous = [{ seq: 4, tool: "search_news", output: { clues: CLUES, notes: [] } }, built];

    const outcome = await writeExplanation({} as never, ctx({ previous }));

    expect(generateMock).toHaveBeenCalledWith(
      expect.objectContaining({ newsClues: CLUES, userId: "user-1", analysisId: "an-1" }),
    );
    expect(outcome).toMatchObject({
      status: "succeeded",
      inputSummary: "숫자 2개, 뉴스 2건, 공시 원문 없음",
      outputSummary: "분석 글 작성",
      usage: { externalCalls: 0, llmCostUsd: 0.0021 },
    });
  });

  it("뉴스 단계가 둘이라 ID가 겹치면 앞 단계 것만 넘긴다 (인용 링크가 엇갈리지 않게)", async () => {
    generateMock.mockResolvedValue({ explanation: { status: "ready" }, llmCostUsd: 0 });
    const other = { ...CLUES[0], title: "다른 기업 기사" };
    const previous = [
      { seq: 3, tool: "search_news", output: { clues: CLUES, notes: [] } },
      { seq: 4, tool: "search_news", output: { clues: [other], notes: [] } },
      built,
    ];

    await writeExplanation({} as never, ctx({ previous }));

    expect(generateMock.mock.calls[0][0].newsClues).toEqual(CLUES);
  });

  it("설명 작성이 실패해도 단계는 성공(차트·표는 그대로) — 요약에 실패를 적는다", async () => {
    generateMock.mockResolvedValue({
      explanation: { status: "failed", label: "AI 작성", failureMessage: "설명 생성 실패" },
      llmCostUsd: 0.001,
    });

    const outcome = await writeExplanation({} as never, ctx({ previous: [built] }));

    expect(outcome).toMatchObject({
      status: "succeeded",
      inputSummary: "숫자 2개, 뉴스 0건, 공시 원문 없음",
      outputSummary: "설명 생성 실패 (차트·표는 그대로)",
      usage: { llmCostUsd: 0.001 },
    });
  });
  it("대상 기업의 재무 출처로 공시 원문 단락을 찾아 넘기고, 원문 받기를 외부 호출로 센다", async () => {
    const passage = {
      id: "d1",
      kind: "business",
      reportName: "2026 반기보고서",
      rceptNo: "20260814003509",
      section: "II. 사업의 내용 › 7. 기타 참고사항",
      text: "2분기는 AI 인프라 투자 확대에 따른 수요 강세가 이어졌습니다.",
    };
    findFilingsMock.mockResolvedValue({
      passages: [passage],
      externalCalls: 2,
      note: "공시 원문 2건에서 1단락",
    });
    generateMock.mockResolvedValue({
      explanation: { status: "ready", label: "AI 작성", filingClues: [{ filingId: "d1" }] },
      llmCostUsd: 0.03,
    });
    const sources = [
      {
        corpCode: "00164779",
        bsnsYear: 2026,
        reprtCode: "11012",
        fsDiv: "CFS",
        rceptNo: "20260814003509",
      },
    ];
    const previous = [
      { seq: 1, tool: "get_financials", output: { companies: [], sources } },
      built,
    ];

    const outcome = await writeExplanation({} as never, ctx({ previous }));

    expect(findFilingsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        corpCode: "00164779",
        sources,
        metrics: ["operating_income"],
        question: "SK하이닉스 영업이익 왜 늘었어?",
      }),
    );
    expect(generateMock.mock.calls[0][0].filings).toEqual([passage]);
    expect(outcome).toMatchObject({
      status: "succeeded",
      inputSummary: "숫자 2개, 뉴스 0건, 공시 원문 2건에서 1단락",
      outputSummary: "분석 글 작성 (공시 원문 1단락 근거)",
      usage: { externalCalls: 2, llmCostUsd: 0.03 },
    });
  });

  it("공시 원문 찾기가 던져도 단락 없이 분석 글을 쓴다", async () => {
    findFilingsMock.mockRejectedValue(new Error("boom"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    generateMock.mockResolvedValue({ explanation: { status: "ready" }, llmCostUsd: 0 });

    const outcome = await writeExplanation({} as never, ctx({ previous: [built] }));

    expect(generateMock.mock.calls[0][0].filings).toEqual([]);
    expect(outcome).toMatchObject({ status: "succeeded", usage: { externalCalls: 0 } });
  });
});
