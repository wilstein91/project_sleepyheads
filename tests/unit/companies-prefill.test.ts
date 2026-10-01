// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuotaExceededError } from "@/lib/quota/errors";

// Phase 3 후속 "기업개황 미리 채우기" (src/lib/companies/prefill.ts, cron /api/cron/prefill-profiles):
// 개황이 없는 상장사를 하루 한 번 조금씩 채운다 — 회원 몫 OpenDART 한도를 남기고, 한도·시간에 걸리면 멈춘다
const { ensureProfileMock, adminState } = vi.hoisted(() => ({
  ensureProfileMock: vi.fn(),
  adminState: { client: null as unknown },
}));
vi.mock("@/lib/companies/profile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/companies/profile")>()),
  ensureCompanyProfile: ensureProfileMock,
}));
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: () => adminState.client }));

const { prefillCompanyProfiles, PREFILL_BATCH } = await import("@/lib/companies/prefill");
const { CompanyProfileUnavailableError } = await import("@/lib/companies/profile");
const { UpstreamApiError } = await import("@/lib/quota/errors");
const { GET } = await import("@/app/api/cron/prefill-profiles/route");

type Row = Record<string, unknown>;

/**
 * 이 기능이 쓰는 체인만: select→eq/is/or→order→limit→maybeSingle 또는 await (limit은 거른 뒤 자른다),
 * update→eq. `or`는 "col.is.null,col.lt.<값>" 꼴만. `noFailedColumn`이면 profile_failed_at 칸이 없는 DB(42703)
 */
function fakeDb(tables: Record<string, Row[]>, { noFailedColumn = false } = {}) {
  const from = (table: string) => {
    const filters: ((r: Row) => boolean)[] = [];
    let order: string | null = null;
    let limit = Infinity;
    const run = () => {
      let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (order)
        rows = [...rows].sort((a, b) => String(a[order!]).localeCompare(String(b[order!])));
      return rows.slice(0, limit);
    };
    let missingColumn = false;
    const builder = {
      select: () => builder,
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), builder),
      is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), builder),
      or: (expr: string) => {
        if (noFailedColumn && expr.includes("profile_failed_at")) missingColumn = true;
        const parts = expr.split(",").map((p) => p.split("."));
        filters.push((r) =>
          parts.some(([c, op, ...rest]) => {
            const v = rest.join(".");
            if (op === "is") return (r[c] ?? null) === null;
            return r[c] != null && String(r[c]) < v; // lt (ISO 시각 문자열)
          }),
        );
        return builder;
      },
      order: (c: string) => ((order = c), builder),
      limit: (n: number) => ((limit = n), builder),
      update: (patch: Row) => ({
        eq: async (c: string, v: unknown) => {
          for (const r of tables[table] ?? []) if (r[c] === v) Object.assign(r, patch);
          return { error: null };
        },
      }),
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      then: (resolve: (v: { data: Row[] | null; error: unknown }) => void) =>
        resolve(
          missingColumn
            ? { data: null, error: { code: "42703", message: "column does not exist" } }
            : { data: run(), error: null },
        ),
    };
    return builder;
  };
  return { from } as unknown as import("@supabase/supabase-js").SupabaseClient;
}

const NOW = new Date("2026-10-01T18:30:00Z"); // KST 10/2 03:30

function companies(n: number, filledFrom = Infinity): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    corp_code: String(i).padStart(8, "0"),
    profile_checked_at: i >= filledFrom ? "2026-09-30T00:00:00Z" : null,
  }));
}

function db(rows: Row[], usedToday = 0, soft = 16000, options: { noFailedColumn?: boolean } = {}) {
  return fakeDb(
    {
      companies: rows,
      quota_config: [{ key: "dart_global_soft_limit", value: soft }],
      api_usage_daily: usedToday
        ? [{ day_kst: "2026-10-02", provider: "dart", calls: usedToday }]
        : [],
    },
    options,
  );
}

beforeEach(() => {
  ensureProfileMock.mockReset();
  ensureProfileMock.mockResolvedValue({ fromCache: false });
});

describe("prefillCompanyProfiles", () => {
  it("개황이 없는 기업만 채운다 (이미 있는 기업은 건드리지 않음)", async () => {
    const result = await prefillCompanyProfiles({ client: db(companies(5, 3)), now: () => +NOW });
    expect(ensureProfileMock.mock.calls.map((c) => c[0])).toEqual([
      "00000000",
      "00000001",
      "00000002",
    ]);
    expect(result).toMatchObject({ filled: 3, failed: 0, remaining: false, stoppedBy: "done" });
  });

  it("하루에 최대 1,000곳 — 남으면 다음 날 이어서", async () => {
    const result = await prefillCompanyProfiles({
      client: db(companies(PREFILL_BATCH + 5)),
      now: () => +NOW,
    });
    expect(ensureProfileMock).toHaveBeenCalledTimes(PREFILL_BATCH);
    expect(result).toMatchObject({ filled: PREFILL_BATCH, remaining: true, stoppedBy: "batch" });
  });

  it("회원 몫을 남긴다: soft limit 16,000의 1/4(4,000)에서 오늘 쓴 호출을 뺀 만큼만", async () => {
    const result = await prefillCompanyProfiles({
      client: db(companies(50), 3_990),
      now: () => +NOW,
    });
    expect(result.budget).toBe(10);
    expect(ensureProfileMock).toHaveBeenCalledTimes(10);
    expect(result).toMatchObject({ remaining: true, stoppedBy: "quota" });
  });

  it("이미 회원 몫까지 쓴 날은 아무것도 부르지 않는다", async () => {
    const result = await prefillCompanyProfiles({
      client: db(companies(5), 5_000),
      now: () => +NOW,
    });
    expect(ensureProfileMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      filled: 0,
      failed: 0,
      remaining: true,
      stoppedBy: "quota",
      budget: 0,
    });
  });

  it("하루 한도(QuotaExceeded)에 걸리면 더 부르지 않는다, 그 밖의 실패는 건너뛰고 센다", async () => {
    ensureProfileMock
      .mockRejectedValueOnce(new CompanyProfileUnavailableError("00000000", "013", "없음"))
      .mockResolvedValueOnce({ fromCache: false })
      .mockRejectedValueOnce(new QuotaExceededError("dart", "2026-10-03T00:00:00+09:00"));
    const result = await prefillCompanyProfiles({ client: db(companies(20)), now: () => +NOW });
    // 동시 4개라 이미 시작한 것은 끝나지만, 한도 뒤로는 새로 시작하지 않는다
    expect(ensureProfileMock.mock.calls.length).toBeLessThanOrEqual(4 + 3);
    expect(result).toMatchObject({ failed: 1, stoppedBy: "quota", remaining: true });
  });

  it("개황을 못 받은 기업(013 등)은 실패 시각을 남기고 7일 동안 건너뛴다 (Phase 5)", async () => {
    const rows = companies(3);
    ensureProfileMock.mockImplementation(async (corpCode: string) => {
      if (corpCode === "00000001")
        throw new CompanyProfileUnavailableError(corpCode, "013", "없음");
      return { fromCache: false };
    });
    const first = await prefillCompanyProfiles({ client: db(rows), now: () => +NOW });
    // 실패 시각을 남긴 기업은 며칠 건너뛰므로 남은 일로 세지 않는다
    expect(first).toMatchObject({ filled: 2, failed: 1, remaining: false });
    expect(rows[1].profile_failed_at).toBe(NOW.toISOString());
    expect(rows[0].profile_failed_at).toBeUndefined();

    // 성공한 기업은 개황이 채워졌다고 치고, 다음 날·6일 뒤에는 실패한 기업을 부르지 않는다
    rows[0].profile_checked_at = rows[2].profile_checked_at = NOW.toISOString();
    for (const days of [1, 6]) {
      ensureProfileMock.mockClear();
      const later = +NOW + days * 24 * 60 * 60 * 1000;
      const result = await prefillCompanyProfiles({ client: db(rows), now: () => later });
      expect(ensureProfileMock).not.toHaveBeenCalled();
      expect(result).toMatchObject({ filled: 0, failed: 0, remaining: false, stoppedBy: "done" });
    }

    // 7일이 지나면 다시 시도한다
    ensureProfileMock.mockClear();
    const weekLater = +NOW + 7 * 24 * 60 * 60 * 1000 + 1;
    await prefillCompanyProfiles({ client: db(rows), now: () => weekLater });
    expect(ensureProfileMock.mock.calls.map((c) => c[0])).toEqual(["00000001"]);
  });

  it("네트워크 오류처럼 기업 탓이 아닌 실패는 실패 시각을 남기지 않는다 (다음 실행에 다시)", async () => {
    const rows = companies(2);
    ensureProfileMock.mockRejectedValue(new UpstreamApiError("dart", "시간 초과", true));
    const result = await prefillCompanyProfiles({ client: db(rows), now: () => +NOW });
    expect(result).toMatchObject({ filled: 0, failed: 2, remaining: true });
    expect(rows.every((r) => r.profile_failed_at === undefined)).toBe(true);
  });

  it("profile_failed_at 칸이 없으면(마이그레이션 적용 전) 실패 기록 없이 예전처럼 채운다", async () => {
    const rows = companies(3);
    ensureProfileMock.mockRejectedValueOnce(
      new CompanyProfileUnavailableError("00000000", "013", "없음"),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await prefillCompanyProfiles({
      client: db(rows, 0, 16000, { noFailedColumn: true }),
      now: () => +NOW,
    });
    expect(ensureProfileMock).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ filled: 2, failed: 1 });
    expect(rows[0].profile_failed_at).toBeUndefined();
    warn.mockRestore();
  });

  it("240초가 지나면 새 기업을 시작하지 않는다 (maxDuration 300초 안)", async () => {
    let t = +NOW;
    ensureProfileMock.mockImplementation(async () => {
      t += 100_000; // 한 곳에 100초 걸린다고 치면
      return { fromCache: false };
    });
    const result = await prefillCompanyProfiles({ client: db(companies(20)), now: () => t });
    expect(result.stoppedBy).toBe("time");
    expect(result.filled).toBeLessThan(20);
  });
});

describe("GET /api/cron/prefill-profiles", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("CRON_SECRET이 없거나 틀리면 401 — 아무것도 부르지 않는다", async () => {
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    const res = await GET(
      new NextRequest("http://localhost/api/cron/prefill-profiles", {
        headers: { authorization: "Bearer wrong" },
      }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(401);
    expect(ensureProfileMock).not.toHaveBeenCalled();
  });

  it("맞으면 채운 결과를 돌려준다", async () => {
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    adminState.client = db(companies(2));
    const res = await GET(
      new NextRequest("http://localhost/api/cron/prefill-profiles", {
        headers: { authorization: "Bearer test-cron-secret" },
      }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ filled: 2, stoppedBy: "done" });
  });
});
