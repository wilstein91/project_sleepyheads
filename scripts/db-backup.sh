#!/usr/bin/env bash
# 운영 DB 수동 백업 (Phase 5, DevelopDoc/OPS_RUNBOOK.md §1) — Supabase 무료 플랜은 자동 백업이 없다.
# **사람이 직접** 실행한다 (Supabase 로그인·프로젝트 연결 + Docker Desktop 실행 중 — CLI가 컨테이너 안에서 pg_dump를 돌린다).
# 운영 DB는 읽기만 한다(pg_dump). 명령은 Supabase 공식 "Backup and Restore using the CLI" 문서와 같다 (2026-10-01 확인).
#
#   bash scripts/db-backup.sh                 # ../sleepyheads-backups/<날짜-시각>/ 에 저장
#   bash scripts/db-backup.sh D:/백업/폴더    # 다른 폴더 (저장소 밖이어야 한다)
#
# 만드는 파일: schema.sql(표·함수·정책), data.sql(데이터), roles.sql(역할). 회원 데이터가 들어 있으니
# **저장소·채팅·공유 드라이브에 올리지 않는다** — 개인 드라이브에만.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
STAMP="$(date +%Y%m%d-%H%M)"
OUT="${1:-$ROOT/../sleepyheads-backups}/$STAMP"

if ! docker info >/dev/null 2>&1; then
  echo "Docker Desktop을 먼저 켜세요 — supabase db dump가 컨테이너 안에서 pg_dump를 돌립니다."
  exit 1
fi

# --linked는 supabase link가 남긴 프로젝트 ref가 있어야 한다 (로그인만으로는 부족)
if [ ! -s "$ROOT/supabase/.temp/project-ref" ] || ! pnpm dlx supabase projects list >/dev/null 2>&1; then
  echo "먼저 Supabase에 로그인하고 이 폴더를 프로젝트에 연결하세요 (한 번만):"
  echo "  pnpm dlx supabase login"
  echo "  pnpm dlx supabase link --project-ref <프로젝트 ref>   # Supabase 대시보드 Project Settings 에 있음"
  exit 1
fi

# 저장소 안에는 절대 쓰지 않는다 (실수로 커밋되지 않게)
mkdir -p "$OUT"
OUT_ABS="$(cd "$OUT" && pwd -P)"
ROOT_ABS="$(cd "$ROOT" && pwd -P)"
case "$OUT_ABS/" in
  "$ROOT_ABS"/*)
    echo "⚠️ 백업 폴더가 저장소 안입니다: $OUT_ABS — 저장소 밖 폴더를 주세요."
    rmdir "$OUT_ABS" 2>/dev/null || true
    exit 1
    ;;
esac

echo "== 백업 → $OUT_ABS"
pnpm dlx supabase db dump --linked -f "$OUT_ABS/roles.sql" --role-only
pnpm dlx supabase db dump --linked -f "$OUT_ABS/schema.sql"
pnpm dlx supabase db dump --linked -f "$OUT_ABS/data.sql" --use-copy --data-only   -x "storage.buckets_vectors" -x "storage.vector_indexes"

for f in schema.sql data.sql roles.sql; do
  [ -s "$OUT_ABS/$f" ] || { echo "⚠️ $f 가 비어 있습니다 — 다시 실행하세요"; exit 1; }
done
ls -l "$OUT_ABS"
echo "✅ 백업 끝. 복구 순서는 DevelopDoc/OPS_RUNBOOK.md §1.2 (운영에 바로 복구하지 말고 로컬에서 먼저)"
