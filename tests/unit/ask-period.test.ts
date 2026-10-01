import { describe, expect, it } from "vitest";
import { parsePeriodText, resolvePeriod } from "@/lib/ask/period";

const LATEST = "2026Q2" as const;

describe("parsePeriodText", () => {
  it("'YYYY년'은 그 해 1~4분기", () => {
    expect(parsePeriodText("2023년", LATEST)).toEqual({ from: "2023Q1", to: "2023Q4" });
  });

  it("'최근 N년'은 latest에서 거슬러 올라간 N*4분기", () => {
    expect(parsePeriodText("최근 3년", LATEST)).toEqual({ from: "2023Q3", to: "2026Q2" });
  });

  it("'최근 N개 분기'는 latest에서 거슬러 올라간 N분기", () => {
    expect(parsePeriodText("최근 8개 분기", LATEST)).toEqual({ from: "2024Q3", to: "2026Q2" });
  });

  it("알아볼 수 없는 표현은 null", () => {
    expect(parsePeriodText("얼마 전", LATEST)).toBeNull();
  });
});

describe("resolvePeriod (TECH §4.3)", () => {
  it("SK하이닉스 '최근 실적' → 기간 미지정, 최근 4개 분기", () => {
    const result = resolvePeriod({ specified: false, text: null }, "recent", LATEST);
    expect(result).toEqual({
      ok: true,
      period: {
        from: "2025Q3",
        to: "2026Q2",
        specified: false,
        reason: "기간 미지정 → 최근 4개 분기",
        clipped: false,
      },
    });
  });

  it("'2023년 분기별 영업이익' → 2023Q1~2023Q4", () => {
    const result = resolvePeriod({ specified: true, text: "2023년" }, "trend", LATEST);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.period.from).toBe("2023Q1");
      expect(result.period.to).toBe("2023Q4");
      expect(result.period.specified).toBe(true);
    }
  });

  // 2026-10-01 운영(분석 33a4f8d7…): "SK하이닉스 2026년 2분기 영업이익이 왜 이렇게 늘었어?" → 2026Q2 하나로 계산해
  // 분석 글이 "비교할 이전 실적이 없어 얼마나 늘었는지 확인하기 어렵다"고 답함
  it("원인 질문에 분기 하나만 적으면 직전 분기를 붙인다 (다른 질문·범위는 그대로)", () => {
    expect(resolvePeriod({ specified: true, text: "2026년 2분기" }, "cause", LATEST)).toMatchObject(
      {
        ok: true,
        period: {
          from: "2026Q1",
          to: "2026Q2",
          specified: true,
          reason: "질문에 지정된 기간: 2026년 2분기 (원인 질문이라 직전 분기와 비교)",
        },
      },
    );
    expect(
      resolvePeriod({ specified: true, text: "2026년 2분기" }, "recent", LATEST),
    ).toMatchObject({ ok: true, period: { from: "2026Q2", to: "2026Q2" } });
    expect(resolvePeriod({ specified: true, text: "2025년" }, "cause", LATEST)).toMatchObject({
      ok: true,
      period: { from: "2025Q1", to: "2025Q4" },
    });
    // 아직 조회 범위 밖인 분기("2026년 3분기", latest=2026Q2)는 넓히지 않고 범위 밖으로 — 2분기만으로 답하지 않는다
    expect(resolvePeriod({ specified: true, text: "2026년 3분기" }, "cause", LATEST)).toEqual({
      ok: false,
      code: "OUT_OF_RANGE",
    });
    // 2016Q1(조회 시작 분기) 하나면 앞 분기가 범위 밖이라 잘린다
    expect(resolvePeriod({ specified: true, text: "2016년 1분기" }, "cause", LATEST)).toMatchObject(
      { ok: true, period: { from: "2016Q1", to: "2016Q1", clipped: true } },
    );
    // 2015년 분기는 OpenDART에 분기보고서가 없어 조회 범위 밖 (Phase 5, EARLIEST_QUARTER 2016Q1)
    expect(resolvePeriod({ specified: true, text: "2015년 1분기" }, "cause", LATEST)).toEqual({
      ok: false,
      code: "OUT_OF_RANGE",
    });
  });

  it("'2013년 매출' → OUT_OF_RANGE", () => {
    const result = resolvePeriod({ specified: true, text: "2013년" }, "recent", LATEST);
    expect(result).toEqual({ ok: false, code: "OUT_OF_RANGE" });
  });
});

// 2026-09-30 운영(분석 97016b86…): "하이브 2023년 1분기부터 2024년 4분기까지" → 분기 범위를 못 읽어 최근 8분기로 계산하던 버그
describe("parsePeriodText — 분기·반기 범위", () => {
  it.each([
    ["2023년 1분기부터 2024년 4분기까지", "2023Q1", "2024Q4"],
    ["2023년 1분기 ~ 2024년 4분기", "2023Q1", "2024Q4"],
    ["2023Q1~2024Q4", "2023Q1", "2024Q4"],
    ["2023Q3-2024Q2", "2023Q3", "2024Q2"],
    ["2023년 1분기부터 3분기까지", "2023Q1", "2023Q3"],
    ["2024년 상반기부터 2025년 하반기까지", "2024Q1", "2025Q4"],
    ["2022년부터 2024년 2분기까지", "2022Q1", "2024Q2"],
    ["2022~2024", "2022Q1", "2024Q4"],
    ["2024년 1~3분기", "2024Q1", "2024Q3"],
    ["2024년 1-3분기", "2024Q1", "2024Q3"],
    ["2023Q1-Q3", "2023Q1", "2023Q3"],
    ["2023Q2~Q4", "2023Q2", "2023Q4"],
  ])("'%s' → %s ~ %s", (text, from, to) => {
    expect(parsePeriodText(text, LATEST)).toEqual({ from, to });
  });

  it("거꾸로 된 범위·알아볼 수 없는 쪽이 있으면 읽지 않는다 (기본 기간으로)", () => {
    expect(parsePeriodText("2024년 4분기부터 2023년 1분기까지", LATEST)).toBeNull();
    expect(parsePeriodText("작년부터 올해까지", LATEST)).toBeNull();
  });

  it("resolvePeriod: 질문에 지정된 분기 범위로 계산한다 (specified)", () => {
    const res = resolvePeriod(
      { specified: true, text: "2023년 1분기부터 2024년 4분기까지" },
      "trend",
      LATEST,
    );
    expect(res).toMatchObject({
      ok: true,
      period: { from: "2023Q1", to: "2024Q4", specified: true },
    });
  });
});
