#!/usr/bin/env bash
set -euo pipefail

: "${VITE_BALLAST_MANAGER:=0x746066ACe5dc89a3692137b8cdE3c31328629d09}"
: "${VITE_BALLAST_KEEPER:=0xA20a59090f609329405F5DcA785Af9357F6965E7}"
: "${VERCEL_PROJECT_ID:=prj_lNAlg1IQFzWPWAHloebfAcTeDrlt}"
: "${VERCEL_SCOPE:=dmetagames-projects}"
: "${PUBLIC_ALIAS:=ballast-enrollment.vercel.app}"

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
"$repo_root/scripts/verify-production.sh"

cd "$repo_root/app"
set_vercel_env() {
  local name="$1" value="$2"
  npx vercel@latest env add "$name" production \
    --value "$value" --force --no-sensitive --project "$VERCEL_PROJECT_ID" \
    --scope "$VERCEL_SCOPE" --yes
}

set_vercel_env VITE_BALLAST_MANAGER "$VITE_BALLAST_MANAGER"
set_vercel_env VITE_BALLAST_KEEPER "$VITE_BALLAST_KEEPER"
set_vercel_env VITE_ENABLE_ENROLLMENT_WRITES true
set_vercel_env VITE_MANAGER_VERSION v3
VITE_BALLAST_MANAGER="$VITE_BALLAST_MANAGER" \
VITE_BALLAST_KEEPER="$VITE_BALLAST_KEEPER" \
VITE_ENABLE_ENROLLMENT_WRITES=true \
VITE_MANAGER_VERSION=v3 \
npm run build
npm run verify:production
deployment_json=$(npx vercel@latest deploy . --prod --yes --force --json \
  --project "$VERCEL_PROJECT_ID" --scope "$VERCEL_SCOPE" \
  -b "VITE_BALLAST_MANAGER=$VITE_BALLAST_MANAGER" \
  -b "VITE_BALLAST_KEEPER=$VITE_BALLAST_KEEPER" \
  -b VITE_ENABLE_ENROLLMENT_WRITES=true \
  -b VITE_MANAGER_VERSION=v3)
printf '%s\n' "$deployment_json"
deployment_url=$(printf '%s' "$deployment_json" | jq -r '.deployment.url')
[ -n "$deployment_url" ] && [ "$deployment_url" != null ] || {
  printf 'deployment URL missing from Vercel response\n' >&2
  exit 1
}
npx vercel@latest alias set "$deployment_url" "$PUBLIC_ALIAS" --scope "$VERCEL_SCOPE"
BASE_URL="https://$PUBLIC_ALIAS" npm run verify:deployment
printf 'frontend write activation completed; configure EXECUTE=true in the keeper environment only after a controlled enrollment\n'
