import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Explanation } from "@/contracts";
import { skhynixRecent } from "../fixtures/mock/skhynix-recent";

// WU-401 보드 화면이 그려지는지 (첫 화면 HTML만 — 누르기는 e2e board.spec.ts, 통합 때 켠다).
// 필터 막대 + 결과 화면 전체 / 분석 글의 "원래 조건 기준" 안내에 [설명 다시 쓰기]가 붙는 조건.

vi.mock("@/components/session/SessionProvider", () => ({
  useSession: () => ({ applyRemaining: () => {} }),
}));

const { BoardPanel } = await import("@/components/board/BoardPanel");
const { ExplanationPanel } = await import("@/components/result/ExplanationPanel");
const { RewriteContext } = await import("@/components/board/rewrite-context");

const result = skhynixRecent.result!;
const explanation = skhynixRecent.explanation!;
const stale: Explanation = { ...explanation, status: "stale" };

function rewriteControl(phase: "idle" | "confirm" | "pending", notice: string | null = null) {
  return { phase, notice, open: () => {}, cancel: () => {}, confirm: () => {} };
}

describe("BoardPanel 첫 화면", () => {
  it("필터 막대(기간 연도·분기 선택·비교 기업)와 결과 화면의 모든 차트를 그린다", () => {
    const html = renderToStaticMarkup(
      createElement(BoardPanel, { analysisId: "a1", result, explanation }),
    );
    for (const label of ["연도", "분기", "기간 적용", "최근 4개 분기"]) {
      expect(html).toContain(label);
    }
    // 프리셋 버튼(최근 8분기 등)은 없앴다
    for (const label of ["최근 8분기", "최근 3년", "최근 5년", "시작 분기", "끝 분기"]) {
      expect(html).not.toContain(label);
    }
    expect(html).toContain("비교 기업 찾기");
    expect(html).toContain("저장된 보드 조건을 불러오는 중");
    for (const chart of result.charts) expect(html).toContain(`id="chart-${chart.id}"`);
    // 필터를 바꾸기 전에는 "원래 조건 기준" 안내가 없다
    expect(html).not.toContain("원래 조건 기준 설명입니다");
  });

  it("원래 질문의 비교 기업은 칩으로 보여 준다", () => {
    const peer = { ...result.basis.target, stockCode: "005930", name: "삼성전자" };
    const html = renderToStaticMarkup(
      createElement(BoardPanel, { analysisId: "a1", result, explanation, peers: [peer] }),
    );
    expect(html).toContain("삼성전자 빼기");
    expect(html).toContain("비교 기업 1곳");
  });
});

describe("ExplanationPanel [설명 다시 쓰기]", () => {
  const panel = (exp: Explanation) =>
    createElement(ExplanationPanel, {
      explanation: exp,
      charts: result.charts,
      onShowChart: () => {},
    });

  it("보드 밖(비로그인 예시 등)에서는 stale 안내만 있고 버튼은 없다 — 기존 동작 그대로", () => {
    const html = renderToStaticMarkup(panel(stale));
    expect(html).toContain("원래 조건 기준 설명입니다.");
    expect(html).not.toContain("설명 다시 쓰기");
  });

  it("보드 안에서 stale이면 [설명 다시 쓰기] 버튼", () => {
    const html = renderToStaticMarkup(
      createElement(RewriteContext.Provider, { value: rewriteControl("idle") }, panel(stale)),
    );
    expect(html).toContain("설명 다시 쓰기");
  });

  it("확인 단계는 질문 1회가 사용된다고 알린다", () => {
    const html = renderToStaticMarkup(
      createElement(RewriteContext.Provider, { value: rewriteControl("confirm") }, panel(stale)),
    );
    expect(html).toContain("질문 1회가 사용됩니다");
    expect(html).toContain("취소");
  });

  it("설명이 ready면 보드 안이어도 버튼이 없다", () => {
    const html = renderToStaticMarkup(
      createElement(RewriteContext.Provider, { value: rewriteControl("idle") }, panel(explanation)),
    );
    expect(html).not.toContain("설명 다시 쓰기");
  });

  it("실패 안내(AI 장애)를 보여 준다", () => {
    const notice = "기존 설명을 그대로 두었고, 질문 수는 차감되지 않았습니다.";
    const html = renderToStaticMarkup(
      createElement(
        RewriteContext.Provider,
        { value: rewriteControl("idle", notice) },
        panel(stale),
      ),
    );
    expect(html).toContain(notice);
  });
});
