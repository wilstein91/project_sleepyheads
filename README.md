# sleepyheads — 공시로 답하는 기업 분석

> 국내 상장사에 대해 **한국어로 질문**하면, 전자공시(DART) 숫자로 계산한 **근거 차트(왼쪽)**와 AI가 쓴 **분석 글(오른쪽)**을 함께 보여 주는 서비스입니다.

- 배포 주소: **https://projectsleepyheads.vercel.app** (구글 로그인)
- 작성자: **Sung, Hyun-Joon · Lee, Yelim · ByeongJun Min**
- ⚠️ **비상업 수업 프로젝트**입니다. 광고·유료 기능이 없고, 수익을 목적으로 운영하지 않습니다. 분석 글은 **투자 권유가 아니며** AI가 쓴 글이라 틀릴 수 있습니다.

| 첫 화면 | 결과 화면 (분석 보드 · 좌 차트 / 우 분석 글) |
|---|---|
| ![첫 화면 — 질문 입력창과 예시 질문](DevelopDoc/phase4/img/home.jpg) | ![결과 화면 — 보드 필터로 기간을 바꾼 SK하이닉스 분기별 실적 차트와 다시 쓴 분석 글](DevelopDoc/phase4/img/wu499-board-rewritten.jpg) |

---

## 1. 무엇을 하나

"SK하이닉스 최근 실적 어때?", "직전 분기 대비 영업이익 변화와 감소한 경쟁사 비교해줘"처럼 물으면:

1. AI가 질문을 **분석 요청(기업·지표·기간)** 으로만 바꿉니다 — AI는 계산하지 않습니다.
2. 서버가 OpenDART 재무제표를 받아 **정해진 계산식**으로 지표를 계산합니다 (12월 외 결산은 달력 분기로 환산).
3. 차트·표를 그리고, AI가 그 숫자의 **ID만 가리키는 방식**으로 분석 글(결론 + 투자 포인트)을 씁니다 → 글의 숫자는 항상 차트와 같습니다.

## 2. 주요 기능

| 기능 | 내용 |
|---|---|
| 질문형 분석 | 최근 실적·추이·연간·원인·기업 비교·합계. 기간을 안 적으면 최근 4개 분기 |
| 근거 차트 | 지표 카드·막대·선·표, 제목·축·단위·범례·출처, "표로 보기"(키보드), 재무 용어 한 줄 설명, ⓘ 계산식 |
| 분석 글 | 결론 2문장 + 투자 포인트 2~4개(긍정·위험·확인할 점), 스마트폰 한 화면 분량. 매수·매도 의견·목표주가 금지 |
| 복합 질문 | 분석 계획 카드 → [분석 시작] 승인 → 진행 표시·취소 → 실행 기록. 경쟁사 자동 선택(같은 섹터 시가총액 순) |
| 뉴스 단서 | Google 뉴스 RSS 기사 제목으로 요지를 만들어 "원인"의 참고 단서로만 사용 (본문 저장 없음) |
| 분석 보드 | 기간·비교 기업 필터 → 모든 차트·표를 같은 조건으로 다시 계산(AI·질문 수 사용 없음), [설명 다시 쓰기] |
| 재무 + 주가 결합 | 시가총액·PER·PBR (금융위원회 주식시세, 기준일 종가). 보통주 코드 중복·같은 날 가격 2행이면 결합 중단 + 경고 |
| 저장·재현성 | 프로젝트·분석 저장, 데이터 버전(접수번호로 고정) → 같은 조건 재실행은 같은 숫자 |
| 안전장치 | 범위 밖·투자 권유·조작 시도 질문 정중한 거절, 질문 수 한도(하루 20개), 질문당 AI 비용 상한, 프롬프트 주입 방어 |
| 비로그인 예시 | 첫 화면 아래 SK하이닉스 예시 분석 (매일 새 정기보고서가 있을 때만 다시 만듦) |

## 3. 기술 스택

| 영역 | 사용 |
|---|---|
| 화면·서버 | **Next.js 16** (App Router, `src/proxy.ts`), React 19, TypeScript, Tailwind CSS, Recharts |
| DB·로그인 | **Supabase** (Postgres + RLS, 구글 로그인) — 프로젝트 `sleepyhead` 하나 |
| 배포 | **Vercel** (Hobby, Cron 3개) |
| AI | **OpenAI** Responses API + Structured Outputs — 질문 해석·뉴스 요지 `gpt-6-luna`, 분석 글 `gpt-6-sol` |
| 테스트 | Vitest(단위·정확도·DB·회귀), Playwright(화면 1280px·375px), GitHub Actions (Linux·Windows) |

## 4. 데이터 출처

| 데이터 | 출처 | 비고 |
|---|---|---|
| 기업·재무제표·공시 | 금융감독원 전자공시시스템 **OpenDART** | 수업 워크플로우의 CSV 업로드를 대체 |
| 주가·상장주식수 | 공공데이터포털 **금융위원회_주식시세정보** (출처: 한국거래소) | 이용 조건(출처표시·상업적 이용금지·변경금지)에 따라 비상업적으로만 사용 |
| 뉴스 | **Google 뉴스 RSS** | 기사 제목·언론사·발행일만, 본문 저장·표시 없음. 저작권은 각 언론사 |
| 분석 글 | **OpenAI** | `AI 작성` 표시, 숫자는 서버가 채움 |

## 5. 수업 워크플로우 대응표 (Step 1~5)

| 수업 워크플로우 | 이 프로젝트 | 증거 |
|---|---|---|
| CSV 파일 업로드·미리보기 | **OpenDART 조회로 대체**, 결과 화면의 "사용된 데이터"(행·열·자료형·기간) | [STEP1_PASS_TEST](DevelopDoc/STEP1_PASS_TEST.md) |
| Step 1 첫 분석 | 질문 → 차트 + 분석 글, 오류 안내, AI 장애 시 실패 표시 | [STEP1_PASS_TEST](DevelopDoc/STEP1_PASS_TEST.md) |
| Step 2 저장·전처리·재현성 | 프로젝트·데이터 버전·재실행, 전처리 진단, 소유자 외 404 | [STEP2_PASS_TEST](DevelopDoc/STEP2_PASS_TEST.md) |
| Step 3 계획·실행·검증 | 계획 카드·승인·취소·실행 기록·재시도·상한, 경쟁사·뉴스 | [STEP3_PASS_TEST](DevelopDoc/STEP3_PASS_TEST.md) |
| Step 4 분석 보드·품질 | 필터 연동, 차트 규격, 가상 12만 행 측정·처리 한도 | [STEP4_PASS_TEST](DevelopDoc/STEP4_PASS_TEST.md) |
| Step 5 확장·운영 | 확장 **② 두 데이터셋 결합**(재무+주가), 작업 큐, 회귀 세트, 프롬프트 주입 방어 | [STEP5_PASS_TEST](DevelopDoc/STEP5_PASS_TEST.md), [회귀 결과](tests/regression/RESULTS.md) |
| (추가) | 뉴스 단서, 서비스 범위 밖 질문 거절 | |

**구현 제외 항목** (PRD §11.2)

| 제외 | 사유 | 대신 증명 |
|---|---|---|
| CSV 업로드·빈 파일·허용 크기 초과 | 파일 업로드 없음 (OpenDART로 대체) | 데이터 없음·기간/기업 수 초과 오류 안내 |
| 결과 내보내기, 내보낸 CSV 수식 주입 처리, "내려받은 파일 회수 불가" | **다운로드 기능 없음** | — |
| 열람자/편집자 권한, 공유 해제 후 접근 차단 | **외부 공유 기능 없음** | 소유자 외 접근 차단 (서버 검사 + RLS, 남의 ID는 404) |

## 6. 로컬에서 실행하기

준비물: **Node.js 24**(`.nvmrc`), **pnpm** (`corepack enable`로 켜짐), Git

```bash
git clone git@github.com:wilstein91/project_sleepyheads.git
```

```bash
cd project_sleepyheads
```

```bash
pnpm install
```

키 없이 화면만 보려면 **가짜 모드**: `.env.example`을 `.env.local`로 복사하고 `NEXT_PUBLIC_API_MOCK=1`만 채운 뒤

```bash
pnpm dev
```

→ http://localhost:3000 (화면 맨 위에 "개발용 가짜 데이터로 동작 중입니다" 줄이 보이면 성공. 서버 API·외부 키 없이 `tests/fixtures/mock/` 데이터로 동작)

실제 데이터로 돌리려면 `.env.local`에 아래 키를 모두 채우고 확인:

```bash
pnpm check:keys
```

(항목마다 ✅가 나오면 준비 끝)

| 명령 | 하는 일 |
|---|---|
| `pnpm lint` · `pnpm format:check` · `pnpm typecheck` | 검사 (ESLint · Prettier · TypeScript) |
| `pnpm test` | 단위·정확도·DB 테스트 |
| `pnpm test:e2e` | 화면 테스트 (가짜 모드로 빌드, 1280px·375px) |
| `pnpm exec vitest run -c tests/regression/vitest.config.mts` | 회귀 세트 (AI 고정 응답, 비용 0) |

## 7. 환경변수 (이름만 — 값은 `.env.local`·Vercel에만)

| 이름 | 공개 | 용도 |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | 공개 | Supabase 주소·공개 키 |
| `SUPABASE_SECRET_KEY` | 🔒 | 서버 전용 관리자 키 |
| `OPENDART_API_KEY` | 🔒 | OpenDART |
| `DATA_GO_KR_SERVICE_KEY` | 🔒 | 공공데이터포털 주식시세 |
| `OPENAI_API_KEY` | 🔒 | OpenAI — 쉼표로 여러 개 넣으면 잔액이 떨어진 키 다음 키를 씀 |
| `OPENAI_MODEL` | 서버 | 질문 해석·뉴스 요지 모델 (기본 `gpt-6-luna`) |
| `OPENAI_EXPLAIN_MODEL`, `OPENAI_EXPLAIN_DAILY_BUDGET_USD` | 서버 | 분석 글 모델(기본 `gpt-6-sol`)과 하루 예산(기본 $1, 넘으면 그날은 `gpt-6-luna`). 로컬은 `OPENAI_EXPLAIN_MODEL=gpt-6-luna` 권장 |
| `CRON_SECRET` | 🔒 | Vercel Cron 호출 인증 (16자 이상 무작위) |
| `NEXT_PUBLIC_API_MOCK` | 개발 | `1`이면 가짜 모드 (운영 배포에서는 넣어도 꺼짐) |

🔒 값은 `NEXT_PUBLIC_`을 붙이지 않습니다(브라우저에 공개됨). `.env*`는 저장소에 올라가지 않습니다.

## 8. 문서

| 문서 | 내용 |
|---|---|
| [PRD](DevelopDoc/PRD.md) | 제품 요구사항 |
| [TECH_SPEC](DevelopDoc/TECH_SPEC.md) | 기술 명세 (계산식 §6.4, AI 안전장치 §11.5, 보안 §17) |
| [API_SPEC](DevelopDoc/API_SPEC.md) | 서버 API |
| [WORK_UNITS](DevelopDoc/WORK_UNITS.md) | 작업 단위·완료조건 |
| [HANDOFF](HANDOFF.md) | 팀 업무분장·현재 상태 (새로 합류하면 §0부터) |
| [FINAL_CHECKLIST](DevelopDoc/FINAL_CHECKLIST.md) | 최종 점검표 |
| [USER_TEST](DevelopDoc/USER_TEST.md) | 사용자 테스트 진행표 |

## 9. 운영 메모

### 9.1 시연 전 점검 — Supabase 일시정지 해제
Supabase 무료 플랜은 **7일 동안 활동이 적으면 프로젝트를 일시정지**합니다 (약 1주 전 경고 메일, 정지 후 확인 메일. 정지 후 1년 안에는 대시보드에서 되살릴 수 있음 — [Supabase 공식 문서](https://supabase.com/docs/guides/platform/free-project-pausing), 2026-10-01 확인).

1. https://supabase.com/dashboard 에 로그인 → 조직 → `sleepyhead` 프로젝트를 누릅니다.
2. 일시정지 상태면 **Resume project**를 누르고 확인합니다. 데이터·설정은 그대로 돌아옵니다 (몇 분 걸림).
3. 확인: 배포 주소 첫 화면 아래 SK하이닉스 예시가 보이고, 로컬에서 `pnpm check:keys`의 Supabase 2줄이 ✅

4. **한 번에 점검** (읽기만): `node scripts/demo-preflight.mjs` — 배포 첫 화면·비로그인 예시·키 유무·오늘 AI 비용과 전자공시·주가 호출 수·1시간 넘게 멈춘 분석·크론 3개의 마지막 실행을 ✅/⚠️로 보여 줍니다(키 값은 출력하지 않음, ⚠️가 있으면 종료 코드 1). 운영 DB 항목은 `.env.local`에 운영 Supabase 주소·서버 키가 있는 PC에서만 나옵니다. 키를 실제로 불러 보려면 `--keys`(키마다 호출 1회 — AI 토큰을 조금 쓰니 시연 당일 1번만). 판정 기준·⚠️일 때 할 일: [OPS_RUNBOOK](DevelopDoc/OPS_RUNBOOK.md) §2
5. **시연 데이터 미리 받기** (AI 0): `node scripts/warm-demo.mjs` — 시연 기업(DEMO_SCRIPT §2)의 보고서·주가를 미리 받아 첫 조회 지연을 없앱니다. 두 번째부터 "이미 있음"이면 정상, ⚠️ 경쟁사 다름이면 DEMO_SCRIPT §2를 고칩니다. 팀 DB에 캐시를 채우는 쓰기라 시연 전날·30분 전에 한 번씩. 그 뒤 시연 질문을 **시연 계정으로 한 번씩 미리** 해 두면 시연 때 분석 글이 재사용돼 빨라집니다(질문당 AI 2회 — 리허설과 같이)
6. **DB 백업 1회** (무료 플랜은 자동 백업 없음): `bash scripts/db-backup.sh` — Docker Desktop·Supabase 로그인 필요, 저장소 밖 폴더에 저장. 복구 순서: OPS_RUNBOOK §1

시연 전날부터 끝날 때까지 **DB 구조 마이그레이션은 적용하지 않습니다.**

### 9.2 한도 값 바꾸기 (코드 수정·배포 없이)
한도는 DB 표 `quota_config`에 있습니다 (기본값 `supabase/seed.sql`). Supabase 대시보드 → 프로젝트 → **SQL Editor**에서 바꿉니다. 예: 회원별 하루 질문 수를 30으로

```sql
update quota_config set value = 30 where key = 'questions_per_day';
```

| key | 기본값 | 뜻 |
|---|---|---|
| `questions_per_day` | 20 | 회원별 하루 질문(후속 질문·설명 다시 쓰기 포함) |
| `llm_questions_per_day_global` | 300 | 서비스 전체 하루 AI 사용 질문 |
| `max_llm_cost_usd_per_question` | 0.10 | 질문당 AI 비용 상한(USD) — 투자 리포트 + 결론 최대 15문장 분석 글 |
| `max_seconds_per_question` | 90 | 질문당 실행 시간 상한(초) |
| `dart_global_soft_limit` / `dart_global_hard_limit` | 16000 / 19000 | OpenDART 전체 하루 호출 |
| `max_declines_per_day` | 10 | 회원별 하루 거절 상한 |

⚠️ 운영 DB를 바로 바꾸는 일이라 되돌리려면 같은 문장으로 원래 값을 다시 넣습니다.

### 9.3 키 재발급 (한 번이라도 노출된 키)
1. 새 키를 발급합니다.
   - **Supabase 비밀 키**: 대시보드 → 프로젝트 → **Settings > API Keys**에서 새 secret key를 만들고, 옛 키는 새 키로 바꾼 뒤 삭제 ([공식 문서](https://supabase.com/docs/guides/getting-started/api-keys))
   - **OpenAI**: https://platform.openai.com/api-keys 에서 새 키를 만들고 옛 키를 지웁니다. (이 메뉴 이름은 2026-10-01에 공식 도움말 접근이 막혀 확인하지 못했습니다 — 화면이 다르면 OpenAI Platform 설정에서 `API keys`를 찾으세요)
   - **OpenDART·공공데이터포털**: 각 사이트의 인증키 관리 화면에서 재발급
2. Vercel → 프로젝트 → 사이드바 **Environment Variables** → 해당 이름 오른쪽 점 세 개 → 값 수정 → **Save** ([공식 문서](https://vercel.com/docs/environment-variables/managing-environment-variables))
3. **다시 배포**해야 새 값이 적용됩니다: 사이드바 **Deployments** → 맨 위 배포 오른쪽 점 세 개 → **Redeploy** → 창에서 다시 **Redeploy** ([공식 문서](https://vercel.com/docs/deployments/managing-deployments), 2026-10-01 확인).
4. 로컬 `.env.local`도 바꾸고 `pnpm check:keys`로 확인합니다.

### 9.4 비로그인 예시 다시 만들기
첫 화면 아래 예시는 Vercel Cron이 매일 04시(KST)에 **SK하이닉스 정기보고서가 새로 나왔을 때만** 다시 만듭니다. 손으로 다시 만들려면(AI 2회 사용):

```bash
curl -H "Authorization: Bearer $CRON_SECRET" "https://projectsleepyheads.vercel.app/api/cron/refresh-guest-example?force=1"
```

설명 작성이 실패하면 저장하지 않고 이전 예시를 그대로 둡니다.

### 9.5 보안·운영 점검 결과 (WU-505, 2026-10-01 — 자세히는 [SECURITY_CHECK](DevelopDoc/SECURITY_CHECK.md))
- **자동 확인 ✅**: 브라우저 번들(운영 JS 포함)에 서버 키 0건 · 저장소·커밋 기록에 비밀 값 0건 · 운영 표 32개 모두 RLS, 회원 표는 본인 정책만 · 권한이 센 DB 함수(SECURITY DEFINER) 8개는 회원이 직접 못 부름 · 뉴스 본문은 DB·로그에 없음
- **남용 방어 ✅**: 분당 요청 제한, 회원 하루 질문 수, 외부 API 전체 상한, 질문당 단계·시간·AI 비용 상한
- **사람이 확인할 것 👤**: Supabase 이메일 가입 꺼짐 · Site URL·Redirect URL과 구글 OAuth 리디렉션 주소 · OpenAI 키별 월 예산 상한 · Vercel 사용량
- **⚠️ 무료 플랜은 자동 백업이 없다** — 시연 전 `supabase db dump`로 한 번 내려받아 보관
- **Security Advisor 경고 2개는 근거를 적고 남김**: `pg_trgm` 확장이 public 스키마 — 권한이 센 함수가 아니라 위험이 낮고, 옮기면 기업 찾기(유사도 검색)가 깨질 수 있어 시연 뒤로 / 유출 비밀번호 보호 꺼짐 — 비밀번호 로그인을 쓰지 않아 해당 없음
- **비밀 값 검사 도구(`secretlint`)의 1건은 오탐**: `tests/unit/news-safety.test.ts`의 `https://아이디:비밀번호@…` 가짜 주소(이런 주소를 거절하는지 보는 테스트)
- **오래 멈춘 분석 정리 (WU-501)**: 1시간 넘게 진행이 없는 "분석 중" 분석은 그 회원이 다음에 질문할 때 정리된다(결과가 있으면 부분 결과, 없으면 실패). 그 안에 다시 열면 마지막 성공 단계 다음부터 이어서 한다
- 다시 점검: `node scripts/security-check.mjs --url https://projectsleepyheads.vercel.app` — 끝에 ✅면 통과, ⚠️면 걸린 파일·커밋 위치만 나온다(키 값은 출력하지 않음, 종료 코드 1)
