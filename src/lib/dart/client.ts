import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkAndRecordApiUsage } from "@/lib/quota/api-usage";
import { createConcurrencyGate } from "@/lib/quota/concurrency";
import { QuotaExceededError, UpstreamApiError } from "@/lib/quota/errors";
import { fetchWithTimeout } from "@/lib/quota/fetch-with-timeout";
import { nextKstMidnight } from "@/lib/quota/kst";
import { logApiBlocked, logApiFailure } from "@/lib/quota/log";
import { withRetry } from "@/lib/quota/retry";
import { isDartBlockedToday, markDartBlockedToday } from "./circuit-breaker";
import { DART_OK_STATUS, DartApiError } from "./errors";

const BASE_URL = "https://opendart.fss.or.kr/api/";
const DEFAULT_TIMEOUT_MS = 10_000;
// TECH §13 max_retries_per_step(2)과 같은 값을 공통 호출기 자체 재시도에도 쓴다(외부 API 오류·시간 초과만).
const MAX_RETRIES = 2;

// OpenDART "동시 호출 최대 5개"(WU-102). 프로세스 하나에서 공유하는 게이트.
const dartConcurrencyGate = createConcurrencyGate(5);

export interface DartEnvelope {
  status: string;
  message: string;
}

export interface DartFetchOptions {
  /** dart_calls_per_user_per_day(회원별 숨은 한도) 판정용. 시스템 수집(기업 동기화 등)이면 생략. */
  userId?: string | null;
  /** 로그에 남길 분석 ID (TECH §19, 키·본문은 남기지 않는다) */
  analysisId?: string | null;
  timeoutMs?: number;
  /** 테스트에서 가짜 Supabase 클라이언트를 주입할 때만 쓴다. */
  client?: SupabaseClient;
}

/**
 * OpenDART 공통 호출기 (WU-102). **모든 OpenDART 호출은 이 함수를 거친다** — 래퍼 밖에서
 * 직접 `fetch`로 OpenDART를 부르지 않는다.
 *
 * 순서: ① 오늘 이미 020(요청 제한 초과)로 차단됐는지 확인 → ② 회원별·전체 상한 확인과 동시에
 * `api_usage_daily` 기록(DB 함수가 한 트랜잭션으로 처리) → ③ 동시 5개 제한 안에서 호출,
 * 네트워크 오류·5xx·시간 초과만 최대 {@link MAX_RETRIES}회 재시도.
 *
 * `status`가 "000"(정상)·"013"(데이터 없음)이면 그대로 돌려준다. "013"은 오류가 아니라 빈 결과라
 * 호출부가 빈 배열 등으로 처리해야 한다. 그 밖의 상태(특히 "020")는 던진다.
 */
export async function dartFetch<T extends DartEnvelope>(
  path: string,
  params: Record<string, string | number | undefined> = {},
  options: DartFetchOptions = {},
): Promise<T> {
  const { url, timeoutMs, client } = await prepareDartRequest(path, params, options);

  return runDartRequest(url, timeoutMs, options.analysisId ?? null, async (res) => {
    const body = (await res.json()) as T;
    if (DART_OK_STATUS.has(body.status)) return body;

    if (body.status === "020") await markDartBlockedToday(client);
    throw new DartApiError(body.status, body.message);
  });
}

/**
 * OpenDART의 바이너리(ZIP) 응답용 공통 호출기 — 고유번호(`corpCode.xml`, WU-103)에 쓴다.
 * 정상일 때는 ZIP 바이트를, 키·상한 오류일 때는(그때는 ZIP 대신 JSON 오류 응답이 온다) 매핑된
 * 오류를 던진다. 동시 호출 제한·재시도·차단·사용량 기록은 {@link dartFetch}와 완전히 같다.
 */
export async function dartFetchBinary(
  path: string,
  params: Record<string, string | number | undefined> = {},
  options: DartFetchOptions = {},
): Promise<ArrayBuffer> {
  const { url, timeoutMs, client } = await prepareDartRequest(path, params, options);

  return runDartRequest(url, timeoutMs, options.analysisId ?? null, async (res) => {
    // 오류일 때는 ZIP이 아니라 {status, message} JSON을 돌려준다(OpenDART 공식 동작).
    // 공시서류원본(`document.xml`)은 오류를 `<result><status>013</status>…` XML로 준다 (2026-10-01 확인,
    // 정상 ZIP은 application/x-msdownload)
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("json")) {
      const body = (await res.json()) as DartEnvelope;
      if (body.status === "020") await markDartBlockedToday(client);
      throw new DartApiError(body.status, body.message);
    }
    if (/\bxml\b/.test(type) && !type.includes("msdownload")) {
      const text = await res.text();
      const status = /<status>\s*(\d{3})\s*<\/status>/.exec(text)?.[1] ?? "900";
      const message = /<message>([\s\S]*?)<\/message>/.exec(text)?.[1]?.trim();
      if (status === "020") await markDartBlockedToday(client);
      throw new DartApiError(status, message);
    }
    return res.arrayBuffer();
  });
}

async function prepareDartRequest(
  path: string,
  params: Record<string, string | number | undefined>,
  options: DartFetchOptions,
): Promise<{ url: URL; timeoutMs: number; client: SupabaseClient | undefined }> {
  const { userId = null, timeoutMs = DEFAULT_TIMEOUT_MS, client } = options;

  if (await isDartBlockedToday(client)) {
    logApiBlocked({ provider: "dart", reason: "오늘 이미 OpenDART 020(요청 제한 초과) 발생" });
    throw new QuotaExceededError("dart", nextKstMidnight());
  }

  // 상한 확인과 기록을 한 번에 처리한다. 넘으면 여기서 QuotaExceededError를 던지고 끝 — 외부 호출 없음.
  await checkAndRecordApiUsage({ provider: "dart", userId, calls: 1 }, client);

  const apiKey = process.env.OPENDART_API_KEY;
  if (!apiKey) throw new Error("OPENDART_API_KEY가 설정되지 않았습니다.");

  const url = new URL(path, BASE_URL);
  url.searchParams.set("crtfc_key", apiKey);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  return { url, timeoutMs, client };
}

async function runDartRequest<T>(
  url: URL,
  timeoutMs: number,
  analysisId: string | null,
  handleResponse: (res: Response) => Promise<T>,
): Promise<T> {
  try {
    return await dartConcurrencyGate.run(() =>
      withRetry(() => requestOnce(url, timeoutMs, handleResponse), {
        retries: MAX_RETRIES,
        isRetryable: (error) => error instanceof UpstreamApiError && error.retryable,
      }),
    );
  } catch (error) {
    logApiFailure({
      provider: "dart",
      message: error instanceof Error ? error.message : String(error),
      analysisId,
    });
    throw error;
  }
}

async function requestOnce<T>(
  url: URL,
  timeoutMs: number,
  handleResponse: (res: Response) => Promise<T>,
): Promise<T> {
  let res: Response;
  try {
    res = await fetchWithTimeout(url, {}, timeoutMs);
  } catch (cause) {
    throw new UpstreamApiError("dart", "OpenDART 요청 실패(네트워크·시간 초과)", true, cause);
  }

  if (!res.ok) {
    throw new UpstreamApiError("dart", `OpenDART HTTP 오류 (${res.status})`, res.status >= 500);
  }

  return handleResponse(res);
}
