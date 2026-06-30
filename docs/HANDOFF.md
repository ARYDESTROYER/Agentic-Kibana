# Developer & Agent Handoff — START HERE

> **If you are a new chat session or a developer picking this up cold, read this file first,
> then `CLAUDE.md` (the master rulebook, auto-loaded every session).** This is the single
> source of truth for *where we are*, *how to run it*, *what's done*, and *what's next*.
> Everything in here is verified against the repo as of the date below — not from memory.

- **Repo:** `ARYDESTROYER/Agentic-Kibana`  ·  **Branch:** `Testing`  ·  **Date:** 2026-06-30
- **Status:** Round 1 + Round 2 overhauls **complete and committed** (local `Testing`, **not pushed**).
- **Green baseline (verified):** backend **794 pytest** pass · webui **build clean** (tsc + vite) ·
  **86 vitest** pass (19 files) · **eslint 0 `react-hooks/rules-of-hooks` errors** (2 benign
  `exhaustive-deps` warnings) · `engine/case_manager.py` **byte-identical** to its pre-overhaul
  decision logic · **zero new runtime dependencies** added across both rounds.

---

## 1. What this is (30-second orientation)

The **TLSOC / Agentic SOC Platform** is a vendor-agnostic agentic SOC triage system: it ingests
security alerts from pluggable sources, normalises to OCSF, correlates + risk-scores
deterministically, runs a two-tier LLM investigation, and turns the result into audited,
cost-metered, human-reviewable **cases** — with a deterministic close/escalate policy that an LLM
can never override.

- **Backend** (`backend/`) — FastAPI + LangGraph. All agentic logic, connectors, auth/RBAC/MFA/SSO,
  sessions, notifications, demo mode, stores. Python stdlib-first (zero heavy deps).
- **WebUI** (`webui/`) — the **primary** surface: Vite + React + **Tailwind + shadcn/radix**
  (NOTE: the old `@elastic/eui` UI is retired — do not reintroduce it). Talks to the backend via an
  `/api` proxy.
- **Kibana plugin** (`archive/kibana-plugin/`) — **archived**; not built/shipped. Ignore unless reviving.

---

## 2. Quick start (verified commands)

### Backend tests (offline; fake ES + mock LLM; must stay green)
```bash
cd backend
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt        # greenlet is pinned, so a fresh install is green
python -m pytest -q                         # -> 794 passed
```

### WebUI build + tests + lint
```bash
cd webui
npm install
npm run build      # tsc --noEmit && vite build  -> clean
npx vitest run     # -> 86 passed (19 files)
npm run lint       # eslint; must be 0 react-hooks/rules-of-hooks ERRORS (2 exhaustive-deps warnings OK)
```

### Run the demo locally (the fastest way to SEE everything)
```bash
./scripts/run-demo.sh
# Starts the backend (app.main:app on :8088, AUTH ENABLED) + the webui dev server (:5173).
# Open http://localhost:5173  ·  log in with  Admin / Admin@123  (seeded super_admin)
# Then Settings -> Experimental -> Demo Mode: enable it for an instant, fully-populated,
# isolated, $0 showcase (old + recent cases + live-simulated alerts). "Exit & clear" reverts.
```
- **Auth is default-OFF** for the library/tests (the no-auth profile stays the out-of-the-box
  default). It is enabled by `TLSOC_AUTH_ENABLED=true` (which `run-demo.sh` sets). When enabled and
  the user store is empty, the backend seeds **`Admin` / `Admin@123`** (super_admin). Change this for
  any real deployment (`backend/app/config.py` `auth_seed_admin_*`; see `SECURITY.md`).
- Full deploy (Docker) in `DEPLOY.md`; the guided product tour in `DEMO.md`.

---

## 3. Repo map (where to look)

```
backend/app/
  config.py        Secrets (env-only) + Preferences (UI-editable). EVERY new setting lands here.
  constants.py     enums (CaseStatus/Disposition, Verdict, UserRole, IndexRole incl. ignore, ...)
  models.py        Pydantic contracts (Case, User(+profile/MFA/SSO), Session, SavedView, ...)
  api/routes.py    THE big FastAPI router (every endpoint).  api/deps.py = auth/RBAC gates.
  auth/            passwords (PBKDF2) · tokens (stdlib HS256 JWT, sid/tv claims) · service ·
                   mfa (RFC-6238 TOTP) · oidc (SSO code-exchange)
  rbac/policy.py   the role->resource->action permission matrix + can()
  stores/          backend-agnostic KV-doc stores: users · sessions · user_prefs · memory ·
                   cases/usage/config/cursor · sql/ (SQLite/Postgres) — NO new index/table needed
  notifications/   channel SPI · email (SMTP+SES) · resend · webhook/slack/teams · templates · dispatch
  connectors/      SPI + registry · elastic/opensearch/wazuh · demo.py · receivers/
  engine/          correlation · risk · case_manager (decide()/apply() — #3) · case_id · poller ·
                   ingest · metrics · threshold_automation · threat_context · mitre · demo_generator/runtime
  agents/          router · investigator · formatter · chat · standup · overview · personas · pipeline
  threat/          bundled compact MITRE ATT&CK technique map (+ refresh script)
webui/src/
  soc/pages/       Login, Cases, CaseDetail, Settings (the consolidated hub), Account, Sessions,
                   Users, Security, Audit, Workspace(Chat+Investigate), Analytics(Metrics+Cost),
                   Home(Overview+Standup), Intelligence(Knowledge+Memory+Catalog), Scans, ...
  soc/components/  RiskGauge, QRCode, CommandPalette, SavedViewsBar, DataTable, NotificationsEditor,
                   SourceEditor (feeds), DemoBanner, badges, charts, HelpTip, ...
  ui/              shadcn/radix primitives (button, dialog, command, table, ...)
  lib/             api.ts (client) · types.ts (keep in sync with backend models) · format · cn
```

---

## 4. The rules you must not break (the 12 non-negotiables)

Full text in `CLAUDE.md` §5. The ones that bite hardest:
- **#3 — the deterministic decision.** `engine/case_manager.py` `decide()`/`apply()` decision logic
  is **byte-identical** and is the ONLY producer of CLOSED/auto-close. No LLM, playbook, automation,
  bulk action, or demo path may set a case's status/disposition outside `apply()` or the
  human analyst action path. There is a guard test (`test_wave6_decide_guard` / the bulk + automation
  tests) that fails if `decide()` changes or is bypassed. **Keep it byte-identical.**
- **#9 — untrusted fencing.** Any log/source/user-influenceable text (case fields, session UA/IP,
  display names, avatars, terminology, email vars, search results) renders as **plain text** and is
  **fenced** before any LLM prompt. Email templates auto-escape; `{{{raw}}}` is whitelisted to trusted keys only.
- **#10 — secrets.** Env/in-memory secret tier only; the UI shows `configured ✓` booleans, never values.
- **#1 read-only scoped log key**, **#2 append-only audit**, **#4 durable cursor (no skip/dup)**.

### Engineering conventions (how this codebase stays green)
- **ZERO new runtime deps** — backend stdlib-first; webui composes the already-installed
  radix/shadcn/framer/recharts/lucide/cmdk. (eslint is the only added *dev* dep.) If you think you
  need a dep, look for an existing one first.
- **Additive + back-compatible.** New stores are KV-doc (no new index/table/migration). New model
  fields are defaulted so old persisted docs load unchanged.
- **eslint `react-hooks/rules-of-hooks` is enforced as an error** (`npm run lint`). All hooks go
  ABOVE any `if (loading) return ...` early return (this caused a real `#310` crash; it's now locked).
- **Auth gates are no-ops when auth is OFF**, so adding a `require_permission(...)` never regresses the
  default profile or the offline tests. **`test_route_auth_coverage.py` now fails CI if any non-GET
  `/api` route lacks an authZ gate** — add the gate when you add a state-changing route.
- **Keep `webui/src/lib/types.ts` in sync with the backend pydantic models.**

---

## 5. What's been built

### Round 1 (commits up to `3e55887`) — the agentic suite + first overhaul
RBAC/OOBE, MFA(TOTP)+SSO(OIDC), status+disposition taxonomy + customizable case-`XXXX` nomenclature +
case overview panel, pluggable notifications (email + slack/teams/webhook), multi-source
Auto-Correlate, playbook automation + threat-context + resolved-case knowledge loop, consolidated
Settings, UI cleanup. (See `CHANGELOG.md` "Waves 1–7" + `docs/research/2026-06-overhaul/`.)

### Round 2 (commits `9ab2954` → `3cd7eec`) — this session
| Commit | Wave | What |
|---|---|---|
| `9ab2954` | W1 | Bug fixes: RiskGauge (dasharray ring), MFA QR (ISO format-info) + clipboard, duplicate close X, chat framing, store-degraded tooltip |
| `317bd5a` | W2 | Login redesign (brand hero + aurora, OTP, SSO icons) + account self-service (profile/avatar/alt-email/timezone) |
| `88cb3c6` | W3 | Sessions registry + revocation + token policy (TTL/idle/absolute), admin terminate (±notify), user activity |
| `9eb7d57` | W4 | **Settings IA**: Account/Users/Security/SSO/Sessions folded under Settings; near-duplicate pages consolidated |
| `93ac735` | W5 | **Demo Mode**: reversible, isolated separate store, $0 mock LLM, hides real data, live-sim + historical spread |
| `2ada050` | W6 | Source **multi-feed**: events/alerts/**ignore** per-feed config + per-feed cursors (back-compatible) |
| `f0909af` | W7a | Email **Resend + SES** + stdlib template engine (5 preloaded, customizable) + preview |
| `36ff656` | W7b | **Customization**: UserPrefsStore + saved views + table columns + terminology + per-user theme (org↔user cascade) |
| `5869f13` | W7c | **Cmd-K command palette** + global search + **bulk case actions** + **audit-log viewer** |
| `aae7a76` | Final | 16-agent adversarial audit + docs refresh + 8 confirmed fixes (RBAC gates, poller isolation, gauge band) |
| `763ded9` | Remediation | Fixed confirmed HIGH/MEDIUM audit findings (+22 regression tests) — see §6 |

Design blueprints (read these before extending a feature): `docs/research/2026-06-round2/ROUND2_DESIGN.md`
(per-wave designs with file:line anchors), `ROUND2_BUGS.md`, `ROUND2_BEST_OF_BEST.md`, `ROUND2_AUDIT.md`,
`ROUND2_PLAN.md` (the live tracker + status log).

---

## 6. Known issues / deferred (next-round candidates)

Found by the adversarial audit, **deliberately deferred** (low severity or needs a deliberate
architectural decision). Full detail + file:line in `docs/research/2026-06-round2/ROUND2_AUDIT.md`:
- **Session KV optimistic concurrency** — the session store is lock-free read-modify-write; a revoke
  racing a touch/create could be lost under high concurrency (single-process is fine today).
- **Multi-generation refresh-reuse detection** — only the last rotation generation is tracked.
- **Shared `CONFIG_INDEX` nested-type collision** (ES-only, speculative).
- **Deep-link breadcrumb** for folded sub-pages shows "Overview" (cosmetic).

**Best-of-best roadmap (Tier 2/3, not yet built)** — `ROUND2_BEST_OF_BEST.md`: API keys / programmatic
access, a dashboard builder, scheduled reports, watchlists, SLA timers, a hunting/query builder,
case linking/merge, an integrations marketplace.

---

## 7. Documentation index (what to read for what)

| You want to… | Read |
|---|---|
| Get the rules + current status (auto-loaded each session) | `CLAUDE.md` |
| Onboard / hand off (this) | `docs/HANDOFF.md` |
| Use a feature (how-to + curl) | `docs/USAGE.md` |
| Deploy (Docker, auth, SMTP/SSO env) | `DEPLOY.md` · `docs/ENVIRONMENT.md` · `.env.example` |
| Run a live demo / give a tour | `DEMO.md` · `scripts/run-demo.sh` |
| Security posture + hardening TODOs | `SECURITY.md` |
| What changed, when | `CHANGELOG.md` · `Journal.md` |
| Round-2 design intent (extend a feature) | `docs/research/2026-06-round2/ROUND2_DESIGN.md` |
| Audit findings + dispositions | `docs/research/2026-06-round2/ROUND2_AUDIT.md` |
| What's next | `ROADMAP.md` · `ROUND2_BEST_OF_BEST.md` |

---

## 8. For a new AI chat session specifically

1. `CLAUDE.md` is auto-loaded — it has the non-negotiables, the module map, and the status. Trust it,
   but **verify any file/function/flag it names still exists before acting** (the codebase moves).
2. The memory files (auto-recalled) point back here. The Round-2 design docs are the implementation blueprint.
3. **Before committing anything:** `pytest -q` (794) green, `npm run build` clean, `npx vitest run` (86)
   green, `npm run lint` 0 rules-of-hooks errors, and `git diff backend/app/engine/case_manager.py`
   **empty** (decision logic unchanged). Commit focused changes; **don't push** unless asked.
4. This repo was built with review-gated, self-verifying waves (research → implement → pytest/build/
   vitest/lint → fix-loop → independent re-verify → commit). Keep that rhythm.
