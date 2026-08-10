#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
scaffold_dir="${FCC_SCAFFOLD_DIR:-${HOME}/fce-extension-scaffold}"
proxy_config="${FCC_PROXY_CONFIG:-${scaffold_dir}/config/proxy/extension_proxy.coston2.docker.toml}"
unit_name="ballast-fcc@${USER}.service"

command -v docker >/dev/null || { printf 'docker is required\n' >&2; exit 1; }
docker compose version >/dev/null
[[ -f "$scaffold_dir/.env" ]] || { printf 'missing protected FCC environment: %s/.env\n' "$scaffold_dir" >&2; exit 1; }
[[ -f "$proxy_config" ]] || { printf 'missing FCC proxy config: %s\n' "$proxy_config" >&2; exit 1; }

chmod 0600 "$scaffold_dir/.env"
sudo chown "${USER}:1001" "$proxy_config"
chmod 0640 "$proxy_config"

sudo install -m 0644 "$repo_root/deploy/systemd/ballast-fcc@.service" \
  /etc/systemd/system/ballast-fcc@.service
sudo systemctl daemon-reload

printf 'installed %s\n' "$unit_name"
printf 'start with: sudo systemctl enable --now %s\n' "$unit_name"
printf 'verify with: sudo systemctl status %s --no-pager\n' "$unit_name"
