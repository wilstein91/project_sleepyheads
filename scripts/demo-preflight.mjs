#!/usr/bin/env node
// 시연 전 점검 (Phase 5, README §9.1) — **읽기만** 한다. 한 번 돌리면 항목마다 ✅/⚠️.
//
//   node scripts/demo-preflight.mjs                    # 배포 주소 + (키가 있으면) 운영 DB 읽기
//   node scripts/demo-preflight.mjs --keys             # + pnpm check:keys (키마다 실제 호출 1회 — AI 토큰을 조금 쓴다)
//   node scripts/demo-preflight.mjs --url https://…    # 다른 배포 주소
//
// 운영 DB 항목은 .env.local(또는 환경변수)의 NEXT_PUBLIC_SUPABASE_URL·SUPABASE_SECRET_KEY로 **select만** 한다.
// 키 값은 출력하지 않는다. ⚠️가 하나라도 있으면 종료 코드 1.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const SITE = option("--url") ?? "https://projectsleepyheads.vercel.app";
if (!/^https?:\/\//.test(SITE)) {
  console.error("사용법: node scripts/demo-preflight.mjs [--keys] [--url https://배포주소]");
  process.exit(2);
}

// 판정 기준 (README §9.1)
const LIMITS = {
  /** 기업 목록 동기화(매일 03시 KST, ±59분)가 이보다 오래 안 돌았으면 ⚠️ */
  syncMaxHours: 30,
  /**
   * 동기화가 돌았다고 볼 최소 갱신 기업 수 (상장사 약 4,000곳을 한 번에 upsert). 기업개황 미리 채우기 cron도 하루 최대
   * 1,000곳(PREFILL_BATCH)의 updated_at을 바꾸므로 그보다 크게 — 동기화가 멈춰도 미리 채우기만으로 ✅가 되지 않게 (Phase 5 통합)
   */
  syncMinCompanies: 2_000,
  /** 오늘 AI 비용이 이보다 크면 ⚠️ (키 3개 각 약 5천 원 — 하루 $1이면 며칠 못 간다) */
  llmDailyWarnUsd: 1,
  /** OpenDART 하루 한도 20,000회의 80% */
  dartDailyWarnCalls: 16_000,
  /** 1시간 넘게 진행 없는 분석 (WU-501 정리 규칙과 같은 기준) */
  idleRunMinutes: 60,
};

const SERVER_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
  "OPENDART_API_KEY",
  "DATA_GO_KR_SERVICE_KEY",
  "OPENAI_API_KEY",
  "CRON_SECRET",
];

function readEnv() {
  const path = join(ROOT, ".env.local");
  const file = existsSync(path)
    ? Object.fromEntries(
        readFileSync(path, "utf8")
          .split(/\r?\n/)
          .filter((l) => l.trim() && !l.trim().startsWith("#") && l.includes("="))
          .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
      )
    : {};
  return { ...file, ...process.env };
}

const results = [];
/** ok: true ✅ / false ⚠️ / null — (확인 못 함, 실패로 보지 않음) */
const report = (group, name, ok, detail) => results.push({ group, name, ok, detail });

const hoursSince = (iso, now) => (now - Date.parse(iso)) / 3_600_000;
const kstDay = (date) => new Date(date.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);

// ── 1) 배포 주소 ──
async function checkSite() {
  try {
    const res = await fetch(SITE, { redirect: "follow" });
    report("배포", "첫 화면", res.status === 200, `HTTP ${res.status} (${SITE})`);
  } catch (err) {
    report("배포", "첫 화면", false, `연결 실패: ${err.message}`);
  }
  try {
    const res = await fetch(new URL("/api/guest/example", SITE));
    const body = await res.json().catch(() => null);
    const has = res.status === 200 && body?.data;
    report(
      "배포",
      "비로그인 예시 (G1)",
      Boolean(has),
      has ? "예시 있음" : `HTTP ${res.status} — README §9.4로 다시 만들기`,
    );
  } catch (err) {
    report("배포", "비로그인 예시 (G1)", false, `연결 실패: ${err.message}`);
  }
}

// ── 2) 키 ──
function checkKeys(env) {
  const missing = SERVER_KEYS.filter((k) => !env[k]);
  report(
    "키",
    "이 PC의 키 (.env.local·환경변수)",
    missing.length === 0 ? true : null,
    missing.length === 0
      ? `${SERVER_KEYS.length}개 모두 있음 (값은 출력하지 않음)`
      : `없음: ${missing.join(", ")} — 운영 키는 Vercel에 있다. 이 PC에서 확인하려면 .env.local`,
  );
  if (!flag("--keys")) return;
  try {
    const out = execFileSync("node", ["scripts/check-keys.mjs", ".env.local"], { cwd: ROOT });
    const text = out.toString("utf8");
    const bad = text.split("\n").filter((l) => l.startsWith("❌"));
    report("키", "pnpm check:keys (실제 호출)", bad.length === 0, bad.join(" / ") || "모두 ✅");
  } catch (err) {
    report(
      "키",
      "pnpm check:keys (실제 호출)",
      false,
      `실패: ${String(err.message).split("\n")[0]}`,
    );
  }
}

// ── 3) 운영 DB (읽기만) ──
async function checkDb(env, now = new Date()) {
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
    report("운영 DB", "읽기 조회", null, "Supabase 주소·서버 키가 이 PC에 없어 건너뜀");
    return;
  }
  const { createClient } = await import("@supabase/supabase-js");
  const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false },
  });
  const today = kstDay(now);

  // 오늘 사용량
  const { data: usage, error: usageError } = await db
    .from("api_usage_daily")
    .select("provider, calls, cost_usd")
    .eq("day_kst", today);
  if (usageError) {
    report("운영 DB", "오늘 사용량", false, usageError.message);
  } else {
    // 그 날 기록이 없으면 0, 기록이 있는데 칸이 비면(표 모양이 바뀜) 확인 못 함으로
    const of = (p) => usage.find((u) => u.provider === p) ?? { calls: 0, cost_usd: 0 };
    const shapeOk = usage.every((u) => typeof u.calls === "number" && u.cost_usd !== undefined);
    if (!shapeOk) {
      report(
        "운영 DB",
        "오늘 사용량",
        false,
        "api_usage_daily 칸 모양이 예상과 다름 — 스크립트 확인",
      );
    }
    const llm = of("llm");
    const dart = of("dart");
    const price = of("price");
    const cost = Number(llm.cost_usd) || 0;
    report(
      "운영 DB",
      "오늘 AI 비용",
      cost <= LIMITS.llmDailyWarnUsd,
      `${llm.calls}회 $${cost.toFixed(3)} (⚠️ 기준 $${LIMITS.llmDailyWarnUsd})`,
    );
    report(
      "운영 DB",
      "오늘 전자공시·주가 호출",
      dart.calls <= LIMITS.dartDailyWarnCalls,
      `전자공시 ${dart.calls}회 · 주가 ${price.calls}회 (전자공시 하루 한도 20,000)`,
    );
  }

  // 오래 멈춘 분석 (WU-501)
  const before = new Date(now.getTime() - LIMITS.idleRunMinutes * 60_000).toISOString();
  const { count: idle, error: idleError } = await db
    .from("analyses")
    .select("id", { count: "exact", head: true })
    .in("status", ["queued", "running"])
    .lt("updated_at", before);
  report(
    "운영 DB",
    "1시간 넘게 멈춘 분석",
    idleError ? false : idle === 0,
    idleError
      ? idleError.message
      : `${idle}건${idle ? " — 그 회원이 다음에 질문하면 정리된다(WU-501). 시연 계정이면 시연 전에 질문 1건" : ""}`,
  );

  // 크론이 남긴 흔적
  const latest = async (table, column, filter) => {
    let q = db.from(table).select(column).order(column, { ascending: false }).limit(1);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw error;
    return data?.[0]?.[column] ?? null;
  };
  try {
    // 질문 때 기업개황을 채우면서도 updated_at이 바뀌므로, 마지막 시각 대신 "최근 30시간에 바뀐 기업 수"로 본다 —
    // 동기화는 상장사 전체(약 4,000곳)를 한 번에 갱신한다
    const since = new Date(now.getTime() - LIMITS.syncMaxHours * 3_600_000).toISOString();
    const { count, error } = await db
      .from("companies")
      .select("corp_code", { count: "exact", head: true })
      .gte("updated_at", since);
    if (error) throw error;
    report(
      "크론",
      "기업 목록 동기화 (sync-companies, 매일 03시 KST)",
      (count ?? 0) >= LIMITS.syncMinCompanies,
      `최근 ${LIMITS.syncMaxHours}시간에 갱신된 기업 ${count ?? 0}곳 (동기화가 돌았으면 ${LIMITS.syncMinCompanies.toLocaleString("ko-KR")}곳 이상)`,
    );
  } catch (err) {
    report("크론", "기업 목록 동기화", false, err.message);
  }
  try {
    const prefill = await latest("companies", "profile_checked_at", (q) =>
      q.not("profile_checked_at", "is", null),
    );
    const { count } = await db
      .from("companies")
      .select("corp_code", { count: "exact", head: true })
      .not("profile_checked_at", "is", null);
    const h = prefill ? hoursSince(prefill, now) : Infinity;
    report(
      "크론",
      "기업개황 채움 흔적 (prefill-profiles 크론 + 질문 때 채운 것)",
      h <= LIMITS.syncMaxHours ? true : null,
      prefill
        ? `채워진 기업 ${count ?? "?"}곳, 마지막 ${prefill} (${h.toFixed(1)}시간 전) — 질문 때 채운 것도 섞여 있어 크론이 돌았는지는 Vercel Cron 로그로${h > LIMITS.syncMaxHours ? " (하루 넘게 새로 채운 곳 없음)" : ""}`
        : "아직 없음",
    );
  } catch (err) {
    report("크론", "기업개황 미리 채우기", false, err.message);
  }
  try {
    const guest = await latest("guest_examples", "generated_at");
    // 새 정기보고서가 나왔을 때만 다시 만들어서, 오래됐다고 실패는 아니다 (README §9.4)
    report(
      "크론",
      "비로그인 예시 (refresh-guest-example, 새 보고서가 있을 때만)",
      guest ? true : false,
      guest ? `마지막 생성 ${guest}` : "예시 없음 — README §9.4",
    );
  } catch (err) {
    report("크론", "비로그인 예시", false, err.message);
  }
}

const env = readEnv();
await checkSite();
checkKeys(env);
await checkDb(env).catch((err) => report("운영 DB", "읽기 조회", false, err.message));

let group = "";
for (const r of results) {
  if (r.group !== group) {
    group = r.group;
    console.log(`\n[${group}]`);
  }
  const mark = r.ok === true ? "✅" : r.ok === false ? "⚠️" : "—";
  console.log(`${mark} ${r.name}: ${r.detail}`);
}
const warnings = results.filter((r) => r.ok === false).length;
const unchecked = results.filter((r) => r.ok === null).length;
if (warnings) console.log(`\n⚠️ ${warnings}개 확인 필요`);
else if (unchecked) {
  console.log(
    `\n— 확인하지 못한 항목 ${unchecked}개 — 운영 키가 있는 PC(.env.local)에서 다시 돌려야 시연 준비를 판정할 수 있다`,
  );
} else console.log("\n✅ 시연 준비 됨");
process.exit(warnings ? 1 : 0);
