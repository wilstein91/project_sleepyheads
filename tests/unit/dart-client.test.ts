import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dartFetch, dartFetchBinary } from "@/lib/dart/client";
import { DartApiError } from "@/lib/dart/errors";
import { QuotaExceededError, UpstreamApiError } from "@/lib/quota/errors";
import samsungFinancials from "../fixtures/dart/financials/00126380_samsung_2024_11011_CFS.json";
import { createFakeSupabase } from "./helpers/fake-supabase";

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as Response;
}

describe("dartFetch (WU-102 공통 호출기)", () => {
  beforeEach(() => {
    vi.stubEnv("OPENDART_API_KEY", "test-crtfc-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("오늘 이미 020으로 차단됐으면 외부 호출·사용량 확인 없이 QuotaExceededError를 던진다", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    const { client, rpcCalls } = createFakeSupabase({ blockedAt: new Date().toISOString() });

    await expect(
      dartFetch("company.json", { corp_code: "00126380" }, { client }),
    ).rejects.toBeInstanceOf(QuotaExceededError);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(rpcCalls).toHaveLength(0);
  });

  it("회원/전체 상한을 넘으면(RPC allowed=false) 외부 호출 없이 QuotaExceededError를 던진다", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    const { client } = createFakeSupabase({ rpcAllowed: false });

    await expect(
      dartFetch("company.json", { corp_code: "00126380" }, { client }),
    ).rejects.toBeInstanceOf(QuotaExceededError);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("정상 응답(000)이면 그대로 돌려주고 호출은 정확히 1회만 기록한다", async () => {
    const body = { status: "000", message: "정상", corp_code: "00126380", corp_name: "삼성전자" };
    vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse(body));
    const { client, rpcCalls } = createFakeSupabase();

    const result = await dartFetch(
      "company.json",
      { corp_code: "00126380" },
      { client, userId: "u1" },
    );

    expect(result).toEqual(body);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]).toMatchObject({
      fn: "check_and_record_api_usage",
      args: { p_provider: "dart", p_user_id: "u1", p_calls: 1 },
    });
  });

  it("013(데이터 없음)은 오류가 아니라 그대로 돌려준다", async () => {
    const body = { status: "013", message: "조회된 데이터가 없습니다." };
    vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse(body));
    const { client } = createFakeSupabase();

    await expect(dartFetch("list.json", {}, { client })).resolves.toEqual(body);
  });

  it("실제 fixture(삼성전자 재무제표) 형태도 그대로 파싱해 돌려준다", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse(samsungFinancials));
    const { client } = createFakeSupabase();

    const result = await dartFetch<{ status: string; message: string; list: unknown[] }>(
      "fnlttSinglAcntAll.json",
      { corp_code: "00126380", bsns_year: 2024, reprt_code: "11011", fs_div: "CFS" },
      { client },
    );

    expect(result.status).toBe("000");
    expect(Array.isArray(result.list)).toBe(true);
    expect(result.list.length).toBeGreaterThan(0);
  });

  it("020(요청 제한 초과)을 받으면 차단을 기록하고 오류를 던진다", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({ status: "020", message: "요청 제한을 초과하였습니다." }),
    );
    const { client, upsertCalls } = createFakeSupabase();

    await expect(dartFetch("list.json", {}, { client })).rejects.toThrow(/요청 제한/);

    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].row).toMatchObject({ provider: "dart" });
  });

  it("020은 재시도하지 않는다(오류코드는 retryable=false)", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(jsonResponse({ status: "020", message: "요청 제한을 초과하였습니다." }));
    const { client } = createFakeSupabase();

    await expect(dartFetch("list.json", {}, { client })).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("네트워크 오류는 재시도 후 성공하면 결과를 돌려준다", async () => {
    const body = { status: "000", message: "정상" };
    let attempts = 0;
    vi.spyOn(global, "fetch").mockImplementation(async () => {
      attempts += 1;
      if (attempts < 2) throw new Error("network down");
      return jsonResponse(body);
    });
    const { client } = createFakeSupabase();

    await expect(dartFetch("list.json", {}, { client })).resolves.toEqual(body);
    expect(attempts).toBe(2);
  });

  it("네트워크 오류가 재시도 상한을 넘으면 UpstreamApiError로 실패한다", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("network down"));
    const { client } = createFakeSupabase();

    await expect(dartFetch("list.json", {}, { client })).rejects.toBeInstanceOf(UpstreamApiError);
  });

  it("동시 호출은 5개를 넘지 않는다", async () => {
    let active = 0;
    let maxActive = 0;
    vi.spyOn(global, "fetch").mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return jsonResponse({ status: "000", message: "정상" });
    });
    const { client } = createFakeSupabase();

    await Promise.all(
      Array.from({ length: 10 }, (_, i) => dartFetch("list.json", { page: i }, { client })),
    );

    expect(maxActive).toBeLessThanOrEqual(5);
  });

  it("API 키가 없으면 외부 호출 전에 오류를 던진다", async () => {
    vi.unstubAllEnvs();
    const fetchSpy = vi.spyOn(global, "fetch");
    const { client } = createFakeSupabase();

    await expect(dartFetch("company.json", {}, { client })).rejects.toThrow(/OPENDART_API_KEY/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("dartFetchBinary (WU-103 — corpCode.xml 등 ZIP 응답용)", () => {
  beforeEach(() => {
    vi.stubEnv("OPENDART_API_KEY", "test-crtfc-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("ZIP 바이트를 그대로 돌려준다", async () => {
    const bytes = new TextEncoder().encode("fake-zip-bytes").buffer;
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "application/zip" },
      arrayBuffer: async () => bytes,
    } as unknown as Response);
    const { client, rpcCalls } = createFakeSupabase();

    const result = await dartFetchBinary("corpCode.xml", {}, { client });

    expect(result).toBe(bytes);
    expect(rpcCalls).toHaveLength(1);
  });

  it("오류일 때는 ZIP 대신 오는 JSON({status,message})을 DartApiError로 던진다", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "application/json;charset=UTF-8" },
      json: async () => ({ status: "010", message: "등록되지 않은 키입니다." }),
    } as unknown as Response);
    const { client } = createFakeSupabase();

    await expect(dartFetchBinary("corpCode.xml", {}, { client })).rejects.toBeInstanceOf(
      DartApiError,
    );
  });

  it("공시서류원본(document.xml)의 XML 오류(<status>013</status>)도 DartApiError로 던진다", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "application/xml;charset=UTF-8" },
      text: async () =>
        '<?xml version="1.0" encoding="UTF-8"?><result><status>013</status><message>접수번호 오류</message></result>',
    } as unknown as Response);
    const { client } = createFakeSupabase();

    await expect(
      dartFetchBinary("document.xml", { rcept_no: "1" }, { client }),
    ).rejects.toMatchObject({ status: "013", message: "접수번호 오류" });
  });

  it("정상 원문 ZIP(application/x-msdownload)은 XML 오류로 보지 않는다", async () => {
    const bytes = new TextEncoder().encode("zip").buffer;
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "application/x-msdownload;charset=UTF-8" },
      arrayBuffer: async () => bytes,
    } as unknown as Response);
    const { client } = createFakeSupabase();

    await expect(dartFetchBinary("document.xml", { rcept_no: "1" }, { client })).resolves.toBe(
      bytes,
    );
  });

  it("오늘 이미 020으로 차단됐으면 외부 호출 없이 QuotaExceededError", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    const { client } = createFakeSupabase({ blockedAt: new Date().toISOString() });

    await expect(dartFetchBinary("corpCode.xml", {}, { client })).rejects.toBeInstanceOf(
      QuotaExceededError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
