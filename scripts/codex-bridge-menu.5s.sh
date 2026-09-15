#!/usr/bin/env zsh
set -euo pipefail

LABEL="com.kaiser.codex-bridge"
ROOT_DIR="/Users/kaiser/workspace/codex-workspace/codex-bridge"
SERVICE="$ROOT_DIR/scripts/codex-bridge-service.sh"
PORT="${PORT:-9011}"

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

user_domain() {
  echo "gui/$(id -u)"
}

is_loaded() {
  launchctl print "$(user_domain)/$LABEL" >/dev/null 2>&1
}

listening_endpoint() {
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR == 2 {print $9}'
}

bridge_url() {
  "$SERVICE" url
}

loaded="not loaded"
loaded_color="red"
if is_loaded; then
  loaded="loaded"
  loaded_color="green"
fi

endpoint="$(listening_endpoint || true)"
port_status="not listening"
port_color="red"
if [[ -n "$endpoint" ]]; then
  port_status="$endpoint"
  port_color="green"
fi

url="$(bridge_url)"
title="Bridge"
title_color="red"
if [[ -n "$endpoint" ]]; then
  title="Bridge $PORT"
  title_color="green"
fi

echo "$title | color=$title_color"
echo "---"
echo "Open Bridge | href=$url"
echo "Health Check | bash=$SERVICE param1=health terminal=true refresh=true"
echo "---"
echo "LaunchAgent: $loaded | color=$loaded_color"
echo "Port $PORT: $port_status | color=$port_color"
echo "URL: $url"
echo "---"
echo "Start | bash=$SERVICE param1=start terminal=false refresh=true"
echo "Stop | bash=$SERVICE param1=stop terminal=false refresh=true"
echo "Restart | bash=$SERVICE param1=restart terminal=false refresh=true"
echo "---"
echo "Install LaunchAgent | bash=$SERVICE param1=install terminal=false refresh=true"
echo "Uninstall LaunchAgent | bash=$SERVICE param1=uninstall terminal=false refresh=true"
echo "---"
echo "Tail Logs | bash=$SERVICE param1=tail terminal=true"
echo "Reveal Project | bash=/usr/bin/open param1=$ROOT_DIR terminal=false"
