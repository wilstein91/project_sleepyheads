# OPS_RUNBOOK — 운영 절차 (백업·복구·시연 전 점검·사용자 테스트 데이터)

| 항목 | 내용 |
|---|---|
| 작성 | 병준 (Phase 5 트랙 A, Claude Code) — 2026-10-01 |
| 대상 | 운영 https://projectsleepyheads.vercel.app · Supabase `sleepyhead` 하나(로컬·Preview·운영 공용, API_SPEC §7.1) · Vercel Hobby |
| 원칙 | 운영 DB에서 **쓰기(지우기·복구·마이그레이션)는 사람이, 팀이 정한 뒤**. 자동 스크립트는 읽기만. 키·회원 이메일은 이 문서·채팅에 적지 않는다 |

---

## 1. DB 백업·복구 (무료 플랜은 자동 백업이 없다 — [Supabase Backups](https://supabase.com/docs/guides/platform/backups))

### 1.1 백업 (👤 시연 전 1회 + 사용자 테스트 전 1회)
준비(한 번만): **Docker Desktop 켜기**(CLI가 컨테이너 안에서 `pg_dump`를 돌린다), `pnpm dlx supabase login`, `pnpm dlx supabase link --project-ref <ref>`(대시보드 Project Settings).

```bash
bash scripts/db-backup.sh
```
- `../sleepyheads-backups/<날짜-시각>/`에 `roles.sql`·`schema.sql`·`data.sql` (저장소 **밖**. 안을 주면 스크립트가 거부한다)
- 명령은 Supabase 공식 [Backup and Restore using the CLI](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)와 같다 (`--role-only` / 기본 / `--use-copy --data-only -x storage.buckets_vectors -x storage.vector_indexes`)
- **회원 데이터가 들어 있다** — 개인 드라이브에만. 저장소·채팅·공유 폴더 금지

### 1.2 복구 (운영에 바로 하지 않는다)
1. **로컬에서 먼저 리허설**: `pnpm dlx supabase start`(Docker) → 아래 명령의 `--dbname`을 로컬 주소(`postgresql://postgres:postgres@127.0.0.1:54322/postgres`)로
2. 공식 순서 그대로 (roles → schema → 트리거 끄기 → data, 한 트랜잭션):
   ```bash
   psql --single-transaction --variable ON_ERROR_STOP=1 \
     --file roles.sql --file schema.sql \
     --command 'SET session_replication_role = replica' \
     --file data.sql --dbname "<연결 주소>"
   ```
3. 확인: 로컬 앱(`.env.local`을 로컬 주소로)에서 비로그인 예시·로그인 뒤 내 분석 목록이 보이는지
4. 운영이 망가졌을 때만, 팀이 정하고 **새 Supabase 프로젝트**에 복구한 뒤 Vercel 환경변수를 바꾼다(기존 운영 DB 위에 덮어쓰지 않는다)

---

## 2. 시연 전 점검 (읽기만)
```bash
node scripts/demo-preflight.mjs            # 배포 + 운영 DB 읽기 (운영 키가 .env.local에 있어야 DB 항목이 나온다)
node scripts/demo-preflight.mjs --keys     # + 키마다 실제 호출 1회 (AI 토큰을 조금 쓴다 — 시연 당일 1번만)
```
| 항목 | ✅ 기준 | ⚠️면 |
|---|---|---|
| 첫 화면 · 비로그인 예시(G1) | HTTP 200 · 예시 있음 | Vercel 배포·Supabase 일시정지(README §9.1)·예시 다시 만들기(README §9.4) |
| 이 PC의 키 | 7개 있음 (값 출력 없음) | — 표시는 실패가 아님 (운영 키는 Vercel) |
| 오늘 AI 비용 | $1 이하 | 키 잔액 확인. 키 3개(각 약 5천 원)라 하루 $1이면 며칠 못 간다 |
| 오늘 전자공시·주가 호출 | 전자공시 16,000회 이하 | 하루 한도 20,000 근처 — 시연 질문을 미리 받아 둔 기업으로 |
| 1시간 넘게 멈춘 분석 | 0건 | 그 회원이 다음 질문하면 정리(WU-501). 시연 계정이면 시연 전 질문 1건 |
| 기업 목록 동기화 | 최근 30시간에 2,000곳 이상 갱신 (동기화는 약 4,000곳을 한 번에 — 마지막 시각만 보면 질문 때 개황 채우기와 섞이고, 개황 미리 채우기 cron도 하루 1,000곳까지 바꾼다) | Vercel Cron 로그(Deployments → Functions) |
| 기업개황 채움 흔적 | 참고용(—) — 크론과 질문 때 채운 것이 섞여 크론 여부는 로그로 | 같은 곳 |
| 비로그인 예시 생성 | 예시 있음 | 새 보고서가 있을 때만 다시 만들어서 오래돼도 정상 |

## 3. Vercel Cron (Hobby) — 한도 안에 있다
[Vercel 공식 문서](https://vercel.com/docs/cron-jobs/usage-and-pricing)(2026-07-15판, 2026-10-01 확인): Hobby는 **프로젝트당 100개**, **하루 1번까지**, 시각은 **±59분**.

| 크론 (`vercel.json`) | 주기 | 판정 |
|---|---|---|
| `sync-companies` `0 18 * * *` (03시 KST) | 하루 1번 | ✅ |
| `prefill-profiles` `30 18 * * *` (03시 30분 KST) | 하루 1번 | ✅ |
| `refresh-guest-example` `0 19 * * *` (04시 KST) | 하루 1번 | ✅ |

- 3개 모두 하루 1번이라 **배포가 거부되지 않는다** → `prefill-profiles`를 `sync-companies` 끝에 붙일 필요 없음.
- 단 **±59분이라 순서가 보장되지 않는다**(예: 동기화가 03:50, 개황 채우기가 03:31에 돌 수 있음). 세 작업은 서로의 결과를 기다리지 않아(개황 채우기는 그 시각의 기업 목록으로, 예시는 그 시각의 보고서로) 순서가 바뀌어도 하루 늦어질 뿐이다.

## 4. Supabase 하나 쓰는 것 — 사용자 테스트(WU-599) 전 재검토 (결정은 팀)
| 안 | 내용 | 좋은 점 | 걱정 |
|---|---|---|---|
| **A. 그대로 하나 (제안)** | 테스트 회원도 운영 DB에 가입 → 끝나면 그 회원들만 지운다 | 설정 그대로, 시연 직전 바꿀 것이 없다. 회원끼리는 RLS로 서로 못 본다(owner-rls·owner-routes 테스트) | 테스트 질문이 하루 질문 수·AI 비용·전자공시 한도를 같이 쓴다 → 테스트 날은 시연 연습을 피한다 |
| B. 테스트용 프로젝트 따로 | 무료 프로젝트 하나 더 + Vercel Preview 환경변수 | 운영 데이터와 완전히 분리 | 마이그레이션·seed·구글 OAuth·Redirect URL을 두 곳에 맞춰야 하고, 무료 프로젝트는 7일 비활성 일시정지도 두 개 |

**A를 고르면 끝난 뒤 지우는 순서** (👤 팀 결정 후 사람이, 테스트 회원만):
1. 읽기로 대상 확인 — 팀원 계정은 빼고, 테스트 참가자 이메일로만:
   ```sql
   select id, email, created_at from profiles
   where email = any (array['참가자1@…', '참가자2@…'])   -- 이메일은 문서에 적지 말고 실행할 때만
     and created_at >= '2026-11-..';                        -- 테스트 시작 날짜
   ```
2. 지우기 — 탈퇴(A6)와 같은 길: **Supabase 대시보드 → Authentication → Users → 그 사용자 → Delete user**. 로그인 계정이 지워지면 `profiles`와 회원 데이터 표 8개(projects·analyses·analysis_steps·dataset_versions·boards·news_clues·usage_daily·quota_consumptions)가 **연쇄 삭제**된다(`owner-rls.test.ts`가 모든 회원 표의 cascade를 확인)
3. 뒷정리(선택, SQL 편집기): `select delete_my_data('<id>'::uuid);` — 연쇄 삭제가 없는 표가 생겼을 때를 위한 것(지금은 0행)
4. 확인: 1번 조회가 0행, `select count(*) from analyses where owner_id = '<id>'` 0
- 공유 캐시(기업·보고서·주가·뉴스 캐시)는 회원 것이 아니라 그대로 둔다.

## 5. WU-501 운영 확인 (읽기 + 질문 1회)
### 5.1 읽기 확인 (2026-10-01 14시 KST, Supabase MCP 읽기 조회)
| 확인 | 결과 |
|---|---|
| 같은 단계 중복 실행 (`analysis_steps`에서 `(analysis_id, seq)`가 2줄 이상) | **0건** (고유 키) |
| 1시간 넘게 `queued`·`running` | **2건 그대로** — 9/29·9/30에 만든 것(옛 실행 경로, 단계 0개). 정리 규칙은 **그 회원이 다음에 질문할 때** 돈다 → 아직 그 회원의 질문이 없음. 다음 질문 뒤 다시 보면 `failed`·`TIMEOUT` |
| 최근 하루 `TIMEOUT` 정리 | 0건 (위와 같은 이유) |

### 5.2 운영 질문 1회 — 복합 질문 → 실행 중 [취소] (👤 로그인한 사람이 한 번만, AI 토큰 소량)
1. 배포 주소에서 로그인 → 질문: **"삼성전자 영업이익이 줄어든 원인 알려줘"**(뉴스 단계가 있어 복합)
2. 계획 카드 → [분석 시작] → "1/4단계 …"가 보이면 **[취소]**
3. 화면 "취소한 분석입니다" 확인 후, 아래 읽기 조회(대시보드 SQL 편집기 또는 Claude Code의 Supabase MCP)로:
   ```sql
   -- 방금 분석: canceled + 단계 줄이 1~2개(취소 뒤 새 단계 없음), 진행 중이던 단계는 skipped
   select a.status, a.stop_reason, s.seq, s.tool, s.status, s.started_at
   from analyses a left join analysis_steps s on s.analysis_id = a.id
   where a.id = '<분석 ID — 주소의 analysis=… 부분>'
   order by s.seq;
   -- 취소 뒤 외부 호출 없음: 오늘 api_usage_daily의 news·dart가 취소 뒤 1분 동안 늘지 않았는지
   select provider, calls from api_usage_daily where day_kst = (now() at time zone 'Asia/Seoul')::date;
   ```
4. 같은 회원이 질문했으므로, 그 회원의 오래된 `running`이 있었다면 이때 정리된다(5.1 표의 2건은 다른 회원 것일 수 있음)

## 6. 운영 응답 시간
→ [`tests/perf/RESULTS.md`](../tests/perf/RESULTS.md) "운영 응답 시간" (실행 기록 `duration_ms` 읽기)
