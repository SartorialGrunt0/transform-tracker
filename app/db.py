"""SQLite storage for Transform Tracker."""

from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path
from typing import Any

DEFAULT_DB_PATH = Path.home() / ".transform-tracker" / "tracker.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS weeks (
    week_start   TEXT PRIMARY KEY,
    name         TEXT NOT NULL DEFAULT '',
    goals        TEXT NOT NULL,
    weight_start REAL,
    weight_end   REAL,
    waist_start  REAL,
    waist_end    REAL,
    unlocked     INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cells (
    week_start TEXT NOT NULL REFERENCES weeks(week_start) ON DELETE CASCADE,
    day        INTEGER NOT NULL,
    col        TEXT NOT NULL,
    count      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (week_start, day, col)
);

CREATE TABLE IF NOT EXISTS activity (
    week_start TEXT NOT NULL REFERENCES weeks(week_start) ON DELETE CASCADE,
    day        INTEGER NOT NULL,
    time       TEXT NOT NULL DEFAULT '',
    type       TEXT NOT NULL DEFAULT '',
    intensity  INTEGER,
    PRIMARY KEY (week_start, day)
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reminders (
    day     TEXT NOT NULL,
    slot    TEXT NOT NULL,
    kind    TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    PRIMARY KEY (day, slot)
);
"""

DEFAULT_SETTINGS: dict[str, Any] = {
    "name": "Clifford",
    "telegram_bot_token": "",
    "telegram_chat_id": "",
    "notify_enabled": False,
    "meal_times": ["08:00", "12:30", "18:30"],
    "evening_time": "21:00",
    "timezone": "America/Los_Angeles",
    "webhook_url": "",
}


def db_path(path: str | Path | None = None) -> Path:
    """Resolve the database file from an explicit path, env var, or default."""
    if path is not None:
        return Path(path)
    env = os.environ.get("TT_DB")
    return Path(env) if env else DEFAULT_DB_PATH


def connect(path: str | Path | None = None) -> sqlite3.Connection:
    p = db_path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(p, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(SCHEMA)
    return conn


def get_settings(conn: sqlite3.Connection) -> dict[str, Any]:
    """Settings with defaults applied for keys never written."""
    out = json.loads(json.dumps(DEFAULT_SETTINGS))
    for row in conn.execute("SELECT key, value FROM settings"):
        try:
            out[row["key"]] = json.loads(row["value"])
        except json.JSONDecodeError:
            out[row["key"]] = row["value"]
    return out


def put_settings(conn: sqlite3.Connection, patch: dict[str, Any]) -> dict[str, Any]:
    for key, value in patch.items():
        if key not in DEFAULT_SETTINGS:
            continue
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, json.dumps(value)),
        )
    conn.commit()
    return get_settings(conn)
