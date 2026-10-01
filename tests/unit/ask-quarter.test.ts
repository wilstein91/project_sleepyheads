import { describe, expect, it } from "vitest";
import {
  addQuarters,
  clipToAvailableRange,
  compareQuarters,
  EARLIEST_QUARTER,
  EARLIEST_QUARTER_LABEL,
  formatQuarter,
  latestAvailableQuarter,
  parseQuarter,
  quarterSpan,
} from "@/lib/ask/quarter";

describe("조회 시작 분기 (TECH §4.3)", () => {
  it("2016Q1 — OpenDART 재무 API에 2015년 분기보고서가 없다 (Phase 5 팀 결정)", () => {
    expect(EARLIEST_QUARTER).toBe("2016Q1");
    expect(EARLIEST_QUARTER_LABEL).toBe("2016년 1분기");
  });
});

describe("quarter 산술", () => {
  it("parseQuarter/formatQuarter가 왕복한다", () => {
    expect(parseQuarter("2026Q2")).toEqual({ year: 2026, q: 2 });
    expect(formatQuarter(2026, 2)).toBe("2026Q2");
  });

  it("addQuarters는 연도 경계를 넘나든다", () => {
    expect(addQuarters("2026Q1", -1)).toBe("2025Q4");
    expect(addQuarters("2025Q4", 1)).toBe("2026Q1");
    expect(addQuarters("2026Q2", -3)).toBe("2025Q3");
  });

  it("compareQuarters는 순서를 매긴다", () => {
    expect(compareQuarters("2025Q1", "2025Q2")).toBeLessThan(0);
    expect(compareQuarters("2025Q2", "2025Q1")).toBeGreaterThan(0);
    expect(compareQuarters("2025Q2", "2025Q2")).toBe(0);
  });

  it("quarterSpan은 양끝을 포함한 개수다", () => {
    expect(quarterSpan("2025Q3", "2026Q2")).toBe(4);
    expect(quarterSpan("2026Q2", "2025Q3")).toBe(0);
  });

  it("latestAvailableQuarter는 보고서 제출 기한이 지난 가장 최근 분기다", () => {
    const at = (kst: string) => latestAvailableQuarter(new Date(`${kst}+09:00`));
    // 2026-09-29(3Q 안): 2Q 반기보고서 기한(8/14)이 지났다
    expect(at("2026-09-29T00:00:00")).toBe("2026Q2");
    // 10/1~11/14: 3Q는 끝났지만 분기보고서 기한 전 → 여전히 2Q (2026-10-01 운영에서 3Q를 잡던 버그)
    expect(at("2026-10-01T00:00:00")).toBe("2026Q2");
    expect(at("2026-11-14T23:59:00")).toBe("2026Q2");
    expect(at("2026-11-15T00:00:00")).toBe("2026Q3");
    // 한국 시간 기준: UTC로는 아직 11/14여도 한국이 11/15면 3Q
    expect(latestAvailableQuarter(new Date("2026-11-14T15:00:00Z"))).toBe("2026Q3");
    // 4Q 사업보고서는 90일 → 다음 해 3/31까지는 3Q, 4/1부터 4Q
    expect(at("2026-01-15T00:00:00")).toBe("2025Q3");
    expect(at("2026-03-31T23:59:00")).toBe("2025Q3");
    expect(at("2026-04-01T00:00:00")).toBe("2025Q4");
    // 1Q는 5/15 기한 → 5/16부터, 2Q는 8/14 기한 → 8/15부터
    expect(at("2026-05-15T12:00:00")).toBe("2025Q4");
    expect(at("2026-05-16T00:00:00")).toBe("2026Q1");
    expect(at("2026-08-14T12:00:00")).toBe("2026Q1");
    expect(at("2026-08-15T00:00:00")).toBe("2026Q2");
  });

  describe("clipToAvailableRange", () => {
    const latest = "2026Q2" as const;

    it("범위 안이면 그대로", () => {
      expect(clipToAvailableRange("2025Q3", "2026Q2", latest)).toEqual({
        from: "2025Q3",
        to: "2026Q2",
        clipped: false,
      });
    });

    it("시작이 2016Q1보다 이르면 잘라내고 clipped=true", () => {
      expect(clipToAvailableRange("2010Q1", "2016Q4", latest)).toEqual({
        from: EARLIEST_QUARTER,
        to: "2016Q4",
        clipped: true,
      });
    });

    it("전부 2016Q1 이전이면 null (OUT_OF_RANGE) — 2015년도 (분기보고서 없음)", () => {
      expect(clipToAvailableRange("2010Q1", "2013Q4", latest)).toBeNull();
      expect(clipToAvailableRange("2015Q1", "2015Q4", latest)).toBeNull();
    });

    it("from이 latest보다 미래면 null", () => {
      expect(clipToAvailableRange("2027Q1", "2027Q4", latest)).toBeNull();
    });

    it("to가 latest를 넘으면 latest로 잘라내고 clipped=true", () => {
      expect(clipToAvailableRange("2026Q1", "2027Q4", latest)).toEqual({
        from: "2026Q1",
        to: latest,
        clipped: true,
      });
    });
  });
});
