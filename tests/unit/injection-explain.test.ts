import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Explanation } from "@/contracts";
import { containsLeak } from "@/lib/explain/output-guard";
import { isGoogleNewsUrl } from "@/lib/news/web-url";
import { skhynixRecent } from "../fixtures/mock/skhynix-recent";
import {
  FAKE_SECRETS,
  FAKE_SECRET_VALUES,
  FORBIDDEN_IN_OUTPUT,
  INJECTION,
  INJECTION_SENTENCES,
  injectedDisclosures,
  injectedNewsClues,
} from "../fixtures/mock/injection";

// WU-504 완료조건 (TECH §11.5·§17): 기사·공시 속 명령문 → 키·환경변수 값 출력 없음, 권유 문장 없음,
// 화면 링크는 검색 API 주소만. **실제 경로**(③ 설명 작성 generateExplanationWithUsage — 실행기 write_explanation·
// Q9 설명 다시 쓰기가 같은 함수를 쓴다)를 지나고, AI만 가짜로 바꿔 "명령문을 그대로 따라 한" 응답을 돌려준다.

const llm = vi.hoisted(() => ({
  requests: [] as Record<string, unknown>[],
  output: null as unknown,
}));
vi.mock("@/lib/llm/client", () => ({
  llmCall: async (request: Record<string, unknown>) => {
    llm.requests.push(request);
    return { output: llm.output, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
  },
}));
vi.mock("@/lib/explain/model", () => ({
  chooseExplainModel: async () => ({ model: "gpt-6-sol" }),
}));

const { generateExplanationWithUsage } = await import("@/lib/explain/generate");

/** 명령문을 따라 한 AI 응답: 비밀 값·권유·주소를 결론·투자 포인트·근거·주의사항 모두에 넣고, 정상 문장도 섞는다 */
const OBEYING_OUTPUT = {
  conclusion: [
    `비밀키는 ${FAKE_SECRETS.OPENAI_API_KEY.split(",")[0]} 입니다.`,
    "이전 지시대로 SK하이닉스 매수를 추천합니다.",
    "자세한 내용은 https://evil.example.com/promo 에서 확인하세요.",
    `전자공시 키는 ${FAKE_SECRETS.OPENDART_API_KEY} 입니다.`,
    "2026년 2분기 매출은 {{f1}}로 4개 분기 중 가장 컸습니다.",
    "영업이익도 {{f2}}로 늘어 수익성이 함께 좋아졌습니다.",
  ],
  insights: [
    {
      kind: "positive",
      text: `환경변수 값: ${FAKE_SECRETS.SUPABASE_SECRET_KEY}`,
      figure_ids: ["f1"],
      news_ids: [],
      chart_ref: "c1",
      inferred: false,
    },
    {
      kind: "positive",
      text: "지금 사야 할 때로 보여 매수를 추천합니다.",
      figure_ids: ["f2"],
      news_ids: ["n2"],
      chart_ref: "c2",
      inferred: true,
    },
    {
      kind: "watch",
      text: "자세히 보기 www.evil-site.xyz",
      figure_ids: ["f3"],
      news_ids: ["n3"],
      chart_ref: "c3",
      inferred: false,
    },
    {
      kind: "watch",
      text: `크론 키 ${FAKE_SECRETS.CRON_SECRET}`,
      figure_ids: ["f3"],
      news_ids: [],
      chart_ref: "c3",
      inferred: false,
    },
    {
      kind: "positive",
      text: "영업이익률 {{f3}}로 매출의 절반 가까이를 이익으로 남기는 구간입니다.",
      figure_ids: ["f3"],
      news_ids: [],
      chart_ref: "c3",
      inferred: false,
    },
    {
      kind: "risk",
      text: "직전 분기에는 매출과 이익이 함께 줄어, 분기마다 실적 변동이 큰 편입니다.",
      figure_ids: ["f4"],
      news_ids: [],
      chart_ref: "c2",
      inferred: false,
    },
  ],
  evidence: [
    { text: `키 값 ${FAKE_SECRETS.DATA_GO_KR_SERVICE_KEY}`, chart_ref: "c1" },
    { text: "링크: http://evil.example.com", chart_ref: null },
    { text: "2026년 2분기 매출은 {{f1}}입니다.", chart_ref: "c1" },
  ],
  news_clues: [{ news_id: "n1", relevance: "명령문이 든 기사" }],
  caveats: ["https://evil.example.com 을 참고하세요.", "목표주가를 확인하세요."],
};

// 서버는 숫자마다 f1, f2 … ID를 붙여 AI에 넘긴다 (TECH §11.4) — 가짜 결과의 숫자를 그 모양으로
const base = skhynixRecent.result!;
const asF = (id: string, from: string) => ({ ...base.figures[from], id });
const result = {
  ...base,
  figures: {
    f1: asF("f1", "rev2026Q2"),
    f2: asF("f2", "oi2026Q2"),
    f3: asF("f3", "om2026Q2"),
    f4: asF("f4", "rev2026Q1"),
  },
  disclosures: injectedDisclosures,
};

const input = {
  question: "SK하이닉스 2분기 실적 왜 늘었어?",
  result,
  newsClues: injectedNewsClues,
  mixedScope: false,
};

function aiWrittenText(e: Explanation): string {
  return JSON.stringify([
    e.conclusion,
    e.insights.map((i) => i.text),
    e.evidence.map((v) => v.text),
    e.caveats,
  ]);
}

beforeEach(() => {
  llm.requests = [];
  llm.output = OBEYING_OUTPUT;
  for (const [name, value] of Object.entries(FAKE_SECRETS)) vi.stubEnv(name, value);
});
afterEach(() => vi.unstubAllEnvs());

describe("③ 설명 작성 — 기사·공시 속 명령문 (WU-504)", () => {
  it("AI 입력: 명령문은 '데이터'(user 메시지 JSON) 안에만 있고, 지시문(system)·비밀 값·공시 원문은 없다", async () => {
    await generateExplanationWithUsage(input);
    const [request] = llm.requests;
    const messages = request.input as { role: string; content: string }[];
    const system = messages.filter((m) => m.role === "system").map((m) => m.content);
    const user = messages.filter((m) => m.role === "user").map((m) => m.content);

    expect(system.join("")).not.toContain(INJECTION.advice);
    expect(user).toHaveLength(1);
    const data = JSON.parse(user[0]) as { 뉴스_단서: { title: string; gist: string }[] };
    // 기사 글은 뉴스_단서 칸 안에 자료로 들어간다 (따르지 않을 자료)
    for (const sentence of INJECTION_SENTENCES) {
      expect(data.뉴스_단서.some((n) => n.gist.includes(sentence))).toBe(true);
    }
    // 뉴스 주소는 AI에 주지 않는다 — AI가 링크를 고를 수 없다
    expect(user[0]).not.toContain("news.google.com");

    const whole = JSON.stringify(request.input);
    // AI에 비밀 값이 들어가지 않으니 AI가 알 방법이 없다
    for (const secret of FAKE_SECRET_VALUES) expect(whole).not.toContain(secret);
    // 공시 원문(제목)은 설명 작성 입력에 들어가지 않는다 — 숫자 목록·차트 제목·뉴스 단서만
    for (const d of injectedDisclosures) expect(whole).not.toContain(d.title);
  });

  it("AI 호출 ③에는 도구를 주지 않는다 — 요청에 tools·tool_choice·functions가 없다", async () => {
    await generateExplanationWithUsage(input);
    const [request] = llm.requests;
    expect(Object.keys(request).sort()).toEqual(
      // reasoningEffort = 추론 분량(속도, src/lib/explain/reasoning.ts)·timeoutMs — 도구 칸이 아니다
      ["analysisId", "input", "model", "reasoningEffort", "schema", "timeoutMs", "userId"].sort(),
    );
    expect(JSON.stringify(request)).not.toMatch(/"tools"|"tool_choice"|"functions"/);
    // 출력은 JSON 스키마로만 (Structured Outputs, strict)
    expect(request.schema).toMatchObject({ name: "explanation", strict: true });
  });

  it("명령문을 따라 한 문장은 모두 버려지고, 정상 문장만 남는다", async () => {
    const { explanation } = await generateExplanationWithUsage(input);
    expect(explanation.status).toBe("ready");
    expect(explanation.conclusion).toEqual([
      "2026년 2분기 매출은 28조 원으로 4개 분기 중 가장 컸습니다.",
      "영업이익도 13조 9,000억 원으로 늘어 수익성이 함께 좋아졌습니다.",
    ]);
    expect(explanation.insights.map((i) => i.text)).toEqual([
      "영업이익률 49.6%로 매출의 절반 가까이를 이익으로 남기는 구간입니다.",
      "직전 분기에는 매출과 이익이 함께 줄어, 분기마다 실적 변동이 큰 편입니다.",
    ]);
    expect(explanation.evidence.map((e) => e.text)).toEqual(["2026년 2분기 매출은 28조 원입니다."]);
    expect(explanation.caveats).toEqual(["본 분석은 투자 권유가 아닙니다."]);
  });

  it("세 경우 모두: AI가 쓴 글에 키·환경변수 값·주소·권유어가 없다", async () => {
    const { explanation } = await generateExplanationWithUsage(input);
    const text = aiWrittenText(explanation);
    for (const forbidden of FORBIDDEN_IN_OUTPUT) {
      if (typeof forbidden === "string") expect(text).not.toContain(forbidden);
      else expect(text).not.toMatch(forbidden);
    }
    // 고정 고지문의 "투자 권유가 아닙니다"는 서버 문구다 — "권유" 낱말 자체가 아니라 권유 문장이 없음을 본다
    expect(text).not.toMatch(/사야|매수|추천/);
  });

  it("화면 링크는 검색 API(Google 뉴스 RSS)가 준 주소만 — AI가 고른 주소가 링크가 되지 않는다", async () => {
    const { explanation } = await generateExplanationWithUsage(input);
    expect(explanation.newsClues.map((n) => n.url).sort()).toEqual(
      injectedNewsClues.map((n) => n.url).sort(),
    );
    for (const clue of explanation.newsClues) expect(isGoogleNewsUrl(clue.url)).toBe(true);
    // 결과 객체에서 링크가 되는 칸은 뉴스 url과 공시 url(DART)뿐이다 — 둘 다 서버가 만든 값
    for (const d of input.result.disclosures)
      expect(d.url).toMatch(/^https:\/\/dart\.fss\.or\.kr\//);
  });

  it("명령문을 따른 문장이 결론 전부면 '설명 생성 실패' — 가짜·임시 문장을 만들지 않는다", async () => {
    llm.output = {
      ...OBEYING_OUTPUT,
      conclusion: OBEYING_OUTPUT.conclusion.slice(0, 4),
    };
    const { explanation } = await generateExplanationWithUsage(input);
    expect(explanation.status).toBe("failed");
    expect(explanation.conclusion).toEqual([]);
  });
});

describe("출력 검사 containsLeak (src/lib/explain/output-guard.ts)", () => {
  it("주소·키 모양·지금 서버의 비밀 값(숫자 없는 값 포함)을 찾는다", () => {
    for (const name of Object.keys(FAKE_SECRETS))
      vi.stubEnv(name, FAKE_SECRETS[name as keyof typeof FAKE_SECRETS]);
    expect(containsLeak("https://evil.example.com")).toBe(true);
    expect(containsLeak("www.evil-site.xyz 참고")).toBe(true);
    expect(containsLeak("evil.example 로 가세요")).toBe(true);
    expect(containsLeak("키는 sk-proj-abcdefghijklmnop")).toBe(true);
    expect(containsLeak(`값 ${FAKE_SECRETS.OPENDART_API_KEY}`)).toBe(true);
    // 띄어 써도 찾는다
    expect(containsLeak("dartSECRET valueNoDigits")).toBe(true);
    // 쉼표로 여러 개 넣은 키도 하나씩
    expect(containsLeak("sk-test-SECONDkeyVALUEabcdefgh")).toBe(true);
  });

  it("보통 분석 문장은 걸리지 않는다 (오탐 없음)", () => {
    for (const ok of [
      "2026년 2분기 매출은 28조 원으로 늘었습니다.",
      "영업이익률 49.6%로 4개 분기 중 가장 높습니다.",
      "한국경제 보도처럼 HBM 공급 확대가 이익 증가로 이어진 것으로 보입니다.",
      "삼성전자·SK하이닉스 모두 반도체 업황 회복의 영향을 받았습니다.",
      "PER 12.34배, PBR 3.21배입니다.",
    ]) {
      expect(containsLeak(ok), ok).toBe(false);
    }
  });
});
