"""Reminder scheduling and push delivery."""

from __future__ import annotations

import json
import sqlite3
import urllib.error
import urllib.request
from datetime import datetime, time

from . import domain

MEAL_KIND = "meal"
EVENING_KIND = "evening"


def _sent(conn: sqlite3.Connection, day: str, slot: str) -> bool:
    return (
        conn.execute(
            "SELECT 1 FROM reminders WHERE day = ? AND slot = ?", (day, slot)
        ).fetchone()
        is not None
    )


def _today_tallies(conn: sqlite3.Connection, ws: str, day: int) -> int:
    row = conn.execute(
        "SELECT COALESCE(SUM(count), 0) AS n FROM cells "
        "WHERE week_start = ? AND day = ?",
        (ws, day),
    ).fetchone()
    return int(row["n"])


def _today_activity(conn: sqlite3.Connection, ws: str, day: int) -> dict:
    row = conn.execute(
        "SELECT time, type, intensity FROM activity WHERE week_start = ? AND day = ?",
        (ws, day),
    ).fetchone()
    return (
        {"time": "", "type": "", "intensity": None}
        if row is None
        else {"time": row["time"], "type": row["type"], "intensity": row["intensity"]}
    )


def _goal_line(conn: sqlite3.Connection, ws: str) -> str:
    row = conn.execute("SELECT goals FROM weeks WHERE week_start = ?", (ws,)).fetchone()
    if row is None:
        return ""
    goals = json.loads(row["goals"])
    parts = [
        f"{col['label']} {g}" for col, g in zip(domain.COLUMNS, goals)
    ]
    return " · ".join(parts)


def due_reminders(
    conn: sqlite3.Connection, settings: dict, now: datetime | None = None
) -> list[dict]:
    """Reminders that are owed right now and have not been sent today."""
    now = now or domain.tz_now(settings)
    today = now.date()
    ws = domain.monday_of(today)
    ws_key = domain.iso(ws)
    day = today.weekday()

    if domain.get_week_row(conn, ws_key) is None:
        return []

    tallies = _today_tallies(conn, ws_key, day)
    act = _today_activity(conn, ws_key, day)
    activity_done = bool(act["time"] or act["type"])

    out: list[dict] = []
    meal_times = settings.get("meal_times") or []
    for slot in meal_times:
        if _sent(conn, domain.iso(today), slot):
            continue
        try:
            hh, mm = (int(x) for x in str(slot).split(":"))
        except ValueError:
            continue
        if now.time() < time(hh, mm):
            continue
        if tallies == 0:
            out.append(
                {
                    "day": domain.iso(today),
                    "slot": slot,
                    "kind": MEAL_KIND,
                    "text": (
                        f"Transform Tracker — nothing logged yet today "
                        f"({today:%a %b %d}). Plan: {_goal_line(conn, ws_key)}"
                    ),
                }
            )

    evening = settings.get("evening_time")
    if evening and not _sent(conn, domain.iso(today), "evening"):
        try:
            hh, mm = (int(x) for x in str(evening).split(":"))
            due_at = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
        except ValueError:
            due_at = None
        if due_at is not None and now >= due_at and not activity_done:
            out.append(
                {
                    "day": domain.iso(today),
                    "slot": "evening",
                    "kind": EVENING_KIND,
                    "text": (
                        f"Transform Tracker — activity still blank for "
                        f"{today:%a}. Log time, type and intensity?"
                    ),
                }
            )
    return out


def ack_reminder(conn: sqlite3.Connection, day: str, slot: str, kind: str) -> None:
    conn.execute(
        "INSERT INTO reminders (day, slot, kind, sent_at) VALUES (?, ?, ?, ?) "
        "ON CONFLICT(day, slot) DO UPDATE SET sent_at = excluded.sent_at",
        (day, slot, kind, datetime.now().isoformat(timespec="seconds")),
    )
    conn.commit()


def _post_json(url: str, payload: dict, timeout: float = 10.0) -> tuple[bool, str]:
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode(errors="replace")
            return True, body[:400]
    except urllib.error.HTTPError as exc:
        return False, f"HTTP {exc.code}: {exc.read().decode(errors='replace')[:300]}"
    except Exception as exc:  # network failure of any kind
        return False, str(exc)[:300]


def send_push(settings: dict, text: str) -> tuple[bool, str]:
    """Deliver one message. Telegram first, then webhook. Never raises."""
    if not settings.get("notify_enabled"):
        return False, "notifications disabled"
    token = (settings.get("telegram_bot_token") or "").strip()
    chat = (settings.get("telegram_chat_id") or "").strip()
    if token and chat:
        ok, detail = _post_json(
            f"https://api.telegram.org/bot{token}/sendMessage",
            {"chat_id": chat, "text": text, "disable_web_page_preview": True},
        )
        if ok:
            return True, "telegram"
        return False, detail
    hook = (settings.get("webhook_url") or "").strip()
    if hook:
        ok, detail = _post_json(hook, {"text": text})
        return (True, "webhook") if ok else (False, detail)
    return False, "no channel configured"
