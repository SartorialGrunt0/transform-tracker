# Transform Tracker

A mobile-first weekly tracker for the paper form it replaces: eight food columns
of tally marks, a per-day activity log, and start/end weight + waist. Weeks roll
over automatically on Monday; old weeks stay browsable.

FastAPI + SQLite + a no-build vanilla front-end. One process, one file of state.

## Run it

```bash
./scripts/dev.sh            # http://localhost:8088  (defaults to ~/.transform-tracker/tracker.db)
TT_DB=./data/dev.db TT_PORT=8088 ./scripts/dev.sh
TT_DB=./data/dev.db .venv/bin/python scripts/seed_demo.py   # demo week for screenshots
```

Docker:

```bash
docker compose up -d --build     # http://<host>:8088, data in ./data/tracker.db
```

The image is `python:3.13-slim` + uvicorn, with a `/healthz` healthcheck. The
SQLite file is the only state — back up `data/tracker.db` (plus `-wal`).

## How the week works

- The current week is the Monday–Sunday containing today (in the configured
  timezone). You can only move **backwards**; future weeks are not open.
- Opening a week for the first time creates it and carries forward: your name,
  the eight plan goals, and *opening* weight/waist = last week's *closing* numbers.
  Tallies and activity start empty.
- Weeks before the current one are **locked** (read-only). Each has an Unlock
  button for corrections, and a Lock button to close it again.
- A cell turns red when its count exceeds that column's goal.

### Three levels

1. **Week** (default) — all 8 columns × 7 days.
2. **Day** — tap a day label (`MON 19`) on the left to zoom into that one day:
   every column as a row with its count, tallies, goal, and explicit
   `−` `+` `Reset` `⤢` controls, plus that day's activity box.
3. **Cell** — `⤢` on a cell (or in a day row) opens a popup with the big count,
   big `−`/`+`, `Reset to 0`, and that column's whole week as a strip you can tap
   through. `Done` / Escape / tapping outside closes it.

Back to the full week: the **‹ All days** button in the day header (Escape also
works). The week arrows stay put at every level.

### Editing a tally

| Action | Effect |
| --- | --- |
| tap a cell (week) or a row (day) | +1 |
| `−` on the cell toolbar | −1 |
| `+` | +1 |
| `Reset` | back to zero |
| `⤢` | open that cell's popup |

Tapping a cell in the week grid raises a bottom toolbar naming that cell
(`WED · VEGGIES 7`) with `−` `+` `Reset` `⤢`, so a correction never depends on
gesture timing. There is
no double-tap or long-press behaviour.

## API

Everything the UI does is a plain JSON endpoint, so anything else can drive it.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/bootstrap` | today, current week, settings, full week payload |
| GET | `/api/week/{week}` | one week (`YYYY-MM-DD` inside the week, or `current`) |
| GET | `/api/weeks` | every stored week, newest first |
| POST | `/api/week/{week}/cell` | `{day, col, delta}` → `{count, over}` |
| PUT | `/api/week/{week}/cell` | `{day, col, count}` |
| PUT | `/api/week/{week}/activity` | `{day, time:"HH:MM", type, intensity:1-10}` |
| PATCH | `/api/week/{week}` | `{goals:{col:n}, name, weight_start, weight_end, waist_start, waist_end}` |
| POST | `/api/week/{week}/unlock` | `{unlocked:true|false}` |
| GET | `/api/settings`, PUT | reminder + name config |
| POST | `/api/notify/test` | send one test push |
| GET | `/api/reminders/due[?consume=true]` | reminders owed right now |
| POST | `/api/reminders/ack` | `{day, slot, kind}` mark as sent |
| GET | `/api/export.csv` | every week, one row per day |

`day` is 0 = Monday … 6 = Sunday. Status codes: `400` bad input, `422` future
week, `423` locked week.

## Reminders

Two triggers, both only firing when the day is still blank:

- **Meal times** — if nothing at all is tallied for today.
- **Evening nudge** — if today's activity (time/type) is empty.

Each slot is sent at most once per day (deduped in the `reminders` table).

### Telegram

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token.
2. Send your new bot any message, then open
   `https://api.telegram.org/bot<token>/getUpdates` and copy `chat.id`.
3. In the app: *Reminders & settings* → paste token + chat id → tick
   "Send reminders" → **Send test**.

### Or let Hermes push it

Set a webhook URL in settings and point a Hermes cronjob at the app instead:

```bash
curl -s "http://<host>:8088/api/reminders/due?consume=true"
```

`consume=true` marks whatever it returns as sent, so the cronjob will not repeat
itself. (Or leave the built-in scheduler doing it — no cron needed.)

## Notes

- Timezone and reminder times live in settings; the scheduler wakes every 60 s
  (`TT_TICK` overrides that for testing).
- Weight/waist ranges are weight 40–700, waist 10–120; goals are 1–9.
- No auth by design: run it on the LAN (or behind your reverse proxy) only.
- Tests: `.venv/bin/python -m pytest -q`
