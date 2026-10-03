#!/usr/bin/env bash
# Start backend (:4000) and frontend (:5173) dev servers in the background. Logs in .run/
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .run
nohup npm --prefix backend run dev > .run/backend.log 2>&1 & echo $! > .run/backend.pid
nohup npm --prefix frontend run dev > .run/frontend.log 2>&1 & echo $! > .run/frontend.pid
echo "backend  → http://127.0.0.1:4000/api/health  (log .run/backend.log)"
echo "frontend → http://127.0.0.1:5173            (log .run/frontend.log)"
