"""Transform Tracker — FastAPI app."""

from __future__ import annotations

import asyncio
import csv
import io
import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import db, domain, reminders

log = logging.getLogger("transform-tracker")
BASE = Path(__file__).resolve().parent
STATIC = BASE / "static"


def get_conn():
    conn = db.connect()
    try:
        yield conn
    finally:
        conn.close()


def get_ctx(conn=Depends(get_conn)):
    return conn, db.get_settings(conn)


# ---------------------------------------------------------------- scheduler


def _tick() -> None:
    conn = db.connect()
    try:
        settings = db.get_settings(conn)
        if not settings.get("notify_enabled"):
            return
        for item in reminders.due_reminders(conn, settings):
            ok, detail = reminders.send_push(settings, item["text"])
            if ok:
                reminders.ack_reminder(conn, item["day"], item["slot"], item["kind"])
                log.info("reminder sent slot=%s via %s", item["slot"], detail)
            else:
                log.warning("reminder failed slot=%s: %s", item["slot"], detail)
    finally:
        conn.close()


async def _scheduler() -> None:
    while True:
        try:
            await asyncio.to_thread(_tick)
        except Exception:  # keep the loop alive no matter what
            log.exception("reminder tick failed")
        await asyncio.sleep(float(os.environ.get("TT_TICK", "60")))


@asynccontextmanager
async def lifespan(app: FastAPI):
    conn = db.connect()
    db.get_settings(conn)
    conn.close()
    task = asyncio.create_task(_scheduler())
    try:
        yield
    finally:
        task.cancel()


app = FastAPI(title="Transform Tracker", lifespan=lifespan)


@app.exception_handler(domain.WeekError)
async def week_error_handler(_request: Request, exc: domain.WeekError):
    return JSONResponse({"detail": str(exc)}, status_code=exc.status)


@app.exception_handler(domain.BadInput)
async def bad_input_handler(_request: Request, exc: domain.BadInput):
    return JSONResponse({"detail": str(exc)}, status_code=400)


# ---------------------------------------------------------------- read


@app.get("/api/bootstrap")
def bootstrap(ctx=Depends(get_ctx)):
    conn, settings = ctx
    today = domain.today_local(settings)
    ws = domain.monday_of(today)
    return {
        "today": domain.iso(today),
        "current_week": domain.iso(ws),
        "settings": settings,
        "week": domain.week_payload(conn, ws, settings),
    }


@app.get("/api/week/{week_start}")
def get_week(week_start: str, ctx=Depends(get_ctx)):
    conn, settings = ctx
    today = domain.today_local(settings)
    ws = domain.parse_week(week_start, today)
    return domain.week_payload(conn, ws, settings)


@app.get("/api/weeks")
def weeks(ctx=Depends(get_ctx)):
    conn, settings = ctx
    return {"weeks": domain.list_weeks(conn, settings)}


@app.get("/api/reminders/due")
def reminders_due(consume: bool = False, ctx=Depends(get_ctx)):
    """Poll target for an external scheduler (e.g. a Hermes cronjob)."""
    conn, settings = ctx
    items = reminders.due_reminders(conn, settings)
    if consume:
        for item in items:
            reminders.ack_reminder(conn, item["day"], item["slot"], item["kind"])
    return {"reminders": items}


# ---------------------------------------------------------------- write


def _editable(conn, settings, week_start: str) -> str:
    today = domain.today_local(settings)
    ws = domain.iso(domain.parse_week(week_start, today))
    domain.ensure_week(conn, domain.parse_week(week_start, today), settings)
    domain.require_editable(conn, ws, settings)
    return ws


@app.post("/api/week/{week_start}/cell")
def add_tally(week_start: str, body: dict, ctx=Depends(get_ctx)):
    conn, settings = ctx
    ws = _editable(conn, settings, week_start)
    count = domain.adjust_cell(
        conn, ws, int(body.get("day", -1)), str(body.get("col", "")),
        int(body.get("delta", 1)),
    )
    return {"count": count, "over": count > _goal(conn, ws, body.get("col"))}


@app.put("/api/week/{week_start}/cell")
def put_tally(week_start: str, body: dict, ctx=Depends(get_ctx)):
    conn, settings = ctx
    ws = _editable(conn, settings, week_start)
    count = domain.set_cell(
        conn, ws, int(body.get("day", -1)), str(body.get("col", "")),
        int(body.get("count", 0)),
    )
    return {"count": count, "over": count > _goal(conn, ws, body.get("col"))}


def _goal(conn, ws: str, col) -> int:
    row = domain.get_week_row(conn, ws)
    if row is None:
        return 0
    values = json.loads(row["goals"])
    try:
        return int(values[domain.COL_KEYS.index(str(col))])
    except (ValueError, IndexError):
        return 0


@app.put("/api/week/{week_start}/activity")
def put_activity(week_start: str, body: dict, ctx=Depends(get_ctx)):
    conn, settings = ctx
    ws = _editable(conn, settings, week_start)
    return domain.set_activity(conn, ws, int(body.get("day", -1)), body)


@app.patch("/api/week/{week_start}")
def patch_week(week_start: str, body: dict, ctx=Depends(get_ctx)):
    conn, settings = ctx
    ws = _editable(conn, settings, week_start)
    if "goals" in body and body["goals"] is not None:
        domain.set_goals(conn, ws, body["goals"])
    meta = {k: v for k, v in body.items() if k in (*domain.MEASURES, "name")}
    if meta:
        domain.set_meta(conn, ws, meta)
    today = domain.today_local(settings)
    return domain.week_payload(conn, domain.parse_week(week_start, today), settings)


@app.post("/api/week/{week_start}/unlock")
def unlock(week_start: str, body: dict | None = None, ctx=Depends(get_ctx)):
    conn, settings = ctx
    today = domain.today_local(settings)
    ws = domain.iso(domain.parse_week(week_start, today))
    domain.ensure_week(conn, domain.parse_week(week_start, today), settings)
    flag = bool((body or {}).get("unlocked", True))
    domain.set_unlocked(conn, ws, flag)
    return domain.week_payload(conn, domain.parse_week(ws, today), settings)


@app.get("/api/settings")
def read_settings(ctx=Depends(get_ctx)):
    _conn, settings = ctx
    return settings


@app.put("/api/settings")
def write_settings(body: dict, ctx=Depends(get_ctx)):
    conn, _settings = ctx
    cleaned = dict(body)
    if "meal_times" in cleaned:
        times = cleaned["meal_times"]
        if isinstance(times, str):
            times = [t.strip() for t in times.split(",") if t.strip()]
        bad = [t for t in times if not domain.TIME_RE.match(str(t))]
        if bad:
            raise domain.BadInput(f"bad reminder time(s): {', '.join(bad)}")
        cleaned["meal_times"] = [f"{int(t.split(':')[0]):02d}:{t.split(':')[1]}"
                                 for t in times]
    if "evening_time" in cleaned and cleaned["evening_time"]:
        if not domain.TIME_RE.match(str(cleaned["evening_time"])):
            raise domain.BadInput("evening time must be HH:MM")
    return db.put_settings(conn, cleaned)


@app.post("/api/notify/test")
def notify_test(ctx=Depends(get_ctx)):
    _conn, settings = ctx
    ok, detail = reminders.send_push(settings, "Transform Tracker — test ping.")
    return {"ok": ok, "detail": detail}


# ---------------------------------------------------------------- export


CSV_FIELDS = [
    "week_start", "date", "day", "name", *domain.COL_KEYS, "goals",
    "activity_time", "activity_type", "intensity",
    "weight_start", "weight_end", "waist_start", "waist_end",
]


@app.get("/api/export.csv")
def export_csv(ctx=Depends(get_ctx)):
    conn, _settings = ctx
    rows = domain.export_rows(conn)
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=CSV_FIELDS)
    writer.writeheader()
    for row in rows:
        writer.writerow({k: row.get(k, "") for k in CSV_FIELDS})
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="transform-tracker.csv"'},
    )


# ---------------------------------------------------------------- static

app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/healthz")
def healthz():
    return {"ok": True}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=os.environ.get("TT_HOST", "0.0.0.0"),
        port=int(os.environ.get("TT_PORT", "8088")),
        reload=bool(os.environ.get("TT_RELOAD")),
    )
