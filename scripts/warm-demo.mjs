#!/usr/bin/env node
// Phase 5 시연 데이터 미리 받기 — 시연 질문(DevelopDoc/DEMO_SCRIPT.md §2)에 나오는 기업의 정기보고서·주가를
// **전자공시·주가 API로만** 미리 받아 둔다(AI 0건). 시연 때 첫 조회가 보고서를 받느라 늦지 않게.
//
//   node scripts/warm-demo.mjs                  # DEMO_SCRIPT §2 기업 (SK하이닉스·삼성전자·한미반도체·DB하이텍)
//   node scripts/warm-demo.mjs 000660 105560    # 종목코드를 직접 (경쟁사 확인은 하지 않음)
//   node scripts/warm-demo.mjs --quarters 8     # 받아 둘 분기 수 (기본 12 = 최신 분기부터 3년)
//
// 받는 길은 질문이 쓰는 앱 코드 그대로다(src/lib/runner/warm-demo.ts) — 캐시 우선이라 몇 번 돌려도 같고, 두 번째부터는
// 외부 호출 0건("이미 있음"). .env.local의 Supabase·OpenDART·공공데이터포털 키를 쓰고, **팀 DB(운영과 같은
// Supabase)에 캐시를 채운다** — 질문 한 번이 하는 것과 같은 쓰기다. 시연 전날·30분 전에 한 번씩 (DEMO_SCRIPT §1).
//
// 앱 코드는 TypeScript라 이미 있는 `typescript` 패키지로 그때그때 바꿔 불러온다(새 패키지 없음, `registerTsLoader`).
// scripts/refresh-answers.mjs도 이 로더를 쓴다.
import { existsSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolvePath(import.meta.dirname, "..");

/** `src/**` TypeScript를 바로 불러오는 로더 훅 — "@/…" 별칭, 확장자 없는 상대 경로, server-only 빈 모듈, JSON */
const HOOKS = String.raw`
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

let root;
let redirects = {};
let ts;
export async function initialize(data) {
  root = data.rootUrl; // "file:///…/project_sleepyheads/"
  redirects = data.redirects ?? {};
  ts = createRequire(new URL("package.json", root))("typescript");
}

const isFile = (u) => { const p = fileURLToPath(u); return existsSync(p) && statSync(p).isFile(); };
const isSource = (u) => u.startsWith("file:") && !u.includes("/node_modules/");

export async function resolve(specifier, context, next) {
  if (redirects[specifier]) return { url: redirects[specifier], shortCircuit: true };
  if (specifier === "server-only") return { url: "data:text/javascript,export {};", shortCircuit: true };
  let base = null;
  if (specifier.startsWith("@/")) base = new URL("src/" + specifier.slice(2), root);
  else if (/^\.\.?\//.test(specifier) && context.parentURL && isSource(context.parentURL))
    base = new URL(specifier, context.parentURL);
  if (base) {
    for (const ext of ["", ".ts", ".tsx", "/index.ts"]) {
      const url = new URL(base.href + ext);
      if (isFile(url)) return { url: url.href, shortCircuit: true };
    }
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (isSource(url) && /\.tsx?$/.test(url)) {
    const fileName = fileURLToPath(url);
    const { outputText } = ts.transpileModule(await readFile(fileName, "utf8"), {
      fileName,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
    });
    return { format: "module", source: outputText, shortCircuit: true };
  }
  // TS 파일이 import한 JSON (import 속성 없이) → 기본 내보내기 모듈
  if (isSource(url) && url.endsWith(".json") && context.importAttributes?.type !== "json") {
    return { format: "module", source: "export default " + (await readFile(fileURLToPath(url), "utf8")) + ";", shortCircuit: true };
  }
  return next(url, context);
}
`;

/**
 * `src/**`를 불러올 수 있게 한다. `redirects`는 모듈을 바꿔 끼울 때(이름 → file: URL) — refresh-answers가 공통 호출기
 * 대신 직접 부르는 호출기를 쓴다. 이 함수 뒤의 `import()`부터 적용된다.
 */
export function registerTsLoader(redirects = {}) {
  register(`data:text/javascript,${encodeURIComponent(HOOKS)}`, import.meta.url, {
    data: { rootUrl: pathToFileURL(ROOT + "/").href, redirects },
  });
}

/** .env.local → process.env (이미 있는 값은 그대로). 값은 출력하지 않는다 */
export function loadEnvLocal() {
  const file = join(ROOT, ".env.local");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

/** 한글 폭(2칸)을 맞춘 표 한 줄 */
export function padCell(text, width) {
  const s = String(text);
  const visual = [...s].reduce((n, ch) => n + (/[ᄀ-ￜ]/.test(ch) ? 2 : 1), 0);
  return s + " ".repeat(Math.max(0, width - visual));
}

function parseArgs(argv) {
  const codes = [];
  let quarters;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--quarters") quarters = Number(argv[++i]);
    else if (/^\d{6}$/.test(argv[i])) codes.push(argv[i]);
    else {
      console.error(
        `알 수 없는 인자: ${argv[i]}\n사용법: node scripts/warm-demo.mjs [종목코드…] [--quarters N]`,
      );
      process.exit(2);
    }
  }
  if (quarters !== undefined && !(Number.isInteger(quarters) && quarters >= 1 && quarters <= 40)) {
    console.error("--quarters는 1~40");
    process.exit(2);
  }
  return { codes, quarters };
}

async function main() {
  const { codes, quarters } = parseArgs(process.argv.slice(2));
  loadEnvLocal();
  const missing = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SECRET_KEY",
    "OPENDART_API_KEY",
    "DATA_GO_KR_SERVICE_KEY",
  ].filter((name) => !process.env[name]);
  if (missing.length > 0) {
    console.error(`환경변수가 없습니다: ${missing.join(", ")} (.env.local 확인 — pnpm check:keys)`);
    process.exit(2);
  }

  registerTsLoader();
  const { DEMO_TARGETS, warmDemoData } = await import("../src/lib/runner/warm-demo.ts");
  const { getSupabaseAdmin } = await import("../src/lib/supabase/admin.ts");
  const targets =
    codes.length > 0 ? codes.map((stockCode) => ({ stockCode, name: stockCode })) : DEMO_TARGETS;

  console.log(`시연 데이터 미리 받기 — 기업 ${targets.length}곳 (AI 0건)`);
  const started = Date.now();
  const result = await warmDemoData(targets, { client: getSupabaseAdmin(), quarters });

  console.log(`\n받아 둔 범위: ${result.period.from} ~ ${result.period.to}\n`);
  console.log(
    `${padCell("기업", 14)}${padCell("종목코드", 10)}${padCell("재무", 10)}${padCell("전자공시 호출", 14)}${padCell("종가(기준일)", 26)}${padCell("리포트 호출", 12)}보고서 없음`,
  );
  for (const c of result.companies) {
    const price = c.price
      ? `${Number(c.price.close).toLocaleString("ko-KR")}원 (${c.price.baseDate})`
      : "없음";
    const noReport = c.quartersWithoutReport.length > 0 ? c.quartersWithoutReport.join(", ") : "-";
    console.log(
      `${padCell(c.name, 14)}${padCell(c.stockCode, 10)}${padCell(c.status, 10)}${padCell(c.dartCalls, 14)}${padCell(price, 26)}${padCell(c.reportCalls ?? "-", 12)}${noReport}`,
    );
    if (c.error) console.log(`  └ ${c.error}`);
  }
  console.log(
    `\n주가 기준일 ${result.priceDate ?? "없음"} · 주가 API 호출 ${result.priceCalls}건 · ${((Date.now() - started) / 1000).toFixed(1)}초`,
  );
  if (result.peers) {
    console.log(
      `\n자동 선택 경쟁사 (${result.peers.target}, ${result.peers.order}): ${result.peers.picked.join(", ") || "없음"}`,
    );
    if (!result.peers.same) {
      console.log(
        `⚠️  시연 목록(${result.peers.expected.join(", ")})과 다릅니다 — DevelopDoc/DEMO_SCRIPT.md §2와 src/lib/runner/warm-demo.ts DEMO_TARGETS를 고치고 다시 돌리세요`,
      );
    }
  }

  const failed = result.companies.filter((c) => c.status === "실패").length;
  if (failed > 0 || result.priceDate === null) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error("시연 데이터 미리 받기 실패:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
