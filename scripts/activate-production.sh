#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
commit=$(git -C "$repo_root" rev-parse HEAD)

"$repo_root/scripts/deploy-static-aws.sh" "$@"
if ! "$repo_root/scripts/deploy-keeper-aws.sh"; then
  EXPECTED_CURRENT_COMMIT="$commit" "$repo_root/scripts/rollback-static-aws.sh"
  printf 'production activation failed; static and keeper runtimes restored to their previous release\n' >&2
  exit 1
fi

printf 'production activation complete: commit=%s\n' "$commit"
