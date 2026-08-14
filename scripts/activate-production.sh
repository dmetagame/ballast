#!/usr/bin/env bash
set -euo pipefail

: "${STATIC_HOST:=ubuntu@16.192.130.150}"
: "${STATIC_SSH_KEY:=$HOME/.ssh/ballast_vps_deploy}"

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
commit=$(git -C "$repo_root" rev-parse HEAD)
ssh_options=(-i "$STATIC_SSH_KEY" -o BatchMode=yes -o ConnectTimeout=20)

"$repo_root/scripts/deploy-static-aws.sh" "$@"
if ! "$repo_root/scripts/deploy-keeper-aws.sh"; then
  EXPECTED_CURRENT_COMMIT="$commit" "$repo_root/scripts/rollback-static-aws.sh"
  if ! ssh "${ssh_options[@]}" "$STATIC_HOST" systemctl --user restart ballast-keeper-health.service; then
    printf 'warning: production rollback completed but the public health signal could not be refreshed\n' >&2
  fi
  printf 'production activation failed; static and keeper runtimes restored to their previous release\n' >&2
  exit 1
fi

printf 'production activation complete: commit=%s\n' "$commit"
