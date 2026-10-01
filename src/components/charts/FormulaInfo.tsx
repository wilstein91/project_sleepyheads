import { Term } from "@/components/glossary/Term";
import { formulaFor } from "@/components/glossary/terms";

/** 지표 옆 ⓘ — 누르거나 마우스를 올리면 계산식 (TECH §6.4와 같은 글자) */
export function FormulaInfo({ seriesKey }: { seriesKey: string }) {
  // 여러 기업 분기·연도별 계열은 "operating_income:00126380" — 지표 부분만 본다
  const info = formulaFor(seriesKey.split(":")[0]);
  if (!info) return null;
  return (
    <Term
      entry={{
        term: `${info.term} 계산식`,
        aliases: [],
        description: info.note ? `${info.formula} (${info.note})` : info.formula,
      }}
      label={`${info.term} 계산식`}
      className="ml-1 inline-flex size-5 cursor-help items-center justify-center rounded-full text-xs text-muted hover:text-accent"
    >
      <span aria-hidden="true">ⓘ</span>
    </Term>
  );
}
