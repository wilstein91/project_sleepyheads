import { expect, test, type Page } from "@playwright/test";
import { EXPLANATION_LIMITS } from "../../src/contracts/explanation";
import { earliestQuarterLabel } from "../../src/components/ask/errorMessages";

// WU-113(대기화면·결과 화면)·WU-114(남은 질문 수 표시) 완료조건. 가짜 모드(tests/fixtures/mock)로 돈다.

async function ask(page: Page, question: string) {
  await page.goto("/");
  await expect(page.getByTestId("questions-remaining")).toBeVisible();
  await page.getByRole("combobox").fill(question);
  await page.getByRole("button", { name: "질문하기" }).click();
}

async function askAndOpen(page: Page, question: string) {
  await ask(page, question);
  await page.waitForURL(/\/p\/.+\?analysis=/);
}

test.describe("대기화면", () => {
  test("로그인 후 / 에는 입력창과 예시 질문만 있다", async ({ page }) => {
    await page.goto("/");
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { level: 1 })).toHaveText(
      "어느 회사의 무엇이 궁금하세요?",
    );
    await expect(main.getByRole("combobox")).toBeVisible();
    // 예시 질문 칩 4개 + 질문하기 버튼
    await expect(main.getByRole("button")).toHaveCount(5);
    await expect(main.getByRole("link")).toHaveCount(0);
  });

  test("예시 질문 칩은 입력창만 채우고 질문 수를 쓰지 않는다", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("questions-remaining")).toContainText("20/20");
    await page.getByRole("button", { name: "SK하이닉스 최근 실적 어때?" }).click();
    await expect(page.getByRole("combobox")).toHaveValue("SK하이닉스 최근 실적 어때?");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("questions-remaining")).toContainText("20/20");
  });

  test("기업명을 치면 자동완성 후보가 뜨고 Enter로 고를 수 있다", async ({ page }) => {
    await page.goto("/");
    const input = page.getByRole("combobox");
    await input.pressSequentially("삼성");
    const listbox = page.getByRole("listbox", { name: "기업 후보" });
    await expect(listbox.getByRole("option").first()).toContainText("삼성전자");
    await expect(input).toHaveAttribute("aria-expanded", "true");
    await input.press("Enter");
    await expect(input).toHaveValue("삼성전자 ");
    await expect(input).toHaveAttribute("aria-expanded", "false");
  });

  test("비로그인이면 질문 대신 로그인 안내 → 로그인 화면으로 보낸다", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "로그아웃" }).click();
    await expect(page.getByRole("link", { name: "로그인", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "질문하기" }).click();
    const prompt = page.getByRole("dialog", { name: "로그인이 필요합니다" });
    await prompt.getByRole("link", { name: "로그인하러 가기" }).click();
    await expect(page).toHaveURL(/\/login\?next=/);
  });
});

test.describe("결과 화면 — 핵심 통과 테스트", () => {
  test("삼성전자 5년 매출: 왼쪽 표·차트와 오른쪽 분석 글에 같은 숫자, 출처·기간 표시", async ({
    page,
  }, testInfo) => {
    await askAndOpen(page, "삼성전자의 최근 5년 매출액 추이를 보여줘");

    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "삼성전자의 최근 5년 매출액 추이를 보여줘",
    );
    // 분석 기준 바: 기업·기간(선정 이유)·기준 보고서·계산식 버전
    const main = page.getByRole("main");
    await expect(main).toContainText("삼성전자 005930");
    await expect(main).toContainText("질문의 '최근 5년'");
    await expect(main).toContainText("2025 사업보고서 외 4건");
    await expect(main).toContainText("v1");

    // 오른쪽 분석 글 + AI 작성 표시
    const article = page
      .getByRole("article")
      .filter({ has: page.getByText("AI 작성") })
      .last();
    await expect(article).toContainText("315조 원");

    // 왼쪽 차트의 표로 보기 값 = 분석 글의 값
    const chart = page.locator("#chart-c2");
    await chart.getByRole("button", { name: "표로 보기" }).click();
    const table = chart.getByRole("table");
    await expect(table.getByRole("row", { name: /2025년/ })).toContainText("315조 원");
    await expect(table.getByRole("row", { name: /2021년/ })).toContainText("280조 원");
    await expect(chart).toContainText("출처: DART");

    // 넓은 화면은 좌우, 좁은 화면은 차트 → 분석 글 순서로 위아래
    const chartBox = (await page.locator("#chart-c1").boundingBox())!;
    const textBox = (await article.boundingBox())!;
    if (testInfo.project.name === "desktop") {
      expect(textBox.x).toBeGreaterThan(chartBox.x + chartBox.width - 1);
    } else {
      expect(textBox.y).toBeGreaterThan(chartBox.y + chartBox.height);
    }
  });

  test("질문하면 남은 질문 수가 줄어든다", async ({ page }) => {
    await askAndOpen(page, "SK하이닉스 최근 실적 어때?");
    await expect(page.getByTestId("questions-remaining")).toContainText("19/20");
  });

  test("모든 차트에 제목·단위가 있고 표로 보기가 된다", async ({ page }) => {
    await askAndOpen(page, "SK하이닉스 최근 실적 어때?");
    for (const id of ["c2", "c3"]) {
      const chart = page.locator(`#chart-${id}`);
      await expect(chart.getByRole("heading")).not.toBeEmpty();
      await expect(chart.getByRole("img", { name: /표로 보기에서 확인/ })).toBeVisible();
      await chart.getByRole("button", { name: "표로 보기" }).click();
      await expect(chart.getByRole("table")).toBeVisible();
    }
    await expect(page.locator("#chart-c2")).toContainText("조 원");
    await expect(page.getByRole("region", { name: "주요 공시" })).toContainText("신규시설투자등");
  });

  test("투자 포인트의 '차트 보기'를 누르면 왼쪽 차트로 이동한다", async ({ page }) => {
    await askAndOpen(page, "삼성전자의 최근 5년 매출액 추이를 보여줘");
    await page.getByRole("button", { name: /^차트 보기: 삼성전자 매출액 전년 대비/ }).click();
    await expect(page.locator("#chart-c3")).toBeFocused();
    await expect(page.locator("#chart-c3")).toBeInViewport();
  });

  test("분석 글: 결론 + 투자 포인트(긍정·위험·확인할 점, 추정 표시)가 스마트폰 한 화면 안", async ({
    page,
  }, testInfo) => {
    await askAndOpen(page, "SK하이닉스 최근 실적 어때?");
    const main = page.getByTestId("explanation-main");
    await expect(main.getByRole("heading", { name: "투자 포인트" })).toBeVisible();
    for (const label of ["긍정 요인", "위험 요인", "확인할 점"]) {
      await expect(main.getByText(label, { exact: true })).toBeVisible();
    }
    await expect(main.getByText("(추정)")).toBeVisible();

    // 근거 숫자는 접혀 있고, 주의사항은 숨기지 않는다
    const evidence = page.locator("details", { hasText: "근거 숫자" });
    await expect(evidence).not.toHaveAttribute("open");
    await expect(page.getByRole("heading", { name: "주의사항" })).toBeVisible();

    // PRD F-V11: 375px 화면에서 결론 + 투자 포인트가 한 화면(650px) 안
    if (testInfo.project.name === "mobile") {
      const box = (await main.boundingBox())!;
      expect(box.height).toBeLessThanOrEqual(650);
    }
  });

  test("분석 글이 길어도(결론 최대 문장 수·투자 포인트 최대 개수) 결론 앞 3문장은 375px 첫 화면 안, 가로로 넘치지 않는다", async ({
    page,
  }, testInfo) => {
    // 투자 리포트(Phase 5 후속)로 분석 글이 관점별로 길어졌다 — 전체를 한 화면에 넣는 대신, 결론은 첫 화면에서 읽히고
    // 투자 포인트는 아래로 이어 읽는다 (PRD F-V11 개정)
    test.skip(testInfo.project.name !== "mobile", "휴대폰 화면 기준");
    await askAndOpen(page, "SK하이닉스 최근 실적 어때?");
    const main = page.getByTestId("explanation-main");
    await expect(main).toBeVisible();

    const box = await page.evaluate((limits) => {
      const el = document.querySelector('[data-testid="explanation-main"]')!;
      // 실제 문장처럼 띄어쓰기가 있는 글 (띄어쓰기 없는 긴 글자는 줄바꿈 규칙상 줄이 안 나뉜다)
      const filler = "가나다라 마바사 ".repeat(60);
      const conclusionBox = [...el.querySelectorAll("section")][0];
      const conclusion = conclusionBox.querySelector("div")!;
      while (conclusion.children.length < limits.conclusionSentences) {
        conclusion.appendChild(conclusion.lastElementChild!.cloneNode(true));
      }
      // 결론 한 문장은 실제 AI 출력 길이 정도 (2026-10-01 실측 최대 약 70자)
      conclusion.querySelectorAll("p").forEach((p) => (p.textContent = filler.slice(0, 90)));
      const list = el.querySelector("ul")!;
      while (list.children.length < limits.insightsMax) {
        list.appendChild(list.lastElementChild!.cloneNode(true));
      }
      list.querySelectorAll("p").forEach((p) => {
        const label = p.querySelector("span")!.outerHTML;
        p.innerHTML = label + filler.slice(0, limits.insightMaxChars);
      });
      // 결론이 최대 15문장까지 길어질 수 있어(2026-10-01) 첫 화면에는 앞 3문장(질문의 답과 핵심)이 들어와야 한다
      const third = conclusion.querySelectorAll("p")[2];
      return {
        conclusionBottom: third.getBoundingClientRect().bottom - el.getBoundingClientRect().top,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    }, EXPLANATION_LIMITS);

    expect(box.conclusionBottom).toBeLessThanOrEqual(650);
    expect(box.overflow).toBeLessThanOrEqual(0);
  });

  test("사용된 데이터에 행·열 수, 자료형, 기간이 보인다", async ({ page }) => {
    await askAndOpen(page, "삼성전자의 최근 5년 매출액 추이를 보여줘");
    const panel = page.locator("details", { hasText: "사용된 데이터" });
    await expect(panel).toContainText("5행 × 3열");
    await panel.locator("summary").click();
    await expect(panel).toContainText("금액(원)");
    await expect(panel).toContainText("비율(%)");
    await expect(panel.getByRole("table")).toContainText("315,000,000,000,000");
  });
});

test.describe("거절·되묻기·오류 화면이 각각 구분된다", () => {
  test("범위 밖 질문: 차트·분석 글 없이 거절 안내 카드만, 추천 질문 칩이 입력창을 채운다", async ({
    page,
  }) => {
    await askAndOpen(page, "오늘 날씨 어때?");
    const card = page.getByTestId("decline-card");
    await expect(card).toContainText("죄송합니다. 이 서비스는 국내 상장 주식회사의");
    await expect(card).toContainText("질문 1회가 사용되었습니다.");
    await expect(page.getByText("AI 작성")).toHaveCount(0);
    await expect(page.locator("[id^=chart-]")).toHaveCount(0);
    await expect(page.getByTestId("questions-remaining")).toContainText("19/20");

    await card.getByRole("link", { name: "SK하이닉스 최근 실적 어때?" }).click();
    await expect(page.getByRole("combobox")).toHaveValue("SK하이닉스 최근 실적 어때?");
  });

  test("투자 권유 요청: 권유 불가 문구 + 같은 기업의 사실 분석 예시", async ({ page }) => {
    await askAndOpen(page, "삼성전자 지금 사도 돼?");
    const card = page.getByTestId("decline-card");
    await expect(card).toContainText("투자 권유는 드릴 수 없어요");
    await expect(card.getByRole("link")).toContainText("삼성전자 최근 4개 분기 실적과 주요 공시");
  });

  test("기업 없는 주식 질문은 거절이 아니라 되묻기 → 고르면 추가 차감 없이 결과", async ({
    page,
  }) => {
    await askAndOpen(page, "요즘 반도체 회사 실적 어때?");
    await expect(page.getByRole("heading", { name: "어느 회사를 말씀하신 건가요?" })).toBeVisible();
    await expect(page.getByTestId("decline-card")).toHaveCount(0);
    await page.getByRole("button", { name: /SK하이닉스/ }).click();
    await expect(page.getByRole("main")).toContainText("SK하이닉스 000660");
    await expect(page.getByTestId("questions-remaining")).toContainText("19/20");
  });

  test("지원하지 않는 지표: 대기화면에 안내 + 질문 1회 사용 표시", async ({ page }) => {
    await ask(page, "SK하이닉스 직원 만족도 알려줘");
    const alert = page.getByRole("main").getByRole("alert");
    await expect(alert).toContainText("공시 자료로 답할 수 없는 질문입니다");
    await expect(alert).toContainText("질문 1회가 사용되었습니다.");
  });

  test("조회 기간 밖: 가능한 범위 안내", async ({ page }) => {
    await ask(page, "삼성전자 2013년 매출 알려줘");
    await expect(page.getByRole("main").getByRole("alert")).toContainText(
      `${earliestQuarterLabel()}부터`,
    );
  });

  test("AI 장애: 가짜 결과 없이 '지금은 분석할 수 없습니다', 질문 수 차감 없음", async ({
    page,
  }) => {
    await ask(page, "삼성전자 매출 알려줘 AI 장애");
    await expect(page.getByRole("main").getByRole("alert")).toContainText(
      "지금은 분석할 수 없습니다",
    );
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("questions-remaining")).toContainText("20/20");
  });

  test("예상 못 한 서버 오류: '잠시 후 다시 시도' + 요청 ID, 결과 화면으로 가지 않음", async ({
    page,
  }) => {
    await ask(page, "삼성전자 매출 알려줘 서버 오류");
    const alert = page.getByRole("main").getByRole("alert");
    await expect(alert).toContainText("일시적인 서버 오류가 발생했습니다");
    await expect(alert).toContainText("잠시 후 다시 시도");
    await expect(alert.getByTestId("request-id")).toHaveText(/^[0-9a-f-]{36}$/);
    await expect(page).toHaveURL(/\/$/);
  });

  test("공시 조회 실패: 가짜 숫자 없이 실패 안내만", async ({ page }) => {
    await askAndOpen(page, "삼성전자 매출 알려줘 DART 장애");
    await expect(page.getByRole("main").getByRole("status")).toContainText(
      "공시 데이터를 불러오지 못했습니다",
    );
    await expect(page.locator("[id^=chart-]")).toHaveCount(0);
  });

  test("설명 작성만 실패: 차트·표는 보이고 '설명 생성 실패'", async ({ page }) => {
    await askAndOpen(page, "삼성전자의 최근 5년 매출액 추이 설명 실패");
    await expect(page.locator("#chart-c2")).toBeVisible();
    await expect(page.getByText("설명 생성 실패")).toBeVisible();
    await expect(page.getByText("삼성전자 매출액은 2021년")).toHaveCount(0);
  });

  test("섞인 질문: 범위 안 부분만 분석하고 분석 글 끝에 안내", async ({ page }) => {
    await askAndOpen(page, "SK하이닉스 실적이랑 저녁 메뉴 추천해줘");
    await expect(page.locator("#chart-c2")).toBeVisible();
    await expect(page.getByText("관련 없는 부분은 이 서비스의 범위를 벗어나")).toBeVisible();
  });

  test("없는 분석 주소: 찾을 수 없음", async ({ page }) => {
    await page.goto("/p/nothing?analysis=nothing");
    await expect(page.getByRole("main")).toContainText("분석을 찾을 수 없습니다");
  });
});
