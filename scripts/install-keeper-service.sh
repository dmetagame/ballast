#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
config_dir="${HOME}/.config/ballast"
unit_dir="${HOME}/.config/systemd/user"
key_file="${config_dir}/keeper.private-key"
runtime_current="${HOME}/ballast-runtime-current"

mkdir -p "$config_dir" "$unit_dir"
chmod 700 "$config_dir"
sudo install -d -o "$(id -un)" -g "$(id -gn)" -m 0755 /var/www/ballast-ops
if [ ! -f "$config_dir/keeper.env" ]; then
  install -m 600 "$repo_root/deploy/systemd/keeper.env.example" "$config_dir/keeper.env"
  printf 'created %s; fill production values before starting the service\n' "$config_dir/keeper.env"
fi
if [ ! -f "$key_file" ]; then
  install -m 600 /dev/null "$key_file"
  printf 'created empty %s; use it only for an approved manual execution window\n' "$key_file"
fi
chmod 600 "$config_dir/keeper.env" "$key_file"
if [ -L "$runtime_current" ]; then
  :
elif [ -e "$runtime_current" ]; then
  printf '%s exists and is not a symlink\n' "$runtime_current" >&2
  exit 1
else
  ln -s "$repo_root" "$runtime_current"
fi
if grep -Eq '^PRIVATE_KEY=.+$' "$config_dir/keeper.env"; then
  printf 'warning: remove PRIVATE_KEY from %s after moving it to %s\n' "$config_dir/keeper.env" "$key_file" >&2
fi
if ! grep -Eq '^OPERATOR_ADDRESS=0x[0-9A-Fa-f]{40}$' "$config_dir/keeper.env"; then
  printf 'warning: set OPERATOR_ADDRESS in %s before starting the dry-run service\n' "$config_dir/keeper.env" >&2
fi
install -m 644 "$repo_root/deploy/systemd/ballast-keeper.service" "$unit_dir/ballast-keeper.service"
install -m 644 "$repo_root/deploy/systemd/ballast-keeper-health.service" "$unit_dir/ballast-keeper-health.service"
install -m 644 "$repo_root/deploy/systemd/ballast-keeper-health.timer" "$unit_dir/ballast-keeper-health.timer"
systemctl --user daemon-reload
printf 'installed ballast-keeper.service\n'
printf 'installed ballast-keeper-health.timer\n'
printf 'after configuring %s, run: systemctl --user enable --now ballast-keeper ballast-keeper-health.timer\n' "$config_dir/keeper.env"
