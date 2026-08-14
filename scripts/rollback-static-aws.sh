#!/usr/bin/env bash
set -euo pipefail

: "${STATIC_HOST:=ubuntu@16.192.130.150}"
: "${STATIC_SSH_KEY:=$HOME/.ssh/ballast_vps_deploy}"
: "${STATIC_CURRENT:=/var/www/ballast-current}"
: "${EXPECTED_CURRENT_COMMIT:=}"

ssh_options=(-i "$STATIC_SSH_KEY" -o BatchMode=yes -o ConnectTimeout=20)

ssh "${ssh_options[@]}" "$STATIC_HOST" bash -s -- "$STATIC_CURRENT" "$EXPECTED_CURRENT_COMMIT" <<'REMOTE'
set -euo pipefail
current_link=$1
expected_current_commit=$2
current_target=$(readlink -f "$current_link" 2>/dev/null || true)
previous_target=$(readlink -f /var/www/ballast-previous 2>/dev/null || true)
[[ -n "$current_target" && -d "$current_target" ]] || { echo 'current static release is missing' >&2; exit 1; }
[[ -n "$previous_target" && -d "$previous_target" ]] || { echo 'previous static release is missing' >&2; exit 1; }
[[ "$current_target" != "$previous_target" ]] || { echo 'current and previous static releases are identical' >&2; exit 1; }

if [[ -n "$expected_current_commit" ]]; then
  actual=$(jq -r '.commit' "$current_target/release.json")
  [[ "$actual" = "$expected_current_commit" ]] || {
    echo "refusing static rollback: current commit is $actual, expected $expected_current_commit" >&2
    exit 1
  }
fi

sudo ln -sfnT "$previous_target" "${current_link}.next"
sudo mv -Tf "${current_link}.next" "$current_link"
if [[ -f /etc/caddy/Caddyfile.ballast-previous ]]; then
  sudo cp /etc/caddy/Caddyfile.ballast-previous /etc/caddy/Caddyfile
fi
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
printf 'static release rolled back: from=%s to=%s\n' "$current_target" "$previous_target"
REMOTE
