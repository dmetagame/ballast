#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
config_dir="${HOME}/.config/ballast"
unit_dir="${HOME}/.config/systemd/user"
key_file="${config_dir}/keeper.private-key"

mkdir -p "$config_dir" "$unit_dir"
if [ ! -f "$config_dir/keeper.env" ]; then
  install -m 600 "$repo_root/deploy/systemd/keeper.env.example" "$config_dir/keeper.env"
  printf 'created %s; fill production values before starting the service\n' "$config_dir/keeper.env"
fi
if [ ! -f "$key_file" ]; then
  install -m 600 /dev/null "$key_file"
  printf 'created empty %s; write the dedicated keeper key before setting EXECUTE=true\n' "$key_file"
fi
chmod 600 "$config_dir/keeper.env" "$key_file"
if grep -Eq '^PRIVATE_KEY=.+$' "$config_dir/keeper.env"; then
  printf 'warning: remove PRIVATE_KEY from %s after moving it to %s\n' "$config_dir/keeper.env" "$key_file" >&2
fi
install -m 644 "$repo_root/deploy/systemd/ballast-keeper.service" "$unit_dir/ballast-keeper.service"
systemctl --user daemon-reload
printf 'installed ballast-keeper.service\n'
printf 'after configuring %s, run: systemctl --user enable --now ballast-keeper\n' "$config_dir/keeper.env"
