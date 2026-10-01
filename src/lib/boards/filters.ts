// WU-401 보드 필터 (API_SPEC B2, PHASE3_PLAN §3.1): 요청 본문 검사와 "원래 분석 요청에 필터만 덮어쓰기".
import { z } from "zod";

import type { AnalysisRequestView, BoardFilters, CompanyRef, Quarter } from "@/contracts";
import { HttpError } from "@/lib/api/errors";
import {
  compareQuarters,
  EARLIEST_QUARTER,
  EARLIEST_QUARTER_LABEL,
  latestAvailableQuarter,
} from "@/lib/ask/quarter";

/** 비교 기업 최대 수 (대상 제외) */
export const MAX_BOARD_PEERS = 5;

const QuarterSchema = z
  .string()
  .regex(/^\d{4}Q[1-4]$/, "분기는 2026Q2 모양으로 적어 주세요.")
  .transform((q) => q as Quarter);

const BoardFiltersSchema = z
  .object({
    period: z.object({ from: QuarterSchema, to: QuarterSchema }).strict().optional(),
    peers: z.array(z.string().regex(/^\d{6}$/, "종목코드는 6자리 숫자입니다.")).optional(),
  })
  .strict();

const BoardPatchSchema = z.object({ filters: BoardFiltersSchema }).strict();

/**
 * B2 본문 `{ filters }`를 검사한다. 비교 기업은 중복을 빼고 대상 기업을 빼서 돌려준다.
 * - 모양이 틀림·시작이 끝보다 늦음·비교 기업 6곳 이상 → 400 VALIDATION_ERROR
 * - EARLIEST_QUARTER(2016Q1) 이전·최신 분기 이후 → 422 OUT_OF_RANGE (잘라서 계산하지 않는다 — 화면이 고른 기간 그대로 보여 줘야 해서)
 */
export function parseBoardFilters(
  body: unknown,
  targetStockCode: string,
  latest: Quarter = latestAvailableQuarter(),
): BoardFilters {
  const parsed = BoardPatchSchema.safeParse(body);
  if (!parsed.success) {
    throw new HttpError("VALIDATION_ERROR", undefined, {
      details: { issues: parsed.error.issues },
    });
  }
  const { period, peers } = parsed.data.filters;
  const filters: BoardFilters = {};

  if (period) {
    if (compareQuarters(period.from, period.to) > 0) {
      throw new HttpError("VALIDATION_ERROR", "시작 분기가 끝 분기보다 늦습니다.");
    }
    if (
      compareQuarters(period.from, EARLIEST_QUARTER) < 0 ||
      compareQuarters(period.to, latest) > 0
    ) {
      throw new HttpError(
        "OUT_OF_RANGE",
        `조회할 수 있는 기간은 ${EARLIEST_QUARTER_LABEL}부터 최신 보고서(${latest})까지입니다.`,
      );
    }
    filters.period = { from: period.from, to: period.to };
  }

  if (peers) {
    const unique = [...new Set(peers)].filter((code) => code !== targetStockCode);
    if (unique.length > MAX_BOARD_PEERS) {
      throw new HttpError(
        "VALIDATION_ERROR",
        `비교 기업은 최대 ${MAX_BOARD_PEERS}곳까지 고를 수 있습니다.`,
        { details: { maxPeers: MAX_BOARD_PEERS } },
      );
    }
    filters.peers = unique;
  }
  return filters;
}

/**
 * 원래 분석 요청에 필터(기간·비교 기업)만 덮어쓴다 (TECH §12.4). 지표·묶음 단위·의도는 그대로.
 * `peers`는 `filters.peers`를 기업 정보로 바꾼 것 (순서 그대로). 필터에 없는 항목은 원래 값.
 * 합계(aggregate "sum")에서 비교 기업을 모두 빼면 더할 기업이 대상 하나뿐이라 합계를 풀고 대상 기업 추이로 본다.
 */
export function applyBoardFilters(
  request: AnalysisRequestView,
  filters: BoardFilters,
  peers: CompanyRef[],
): AnalysisRequestView {
  const period = filters.period
    ? {
        from: filters.period.from,
        to: filters.period.to,
        specified: true,
        reason: `보드 필터: ${filters.period.from}~${filters.period.to}`,
        clipped: false,
      }
    : request.period;
  const next: AnalysisRequestView = {
    ...request,
    period,
    peers: filters.peers ? peers : request.peers,
  };
  if (next.aggregate === "sum" && next.peers.length === 0) {
    delete next.aggregate;
    next.groupBy = next.groupBy === "year" ? "year" : "quarter";
  }
  return next;
}
