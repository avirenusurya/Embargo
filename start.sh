#!/usr/bin/env bash
# Starts the whole Embargo app in one go: API, remote MCP endpoint, workers, schedules and web app.
# First run installs dependencies and creates a demo workspace. Ctrl+C stops everything.
#
#   ./start.sh              start (reuses existing data)
#   ./start.sh --no-open    don't open the browser
#   ./start.sh --port 9000  use another port
#   ./start.sh --fresh      delete local data first (asks for confirmation)
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8787}"; OPEN=1; FRESH=0
DATA_DIR="${DATA_DIR:-data}"; export DATA_DIR
while [ $# -gt 0 ]; do
  case "$1" in
    --no-open) OPEN=0 ;;
    --port) PORT="$2"; shift ;;
    --fresh) FRESH=1 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1"; exit 2 ;;
  esac
  shift
done
URL="http://localhost:$PORT"
B=$'\e[1m'; G=$'\e[38;5;149m'; D=$'\e[2m'; R=$'\e[31m'; X=$'\e[0m'
say() { printf '%s\n' "$*"; }

command -v node >/dev/null || { say "${R}Node.js 22.13+ is required: https://nodejs.org${X}"; exit 1; }
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 22 ] || { say "${R}Node.js 22.13+ is required (found $(node -v)).${X}"; exit 1; }

if [ "$FRESH" = 1 ] && [ -d "$DATA_DIR" ]; then
  read -r -p "Delete $DATA_DIR (database, keys, demo workspace)? Type yes: " ans
  [ "$ans" = "yes" ] && rm -rf "$DATA_DIR/pg" "$DATA_DIR/objects" "$DATA_DIR/.dev-secrets.json" "$DATA_DIR/demo-credentials.txt" && say "Local data deleted." || { say "Kept existing data."; }
fi

if [ ! -d node_modules ] || [ package.json -nt node_modules/.package-lock.json ]; then
  say "${D}Installing dependencies…${X}"; npm install --no-fund --no-audit --loglevel=error
fi
mkdir -p "$DATA_DIR"
LOG="$DATA_DIR/server.log"; CREDS="$DATA_DIR/demo-credentials.txt"

if curl -fs "$URL/ready" >/dev/null 2>&1; then
  say "Embargo is already running at ${B}$URL${X}"
  [ "$OPEN" = 1 ] && command -v xdg-open >/dev/null && xdg-open "$URL" >/dev/null 2>&1 || true
  exit 0
fi

say "${D}Starting Embargo on port $PORT…${X}"
PORT="$PORT" API_URL="$URL" npx tsx src/main.ts > "$LOG" 2>&1 &
PID=$!
cleanup() { trap - INT TERM EXIT; kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; say ""; say "Embargo stopped."; }
trap cleanup INT TERM EXIT

for i in $(seq 1 120); do
  curl -fs "$URL/ready" >/dev/null 2>&1 && break
  if ! kill -0 "$PID" 2>/dev/null; then say "${R}Server failed to start. Last log lines:${X}"; tail -n 30 "$LOG"; exit 1; fi
  sleep 0.5
done
curl -fs "$URL/ready" >/dev/null 2>&1 || { say "${R}Server did not become ready in 60s. See $LOG${X}"; exit 1; }

if [ ! -f "$CREDS" ]; then
  say "${D}Creating the demo workspace…${X}"
  API="$URL" npx tsx scripts/seed.ts > "$CREDS" 2>>"$LOG" || { say "${R}Seeding failed, see $LOG${X}"; rm -f "$CREDS"; }
  sleep 3 # let the workers finish compressing the demo blocks
fi
READY=$(curl -fs "$URL/ready")
TOKEN=$(grep -o 'emb_[A-Za-z0-9_-]*' "$CREDS" 2>/dev/null | head -1 || true)

cat <<EOF

${G}${B}  ███ EMBARGO ███${X}  ${D}knowledge is not public property${X}

  ${B}Website${X}      $URL
  ${B}App${X}          $URL/app
  ${B}Remote MCP${X}   $URL/mcp
  ${B}Status${X}       ${D}$READY${X}

  ${B}Demo sign-in${X} open the app, type an email, choose "Developer sign-in"
               founder@demo.embargo   owner
               priya@demo.embargo     context admin (sees Warden's inbox)
               rohan@demo.embargo     editor
EOF
if [ -n "$TOKEN" ]; then cat <<EOF

  ${B}Connect Claude Code${X}
  claude mcp add --transport http embargo $URL/mcp --header "Authorization: Bearer $TOKEN"
EOF
fi
cat <<EOF

  ${D}Logs: $LOG   Credentials: $CREDS   Stop: Ctrl+C${X}

EOF

if [ "$OPEN" = 1 ]; then
  if command -v xdg-open >/dev/null; then xdg-open "$URL" >/dev/null 2>&1 || true
  elif command -v open >/dev/null; then open "$URL" || true; fi
fi
wait "$PID"
