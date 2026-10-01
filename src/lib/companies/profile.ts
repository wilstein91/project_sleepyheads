import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { dartFetch, type DartEnvelope, type DartFetchOptions } from "@/lib/dart/client";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { classifySector } from "./classify-sector";

// TECH §3.1: 기업개황은 "첫 조회 시, 이후 30일마다"만 다시 부른다.
const PROFILE_REFRESH_DAYS = 30;
const PROFILE_REFRESH_MS = PROFILE_REFRESH_DAYS * 24 * 60 * 60 * 1000;

const MARKET_BY_CORP_CLS: Record<string, "KOSPI" | "KOSDAQ"> = { Y: "KOSPI", K: "KOSDAQ" };

interface DartCompanyProfile extends DartEnvelope {
  corp_code: string;
  corp_name: string;
  /** "SK하이닉스"처럼 실제로 통용되는 이름. corp_name은 "에스케이하이닉스(주)"같은 정식 등기명이다. */
  stock_name?: string;
  corp_cls?: string; // Y=코스피 K=코스닥 N=코넥스 E=기타
  induty_code?: string;
  acc_mt?: string; // "12"
}

/**
 * OpenDART가 그 기업의 개황을 주지 않았다(013 등 정상이 아닌 상태) — 폐지된 기업처럼 다시 해도 같을 가능성이 크다.
 * 네트워크·한도 오류(`UpstreamApiError`·`QuotaExceededError`)와 구분해 prefill이 며칠 건너뛰는 근거로 쓴다.
 */
export class CompanyProfileUnavailableError extends Error {
  constructor(
    readonly corpCode: string,
    readonly status: string,
    detail: string,
  ) {
    super(`기업개황 조회 실패 (${corpCode}): ${status} ${detail}`);
    this.name = "CompanyProfileUnavailableError";
  }
}

export interface CompanyProfileOptions extends DartFetchOptions {
  /** 테스트에서 가짜 Supabase 클라이언트를 주입할 때만 쓴다. */
  client?: SupabaseClient;
}

export interface CompanyProfileFields {
  corpName: string;
  market: "KOSPI" | "KOSDAQ" | null;
  indutyCode: string | null;
  accMt: number | null;
  sectorId: string;
  sectorSource: "manual" | "induty_code" | "other";
}

export interface CompanyProfileResult {
  corpCode: string;
  /** true면 30일 캐시 안이라 company.json을 부르지 않고 끝냈다는 뜻. */
  fromCache: boolean;
  /** fromCache가 false일 때만 채워진다 — 이번에 새로 반영한 값. */
  profile?: CompanyProfileFields;
}

/**
 * 기업개황 조회·반영 (WU-104, TECH §3.1·§8). `companies`에 이미 있는 기업만 대상으로 한다
 * (WU-103 동기화가 먼저 있어야 한다). 30일 안에 이미 조회했으면 `company.json`을 다시 부르지
 * 않는다(완료조건). 결산월·업종코드·시장구분을 반영하고, 섹터를 분류해 저장한다.
 */
export async function ensureCompanyProfile(
  corpCode: string,
  options: CompanyProfileOptions = {},
): Promise<CompanyProfileResult> {
  const admin = options.client ?? getSupabaseAdmin();

  const { data: existing, error: readError } = await admin
    .from("companies")
    .select("profile_checked_at")
    .eq("corp_code", corpCode)
    .maybeSingle();
  if (readError) throw new Error(`기업 조회 실패: ${readError.message}`);
  if (!existing) {
    throw new Error(`companies에 없는 기업입니다: ${corpCode} (WU-103 동기화가 먼저 필요합니다)`);
  }

  const profileCheckedAt = (existing as { profile_checked_at: string | null }).profile_checked_at;
  if (isFresh(profileCheckedAt)) {
    return { corpCode, fromCache: true };
  }

  const dartProfile = await dartFetch<DartCompanyProfile>(
    "company.json",
    { corp_code: corpCode },
    options,
  );
  if (dartProfile.status !== "000") {
    throw new CompanyProfileUnavailableError(corpCode, dartProfile.status, dartProfile.message);
  }

  const market = dartProfile.corp_cls ? (MARKET_BY_CORP_CLS[dartProfile.corp_cls] ?? null) : null;
  const accMt = dartProfile.acc_mt ? Number.parseInt(dartProfile.acc_mt, 10) : null;
  const indutyCode = dartProfile.induty_code?.trim() || null;
  const corpName = dartProfile.stock_name?.trim() || dartProfile.corp_name;

  const { sectorId, sectorSource } = await classifySector(admin, corpCode, indutyCode);

  const now = new Date().toISOString();
  const { error: writeError } = await admin
    .from("companies")
    .update({
      corp_name: corpName,
      market,
      induty_code: indutyCode,
      acc_mt: accMt,
      sector_id: sectorId,
      sector_source: sectorSource,
      profile_checked_at: now,
      updated_at: now,
    })
    .eq("corp_code", corpCode);
  if (writeError) throw new Error(`기업개황 반영 실패: ${writeError.message}`);

  return {
    corpCode,
    fromCache: false,
    profile: { corpName, market, indutyCode, accMt, sectorId, sectorSource },
  };
}

function isFresh(profileCheckedAt: string | null): boolean {
  if (!profileCheckedAt) return false;
  return Date.now() - new Date(profileCheckedAt).getTime() < PROFILE_REFRESH_MS;
}
