#!/usr/bin/env zsh
set -euo pipefail

# Force Codex.app to remount a thread by briefly bouncing through Settings.
# Usage:
#   scripts/refresh-codex-thread.sh <thread-id>
#   scripts/refresh-codex-thread.sh codex://threads/<thread-id>

BUNDLE_ID="${CODEX_BUNDLE_ID:-com.openai.codex}"
APP_PATH="${CODEX_APP_PATH:-/Applications/Codex.app}"
BOUNCE_URL="codex://settings"

usage() {
  cat <<EOF
Usage: $0 <thread-id|codex://threads/<thread-id>>

Examples:
  $0 0196f2c0-1234-7890-abcd-ef0123456789
  $0 codex://threads/0196f2c0-1234-7890-abcd-ef0123456789
EOF
}

if [[ $# -ne 1 ]]; then
  usage >&2
  exit 64
fi

target="$1"
if [[ "$target" != codex://threads/* ]]; then
  target="codex://threads/$target"
fi

osascript - "$BUNDLE_ID" "$APP_PATH" "$BOUNCE_URL" "$target" <<'APPLESCRIPT'
on run argv
  set bundleId to item 1 of argv
  set appPath to item 2 of argv
  set bounceUrl to item 3 of argv
  set targetUrl to item 4 of argv

  try
    tell application "Finder" to activate
  end try

  delay 0.12
  my openCodexUrl(bundleId, appPath, bounceUrl)
  delay 0.18
  my openCodexUrl(bundleId, appPath, targetUrl)
  delay 0.18

  try
    tell application id bundleId to activate
  end try
end run

on openCodexUrl(bundleId, appPath, targetUrl)
  try
    do shell script "open -b " & quoted form of bundleId & " " & quoted form of targetUrl
  on error
    do shell script "open -a " & quoted form of appPath & " " & quoted form of targetUrl
  end try
end openCodexUrl
APPLESCRIPT
