import { expect, test, type Page } from "@playwright/test";

// WU-402 완료조건: 차트 규격(제목·축·단위·범례·출처), 색 말고도 구분되는 범례, 키보드로 여는 "표로 보기",
// 재무 용어 한 줄 설명. 가짜 모드(tests/fixtures/mock) — SK하이닉스 결과: c1 카드, c2 막대 2계열, c3 선 1계열.

async function openSkhynix(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("questions-remaining")).toBeVisible();
  await page.getByRole("combobox").fill("SK하이닉스 최근 실적 어때?");
  await page.getByRole("button", { name: "질문하기" }).click();
  await page.waitForURL(/\/p\/.+\?analysis=/);
  await expect(page.locator("#chart-c2")).toBeVisible();
}

test.describe("차트 규격", () => {
  test("차트 종류마다 제목·축·단위·출처가 보인다", async ({ page }) => {
    await openSkhynix(page);

    // 카드: 제목·지표 이름·단위가 붙은 값·출처
    const card = page.locator("#chart-c1");
    await expect(card.getByRole("heading")).toHaveText("2026년 2분기 실적");
    await expect(card.getByRole("definition").first()).toContainText("조 원");
    await expect(card.getByTestId("chart-source")).toHaveText(/^출처: DART/);

    // 막대·선: 제목, X축 이름(분기), Y축 단위, 출처
    for (const [id, unit] of [
      ["c2", "(조 원)"],
      ["c3", "(%)"],
    ]) {
      const chart = page.locator(`#chart-${id}`);
      await expect(chart.getByRole("heading")).toContainText("(2025Q3~2026Q2)");
      const img = chart.getByRole("img", { name: /표로 보기에서 확인/ });
      await expect(img).toContainText("분기");
      await expect(img).toContainText(unit);
      await expect(chart.getByTestId("chart-source")).toHaveText(/^출처: DART .+ 외 3건$/);
    }
  });

  test("Y축 단위 글자가 차트 왼쪽 끝에서 잘리지 않는다 (좁은 화면 포함)", async ({ page }) => {
    await openSkhynix(page);
    for (const id of ["c2", "c3"]) {
      const { left, top } = await page
        .locator(`#chart-${id} text.recharts-label`, { hasText: /^\(.+\)$/ })
        .evaluate((t) => {
          const label = t.getBoundingClientRect();
          const svg = t.closest("svg")!.getBoundingClientRect();
          return { left: label.left - svg.left, top: label.top - svg.top };
        });
      expect(left).toBeGreaterThanOrEqual(0);
      expect(top).toBeGreaterThanOrEqual(0);
    }
  });

  test("2계열 차트만 범례가 있고, 계열마다 무늬가 달라 색 없이도 구분된다", async ({ page }) => {
    await openSkhynix(page);
    const bar = page.locator("#chart-c2");
    const legend = bar.getByRole("list", { name: "범례" });
    await expect(legend.getByRole("listitem")).toHaveCount(2);
    await expect(legend.getByRole("button")).toHaveText(["매출액", "영업이익"]);
    const swatches = legend.locator("svg");
    await expect(swatches.nth(0)).toHaveAttribute("data-pattern", "solid");
    await expect(swatches.nth(1)).toHaveAttribute("data-pattern", "hatch");

    // 차트의 막대도 범례와 같은 채움: 첫 계열은 색, 둘째 계열은 빗금 무늬
    const fills = await bar
      .locator(".recharts-bar-rectangle path")
      .evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute("fill")))]);
    expect(fills).toEqual(["var(--series-1)", "url(#pat-c2-1-s)"]);
    await expect(page.locator("pattern#pat-c2-1-s")).toHaveCount(1);

    // 1계열 차트는 범례가 없다
    await expect(page.locator("#chart-c3").getByRole("list", { name: "범례" })).toHaveCount(0);
  });
});

test.describe("표로 보기 — 키보드", () => {
  test("Tab으로 옮겨 가 Enter로 열고 Space로 닫는다", async ({ page }) => {
    await openSkhynix(page);
    const chart = page.locator("#chart-c2");
    const toggle = chart.getByRole("button", { name: "표로 보기" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    const controls = await toggle.getAttribute("aria-controls");
    expect(controls).toBe("chart-c2-table");

    // 제목 안의 마지막 용어 버튼에서 Tab 한 번 → 표로 보기
    await chart.getByRole("heading").getByRole("button").last().focus();
    await page.keyboard.press("Tab");
    await expect(toggle).toBeFocused();

    await page.keyboard.press("Enter");
    const opened = chart.getByRole("button", { name: "차트로 보기" });
    await expect(opened).toHaveAttribute("aria-expanded", "true");
    await expect(opened).toBeFocused();
    const table = page.locator(`#${controls}`).getByRole("table");
    await expect(table).toBeVisible();
    await expect(table.getByRole("row", { name: /2026년 2분기/ })).toContainText("조 원");

    await page.keyboard.press("Space");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(chart.getByRole("table")).toHaveCount(0);
    await expect(chart.getByRole("img", { name: /표로 보기에서 확인/ })).toBeVisible();
  });
});

test.describe("재무 용어 설명", () => {
  test("마우스를 올리면 한 줄 설명이 뜨고, 치우면 사라진다", async ({ page }) => {
    await openSkhynix(page);
    const term = page.locator("#chart-c3").getByRole("button", { name: "영업이익률" });
    await expect(term).toHaveAccessibleDescription(/100원어치 팔아 본업으로 몇 원/);

    const tip = page.getByRole("tooltip").filter({ hasText: "100원어치" });
    await expect(tip).toBeHidden();
    await term.hover();
    await expect(tip).toBeVisible();
    await page.mouse.move(1, 1);
    await expect(tip).toBeHidden();
  });

  test("키보드로 옮겨 오면 뜨고 Esc로 닫힌다", async ({ page }) => {
    await openSkhynix(page);
    const chart = page.locator("#chart-c3");
    // 표로 보기 버튼에서 Shift+Tab 한 번 → 제목 안의 "영업이익률"
    await chart.getByRole("button", { name: "표로 보기" }).focus();
    await page.keyboard.press("Shift+Tab");
    const term = chart.getByRole("button", { name: "영업이익률" });
    await expect(term).toBeFocused();
    const tip = page.getByRole("tooltip").filter({ hasText: "100원어치" });
    await expect(tip).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(tip).toBeHidden();
  });

  test("누르면(휴대폰 탭) 고정되고, 한 번 더 누르면 닫힌다 — 화면 밖으로 나가지 않는다", async ({
    page,
  }) => {
    await openSkhynix(page);
    // 표 머리글 안의 용어도 가로 스크롤 칸에 잘리지 않고 뜬다
    const chart = page.locator("#chart-c2");
    await chart.getByRole("button", { name: "표로 보기" }).click();
    const term = chart.getByRole("columnheader", { name: "영업이익" }).getByRole("button");
    const tip = page.getByRole("tooltip").filter({ hasText: "본업으로 번 이익" });

    await term.click();
    await page.mouse.move(1, 1);
    await expect(tip).toBeVisible();
    const box = (await tip.boundingBox())!;
    const width = page.viewportSize()!.width;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);

    await term.click();
    await expect(tip).toBeHidden();
  });

  test("지표 카드·분석 기준·사용된 데이터에도 용어 설명이 붙는다", async ({ page }) => {
    await openSkhynix(page);
    await expect(
      page.locator("#chart-c1").getByRole("button", { name: "매출액", exact: true }).first(),
    ).toHaveAccessibleDescription(/물건·서비스를 팔아/);
    await expect(
      page.locator("#chart-c1").getByRole("button", { name: "직전 분기 대비" }),
    ).toHaveAccessibleDescription(/바로 앞 분기와 비교해/);
    await expect(page.getByRole("button", { name: "연결", exact: true }).first()).toBeVisible();

    await page.getByText("사용된 데이터", { exact: true }).click();
    // 투자 리포트 표에도 같은 열이 있어 "사용된 데이터" 안에서만 찾는다 (Phase 5 후속)
    const usedData = page.locator("details", { hasText: "사용된 데이터" });
    await expect(
      usedData.getByRole("columnheader", { name: "영업이익률" }).getByRole("button"),
    ).toHaveAccessibleDescription(/100원어치/);
  });
});
