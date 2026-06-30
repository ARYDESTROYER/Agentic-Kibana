# DEMO.md — Guided demo walkthrough

A crisp, copy-pasteable script for **presenting** the Agentic SOC Triage Suite.
It brings the suite up locally with **auth enabled** (so the redesigned login,
6-role RBAC, MFA, sessions, and SSO surfaces are all live) and walks a presenter
through every headline feature in order. Budget ~15-20 minutes.

> **Fastest path to a great demo:** if you just want a populated, $0, fully
> isolated showcase with no source wiring, skip straight to **§3a — Demo Mode**.
> One click seeds weeks of synthetic cases (and can keep generating new ones
> live), then one click clears it all. Everything else below still works on top of
> it.

> **What you'll show (Round 2 included, in order):** the **redesigned 2-column
> login** + account self-service, the **Cmd-K command palette** + global search,
> **Demo Mode** (one-click populated showcase), a **case overview** + **bulk
> actions**, **sessions** (device list + remote sign-out), the **consolidated
> Settings IA**, **per-feed sources** (alerts/events/ignore), **notifications**
> (incl. Resend + SES + customizable email templates), **per-user customization**
> (saved views, table columns, terminology, theme), MFA/SSO, run-a-playbook +
> threat context, the **audit viewer**, and the Overview / RiskGauge.

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

## 2. Log in (the redesigned login)

Open the web UI. Because auth is enabled and the user store starts empty, the
backend has auto-seeded a demo **super_admin**:

| Username | Password |
|---|---|
| `Admin` | `Admin@123` |

Things to point out on the **redesigned login** before you sign in:
- It's a **2-column split**: a left **brand hero** (org name / logo / tagline from
  `GET /api/branding`, with a drifting aurora glow that uses the secondary accent
  colour) and a right **form card**. The hero is `hidden lg:block`, so on a phone
  you just see the clean form.
- The same screen drives all four flows: **sign-in**, the **first-run / forced
  password change** (with a live, dependency-free **password-strength meter**),
  the **MFA** step (a 6-cell segmented OTP input), and any configured **SSO**
  buttons (per-provider Google / Microsoft / generic brand icons).

Sign in. (For a real deployment, change this immediately — see §3i.)

> If you ran `run-demo.sh`, these creds are also echoed in the startup banner.

---

## 3. The guided tour (hit these in order)

### 3a. ⭐ Demo Mode — the one-click populated showcase — *Settings → Experimental* (super_admin)
This is the showpiece. It populates the whole product with realistic, **isolated,
$0** synthetic data so every page has something to show — no source wiring, no LLM
spend, no risk to real state. It is **fully reversible in one click**.

- Open **Settings → Experimental** and **enable Demo Mode**. Two modes:
  - **`seeded`** — instantly back-fills ~2 weeks of synthetic cases (old + recent),
    audit, and cost rows from a fixed seed, so it's deterministic and repeatable.
  - **`live`** — also starts a background simulator that keeps emitting benign
    traffic plus the occasional MITRE ATT&CK storyline (phishing → cred-access →
    lateral → exfil, RDP brute-force, SQLi → webshell, impossible-travel,
    ransomware beacon, insider staging) on a jittered tick, so new cases appear
    *while you present*.
- Notice the amber **Demo banner** pinned in the app shell and the **`SAMPLE`**
  badge on every demo row; cost tiles read **"(simulated)"**. Real-write actions
  (real connector runs, real notifications, live policy changes) are disabled while
  demo is on, so you cannot accidentally touch production state.
- Synthetic events flow through the **REAL pipeline** (correlation → risk →
  router → investigator → case manager) against a separate in-memory store and a
  deterministic **mock LLM** — so what you're showing is the genuine product, just
  sandboxed. NEEDS_HUMAN cases stay open (the HITL showcase); FALSE_POSITIVE runs
  through the real deterministic `decide()` against a *sandboxed* policy copy
  (proving non-negotiable #3 without touching the live policy).
- Knobs to mention: `seed`, `history_days`, `tick_seconds` / `tick_jitter`,
  `incident_rate`.
- **Reset** re-seeds from the same seed (clean slate, same data). **Exit & clear**
  stops the simulator and **hard-deletes everything by `run_id`** across
  cases/audit/usage/events, then flips Demo Mode off — the suite is exactly as it
  was. *Do this live at the end so the audience sees it's truly reversible.*
- Endpoints (all admin-gated): `GET /api/demo/status`, `POST /api/demo/enable`,
  `POST /api/demo/reset`, `POST /api/demo/disable`.

> From here on, **leave Demo Mode ON** so Cases/Overview/Metrics/Audit have data
> to show. Remember to **Exit & clear** in §4.

### 3b. Cmd-K command palette + global search — *anywhere*
- Press **⌘K** (macOS) / **Ctrl-K** (Win/Linux) to open the **command palette**.
- Type to jump to any page, run quick actions, and run **global search** across
  cases (backed by `GET /api/search`) — open a case straight from the results.
- Great moment to show how fast the redesigned IA is to navigate without the mouse.

### 3c. A case — overview panel + bulk actions — *Cases*
- On the **Cases list**, show **multi-select** + the **bulk action bar**: select
  several demo cases and apply a single action to all of them
  (`POST /api/cases/bulk`). The bulk path runs through the **same RBAC and the same
  analyst-action handler** as a single case — so it is exactly as safe.
- Open one case. **Overview panel:** the polished summary (entities, verdict,
  confidence, risk).
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
  never auto-closed — even from a bulk action or an automation rule.

### 3d. Account self-service + sessions — *Settings → Account*
- **Profile** (`GET/PUT /api/account/me`): edit **display name**, **avatar** (the
  browser crops/resizes to a tiny WebP before upload; SVG is rejected),
  **alt email**, **timezone**, **locale**. Self-service — no admin needed.
- **Sessions** (`GET /api/sessions`): show the list of **active sessions** as
  device cards — current one pinned with a **"This device"** badge, plus
  Device/Browser, Location (IP + city/country, rendered as plain text),
  Last-active, and Signed-in columns.
  - **Revoke** a single other session (`POST /api/sessions/{sid}/revoke`), or click
    **"Sign out all other sessions"** (`POST /api/sessions/revoke-others`).
  - Talking points: sessions are **server-enforced** (idle timeout / absolute
    lifetime / revocation checked in `require_auth`), and **refresh-token rotation
    with reuse detection** auto-revokes a stolen token. A super_admin can also
    force-terminate **any** user's sessions from the admin sessions console
    (`GET /api/admin/sessions`, `POST /api/admin/sessions/{sid}/revoke`).

### 3e. Consolidated Settings IA — *Settings*
- Show the new **two-scope Settings**: a **Personal Account** scope (Profile /
  Preferences / Notifications / Security / Sessions — open to every signed-in user)
  and an **Organization** scope (admin-gated: Users, Security & SSO, Sources,
  Automation, Branding, token policy, …) in **one left rail** with grouped headers.
- Note that **RBAC hides what you can't touch**: admin sections simply don't appear
  for a lower-tier user (and the rail auto-collapses empty groups). When auth is
  off, everything shows.
- The whole top-level nav is grouped into **≤5 areas** (Overview / Triage /
  Intelligence / Analytics / Admin) and several near-duplicate pages were merged
  into tabbed surfaces (Investigate into Chat; Cost/Feedback into Metrics; Standup
  into Overview; Knowledge/Memory/Catalog under Intelligence).

### 3f. Users, roles, MFA & SSO — *Settings → Organization → Users / Security*
- **Users & roles (RBAC):** show the **users list** (persisted in a KV-doc; no new
  index/table). **Create a user** and assign one of the **6 roles**:
  `super_admin` · `soc_manager` · `analyst_tier2` · `analyst_tier1` ·
  `responder` · `auditor`. Server-side, every route is gated by
  `require_permission`; the UI mirrors it with `<Can>` guards.
- **MFA enrollment (TOTP):** click **Enroll MFA** — a **QR code renders inline**
  (SVG, no external calls). Scan it with any authenticator; enter the 6-digit code
  to confirm; **single-use recovery codes** are shown — save them. Log out and back
  in to show the **two-phase login** (password → the §2 segmented OTP).
- **SSO configuration:** add an **OIDC provider** (Google / Microsoft / generic);
  fill issuer + client id; the **client secret goes to the SECRET tier** (env or
  runtime push), never the config store. Show **group → role provisioning**. The
  callback URI to register with the IdP is **`<base-url>/api/auth/sso/callback`**
  (see `DEPLOY.md` §10).
- **Token / session policy** (*Organization → Security*): the idle timeout,
  absolute lifetime, refresh TTL, and step-up ("sudo") re-auth window are all
  **UI-editable** here (defaults: 12h idle, 30-day absolute/refresh, 10-min sudo).

### 3g. Sources — per-feed config + Auto-Correlate + inline help — *Settings → Sources* (or wizard)
- **Add a source** (a webhook is the fastest live demo: no external cluster).
- **Per-feed (multi-feed) config:** each index pattern is now its own **feed** with
  a **role** — **alerts** (auto-investigate), **events** (correlate only), or
  **ignore** (skip entirely) — plus per-feed **query**, **field-mapping override**,
  **severity floor**, **schedule**, and split **correlate** / **auto-investigate**
  switches. Mention that a severity floor never *drops* an event (#4) — it just
  holds it back from auto-forwarding.
- Hover the **(?) HelpTips** and open the **connector setup help**; use the
  **analyze-sample** affordance to paste a sample event and preview the field
  mapping. *(Optional)* enable **cross-source correlation** to link related cases by
  a shared entity (ip / host / user / file_hash / domain).
- *(If you want a real non-demo case)* push a sample alert (replace the token + id):

  ```bash
  curl -X POST http://localhost:5173/api/sources/<source_id>/secrets \
    -H 'Content-Type: application/json' -d '{"token":"demo-token"}'

  curl -X POST http://localhost:5173/api/ingest/<source_id> \
    -H 'Authorization: Bearer demo-token' -H 'Content-Type: application/json' \
    -d '{"event.module":"web_auth","source.ip":"203.0.113.7","user.name":"alice"}'
  ```

### 3h. Notifications + email templates — *Settings → Notifications*
- Add a channel. Email options now include the **`email` (SMTP, 13 provider
  presets)** channel, the **`resend`** channel (HTTPS API), and an **SES** preset
  (an SMTP-preset entry — host `email-smtp.{region}.amazonaws.com`, region from
  channel config); plus **Slack / Teams / webhook / PagerDuty / Telegram**.
- The channel secret (SMTP password, **Resend API key**, SES IAM secret, webhook
  URL, API token) goes in the **secret tier** — set via the UI or
  `POST /api/notifications/channels/{id}/secret` (env at boot via
  `TLSOC_NOTIFICATION_SECRETS`); the UI only ever shows `configured ✓`.
- **Customizable email templates:** open the **template editor** and **preview**
  pane. There are 5 preloaded, operator-overridable templates (`case.new`,
  `case.escalation`, `case.resolved`, `digest.daily`, `test`); the server renders
  the preview (`POST /api/notifications/preview?trigger=…`) with a tiny
  mustache-subset renderer that **HTML-escapes every interpolated variable** —
  point this out as a #9 (untrusted-data) safeguard.
- Click **Send test** and show the message land. Show **per-condition triggers** +
  **dedup / rate-limit / digest** controls.

### 3i. Per-user customization — saved views, columns, terminology, theme — *across the app + Settings → Appearance*
- **Saved views:** filter/sort the Cases list, then **save the view** from the
  saved-views bar; switch between personal views (`GET/POST/PUT/DELETE /api/views`,
  `POST /api/views/{id}/clone`). Org-default views can be cloned to personal.
- **Table columns:** show/hide and reorder columns; the choice persists per user
  (`PUT /api/prefs/user/tables/{table_id}`).
- **Terminology:** in **Appearance**, relabel domain nouns (e.g. "Case" → "Alert",
  "Source" → "Sensor"); the change cascades through the UI via the `t()` helper
  (`GET/PUT /api/terminology`, admin PUT).
- **Theme:** toggle **light / dark / system**; it persists in your user prefs.
- These resolve through a cascade — org Preferences then per-user prefs — exposed
  at `GET /api/prefs/effective` (`/api/prefs/user`, `/api/prefs/org`).

### 3j. Automation rule — *Settings → Automation*
- Create a **threshold rule**. Show the **#3-safe** action menu:
  `tag` / `recommend` / `notify` / `run_playbook` / `request_approval`.
- Emphasize: **automation NEVER sets case status** — `request_approval` raises a
  **HITL proposal** for a human to approve; it cannot close or escalate on its own.

### 3k. Audit viewer — *Audit* (or Admin → Audit)
- Open the **audit viewer** (`GET /api/audit`): an append-only, filterable record
  of every agent and operator action (#2). Filter by actor / action type / surface
  and show a few demo entries — including the **Demo-Mode enable** you triggered in
  §3a, which is recorded on the *real* audit log as a real admin action.

### 3l. Overview / RiskGauge — *Overview / Dashboard*
- Land on the **Overview**: KPI tiles, verdict/status mix, trend (all populated by
  Demo Mode).
- Show the redesigned **RiskGauge** (the Active-Risk-Index glitch is fixed).
- Point out the polish layer: **skeleton/shimmer loading**, staggered reveals,
  8px-grid alignment, **WCAG AA** contrast.

---

## 4. Reset / teardown

- **Exit Demo Mode first** (if you enabled it in §3a): *Settings → Experimental →
  **Exit & clear*** (or `POST /api/demo/disable`). This stops the live simulator and
  **hard-deletes all synthetic data by `run_id`** — leaving any real state
  untouched. (Use **Reset** instead to re-seed the same dataset for another run.)
- **`run-demo.sh`:** press **Ctrl-C** — it tears down both processes.
- **Docker:** `docker compose -f deploy/docker-compose.agnostic.yml down`
  (add `-v` to also drop the Postgres volume for a clean slate).
- **Auth & session state** live in the state backend; for the in-memory/local demo
  they reset on backend restart (the `Admin/Admin@123` super_admin re-seeds, and
  with no stable `TLSOC_AUTH_JWT_SECRET` all sessions are invalidated on restart).

---

## 5. Notes & gotchas

- **Auth is DEFAULT OFF** in the committed config for back-compat and tests;
  `run-demo.sh` (and the env in Option B/C) turn it on. Without
  `TLSOC_AUTH_ENABLED=true` there is **no login** and every user is treated as
  `super_admin`.
- Use a **stable** `TLSOC_AUTH_JWT_SECRET` or sessions die on every backend
  restart (the §3d sessions list will look empty after a restart). `run-demo.sh`
  generates one per run (fine for a single sitting).
- **Demo Mode is $0 and uses the mock LLM regardless of any key** — it never spends
  real tokens or writes real state. For a *non-demo* live investigation you need a
  real provider key; otherwise the **mock LLM** is used (perfectly fine for a UI
  walkthrough).
- **Demo Mode requires super_admin** and is found under *Settings → Experimental*;
  the same gate (`require_admin`) protects all `/api/demo/*` endpoints.
- Secret values are **never** shown in the UI — you only ever see `configured ✓`.
  That includes the new **Resend API key** and **SES** credentials.
