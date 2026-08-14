#!/usr/bin/env bash
set -euo pipefail

: "${PRODUCT_URL:=https://ballast.rouma.online/product/}"
: "${ROOT_URL:=https://ballast.rouma.online/}"
: "${DASHBOARD_URL:=https://ballast.rouma.online/risk/}"
: "${ENROLLMENT_URL:=https://ballast.rouma.online/enroll/}"
: "${EXPECTED_COMMIT:=}"
: "${HEALTH_URL:=https://ballast.rouma.online/ops/health.json}"
: "${VERIFY_OPS_HEALTH:=false}"

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

(cd "$repo_root/landing" && BASE_URL="$PRODUCT_URL" npm run verify)
(cd "$repo_root/dashboard" && BASE_URL="$DASHBOARD_URL" npm run verify)
(cd "$repo_root/app" && BASE_URL="$ENROLLMENT_URL" npm run verify:deployment)
"$repo_root/scripts/verify-fcc-production.sh"

root_headers=$(curl --silent --show-error --head --max-time 20 "$ROOT_URL" | tr -d '\r')
grep -Fq 'HTTP/2 308' <<<"$root_headers" || grep -Fq 'HTTP/1.1 308' <<<"$root_headers"
grep -Fiq 'location: /product/' <<<"$root_headers"

headers=$(curl --fail --silent --show-error --head --max-time 20 "$PRODUCT_URL" | tr -d '\r' | tr '[:upper:]' '[:lower:]')
grep -Fq 'x-content-type-options: nosniff' <<<"$headers"
grep -Fq 'x-frame-options: deny' <<<"$headers"
grep -Fq 'strict-transport-security: max-age=31536000' <<<"$headers"
grep -Fq "content-security-policy: default-src 'self'" <<<"$headers"
grep -Fq 'cache-control: no-cache' <<<"$headers"
if [[ "$VERIFY_OPS_HEALTH" = true ]]; then
  HEALTH_URL="$HEALTH_URL" \
    RELEASE_URLS="${PRODUCT_URL%/}/release.json,${DASHBOARD_URL%/}/release.json,${ENROLLMENT_URL%/}/release.json" \
    EXPECTED_RELEASE_COMMIT="$EXPECTED_COMMIT" \
    node "$repo_root/monitor/watchdog.mjs"
  health_headers=$(curl --fail --silent --show-error --head --max-time 20 "$HEALTH_URL" | tr -d '\r' | tr '[:upper:]' '[:lower:]')
  grep -Fq 'content-type: application/json' <<<"$health_headers"
  grep -Fq 'cache-control: no-store' <<<"$health_headers"
fi

product_html=$(curl --fail --silent --show-error --max-time 20 "$PRODUCT_URL")
asset_path=$(grep -Eo 'assets/[A-Za-z0-9._-]+' <<<"$product_html" | head -1)
[[ -n "$asset_path" ]] || { printf 'product asset path is missing\n' >&2; exit 1; }
asset_headers=$(curl --fail --silent --show-error --head --max-time 20 \
  "${PRODUCT_URL%/}/$asset_path" | tr -d '\r' | tr '[:upper:]' '[:lower:]')
grep -Fq 'cache-control: public, max-age=31536000, immutable' <<<"$asset_headers"

if [[ -n "$EXPECTED_COMMIT" ]]; then
  for url in "$PRODUCT_URL" "$DASHBOARD_URL" "$ENROLLMENT_URL"; do
    actual=$(curl --fail --silent --show-error --max-time 20 "${url%/}/release.json" | jq -r '.commit')
    [[ "$actual" = "$EXPECTED_COMMIT" ]] || {
      printf 'release provenance mismatch: url=%s actual=%s expected=%s\n' "$url" "$actual" "$EXPECTED_COMMIT" >&2
      exit 1
    }
  done
fi

printf 'static production verified: product=%s dashboard=%s enrollment=%s\n' \
  "$PRODUCT_URL" "$DASHBOARD_URL" "$ENROLLMENT_URL"
