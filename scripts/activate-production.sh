#!/usr/bin/env bash
set -euo pipefail

: "${VITE_BALLAST_MANAGER:=0x746066ACe5dc89a3692137b8cdE3c31328629d09}"
: "${VERCEL_PROJECT_ID:=prj_lNAlg1IQFzWPWAHloebfAcTeDrlt}"
: "${VERCEL_SCOPE:=dmetagames-projects}"

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
"$repo_root/scripts/verify-production.sh"

cd "$repo_root/app"
printf 'true\n' | npx vercel@latest env update VITE_ENABLE_ENROLLMENT_WRITES production --project "$VERCEL_PROJECT_ID" --scope "$VERCEL_SCOPE" --yes
npx vercel@latest deploy . --prod --yes --force --project "$VERCEL_PROJECT_ID" --scope "$VERCEL_SCOPE" \
  -b "VITE_BALLAST_MANAGER=$VITE_BALLAST_MANAGER" \
  -b VITE_ENABLE_ENROLLMENT_WRITES=true \
  -b VITE_MANAGER_VERSION=v3
printf 'frontend write activation completed; configure EXECUTE=true in the keeper environment only after a controlled enrollment\n'
