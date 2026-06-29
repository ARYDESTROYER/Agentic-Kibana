# DEMO.md — Guided demo walkthrough

A crisp, copy-pasteable script for **presenting** the Agentic SOC Triage Suite.
It brings the suite up locally with **auth enabled** (so the login, 6-role RBAC,
MFA, and SSO surfaces are all live) and walks a presenter through every headline
feature in order. Budget ~10-15 minutes.

> **What you'll show:** persisted multi-user + RBAC, MFA enrollment, SSO config,
> adding a source with Auto-Correlate + inline help, a case (overview panel /
> status+disposition / run-a-playbook / threat context), notification send-test,
> a threshold automation rule, the consolidated Settings, and the Overview /
> RiskGauge.

---

## 0. Prerequisites

- **Python 3.11** and **Node 22** on PATH (no Docker required for the quick path).
- *(Optional)* a real LLM key (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`) for live
  triage; without one the suite uses the built-in **mock** provider, which is fine
  for a UI-driven demo.

---

## 1. Quick start

### Option A — one command (recommended for a live demo)

From the repo root:

```bash
./scripts/run-demo.sh
```

This:
- creates/uses `backend/.venv`, installs backend deps on first run, and starts
  **uvicorn `app.main:app` on :8088** with **`TLSOC_AUTH_ENABLED=true`** and a
  generated dev **`TLSOC_AUTH_JWT_SECRET`**;
- installs the web UI deps on first run and starts the **Vite dev server on
  :5173** (it proxies `/api/*` to the backend);
- prints the URL and the seeded **`Admin` / `Admin@123`** credentials.

Open **http://localhost:5173**. Press **Ctrl-C** to stop both.

For live triage, prefix with a key, e.g.
`ANTHROPIC_API_KEY=sk-... ./scripts/run-demo.sh`.

### Option B — by hand (two terminals)

```bash
# Terminal 1 — backend with auth on
cd backend
python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt
# NOTE: a DIRECT uvicorn run reads UNPREFIXED env names (the TLSOC_* prefix is the
# .env convention that ONLY the compose file maps). So set the unprefixed names:
export AUTH_ENABLED=true
export AUTH_JWT_SECRET="$(python3 -c 'import secrets;print(secrets.token_hex(24))')"
python -m uvicorn app.main:app --port 8088
```

```bash
# Terminal 2 — web UI dev server (proxies /api -> :8088)
cd webui
npm install
npm run dev          # serves http://localhost:5173
```

### Option C — Docker (full agnostic stack)

```bash
cp .env.example .env                 # set TLSOC_PG_PASSWORD + one LLM key
# Enable the auth demo posture:
#   TLSOC_AUTH_ENABLED=true
#   TLSOC_AUTH_JWT_SECRET=<32+ random bytes>
docker compose -f deploy/docker-compose.agnostic.yml up -d --build
```

Open **http://localhost:8080**. (See `DEPLOY.md` §3 for the full stack and §8/§10
for the auth/MFA/SSO/notification setup.)

---

## 2. Log in

Open the web UI. Because auth is enabled and the user store starts empty, the
backend has auto-seeded a demo **super_admin**:

| Username | Password |
|---|---|
| `Admin` | `Admin@123` |

Log in. (For a real deployment, change this immediately — see step 3.)

> If you ran `run-demo.sh`, these creds are also echoed in the startup banner.

---

## 3. The guided tour (hit these in order)

### 3a. Users & roles (RBAC) — *Settings → Users / Access*
- Show the **users list** (persisted in a KV-doc; no new index/table).
- **Create a user** and assign one of the **6 roles**:
  `super_admin` · `soc_manager` · `analyst_tier2` · `analyst_tier1` ·
  `responder` · `auditor`.
- Point out that the UI itself enforces permissions with `<Can>` guards — log out
  and back in as a lower-tier user to show buttons/sections disappearing
  (server-side, every route is gated by `require_permission`).

### 3b. MFA enrollment (TOTP) — *Settings → Security → My MFA* (or your profile)
- Click **Enroll MFA**. A **QR code renders inline** (SVG, no external calls).
- Scan it with any authenticator (Google Authenticator / Authy / 1Password).
- Enter the 6-digit code to confirm; **single-use recovery codes** are shown —
  save them.
- Log out and back in to show the **two-phase login** (password → TOTP).

### 3c. SSO configuration — *Settings → Security → SSO*
- Add an **OIDC provider** (Google / Microsoft / generic). Fill issuer + client id;
  the **client secret goes to the SECRET tier** (env or runtime push), never the
  config store.
- Show **group → role provisioning** (map an IdP group to one of the 6 roles).
- The callback/redirect URI the suite hands the IdP is
  **`<your-base-url>/api/auth/sso/callback`** — note it for registration (see
  `DEPLOY.md` §10 for Google/Microsoft registration steps).

### 3d. Add a source + Auto-Correlate + inline help — *Settings → Sources* (or wizard)
- **Add a source** (a webhook is the fastest live demo: no external cluster).
- Show the **Auto-Correlate** toggle **per source** *and* per **sub-source**
  (index pattern).
- Hover the **(?) HelpTips** and open **connector setup_help**; use
  **analyze-sample** to paste a sample event and preview the field mapping.
- *(Optional)* enable **cross-source correlation** to link RELATED cases by a
  shared entity (ip / host / user / file_hash / domain).
- Push a sample alert to make a case appear (replace the token + id):

  ```bash
  curl -X POST http://localhost:5173/api/sources/<source_id>/secrets \
    -H 'Content-Type: application/json' -d '{"token":"demo-token"}'

  curl -X POST http://localhost:5173/api/ingest/<source_id> \
    -H 'Authorization: Bearer demo-token' -H 'Content-Type: application/json' \
    -d '{"event.module":"web_auth","source.ip":"203.0.113.7","user.name":"alice"}'
  ```

### 3e. A case — *Cases → open one*
- **Overview panel:** the polished summary (entities, verdict, confidence, risk).
- **Status + disposition taxonomy:** drive the lifecycle —
  `NEW → INVESTIGATING → ESCALATED / ON_HOLD → RESOLVED` (the original
  `open/needs_human/closed` remain as aliases), and set a **Disposition**
  (`true_positive` / `false_positive` / `benign` / `suspicious` / `duplicate` /
  `undetermined`). Show the **status_history**.
- **Run a playbook:** trigger a **context-only re-investigation** against a chosen
  playbook.
- **Threat context panel:** IOC reputation + bundled **MITRE ATT&CK (697
  techniques)** + related cases (fails open if enrichment is unavailable).
- *(Talking point — non-negotiable #3):* the **close/escalate decision is
  deterministic code**; the LLM verdict only recommends, and a TRUE_POSITIVE is
  never auto-closed.

### 3f. Notifications send-test — *Settings → Notifications*
- Add a channel — **email (SMTP)** has **13 provider presets**; or
  **Slack / Teams / webhook / PagerDuty / Telegram**.
- Put the channel secret (SMTP password / webhook URL / API token) in the
  **secret tier** (env or runtime push).
- Click **Send test** and show the message land.
- Show **per-condition triggers** + **dedup / rate-limit / digest** controls.

### 3g. Automation rule — *Settings → Automation*
- Create a **threshold rule**. Show the **#3-safe** action menu:
  `tag` / `recommend` / `notify` / `run_playbook` / `request_approval`.
- Emphasize: **automation NEVER sets case status** — `request_approval` raises a
  **HITL proposal** for a human to approve; it cannot close or escalate on its own.

### 3h. Consolidated Settings — *Settings*
- Show the **13 sections across 4 nav groups** in one consolidated Settings shell.
- Mention the machine-readable schema at **`GET /api/settings/schema`**.

### 3i. Overview / RiskGauge — *Overview / Dashboard*
- Land on the **Overview**: KPI tiles, verdict/status mix, trend.
- Show the redesigned **RiskGauge** (the Active-Risk-Index glitch is fixed).
- Point out the polish layer: **skeleton/shimmer loading**, staggered reveals,
  8px-grid alignment, **WCAG AA** contrast.

---

## 4. Reset / teardown

- **`run-demo.sh`:** press **Ctrl-C** — it tears down both processes.
- **Docker:** `docker compose -f deploy/docker-compose.agnostic.yml down`
  (add `-v` to also drop the Postgres volume for a clean slate).
- **Auth state** lives in the state backend; for the in-memory/local demo it
  resets on backend restart (the `Admin/Admin@123` super_admin re-seeds).

---

## 5. Notes & gotchas

- **Auth is DEFAULT OFF** in the committed config for back-compat and tests;
  `run-demo.sh` (and the env in Option B/C) turn it on. Without
  `TLSOC_AUTH_ENABLED=true` there is **no login** and every user is treated as
  `super_admin`.
- Use a **stable** `TLSOC_AUTH_JWT_SECRET` or sessions die on every backend
  restart. `run-demo.sh` generates one per run (fine for a single sitting).
- The **mock LLM** is used unless you export a real provider key — perfectly fine
  for a UI walkthrough; use a real key to show genuine investigations.
- Secret values are **never** shown in the UI — you only ever see `configured ✓`.
