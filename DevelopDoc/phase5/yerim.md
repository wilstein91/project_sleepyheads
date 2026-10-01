# Phase 5 보고서 — 예림 (`feat/P5-data`)

트랙 B "데이터 마감" (데이터/서버). 기준: main `83933e1` (Phase 4 병합 + Phase 5 계획). 작성 2026-10-01.

## 무엇을 했나

### 1. WU-502 운영 확인 — **아직 (사람이 확인)**
- 이번 Claude Code 세션에서는 **운영 DB 읽기 조회가 권한 설정에 막혔다**(자동 모드가 운영 데이터 읽기를 거부). 그래서 `get_peers` 기록·`stock_prices`·기업개황 없는 기업 수를 읽지 못했고, 운영 질문 1회("SK하이닉스 PER 알려줘")도 구글 로그인이 필요해 하지 않았다.
- 대신 확인 방법을 정리했다 → 아래 "사람이 확인할 것" 1~3. 운영 질문은 현준님 시연 리허설 Q4와 **같은 질문**이라(DEMO_SCRIPT), 리허설 1회로 함께 보면 AI 토큰을 따로 쓰지 않는다.
- WORK_UNITS WU-502에 "운영 확인 (Phase 5)" 칸을 만들고 아직인 것은 빈 칸으로 두었다.

### 2. 조회 시작 분기 2015Q1 → **2016Q1** (팀 찬성, 2026-10-01)
- `src/lib/ask/quarter.ts` `EARLIEST_QUARTER = "2016Q1"` + 안내용 `EARLIEST_QUARTER_LABEL`("2016년 1분기"). 질문 422(`validate.ts`)·보드 422(`boards/filters.ts`) 문구가 이 값을 따라간다 — 다음에 바꿀 때도 상수 하나만.
- 질문 경로: "2015년 1분기"·"2015년 매출"은 이제 **기간이 범위 밖**. 원인 질문 "2016년 1분기"는 앞 분기(2015Q4)가 잘려 2016Q1 하나.
- 보드 기간 선택 목록(`PeriodFilter`)은 상수를 import해 자동으로 2016Q1부터.
- TECH §4.3·§4.5 + 변경 이력 v0.6.4. 정답 `edge.json#no_report_2015q1`은 엔진 직접 정답으로 남기고 "질문 경로에서는 OUT_OF_RANGE" 메모.
- 테스트: `ask-quarter`(값·라벨, 2015년 전체가 null), `ask-period`, `ask-validate`(문구), `boards-filters`(422 문구 그대로), `api/boards-route`(2016Q1~2026Q2 = 42분기 + 4).

### 3. Phase 4 남긴 리뷰 2건
**① 거래정지 종목 주가 재호출** — 마이그레이션 `20261001200000_p5_price_fetch_state.sql`(새 표, 추가만)
- `price_fetch_state(stock_code, range_to, range_from, row_count, fetched_at)` — 받을 때마다 "이 종목·기간 끝을 받았다 + 기간 안 행 수"를 남긴다. RLS 켬·정책 없음(서버만, `stock_prices`와 같음).
- `loadPrices`: 받은 기록이 **0행**이고 같은 날(지금 기준)·기준일이 지난 뒤(과거 기준)면 다시 부르지 않고 `NO_PRICE`. 행이 있었는데 저장이 안 된 경우(같은 종목·기준일 2행)는 다시 받아 **결합 경고가 계속 나오게** 했다(자체 검토에서 고침).
- **마이그레이션 적용 전에도 안 깨진다**: 표를 못 읽거나 못 쓰면 경고 한 번(프로세스당) 남기고 예전처럼 부른다.

**② 기업개황 영구 실패 기업** — 마이그레이션 `20261001200100_p5_company_profile_failed.sql`(`companies.profile_failed_at`, 추가만)
- `profile.ts`: OpenDART가 개황을 주지 않으면(013) `CompanyProfileUnavailableError`(메시지는 예전과 같음).
- `prefill.ts`: 그 오류만 실패 시각을 남기고 **7일 건너뜀**. 네트워크·키·DB 오류는 남기지 않는다(다음 실행에 다시). `remaining`은 건너뛰는 기업을 세지 않는다. 회원 질문의 기업개황 조회는 이 칸을 보지 않는다.
- 칸이 없으면(Postgres `42703`) 예전처럼 실패 기록 없이 고른다.

### 4. 시연 데이터 미리 받기 — `scripts/warm-demo.mjs` + `src/lib/runner/warm-demo.ts`
- 대상: 현준님 브랜치 `feat/P5-demo`의 **DEMO_SCRIPT §2** — SK하이닉스·삼성전자·한미반도체·DB하이텍 (`DEMO_TARGETS`). 종목코드를 인자로 주면 그 기업만.
- 받는 길은 질문과 같은 앱 코드: `ensureCompanyFinancials`(최신 분기부터 **12분기** — 8분기 추이 + 첫 분기 전년 동기, 보드 3년까지), `loadPrices`(지금 기준 종가), `pickPeers`(SK하이닉스 경쟁사 3곳 → 경쟁사 순서용 전체 시가총액도 받힘). **AI 0건.** 캐시 우선이라 두 번째부터 "이미 있음"(외부 호출 0).
- 자동 선택 경쟁사가 시연 목록과 다르면 ⚠️로 알린다 → DEMO_SCRIPT §2와 `DEMO_TARGETS`를 고치라고.
- 앱 코드가 TypeScript라 **이미 있는 `typescript` 패키지로 그때그때 변환하는 로더**(`registerTsLoader`)를 스크립트 안에 넣었다 — 새 패키지 없음. `refresh-answers.mjs`도 이 로더를 import한다(소유표가 두 스크립트만 허용해 여기 둠).
- **팀 DB에 캐시를 채운다**(질문 한 번이 하는 것과 같은 쓰기). 그래서 이 세션에서는 **운영에 돌리지 않았다** — 가짜로만 확인. 시연 전날·30분 전에 사람이 돌린다(DEMO_SCRIPT §1-3).
- 테스트 `runner-warm-demo.test.ts` 7건(범위 2023Q3~2026Q2, 두 번째 실행 "이미 있음", 11/15 뒤 2026Q3, 경쟁사 다름 경고, 개황 먼저 채우기, 한 기업 실패해도 계속, 주가 실패).

### 5. 정답 다시 구하기 — `scripts/refresh-answers.mjs`
- 정답 파일의 원문(전자공시 보고서)·주가를 **직접 다시 받아** 실제 엔진으로 계산 → 지금 정답과 다른 곳만 표(+ 접수번호가 바뀌었으면 "정정 공시?"). **파일은 고치지 않는다.** 받은 값은 메모리 DB에만 — **팀 DB는 읽지도 쓰지도 않는다**(관리자 클라이언트를 막는 모듈로 바꿔 끼움). AI 0건.
- `--to 2026Q3`: 2026Q2로 끝나는 정답을 옮겨 새 정답 후보 표, `--json`이면 붙여 넣기용 JSON. `--today`: 주가 정답을 지금 시각으로.
- 상세 정답은 `runAnalysis` 그대로, 한 줄 정답은 `tests/regression/engine.ts`의 `valueFromFinancials`(이번에 fixture 없이도 쓰게 나눔 — 회귀 28/28 그대로).
- **실행 결과(2026-10-01)**: 정답 19개·숫자 36개 **모두 같음**. 정답 하나를 일부러 1원 바꾸면 그 줄만 표에 나오는 것도 확인(되돌림).
- 사용법·11/15 이후 순서: `tests/accuracy/ANSWER_KEY.md` §9.

### 6. 분석 글의 PER·PBR 숫자(`TIMES`) 확인 — 가짜 AI
`runner-valuation.test.ts`에 4건(실제 실행기 결과 → `generateExplanationWithUsage`, AI는 가짜):
- AI가 받는 숫자 목록에 PER·PBR이 "0.18배" 같은 표시 글자로 들어간다 ✅
- `{{PER}}` → 서버가 "…배"로 채운다(결론·투자 포인트) ✅
- AI가 숫자를 직접 쓰면("PER은 13배") 그 문장은 버린다 ✅
- 적자 PER("적자")·자본잠식 PBR을 가리키는 문장은 **버려진다**(값이 null) — 지금 동작을 테스트로 고정, 아래 "다른 트랙에 부탁"
- 발견: AI가 `{{f}}배`처럼 단위를 덧붙이면 "8.01배배"가 그대로 나간다(검사 없음) → 부탁

## 완료조건
| 항목 | 근거 |
|---|---|
| 1. WU-502 운영 확인 | **아직** — 운영 DB 읽기 권한 없음, 사람이 확인 (아래 1~3) |
| 2. 조회 시작 분기 | 팀 찬성 → 2016Q1, 위 테스트 |
| 3-① 거래정지 재호출 | `price-daily.test.ts` "받았지만 없음" 6건, `db/phase5-fetch-state.test.ts` 5건(실제 Postgres, RLS, 다시 적용) |
| 3-② 개황 영구 실패 | `companies-prefill.test.ts` +3건 (7일 건너뜀·일시 오류는 기록 안 함·칸 없을 때) |
| 4. warm-demo | `runner-warm-demo.test.ts` 7건, 로더로 실제 모듈 불러오기 확인 |
| 5. refresh-answers | 실제 API로 실행 19/19 같음, 차이 검출 확인, `--to 2026Q3` 확인 |
| 6. TIMES 자리표시자 | `runner-valuation.test.ts` +4건 |

## 자체 검토
- 검사: `pnpm lint` ✅ · `format:check` ✅ · `typecheck` ✅ · `pnpm test` **1,337 통과**(1,310 → +27) · 회귀 **28/28** · `test:e2e` **157 통과**(1 skip).
- `/code-review high` — 7건 중 고친 것 5:
  1. 같은 종목·기준일 2행만 온 종목은 두 번째 요청에서 결합 경고가 사라지고 "가격 없음"이 됨 → 받은 기록은 0행일 때만 씀
  2. warm-demo가 종목코드 행이 둘이면 실패 → 개황 있는 행을 고름
  3. refresh-answers 한 줄 정답 비율을 글자로 비교 → 숫자로
  4. 마이그레이션 전 주가 요청마다 경고 2줄 → 프로세스당 한 번
  5. prefill `remaining`이 7일 건너뛸 기업도 남은 것으로 셈 → 빼고 셈
  - 남긴 것 2: 화면 문구 "2015년 1분기부터"(현준님 파일 → 부탁) · 로더가 warm-demo 스크립트 안에 있음(소유표상 두 스크립트만 — 머리말에 적음)

## 마이그레이션 — **운영 적용 완료 (2026-10-01, 통합 때 대시보드 SQL Editor)**
| 파일 | 내용 | 적용 전 동작 |
|---|---|---|
| `20261001200000_p5_price_fetch_state.sql` | 새 표 `price_fetch_state` + RLS | 받은 기록 없이 예전처럼(경고 1회) |
| `20261001200100_p5_company_profile_failed.sql` | `companies.profile_failed_at` | 실패 기록 없이 예전처럼 |
둘 다 `if not exists` — 여러 번 적용해도 같다(`db/phase5-fetch-state.test.ts`). **시연 전날부터는 적용 금지**(PHASE5_PLAN §1-7) — 적용 못 해도 위처럼 동작은 한다.

## 계약·공유 파일
- 계약(`src/contracts/**`)·잠긴 파일 안 바꿈. 새 패키지 없음.
- 내 소유 밖이지만 고친 것(보고, 테스트만): `tests/unit/board-ui-mock.test.ts`(413 예시 기간을 `EARLIEST_QUARTER`로), `tests/e2e/board.spec.ts`(시작 분기 선택 "2015Q1" → "2016Q1" — 목록에서 2015Q1이 사라져서). 상수가 바뀌어 깨지는 것만 최소로.
- 읽기만 하고 쓴 남의 파일: `tests/unit/helpers/fake-financials-db.ts`·`tests/fixtures/mock/account-map.ts`(refresh-answers의 메모리 DB), `src/lib/explain/**`(6번 테스트).
- 문서: TECH v0.6.4(§4.3·§4.5·§6.6·§15.3·§15.4), API_SPEC C3(실패 기업 7일), WORK_UNITS WU-502 운영 확인 칸 + v0.5.1, ANSWER_KEY §9.

### 다른 트랙에 부탁
- **현준 (화면 문구 "2015")**: 조회 시작 분기가 2016Q1이 됐다. 아래가 아직 "2015년 1분기"라 2015년을 물으면 "2015년 1분기부터 다시 물어봐 주세요"가 나온다 —
  `src/components/ask/errorMessages.ts:52`, `src/components/board/boardErrors.ts:30`("2015년 1분기(2015Q1)부터"), `src/lib/api-client/mock-analysis.ts:154`·`mock-boards.ts:102`(+ 주석 6~7줄), `tests/e2e/ask-result.spec.ts:242`. 가능하면 `EARLIEST_QUARTER_LABEL`(`@/lib/ask/quarter`)을 쓰면 다음에 안 바뀐다. 회귀 케이스 `r11-out-of-period` 제목 "2015년 1분기 이전"도.
- **현준 (분석 글 `explain/**`)**: ① AI가 `{{f3}}배`·`{{f3}}%`처럼 단위를 덧붙이면 "8.01배배"·"+12.3%%"가 그대로 나간다 — 채운 뒤 "배배"·"%%"·"원 원" 같은 단위 겹침을 버리거나 지우는 검사, 또는 프롬프트에 "자리표시자 뒤에 단위를 붙이지 않는다" 한 줄. ② 적자 PER("적자")·자본잠식 PBR을 가리키는 문장은 값이 null이라 버려진다. "PER이 적자라 계산되지 않는다"를 쓰게 하려면 `fillPlaceholders`가 `DEFICIT`·`CAPITAL_IMPAIRMENT`의 display도 흑자전환처럼 글자 값으로 받아야 한다(정할 일 — 지금 동작은 `runner-valuation.test.ts`에 고정, 바꾸면 그 테스트도).
- **병준 (`demo-preflight`)**: 점검 목록에 "warm-demo를 돌렸는지"는 읽기만으로 보려면 `report_fetch_state`에서 DEMO 기업 4곳의 최신 분기 행이 있는지 보면 된다(SK하이닉스 00164779 등, `src/lib/runner/warm-demo.ts` `DEMO_TARGETS`).
- **통합 담당**: 마이그레이션 2개 운영 적용(시연 전날 전까지). `price_fetch_state`는 데이터가 쌓이기만 한다(종목 × 날 한 행) — 정리 필요하면 30일 지난 행 삭제.

## 발견한 것
- 2015년은 사업보고서만 있어 **"2015년 연간" 질문도 이제 범위 밖**이다(팀 결정 때 함께 확인함). 2015 연간이 꼭 필요하면 연간 질문만 사업보고서로 답하는 길을 따로 만들어야 한다.
- 같은 종목·기준일 2행 경우, **2행 말고 다른 날 행도 함께 오면**(예: 9/29 1행 + 9/30 2행) 두 번째 요청은 저장된 9/29 행만 보고 기준일을 9/29로 잡는다 — Phase 4부터 있던 동작(오늘 받은 행이 있으면 다시 안 부름). 드물고 결합 검사가 첫 요청에서 경고하므로 그대로 두었다.

## 사람이 확인할 것
1. **운영 PER 1회** — 현준님 시연 리허설 Q4 "SK하이닉스 PER 알려줘" 때: 카드에 시가총액·PER·PBR + 기준일, 실행 기록 `build_result`에 "주가 결합: 재무 1행 + 주가 1행 → 1행". 결과를 WORK_UNITS WU-502 "운영 확인" 칸에.
2. **경쟁사 시가총액 순** — 리허설 Q3 실행 기록 `get_peers`가 `"시가총액 순 (… 종가)"`인지(아니면 Vercel 로그 `[external-api:price]`). 또는 Supabase SQL 편집기에서 읽기만:
   `select created_at, output_summary from analysis_steps where tool = 'get_peers' order by created_at desc limit 5;`
3. **기업개황 cron** — `select count(*) from companies where profile_checked_at is null;`를 오늘·내일 두 번(하루 약 1,000곳 줄어야 함, Phase 4 때 3,977곳). Vercel Cron 로그의 `filled`·`budget`도.
4. **warm-demo** — 시연 전날·30분 전에 `node scripts/warm-demo.mjs` (두 번째부터 "이미 있음"이면 정상, ⚠️ 경쟁사 다름이면 DEMO_SCRIPT §2 고치기).
5. 이 세션에서 운영 DB를 읽게 하려면 Claude Code 권한 설정에서 허용해야 한다(이번엔 막혀서 1~3을 못 함).
