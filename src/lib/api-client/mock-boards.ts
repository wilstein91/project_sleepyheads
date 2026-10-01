// 가짜 모드: 분석 보드(B1·B2)와 설명 다시 쓰기(Q9) 흉내 (WU-401).
// 보드는 분석 1개당 1개, 보드 ID = 분석 ID (PHASE3_PLAN §3.1). 보드 상태는 탭을 닫으면 사라지게 sessionStorage에 둔다.
//
//   필터 바꾸기(B2)   → 원래 결과를 본떠 숫자를 다시 지어내고 explanationStatus "stale" (질문 수 그대로)
//   설명 다시 쓰기(Q9) → 질문 1회 사용, 분석 글을 새로 쓰고 "ready"
//   오류: 비교 기업 6곳 이상·시작 분기가 끝보다 늦음 → 400, 조회 시작 분기(EARLIEST_QUARTER) 이전·최신 분기 이후 → 422,
//         분기 수 × 기업 수가 100을 넘음(예: 조회 시작 분기~최신 + 비교 기업 2곳) → 413
//   AI 장애 흉내: sessionStorage에 MOCK_LLM_DOWN_KEY = "1"을 넣으면 Q9가 503 (차감 없음, 기존 설명 유지)
//   새 데이터 버전 흉내: MOCK_BOARD_NEW_VERSION_KEY = "1"이면 B2 결과가 원래 분석과 다른 데이터 버전 + flags 맨 앞 한 줄
import type {
  BoardFilters,
  BoardView,
  CompanyRef,
  ResultObject,
  RewriteResponse,
} from "@/contracts";
import {
  EARLIEST_QUARTER,
  EARLIEST_QUARTER_LABEL,
  compareQuarters,
  latestAvailableQuarter,
  quarterSpan,
} from "@/lib/ask/quarter";
import {
  MOCK_BOARD_MAX_CELLS,
  buildMockBoardResult,
} from "../../../tests/fixtures/mock/board-results";
import { MOCK_COMPANIES } from "../../../tests/fixtures/mock/companies";
import { ApiRequestError } from "./errors";
import { MOCK_QUESTIONS_LIMIT, nextKstMidnight, remainingQuestions } from "./mock-session";
import { mockDelay, readMockState, sessionFlag, updateMockState } from "./mock-store";
import type { WithRemaining } from "./types";

const BOARDS_KEY = "sleepyheads.mock.boards";
/** e2e·수동 확인용: 이 값이 "1"이면 설명 다시 쓰기가 AI 장애(503)로 끝난다 */
export const MOCK_LLM_DOWN_KEY = "sleepyheads.mock.llmDown";
/** e2e·수동 확인용: 이 값이 "1"이면 B2가 새 데이터 버전으로 다시 계산한 결과를 준다 (서버 boardVersionFlag와 같은 모양) */
export const MOCK_BOARD_NEW_VERSION_KEY = "sleepyheads.mock.boardNewVersion";
const MOCK_NEW_VERSION_ID = "b0a4d000-0000-4000-8000-000000000001";
/** 비교 기업 최대 수 (PHASE3_PLAN §3.1) */
export const MAX_BOARD_PEERS = 5;

type StoredBoards = Record<string, Omit<BoardView, "id" | "analysisId">>;

function readBoards(): StoredBoards {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.sessionStorage.getItem(BOARDS_KEY) ?? "{}") as StoredBoards;
  } catch {
    return {};
  }
}

function saveBoard(analysisId: string, board: Omit<BoardView, "id" | "analysisId">) {
  const boards = readBoards();
  boards[analysisId] = board;
  try {
    window.sessionStorage.setItem(BOARDS_KEY, JSON.stringify(boards));
  } catch {
    // 저장 공간을 못 쓰는 환경에서는 이번 화면에서만 유지된다 (mock-store.ts와 같다)
  }
}

/** 새 데이터 버전 흉내가 켜져 있으면 결과의 버전을 바꾸고 서버처럼 flags 맨 앞에 한 줄을 붙인다 */
function withMockNewVersion(result: ResultObject): ResultObject {
  if (!sessionFlag(MOCK_BOARD_NEW_VERSION_KEY)) return result;
  const original = result.basis.dataVersionId;
  const flag = `보드 데이터 버전 ${MOCK_NEW_VERSION_ID.slice(0, 8)} — 원래 분석(${original.slice(0, 8)})과 다릅니다. 위 [같은 조건으로 재실행]은 원래 분석 기준입니다`;
  return {
    ...result,
    basis: {
      ...result.basis,
      dataVersionId: MOCK_NEW_VERSION_ID,
      flags: [flag, ...(result.basis.flags ?? [])],
    },
  };
}

function llmDown(): boolean {
  return sessionFlag(MOCK_LLM_DOWN_KEY);
}

function analysisWithResult(analysisId: string) {
  const analysis = readMockState().analyses[analysisId];
  if (!analysis) throw new ApiRequestError("NOT_FOUND", "분석을 찾을 수 없습니다.", 404);
  if (!analysis.result) {
    throw new ApiRequestError("INVALID_STATE", "결과가 있는 분석만 보드로 볼 수 있습니다.", 409);
  }
  return { ...analysis, result: analysis.result };
}

function view(analysisId: string, board: Omit<BoardView, "id" | "analysisId">): BoardView {
  return { id: analysisId, analysisId, ...board };
}

/** B2 필터 검사 — 서버(예림 B2)와 같은 오류 코드를 낸다 (API_SPEC B2) */
function checkFilters(filters: BoardFilters): CompanyRef[] {
  const codes = filters.peers ?? [];
  if (codes.length > MAX_BOARD_PEERS) {
    throw new ApiRequestError(
      "VALIDATION_ERROR",
      `비교 기업은 최대 ${MAX_BOARD_PEERS}곳까지 고를 수 있습니다.`,
      400,
    );
  }
  const peers = codes.map((code) => {
    const found = MOCK_COMPANIES.find((c) => c.stockCode === code);
    if (!found) throw new ApiRequestError("VALIDATION_ERROR", "없는 종목코드입니다.", 400);
    return found;
  });

  if (filters.period) {
    const { from, to } = filters.period;
    if (compareQuarters(from, to) > 0) {
      throw new ApiRequestError("VALIDATION_ERROR", "시작 분기가 끝 분기보다 늦습니다.", 400);
    }
    if (
      compareQuarters(from, EARLIEST_QUARTER) < 0 ||
      compareQuarters(to, latestAvailableQuarter()) > 0
    ) {
      throw new ApiRequestError(
        "OUT_OF_RANGE",
        `조회할 수 있는 기간은 ${EARLIEST_QUARTER_LABEL}부터 최신 보고서까지입니다.`,
        422,
      );
    }
  }
  return peers;
}

export async function mockGetBoard(analysisId: string): Promise<WithRemaining<BoardView>> {
  await mockDelay(200);
  const analysis = analysisWithResult(analysisId);
  // 필터를 한 번도 안 바꿨으면 보드가 없다 → 빈 필터 + 원래 결과 (PHASE3_PLAN §3.1)
  const board = readBoards()[analysisId] ?? {
    filters: {},
    result: analysis.result,
    explanationStatus: "ready" as const,
  };
  return { data: view(analysisId, board), questionsRemaining: remainingQuestions() };
}

export async function mockUpdateBoardFilters(
  analysisId: string,
  filters: BoardFilters,
): Promise<WithRemaining<BoardView>> {
  await mockDelay(450);
  const analysis = analysisWithResult(analysisId);
  const peers = checkFilters(filters);

  const period = filters.period ?? analysis.result.basis.period;
  const companies =
    1 + peers.filter((p) => p.stockCode !== analysis.result.basis.target.stockCode).length;
  if (quarterSpan(period.from, period.to) * companies > MOCK_BOARD_MAX_CELLS) {
    throw new ApiRequestError(
      "TOO_LARGE",
      "한 번에 계산할 수 있는 양을 넘었습니다. 기간이나 비교 기업 수를 줄여 주세요.",
      413,
    );
  }

  // 필터 바꾸기는 AI를 쓰지 않고 질문 수도 그대로다 (API_SPEC B2) — questionsUsed를 건드리지 않는다
  const board = {
    filters,
    result: withMockNewVersion(buildMockBoardResult({ original: analysis.result, filters, peers })),
    explanationStatus: "stale" as const,
  };
  saveBoard(analysisId, board);
  return { data: view(analysisId, board), questionsRemaining: remainingQuestions() };
}

export async function mockRewriteExplanation(
  analysisId: string,
): Promise<WithRemaining<RewriteResponse>> {
  await mockDelay(900);
  const analysis = analysisWithResult(analysisId);
  if (readMockState().questionsUsed >= MOCK_QUESTIONS_LIMIT) {
    throw new ApiRequestError(
      "QUOTA_EXCEEDED",
      "오늘 질문 수를 모두 사용했습니다.",
      429,
      nextKstMidnight(),
    );
  }
  // AI 장애: 차감하지 않고 기존 설명·보드 상태를 그대로 둔다 (API_SPEC Q9)
  if (llmDown()) {
    throw new ApiRequestError("LLM_UNAVAILABLE", "AI 서비스에 일시적인 문제가 있습니다.", 503);
  }
  if (!analysis.explanation) {
    throw new ApiRequestError("INVALID_STATE", "다시 쓸 분석 글이 없습니다.", 409);
  }

  const board = readBoards()[analysisId];
  const period = board?.result.basis.period ?? analysis.result.basis.period;
  const peerCount = board?.filters.peers?.length ?? 0;
  const condition = `${period.from}~${period.to}${peerCount > 0 ? `, 비교 기업 ${peerCount}곳` : ""}`;
  const explanation = {
    ...analysis.explanation,
    status: "ready" as const,
    conclusion: [
      `바꾼 조건(${condition}) 기준으로 다시 쓴 분석 글입니다.`,
      ...analysis.explanation.conclusion.slice(0, 1),
    ],
  };

  updateMockState((s) => {
    s.questionsUsed += 1;
    const saved = s.analyses[analysisId];
    if (saved) saved.explanation = explanation;
  });
  if (board) saveBoard(analysisId, { ...board, explanationStatus: "ready" });
  return { data: { explanation }, questionsRemaining: remainingQuestions() };
}
