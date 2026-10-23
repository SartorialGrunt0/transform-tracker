import sys
from datetime import date
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app import domain  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture
def clock(monkeypatch):
    """Pretend it is Wednesday 2026-10-21 unless a test moves it."""
    holder = {"today": date(2026, 10, 21)}
    monkeypatch.setattr(domain, "today_local", lambda settings: holder["today"])
    return holder


@pytest.fixture
def client(tmp_path, monkeypatch, clock):
    monkeypatch.setenv("TT_DB", str(tmp_path / "tracker.db"))
    with TestClient(app) as c:
        yield c
