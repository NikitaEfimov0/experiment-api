#!/usr/bin/env bash
# =============================================================================
# One-command launcher for the Experiment API stack.
#
#   ./run.sh                 install everything that's missing + start server
#   ./run.sh --skip-pipeline start without the Python feature pipeline
#   ./run.sh --batch         additionally run the batch feature table
#                            (pipeline/feature_pipeline.py) before starting
#
# What it does, in order:
#   1. checks Node >= 20.6 and installs npm dependencies if missing
#   2. checks .env exists (DATABASE_URL etc.)
#   3. sets up a Python venv for the feature pipeline (pipeline/.venv) and
#      installs its requirements — first run takes a few minutes
#   4. pings the Raspberry Pi recording agent (warning only if unreachable)
#   5. starts the server (Ctrl+C stops it) and opens the admin UI
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"

SKIP_PIPELINE=false
RUN_BATCH=false
for arg in "$@"; do
  case "$arg" in
    --skip-pipeline) SKIP_PIPELINE=true ;;
    --batch) RUN_BATCH=true ;;
    *) echo "Unknown option: $arg"; exit 1 ;;
  esac
done

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mFAIL\033[0m %s\n' "$*"; exit 1; }

# --- 1. Node + npm dependencies ---------------------------------------------
command -v node >/dev/null || fail "Node.js not found — install Node 20.6+ first."
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
NODE_MINOR=$(node -p 'process.versions.node.split(".")[1]')
if [ "$NODE_MAJOR" -lt 20 ] || { [ "$NODE_MAJOR" -eq 20 ] && [ "$NODE_MINOR" -lt 6 ]; }; then
  fail "Node $(node -v) is too old — need >= 20.6 (for --env-file support)."
fi
say "Node $(node -v)"

if [ ! -d node_modules ]; then
  say "Installing npm dependencies..."
  npm install --no-audit --no-fund
fi

# --- 2. .env ------------------------------------------------------------------
[ -f .env ] || fail ".env not found — copy the template from SETUP.md and set DATABASE_URL."
grep -q '^DATABASE_URL=' .env || fail ".env has no DATABASE_URL."
say ".env found"

# --- 3. Python feature pipeline ----------------------------------------------
if [ "$SKIP_PIPELINE" = false ]; then
  if command -v python3 >/dev/null; then
    VENV="pipeline/.venv"
    if [ ! -x "$VENV/bin/python" ]; then
      say "Creating Python venv for the feature pipeline (first run only)..."
      python3 -m venv "$VENV"
    fi
    if ! "$VENV/bin/python" -c 'import mediapipe, librosa, cv2, scipy, pandas' 2>/dev/null; then
      say "Installing pipeline requirements (this can take a few minutes)..."
      "$VENV/bin/pip" install -q --upgrade pip
      "$VENV/bin/pip" install -q -r pipeline/requirements.txt \
        || { warn "pipeline install failed — server will use placeholder signals"; SKIP_PIPELINE=true; }
    fi
    if [ "$SKIP_PIPELINE" = false ]; then
      export PIPELINE_PYTHON="$PWD/$VENV/bin/python"
      say "Feature pipeline ready ($PIPELINE_PYTHON)"
    fi
  else
    warn "python3 not found — server will use placeholder signals."
    SKIP_PIPELINE=true
  fi
fi
[ "$SKIP_PIPELINE" = true ] && export PIPELINE_ENABLED=false

# --- optional batch run --------------------------------------------------------
if [ "$RUN_BATCH" = true ] && [ "$SKIP_PIPELINE" = false ]; then
  say "Running batch feature pipeline over ./data ..."
  (cd pipeline && "$PIPELINE_PYTHON" feature_pipeline.py --data-dir ../data --out-dir ./outputs) \
    || warn "batch pipeline failed (continuing)"
fi

# --- 4. Raspberry Pi agent -----------------------------------------------------
PI_URL=$(grep '^PI_AGENT_URL=' .env | cut -d= -f2- || true)
if [ -n "${PI_URL:-}" ]; then
  if curl -sf -m 3 "$PI_URL/health" >/dev/null 2>&1; then
    say "Pi agent reachable at $PI_URL"
  else
    warn "Pi agent NOT reachable at $PI_URL — recording start will fail until it's up."
  fi
fi

# --- 5. Start server -----------------------------------------------------------
PORT_VAL=$(grep '^PORT=' .env | cut -d= -f2- || true); PORT_VAL=${PORT_VAL:-3000}
LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || true)
say "Starting server on port $PORT_VAL"
[ -n "${LAN_IP:-}" ] && say "LAN address for the Pi team (SERVER_BASE_URL): http://$LAN_IP:$PORT_VAL"

# Open the admin UI once the server is up (macOS 'open' / Linux 'xdg-open').
( sleep 2 && { open "http://localhost:$PORT_VAL/admin" 2>/dev/null || xdg-open "http://localhost:$PORT_VAL/admin" 2>/dev/null || true; } ) &

exec node --env-file=.env server.js
