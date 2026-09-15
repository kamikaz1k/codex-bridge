#!/usr/bin/env zsh
set -euo pipefail

ROOT_DIR="/Users/kaiser/workspace/codex-workspace/codex-bridge"
LOG_DIR="$HOME/Library/Logs/codex-bridge"

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export NODE_ENV="production"
export PORT="${PORT:-9011}"

resolve_tailscale_ip() {
  if command -v tailscale >/dev/null 2>&1; then
    tailscale ip -4 2>/dev/null | awk '/^[0-9]+[.][0-9]+[.][0-9]+[.][0-9]+$/ { print; exit }'
  fi
}

mkdir -p "$LOG_DIR"
cd "$ROOT_DIR"

if [[ -z "${HOST:-}" ]]; then
  TAILSCALE_IP="$(resolve_tailscale_ip || true)"
  export HOST="${TAILSCALE_IP:-127.0.0.1}"
fi

if [[ ! -f "$ROOT_DIR/dist/index.html" ]]; then
  npm run build
fi

exec npm start
