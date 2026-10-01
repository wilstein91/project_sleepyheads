// 분석 글(AI ③)에 붙일 공시 원문 단락 찾기. 재무 수집(get_financials)이 이미 확인한 보고서의 접수번호를
// 그대로 쓴다 — 차트 숫자와 같은 보고서의 글을 읽는다. 던지지 않는다: 원문을 못 받으면 단락 없이(지금과 같은 분석 글).
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MetricId } from "@/contracts";
import { METRIC_LABEL } from "@/lib/runner/metric-info";
import { reportDisplayName } from "@/lib/runner/format";
import type { DataSource } from "@/lib/versions/version";
import { fetchFiling } from "./fetch";
import {
  noteTitleTerms,
  queryTerms,
  selectPassages,
  type FilingPassage,
  type FilingSource,
} from "./passages";

export type { FilingPassage } from "./passages";

export interface FindFilingPassagesInput {
  corpCode: string;
  /** get_financials 출력의 출처 (여러 기업이 섞여 있어도 corpCode 것만 쓴다) */
  sources: readonly DataSource[];
  question: string;
  metrics: readonly MetricId[];
  userId?: string | null;
  analysisId?: string | null;
  client?: SupabaseClient;
}

export interface FoundFilingPassages {
  passages: FilingPassage[];
  externalCalls: number;
  /** 실행 기록용 ("공시 원문 2건에서 14단락") */
  note: string;
}

/**
 * 읽을 보고서: ① 분석 기간의 가장 최근 보고서(사업의 내용·주석이 최신) ② 가장 최근 사업보고서
 * (경영진단은 사업보고서에만 있다). 같으면 하나만 받는다.
 */
export function pickFilingReports(sources: readonly DataSource[], corpCode: string): DataSource[] {
  const own = sources
    .filter((s) => s.corpCode === corpCode && s.rceptNo)
    // 접수번호 앞 8자리가 접수일이라 글자 순서 = 시간 순서
    .sort((a, b) => (b.rceptNo! < a.rceptNo! ? -1 : 1));
  const latest = own[0];
  const annual = own.find((s) => s.reprtCode === "11011");
  return [latest, annual].filter(
    (s, i, all): s is DataSource => !!s && all.findIndex((x) => x?.rceptNo === s.rceptNo) === i,
  );
}

export async function findFilingPassages(
  input: FindFilingPassagesInput,
): Promise<FoundFilingPassages> {
  const reports = pickFilingReports(input.sources, input.corpCode);
  if (reports.length === 0) {
    return { passages: [], externalCalls: 0, note: "공시 원문 없음 (확인한 보고서 없음)" };
  }

  // 두 보고서를 동시에 받는다 (OpenDART 동시 호출 상한 5개 안쪽)
  const settled = await Promise.allSettled(
    reports.map((r) =>
      fetchFiling(r.rceptNo!, {
        userId: input.userId ?? null,
        analysisId: input.analysisId ?? null,
        client: input.client,
      }),
    ),
  );

  let externalCalls = 0;
  const sources: FilingSource[] = [];
  settled.forEach((s, i) => {
    if (s.status !== "fulfilled") {
      console.warn(`[filings] ${reports[i].rceptNo} 원문 받기 실패:`, s.reason);
      return;
    }
    externalCalls += s.value.externalCalls;
    sources.push({
      rceptNo: reports[i].rceptNo!,
      reportName: reportDisplayName(reports[i].bsnsYear, reports[i].reprtCode),
      filing: s.value.filing,
    });
  });
  if (sources.length === 0) {
    return { passages: [], externalCalls, note: "공시 원문 받기 실패 — 숫자만으로 작성" };
  }

  const passages = selectPassages(sources, {
    terms: queryTerms(
      input.question,
      input.metrics.map((m) => METRIC_LABEL[m]),
    ),
    noteTitles: noteTitleTerms(input.metrics),
  });
  return {
    passages,
    externalCalls,
    note: `공시 원문 ${sources.length}건에서 ${passages.length}단락`,
  };
}
