#!/usr/bin/env bash
# =============================================================================
# run-demo.sh — one-command LOCAL demo of the Agentic SOC Triage Suite.
#
# Brings up the suite in its "headline-features" demo posture WITHOUT Docker:
#   * the FastAPI + LangGraph backend (app.main:app) on :8088, with API auth
#     ENABLED so the login + 6-role RBAC + MFA/SSO surfaces are live;
#   * the Vite + React web UI dev server on :5173, proxying /api/* to :8088.
#
# When auth is enabled and the user store is empty, the backend auto-seeds a
# demo super_admin:  Admin / Admin@123  (see app/config.py auth_seed_admin*).
#
# This script is DEPLOY-agnostic: it uses an in-memory / SQLite-friendly state
# backend and a mock LLM provider unless you export real keys, so it runs on a
# laptop with nothing but Python 3.11 + Node 22 installed.
# It also completes the local OOBE and enables the isolated seeded Demo Mode, so
# the first page is populated without manual setup or provider spend.
#
# Usage:
#   ./scripts/run-demo.sh            # start both, stream logs, Ctrl-C to stop
#   ANTHROPIC_API_KEY=sk-... ./scripts/run-demo.sh   # real triage
#
# Override ports/secret via env:
#   BACKEND_PORT (8088)  WEBUI_PORT (5173)  TLSOC_AUTH_JWT_SECRET (auto-dev)
# =============================================================================
set -euo pipefail

# --- Resolve repo paths (works from any CWD) ---------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BACKEND_DIR="${REPO_ROOT}/backend"
WEBUI_DIR="${REPO_ROOT}/webui"

BACKEND_PORT="${BACKEND_PORT:-8088}"
WEBUI_PORT="${WEBUI_PORT:-5173}"

# --- Demo auth posture -------------------------------------------------------
# Enabling auth turns on the login screen + RBAC + MFA/SSO surfaces and seeds
# the demo super_admin. A STABLE JWT secret keeps sessions alive across reloads;
# we generate a throwaway dev one if the operator did not supply theirs.
#
# IMPORTANT: when we run uvicorn DIRECTLY (no Docker), the backend's pydantic
# Secrets reads UNPREFIXED env names (auth_enabled / auth_jwt_secret / …). The
# TLSOC_* names are only the .env convention that the compose file maps. So here
# we accept the operator's TLSOC_* (the documented knob) AND export the
# unprefixed names the backend actually reads.
DEMO_JWT_SECRET="${TLSOC_AUTH_JWT_SECRET:-${AUTH_JWT_SECRET:-}}"
if [[ -z "${DEMO_JWT_SECRET}" ]]; then
  DEMO_JWT_SECRET="dev-demo-secret-$(python3 -c 'import secrets;print(secrets.token_hex(24))' 2>/dev/null || echo changeme-please-rotate-0123456789abcdef)"
fi

# Unprefixed names — these are what uvicorn/app.config.Secrets reads:
export AUTH_ENABLED=true
export AUTH_JWT_SECRET="${DEMO_JWT_SECRET}"
export AUTH_COOKIE_SECURE="${TLSOC_AUTH_COOKIE_SECURE:-${AUTH_COOKIE_SECURE:-false}}"
export SECURITY_HEADERS_ENABLED="${TLSOC_SECURITY_HEADERS_ENABLED:-${SECURITY_HEADERS_ENABLED:-true}}"

ADMIN_USER="${AUTH_SEED_ADMIN_USERNAME:-Admin}"
ADMIN_PASS="${AUTH_SEED_ADMIN_PASSWORD:-Admin@123}"

# --- Track child PIDs so Ctrl-C tears the whole demo down -------------------
PIDS=()
cleanup() {
  echo
  echo "[demo] shutting down…"
  for pid in "${PIDS[@]:-}"; do
    [[ -n "${pid}" ]] && kill "${pid}" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  echo "[demo] stopped."
}
trap cleanup INT TERM EXIT

# --- 1) Backend: ensure venv + deps, then launch uvicorn --------------------
echo "[demo] preparing backend venv at ${BACKEND_DIR}/.venv …"
if [[ ! -d "${BACKEND_DIR}/.venv" ]]; then
  python3 -m venv "${BACKEND_DIR}/.venv"
fi
# shellcheck disable=SC1091
source "${BACKEND_DIR}/.venv/bin/activate"

# Install runtime deps once (idempotent; quiet). Prefer requirements.txt.
if ! python -c "import fastapi, uvicorn" >/dev/null 2>&1; then
  echo "[demo] installing backend dependencies (first run)…"
  if [[ -f "${BACKEND_DIR}/requirements.txt" ]]; then
    pip install -q -r "${BACKEND_DIR}/requirements.txt"
  elif [[ -f "${BACKEND_DIR}/requirements-dev.txt" ]]; then
    pip install -q -r "${BACKEND_DIR}/requirements-dev.txt"
  fi
fi

echo "[demo] starting backend (uvicorn app.main:app) on :${BACKEND_PORT} …"
(
  cd "${BACKEND_DIR}"
  exec python -m uvicorn app.main:app --host 0.0.0.0 --port "${BACKEND_PORT}"
) &
PIDS+=("$!")

# Wait for the API, authenticate as the local seeded admin, finish the local OOBE,
# and enable the isolated deterministic demo. Python stdlib keeps curl/jq optional.
echo "[demo] waiting for backend and seeding deterministic Demo Mode …"
python - "${BACKEND_PORT}" "${ADMIN_USER}" "${ADMIN_PASS}" <<'PY'
import http.cookiejar
import json
import sys
import time
import urllib.error
import urllib.request

port, username, password = sys.argv[1:]
base = f"http://127.0.0.1:{port}/api"
cookies = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies))

for _ in range(120):
    try:
        with opener.open(f"{base}/health/live", timeout=1):
            break
    except Exception:
        time.sleep(0.25)
else:
    raise SystemExit("backend did not become live within 30 seconds")

def post(path, payload):
    request = urllib.request.Request(
        f"{base}/{path}",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with opener.open(request, timeout=30) as response:
        return json.load(response)

post("auth/login", {"username": username, "password": password})
post("setup/complete", {})
status = post("demo/enable", {"mode": "seeded", "force_capabilities": True})
print(f"[demo] seeded run {status.get('run_id', 'ready')}")
PY

# --- 2) Web UI: ensure node_modules, then launch the Vite dev server --------
echo "[demo] preparing web UI at ${WEBUI_DIR} …"
if [[ ! -d "${WEBUI_DIR}/node_modules" ]]; then
  echo "[demo] installing web UI dependencies (first run)…"
  ( cd "${WEBUI_DIR}" && npm install )
fi

echo "[demo] starting web UI (vite dev) on :${WEBUI_PORT} …"
(
  cd "${WEBUI_DIR}"
  # Vite proxies /api/* to the backend; point it at our chosen backend port.
  export BACKEND_URL="http://localhost:${BACKEND_PORT}"
  exec npm run dev -- --port "${WEBUI_PORT}" --host
) &
PIDS+=("$!")

# --- 3) Banner ---------------------------------------------------------------
cat <<BANNER

==============================================================================
  Agentic SOC Triage Suite — DEMO is starting up
------------------------------------------------------------------------------
  Web UI :   http://localhost:${WEBUI_PORT}
  Backend:   http://localhost:${BACKEND_PORT}/api/health

  Login  :   username  ${ADMIN_USER}
             password  ${ADMIN_PASS}     (demo super_admin — change for real use)

  Auth is ENABLED and deterministic Demo Mode is SEEDED (no provider spend).
  Press Ctrl-C to stop both services.

  Walkthrough script:  see DEMO.md
==============================================================================

BANNER

# Wait on the children; the EXIT trap cleans up on Ctrl-C or any exit.
wait
