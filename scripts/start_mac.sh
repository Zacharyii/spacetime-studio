#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ ! -x "$ROOT/backend/.venv/bin/uvicorn" || ! -d "$ROOT/frontend/node_modules" ]]; then
  echo "尚未安装依赖。请先运行: $ROOT/scripts/setup_mac.sh" >&2
  exit 1
fi
"$ROOT/backend/.venv/bin/uvicorn" app.main:app --app-dir "$ROOT/backend" --host 127.0.0.1 --port 8000 --reload --reload-dir "$ROOT/backend/app" &
BACKEND_PID=$!
(cd "$ROOT/frontend" && npm run dev) &
FRONTEND_PID=$!
cleanup() { kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true; wait "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM
echo "后端 API: http://127.0.0.1:8000"
echo "浏览器: http://127.0.0.1:5173"
wait
