#!/usr/bin/env bash
set -euo pipefail

: "${STATIC_HOST:=ubuntu@16.192.130.150}"
: "${STATIC_SSH_KEY:=$HOME/.ssh/ballast_vps_deploy}"
: "${STATIC_RELEASE_ROOT:=/var/www/ballast-releases}"
: "${STATIC_CURRENT:=/var/www/ballast-current}"
: "${VITE_BALLAST_MANAGER:=0x746066ACe5dc89a3692137b8cdE3c31328629d09}"
: "${VITE_BALLAST_KEEPER:=0xA20a59090f609329405F5DcA785Af9357F6965E7}"
: "${ALLOW_DIRTY_DEPLOY:=false}"

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
commit=$(git -C "$repo_root" rev-parse HEAD)
short_commit=$(git -C "$repo_root" rev-parse --short HEAD)
release_id=$(date -u +%Y%m%dT%H%M%SZ)-$short_commit
archive=$(mktemp "/tmp/ballast-static-${release_id}.XXXXXX.tar.gz")
stage=$(mktemp -d "/tmp/ballast-static-stage-${release_id}.XXXXXX")
remote_archive="/tmp/ballast-static-${release_id}.tar.gz"
remote_caddy="/tmp/ballast-${release_id}.Caddyfile"
ssh_options=(-i "$STATIC_SSH_KEY" -o BatchMode=yes -o ConnectTimeout=20)

cleanup() {
  rm -f "$archive"
  rm -rf "$stage"
}
trap cleanup EXIT

if [[ "$ALLOW_DIRTY_DEPLOY" != true ]] && [[ -n "$(git -C "$repo_root" status --porcelain --untracked-files=normal)" ]]; then
  printf 'refusing dirty production deploy; commit the release or set ALLOW_DIRTY_DEPLOY=true\n' >&2
  exit 1
fi

"$repo_root/scripts/verify-production.sh"

(cd "$repo_root/landing" && npm ci && npm run build && npm run verify)
(cd "$repo_root/app" && npm ci && \
  VITE_BALLAST_MANAGER="$VITE_BALLAST_MANAGER" \
  VITE_BALLAST_KEEPER="$VITE_BALLAST_KEEPER" \
  VITE_ENABLE_ENROLLMENT_WRITES=true \
  VITE_MANAGER_VERSION=v3 \
  npm run build && npm run verify:production)
(cd "$repo_root/dashboard" && npm run build && npm run verify)

if [[ "$ALLOW_DIRTY_DEPLOY" != true ]] && [[ -n "$(git -C "$repo_root" status --porcelain --untracked-files=normal)" ]]; then
  printf 'build changed tracked release inputs; commit regenerated artifacts before deploying\n' >&2
  exit 1
fi

install -d "$stage/landing" "$stage/dashboard" "$stage/enrollment"
rsync -a --delete "$repo_root/landing/dist/" "$stage/landing/"
install -m 0644 "$repo_root/dashboard/index.html" "$stage/dashboard/index.html"
rsync -a --delete "$repo_root/app/dist/" "$stage/enrollment/"
jq -n --arg commit "$commit" --arg release "$release_id" --arg builtAt "$(date -u +%FT%TZ)" \
  '{commit:$commit,release:$release,builtAt:$builtAt}' > "$stage/release.json"
install -m 0644 "$stage/release.json" "$stage/landing/release.json"
install -m 0644 "$stage/release.json" "$stage/dashboard/release.json"
install -m 0644 "$stage/release.json" "$stage/enrollment/release.json"
tar -czf "$archive" -C "$stage" .

scp "${ssh_options[@]}" "$archive" "$STATIC_HOST:$remote_archive"
scp "${ssh_options[@]}" "$repo_root/deploy/caddy/ballast.Caddyfile" "$STATIC_HOST:$remote_caddy"

rollback_remote() {
  ssh "${ssh_options[@]}" "$STATIC_HOST" bash -s -- "$STATIC_CURRENT" <<'REMOTE'
set -euo pipefail
current_link=$1
previous_target=$(readlink -f /var/www/ballast-previous 2>/dev/null || true)
if [[ -n "$previous_target" ]]; then
  sudo ln -sfnT "$previous_target" "${current_link}.next"
  sudo mv -Tf "${current_link}.next" "$current_link"
fi
if [[ -f /etc/caddy/Caddyfile.ballast-previous ]]; then
  sudo cp /etc/caddy/Caddyfile.ballast-previous /etc/caddy/Caddyfile
fi
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
REMOTE
}

if ! ssh "${ssh_options[@]}" "$STATIC_HOST" bash -s -- \
  "$remote_archive" "$remote_caddy" "$release_id" "$STATIC_RELEASE_ROOT" "$STATIC_CURRENT" <<'REMOTE'
set -euo pipefail
archive=$1
caddy_file=$2
release_id=$3
release_root=$4
current_link=$5
release_dir="$release_root/$release_id"

sudo install -d -m 0755 "$release_root" "$release_dir"
sudo tar -xzf "$archive" -C "$release_dir"
sudo find "$release_dir" -type d -exec chmod 0755 {} +
sudo find "$release_dir" -type f -exec chmod 0644 {} +
sudo caddy validate --config "$caddy_file" --adapter caddyfile
previous_target=$(readlink -f "$current_link" 2>/dev/null || true)
if [[ -n "$previous_target" ]]; then
  sudo ln -sfnT "$previous_target" /var/www/ballast-previous
fi
if [[ -f /etc/caddy/Caddyfile ]]; then
  sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.ballast-previous
fi
rollback() {
  status=$?
  trap - ERR
  set +e
  if [[ -n "$previous_target" ]]; then
    sudo ln -sfnT "$previous_target" "${current_link}.next"
    sudo mv -Tf "${current_link}.next" "$current_link"
  fi
  if [[ -f /etc/caddy/Caddyfile.ballast-previous ]]; then
    sudo cp /etc/caddy/Caddyfile.ballast-previous /etc/caddy/Caddyfile
  fi
  sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
  sudo systemctl reload caddy
  exit "$status"
}
trap rollback ERR
sudo install -m 0644 "$caddy_file" /etc/caddy/Caddyfile
sudo ln -sfnT "$release_dir" "${current_link}.next"
sudo mv -Tf "${current_link}.next" "$current_link"
sudo systemctl daemon-reload
sudo systemctl reload caddy
trap - ERR
rm -f "$archive" "$caddy_file"
REMOTE
then
  printf 'production activation failed; remote rollback completed if live state changed\n' >&2
  exit 1
fi

if ! EXPECTED_COMMIT="$commit" "$repo_root/scripts/verify-static-production.sh"; then
  rollback_remote
  printf 'production verification failed; previous static release restored\n' >&2
  exit 1
fi
printf 'AWS static deployment complete: release=%s host=%s\n' "$release_id" "$STATIC_HOST"
