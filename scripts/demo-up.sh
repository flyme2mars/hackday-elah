#!/usr/bin/env bash
# Foreground supervisor: Ctrl-C stops only the processes started by this run.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MLX_DIR="${SENSE_MLX_DIR:-$HOME/code/hackday-mlx}"
SENSE_PYTHON="${SENSE_PYTHON:-$REPO_DIR/.venv/bin/python}"
MLX_PYTHON="${SENSE_MLX_PYTHON:-$MLX_DIR/.venv/bin/python}"
TIMEOUT="${DEMO_START_TIMEOUT:-120}"
PIDS=()

fail() { echo "demo-up: $*" >&2; exit 1; }
[[ -d "$MLX_DIR" ]] || fail "MLX directory missing: $MLX_DIR. Set SENSE_MLX_DIR."
[[ -x "$SENSE_PYTHON" ]] || fail "Sense venv missing: $SENSE_PYTHON. Create .venv and install sense/requirements.txt."
[[ -x "$MLX_PYTHON" ]] || fail "MLX venv missing: $MLX_PYTHON. Set SENSE_MLX_PYTHON if needed."
command -v npm >/dev/null || fail 'npm is missing.'
command -v curl >/dev/null || fail 'curl is missing.'
[[ -x "$REPO_DIR/node_modules/.bin/vite" ]] || fail 'Frontend dependencies missing. Run npm ci.'
[[ "$TIMEOUT" =~ ^[1-9][0-9]*$ ]] || fail 'DEMO_START_TIMEOUT must be a positive integer.'
(cd "$REPO_DIR" && "$SENSE_PYTHON" -c 'import uvicorn, sense.app') || fail 'Install sense/requirements.txt in the Sense venv.'

# Prefer the MLX checkout's own launcher. No model package layout is assumed.
if [[ -n "${SENSE_MLX_START_CMD:-}" ]]; then
  MLX_COMMAND="$SENSE_MLX_START_CMD"
elif [[ -f "$MLX_DIR/scripts/serve.sh" ]]; then
  MLX_COMMAND='exec bash scripts/serve.sh'
elif [[ -f "$MLX_DIR/start.sh" ]]; then
  MLX_COMMAND='exec bash start.sh'
else
  fail "No MLX launcher found in $MLX_DIR. Set SENSE_MLX_START_CMD to its server command (serving :8787)."
fi

# Refuse occupied ports; never reuse or kill an unrelated process.
"$SENSE_PYTHON" - <<'PY'
import socket
for port in (8787, 8765, 43123):
    with socket.socket() as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(('127.0.0.1', port))
        except OSError:
            raise SystemExit(f'demo-up: port {port} is already in use. Stop that service before launching.')
PY

cd "$REPO_DIR"
if [[ -f .gemini.env ]]; then
  set -a
  source .gemini.env
  set +a
fi
export SENSE_VAULT="${SENSE_VAULT:-$HOME/HackDayVault}"
export SENSE_MLX_URL='http://127.0.0.1:8787'
export GOOGLE_CLOUD_PROJECT="${GOOGLE_CLOUD_PROJECT:-hackathon1-512618}"
export VERTEX_LOCATION="${VERTEX_LOCATION:-global}"
export VERTEX_MODEL="${VERTEX_MODEL:-gemma-4-26b-a4b-it-maas}"
LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/hackday-demo.XXXXXX")"
echo "Logs: $LOG_DIR"

cleanup() {
  trap - EXIT INT TERM
  for pid in "${PIDS[@]}"; do kill -TERM -- "-$pid" 2>/dev/null || true; done
  # Bound shutdown even when a model process ignores TERM.
  sleep 2
  for pid in "${PIDS[@]}"; do kill -KILL -- "-$pid" 2>/dev/null || true; done
  for pid in "${PIDS[@]}"; do wait "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

start_service() {
  local name="$1" directory="$2"
  shift 2
  # setsid is provided by Python on macOS too. Each child owns its process group.
  "$SENSE_PYTHON" -c 'import os,sys; os.setsid(); os.chdir(sys.argv[1]); os.execvp(sys.argv[2], sys.argv[2:])' \
    "$directory" "$@" >"$LOG_DIR/$name.log" 2>&1 &
  PIDS+=("$!")
}
wait_for() {
  local name="$1" url="$2" pid="$3" deadline=$((SECONDS + TIMEOUT))
  until curl --fail --silent --max-time 2 "$url" >/dev/null 2>&1; do
    kill -0 "$pid" 2>/dev/null || fail "$name exited. See $LOG_DIR/$name.log"
    (( SECONDS < deadline )) || fail "$name did not become ready within ${TIMEOUT}s. See $LOG_DIR/$name.log"
    sleep 1
  done
}

# Activate the MLX interpreter for checkout-owned shell launchers.
export PATH="$(dirname "$MLX_PYTHON"):$PATH"
start_service mlx "$MLX_DIR" bash -c "$MLX_COMMAND"
wait_for mlx http://127.0.0.1:8787/health "${PIDS[0]}"
start_service sense "$REPO_DIR" "$SENSE_PYTHON" -m uvicorn sense.app:app --host 127.0.0.1 --port 8765
wait_for sense http://127.0.0.1:8765/health "${PIDS[1]}"
start_service vite "$REPO_DIR" npm run dev
wait_for vite http://127.0.0.1:43123/ "${PIDS[2]}"

curl --fail --silent --max-time 5 http://127.0.0.1:8765/health | "$SENSE_PYTHON" -c '
import json,sys
h=json.load(sys.stdin)
for key in ("vault_present", "item_count", "embeddings", "gemini_configured", "vertex_credentials", "mlx_url", "e4b_url"):
    print(f"{key}: {h.get(key)}")
'
echo 'MLX :8787 | Sense :8765 | Editor http://127.0.0.1:43123'
echo 'Press Ctrl-C to stop the stack.'
while true; do
  for pid in "${PIDS[@]}"; do
    kill -0 "$pid" 2>/dev/null || fail "A service exited. See $LOG_DIR"
  done
  sleep 2
done
