#!/usr/bin/env bash
set -euo pipefail

: "${STATIC_HOST:=ubuntu@16.192.130.150}"
: "${STATIC_SSH_KEY:=$HOME/.ssh/ballast_vps_deploy}"
: "${RUNTIME_RELEASE_ROOT:=/home/ubuntu/ballast-runtime-releases}"
: "${RUNTIME_CURRENT:=/home/ubuntu/ballast-runtime-current}"
: "${RUNTIME_SERVICE:=ballast-keeper.service}"
: "${HEALTH_TIMER:=ballast-keeper-health.timer}"
: "${RUNTIME_OPERATOR:=0xA20a59090f609329405F5DcA785Af9357F6965E7}"

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
commit=$(git -C "$repo_root" rev-parse HEAD)
short_commit=$(git -C "$repo_root" rev-parse --short HEAD)
release_id=$(date -u +%Y%m%dT%H%M%SZ)-$short_commit
stage=$(mktemp -d "/tmp/ballast-runtime-stage-${release_id}.XXXXXX")
archive=$(mktemp "/tmp/ballast-runtime-${release_id}.XXXXXX.tar.gz")
remote_archive="/tmp/ballast-runtime-${release_id}.tar.gz"
ssh_options=(-i "$STATIC_SSH_KEY" -o BatchMode=yes -o ConnectTimeout=20)

cleanup() {
  rm -rf "$stage"
  rm -f "$archive"
}
trap cleanup EXIT

if [[ -n "$(git -C "$repo_root" status --porcelain --untracked-files=normal)" ]]; then
  printf 'refusing dirty keeper deploy; commit the release first\n' >&2
  exit 1
fi

git -C "$repo_root" fetch --quiet origin main
remote_main=$(git -C "$repo_root" rev-parse origin/main)
[[ "$remote_main" = "$commit" ]] || {
  printf 'refusing unpushed keeper deploy: HEAD=%s origin/main=%s\n' "$commit" "$remote_main" >&2
  exit 1
}
git -C "$repo_root" diff --check
node --check "$repo_root/monitor/healthcheck.mjs"

git -C "$repo_root" archive "$commit" \
  monitor \
  deploy/systemd/ballast-keeper.service \
  deploy/systemd/ballast-keeper-health.service \
  deploy/systemd/ballast-keeper-health.timer | tar -x -C "$stage"
jq -n --arg commit "$commit" --arg release "$release_id" --arg builtAt "$(date -u +%FT%TZ)" \
  '{commit:$commit,release:$release,builtAt:$builtAt}' > "$stage/release.json"
tar -czf "$archive" -C "$stage" .
scp "${ssh_options[@]}" "$archive" "$STATIC_HOST:$remote_archive"

ssh "${ssh_options[@]}" "$STATIC_HOST" bash -s -- \
  "$remote_archive" "$release_id" "$RUNTIME_RELEASE_ROOT" "$RUNTIME_CURRENT" "$RUNTIME_SERVICE" "$HEALTH_TIMER" "$RUNTIME_OPERATOR" <<'REMOTE'
set -euo pipefail
archive=$1
release_id=$2
release_root=$3
current_link=$4
service=$5
health_timer=$6
expected_operator=$7
release_dir="$release_root/$release_id"
unit_dir="$HOME/.config/systemd/user"
env_file="$HOME/.config/ballast/keeper.env"

[[ -f "$env_file" ]] || { echo "keeper environment is missing: $env_file" >&2; exit 1; }
configured_operator=$(sed -n 's/^OPERATOR_ADDRESS=//p' "$env_file" | tail -1)
[[ -n "$configured_operator" && "${configured_operator,,}" = "${expected_operator,,}" ]] || {
  echo "keeper OPERATOR_ADDRESS is missing or unexpected" >&2
  exit 1
}
grep -Eq '^EXECUTE=false$' "$env_file" || {
  echo "keeper.env must retain EXECUTE=false for the continuous service" >&2
  exit 1
}

mkdir -p "$release_root" "$release_dir" "$unit_dir"
tar -xzf "$archive" -C "$release_dir"
npm ci --omit=dev --prefix "$release_dir/monitor"
if [[ -L "$current_link" ]]; then
  previous_target=$(readlink -f "$current_link")
elif [[ -e "$current_link" ]]; then
  echo "$current_link exists and is not a symlink" >&2
  exit 1
else
  previous_target="$HOME/ballast"
fi
[[ -d "$previous_target/monitor" && -f "$previous_target/deploy/systemd/ballast-keeper.service" ]] || {
  echo "previous keeper runtime is invalid: $previous_target" >&2
  exit 1
}

rollback() {
  status=${1:-$?}
  trap - ERR
  set +e
  ln -sfnT "$previous_target" "${current_link}.next"
  mv -Tf "${current_link}.next" "$current_link"
  install -m 0644 "$previous_target/deploy/systemd/ballast-keeper.service" "$unit_dir/ballast-keeper.service"
  if [[ -f "$previous_target/deploy/systemd/ballast-keeper-health.service" ]]; then
    install -m 0644 "$previous_target/deploy/systemd/ballast-keeper-health.service" "$unit_dir/ballast-keeper-health.service"
    install -m 0644 "$previous_target/deploy/systemd/ballast-keeper-health.timer" "$unit_dir/ballast-keeper-health.timer"
  else
    rm -f "$unit_dir/ballast-keeper-health.service" "$unit_dir/ballast-keeper-health.timer"
  fi
  systemctl --user daemon-reload
  systemctl --user restart "$service"
  if [[ -f "$unit_dir/ballast-keeper-health.timer" ]]; then
    systemctl --user enable --now "$health_timer" >/dev/null 2>&1 || true
  else
    systemctl --user disable --now "$health_timer" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap rollback ERR

systemctl --user disable --now "$health_timer" 2>/dev/null || true
systemctl --user stop ballast-keeper-health.service 2>/dev/null || true
systemctl --user stop "$service"
install -m 0644 "$release_dir/deploy/systemd/ballast-keeper.service" "$unit_dir/ballast-keeper.service"
install -m 0644 "$release_dir/deploy/systemd/ballast-keeper-health.service" "$unit_dir/ballast-keeper-health.service"
install -m 0644 "$release_dir/deploy/systemd/ballast-keeper-health.timer" "$unit_dir/ballast-keeper-health.timer"
ln -sfnT "$release_dir" "${current_link}.next"
mv -Tf "${current_link}.next" "$current_link"
systemctl --user daemon-reload
systemctl --user start "$service"
for attempt in 1 2 3 4 5; do
  systemctl --user is-active --quiet "$service" && break
  sleep 2
  if [[ "$attempt" -eq 5 ]]; then
    echo 'keeper service did not become active' >&2
    rollback 1
  fi
done

health_ok=false
for attempt in 1 2 3 4 5; do
  if systemctl --user restart ballast-keeper-health.service; then
    health_ok=true
    break
  fi
  sleep 10
done
if [[ "$health_ok" != true ]]; then
  echo 'keeper health check did not pass' >&2
  rollback 1
fi
systemctl --user enable --now "$health_timer"
rm -f "$archive"
printf 'keeper runtime deployed: release=%s commit=%s service=%s health_timer=%s\n' \
  "$release_id" "$(jq -r '.commit' "$release_dir/release.json")" "$service" "$health_timer"
trap - ERR
REMOTE
