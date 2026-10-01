import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkAndRecordApiUsage, recordApiUsageDetails } from "@/lib/quota/api-usage";
import { UpstreamApiError } from "@/lib/quota/errors";
import { fetchWithTimeout } from "@/lib/quota/fetch-with-timeout";
import { logApiFailure } from "@/lib/quota/log";
import { withRetry } from "@/lib/quota/retry";
import { estimateLlmCostUsd } from "./pricing";

const BASE_URL = "https://api.openai.com/v1/responses";
const DEFAULT_TIMEOUT_MS = 30_000;
// TECH §11.5 장애 처리: AI 호출은 "1회 재시도 후 실패 처리".
const MAX_RETRIES = 1;
const DEFAULT_MODEL = "gpt-6-luna";

/**
 * 잔액·지출 한도 오류 (429) — 이 키로는 다시 해도 안 되므로 **다음 키로** 넘어간다. 속도 제한(429 `rate_limit_error`)은
 * 키를 바꾸지 않는다. 코드 이름은 OpenAI 공식 문서 Error codes(developers.openai.com/api/docs/guides/error-codes,
 * 2026-09-30 확인): `error.code`에 아래 값, 넓은 분류 `error.type`은 `insufficient_quota`일 수 있다.
 */
const KEY_EXHAUSTED_CODES = new Set([
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "insufficient_quota",
]);

/** 이 키로는 더 부를 수 없다 (잔액·지출 한도) */
class KeyExhaustedError extends UpstreamApiError {
  constructor(code: string) {
    super("llm", `OpenAI 키 잔액·한도 소진 (${code})`, false);
  }
}

/**
 * `OPENAI_API_KEY`는 쉼표로 여러 개 넣을 수 있다 (팀원 키를 순서대로 — 2026-09-30 현준님 요청).
 * 앞 키가 잔액 부족이면 다음 키로 같은 요청을 한 번 더 한다. 로그에는 **몇 번째 키인지만** 남긴다(키 값 없음).
 */
export function parseApiKeys(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

// 같은 서버 인스턴스 안에서는 잔액이 떨어진 키를 다시 부르지 않는다 (키 목록이 바뀌면 처음부터)
let exhausted: { keys: string; from: number } = { keys: "", from: 0 };

/** 테스트용 — 기억해 둔 "떨어진 키"를 비운다 */
export function resetExhaustedKeysForTest(): void {
  exhausted = { keys: "", from: 0 };
}

export interface LlmJsonSchema {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
}

export interface LlmCallRequest {
  userId?: string | null;
  analysisId?: string | null;
  /** Responses API의 input(메시지·지시문 등). 프롬프트 조립은 호출부(WU-109·111) 몫. */
  input: unknown;
  /** Structured Outputs로 강제할 JSON 스키마 (TECH §4.2, §11.3, §11.5 "출력 제한"). 생략하면 평문. */
  schema?: LlmJsonSchema;
  model?: string;
  /**
   * 추론 모델의 생각 분량 (Responses API `reasoning.effort`). 생략하면 모델 기본값. 분석 글은 "low" —
   * 2026-10-01 실측(gpt-6-sol, 같은 입력): 기본 13.7~14.8초 → low 7.6~7.7초, 글 품질 차이 없음
   */
  reasoningEffort?: "low" | "medium" | "high";
  timeoutMs?: number;
  /** 테스트에서 가짜 Supabase 클라이언트를 주입할 때만 쓴다. */
  client?: SupabaseClient;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface LlmCallResult<T = unknown> {
  output: T;
  usage: LlmUsage;
}

interface OpenAiResponsesBody {
  output_text?: string;
  output?: Array<{ content?: Array<{ type: string; text?: string }> }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * OpenAI 공통 호출기 (WU-102). **모든 AI 호출은 이 함수를 거친다.**
 * 호출 수는 요청 전에 확인·기록하고, 토큰·비용은 응답을 받은 뒤 같은 DB 함수로 더한다
 * (TECH §13 "AI는 토큰·비용까지" 기록). 질문당 비용 상한·되묻기·거절 판단은 분석 실행기(WU-109~111) 몫이다.
 */
export async function llmCall<T = unknown>(request: LlmCallRequest): Promise<LlmCallResult<T>> {
  const { userId = null, analysisId = null, timeoutMs = DEFAULT_TIMEOUT_MS, client } = request;
  const model = request.model ?? process.env.OPENAI_MODEL ?? DEFAULT_MODEL;

  await checkAndRecordApiUsage({ provider: "llm", userId, calls: 1 }, client);

  const raw = process.env.OPENAI_API_KEY;
  const apiKeys = parseApiKeys(raw);
  if (apiKeys.length === 0) throw new Error("OPENAI_API_KEY가 설정되지 않았습니다.");
  // 키 목록이 바뀌었거나, 모든 키가 떨어졌다고 기억 중이면 처음 키부터 다시 (충전·한도 조정 뒤 서버 재시작 없이 되살아나게)
  if (exhausted.keys !== raw || exhausted.from >= apiKeys.length) {
    exhausted = { keys: raw ?? "", from: 0 };
  }

  try {
    let body: OpenAiResponsesBody | null = null;
    for (let i = exhausted.from; i < apiKeys.length && body === null; i += 1) {
      try {
        body = await withRetry(() => requestOnce(model, apiKeys[i], request, timeoutMs), {
          retries: MAX_RETRIES,
          isRetryable: (error) => error instanceof UpstreamApiError && error.retryable,
        });
      } catch (error) {
        if (!(error instanceof KeyExhaustedError)) throw error;
        exhausted = { keys: raw ?? "", from: i + 1 };
        console.warn(
          `[llm] OpenAI 키 ${i + 1}번 잔액·한도 소진 — ${
            i + 1 < apiKeys.length ? `${i + 2}번 키로` : "남은 키 없음"
          } (${error.message})`,
        );
        if (i + 1 >= apiKeys.length) throw error;
      }
    }
    if (body === null) {
      throw new UpstreamApiError("llm", "OpenAI 키가 모두 잔액·한도 소진 상태입니다", false);
    }

    const inputTokens = body.usage?.input_tokens ?? 0;
    const outputTokens = body.usage?.output_tokens ?? 0;
    const costUsd = estimateLlmCostUsd(model, inputTokens, outputTokens);

    await recordApiUsageDetails(
      { provider: "llm", userId, inputTokens, outputTokens, costUsd },
      client,
    );

    const text = extractOutputText(body);
    return {
      output: (request.schema ? JSON.parse(text) : text) as T,
      usage: { inputTokens, outputTokens, costUsd },
    };
  } catch (error) {
    logApiFailure({
      provider: "llm",
      message: error instanceof Error ? error.message : String(error),
      analysisId,
    });
    throw error;
  }
}

function extractOutputText(body: OpenAiResponsesBody): string {
  if (body.output_text !== undefined) return body.output_text;
  const text = body.output
    ?.flatMap((item) => item.content ?? [])
    .find((content) => content.type === "output_text")?.text;
  if (text === undefined)
    throw new UpstreamApiError("llm", "AI 응답에서 출력 텍스트를 찾지 못했습니다.", false);
  return text;
}

async function requestOnce(
  model: string,
  apiKey: string,
  request: LlmCallRequest,
  timeoutMs: number,
): Promise<OpenAiResponsesBody> {
  let res: Response;
  try {
    res = await fetchWithTimeout(
      BASE_URL,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: request.input,
          ...(request.reasoningEffort ? { reasoning: { effort: request.reasoningEffort } } : {}),
          ...(request.schema
            ? {
                text: {
                  format: {
                    type: "json_schema",
                    name: request.schema.name,
                    schema: request.schema.schema,
                    strict: request.schema.strict ?? true,
                  },
                },
              }
            : {}),
        }),
      },
      timeoutMs,
    );
  } catch (cause) {
    throw new UpstreamApiError("llm", "OpenAI 요청 실패(네트워크·시간 초과)", true, cause);
  }

  if (!res.ok) {
    if (res.status === 429) {
      const code = await billingErrorCode(res);
      if (code) throw new KeyExhaustedError(code);
    }
    throw new UpstreamApiError("llm", `OpenAI HTTP 오류 (${res.status})`, res.status >= 500);
  }
  return (await res.json()) as OpenAiResponsesBody;
}

/** 429 본문에서 잔액·한도 코드를 찾는다 (속도 제한이면 null). 본문을 못 읽으면 null — 키를 바꾸지 않는다 */
async function billingErrorCode(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: { code?: string | null; type?: string | null } };
    const code = body.error?.code ?? "";
    const type = body.error?.type ?? "";
    if (KEY_EXHAUSTED_CODES.has(code)) return code;
    if (type === "insufficient_quota") return code || type;
    return null;
  } catch {
    return null;
  }
}
