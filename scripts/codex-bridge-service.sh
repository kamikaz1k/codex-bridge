#!/usr/bin/env zsh
set -euo pipefail

LABEL="com.kaiser.codex-bridge"
ROOT_DIR="/Users/kaiser/workspace/codex-workspace/codex-bridge"
PLIST_SOURCE="$ROOT_DIR/launchd/$LABEL.plist"
PLIST_TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/codex-bridge"
PORT="${PORT:-9011}"

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

usage() {
  cat <<EOF
Usage: $0 <command>

Commands:
  install       Install and start the LaunchAgent
  uninstall     Stop and remove the LaunchAgent
  start         Start the LaunchAgent
  stop          Stop the LaunchAgent
  restart       Restart the LaunchAgent
  status        Print launchd and port status
  url           Print the best bridge URL
  tail          Tail bridge logs
  health        Fetch /health from the bridge
EOF
}

user_domain() {
  echo "gui/$(id -u)"
}

resolve_tailscale_ip() {
  if command -v tailscale >/dev/null 2>&1; then
    tailscale ip -4 2>/dev/null | awk '/^[0-9]+[.][0-9]+[.][0-9]+[.][0-9]+$/ { print; exit }'
  fi
}

bridge_host() {
  local ts_ip
  ts_ip="$(resolve_tailscale_ip || true)"
  echo "${ts_ip:-127.0.0.1}"
}

bridge_url() {
  local endpoint host
  endpoint="$(listening_endpoint || true)"
  if [[ -n "$endpoint" ]]; then
    host="${endpoint%:$PORT}"
    if [[ "$host" != "*" && "$host" != "127.0.0.1" ]]; then
      echo "http://$endpoint"
      return
    fi
  fi
  echo "http://$(bridge_host):$PORT"
}

is_loaded() {
  launchctl print "$(user_domain)/$LABEL" >/dev/null 2>&1
}

listening_endpoint() {
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR == 2 {print $9}'
}

install_agent() {
  mkdir -p "$(dirname "$PLIST_TARGET")" "$LOG_DIR"
  cp "$PLIST_SOURCE" "$PLIST_TARGET"
  if is_loaded; then
    launchctl bootout "$(user_domain)" "$PLIST_TARGET" >/dev/null 2>&1 || true
  fi
  launchctl bootstrap "$(user_domain)" "$PLIST_TARGET"
}

start_agent() {
  if [[ ! -f "$PLIST_TARGET" ]]; then
    install_agent
    return
  fi
  if ! is_loaded; then
    launchctl bootstrap "$(user_domain)" "$PLIST_TARGET"
  else
    launchctl kickstart -k "$(user_domain)/$LABEL"
  fi
}

stop_agent() {
  if is_loaded; then
    launchctl bootout "$(user_domain)" "$PLIST_TARGET"
  fi
}

uninstall_agent() {
  stop_agent || true
  rm -f "$PLIST_TARGET"
}

print_status() {
  local loaded="no"
  local endpoint
  if is_loaded; then
    loaded="yes"
  fi
  endpoint="$(listening_endpoint || true)"
  cat <<EOF
label=$LABEL
installed=$([[ -f "$PLIST_TARGET" ]] && echo yes || echo no)
loaded=$loaded
port=$PORT
listening=${endpoint:-no}
url=$(bridge_url)
logs=$LOG_DIR
EOF
}

case "${1:-}" in
  install)
    install_agent
    ;;
  uninstall)
    uninstall_agent
    ;;
  start)
    start_agent
    ;;
  stop)
    stop_agent
    ;;
  restart)
    stop_agent || true
    start_agent
    ;;
  status)
    print_status
    ;;
  url)
    bridge_url
    ;;
  tail)
    mkdir -p "$LOG_DIR"
    touch "$LOG_DIR/stdout.log" "$LOG_DIR/stderr.log"
    tail -f "$LOG_DIR/stdout.log" "$LOG_DIR/stderr.log"
    ;;
  health)
    curl -fsS "$(bridge_url)/health"
    ;;
  *)
    usage
    exit 2
    ;;
esac
