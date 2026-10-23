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

### One screen

The week grid is the whole app: eight columns × seven days, the plan goals on
top, that week's activity underneath, then the weight/waist bookends.

Tap a cell and a bar slides up naming it — `WED · VEGGIES 7` — with `−`, `+`
and `Reset`. That bar is the whole editing surface, and the tapped cell gets an
outline so there is never any doubt which cell it belongs to. Tapping outside
(or Escape) dismisses it.

| Action | Effect |
| --- | --- |
| tap a cell | +1 |
| `−` / `+` in the bar | −1 / +1 |
| `Reset` | back to zero |

No popups, no zoom levels, no day view — the grid is the app.

Nothing depends on gesture timing: no double-tap, no long-press.

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
