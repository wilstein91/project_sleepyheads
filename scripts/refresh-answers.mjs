#!/usr/bin/env node
// 회귀 숫자 정답 다시 구하기 (Phase 5) — tests/regression/answers/*.json의 원문 값(전자공시 보고서)·주가를 **지금 다시 받아**
// 실제 엔진으로 계산하고, 지금 정답과 다른 곳만 표로 보여 준다. **파일은 고치지 않는다** — 바꿀지는 사람이 정한다.
//
//   node scripts/refresh-answers.mjs                 # 정답 그대로 다시 계산 → 다른 곳만 (정정 공시·계산식 변화 확인)
//   node scripts/refresh-answers.mjs --to 2026Q3     # 최신 분기(2026Q2)로 끝나는 정답을 2026Q3로 옮겨 새 정답 후보 계산
//   node scripts/refresh-answers.mjs --to 2026Q3 --json > new-answers.json   # 새 정답 후보를 JSON으로 (붙여 넣기용)
//   node scripts/refresh-answers.mjs --today         # 주가 정답을 정답의 기준 시각 대신 지금 시각으로
//
// - 받는 길: 전자공시·주가 API를 **직접** 부른다(공통 호출기 그대로, 사용량 기록만 뺌). 받은 값은 메모리 DB에만 두고
//   **팀 DB(Supabase)는 읽지도 쓰지도 않는다** — 캐시를 거치지 않아야 "지금 원문"과 비교가 된다. AI 0건.
// - 계산: 상세 정답(question·figures)은 실행기 `runAnalysis` 그대로(tests/accuracy/regression-answers.test.ts와 같은 요청),
//   한 줄 정답(company·metric·period)은 회귀 엔진 `valueFromFinancials`(tests/regression/engine.ts). 'synthetic'은 건너뛴다.
// - 전자공시 호출은 정답 전체에 약 40~80건(하루 한도 20,000건 중) — 우리 사용량 집계(api_usage_daily)에는 안 잡힌다.
// 사용법·11/15 이후 새 정답 만드는 순서: tests/accuracy/ANSWER_KEY.md 끝 "정답 다시 구하기".
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { loadEnvLocal, padCell, registerTsLoader } from "./warm-demo.mjs";

const ROOT = resolvePath(import.meta.dirname, "..");
const ANSWERS_DIR = join(ROOT, "tests/regression/answers");
/** 정답을 만든 때의 최신 분기 (2026-10-01, 3분기보고서 기한 11/14 전) — `--to`는 이 분기로 끝나는 정답을 옮긴다 */
const ANSWERS_LATEST = "2026Q2";

const dataUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
/** 바꿔 끼우는 모듈 — 팀 DB를 절대 건드리지 않게 관리자 클라이언트는 막고, 사용량 기록은 하지 않는다 */
const REDIRECTS = {
  "@/lib/supabase/admin": dataUrl(
    `export function getSupabaseAdmin() { throw new Error("refresh-answers는 팀 DB를 쓰지 않습니다 — 메모리 DB를 넘겨야 합니다"); }`,
  ),
  "@/lib/quota/api-usage": dataUrl(
    `export async function checkAndRecordApiUsage() {} export async function recordApiUsageDetails() {}`,
  ),
  // 테스트용 가짜 DB(tests/unit/helpers/fake-financials-db.ts)가 vi.fn만 쓴다
  vitest: dataUrl(`export const vi = { fn: (impl) => impl ?? (() => undefined) };`),
};

function parseArgs(argv) {
  const args = { to: null, today: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--to") args.to = argv[++i];
    else if (argv[i] === "--today") args.today = true;
    else if (argv[i] === "--json") args.json = true;
    else {
      console.error(
        `알 수 없는 인자: ${argv[i]}\n사용법: node scripts/refresh-answers.mjs [--to 2026Q3] [--today] [--json]`,
      );
      process.exit(2);
    }
  }
  if (args.to !== null && !/^\d{4}Q[1-4]$/.test(args.to)) {
    console.error("--to는 2026Q3 꼴");
    process.exit(2);
  }
  return args;
}

const log = (...xs) => console.error(...xs); // 진행 상황은 stderr — --json일 때 stdout은 JSON만

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnvLocal();
  const missing = ["OPENDART_API_KEY", "DATA_GO_KR_SERVICE_KEY"].filter((n) => !process.env[n]);
  if (missing.length > 0) {
    console.error(`환경변수가 없습니다: ${missing.join(", ")} (.env.local 확인 — pnpm check:keys)`);
    process.exit(2);
  }

  registerTsLoader(REDIRECTS);
  const { runAnalysis } = await import("../src/lib/runner/execute.ts");
  const { ensureCompanyFinancials } = await import("../src/lib/runner/company-financials.ts");
  const { loadPrices } = await import("../src/lib/price/daily.ts");
  const { addQuarters, compareQuarters } = await import("../src/lib/ask/quarter.ts");
  const { FIXTURES, valueFromFinancials } = await import("../tests/regression/engine.ts");
  const { createFakeFinancialsDb } = await import("../tests/unit/helpers/fake-financials-db.ts");
  const { ACCOUNT_MAP_SEED_ROWS } = await import("../tests/fixtures/mock/account-map.ts");

  // 정답에 나오는 기업 — 원문 fixture의 기업 정보(종목코드·결산월·금융업)를 쓴다
  const fixtures = Object.entries(FIXTURES).map(([key, f]) => ({ key, ...f }));
  const refOf = (f) => ({
    corpCode: f.corp_code,
    stockCode: f.stock_code,
    name: f.corp_name,
    market: f.market,
    sector: {
      name: f.is_financial ? "금융지주" : "기타",
      source: "manual",
      isFinancial: f.is_financial,
    },
    fiscalMonth: f.acc_mt,
  });
  const db = createFakeFinancialsDb({
    account_map: ACCOUNT_MAP_SEED_ROWS,
    issue_rules: [],
    stock_prices: [],
    companies: fixtures.map((f) => ({
      corp_code: f.corp_code,
      stock_code: f.stock_code,
      acc_mt: f.acc_mt,
      sectors: { is_financial: f.is_financial },
    })),
  });

  const delta = args.to ? quarterIndex(args.to) - quarterIndex(ANSWERS_LATEST) : 0;
  const shiftQuarter = (q) => (delta === 0 ? q : addQuarters(q, delta));
  const shiftText = (text) => text.replace(/\d{4}Q[1-4]/g, (q) => shiftQuarter(q));
  const now = new Date();

  const rows = []; // 표: { key, label, want, got, note }
  const candidates = {}; // --json: { "skhynix.json": { key: answer } }
  let differences = 0;

  for (const file of readdirSync(ANSWERS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()) {
    const answers = JSON.parse(readFileSync(join(ANSWERS_DIR, file), "utf8"));
    for (const [key, answer] of Object.entries(answers)) {
      if (key.startsWith("_") || answer.synthetic || answer.formula) continue;
      const id = `${file.replace(/\.json$/, "")}#${key}`;
      const moves = delta !== 0 && endsAtLatest(answer);
      try {
        if ("question" in answer && "figures" in answer) {
          const result = await refreshDetailed(answer, moves);
          for (const r of result.rows) rows.push({ id, moved: moves, ...r });
          differences += result.rows.filter((r) => r.differs).length;
          if (moves || result.rows.some((r) => r.differs)) {
            (candidates[file] ??= {})[key] = result.candidate;
          }
        } else if ("company" in answer && "metric" in answer) {
          const r = await refreshOneLine(answer, moves);
          rows.push({ id, moved: moves, ...r.row });
          if (r.row.differs) differences += 1;
          if (moves || r.row.differs) (candidates[file] ??= {})[key] = r.candidate;
        }
      } catch (err) {
        differences += 1;
        rows.push({
          id,
          label: "-",
          want: "-",
          got: "-",
          differs: true,
          note: `계산 실패: ${err instanceof Error ? err.message : err}`,
        });
      }
    }
  }

  const answerCount = new Set(rows.map((r) => r.id)).size;
  log(
    `정답 ${answerCount}개 · 숫자 ${rows.length}개를 다시 계산했습니다 (전자공시·주가 API 직접, 팀 DB 안 씀)`,
  );
  if (args.json) {
    process.stdout.write(`${JSON.stringify(candidates, null, 2)}\n`);
  } else {
    printTable(rows, args);
  }
  log(
    delta !== 0
      ? `\n${ANSWERS_LATEST} → ${args.to}: 옮긴 정답 ${Object.values(candidates).reduce((n, c) => n + Object.keys(c).length, 0)}개. 파일은 고치지 않았습니다 — ANSWER_KEY.md 끝 순서대로 손으로 확인 뒤 반영`
      : differences === 0
        ? "\n✅ 모든 정답이 지금 원문·주가로 다시 계산한 값과 같습니다."
        : `\n⚠️  다른 곳 ${differences}개 — 정정 공시인지(접수번호) 먼저 확인하세요. 파일은 고치지 않았습니다.`,
  );
  if (delta === 0 && differences > 0) process.exit(1);

  // ── 상세 정답: 실행기 그대로 ───────────────────────────────────────────────
  async function refreshDetailed(answer, moves) {
    const period = moves
      ? { from: shiftQuarter(answer.period.from), to: shiftQuarter(answer.period.to) }
      : answer.period;
    const named = fixtures.filter((f) => f.corp_name && answer.question.includes(f.corp_name));
    // 질문에 나온 순서 (대상 먼저)
    named.sort(
      (a, b) => answer.question.indexOf(a.corp_name) - answer.question.indexOf(b.corp_name),
    );
    const companies = (named.length > 0 ? named : fixtures.filter((f) => f.key === "skHynix")).map(
      refOf,
    );
    const [target, ...peers] = companies;
    const at = answer.now && !(args.today || moves) ? new Date(answer.now) : now;
    const outcome = await runAnalysis(
      {
        intent: peers.length > 0 ? "compare" : "recent",
        target,
        peers,
        metrics: answer.metrics,
        period: { ...period, specified: true, reason: "회귀 정답 다시 구하기", clipped: false },
        groupBy: answer.groupBy ?? "quarter",
        needsNews: false,
      },
      { client: db.client, now: () => at },
    );
    if (outcome.kind !== "done") {
      const codes = outcome.diagnoses.map((d) => d.kind).join(", ");
      throw new Error(`전처리 확인이 필요합니다 (${codes}) — 앱에서 같은 질문으로 확인`);
    }
    const byLabel = new Map(Object.values(outcome.result.figures).map((f) => [f.label, f]));
    const used = new Set(outcome.version.sources.map((s) => s.rceptNo).filter(Boolean));
    // 옮긴 정답은 보고서가 바뀌는 게 당연하다 — 같은 기간을 다시 계산할 때만 정정 공시를 의심한다
    const changedRcept = moves ? [] : (answer.rceptNo ?? []).filter((r) => !used.has(r));

    const out = [];
    const figures = [];
    for (const want of answer.figures) {
      const label = moves ? shiftText(want.label) : want.label;
      const got = byLabel.get(label);
      const fresh = got
        ? {
            label,
            value: got.value === null ? null : round4(got.value, want.unit),
            unit: got.unit,
            ...(want.display || moves ? { display: got.display } : {}),
            ...(got.reason ? { reason: got.reason } : {}),
            ...(got.basis.priceDate ? { priceDate: got.basis.priceDate } : {}),
          }
        : null;
      figures.push(fresh ?? { label, value: null, unit: want.unit, reason: "결과에 없음" });
      const differs = moves ? false : !sameFigure(want, got);
      out.push({
        label,
        want: moves ? "(새 분기)" : showFigure(want),
        got: got ? showFigure(fresh) : "결과에 없음",
        differs,
        note:
          changedRcept.length > 0 ? `접수번호 바뀜(정정 공시?): ${changedRcept.join(", ")}` : "",
      });
    }
    const candidate = {
      ...answer,
      period: { ...period },
      ...(moves && answer.now ? { now: at.toISOString() } : {}),
      figures,
      rceptNo: [...used].sort(),
      notes: [
        ...(answer.notes ?? []),
        `scripts/refresh-answers.mjs로 다시 구함 (${now.toISOString().slice(0, 10)}) — rceptNo는 계산에 쓴 보고서 전부(증감률용 앞 분기 포함). 원문과 손으로 대조한 뒤 반영`,
      ],
    };
    if (moves) candidate.question = shiftQuestion(answer.question);
    return { rows: out, candidate };
  }

  // ── 한 줄 정답: 회귀 엔진 계산 그대로 ────────────────────────────────────────
  async function refreshOneLine(answer, moves) {
    const fixture = fixtures.find((f) => f.key === answer.company);
    if (!fixture)
      throw new Error(`answers의 company "${answer.company}"가 tests/accuracy/fixtures에 없습니다`);
    const period = moves ? shiftQuarter(answer.period) : answer.period;
    const isYear = /^\d{4}$/.test(period);
    const to = isYear ? `${period}Q4` : period;
    const financials = await ensureCompanyFinancials(refOf(fixture), addQuarters(to, -7), to, {
      client: db.client,
    });
    let valuation;
    let priceDate = answer.priceDate;
    if (/^(per|pbr|market_cap)$/.test(answer.metric)) {
      const window =
        moves || args.today || !priceDate ? { kind: "latest" } : { kind: "asOf", date: priceDate };
      const loaded = await loadPrices([fixture.stock_code], window, {
        client: db.client,
        now: () => now,
      });
      priceDate = loaded.baseDate ?? priceDate;
      valuation = {
        corpCode: fixture.corp_code,
        stockCode: fixture.stock_code,
        name: fixture.corp_name,
        priceDate,
        prices: loaded.rows,
      };
    }
    const got = valueFromFinancials(financials, answer.metric, period, valuation);
    const value = typeof got.value === "number" ? round4(got.value, "PERCENT") : got.value;
    const differs =
      !moves &&
      !(
        sameValue(value, answer.value) && (got.reason ?? undefined) === (answer.reason ?? undefined)
      );
    const show = (v, reason) => (v === null ? `없음(${reason})` : formatNumber(v));
    return {
      row: {
        label: `${answer.metric} ${period}${priceDate ? ` · 기준일 ${priceDate}` : ""}`,
        want: moves ? "(새 분기)" : show(answer.value, answer.reason),
        got: show(value, got.reason),
        differs,
        note: "",
      },
      candidate: {
        ...answer,
        period,
        ...(priceDate ? { priceDate } : {}),
        value: value === null ? null : String(value),
        ...(got.reason ? { reason: got.reason } : {}),
        source: `${answer.source} — scripts/refresh-answers.mjs로 다시 구함 (${now.toISOString().slice(0, 10)})`,
      },
    };
  }

  function endsAtLatest(answer) {
    if (answer.period && typeof answer.period === "object")
      return answer.period.to === ANSWERS_LATEST;
    return (
      answer.period === ANSWERS_LATEST ||
      answer.metric === "per" ||
      answer.metric === "pbr" ||
      answer.metric === "market_cap"
    );
  }

  /**
   * 질문 속 분기도 옮긴다: "2026년 2분기" → "2026년 3분기", 연도 없는 "2분기"는 정답을 만든 해(최신 분기의 해)로 본다.
   * 분기 이름이 없는 "최근 실적"은 그대로.
   */
  function shiftQuestion(question) {
    const baseYear = ANSWERS_LATEST.slice(0, 4);
    return question.replace(/(?:(\d{4})년 )?([1-4])분기/g, (_, y, q) => {
      const moved = shiftQuarter(`${y ?? baseYear}Q${q}`);
      return y || moved.slice(0, 4) !== baseYear
        ? `${moved.slice(0, 4)}년 ${moved.slice(5)}분기`
        : `${moved.slice(5)}분기`;
    });
  }

  function quarterIndex(q) {
    return compareQuarters(q, "2000Q1");
  }
}

/** 한 줄 정답 값 비교 — 정수 금액은 글자 그대로, 소수(비율)는 숫자로("62.1500" = 62.15) */
function sameValue(got, want) {
  if (got === null || want === null || want === undefined) return got === (want ?? null);
  if (/^-?\d+$/.test(String(want)) && /^-?\d+$/.test(String(got)))
    return String(got) === String(want);
  return Math.abs(Number(got) - Number(want)) < 0.00005 + 1e-9;
}

/** 정답 쪽 규칙: 금액은 원 단위 정수, 퍼센트·배수는 소수 넷째 자리 */
function round4(value, unit) {
  if (unit === "KRW") return value;
  return Math.round(value * 10_000) / 10_000;
}

function sameFigure(want, got) {
  if (!got) return false;
  if (want.value === null) {
    if (got.value !== null) return false;
  } else if (got.value === null) return false;
  else if (want.unit === "KRW") {
    if (got.value !== want.value) return false;
  } else if (Math.abs(got.value - want.value) >= 0.00005 + 1e-9) return false;
  if (got.unit !== want.unit) return false;
  if (want.display && got.display !== want.display) return false;
  if (want.reason && got.reason !== want.reason) return false;
  if (want.priceDate && got.basis?.priceDate !== want.priceDate) return false;
  return true;
}

function showFigure(f) {
  if (!f) return "-";
  if (f.value === null && !f.reason && f.display) return `"${f.display}"`; // 흑자전환 등
  const v = f.value === null ? `없음(${f.reason ?? "?"})` : formatNumber(f.value);
  return f.display && f.value !== null && f.unit !== "KRW" ? `${v} "${f.display}"` : v;
}

function formatNumber(v) {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v).toLocaleString("ko-KR");
  return Number.isInteger(n) ? n.toLocaleString("ko-KR") : String(n);
}

function printTable(rows, args) {
  const shown = rows.filter((r) => r.differs || (args.to && r.moved));
  if (shown.length === 0) return;
  const widths = [40, 34, 28, 28];
  console.log(
    `\n${padCell("정답 키", widths[0])}${padCell("숫자", widths[1])}${padCell(args.to ? "" : "지금 정답", widths[2])}${padCell(args.to ? "새 값" : "다시 구한 값", widths[3])}비고`,
  );
  for (const r of shown) {
    console.log(
      `${padCell(r.id, widths[0])}${padCell(r.label, widths[1])}${padCell(args.to ? "" : r.want, widths[2])}${padCell(r.got, widths[3])}${r.note}`,
    );
  }
}

main().catch((err) => {
  console.error("정답 다시 구하기 실패:", err instanceof Error ? err.message : err);
  process.exit(1);
});
