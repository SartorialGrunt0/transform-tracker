"""API contract tests for Transform Tracker."""

from datetime import date, datetime
from zoneinfo import ZoneInfo

from app import reminders


def test_bootstrap_creates_current_week(client):
    data = client.get("/api/bootstrap").json()
    week = data["week"]
    assert data["current_week"] == "2026-10-19"
    assert week["week_start"] == "2026-10-19"
    assert week["week_end"] == "2026-10-25"
    assert week["is_current"] is True
    assert week["locked"] is False
    assert [d["label"] for d in week["days"]] == [
        "MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN",
    ]
    assert week["goals"]["veggies"] == 5
    assert week["goals"]["water"] == 8
    assert week["weight_start"] is None
    assert len(week["columns"]) == 8


def test_tally_increment_and_clamp(client):
    base = "/api/week/current/cell"
    r = client.post(base, json={"day": 0, "col": "veggies", "delta": 1}).json()
    assert r == {"count": 1, "over": False}
    client.post(base, json={"day": 0, "col": "veggies", "delta": 1})
    client.post(base, json={"day": 0, "col": "veggies", "delta": 1})
    client.post(base, json={"day": 0, "col": "veggies", "delta": 1})
    r = client.post(base, json={"day": 0, "col": "veggies", "delta": 1}).json()
    assert r == {"count": 5, "over": False}
    r = client.post(base, json={"day": 0, "col": "veggies", "delta": 1}).json()
    assert r == {"count": 6, "over": True}
    r = client.post(base, json={"day": 0, "col": "veggies", "delta": -2}).json()
    assert r == {"count": 4, "over": False}


def test_double_tap_never_goes_negative(client):
    base = "/api/week/current/cell"
    r = client.post(base, json={"day": 2, "col": "water", "delta": -2}).json()
    assert r["count"] == 0
    client.post(base, json={"day": 2, "col": "water", "delta": 1})
    r = client.post(base, json={"day": 2, "col": "water", "delta": -2}).json()
    assert r["count"] == 0


def test_cell_put_and_payload(client):
    client.put("/api/week/current/cell", json={"day": 1, "col": "fats", "count": 3})
    week = client.get("/api/week/current").json()
    assert week["days"][1]["cells"]["fats"] == 3
    assert week["days"][1]["over"]["fats"] is True  # goal is 1
    assert week["col_totals"]["fats"] == 3


def test_bad_column_rejected(client):
    r = client.post("/api/week/current/cell", json={"day": 0, "col": "sugar"})
    assert r.status_code == 400
    r = client.post("/api/week/current/cell", json={"day": 9, "col": "fats"})
    assert r.status_code == 400


def test_future_week_is_closed(client):
    r = client.get("/api/week/2026-11-02")
    assert r.status_code == 422
    r = client.post("/api/week/2026-11-02/cell", json={"day": 0, "col": "fats"})
    assert r.status_code == 422


def test_any_day_inside_week_maps_to_monday(client):
    week = client.get("/api/week/2026-10-22").json()
    assert week["week_start"] == "2026-10-19"


def test_past_week_is_locked_until_unlocked(client):
    week = client.get("/api/week/2026-10-12").json()
    assert week["locked"] is True
    r = client.post("/api/week/2026-10-12/cell", json={"day": 0, "col": "fats"})
    assert r.status_code == 423
    r = client.post("/api/week/2026-10-12/unlock", json={"unlocked": True})
    assert r.status_code == 200
    assert r.json()["locked"] is False
    r = client.post("/api/week/2026-10-12/cell", json={"day": 0, "col": "fats"})
    assert r.status_code == 200
    assert r.json()["count"] == 1


def test_activity_round_trip(client):
    url = "/api/week/current/activity"
    r = client.put(url, json={"day": 0, "time": "0:45", "type": "walk", "intensity": 5})
    assert r.json() == {"time": "00:45", "type": "walk", "intensity": 5}
    week = client.get("/api/week/current").json()
    assert week["days"][0]["activity"] == {
        "time": "00:45", "type": "walk", "intensity": 5,
    }
    assert week["days"][0]["activity_done"] is True
    # partial update keeps the other fields
    r = client.put(url, json={"day": 0, "intensity": 7})
    assert r.json() == {"time": "00:45", "type": "walk", "intensity": 7}


def test_activity_validation(client):
    url = "/api/week/current/activity"
    assert client.put(url, json={"day": 0, "time": "45 min"}).status_code == 400
    assert client.put(url, json={"day": 0, "time": "99:99"}).status_code == 400
    assert client.put(url, json={"day": 0, "intensity": 11}).status_code == 400
    assert client.put(url, json={"day": 0, "intensity": 0}).status_code == 400
    r = client.put(url, json={"day": 0, "intensity": None})
    assert r.json()["intensity"] is None


def test_goals_editable_and_carry_forward(client, clock):
    r = client.patch("/api/week/current", json={"goals": {"veggies": 7}})
    assert r.json()["goals"]["veggies"] == 7
    r = client.patch("/api/week/current", json={"goals": {"veggies": 10}})
    assert r.status_code == 400
    clock["today"] = date(2026, 10, 28)
    week = client.get("/api/week/current").json()
    assert week["week_start"] == "2026-10-26"
    assert week["goals"]["veggies"] == 7


def test_new_week_clears_cells_and_activity_but_keeps_meta(client, clock):
    client.post("/api/week/current/cell", json={"day": 0, "col": "fats"})
    client.put(
        "/api/week/current/activity",
        json={"day": 0, "time": "01:00", "type": "walk", "intensity": 4},
    )
    client.patch(
        "/api/week/current",
        json={"name": "Clifford", "weight_end": 204.8, "waist_end": 36.5},
    )
    clock["today"] = date(2026, 10, 26)
    week = client.get("/api/week/current").json()
    assert week["days"][0]["cells"]["fats"] == 0
    assert week["days"][0]["activity"]["time"] == ""
    assert week["days"][0]["activity"]["intensity"] is None
    assert week["name"] == "Clifford"
    assert week["weight_start"] == 204.8
    assert week["waist_start"] == 36.5
    assert week["weight_end"] is None
    assert week["goals"]["veggies"] == 5


def test_opening_weight_backfills_from_late_closing_entry(client, clock):
    client.get("/api/week/current")
    client.get("/api/week/2026-10-12")  # previous week exists
    clock["today"] = date(2026, 10, 26)
    client.get("/api/week/current")
    client.post("/api/week/2026-10-19/unlock", json={"unlocked": True})
    client.patch("/api/week/2026-10-19", json={"weight_end": 203.4})
    week = client.get("/api/week/current").json()
    assert week["weight_start"] == 203.4


def test_name_validation(client):
    assert client.patch("/api/week/current", json={"name": "  "}).status_code == 400
    assert client.patch("/api/week/current", json={"weight_end": 5}).status_code == 400


def test_weeks_list_is_backwards_only(client):
    client.get("/api/week/2026-10-05")
    client.get("/api/week/2026-10-12")
    client.get("/api/week/current")
    weeks = client.get("/api/weeks").json()["weeks"]
    starts = [w["week_start"] for w in weeks]
    assert starts == ["2026-10-19", "2026-10-12", "2026-10-05"]
    assert weeks[0]["is_current"] is True
    assert weeks[1]["locked"] is True


def test_export_csv(client):
    client.post("/api/week/current/cell", json={"day": 0, "col": "water"})
    r = client.get("/api/export.csv")
    assert r.status_code == 200
    body = r.text.strip().splitlines()
    assert body[0].startswith("week_start,date,day,name,veggies")
    assert len(body) == 8  # header + 7 days


def test_settings_round_trip_and_validation(client):
    s = client.put(
        "/api/settings",
        json={
            "name": "Clifford",
            "meal_times": ["8:00", "12:30"],
            "notify_enabled": True,
        },
    ).json()
    assert s["meal_times"] == ["08:00", "12:30"]
    assert s["notify_enabled"] is True
    bad = client.put("/api/settings", json={"meal_times": ["25:99"]})
    assert bad.status_code == 400


def test_reminder_due_rules(client, monkeypatch):
    client.get("/api/bootstrap")
    from app import db

    conn = db.connect()
    settings = db.get_settings(conn)
    tz = ZoneInfo(settings["timezone"])

    def at(hour, minute=0):
        return datetime(2026, 10, 21, hour, minute, tzinfo=tz)

    due = reminders.due_reminders(conn, settings, now=at(7, 0))
    assert due == []
    due = reminders.due_reminders(conn, settings, now=at(13, 0))
    assert [d["slot"] for d in due] == ["08:00", "12:30"]
    assert all(d["kind"] == "meal" for d in due)

    # logging anything silences the meal pings
    client.post("/api/week/current/cell", json={"day": 2, "col": "water"})
    due = reminders.due_reminders(conn, settings, now=at(13, 0))
    assert due == []

    # evening nudge fires when activity is blank
    due = reminders.due_reminders(conn, settings, now=at(21, 30))
    assert [d["slot"] for d in due] == ["evening"]

    reminders.ack_reminder(conn, "2026-10-21", "evening", "evening")
    due = reminders.due_reminders(conn, settings, now=at(21, 31))
    assert due == []

    client.put(
        "/api/week/current/activity",
        json={"day": 2, "time": "00:30", "type": "walk", "intensity": 3},
    )
    due = reminders.due_reminders(conn, settings, now=at(21, 45))
    assert due == []
    conn.close()


def test_reminders_endpoint_consume(client):
    client.get("/api/bootstrap")
    first = client.get("/api/reminders/due?consume=true").json()["reminders"]
    assert isinstance(first, list)
    again = client.get("/api/reminders/due?consume=true").json()["reminders"]
    assert again == first or again == []


def test_health(client):
    assert client.get("/healthz").json() == {"ok": True}
