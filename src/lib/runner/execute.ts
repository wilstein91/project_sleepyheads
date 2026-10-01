// WU-110 분석 실행기: 검사를 통과한 분석 요청(WU-109)을 허용된 도구로만 계산해
// 결과 객체(차트·표·숫자 ID, API_SPEC §2.5)를 만든다. Python·SQL 생성·실행 경로는 없다 —
// 여기 나열된 함수 호출 조합이 전부다 (TECH §4.4).
// WU-202: 계산에 쓴 보고서(접수번호)를 데이터 버전으로 묶고, 재실행은 그 출처만 다시 읽는다.
// WU-203: 계산 전에 전처리 진단을 만들고, 확인이 필요하면 멈춰서 선택을 받은 뒤 계산한다.
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AnalysisRequestView, Diagnosis, Quarter, ResultObject, Series } from "@/contracts";
import type { FsDiv } from "@/lib/financials/types";
import { CALC_VERSION } from "@/lib/metrics/types";
import { ensureOfsReport } from "@/lib/preprocess/ofs";
import { hasUndecided, withDefaults, type PreprocessDecisions } from "@/lib/preprocess/types";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { addQuarters, parseQuarter } from "@/lib/ask/quarter";
import {
  dataVersionIdFor,
  hashDataVersion,
  type DataSource,
  type DataVersionContent,
} from "@/lib/versions/version";
import {
  ensureCompanyFinancials,
  ensureCompanyFinancialsOver,
  financialsFromSources,
  sourceKeyOf,
  type CompanyFinancials,
} from "./company-financials";
import {
  collectDiagnostics,
  findMissingQuarters,
  mixedFsDivCorps,
  preprocessFlags,
  applyFirstFilings,
} from "./diagnostics";
import { fetchEventDisclosures } from "./disclosures-tool";
import { createFigureAllocator } from "./figures";
import {
  buildCharts,
  buildDataBasis,
  buildUsedData,
  comparisonChartOptions,
  comparisonFlags,
  FINANCIAL_CONVERSION_FLAG,
  FINANCIAL_FOOTNOTE,
  sumChartOptions,
  unavailableFlags,
} from "./present";
import {
  buildAnnualSeries,
  buildCompanyComparisonSeries,
  buildMultiCompanyPeriodSeries,
  comparisonQuarter,
  buildQuarterlySeries,
  buildSumSeries,
  sumPeriods,
  quartersInRange,
  type CompanyMetricSample,
} from "./series-builders";
import {
  buildValuationChart,
  isPriceMetric,
  prepareValuation,
  valuationSummary,
  type PreparedValuation,
} from "./valuation";

export interface ExecuteAnalysisOptions {
  userId?: string | null;
  analysisId?: string | null;
  client?: SupabaseClient;
  /** 테스트용 시계 (주가 기준일·"최신 분기" 판정) */
  now?: () => Date;
}

export interface RunAnalysisOptions extends ExecuteAnalysisOptions {
  /**
   * 재실행(WU-202 Q6 `useLatestData=false`): 이 데이터 버전의 출처·선택만으로 계산한다.
   * 외부 호출·진단 없음 — 그래서 언제 해도 같은 숫자가 나온다.
   */
  version?: Pick<DataVersionContent, "sources" | "decisions"> &
    Partial<Pick<DataVersionContent, "priceDate">>;
  /** Q5에서 고른 전처리 선택 (없으면 기본값) */
  decisions?: PreprocessDecisions | null;
  /**
   * true면 확인이 필요한 진단(결측·정정 중복·연결/별도 혼재)을 아직 고르지 않았을 때 계산하지 않고
   * 진단을 돌려준다(회원 분석, `awaiting_preprocess`). false면 기본값으로 바로 계산한다(비로그인 예시).
   */
  requireConfirmation?: boolean;
  /**
   * 보드 필터 다시 계산(WU-401 B2): 원래 분석의 데이터 버전. 이 출처에 있는 보고서는 그대로 쓰고
   * 새 기간·새 기업에 더 필요한 보고서만 새로 받는다. 원래 전처리 선택을 이어 쓰고, 새로 받은 보고서에만
   * 선택을 적용한다. 진단에서 멈추지 않는다(새로 생긴 진단은 기본값).
   */
  base?: Pick<DataVersionContent, "sources" | "decisions">;
  /**
   * 보드에서 비교 기업을 넣었을 때: 분기·연도별 결과에 "기업 비교" 막대 차트를 더한다.
   * (원래 분석이 기업 비교·합계면 그 차트가 이미 비교 기업을 따라 바뀌므로 더하지 않는다)
   */
  peerComparisonChart?: boolean;
}

export type RunAnalysisOutcome =
  | { kind: "needs_preprocess"; diagnoses: Diagnosis[] }
  | {
      kind: "done";
      result: ResultObject;
      version: DataVersionContent;
      versionHash: string;
      /** 발견된 진단 (자동 처리 항목 포함) — 결과와 함께 저장해 두면 나중에도 보인다 */
      diagnoses: Diagnosis[];
      /** 주가 지표(WU-502)를 계산했으면 결합 기록 — 실행 기록 `outputSummary`에 붙인다 (TECH §6.6 "기록") */
      priceJoin: { summary: string; externalCalls: number } | null;
    };

/** YoY(4분기 전)까지 계산할 수 있게, 요청 범위보다 4분기 앞서서 데이터를 확보해 둔다. */
export const CHANGE_LOOKBACK_QUARTERS = 4;

/** 기존 호출(비로그인 예시 등)용: 진단은 기본값으로 처리하고 결과만 돌려준다 */
export async function executeAnalysis(
  request: AnalysisRequestView,
  options: ExecuteAnalysisOptions = {},
): Promise<ResultObject> {
  const outcome = await runAnalysis(request, { ...options, requireConfirmation: false });
  if (outcome.kind !== "done") throw new Error("전처리 확인 없이 실행했는데 진단에서 멈췄습니다");
  return outcome.result;
}

export async function runAnalysis(
  request: AnalysisRequestView,
  options: RunAnalysisOptions = {},
): Promise<RunAnalysisOutcome> {
  const client = options.client ?? getSupabaseAdmin();
  const toolOptions = {
    userId: options.userId ?? null,
    analysisId: options.analysisId ?? null,
    client,
  };

  const requestedQuarters = quartersInRange(request.period);
  const fetchFrom = addQuarters(request.period.from, -CHANGE_LOOKBACK_QUARTERS);
  const companies = [request.target, ...request.peers];
  const financialsByCorp = new Map<string, CompanyFinancials>();

  let decisions: PreprocessDecisions;
  let diagnoses: Diagnosis[] = [];

  if (options.version) {
    // 재실행: 저장된 출처(전처리 선택이 이미 반영된 접수번호·연결/별도)만 읽는다
    const version = options.version;
    const loaded = await Promise.all(
      companies.map((company) =>
        financialsFromSources(company, fetchFrom, request.period.to, version.sources, { client }),
      ),
    );
    companies.forEach((company, i) => financialsByCorp.set(company.corpCode, loaded[i]));
    decisions = version.decisions;
  } else {
    // 보드 다시 계산이면 원래 출처를 그대로 두고 빠진 보고서만 받는다. 새로 받은 보고서 키를 모아 둔다
    // 기업들을 함께 받는다 (Phase 3 후속: 보드 B2에서 처음 보는 비교 기업 4~5곳을 한 곳씩 받으면 60초를 넘었다).
    // 전자공시 동시 호출은 공통 호출기(dartFetch)가 프로세스 전체에서 5개로 묶으므로 여기서 더 묶지 않는다
    const freshKeys = new Set<string>();
    const base = options.base;
    // allSettled: 한 기업이 실패해도 나머지 수집이 응답 뒤에 남아 돌지 않게 모두 끝난 뒤 첫 오류를 던진다
    const settled = await Promise.allSettled(
      companies.map(async (company) => {
        if (!base) {
          return ensureCompanyFinancials(company, fetchFrom, request.period.to, toolOptions);
        }
        const over = await ensureCompanyFinancialsOver(
          company,
          fetchFrom,
          request.period.to,
          base.sources,
          toolOptions,
        );
        for (const key of over.freshKeys) freshKeys.add(key);
        return over;
      }),
    );
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") financialsByCorp.set(companies[i].corpCode, r.value);
    });
    // 원래 출처에는 원래 선택이 이미 반영돼 있다 — 선택은 새로 받은 보고서에만 적용한다
    const isFresh = (s: DataSource) => !options.base || freshKeys.has(sourceKeyOf(s));

    const samples = companies.map((company) => ({
      company,
      financials: financialsByCorp.get(company.corpCode)!,
    }));
    const found = await collectDiagnostics(samples, requestedQuarters, request.metrics, client);
    diagnoses = found.diagnoses;
    if (options.requireConfirmation && hasUndecided(diagnoses, options.decisions)) {
      return { kind: "needs_preprocess", diagnoses };
    }
    decisions = withDefaults(diagnoses, { ...options.base?.decisions, ...options.decisions });
    const firstFilings = options.base
      ? new Map([...found.firstFilings].filter(([key]) => freshKeys.has(key)))
      : found.firstFilings;

    // 선택 적용 — 원본(report_values)은 그대로 두고 계산에 쓸 출처만 바꾼다 (TECH §5.3)
    for (const company of companies) {
      const financials = financialsByCorp.get(company.corpCode)!;
      let sources = financials.sources ?? [];
      if (decisions.duplicate_correction === "first_filing") {
        sources = applyFirstFilings(sources, firstFilings);
      }
      if (decisions.mixed_fs_div === "unify_ofs" && found.mixedCorps.has(company.corpCode)) {
        sources = await unifyToOfs(sources, toolOptions, isFresh);
      }
      if (sources !== financials.sources) {
        financialsByCorp.set(
          company.corpCode,
          await financialsFromSources(company, fetchFrom, request.period.to, sources, { client }),
        );
      }
    }
  }

  // 결측 "해당 분기 제외" — **기업별로** 뺀다. 같은 출처면 늘 같은 분기가 빠진다 (재실행에서도 다시 계산).
  // 비교는 기업마다 자기 분기만 빠지고(한 기업 결측 때문에 다른 기업의 기준 분기가 밀리지 않게),
  // 합계는 한 칸에 모든 기업이 있어야 해서 누구 하나라도 뺀 분기는 그 칸이 빠진다 (buildResult).
  const excludedByCorp = new Map<string, Set<Quarter>>();
  if (decisions.missing_account === "exclude_quarter") {
    for (const company of companies) {
      const financials = financialsByCorp.get(company.corpCode)!;
      const missing = findMissingQuarters(financials, requestedQuarters, request.metrics).quarters;
      if (missing.length > 0) excludedByCorp.set(company.corpCode, new Set(missing));
    }
  }
  const excludedLabels = companies.flatMap((c) =>
    [...(excludedByCorp.get(c.corpCode) ?? [])].map((q) =>
      companies.length > 1 ? `${c.name} ${q}` : q,
    ),
  );

  // 주가 지표 (WU-502): 기업마다 기준 분기(요청 범위 안 보고서가 있는 최근 분기)에 주가를 결합한다.
  // 기준일이 데이터 버전에 들어가야 해서 버전 해시보다 먼저 한다
  let valuation: PreparedValuation | null = null;
  if (request.metrics.some(isPriceMetric)) {
    const quarterByCorp = new Map(
      companies.map((c) => [
        c.corpCode,
        comparisonQuarter(
          financialsByCorp.get(c.corpCode)!,
          requestedQuarters.filter((q) => !excludedByCorp.get(c.corpCode)?.has(q)),
          request.period.to,
        ),
      ]),
    );
    valuation = await prepareValuation({
      companies,
      financialsByCorp,
      quarterByCorp,
      period: request.period,
      priceDate: options.version?.priceDate ?? null,
      ...toolOptions,
      now: options.now,
    });
  }

  const sources: DataSource[] = companies.flatMap(
    (c) => financialsByCorp.get(c.corpCode)!.sources ?? [],
  );
  const version: DataVersionContent = {
    sources,
    calcVersion: CALC_VERSION,
    priceDate: valuation?.priceDate ?? null,
    decisions,
  };
  const versionHash = hashDataVersion(version);
  const dataVersionId = dataVersionIdFor(options.userId ?? null, versionHash);

  const result = await buildResult(request, {
    companies,
    financialsByCorp,
    requestedQuarters,
    excludedByCorp,
    dataVersionId,
    extraFlags: [
      ...preprocessFlags(decisions, excludedLabels),
      ...(decisions.mixed_fs_div === "unify_ofs" && mixedFsDivCorps(sources).size > 0
        ? ["⚠ 별도 재무제표가 없는 보고서는 연결 기준 그대로 사용"]
        : []),
    ],
    toolOptions,
    peerComparisonChart: options.peerComparisonChart ?? false,
    valuation,
  });

  const priceJoin = valuation
    ? { summary: valuationSummary(valuation), externalCalls: valuation.externalCalls }
    : null;
  return { kind: "done", result, version, versionHash, diagnoses, priceJoin };
}

/** 연결(CFS)로 쓴 보고서를 별도(OFS)로 바꾼다. 별도가 없는 보고서(013)는 그대로 둔다 */
async function unifyToOfs(
  sources: readonly DataSource[],
  options: { userId: string | null; analysisId: string | null; client: SupabaseClient },
  /** 바꿀 보고서만 true (보드 다시 계산은 새로 받은 보고서만) */
  applies: (s: DataSource) => boolean = () => true,
): Promise<DataSource[]> {
  const result: DataSource[] = [];
  for (const s of sources) {
    if (s.fsDiv !== "CFS" || !s.rceptNo || !applies(s)) {
      result.push(s);
      continue;
    }
    const ofsRceptNo = await ensureOfsReport(s.corpCode, s.bsnsYear, s.reprtCode, options);
    result.push(
      ofsRceptNo
        ? {
            ...s,
            fsDiv: "OFS",
            rceptNo: ofsRceptNo,
            collected: { fsDiv: "CFS", rceptNo: s.rceptNo },
          }
        : s,
    );
  }
  return result;
}

interface BuildResultInput {
  companies: AnalysisRequestView["peers"];
  financialsByCorp: Map<string, CompanyFinancials>;
  /** 요청 범위의 분기 */
  requestedQuarters: Quarter[];
  /** 기업(corpCode) → 결측 "해당 분기 제외"로 뺀 분기 */
  excludedByCorp: ReadonlyMap<string, ReadonlySet<Quarter>>;
  dataVersionId: string;
  extraFlags: string[];
  toolOptions: { userId: string | null; analysisId: string | null; client: SupabaseClient };
  /** {@link RunAnalysisOptions.peerComparisonChart} */
  peerComparisonChart?: boolean;
  /** 주가 지표 (WU-502) — 없으면 주가 지표를 묻지 않은 질문 */
  valuation?: PreparedValuation | null;
}

/** 여러 기업 분기·연도별 표의 행: 어느 기업에든 있는 분기(연도) — "2025Q3"·"2025"는 글자 순서가 곧 시간 순서 */
function periodRowKeys(series: readonly Series[]): string[] {
  return [...new Set(series.flatMap((s) => s.points.map((p) => p.x)))].sort();
}

/** 계산된 재무 값으로 차트·표·숫자 ID를 만든다 (WU-110) */
async function buildResult(
  fullRequest: AnalysisRequestView,
  input: BuildResultInput,
): Promise<ResultObject> {
  const { companies, financialsByCorp } = input;
  // 주가 지표(시가총액·PER·PBR)는 아래 재무 차트가 아니라 주가 지표 카드·표로 따로 만든다
  const request = {
    ...fullRequest,
    metrics: fullRequest.metrics.filter((m) => !isPriceMetric(m)),
  };
  const fsDivByCorp = new Map<string, FsDiv>();
  for (const company of companies) {
    const financials = financialsByCorp.get(company.corpCode)!;
    const anyRow = [...financials.metricsByQuarter.values()][0];
    fsDivByCorp.set(company.corpCode, anyRow?.fs_div ?? "CFS");
  }
  const allowedFor = (corpCode: string) =>
    input.requestedQuarters.filter((q) => !input.excludedByCorp.get(corpCode)?.has(q));
  // 합계는 한 칸에 모든 기업이 있어야 한다 — 누구 하나라도 뺀 분기는 그 칸을 뺀다
  const commonQuarters = input.requestedQuarters.filter((q) =>
    companies.every((c) => !input.excludedByCorp.get(c.corpCode)?.has(q)),
  );
  // 분기·연도별(기업 하나)은 대상 기업만 보여 주므로 대상 기업이 뺀 분기만 뺀다
  const requestedQuarters = allowedFor(request.target.corpCode);

  const targetFinancials = financialsByCorp.get(request.target.corpCode)!;
  const targetFsDiv = fsDivByCorp.get(request.target.corpCode)!;
  const allocator = createFigureAllocator();

  const isSum = request.aggregate === "sum";
  const isComparison = !isSum && (request.groupBy === "company" || request.groupBy === "sector");
  const samples = companies.map((company): CompanyMetricSample => ({
    company,
    financials: financialsByCorp.get(company.corpCode)!,
    fsDiv: fsDivByCorp.get(company.corpCode)!,
  }));
  // 연도별 합계면 1~4분기가 다 있는 해마다, 아니면 분기마다 한 칸
  const periods = isSum ? sumPeriods(commonQuarters, request.groupBy === "year") : [];
  const sumByYear = periods.length > 0 && periods[0].quarters.length === 4;
  const sumResult = isSum
    ? buildSumSeries(samples, periods, request.metrics, request.groupBy === "sector", allocator)
    : null;

  const comparisonQuarters = () =>
    new Map(
      samples.map((s) => [
        s.company.corpCode,
        comparisonQuarter(s.financials, allowedFor(s.company.corpCode), request.period.to),
      ]),
    );
  const comparison = isComparison
    ? buildCompanyComparisonSeries(samples, comparisonQuarters(), request.metrics, allocator)
    : null;
  // 질문에 기업이 여럿인 분기·연도별 ("삼성전자와 SK하이닉스 최근 4분기 영업이익 비교해줘" — AI가 group_by를
  // "quarter"로 줄 때가 있다): 기업마다 선 하나씩. 보드에서 비교 기업을 넣은 경우는 아래 기업 비교 막대(WU-401)
  const multiCompany =
    !isSum && !isComparison && companies.length > 1 && !input.peerComparisonChart
      ? buildMultiCompanyPeriodSeries(
          samples,
          allowedFor,
          request.metrics,
          allocator,
          request.groupBy === "year",
        )
      : null;

  const { series, reportsUsed } = sumResult
    ? sumResult
    : comparison
      ? comparison
      : multiCompany
        ? multiCompany
        : request.groupBy === "year"
          ? buildAnnualSeries(
              targetFinancials,
              targetFsDiv,
              requestedQuarters,
              request.metrics,
              allocator,
            )
          : buildQuarterlySeries(
              targetFinancials,
              targetFsDiv,
              requestedQuarters,
              request.metrics,
              allocator,
            );

  const charts = buildCharts(
    request,
    comparison?.chartSeries ?? series,
    allocator.figures,
    reportsUsed,
    sumResult
      ? sumChartOptions(request, companies, periods.length, sumResult.excluded)
      : comparison
        ? comparisonChartOptions(comparison)
        : multiCompany
          ? { type: "line", footnotes: [], subject: companies.map((c) => c.name).join("·") }
          : undefined,
  );

  // 보드에서 비교 기업을 넣은 분기·연도별 결과 (WU-401): 원래 차트는 대상 기업 그대로 두고 기업 비교 막대를 더한다
  const peerComparison =
    input.peerComparisonChart && !isSum && !isComparison && companies.length > 1
      ? buildCompanyComparisonSeries(samples, comparisonQuarters(), request.metrics, allocator)
      : null;
  if (peerComparison) {
    const added = buildCharts(
      { ...request, groupBy: "company" },
      peerComparison.chartSeries,
      allocator.figures,
      peerComparison.reportsUsed,
      comparisonChartOptions(peerComparison),
    );
    const firstId = charts.length + 1;
    added.forEach((chart, i) => charts.push({ ...chart, id: `c${firstId + i}` }));
  }
  const shownComparison = comparison ?? peerComparison;
  const reportsInBasis = peerComparison
    ? new Set([...reportsUsed, ...peerComparison.reportsUsed])
    : reportsUsed;

  const disclosures =
    request.intent === "event"
      ? await fetchEventDisclosures(request.target, request.period, input.toolOptions)
      : [];

  // 주가 지표 카드(기업 하나)·표(여럿)를 맨 앞에 — 주가 지표를 물은 질문의 첫 답이다
  const valuationChart = input.valuation
    ? buildValuationChart(input.valuation, allocator, "c1")
    : null;
  if (valuationChart) {
    charts.forEach((chart, i) => (chart.id = `c${i + 2}`));
    charts.unshift(valuationChart.chart);
    for (const r of input.valuation!.rows) reportsInBasis.add(r.input.report);
  }

  const basis = buildDataBasis(request, reportsInBasis, targetFsDiv, input.dataVersionId);
  if (input.valuation) {
    basis.priceDate = input.valuation.priceDate;
    // 결합을 멈췄으면 그 사유를 맨 앞에 (TECH §6.6 "결합 중단 + 경고")
    basis.flags.unshift(...input.valuation.warnings);
  }
  if (isSum)
    basis.flags.push(`합계: ${companies.map((c) => c.name).join("·")} ${companies.length}곳`);
  // 여러 기업을 나란히 놓거나 더할 때 금융사가 섞이면 매출·영업이익률을 공통 지표로 바꿔 읽는다 (TECH §7).
  // 기업 하나의 분기·연도별은 붙이지 않는다
  const mixesFinancial =
    shownComparison?.hasFinancial ??
    ((isSum || multiCompany !== null) && samples.some((s) => s.company.sector.isFinancial));
  if (companies.length > 1 && mixesFinancial) basis.flags.push(FINANCIAL_CONVERSION_FLAG);
  if (shownComparison) {
    basis.flags.push(
      ...comparisonFlags(
        samples,
        shownComparison.quarterByCorp,
        request.period.to,
        input.excludedByCorp,
      ),
    );
  }
  basis.flags.push(...input.extraFlags);
  basis.flags.push(...unavailableFlags(allocator.figures));
  // 표 아래 주석 (TECH §7 글자 그대로): 부채비율에 ※가 붙은 표
  if ([...series, ...(peerComparison?.series ?? [])].some((s) => s.footnoteMark === "※")) {
    basis.flags.push(FINANCIAL_FOOTNOTE);
  }

  const rowKeys = isSum
    ? periods.map((p) => p.x)
    : comparison
      ? comparison.rowKeys
      : multiCompany
        ? periodRowKeys(multiCompany.series)
        : request.groupBy === "year"
          ? [...new Set(requestedQuarters.map((q) => `${parseQuarter(q).year}`))]
          : requestedQuarters;

  const rowLabelColumn = isSum
    ? sumByYear
      ? ({ name: "연도", type: "text" } as const)
      : ({ name: "분기", type: "quarter" } as const)
    : isComparison
      ? ({ name: "기업", type: "text" } as const)
      : request.groupBy === "year"
        ? ({ name: "연도", type: "text" } as const)
        : ({ name: "분기", type: "quarter" } as const);

  // 주가 지표만 물었으면 재무 차트가 없다 — "사용된 데이터"는 주가 지표 표로
  const usedData =
    valuationChart && series.length === 0
      ? buildUsedData({
          rowLabelColumn: { name: "기업", type: "text" },
          rowKeys: valuationChart.rowKeys,
          series: valuationChart.series,
          figures: allocator.figures,
          period: request.period,
          notes: basis.flags,
        })
      : buildUsedData({
          rowLabelColumn,
          rowKeys,
          series,
          figures: allocator.figures,
          period: request.period,
          notes: basis.flags,
        });

  return { basis, figures: allocator.figures, charts, disclosures, usedData };
}
