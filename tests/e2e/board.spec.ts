import { expect, test, type Page } from "@playwright/test";

// WU-401 분석 보드: 필터 막대(기간·비교 기업) → 모든 차트·표가 같은 조건으로, "원래 조건 기준 설명" + [설명 다시 쓰기].
// 가짜 모드(src/lib/api-client/mock-boards.ts)로 돈다.
test.describe.configure({ mode: "parallel" });

async function openBoard(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("questions-remaining")).toContainText("20/20");
  await page.getByRole("combobox").fill("SK하이닉스 최근 실적 어때?");
  await page.getByRole("button", { name: "질문하기" }).click();
  await page.waitForURL(/\/p\/.+\?analysis=/);
  await expect(page.getByRole("region", { name: "보드 필터" })).toBeVisible();
  // B1을 다 불러온 뒤에 필터를 누른다
  await expect(filterRegion(page).getByLabel("시작 연도")).toBeEnabled();
}

const filterRegion = (page: Page) => page.getByRole("region", { name: "보드 필터" });

type YQ = [year: number, quarter: 1 | 2 | 3 | 4];

/** 시작 [연도][분기] ~ 끝 [연도][분기] 드롭다운 4개를 고른다 (적용은 하지 않는다) */
async function selectPeriod(page: Page, from: YQ, to: YQ) {
  const filter = filterRegion(page);
  await filter.getByLabel("시작 연도").selectOption(String(from[0]));
  await filter.getByLabel("시작 분기").selectOption(String(from[1]));
  await filter.getByLabel("끝 연도").selectOption(String(to[0]));
  await filter.getByLabel("끝 분기").selectOption(String(to[1]));
}

/** 기간을 고르고 [기간 적용] — 보드 조건이 새 기간으로 바뀔 때까지 기다린다 */
async function pickPeriod(page: Page, from: YQ, to: YQ) {
  await selectPeriod(page, from, to);
  await filterRegion(page).getByRole("button", { name: "기간 적용" }).click();
  await expect(page.getByTestId("board-condition")).toContainText(
    `${from[0]}Q${from[1]}~${to[0]}Q${to[1]}`,
  );
}

const charts = (page: Page) =>
  page.locator('[aria-label="근거 차트"]').locator("section[id^=chart-]");

test("시작·끝 연도·분기로 기간을 바꾸면 모든 분기 차트 제목·표가 같은 기간으로 바뀌고 질문 수는 그대로", async ({
  page,
}) => {
  await openBoard(page);
  await expect(page.getByTestId("questions-remaining")).toContainText("19/20");

  await pickPeriod(page, [2024, 3], [2026, 2]);
  const condition = await page.getByTestId("board-condition").textContent();
  const range = /(\d{4}Q[1-4])~(\d{4}Q[1-4])/.exec(condition ?? "");
  expect(range).not.toBeNull();

  // 카드(최근 분기 실적)를 뺀 모든 차트 제목이 새 기간
  const titled = charts(page).filter({ hasText: /\(\d{4}Q[1-4]~\d{4}Q[1-4]\)/ });
  const count = await titled.count();
  expect(count).toBeGreaterThanOrEqual(2);
  for (let i = 0; i < count; i += 1) {
    await expect(titled.nth(i)).toContainText(`(${range![0]})`);
  }
  // 표로 보기에도 8개 분기
  await titled.first().getByRole("button", { name: "표로 보기" }).click();
  await expect(titled.first().locator("tbody tr")).toHaveCount(8);

  await expect(page.getByTestId("questions-remaining")).toContainText("19/20");
});

test("비교 기업을 넣으면 기업 비교 차트가 생기고, 빼면 사라진다", async ({ page }) => {
  await openBoard(page);
  const filter = page.getByRole("region", { name: "보드 필터" });
  await filter.getByLabel("비교 기업 찾기").fill("삼성전자");
  await filter.getByRole("button", { name: /삼성전자/ }).click();
  await expect(filter.getByRole("list", { name: "고른 비교 기업" })).toContainText("삼성전자");
  await expect(page.locator("#chart-board-peers")).toContainText("삼성전자");

  await filter.getByRole("button", { name: "삼성전자 빼기" }).click();
  await expect(page.locator("#chart-board-peers")).toHaveCount(0);
});

test("긴 기간 + 비교 기업 여러 곳이면 413 안내 — 기간이나 비교 기업 수를 줄이라고 알려 준다", async ({
  page,
}) => {
  await openBoard(page);
  const filter = filterRegion(page);
  for (const name of ["삼성전자", "NAVER"]) {
    await filter.getByLabel("비교 기업 찾기").fill(name);
    await filter.getByRole("button", { name: new RegExp(name) }).click();
    await expect(filter.getByRole("list", { name: "고른 비교 기업" })).toContainText(name);
  }
  await filter.getByLabel("시작 연도").selectOption("2016");
  await filter.getByLabel("시작 분기").selectOption("1");
  await filter.getByRole("button", { name: "기간 적용" }).click();

  const alert = page
    .getByRole("alert")
    .filter({ hasText: "한 번에 계산할 수 있는 양을 넘었습니다" });
  await expect(alert).toContainText("기간이나 비교 기업 수를 줄여 주세요");
  await expect(alert).toContainText("질문 수는 쓰지 않았습니다");
});

test("시작이 끝보다 늦으면 [기간 적용]을 막고 안내한다", async ({ page }) => {
  await openBoard(page);
  await selectPeriod(page, [2026, 1], [2025, 2]);
  const filter = filterRegion(page);
  await expect(filter.getByRole("alert")).toContainText("시작 분기가 끝 분기보다 늦습니다");
  await expect(filter.getByRole("button", { name: "기간 적용" })).toBeDisabled();
});

test("필터를 바꾸면 '원래 조건 기준 설명' — [설명 다시 쓰기]는 질문 1회 확인 뒤 새 설명으로 바꾼다", async ({
  page,
}) => {
  await openBoard(page);
  await expect(page.getByTestId("explanation-stale")).toHaveCount(0);

  await pickPeriod(page, [2024, 3], [2026, 2]);
  const stale = page.getByTestId("explanation-stale");
  await expect(stale).toContainText("원래 조건 기준 설명입니다.");

  await stale.getByRole("button", { name: "설명 다시 쓰기" }).click();
  await expect(stale).toContainText("질문 1회가 사용됩니다");
  await stale.getByRole("button", { name: "질문 1회 쓰고 다시 쓰기" }).click();

  await expect(page.getByTestId("explanation-stale")).toHaveCount(0);
  await expect(page.getByTestId("explanation-main")).toContainText(
    "기준으로 다시 쓴 분석 글입니다",
  );
  await expect(page.getByTestId("questions-remaining")).toContainText("18/20");
});

test("AI 장애면 기존 설명을 그대로 두고 질문 수는 차감되지 않았다고 알려 준다", async ({
  page,
}) => {
  await openBoard(page);
  await page.evaluate(() => window.sessionStorage.setItem("sleepyheads.mock.llmDown", "1"));
  await pickPeriod(page, [2024, 3], [2026, 2]);
  const stale = page.getByTestId("explanation-stale");
  await stale.getByRole("button", { name: "설명 다시 쓰기" }).click();
  await stale.getByRole("button", { name: "질문 1회 쓰고 다시 쓰기" }).click();

  await expect(page.getByTestId("rewrite-notice")).toContainText("기존 설명을 그대로 두었고");
  await expect(page.getByTestId("rewrite-notice")).toContainText("질문 수는 차감되지 않았습니다");
  await expect(stale).toContainText("원래 조건 기준 설명입니다.");
  await expect(page.getByTestId("questions-remaining")).toContainText("19/20");
});

test("필터 상태는 새로 고쳐도 유지된다 (B1)", async ({ page }) => {
  await openBoard(page);
  await pickPeriod(page, [2023, 3], [2025, 4]);
  await page.reload();
  await expect(page.getByTestId("board-condition")).toContainText("2023Q3~2025Q4");
  const filter = filterRegion(page);
  await expect(filter.getByLabel("시작 연도")).toHaveValue("2023");
  await expect(filter.getByLabel("시작 분기")).toHaveValue("3");
  await expect(filter.getByLabel("끝 연도")).toHaveValue("2025");
  await expect(filter.getByLabel("끝 분기")).toHaveValue("4");
  await expect(page.getByTestId("explanation-stale")).toBeVisible();
});

test("보드가 다른 데이터 버전으로 다시 계산되면 위 버전 막대가 '원래 분석' 버전임을 밝힌다 (Phase 5)", async ({
  page,
}) => {
  await openBoard(page);
  const bar = page.getByRole("region", { name: "데이터 버전" });
  await expect(bar).toContainText("데이터 버전");
  await expect(bar.getByTestId("board-version")).toHaveCount(0);

  // 같은 버전이면 그대로
  await pickPeriod(page, [2024, 3], [2026, 2]);
  await expect(bar.getByTestId("board-version")).toHaveCount(0);

  // 새 데이터 버전으로 다시 계산 (서버 boardVersionFlag 흉내)
  await page.evaluate(() => window.sessionStorage.setItem("sleepyheads.mock.boardNewVersion", "1"));
  await pickPeriod(page, [2023, 3], [2026, 2]);
  await expect(bar).toContainText("원래 분석 데이터 버전");
  await expect(bar.getByTestId("board-version")).toContainText("아래 보드 데이터 버전 b0a4d000");
  await expect(bar.getByTestId("board-version-note")).toContainText("원래 분석 기준");
  // 결과 쪽 분석 기준 바에도 서버가 붙인 한 줄
  await expect(page.getByText(/보드 데이터 버전 b0a4d000 — 원래 분석/)).toBeVisible();
});
