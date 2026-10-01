import { z } from "zod";

import type { AnalysisRequestView, Diagnosis, Explanation, ResultObject } from "@/contracts";
import { HttpError } from "@/lib/api/errors";
import { ownedOrNotFound } from "@/lib/api/guards";
import { created } from "@/lib/api/respond";
import { route } from "@/lib/api/route";
import {
  consumeQuestionQuota,
  QuestionQuotaExceededError,
  refundQuestionQuota,
} from "@/lib/quota/question-quota";
import { CALC_VERSION } from "@/lib/metrics/types";
import { carryReport } from "@/lib/report/carry";
import { runAnalysis } from "@/lib/runner/execute";
import { withLatestDefaultPeriod } from "@/lib/runner/latest-request";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { SessionClient } from "@/lib/supabase/server";
import { sameNumbers } from "@/lib/versions/compare";
import { isNewerDataAvailable, loadDataVersion } from "@/lib/versions/store";
import { hashAnalysisRequest } from "@/lib/versions/version";
import { buildStoredPlan } from "@/lib/runner/steps/plan";

// API_SPEC §8.2
export const maxDuration = 60;

const RerunBodySchema = z.object({ useLatestData: z.boolean() });

interface OriginalRow {
  id: string;
  owner_id: string;
  project_id: string;
  question: string;
  status: string;
  mixed_scope: boolean;
  analysis_request: AnalysisRequestView | null;
  result: ResultObject | null;
  explanation: Explanation | null;
  diagnoses: Diagnosis[] | null;
  dataset_version_id: string | null;
  /** 분석 요청 해시. 비어 있으면 Q9(설명 다시 쓰기)가 보드 조건 기준으로 설명을 다시 쓴 분석이다 */
  request_hash: string | null;
}

// Q6 POST /api/analyses/:id/rerun 🔑 🛡️ — API_SPEC §4 (WU-202)
// useLatestData=false: 같은 데이터 버전(출처 접수번호·전처리 선택)으로 다시 계산해 새 분석으로 저장한다.
//   AI 호출 없음·질문 0회·저장된 설명 재사용. 숫자가 원래와 같은지(sameNumbers) 서버가 확인한다.
// useLatestData=true: 같은 분석 요청으로 새 분석을 만든다(질문 1회). 질문에 기간이 없었으면(기본 기간)
//   오늘 기준 최근 N분기로 다시 잡는다(AI 없이, withLatestDefaultPeriod). 상태 queued로 돌려주면 화면이
//   Q4를 불러 최신 보고서로 계산하고 설명을 새로 쓴다. 두 경우 모두 이전 분석은 그대로 남는다.
export const POST = route(
  { access: "member", questionRequest: true, idempotent: true },
  async (ctx) => {
    const parsed = RerunBodySchema.safeParse(await ctx.req.json().catch(() => null));
    if (!parsed.success) {
      throw new HttpError("VALIDATION_ERROR", undefined, {
        details: { issues: parsed.error.issues },
      });
    }
    const { useLatestData } = parsed.data;
    const supabase = ctx.supabase!;
    const userId = ctx.userId!;
    const idempotencyKey = ctx.idempotencyKey!;
    const admin = getSupabaseAdmin();

    const { data, error } = await supabase
      .from("analyses")
      .select(
        "id, owner_id, project_id, question, status, mixed_scope, analysis_request, result, explanation, diagnoses, dataset_version_id, request_hash",
      )
      .eq("id", ctx.params.id)
      .maybeSingle();
    if (error) throw error;
    const original = ownedOrNotFound(data as OriginalRow | null, userId);

    // 재요청 안전: 같은 멱등키로 이미 만든 재실행이 있으면 그대로 돌려준다 (차감·계산 없음)
    const { data: existing, error: existingError } = await supabase
      .from("analyses")
      .select("id, status, result")
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (existingError) throw existingError;
    if (existing) {
      const again = existing as { id: string; status: string; result: ResultObject | null };
      return created({
        analysisId: again.id,
        status: again.status,
        sameNumbers:
          !useLatestData && again.result && original.result
            ? sameNumbers(original.result, again.result)
            : null,
      });
    }

    if (
      (original.status !== "succeeded" && original.status !== "partial") ||
      !original.analysis_request ||
      !original.result
    ) {
      throw new HttpError("INVALID_STATE", "결과가 있는 분석만 다시 실행할 수 있습니다.");
    }
    const request = original.analysis_request;
    const base = {
      project_id: original.project_id,
      owner_id: userId,
      question: original.question,
      idempotency_key: idempotencyKey,
      analysis_request: request,
      mixed_scope: original.mixed_scope,
    };

    if (!useLatestData) {
      const version = original.dataset_version_id
        ? await loadDataVersion(supabase, original.dataset_version_id)
        : null;
      if (!version) {
        throw new HttpError(
          "INVALID_STATE",
          "데이터 버전을 기록하기 전에 만든 분석이라 같은 조건으로 다시 실행할 수 없습니다. [최신 데이터로 다시 분석]을 이용해 주세요.",
        );
      }

      // 계산식이 바뀌었으면 같은 출처라도 같은 숫자를 약속할 수 없다 — 최신으로 다시 분석하게 안내한다
      if (version.calcVersion !== CALC_VERSION) {
        throw new HttpError(
          "INVALID_STATE",
          "계산 방식이 바뀌어 같은 조건으로 다시 실행할 수 없습니다. [최신 데이터로 다시 분석]을 이용해 주세요.",
        );
      }

      const outcome = await runAnalysis(request, { userId, client: admin, version });
      if (outcome.kind !== "done") throw new Error("재실행이 전처리 진단에서 멈췄습니다");
      // 투자 리포트는 그 분석을 한 시점의 스냅숏 — 원래 것을 그대로 붙인다 (Phase 5 후속)
      const result = carryReport(original.result, outcome.result);
      result.basis.newerDataVersionAvailable = await isNewerDataAvailable(admin, version.sources);
      const same = sameNumbers(original.result, result);
      // 숫자가 같으면 설명도 그대로 맞다. 다르면(있어서는 안 되는 경우) 옛 설명을 "갱신 필요"로 표시한다.
      // 설명을 보드 조건으로 다시 쓴 분석(Q9가 request_hash를 비움)도 — 다시 계산한 원래 숫자와 맞지 않는다 (Phase 3 통합)
      const rewrittenForBoard = original.request_hash === null;
      const explanation =
        original.explanation && (!same || rewrittenForBoard)
          ? { ...original.explanation, status: "stale" as const }
          : original.explanation;

      const { data: inserted, error: insertError } = await supabase
        .from("analyses")
        .insert({
          ...base,
          status: "succeeded",
          result,
          explanation,
          diagnoses: original.diagnoses,
          dataset_version_id: version.id,
          request_hash: hashAnalysisRequest({ request, mixedScope: original.mixed_scope }),
        })
        .select("id")
        .single();
      if (insertError) throw insertError;
      await touchProject(supabase, original.project_id, ctx.requestId);
      return created({ analysisId: inserted.id, status: "succeeded", sameNumbers: same });
    }

    // 최신 데이터로 다시 분석: 질문 1회 (같은 멱등키 재요청은 DB 함수가 재차감하지 않는다)
    const latestRequest = withLatestDefaultPeriod(request);
    // 사용자가 [최신 데이터로 다시 분석]을 눌러 이미 동의했다 — 복합 질문이어도 계획 카드를 다시 띄우지 않게
    // 승인된 계획을 함께 넣는다 (트랙 A 부탁, 통합 검토). 질문 수 차감 전에 만들어 실패해도 차감되지 않게
    const plan = { ...buildStoredPlan(latestRequest), approvedAt: new Date().toISOString() };
    try {
      const consumed = await consumeQuestionQuota(userId, idempotencyKey, admin);
      if (consumed.alreadyConsumed) {
        throw new HttpError(
          "INVALID_STATE",
          "같은 요청을 처리하고 있습니다. 잠시 후 다시 시도해 주세요.",
        );
      }
    } catch (err) {
      if (err instanceof QuestionQuotaExceededError) {
        throw new HttpError("QUOTA_EXCEEDED", undefined, { resetAt: err.resetAt });
      }
      throw err;
    }

    const { data: inserted, error: insertError } = await supabase
      .from("analyses")
      .insert({
        ...base,
        analysis_request: latestRequest,
        status: "queued",
        plan,
      })
      .select("id")
      .single();
    if (insertError) {
      await refundQuestionQuota(userId, idempotencyKey, admin).catch((refundError) =>
        console.warn(`[${ctx.requestId}] 재분석 저장 실패 뒤 질문 수 환불 실패:`, refundError),
      );
      throw insertError;
    }
    await touchProject(supabase, original.project_id, ctx.requestId);
    return created({ analysisId: inserted.id, status: "queued", sameNumbers: null });
  },
);

// 내 분석 목록(P1)이 최근 활동순이라, 새 분석이 생기면 프로젝트 활동 시각을 올린다 (Q1 후속 질문과 같게)
async function touchProject(supabase: SessionClient, projectId: string, requestId: string) {
  const { error } = await supabase
    .from("projects")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", projectId);
  if (error) console.warn(`[${requestId}] 프로젝트 활동 시각 갱신 실패:`, error);
}
