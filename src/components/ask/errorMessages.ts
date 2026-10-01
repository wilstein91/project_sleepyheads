// 오류 코드별 화면 안내 (API_SPEC §1.7 "화면 처리" 열). 무엇이 잘못됐고 어떻게 하면 되는지를 쓴다.
import { ApiRequestError } from "@/lib/api-client/errors";
import { EARLIEST_QUARTER_LABEL } from "@/lib/ask/quarter";

/** 조회 시작 분기 "2016년 1분기" — `EARLIEST_QUARTER`가 바뀌면 안내도 같이 바뀐다 (서버 422 문구와 같은 값) */
export function earliestQuarterLabel(): string {
  return EARLIEST_QUARTER_LABEL;
}

export interface ErrorNotice {
  title: string;
  body: string;
  /** 질문 수가 차감되는 오류인가 (422는 차감, API_SPEC Q1) */
  charged: boolean;
  /** 대신 해볼 수 있는 질문 */
  suggestions: string[];
  /** 문의할 때 알려 줄 요청 ID (예상 못 한 서버 오류일 때만 보여 준다) */
  requestId?: string | null;
}

export function formatKstTime(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

export function describeError(error: unknown): ErrorNotice {
  const e =
    error instanceof ApiRequestError
      ? error
      : new ApiRequestError("NETWORK_ERROR", "알 수 없는 오류", null);
  const resetAt = formatKstTime(e.resetAt);
  const none = { charged: false, suggestions: [] };

  switch (e.code) {
    case "UNSUPPORTED_QUESTION": {
      const examples = Array.isArray(e.details?.examples)
        ? (e.details.examples as string[]).join(", ")
        : "매출액, 영업이익, 순이익, 영업이익률";
      return {
        title: "공시 자료로 답할 수 없는 질문입니다",
        body: `${e.message} ${examples}처럼 재무제표에 있는 지표로 물어봐 주세요.`,
        charged: true,
        suggestions: ["삼성전자의 최근 5년 매출액 추이를 보여줘"],
      };
    }
    case "OUT_OF_RANGE":
      return {
        title: "조회할 수 없는 기간입니다",
        body: `${earliestQuarterLabel()}부터 최신 보고서까지의 기간으로 다시 물어봐 주세요.`,
        charged: true,
        suggestions: ["삼성전자의 최근 5년 매출액 추이를 보여줘"],
      };
    case "QUOTA_EXCEEDED":
      return {
        title: "오늘 질문을 모두 사용했습니다",
        body: `${resetAt ?? "한국 시간 자정"}에 질문 수가 다시 채워집니다. 이미 만든 분석은 계속 볼 수 있습니다.`,
        ...none,
      };
    case "DECLINE_LIMIT":
      return {
        title: "서비스 목적에 맞는 질문만 가능합니다",
        body: `오늘은 기업 분석과 관계없는 질문이 여러 번 들어와 새 질문을 받지 않습니다. ${resetAt ?? "한국 시간 자정"}부터 다시 질문할 수 있습니다.`,
        ...none,
      };
    case "RATE_LIMITED":
      return {
        title: "질문을 너무 빠르게 보냈습니다",
        body: `${e.retryAfterSeconds ?? 60}초 뒤에 다시 보내 주세요.`,
        ...none,
      };
    case "LLM_UNAVAILABLE":
      return {
        title: "지금은 분석할 수 없습니다",
        body: "질문을 해석하는 AI 서비스에 일시적인 문제가 있습니다. 질문 수는 차감되지 않았으니 잠시 후 다시 보내 주세요.",
        ...none,
      };
    case "SERVICE_BUDGET":
      return {
        title: "오늘은 새 분석을 받을 수 없습니다",
        body: "서비스 전체 사용량이 하루 한도에 도달했습니다. 내일 다시 이용해 주세요.",
        ...none,
      };
    case "UPSTREAM_ERROR":
      return {
        title: "공시 데이터를 불러오지 못했습니다",
        body: "전자공시(DART)가 응답하지 않습니다. 잠시 후 다시 시도해 주세요.",
        ...none,
      };
    case "TOO_LARGE":
      // 질문(/api/ask)에서는 AI가 질문을 읽은 뒤라 422처럼 질문 1회가 사용된다 (API_SPEC Q1).
      // Step 4 보드 필터(B2)의 TOO_LARGE는 차감이 없으니, 그 화면을 만들 때 charged를 따로 정한다
      return {
        title: "한 번에 처리할 수 있는 양을 넘었습니다",
        body: e.message || "기간을 줄이거나 비교할 기업 수를 줄여서 다시 물어봐 주세요.",
        charged: true,
        suggestions: ["삼성전자와 SK하이닉스 영업이익 비교해줘"],
      };
    case "VALIDATION_ERROR":
      return { title: "질문을 확인해 주세요", body: "질문은 1~500자로 입력해 주세요.", ...none };
    case "INTERNAL_ERROR":
      return {
        title: "일시적인 서버 오류가 발생했습니다",
        body: "잠시 후 다시 시도해 주세요. 같은 문제가 계속되면 아래 요청 ID를 함께 알려 주세요.",
        ...none,
        requestId: e.requestId,
      };
    case "NETWORK_ERROR":
      return {
        title: "서버에 연결하지 못했습니다",
        body: "인터넷 연결을 확인하고 다시 보내 주세요.",
        ...none,
      };
    default:
      return {
        title: "요청을 처리하지 못했습니다",
        body: "잠시 후 다시 시도해 주세요.",
        ...none,
        requestId: e.requestId,
      };
  }
}
