#!/usr/bin/env bash
set -euo pipefail

: "${PRODUCT_URL:=https://ballast.rouma.online/product/}"
: "${DASHBOARD_URL:=https://ballast.rouma.online/risk/}"
: "${ENROLLMENT_URL:=https://ballast.rouma.online/enroll/}"
: "${EXPECTED_COMMIT:=}"

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

(cd "$repo_root/landing" && BASE_URL="$PRODUCT_URL" npm run verify)
(cd "$repo_root/dashboard" && BASE_URL="$DASHBOARD_URL" npm run verify)
(cd "$repo_root/app" && BASE_URL="$ENROLLMENT_URL" npm run verify:deployment)
"$repo_root/scripts/verify-fcc-production.sh"

headers=$(curl --fail --silent --show-error --head --max-time 20 "$PRODUCT_URL" | tr -d '\r' | tr '[:upper:]' '[:lower:]')
grep -Fq 'x-content-type-options: nosniff' <<<"$headers"
grep -Fq 'x-frame-options: deny' <<<"$headers"
grep -Fq 'strict-transport-security: max-age=31536000' <<<"$headers"
grep -Fq "content-security-policy: default-src 'self'" <<<"$headers"
grep -Fq 'cache-control: no-cache' <<<"$headers"

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
