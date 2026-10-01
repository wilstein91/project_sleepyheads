// 가짜 모드: 질문·결과 API (S1, Q1~Q4) 흉내.
// 질문 문장에 든 낱말로 상황을 고른다. 화면의 모든 상태(성공·되묻기·거절·오류)를 서버 없이 확인하기 위함이다.
//
//   삼성전자 …            → 매출 추이 결과          SK하이닉스 …        → 최근 실적 결과
//   … 설명 실패           → 차트만 + 설명 생성 실패  … DART 장애         → 조회 실패(failed)
//   … 사도 돼 / 목표주가   → 투자 권유 거절          기업 없는 주식 질문  → 되묻기
//   주식과 무관           → 범위 밖 거절            … 2013년            → 조회 기간 밖(422)
//   … 직원 만족도         → 지원하지 않는 지표(422)  … AI 장애          → AI 장애(503, 차감 없음)
//   … 서버 오류           → 예상 못 한 서버 오류(500, 요청 ID 안내)
//   SK하이닉스 … 뉴스      → 최근 실적 + 뉴스 단서 (WU-305)
//   SK하이닉스 … PER·PBR·시가총액 → 주가 지표 결과 (WU-502 화면: 기준일·적자·자본잠식·결합 경고)
import { earliestQuarterLabel } from "@/components/ask/errorMessages";
import type { Analysis, CompanyRef } from "@/contracts";
import { EARLIEST_QUARTER, parseQuarter } from "@/lib/ask/quarter";
import { MOCK_COMPANIES, findMockCompany } from "../../../tests/fixtures/mock/companies";
import {
  MIXED_QUESTION_CAVEAT,
  OUT_OF_SCOPE_DECLINE,
  adviceDecline,
} from "../../../tests/fixtures/mock/declines";
import { withMockNewsClues } from "../../../tests/fixtures/mock/news-clues";
import { withMockFilingClues } from "../../../tests/fixtures/mock/filing-clues";
import { samsungRevenueTrend } from "../../../tests/fixtures/mock/samsung-revenue-trend";
import { skhynixRecent } from "../../../tests/fixtures/mock/skhynix-recent";
import { skhynixValuation } from "../../../tests/fixtures/mock/skhynix-valuation";
import { ApiRequestError } from "./errors";
import { MOCK_QUESTIONS_LIMIT, nextKstMidnight, remainingQuestions } from "./mock-session";
import { mockDelay, readMockState, updateMockState } from "./mock-store";
import type { AskResponse, ClarifyResponse, StepResponse, WithRemaining } from "./types";

const MANIPULATION = /이전 지시|시스템 프롬프트|너는 이제|ignore (all|previous)/i;
const ADVICE = /사도 돼|사야|팔아야|팔까|살까|매수|매도|목표\s?주가/;
const STOCK_WORDS = /주식|종목|실적|매출|영업이익|순이익|공시|회사|기업|반도체|배당/;
const OFF_TOPIC_PART = /저녁|메뉴|날씨|번역/;

function detectCompany(question: string): CompanyRef | null {
  if (/하이닉스/i.test(question)) return findMockCompany("SK하이닉스");
  return MOCK_COMPANIES.find((c) => question.includes(c.name)) ?? null;
}

// 대문자 그대로만 — "operating"·"super" 같은 영어 낱말 속 per에 걸리지 않게
const VALUATION = /PER|PBR|시가총액/;

function resultFor(company: CompanyRef, question = ""): Analysis {
  if (company.name !== "SK하이닉스") return samsungRevenueTrend;
  return VALUATION.test(question) ? skhynixValuation : skhynixRecent;
}

function emptyAnalysis(question: string): Analysis {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    question,
    status: "queued",
    stopReason: null,
    decline: null,
    request: null,
    clarification: null,
    plan: null,
    diagnoses: [],
    progress: null,
    steps: [],
    result: null,
    explanation: null,
    boardId: null,
    createdAt: now,
    updatedAt: now,
  };
}

function withResult(base: Analysis, company: CompanyRef): Analysis {
  const question = base.question;
  const fixture = structuredClone(resultFor(company, question));
  const analysis: Analysis = { ...fixture, id: base.id, projectId: base.projectId, question };

  if (/설명 실패/.test(question) && analysis.explanation) {
    analysis.explanation = {
      ...analysis.explanation,
      status: "failed",
      conclusion: [],
      insights: [],
      evidence: [],
      caveats: [],
      failureMessage: "설명 생성 실패",
    };
  } else if (OFF_TOPIC_PART.test(question) && analysis.explanation) {
    analysis.explanation.caveats.push(MIXED_QUESTION_CAVEAT);
  } else if (/뉴스/.test(question) && company.name === "SK하이닉스" && analysis.explanation) {
    analysis.explanation = withMockNewsClues(analysis.explanation);
    if (analysis.request) analysis.request = { ...analysis.request, needsNews: true };
  } else if (/원문/.test(question) && company.name === "SK하이닉스" && analysis.explanation) {
    analysis.explanation = withMockFilingClues(analysis.explanation);
  }
  return analysis;
}

function charge() {
  updateMockState((s) => {
    s.questionsUsed += 1;
  });
}

function save(analysis: Analysis) {
  updateMockState((s) => {
    s.analyses[analysis.id] = analysis;
  });
}

export async function mockSearchCompanies(q: string): Promise<WithRemaining<CompanyRef[]>> {
  await mockDelay(120);
  const query = q.trim().toLowerCase();
  const data = MOCK_COMPANIES.filter(
    (c) => c.name.toLowerCase().includes(query) || c.stockCode.startsWith(query),
  ).slice(0, 10);
  return { data, questionsRemaining: remainingQuestions() };
}

/** 질문에 조회 시작 연도(EARLIEST_QUARTER)보다 이른 "20xx년"이 있는가 — 서버 422(OUT_OF_RANGE) 흉내 */
function asksBeforeEarliestYear(question: string): boolean {
  const earliest = parseQuarter(EARLIEST_QUARTER).year;
  return [...question.matchAll(/(20\d{2})년/g)].some((m) => Number(m[1]) < earliest);
}

export async function mockAsk(question: string): Promise<WithRemaining<AskResponse>> {
  await mockDelay(900);
  if (readMockState().questionsUsed >= MOCK_QUESTIONS_LIMIT) {
    throw new ApiRequestError(
      "QUOTA_EXCEEDED",
      "오늘 질문 수를 모두 사용했습니다.",
      429,
      nextKstMidnight(),
    );
  }
  // AI 장애로 질문 해석 실패 → 차감 취소 (API_SPEC Q1)
  if (/AI 장애/.test(question)) {
    throw new ApiRequestError("LLM_UNAVAILABLE", "AI 서비스에 일시적인 문제가 있습니다.", 503);
  }
  // 서버가 예상 못 한 오류로 끊김 → 요청 ID만 돌아온다 (API_SPEC §1.7)
  if (/서버 오류/.test(question)) {
    throw new ApiRequestError(
      "INTERNAL_ERROR",
      "서버 오류가 발생했습니다.",
      500,
      null,
      null,
      null,
      crypto.randomUUID(),
    );
  }

  charge();
  const analysis = emptyAnalysis(question);
  const company = detectCompany(question);

  if (MANIPULATION.test(question) || (!company && !STOCK_WORDS.test(question))) {
    analysis.status = "declined";
    analysis.decline = OUT_OF_SCOPE_DECLINE;
  } else if (ADVICE.test(question)) {
    analysis.status = "declined";
    analysis.decline = adviceDecline(company?.name ?? "SK하이닉스");
  } else if (asksBeforeEarliestYear(question)) {
    throw new ApiRequestError(
      "OUT_OF_RANGE",
      `조회할 수 있는 기간은 ${earliestQuarterLabel()}부터 최신 보고서까지입니다.`,
      422,
    );
  } else if (/만족도|연봉|직원 수/.test(question)) {
    throw new ApiRequestError(
      "UNSUPPORTED_QUESTION",
      "공시 자료로 계산할 수 없는 지표입니다.",
      422,
      null,
      null,
      { examples: ["매출액", "영업이익", "순이익", "영업이익률", "ROE", "부채비율"] },
    );
  } else if (!company) {
    analysis.status = "needs_clarification";
    analysis.clarification = {
      question: "어느 회사를 말씀하신 건가요?",
      options: ["삼성전자", "SK하이닉스"].map((name, i) => ({
        id: `opt${i + 1}`,
        label: name,
        company: findMockCompany(name),
      })),
    };
  } else if (/DART 장애/.test(question)) {
    analysis.status = "failed";
    analysis.stopReason = "UPSTREAM_ERROR";
    analysis.request = resultFor(company).request;
  } else {
    save(withResult(analysis, company));
    return {
      data: { analysisId: analysis.id, projectId: analysis.projectId, status: "succeeded" },
      questionsRemaining: remainingQuestions(),
    };
  }

  save(analysis);
  return {
    data: {
      analysisId: analysis.id,
      projectId: analysis.projectId,
      status: analysis.status,
      ...(analysis.decline ? { decline: analysis.decline } : {}),
    },
    questionsRemaining: remainingQuestions(),
  };
}

export async function mockGetAnalysis(id: string): Promise<WithRemaining<Analysis>> {
  await mockDelay(250);
  const analysis = readMockState().analyses[id];
  if (!analysis) throw new ApiRequestError("NOT_FOUND", "분석을 찾을 수 없습니다.", 404);
  return { data: analysis, questionsRemaining: remainingQuestions() };
}

export async function mockClarify(
  id: string,
  optionId: string,
): Promise<WithRemaining<ClarifyResponse>> {
  await mockDelay(700);
  const analysis = readMockState().analyses[id];
  if (!analysis) throw new ApiRequestError("NOT_FOUND", "분석을 찾을 수 없습니다.", 404);
  if (analysis.status !== "needs_clarification") {
    throw new ApiRequestError("INVALID_STATE", "이미 답한 질문입니다.", 409);
  }
  const option = analysis.clarification?.options.find((o) => o.id === optionId);
  if (!option?.company) throw new ApiRequestError("VALIDATION_ERROR", "없는 선택지입니다.", 400);

  // 되묻기에 답하면 추가 차감 없이 분석을 이어간다 (API_SPEC Q3)
  save(withResult(analysis, option.company));
  return { data: { status: "succeeded" }, questionsRemaining: remainingQuestions() };
}

export async function mockStep(id: string): Promise<WithRemaining<StepResponse>> {
  await mockDelay(400);
  const analysis = readMockState().analyses[id];
  if (!analysis) throw new ApiRequestError("NOT_FOUND", "분석을 찾을 수 없습니다.", 404);
  return {
    data: { status: analysis.status, progress: null, lastStep: null, next: "done" },
    questionsRemaining: remainingQuestions(),
  };
}
