---
name: refresh-codex-thread
description: Select a persisted Codex thread explicitly and refresh/open it in Codex.app. Use when the user says "refresh thread", asks to refresh Codex, reopen a Codex thread, choose a thread to show in the desktop app, or hand off to an existing thread.
---

# Refresh Codex Thread

Use the repo scripts rather than reconstructing deep links manually.

## Workflow

1. When the user says `refresh thread` with no target, run:

   ```sh
   python3 .agents/skills/refresh-codex-thread/scripts/select-codex-thread.py --list
   ```

2. Present the numbered choices exactly as a compact selector and ask `Which thread should I refresh?` Do not guess unless they explicitly ask for the latest thread.

3. After they reply with a number, map that number to the corresponding thread ID from the same listing and run:

   ```sh
   .agents/skills/refresh-codex-thread/scripts/refresh-codex-thread.sh <thread-id>
   ```

4. If they ask to search across projects, rerun the selector with `--all`.

5. After opening the thread, confirm the selected preview in one short sentence.

## Notes

- The refresh mechanism is a route bounce: `codex://settings` then `codex://threads/<id>`.
- `scripts/select-codex-thread.py` defaults to this repo's threads only, which keeps the choice set tight when working inside this project.
- The selector prefers the same `thread/list` RPC the bridge UI uses, then falls back to Codex's local state DB if the bridge is not running.
- The selector discovers the newest compatible `~/.codex/state_*.sqlite` database when available, then falls back to persisted session rollouts if Codex changes or removes that local SQLite schema.
