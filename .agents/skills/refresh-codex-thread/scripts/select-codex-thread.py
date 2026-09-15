#!/usr/bin/env python3
"""List and explicitly select persisted Codex threads."""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path


@dataclass
class Thread:
    id: str
    timestamp: str
    cwd: str
    preview: str

    @property
    def project(self) -> str:
        return Path(self.cwd).name or self.cwd


def discover_state_dbs(codex_home: Path) -> list[Path]:
    # Prefer newer state_N files when Codex has migrated its local schema.
    return sorted(
        codex_home.glob("state_*.sqlite"),
        key=lambda path: numeric_suffix(path.stem),
        reverse=True,
    )


def numeric_suffix(value: str) -> int:
    try:
        return int(value.rsplit("_", 1)[1])
    except (IndexError, ValueError):
        return -1


def db_has_threads_shape(connection: sqlite3.Connection) -> bool:
    try:
        columns = {
            row[1]
            for row in connection.execute("PRAGMA table_info(threads)")
        }
    except sqlite3.DatabaseError:
        return False
    return {"id", "cwd"}.issubset(columns)


def load_threads_from_db(path: Path) -> list[Thread] | None:
    try:
        with sqlite3.connect(path) as connection:
            if not db_has_threads_shape(connection):
                return None
            columns = {
                row[1]
                for row in connection.execute("PRAGMA table_info(threads)")
            }
            timestamp_expr = "updated_at_ms" if "updated_at_ms" in columns else "created_at_ms"
            title_expr = "title" if "title" in columns else "NULL"
            preview_expr = "preview" if "preview" in columns else "NULL"
            filters = []
            if "archived" in columns:
                filters.append("archived = 0")
            if "thread_source" in columns:
                filters.append("COALESCE(thread_source, '') != 'subagent'")
            if "source" in columns:
                filters.append("COALESCE(source, '') NOT LIKE '%\"subagent\"%'")
            where_clause = f"WHERE {' AND '.join(filters)}" if filters else ""
            rows = connection.execute(
                f"""
                SELECT id, {timestamp_expr}, cwd, {title_expr}, {preview_expr}
                FROM threads
                {where_clause}
                ORDER BY {timestamp_expr} DESC
                """
            )
            return [
                Thread(
                    id=row[0],
                    timestamp=timestamp_from_ms(row[1]),
                    cwd=row[2],
                    preview=" ".join((row[3] or row[4] or "untitled").split()),
                )
                for row in rows
                if row[0] and row[2]
            ]
    except sqlite3.DatabaseError:
        return None


def timestamp_from_ms(value: int | float | None) -> str:
    if not value:
        return ""
    return datetime.fromtimestamp(value / 1000).isoformat()


def first_meaningful_user_text(path: Path) -> str:
    try:
        with path.open() as handle:
            for line in handle:
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                payload = item.get("payload", {})
                if item.get("type") != "response_item" or payload.get("role") != "user":
                    continue
                chunks = [
                    part.get("text", "")
                    for part in payload.get("content", [])
                    if part.get("type") in {"input_text", "text"}
                ]
                text = " ".join(chunks).strip()
                if text and not is_scaffolding_user_text(text):
                    return " ".join(text.split())
    except OSError:
        pass
    return "untitled"


def is_scaffolding_user_text(text: str) -> bool:
    return text.startswith(
        (
            "<environment_context>",
            "# AGENTS.md instructions",
            "The following is the Codex agent history",
            "<skill>",
        )
    )


def read_rollout(path: Path) -> Thread | None:
    try:
        with path.open() as handle:
            for line in handle:
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if item.get("type") != "session_meta":
                    continue
                payload = item.get("payload", {})
                if not payload.get("id") or not payload.get("cwd"):
                    return None
                return Thread(
                    id=payload["id"],
                    timestamp=payload.get("timestamp", ""),
                    cwd=payload["cwd"],
                    preview=first_meaningful_user_text(path),
                )
    except OSError:
        pass
    return None


def load_threads_from_rollouts(sessions_dir: Path) -> list[Thread]:
    threads = [
        thread
        for path in sessions_dir.glob("**/*.jsonl")
        if (thread := read_rollout(path))
    ]
    return sorted(threads, key=lambda thread: thread.timestamp, reverse=True)


def load_threads(codex_home: Path, sessions_dir: Path) -> tuple[list[Thread], str]:
    bridge_threads = load_threads_from_bridge()
    if bridge_threads is not None:
        return bridge_threads, "bridge thread/list"
    for db_path in discover_state_dbs(codex_home):
        threads = load_threads_from_db(db_path)
        if threads is not None:
            return threads, db_path.name
    return load_threads_from_rollouts(sessions_dir), "session rollouts"


def load_threads_from_bridge() -> list[Thread] | None:
    script = Path(__file__).with_name("list-codex-threads.mjs")
    try:
        result = subprocess.run(
            ["node", str(script)],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        )
        rows = json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
        return None
    return [
        Thread(
            id=row["id"],
            timestamp=row.get("updatedAt") or row.get("createdAt") or "",
            cwd=row.get("cwd") or "",
            preview=" ".join((row.get("name") or row.get("preview") or "untitled").split()),
        )
        for row in rows
        if row.get("id") and row.get("cwd")
    ]


def display_timestamp(value: str) -> str:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).strftime("%Y-%m-%d %H:%M")
    except ValueError:
        return value or "unknown time"


def truncate(value: str, width: int = 72) -> str:
    return value if len(value) <= width else value[: width - 1] + "..."


def print_threads(threads: list[Thread]) -> None:
    for index, thread in enumerate(threads, start=1):
        print(f"{index:>2}. {thread.project:<20} {display_timestamp(thread.timestamp)}")
        print(f"    {truncate(thread.preview)}")


def filter_threads(threads: list[Thread], query: str) -> list[Thread]:
    needle = query.lower()
    return [
        thread
        for thread in threads
        if needle in thread.id.lower()
        or needle in thread.cwd.lower()
        or needle in thread.preview.lower()
    ]


def choose_thread(threads: list[Thread]) -> Thread:
    visible = threads
    while True:
        print_threads(visible)
        answer = input("\nSelect number, or type to filter: ").strip()
        if answer.isdigit() and 1 <= int(answer) <= len(visible):
            return visible[int(answer) - 1]
        narrowed = filter_threads(threads, answer)
        if narrowed:
            visible = narrowed
            print()
            continue
        print("No matching threads.\n", file=sys.stderr)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--codex-home", default=os.path.expanduser("~/.codex"))
    parser.add_argument("--sessions-dir", default=None)
    parser.add_argument("--cwd", default=os.getcwd())
    parser.add_argument("--all", action="store_true", help="include threads from other projects")
    parser.add_argument("--limit", type=int, default=12)
    parser.add_argument("--list", action="store_true", help="print choices without prompting")
    parser.add_argument("--source", action="store_true", help="print the backing source used")
    args = parser.parse_args()

    codex_home = Path(args.codex_home)
    sessions_dir = Path(args.sessions_dir) if args.sessions_dir else codex_home / "sessions"
    threads, source = load_threads(codex_home, sessions_dir)
    if not args.all:
        threads = [thread for thread in threads if thread.cwd == args.cwd]
    threads = threads[: args.limit]
    if not threads:
        print("No matching Codex threads found.", file=sys.stderr)
        return 1
    if args.source:
        print(f"source={source}", file=sys.stderr)

    if args.list:
        print_threads(threads)
        return 0

    selected = choose_thread(threads)
    refresh_script = Path(__file__).with_name("refresh-codex-thread.sh")
    subprocess.run([str(refresh_script), selected.id], check=True)
    print(f"Opened {selected.project}: {selected.id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
