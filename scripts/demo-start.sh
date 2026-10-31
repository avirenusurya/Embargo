#!/usr/bin/env bash
# Start command for hosted demo deployments (Render): runs the server, waits until it is ready, seeds the demo
# workspace once (idempotent), then stays attached to the server process so the platform sees it as the service.
# Developer sign-in must be enabled for seeding, so NODE_ENV must not be "production" (see README, "Deploy").
set -euo pipefail
PORT="${PORT:-8787}"
# Render sets RENDER_EXTERNAL_URL; links, cookies and passkeys use API_URL, so default it to the public URL.
export API_URL="${API_URL:-${RENDER_EXTERNAL_URL:-http://localhost:$PORT}}"
DATA_DIR="${DATA_DIR:-./data}"; mkdir -p "$DATA_DIR"
npx tsx src/main.ts &
PID=$!
trap 'kill -TERM "$PID" 2>/dev/null || true' TERM INT
for _ in $(seq 1 240); do
  curl -fs "http://127.0.0.1:$PORT/ready" >/dev/null 2>&1 && break
  kill -0 "$PID" 2>/dev/null || { echo "server exited during startup"; exit 1; }
  sleep 0.5
done
if [ ! -s "$DATA_DIR/demo-credentials.txt" ]; then
  API="http://127.0.0.1:$PORT" npx tsx scripts/seed.ts > "$DATA_DIR/demo-credentials.txt" 2>&1 \
    && echo "demo workspace seeded" || { echo "seeding failed:"; cat "$DATA_DIR/demo-credentials.txt"; rm -f "$DATA_DIR/demo-credentials.txt"; }
fi
wait "$PID"
