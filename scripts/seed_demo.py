"""Seed a demo database (handy for screenshots / first run).

    TT_DB=~/.transform-tracker/tracker.db python scripts/seed_demo.py
"""

from __future__ import annotations

import os
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import db, domain  # noqa: E402

COLUMNS = domain.COL_KEYS
ROWS = [
    [5, 3, 5, 4, 1, 1, 5, 8],
    [4, 2, 5, 3, 1, 1, 6, 9],
    [6, 3, 6, 4, 2, 1, 5, 8],
    [5, 4, 5, 4, 1, 1, 5, 7],
    [3, 2, 4, 3, 1, 1, 4, 8],
    [5, 3, 5, 5, 1, 2, 5, 8],
    [4, 3, 5, 4, 1, 1, 5, 8],
]
ACTIVITY = [
    ("00:45", "walk", 5),
    ("00:50", "walk", 4),
    ("00:55", "walk", 6),
    ("01:10", "hike", 7),
    ("00:40", "walk", 3),
    ("00:30", "walk", 2),
    ("01:00", "walk", 4),
]


def main() -> None:
    conn = db.connect()
    settings = db.get_settings(conn)
    today = domain.today_local(settings)
    this_week = domain.monday_of(today)
    last_week = date.fromordinal(this_week.toordinal() - 7)

    domain.week_payload(conn, last_week, settings)
    domain.set_unlocked(conn, domain.iso(last_week), True)
    for day, row in enumerate(ROWS[:5]):
        for col, n in zip(COLUMNS, row):
            domain.set_cell(conn, domain.iso(last_week), day, col, max(0, n - 1))
    domain.set_meta(
        conn,
        domain.iso(last_week),
        {"weight_start": 207.4, "waist_start": 37.2,
         "weight_end": 206.2, "waist_end": 37.0},
    )
    domain.set_unlocked(conn, domain.iso(last_week), False)

    domain.week_payload(conn, this_week, settings)
    for day, row in enumerate(ROWS):
        for col, n in zip(COLUMNS, row):
            domain.set_cell(conn, domain.iso(this_week), day, col, n)
        t, kind, intensity = ACTIVITY[day]
        domain.set_activity(
            conn, domain.iso(this_week), day,
            {"time": t, "type": kind, "intensity": intensity},
        )
    domain.set_meta(
        conn,
        domain.iso(this_week),
        {"weight_start": 206.2, "waist_start": 37.0,
         "weight_end": 204.8, "waist_end": 36.5},
    )
    print(f"seeded {os.environ.get('TT_DB', db.DEFAULT_DB_PATH)}")
    conn.close()


if __name__ == "__main__":
    main()
