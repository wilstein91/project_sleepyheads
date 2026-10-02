"use client";

import { useState } from "react";
import type { Quarter } from "@/contracts";
import {
  EARLIEST_QUARTER,
  addQuarters,
  compareQuarters,
  formatQuarter,
  maxQuarter,
  parseQuarter,
} from "@/lib/ask/quarter";

// 보드 기간 필터 (TECH §12.4): 연도 하나 + 분기 하나로 기준 분기를 고르면, 그 분기까지 최근 4개 분기(1년)를 본다.
// 달력 분기 기준. 처음에는 지금 보드 기간의 끝 분기가 골라져 있다 (기간 미지정 질문이면 최신 분기 기준 최근 4분기).

/** 기준 분기까지 보여 주는 분기 수 (1년) */
export const PERIOD_QUARTERS = 4;

export interface Period {
  from: Quarter;
  to: Quarter;
}

/** 기준 분기에서 끝나는 최근 4개 분기 — 조회 시작 분기(EARLIEST_QUARTER) 앞은 자른다 */
export function periodEndingAt(to: Quarter): Period {
  return { from: maxQuarter(addQuarters(to, -(PERIOD_QUARTERS - 1)), EARLIEST_QUARTER), to };
}

const QUARTERS = [1, 2, 3, 4] as const;

/** 조회 시작 연도 ~ 최신 분기 연도, 최근 것부터 (선택 목록용) */
function yearOptions(latest: Quarter): number[] {
  const first = parseQuarter(EARLIEST_QUARTER).year;
  const last = parseQuarter(latest).year;
  return Array.from({ length: last - first + 1 }, (_, i) => last - i);
}

/** 그 연도에서 고를 수 있는 분기인가 (조회 시작 분기 ~ 최신 분기) */
function selectable(year: number, q: 1 | 2 | 3 | 4, latest: Quarter): boolean {
  const quarter = formatQuarter(year, q);
  return compareQuarters(quarter, EARLIEST_QUARTER) >= 0 && compareQuarters(quarter, latest) <= 0;
}

const selectClass =
  "h-9 rounded-lg border border-line bg-surface px-2 text-sm disabled:opacity-50 focus:outline-2 focus:outline-accent";

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
  // [기간 적용]을 눌러야 계산한다 (연도·분기를 고르는 도중마다 다시 계산하지 않게)
  // 조회 범위 규칙이 바뀌기 전의 옛 분석(끝이 최신 분기보다 뒤)은 최신 분기에서 시작한다
  const initial = parseQuarter(compareQuarters(period.to, latest) > 0 ? latest : period.to);
  const [year, setYear] = useState<number>(initial.year);
  const [q, setQ] = useState<1 | 2 | 3 | 4>(initial.q);
  const next = periodEndingAt(formatQuarter(year, q));
  const unchanged = next.from === period.from && next.to === period.to;

  function pickYear(value: number) {
    setYear(value);
    // 최신 연도로 바꿨는데 아직 없는 분기면 그해 마지막으로 고를 수 있는 분기로 옮긴다
    if (!selectable(value, q, latest)) {
      const fallback = [...QUARTERS].reverse().find((c) => selectable(value, c, latest));
      if (fallback) setQ(fallback);
    }
  }

  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="text-sm font-semibold">기간</legend>
      <div className="flex flex-wrap items-end gap-2">
        <label className="space-y-1 text-xs text-muted">
          <span className="block">연도</span>
          <select
            aria-label="연도"
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
          <span className="block">분기</span>
          <select
            aria-label="분기"
            value={q}
            onChange={(e) => setQ(Number(e.target.value) as 1 | 2 | 3 | 4)}
            className={selectClass}
          >
            {QUARTERS.map((c) => (
              <option key={c} value={c} disabled={!selectable(year, c, latest)}>
                {c}분기
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => onApply(next)}
          disabled={unchanged}
          className="inline-flex h-9 items-center rounded-lg border border-line px-3 text-sm font-medium hover:border-accent hover:text-accent disabled:opacity-50"
        >
          기간 적용
        </button>
      </div>
      <p className="text-xs text-muted" data-testid="period-preview">
        {next.from}~{next.to} (기준 분기까지 최근 {PERIOD_QUARTERS}개 분기)
      </p>
    </fieldset>
  );
}
