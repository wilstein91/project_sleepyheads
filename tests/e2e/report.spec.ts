import { expect, test, type Page } from "@playwright/test";

// 투자 리포트 (Phase 5 후속): 기업 하나가 대상인 질문이면 결과 위에 핵심 지표, 차트 아래에 기본정보·주가·재무·
// 밸류에이션·공시 칸이 붙는다. 가짜 모드의 숫자는 실제 API를 한 번 돌린 결과(tests/fixtures/mock/skhynix-report.json)

async function askAndOpen(page: Page, question: string) {
  await page.goto("/");
  await expect(page.getByTestId("questions-remaining")).toBeVisible();
  await page.getByRole("combobox").fill(question);
  await page.getByRole("button", { name: "질문하기" }).click();
  await page.waitForURL(/\/p\/.+\?analysis=/);
}

test("SK하이닉스 질문 → 투자 리포트 핵심 지표(현재가·시가총액·PER·PBR·ROE·52주 범위·최대주주)", async ({
  page,
}) => {
  await askAndOpen(page, "SK하이닉스 최근 실적 어때?");
  const top = page.getByTestId("report-highlights");
  await expect(top.getByRole("heading", { name: "SK하이닉스 투자 리포트" })).toBeVisible();
  for (const [label, value] of [
    ["현재가", "1,776,000원"],
    ["시가총액", "1,297조 3,544억 원"],
    ["PER", "8.01배"],
    ["PBR", "4.94배"],
  ]) {
    await expect(
      top.locator("div", { hasText: label }).filter({ hasText: value }).first(),
    ).toBeVisible();
  }
  await expect(top).toContainText("52주 범위");
  await expect(top).toContainText("최대주주");
  await expect(top).toContainText("주가 기준일 2026-09-30");
});

test("리포트 칸: 주가·재무·밸류에이션에 차트와 계산 메모, 받지 못하는 정보는 그렇다고 밝힌다", async ({
  page,
}) => {
  await askAndOpen(page, "SK하이닉스 최근 실적 어때?");
  const price = page.getByTestId("report-section-price");
  await expect(price.getByRole("heading", { name: "주가·거래" })).toBeVisible();
  await expect(price).toContainText("52주 최고가");
  await expect(price).toContainText("연율 변동성");
  await expect(price.getByRole("heading", { name: /주가 \(최근 1년, 주간 종가\)/ })).toBeVisible();
  await expect(price).toContainText("외국인·기관 순매수, 공매도는 제공하지 않습니다");

  const fin = page.getByTestId("report-section-financials");
  await expect(fin.getByRole("heading", { name: /연간 실적 \(최근 5개 사업연도\)/ })).toBeVisible();
  await expect(fin.getByRole("heading", { name: /현금흐름 \(사업연도\)/ })).toBeVisible();
  await expect(fin).toContainText("유동비율");

  const val = page.getByTestId("report-section-valuation");
  await expect(val).toContainText("과거 평균 PER");
  // 용어(PER)에 한 줄 설명이 끼어 글자가 나뉜다 — 낱말만 본다
  await expect(val).toContainText("vs 과거 평균");
  await expect(val.getByRole("table")).toContainText("한미반도체");
  await expect(val).toContainText("목표주가·투자의견은 제공하지 않습니다");
});

test("리포트 차트도 '표로 보기'가 되고, 가로로 넘치지 않는다", async ({ page }) => {
  await askAndOpen(page, "SK하이닉스 최근 실적 어때?");
  const chart = page.locator("#chart-r2");
  await chart.scrollIntoViewIfNeeded();
  await chart.getByRole("button", { name: "표로 보기" }).click();
  await expect(chart.getByRole("table")).toContainText("1년");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("리포트가 없는 결과(삼성전자 가짜 데이터)는 예전 화면 그대로", async ({ page }) => {
  await askAndOpen(page, "삼성전자의 최근 5년 매출액 추이를 보여줘");
  await expect(page.getByRole("heading", { name: "분석 글" })).toBeVisible();
  await expect(page.getByTestId("report-highlights")).toHaveCount(0);
});
