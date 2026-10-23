"""Week / tally domain logic."""

from __future__ import annotations

import json
import re
import sqlite3
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

COLUMNS: list[dict[str, str]] = [
    {"key": "veggies", "label": "Veggies", "short": "Veg", "color": "#cfe3c4"},
    {"key": "fruits", "label": "Fruits", "short": "Fruit", "color": "#cfdff0"},
    {"key": "protein", "label": "Protein", "short": "Prot", "color": "#f3cfd2"},
    {"key": "carbs", "label": "Carbs", "short": "Carb", "color": "#f6ebbd"},
    {"key": "fats", "label": "Fats", "short": "Fat", "color": "#ecd2a4"},
    {"key": "seeds", "label": "Seeds", "short": "Seed", "color": "#d9bf93"},
    {"key": "oils", "label": "Oil + Nuts", "short": "Oil", "color": "#e8c07f"},
    {"key": "water", "label": "Water", "short": "Water", "color": "#cdd8dd"},
]

COL_KEYS = [c["key"] for c in COLUMNS]
DEFAULT_GOALS = [5, 3, 5, 4, 1, 1, 5, 8]
DAY_LABELS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]
MAX_GOAL = 9
MAX_TALLY = 999
TIME_RE = re.compile(r"^([01]?\d|2[0-3]):[0-5]\d$")


class WeekError(Exception):
    """Base class for week rule violations."""

    status = 400


class FutureWeek(WeekError):
    status = 422


class LockedWeek(WeekError):
    status = 423


class BadInput(WeekError):
    status = 400


def tz_now(settings: dict) -> datetime:
    try:
        zone = ZoneInfo(settings.get("timezone") or "UTC")
    except Exception:  # unknown tz name -> UTC
        zone = ZoneInfo("UTC")
    return datetime.now(zone)


def today_local(settings: dict) -> date:
    return tz_now(settings).date()


def monday_of(d: date) -> date:
    return d - timedelta(days=d.weekday())


def parse_week(value: str | None, today: date) -> date:
    """Parse 'YYYY-MM-DD' (or 'current') into the Monday of that week."""
    if not value or value == "current":
        return monday_of(today)
    try:
        d = date.fromisoformat(value)
    except ValueError as exc:
        raise BadInput(f"bad week start {value!r}") from exc
    return monday_of(d)


def week_label(start: date) -> str:
    end = start + timedelta(days=6)
    if start.year != end.year:
        return f"{start:%b} {start.day}, {start.year} – {end:%b} {end.day}, {end.year}"
    if start.month != end.month:
        return f"{start:%b} {start.day} – {end:%b} {end.day}, {end.year}"
    return f"{start:%b} {start.day} – {end.day}, {end.year}"


def iso(d: date) -> str:
    return d.isoformat()


def _row_to_week(row: sqlite3.Row) -> dict:
    return {
        "week_start": row["week_start"],
        "name": row["name"],
        "goals": json.loads(row["goals"]),
        "weight_start": row["weight_start"],
        "weight_end": row["weight_end"],
        "waist_start": row["waist_start"],
        "waist_end": row["waist_end"],
        "unlocked": bool(row["unlocked"]),
    }


def get_week_row(conn: sqlite3.Connection, ws: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM weeks WHERE week_start = ?", (ws,)
    ).fetchone()


def prev_week_row(conn: sqlite3.Connection, ws: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM weeks WHERE week_start < ? ORDER BY week_start DESC LIMIT 1",
        (ws,),
    ).fetchone()


def _carry_from_prev(conn: sqlite3.Connection, ws: str, settings: dict) -> dict:
    """Name / goals / opening measurements inherited by a fresh week."""
    prev = prev_week_row(conn, ws)
    base = {
        "name": settings.get("name") or "Me",
        "goals": list(DEFAULT_GOALS),
        "weight_start": None,
        "waist_start": None,
    }
    if prev is None:
        return base
    prev_data = _row_to_week(prev)
    base["name"] = prev_data["name"] or base["name"]
    base["goals"] = prev_data["goals"] or base["goals"]
    # Opening numbers are last week's closing numbers.
    base["weight_start"] = (
        prev_data["weight_end"] if prev_data["weight_end"] is not None
        else prev_data["weight_start"]
    )
    base["waist_start"] = (
        prev_data["waist_end"] if prev_data["waist_end"] is not None
        else prev_data["waist_start"]
    )
    return base


def ensure_week(conn: sqlite3.Connection, ws: date, settings: dict) -> sqlite3.Row:
    """Fetch the week, creating it (carrying settings forward) if needed."""
    current = monday_of(today_local(settings))
    if ws > current:
        raise FutureWeek("future weeks are not open yet")
    key = iso(ws)
    row = get_week_row(conn, key)
    if row is not None:
        return _backfill_opening(conn, row, settings)
    carry = _carry_from_prev(conn, key, settings)
    conn.execute(
        "INSERT INTO weeks (week_start, name, goals, weight_start, waist_start, "
        "unlocked, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
        (
            key,
            carry["name"],
            json.dumps(carry["goals"]),
            carry["weight_start"],
            carry["waist_start"],
            datetime.now().isoformat(timespec="seconds"),
        ),
    )
    for day in range(7):
        conn.execute(
            "INSERT INTO activity (week_start, day, time, type, intensity) "
            "VALUES (?, ?, '', '', NULL)",
            (key, day),
        )
    conn.commit()
    return get_week_row(conn, key)  # type: ignore[return-value]


def _backfill_opening(
    conn: sqlite3.Connection, row: sqlite3.Row, settings: dict
) -> sqlite3.Row:
    """If last week's closing number was entered late, adopt it as this opening."""
    data = _row_to_week(row)
    prev = prev_week_row(conn, data["week_start"])
    if prev is None:
        return row
    prev_data = _row_to_week(prev)
    updates: list[tuple[str, float]] = []
    if data["weight_start"] is None and prev_data["weight_end"] is not None:
        updates.append(("weight_start", prev_data["weight_end"]))
    if data["waist_start"] is None and prev_data["waist_end"] is not None:
        updates.append(("waist_start", prev_data["waist_end"]))
    if not data["name"]:
        updates.append(("name", settings.get("name") or "Me"))  # type: ignore[arg-type]
    for field, value in updates:
        conn.execute(
            f"UPDATE weeks SET {field} = ? WHERE week_start = ?",  # noqa: S608
            (value, data["week_start"]),
        )
    if updates:
        conn.commit()
        row = get_week_row(conn, data["week_start"])  # type: ignore[assignment]
    return row  # type: ignore[return-value]


def is_locked(week: dict, current: date) -> bool:
    return week["week_start"] < iso(current) and not week["unlocked"]


def require_editable(conn: sqlite3.Connection, ws: str, settings: dict) -> dict:
    row = get_week_row(conn, ws)
    if row is None:
        raise BadInput("unknown week")
    week = _row_to_week(row)
    if is_locked(week, monday_of(today_local(settings))):
        raise LockedWeek("this week is closed — press unlock to edit")
    return week


def week_payload(conn: sqlite3.Connection, ws: date, settings: dict) -> dict:
    row = ensure_week(conn, ws, settings)
    week = _row_to_week(row)
    key = week["week_start"]
    current = monday_of(today_local(settings))

    cells: dict[tuple[int, str], int] = {}
    for r in conn.execute(
        "SELECT day, col, count FROM cells WHERE week_start = ?", (key,)
    ):
        cells[(r["day"], r["col"])] = r["count"]

    acts = {
        r["day"]: {"time": r["time"], "type": r["type"], "intensity": r["intensity"]}
        for r in conn.execute(
            "SELECT day, time, type, intensity FROM activity WHERE week_start = ?",
            (key,),
        )
    }

    start = ws
    days = []
    col_totals = dict.fromkeys(COL_KEYS, 0)
    for day in range(7):
        d = start + timedelta(days=day)
        day_cells = {k: cells.get((day, k), 0) for k in COL_KEYS}
        for k in COL_KEYS:
            col_totals[k] += day_cells[k]
        act = acts.get(day, {"time": "", "type": "", "intensity": None})
        days.append(
            {
                "day": day,
                "label": DAY_LABELS[day],
                "date": iso(d),
                "dom": d.day,
                "is_today": d == today_local(settings),
                "cells": day_cells,
                "over": {
                    k: day_cells[k] > week["goals"][i] for i, k in enumerate(COL_KEYS)
                },
                "activity": act,
                "activity_done": bool(act["time"] or act["type"]),
            }
        )

    return {
        "week_start": key,
        "week_end": iso(start + timedelta(days=6)),
        "label": week_label(start),
        "name": week["name"],
        "goals": dict(zip(COL_KEYS, week["goals"])),
        "is_current": key == iso(current),
        "locked": is_locked(week, current),
        "days": days,
        "columns": COLUMNS,
        "weight_start": week["weight_start"],
        "weight_end": week["weight_end"],
        "waist_start": week["waist_start"],
        "waist_end": week["waist_end"],
        "col_totals": col_totals,
        "today": iso(today_local(settings)),
    }


def adjust_cell(
    conn: sqlite3.Connection, ws: str, day: int, col: str, delta: int
) -> int:
    if col not in COL_KEYS:
        raise BadInput(f"unknown column {col!r}")
    if not 0 <= day <= 6:
        raise BadInput("day must be 0-6")
    row = conn.execute(
        "SELECT count FROM cells WHERE week_start = ? AND day = ? AND col = ?",
        (ws, day, col),
    ).fetchone()
    count = (row["count"] if row else 0) + delta
    count = max(0, min(MAX_TALLY, count))
    conn.execute(
        "INSERT INTO cells (week_start, day, col, count) VALUES (?, ?, ?, ?) "
        "ON CONFLICT(week_start, day, col) DO UPDATE SET count = excluded.count",
        (ws, day, col, count),
    )
    conn.commit()
    return count


def set_cell(conn: sqlite3.Connection, ws: str, day: int, col: str, count: int) -> int:
    if col not in COL_KEYS:
        raise BadInput(f"unknown column {col!r}")
    if not 0 <= day <= 6:
        raise BadInput("day must be 0-6")
    count = max(0, min(MAX_TALLY, int(count)))
    conn.execute(
        "INSERT INTO cells (week_start, day, col, count) VALUES (?, ?, ?, ?) "
        "ON CONFLICT(week_start, day, col) DO UPDATE SET count = excluded.count",
        (ws, day, col, count),
    )
    conn.commit()
    return count


def set_activity(
    conn: sqlite3.Connection, ws: str, day: int, patch: dict
) -> dict:
    if not 0 <= day <= 6:
        raise BadInput("day must be 0-6")
    row = conn.execute(
        "SELECT time, type, intensity FROM activity WHERE week_start = ? AND day = ?",
        (ws, day),
    ).fetchone()
    time_s = patch.get("time", row["time"] if row else "")
    type_s = patch.get("type", row["type"] if row else "")
    intensity = patch.get("intensity", row["intensity"] if row else None)

    time_s = (time_s or "").strip()
    if time_s:
        if not TIME_RE.match(time_s):
            raise BadInput("time must be HH:MM")
        hh, mm = time_s.split(":")
        time_s = f"{int(hh):02d}:{mm}"
    type_s = (type_s or "").strip()[:120]
    if intensity in ("", None):
        intensity = None
    else:
        try:
            intensity = int(intensity)
        except (TypeError, ValueError) as exc:
            raise BadInput("intensity must be 1-10") from exc
        if not 1 <= intensity <= 10:
            raise BadInput("intensity must be 1-10")

    conn.execute(
        "INSERT INTO activity (week_start, day, time, type, intensity) "
        "VALUES (?, ?, ?, ?, ?) ON CONFLICT(week_start, day) DO UPDATE SET "
        "time = excluded.time, type = excluded.type, "
        "intensity = excluded.intensity",
        (ws, day, time_s, type_s, intensity),
    )
    conn.commit()
    return {"time": time_s, "type": type_s, "intensity": intensity}


def set_goals(conn: sqlite3.Connection, ws: str, goals: dict) -> list[int]:
    row = get_week_row(conn, ws)
    if row is None:
        raise BadInput("unknown week")
    current = json.loads(row["goals"])
    for key, value in goals.items():
        if key not in COL_KEYS:
            raise BadInput(f"unknown column {key!r}")
        try:
            n = int(value)
        except (TypeError, ValueError) as exc:
            raise BadInput("goals must be integers") from exc
        if not 1 <= n <= MAX_GOAL:
            raise BadInput(f"goal must be 1-{MAX_GOAL}")
        current[COL_KEYS.index(key)] = n
    conn.execute(
        "UPDATE weeks SET goals = ? WHERE week_start = ?", (json.dumps(current), ws)
    )
    conn.commit()
    return current


MEASURES = ("weight_start", "weight_end", "waist_start", "waist_end")
MEASURE_RANGES = {
    "weight_start": (40.0, 700.0),
    "weight_end": (40.0, 700.0),
    "waist_start": (10.0, 120.0),
    "waist_end": (10.0, 120.0),
}


def set_meta(conn: sqlite3.Connection, ws: str, patch: dict) -> dict:
    sets: list[str] = []
    args: list = []
    for field in MEASURES:
        if field not in patch:
            continue
        value = patch[field]
        if value in ("", None):
            sets.append(f"{field} = NULL")
            continue
        try:
            num = round(float(value), 1)
        except (TypeError, ValueError) as exc:
            raise BadInput(f"{field} must be a number") from exc
        low, high = MEASURE_RANGES[field]
        if not low <= num <= high:
            raise BadInput(f"{field} out of range")
        sets.append(f"{field} = ?")
        args.append(num)
    if "name" in patch:
        name = str(patch["name"]).strip()[:40]
        if not name:
            raise BadInput("name cannot be empty")
        sets.append("name = ?")
        args.append(name)
    if sets:
        conn.execute(
            f"UPDATE weeks SET {', '.join(sets)} WHERE week_start = ?",  # noqa: S608
            (*args, ws),
        )
        conn.commit()
    row = get_week_row(conn, ws)
    if row is None:
        raise BadInput("unknown week")
    return _row_to_week(row)


def set_unlocked(conn: sqlite3.Connection, ws: str, unlocked: bool) -> dict:
    conn.execute(
        "UPDATE weeks SET unlocked = ? WHERE week_start = ?",
        (1 if unlocked else 0, ws),
    )
    conn.commit()
    row = get_week_row(conn, ws)
    if row is None:
        raise BadInput("unknown week")
    return _row_to_week(row)


def list_weeks(conn: sqlite3.Connection, settings: dict) -> list[dict]:
    current = iso(monday_of(today_local(settings)))
    rows = conn.execute(
        "SELECT * FROM weeks WHERE week_start <= ? ORDER BY week_start DESC",
        (current,),
    ).fetchall()
    out = []
    for row in rows:
        data = _row_to_week(row)
        totals = conn.execute(
            "SELECT COALESCE(SUM(count), 0) AS n FROM cells WHERE week_start = ?",
            (data["week_start"],),
        ).fetchone()["n"]
        acts = conn.execute(
            "SELECT COUNT(*) AS n FROM activity WHERE week_start = ? "
            "AND (time != '' OR type != '')",
            (data["week_start"],),
        ).fetchone()["n"]
        start = date.fromisoformat(data["week_start"])
        out.append(
            {
                "week_start": data["week_start"],
                "week_end": iso(start + timedelta(days=6)),
                "label": week_label(start),
                "is_current": data["week_start"] == current,
                "locked": data["week_start"] < current and not data["unlocked"],
                "tallies": totals,
                "activity_days": acts,
                "weight_end": data["weight_end"],
            }
        )
    return out


def export_rows(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM weeks ORDER BY week_start"
    ).fetchall()
    out = []
    for row in rows:
        week = _row_to_week(row)
        for day in range(7):
            d = date.fromisoformat(week["week_start"]) + timedelta(days=day)
            cells = {
                r["col"]: r["count"]
                for r in conn.execute(
                    "SELECT col, count FROM cells WHERE week_start = ? AND day = ?",
                    (week["week_start"], day),
                )
            }
            act = conn.execute(
                "SELECT time, type, intensity FROM activity "
                "WHERE week_start = ? AND day = ?",
                (week["week_start"], day),
            ).fetchone()
            out.append(
                {
                    "week_start": week["week_start"],
                    "date": iso(d),
                    "day": DAY_LABELS[day],
                    "name": week["name"],
                    **{k: cells.get(k, 0) for k in COL_KEYS},
                    "goals": "/".join(str(g) for g in week["goals"]),
                    "activity_time": act["time"] if act else "",
                    "activity_type": act["type"] if act else "",
                    "intensity": act["intensity"] if act else "",
                    "weight_start": week["weight_start"],
                    "weight_end": week["weight_end"],
                    "waist_start": week["waist_start"],
                    "waist_end": week["waist_end"],
                }
            )
    return out
