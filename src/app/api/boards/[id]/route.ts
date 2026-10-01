import type { AnalysisRequestView, CompanyRef, ResultObject } from "@/contracts";
import { HttpError } from "@/lib/api/errors";
import { ownedOrNotFound } from "@/lib/api/guards";
import { ok } from "@/lib/api/respond";
import { route } from "@/lib/api/route";
import {
  loadAutoPeers,
  loadBoardRow,
  parseBoardFilters,
  recomputeBoard,
  saveBoard,
  toBoardView,
} from "@/lib/boards";
import { carryReport } from "@/lib/report/carry";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { SessionClient } from "@/lib/supabase/server";

// API_SPEC §8.2는 PATCH(B2)만 60초. maxDuration은 파일 단위라 GET(B1)에도 같이 적용된다.
export const maxDuration = 60;

interface AnalysisRow {
  id: string;
  owner_id: string;
  status: string;
  analysis_request: AnalysisRequestView | null;
  result: ResultObject | null;
  dataset_version_id: string | null;
  updated_at: string;
}

/** 보드 ID = 분석 ID (PHASE3_PLAN §3.1). 남의 것·없는 것은 404, 결과가 없는 분석은 409 */
async function loadAnalysisWithResult(supabase: SessionClient, id: string, userId: string) {
  const { data, error } = await supabase
    .from("analyses")
    .select("id, owner_id, status, analysis_request, result, dataset_version_id, updated_at")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  const analysis = ownedOrNotFound(data as AnalysisRow | null, userId);
  if ((analysis.status !== "succeeded" && analysis.status !== "partial") || !analysis.result) {
    throw new HttpError("INVALID_STATE", "결과가 있는 분석만 보드로 볼 수 있습니다.");
  }
  return { ...analysis, result: analysis.result };
}

/** 원래 비교 기업: 질문에 적은 경쟁사, 없으면 get_peers 단계가 자동으로 고른 경쟁사 (실행 기록) */
async function originalPeers(analysis: AnalysisRow): Promise<CompanyRef[]> {
  const asked = analysis.analysis_request?.peers ?? [];
  if (asked.length > 0) return asked;
  return loadAutoPeers(getSupabaseAdmin(), analysis.id);
}

// B1 GET /api/boards/:id 🔑 🛡️ — API_SPEC B1 (WU-401)
// 보드가 없으면(필터를 한 번도 안 바꿈) filters: {} + 원래 결과 + "ready".
export const GET = route({ access: "member" }, async (ctx) => {
  const supabase = ctx.supabase!;
  const analysis = await loadAnalysisWithResult(supabase, ctx.params.id, ctx.userId!);
  const board = await loadBoardRow(supabase, analysis.id);
  const peers = await originalPeers(analysis);
  // 질문에 적은 경쟁사는 화면이 분석 요청에서 이미 안다 — 자동 선택 경쟁사만 filters.peers로 알려 준다
  const auto = analysis.analysis_request?.peers.length ? [] : peers;
  return ok(toBoardView(analysis, board, auto));
});

// B2 PATCH /api/boards/:id 🔑 🛡️ — API_SPEC B2 (WU-401)
// 필터(기간·비교 기업)만 바꿔 서버가 다시 계산하고 boards에 저장한다. AI 호출 없음·질문 차감 없음.
// 순서: 소유자 검사(404) → 결과 있는 분석(409) → 필터 검사(400·422) → 처리 한도(413, 계산 전) → 다시 계산 → 저장
export const PATCH = route({ access: "member" }, async (ctx) => {
  const supabase = ctx.supabase!;
  const userId = ctx.userId!;
  const analysis = await loadAnalysisWithResult(supabase, ctx.params.id, userId);

  // 다시 계산은 원래 분석 요청이 있어야 한다 (B1은 결과만 있으면 된다)
  const request = analysis.analysis_request;
  if (!request) {
    throw new HttpError(
      "INVALID_STATE",
      "분석 요청이 저장되지 않은 분석이라 필터를 바꿀 수 없습니다.",
    );
  }
  const body = await ctx.req.json().catch(() => null);
  const filters = parseBoardFilters(body, request.target.stockCode);

  const admin = getSupabaseAdmin();
  // 자동 선택 경쟁사도 원래 비교 기업으로 — 기간만 바꿔도 비교 기업이 사라지지 않게
  const peers = await originalPeers(analysis);
  const result = await recomputeBoard(
    {
      analysisId: analysis.id,
      ownerId: userId,
      request: { ...request, peers },
      datasetVersionId: analysis.dataset_version_id,
      filters,
    },
    admin,
  );

  // 투자 리포트는 원래 분석 것을 그대로 (보드 필터는 질문 차트만 다시 계산한다 — Phase 5 후속)
  carryReport(analysis.result, result);

  await saveBoard(admin, {
    analysisId: analysis.id,
    ownerId: userId,
    filters,
    result,
    updatedAt: new Date().toISOString(),
  });
  const autoShown =
    !filters.peers && !request.peers.length && peers.length > 0
      ? { ...filters, peers: peers.map((p) => p.stockCode) }
      : filters;
  return ok({
    id: analysis.id,
    analysisId: analysis.id,
    filters: autoShown,
    result,
    explanationStatus: "stale" as const,
  });
});
