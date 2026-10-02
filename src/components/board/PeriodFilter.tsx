"use client";

import { useState } from "react";
import type { Quarter } from "@/contracts";
import { EARLIEST_QUARTER, compareQuarters, formatQuarter, parseQuarter } from "@/lib/ask/quarter";

// 보드 기간 필터 (TECH §12.4): 시작 [연도][분기] ~ 끝 [연도][분기] 드롭다운 4개. 달력 분기 기준.
// 처음에는 지금 보드 기간이 골라져 있다 (기간 미지정 질문이면 최신 분기 기준 최근 4분기).

export interface Period {
  from: Quarter;
  to: Quarter;
}

type Q = 1 | 2 | 3 | 4;
const QUARTERS = [1, 2, 3, 4] as const;

/** 조회 시작 연도 ~ 최신 분기 연도, 최근 것부터 (선택 목록용) */
function yearOptions(latest: Quarter): number[] {
  const first = parseQuarter(EARLIEST_QUARTER).year;
  const last = parseQuarter(latest).year;
  return Array.from({ length: last - first + 1 }, (_, i) => last - i);
}

/** 그 연도에서 고를 수 있는 분기인가 (조회 시작 분기 ~ 최신 분기) */
function selectable(year: number, q: Q, latest: Quarter): boolean {
  const quarter = formatQuarter(year, q);
  return compareQuarters(quarter, EARLIEST_QUARTER) >= 0 && compareQuarters(quarter, latest) <= 0;
}

/** 조회 범위 밖이면 가장 가까운 끝으로 (규칙이 바뀌기 전의 옛 분석 기간 등) */
function clamp(quarter: Quarter, latest: Quarter): Quarter {
  if (compareQuarters(quarter, latest) > 0) return latest;
  if (compareQuarters(quarter, EARLIEST_QUARTER) < 0) return EARLIEST_QUARTER;
  return quarter;
}

const selectClass =
  "h-9 rounded-lg border border-line bg-surface px-2 text-sm disabled:opacity-50 focus:outline-2 focus:outline-accent";

/** 연도 + 분기 드롭다운 한 쌍 (시작 또는 끝) */
function QuarterPicker({
  label,
  value,
  latest,
  onChange,
}: {
  label: "시작" | "끝";
  value: Quarter;
  latest: Quarter;
  onChange: (quarter: Quarter) => void;
}) {
  const { year, q } = parseQuarter(value);

  function pickYear(nextYear: number) {
    // 그해에 고를 수 없는 분기(최신 연도의 아직 없는 분기 등)면 그해 고를 수 있는 가장 가까운 분기로 옮긴다
    if (selectable(nextYear, q, latest)) return onChange(formatQuarter(nextYear, q));
    const ok = QUARTERS.filter((c) => selectable(nextYear, c, latest));
    const nearest = q > ok[ok.length - 1] ? ok[ok.length - 1] : ok[0];
    onChange(formatQuarter(nextYear, nearest));
  }

  return (
    <div className="flex items-end gap-1">
      <label className="space-y-1 text-xs text-muted">
        <span className="block">{label} 연도</span>
        <select
          aria-label={`${label} 연도`}
          value={year}
          onChange={(e) => pickYear(Number(e.target.value))}
          className={selectClass}
        >
          {yearOptions(latest).map((y) => (
            <option key={y} value={y}>
              {y}년
            </option>
          ))}
        </select>
      </label>
      <label className="space-y-1 text-xs text-muted">
        <span className="block">{label} 분기</span>
        <select
          aria-label={`${label} 분기`}
          value={q}
          onChange={(e) => onChange(formatQuarter(year, Number(e.target.value) as Q))}
          className={selectClass}
        >
          {QUARTERS.map((c) => (
            <option key={c} value={c} disabled={!selectable(year, c, latest)}>
              {c}분기
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

export function PeriodFilter({
  period,
  latest,
  disabled,
  onApply,
}: {
  /** 지금 보드에 적용된 기간 */
  period: Period;
  latest: Quarter;
  disabled: boolean;
  onApply: (period: Period) => void;
}) {
  // [기간 적용]을 눌러야 계산한다 (드롭다운을 고르는 도중마다 다시 계산하지 않게)
  const [from, setFrom] = useState<Quarter>(clamp(period.from, latest));
  const [to, setTo] = useState<Quarter>(clamp(period.to, latest));
  const reversed = compareQuarters(from, to) > 0;
  const unchanged = from === period.from && to === period.to;

  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="text-sm font-semibold">기간</legend>
      <div className="flex flex-wrap items-end gap-2">
        <QuarterPicker label="시작" value={from} latest={latest} onChange={setFrom} />
        <span aria-hidden="true" className="pb-2 text-muted">
          ~
        </span>
        <QuarterPicker label="끝" value={to} latest={latest} onChange={setTo} />
        <button
          type="button"
          onClick={() => onApply({ from, to })}
          disabled={reversed || unchanged}
          className="inline-flex h-9 items-center rounded-lg border border-line px-3 text-sm font-medium hover:border-accent hover:text-accent disabled:opacity-50"
        >
          기간 적용
        </button>
      </div>
      {reversed && (
        <p role="alert" className="text-sm text-notice-ink">
          시작 분기가 끝 분기보다 늦습니다. 시작 분기를 앞으로 옮겨 주세요.
        </p>
      )}
    </fieldset>
  );
}
