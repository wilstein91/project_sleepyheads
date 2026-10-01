import { expect, test } from "@playwright/test";
import { MOCK_FILING_CLUES } from "../fixtures/mock/filing-clues";

// 공시 원문 근거 화면 (2026-10-01). 가짜 모드에서 질문에 "원문"이 들어가면 SK하이닉스 결과에 단락 2개가 붙는다.

async function openFilingResult(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(page.getByTestId("questions-remaining")).toBeVisible();
  await page.getByRole("combobox").fill("SK하이닉스 최근 실적을 공시 원문 근거로 설명해줘");
  await page.getByRole("button", { name: "질문하기" }).click();
  await page.waitForURL(/\/p\/.+\?analysis=/);
  const section = page.getByTestId("filing-clues");
  await expect(section).toBeVisible();
  return section;
}

test.describe("공시 원문 근거", () => {
  test("보고서·목차·한 줄 설명·원문 단락(펼침)·DART 링크(새 탭)", async ({ page }) => {
    const section = await openFilingResult(page);
    await expect(section.getByRole("heading", { name: "공시 원문 근거" })).toBeVisible();

    const items = section.getByTestId("filing-clue");
    await expect(items).toHaveCount(MOCK_FILING_CLUES.length);

    const first = items.nth(0);
    await expect(first).toContainText(MOCK_FILING_CLUES[0].reportName);
    await expect(first).toContainText(MOCK_FILING_CLUES[0].relevance);
    // 원문 단락은 접혀 있다가 펼치면 원문 글자 그대로
    const excerptLine = MOCK_FILING_CLUES[0].excerpt.split("\n")[0];
    await expect(first.getByText(excerptLine)).toBeHidden();
    await first.getByText("원문 단락 보기").click();
    await expect(first.getByText(excerptLine)).toBeVisible();

    const link = first.getByRole("link", { name: /DART에서 보고서 전체 보기/ });
    await expect(link).toHaveAttribute("href", MOCK_FILING_CLUES[0].url);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  test("투자 포인트의 [원문 n] 버튼을 누르면 그 단락으로 이동한다", async ({ page }) => {
    await openFilingResult(page);
    await page.getByRole("button", { name: "근거 공시 원문 2번 보기" }).click();
    await expect(page.locator("#filing-clue-d2")).toBeFocused();
  });
});
