#!/usr/bin/env bash
# Local dev server: http://localhost:8088  (no docker needed)
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d .venv ]; then
  uv venv .venv
fi
uv pip install --python .venv/bin/python -q -r requirements.txt

export TT_PORT="${TT_PORT:-8088}"
export TT_DB="${TT_DB:-$HOME/.transform-tracker/tracker.db}"
exec .venv/bin/python -m app.main
