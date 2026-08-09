#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
config_dir="${HOME}/.config/ballast"
unit_dir="${HOME}/.config/systemd/user"

mkdir -p "$config_dir" "$unit_dir"
if [ ! -f "$config_dir/keeper.env" ]; then
  install -m 600 "$repo_root/deploy/systemd/keeper.env.example" "$config_dir/keeper.env"
  printf 'created %s; fill production values before starting the service\n' "$config_dir/keeper.env"
fi
install -m 644 "$repo_root/deploy/systemd/ballast-keeper.service" "$unit_dir/ballast-keeper.service"
systemctl --user daemon-reload
printf 'installed ballast-keeper.service\n'
printf 'after configuring %s, run: systemctl --user enable --now ballast-keeper\n' "$config_dir/keeper.env"
