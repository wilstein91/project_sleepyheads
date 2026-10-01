// Figure ID 발급 + 화면용 문자열 포맷 (모든 숫자에 ID·단위·기준 보고서가 붙는다, WU-110 완료조건).
import type { Figure, NullReason, Unit } from "@/contracts";
import { formatCount, formatKrw, formatPercent, formatTimes } from "./format";

export interface AddFigureInput {
  label: string;
  unit: Unit;
  /** KRW면 bigint, 그 밖은 number. null이면 계산 불가(`reason` 필수). */
  value: bigint | number | null;
  reason?: NullReason;
  /** 숫자 대신 보여 줄 글자 (증감률 부호 전환 "흑자전환" 등, TECH §6.4). value는 null, reason은 없다 */
  displayText?: string;
  basis: Figure["basis"];
}

export interface FigureAllocator {
  add(input: AddFigureInput): Figure;
  figures: Record<string, Figure>;
}

/** `startAt`부터 번호를 붙인다 — 투자 리포트는 100000부터 써서 질문 결과의 숫자 ID(f1…)와 겹치지 않는다 */
export function createFigureAllocator(startAt = 0): FigureAllocator {
  const figures: Record<string, Figure> = {};
  let seq = startAt;

  return {
    figures,
    add(input) {
      seq += 1;
      const id = `f${seq}`;
      const figure: Figure = {
        id,
        label: input.label,
        value: input.value === null ? null : Number(input.value),
        unit: input.unit,
        display: input.displayText ?? formatDisplay(input.unit, input.value, input.reason),
        basis: input.basis,
        ...(input.reason ? { reason: input.reason } : {}),
      };
      figures[id] = figure;
      return figure;
    },
  };
}

function formatDisplay(unit: Unit, value: bigint | number | null, reason?: NullReason): string {
  if (value === null) return reason ? "계산 불가" : "값 없음";
  switch (unit) {
    case "KRW":
      return formatKrw(value as bigint);
    case "PERCENT":
      return formatPercent(value as number);
    case "TIMES":
      return formatTimes(value as number);
    case "COUNT":
      return formatCount(value as number);
    default:
      return String(value);
  }
}
