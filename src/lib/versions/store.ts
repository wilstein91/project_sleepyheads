// WU-202: dataset_versions 저장·조회와 "새 데이터 버전 있음" 판정 (TECH §5.2, §15.2).
// 쓰기는 관리자 클라이언트(서버)만 — 회원은 RLS로 자기 행 읽기만 할 수 있다.
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Explanation } from "@/contracts";
import type { PreprocessDecisions } from "@/lib/preprocess/types";
import { normalizeSources, type DataSource, type DataVersionContent } from "./version";

interface DatasetVersionRow {
  id: string;
  owner_id: string;
  sources: DataSource[];
  price_date: string | null;
  calc_version: string;
  preprocess_decisions: PreprocessDecisions | null;
  hash: string;
}

export interface StoredDataVersion extends DataVersionContent {
  id: string;
  ownerId: string;
  hash: string;
}

/**
 * 데이터 버전을 저장한다. 같은 회원·같은 해시가 이미 있으면 그대로 둔다(같은 ID —
 * `dataVersionIdFor`가 해시에서 ID를 만들기 때문).
 */
export async function saveDataVersion(
  admin: SupabaseClient,
  params: { id: string; ownerId: string; hash: string; content: DataVersionContent },
): Promise<void> {
  const { error } = await admin.from("dataset_versions").upsert(
    [
      {
        id: params.id,
        owner_id: params.ownerId,
        sources: normalizeSources(params.content.sources),
        price_date: params.content.priceDate,
        calc_version: params.content.calcVersion,
        preprocess_decisions: params.content.decisions,
        hash: params.hash,
      },
    ],
    { onConflict: "owner_id,hash", ignoreDuplicates: true },
  );
  if (error) throw new Error(`dataset_versions 저장 실패: ${error.message}`);
}

export async function loadDataVersion(
  client: SupabaseClient,
  id: string,
): Promise<StoredDataVersion | null> {
  const { data, error } = await client
    .from("dataset_versions")
    .select("id, owner_id, sources, price_date, calc_version, preprocess_decisions, hash")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`dataset_versions 조회 실패: ${error.message}`);
  if (!data) return null;
  const row = data as unknown as DatasetVersionRow;
  return {
    id: row.id,
    ownerId: row.owner_id,
    hash: row.hash,
    sources: row.sources,
    calcVersion: row.calc_version,
    priceDate: row.price_date,
    decisions: row.preprocess_decisions ?? {},
  };
}

interface FetchStateRow {
  corp_code: string;
  bsns_year: number;
  reprt_code: string;
  fs_div_used: string | null;
  rcept_no: string | null;
}

/**
 * 이 출처들 중 지금 DB에 더 새 값이 있는가 — ① 같은 보고서의 접수번호가 바뀌었다(정정 공시 반영),
 * ② 그때 없던(013) 보고서가 이제 있다. 보고서 수집 기록(report_fetch_state)과 비교한다.
 */
export async function isNewerDataAvailable(
  admin: SupabaseClient,
  sources: readonly DataSource[],
): Promise<boolean> {
  if (sources.length === 0) return false;
  const corpCodes = [...new Set(sources.map((s) => s.corpCode))];
  const { data, error } = await admin
    .from("report_fetch_state")
    .select("corp_code, bsns_year, reprt_code, fs_div_used, rcept_no")
    .in("corp_code", corpCodes);
  if (error) throw new Error(`report_fetch_state 조회 실패: ${error.message}`);

  const stateByKey = new Map<string, FetchStateRow>();
  for (const row of (data ?? []) as FetchStateRow[]) {
    stateByKey.set(`${row.corp_code}|${row.bsns_year}|${row.reprt_code}`, row);
  }

  return sources.some((source) => {
    const state = stateByKey.get(`${source.corpCode}|${source.bsnsYear}|${source.reprtCode}`);
    if (!state || state.fs_div_used === null || state.rcept_no === null) return false;
    const collectedRceptNo = source.collected?.rceptNo ?? source.rceptNo;
    return collectedRceptNo !== state.rcept_no;
  });
}

/**
 * 같은 요청 + 같은 데이터 버전으로 이미 끝난 분석의 설명 (TECH §4.10 — 설명은 같은 결과에 한 번만 쓴다).
 * 설명 작성이 실패했던 분석은 재사용하지 않는다.
 */
export async function findReusableExplanation(
  client: SupabaseClient,
  params: {
    ownerId: string;
    dataVersionId: string;
    requestHash: string;
    excludeAnalysisId: string;
  },
): Promise<Explanation | null> {
  const { data, error } = await client
    .from("analyses")
    .select("id, explanation")
    .eq("owner_id", params.ownerId)
    .eq("dataset_version_id", params.dataVersionId)
    .eq("request_hash", params.requestHash)
    .eq("status", "succeeded")
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) throw new Error(`재사용할 분석 조회 실패: ${error.message}`);
  const rows = (data ?? []) as { id: string; explanation: Explanation | null }[];
  // 공시 원문 근거(filingClues, 2026-10-01)가 생기기 전에 쓴 분석 글은 재사용하지 않는다 — 같은 질문을 다시 해도
  // 원문 근거 없는 옛 글이 나오지 않게. 새 코드는 근거가 없어도 빈 배열을 남긴다
  return (
    rows.find(
      (r) =>
        r.id !== params.excludeAnalysisId &&
        r.explanation?.status === "ready" &&
        Array.isArray(r.explanation.filingClues),
    )?.explanation ?? null
  );
}
