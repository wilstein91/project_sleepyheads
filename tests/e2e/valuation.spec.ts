import { expect, test, type Page } from "@playwright/test";

// WU-502 화면 (PHASE4_PLAN §3.1): 지표 카드에 시가총액·PER·PBR + "기준일 9월 30일 종가", 적자·자본잠식 표시,
// ⓘ 계산식(TECH §6.4), 결합 경고 줄. 가짜 모드(tests/fixtures/mock/skhynix-valuation.ts) — 1280px·375px 둘 다.

async function openValuation(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("questions-remaining")).toBeVisible();
  await page.getByRole("combobox").fill("SK하이닉스 PER·PBR 알려줘");
  await page.getByRole("button", { name: "질문하기" }).click();
  await page.waitForURL(/\/p\/.+\?analysis=/);
  await expect(page.locator("#chart-c1")).toBeVisible();
}

test("지표 카드에 시가총액·PER·PBR과 주가 기준일이 보인다", async ({ page }) => {
  await openValuation(page);
  const card = page.locator("#chart-c1");
  for (const [metric, value] of [
    ["market_cap", "1,293조 원"],
    ["per", "12.34배"],
    ["pbr", "3.21배"],
  ]) {
    const cell = card.locator(`[data-metric="${metric}"]`);
    await expect(cell).toContainText(value);
    await expect(cell).toContainText("기준일 9월 30일 종가");
  }
  // 분석 기준 바에도 주가 기준일 (투자 리포트에도 같은 글자가 있어 첫 번째 = 분석 기준 바)
  await expect(page.getByText("2026-09-30 종가", { exact: true }).first()).toBeVisible();
});

test("ⓘ를 누르면 TECH §6.4와 같은 계산식이 뜨고, Esc로 닫힌다", async ({ page }) => {
  await openValuation(page);
  const card = page.locator("#chart-c1");
  const cases: [string, string][] = [
    ["PER 계산식", "시가총액 ÷ TTM 지배주주 순이익 (TTM ≤ 0 → 적자)"],
    ["PBR 계산식", "시가총액 ÷ 최근 분기말 지배주주지분 (지분 ≤ 0 → 자본잠식)"],
    ["시가총액 계산식", "기준일 종가 × 상장주식수 (보통주만)"],
  ];
  for (const [name, formula] of cases) {
    const button = card.getByRole("button", { name, exact: true });
    await button.click();
    const tip = page.getByRole("tooltip").filter({ hasText: formula });
    await expect(tip).toBeVisible();
    // 화면 밖으로 나가지 않는다 (375px 포함)
    const box = (await tip.boundingBox())!;
    const width = page.viewportSize()!.width;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await page.keyboard.press("Escape");
    await expect(tip).toBeHidden();
  }
});

test("비교 표: 적자·자본잠식은 그 말 그대로, 주가를 못 붙인 기업은 계산 불가 + 이유", async ({
  page,
}) => {
  await openValuation(page);
  const table = page.locator("#chart-c2").getByRole("table");
  const row = (name: string) => table.getByRole("row").filter({ hasText: name });
  await expect(row("SK하이닉스")).toContainText("12.34배");
  await expect(row("에코프로비엠")).toContainText("적자");
  await expect(row("에코프로비엠")).not.toContainText("계산 불가");
  await expect(row("예시기업")).toContainText("자본잠식");
  await expect(row("카카오")).toContainText("계산 불가 (주가 없음)");
  // 열 머리글의 PER·PBR 옆에도 ⓘ
  await expect(table.getByRole("button", { name: "PER 계산식", exact: true })).toBeVisible();
  await expect(table.getByRole("button", { name: "PBR 계산식", exact: true })).toBeVisible();
});

test("주가 결합을 멈춘 경고가 분석 기준 바에 한 줄로 보인다", async ({ page }) => {
  await openValuation(page);
  await expect(
    page.getByText("주가 결합 중단 — 보통주 종목코드 중복: 카카오(035720·035725)"),
  ).toBeVisible();
});

test("휴대폰 폭에서도 카드·표가 가로로 넘치지 않는다", async ({ page }) => {
  await openValuation(page);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
