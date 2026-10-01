// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { beforeAll, describe, expect, it } from "vitest";

// Phase 5 (Phase 4 남긴 리뷰 2건) 마이그레이션을 실제 Postgres(PGlite, 메모리)에서 확인한다.
// - 20261001200000 price_fetch_state: 종목 + 기간 끝으로 "받았다"만 남긴다(0행도), 서버만 읽고 쓴다
// - 20261001200100 companies.profile_failed_at: 기존 기업은 null
// 둘 다 추가만 — 운영처럼 이미 적용된 DB에 다시 적용해도 같다. 운영 DB에서는 시험하지 않는다.

const ROOT = join(__dirname, "../../../supabase");
const PRICE_STATE = "20261001200000_p5_price_fetch_state.sql";
const PROFILE_FAILED = "20261001200100_p5_company_profile_failed.sql";

let db: PGlite;

beforeAll(async () => {
  db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable
      as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  `);
  const dir = join(ROOT, "migrations");
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    await db.exec(readFileSync(join(dir, file), "utf8"));
  }
  await db.exec(readFileSync(join(ROOT, "seed.sql"), "utf8"));
  // Supabase 기본 권한 흉내 — 막는 것은 RLS여야 한다
  await db.exec(`
    grant usage on schema public to anon, authenticated;
    grant select, insert, update, delete on all tables in schema public to anon, authenticated;
  `);
}, 60_000);

describe("price_fetch_state (Phase 5)", () => {
  it("받았지만 가격이 없는 종목도(0행) 기록하고, 같은 종목·기간 끝은 한 행으로 덮어쓴다", async () => {
    await db.exec(`
      insert into price_fetch_state (stock_code, range_to, range_from, row_count, fetched_at)
      values ('000000', '2026-10-01', '2026-09-17', 0, '2026-10-01T03:00:00Z')
      on conflict (stock_code, range_to) do update
        set row_count = excluded.row_count, fetched_at = excluded.fetched_at;
      insert into price_fetch_state (stock_code, range_to, range_from, row_count, fetched_at)
      values ('000000', '2026-10-01', '2026-09-17', 0, '2026-10-01T05:00:00Z')
      on conflict (stock_code, range_to) do update
        set row_count = excluded.row_count, fetched_at = excluded.fetched_at;
    `);
    const { rows } = await db.query<{ row_count: number; fetched_at: Date }>(
      "select row_count, fetched_at from price_fetch_state where stock_code = '000000'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].row_count).toBe(0);
    expect(rows[0].fetched_at.toISOString()).toBe("2026-10-01T05:00:00.000Z");
  });

  it("행 수는 음수가 될 수 없다", async () => {
    await expect(
      db.exec(
        "insert into price_fetch_state (stock_code, range_to, range_from, row_count) values ('1', '2026-10-01', '2026-09-17', -1)",
      ),
    ).rejects.toThrow();
  });

  it("회원·비로그인은 읽지도 쓰지도 못한다 (RLS, 정책 없음 = 서버만)", async () => {
    for (const role of ["anon", "authenticated"]) {
      const rows = await db.transaction(async (tx) => {
        await tx.exec(`set local role ${role}`);
        return (await tx.query("select * from price_fetch_state")).rows;
      });
      expect(rows, role).toEqual([]);
      await expect(
        db.transaction(async (tx) => {
          await tx.exec(`set local role ${role}`);
          await tx.exec(
            "insert into price_fetch_state (stock_code, range_to, range_from) values ('2', '2026-10-01', '2026-09-17')",
          );
        }),
        role,
      ).rejects.toThrow(/row-level security/);
    }
  });
});

describe("companies.profile_failed_at (Phase 5)", () => {
  it("칸이 생기고 기존 기업은 null", async () => {
    await db.exec(
      "insert into companies (corp_code, stock_code, corp_name) values ('99999990', '999990', '가상기업')",
    );
    const { rows } = await db.query<{ profile_failed_at: Date | null }>(
      "select profile_failed_at from companies where corp_code = '99999990'",
    );
    expect(rows[0].profile_failed_at).toBeNull();
  });
});

describe("다시 적용해도 같다 (추가만)", () => {
  it("두 마이그레이션을 한 번 더 적용해도 오류 없이 데이터가 그대로다", async () => {
    await db.exec("update companies set profile_failed_at = now() where corp_code = '99999990'");
    for (const file of [PRICE_STATE, PROFILE_FAILED]) {
      await db.exec(readFileSync(join(ROOT, "migrations", file), "utf8"));
    }
    const state = await db.query<{ n: number }>(
      "select count(*)::int n from price_fetch_state where stock_code = '000000'",
    );
    expect(state.rows[0].n).toBe(1);
    const company = await db.query<{ profile_failed_at: Date | null }>(
      "select profile_failed_at from companies where corp_code = '99999990'",
    );
    expect(company.rows[0].profile_failed_at).not.toBeNull();
  });
});

describe("투자 리포트 캐시 3개 (20261001210000)", () => {
  const REPORT = "20261001210000_report_caches.sql";

  it("1년 시세·보고서별 계정·최대주주/배당을 jsonb로 담고, 같은 키는 한 행", async () => {
    await db.exec(`
      insert into companies (corp_code, stock_code, corp_name) values ('99999980', '999980', '리포트기업')
        on conflict do nothing;
      insert into stock_price_history (stock_code, days) values ('999980', '[{"date":"2026-09-30","close":1000}]')
        on conflict (stock_code) do update set days = excluded.days;
      insert into report_extras (corp_code, bsns_year, reprt_code, fs_div, rcept_no, values)
        values ('99999980', 2025, '11011', 'CFS', 'r1', '{"revenue":"100","eps":"62044"}');
      insert into report_extras (corp_code, bsns_year, reprt_code, fs_div, rcept_no, values)
        values ('99999980', 2026, '11014', null, null, '{}');
      insert into company_facts (corp_code, kind, bsns_year, reprt_code, data)
        values ('99999980', 'shareholder', 2026, '11012', '{"name":"A","ratio":20.5}');
    `);
    const { rows } = await db.query<{ v: string }>(
      "select values->>'eps' v from report_extras where corp_code = '99999980' and bsns_year = 2025",
    );
    expect(rows[0].v).toBe("62044");
    await expect(
      db.exec(
        "insert into company_facts (corp_code, kind, bsns_year, reprt_code) values ('99999980', 'unknown', 2026, '11012')",
      ),
    ).rejects.toThrow();
  });

  it("회원·비로그인은 읽지 못한다 (서버만)", async () => {
    for (const table of ["stock_price_history", "report_extras", "company_facts"]) {
      const rows = await db.transaction(async (tx) => {
        await tx.exec("set local role anon");
        return (await tx.query(`select * from ${table}`)).rows;
      });
      expect(rows, table).toEqual([]);
    }
  });

  it("다시 적용해도 같다", async () => {
    await db.exec(readFileSync(join(ROOT, "migrations", REPORT), "utf8"));
    const { rows } = await db.query<{ n: number }>(
      "select count(*)::int n from report_extras where corp_code = '99999980'",
    );
    expect(rows[0].n).toBe(2);
  });
});
