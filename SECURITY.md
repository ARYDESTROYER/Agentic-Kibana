# SECURITY.md — Threat model & security posture

This document describes the security posture of the **Agentic SOC Triage Suite** —
a vendor-agnostic, LLM-driven SOC triage tool that runs **next to** your existing
security telemetry as a **read-only consumer**. Because the suite reads
attacker-influenced event data (from any source) and drives Large Language Models
with it, its design treats every external surface as hostile and makes its safety
guarantees **deterministic code**, not model behaviour.

Every claim below is enforced somewhere in the tree; the enforcement point is cited
inline. See also the 12 non-negotiables in [`CLAUDE.md`](CLAUDE.md) §5,
[`README.md`](README.md), and [`docs/RUNBOOK.md`](docs/RUNBOOK.md) (rotation).

## 1. Trust boundaries

The suite spans these tiers. Each arrow crosses a trust boundary; the suite
**never** holds a write credential to any log source, and **never** uses a source's
superuser/admin credential at runtime.

```
┌──────────────┐   TLS reverse proxy   ┌──────────────┐                ┌──────────────────┐
│  Analyst     │   (nginx serves the   │  Standalone  │   relative     │  tlsoc-backend   │
│  browser     │ ──SPA + proxies /api─▶│  web UI      │ ──/api/* call─▶ │  (FastAPI +      │
│ (React/EUI)  │                       │  (nginx)     │   server-side   │   LangGraph)     │
└──────────────┘                       └──────────────┘                 └───────┬──────────┘
        ▲  booleans only,                                                       │
        │  never secret values            TRUST BOUNDARY 2                      │
   TRUST BOUNDARY 1                        (proxy: no secret in browser)        │
   (untrusted client)                                                          ▼
        ┌──────────────────────────── TRUST BOUNDARY 3 ───────────────────────────────┐
        │  per-source read-only creds      state-backend creds      egress (HTTPS)      │
        │           │                            │                        │             │
        ▼           ▼                            ▼                        ▼             │
  ┌──────────────────────────┐   ┌────────────────────────┐   ┌──────────────────────┐ │
  │ LOG SOURCES (READ-ONLY)  │   │ OWN STATE              │   │ LLM (anthropic/openai)│ │
  │  pull: ES/OpenSearch/    │   │  ES tlsoc-agent-* OR   │   │ Enrich: AbuseIPDB /   │ │
  │   Wazuh; push: webhook/  │   │  Postgres+pgvector OR  │   │         VirusTotal    │ │
  │   HEC/syslog/queues/…    │   │  SQLite                │   │ Cache:  Redis         │ │
  │  — UNTRUSTED DATA        │   │  — suite bookkeeping   │   └──────────────────────┘ │
  └──────────────────────────┘   └────────────────────────┘                            │
        └──────────────────────────────────────────────────────────────────────────────┘
```

| # | Boundary | Posture |
|---|----------|---------|
| 1 | Analyst browser ↔ web UI | The standalone SPA should sit **behind a TLS reverse proxy** with your own auth (the SPA itself is a thin viewer). The UI sees **booleans only** for secrets (`configured ✓`), never values (`config.py:configured_status`). |
| 2 | Web UI ↔ backend | The browser calls **relative** `/api/*` paths; nginx reverse-proxies them to `tlsoc-backend:8088` server-side (`webui/nginx.conf`). The browser bundle contains **no** backend URL or secret (no CORS, no embedded host). |
| 3 | Backend ↔ sources / state / LLM / enrichment | Per-source **read-only** credentials for every log source; a single least-privilege credential for the chosen state backend; outbound HTTPS to LLM/enrichment. **All inbound event data is treated as UNTRUSTED** (§4). |

## 2. Read-only, scoped source credentials (generalised principle #1)

The #1 non-negotiable — *a read-only, scoped credential for the agent's log
access* — now applies to **every** connector, not just Elasticsearch:

- **Pull connectors** (Elasticsearch / OpenSearch / Wazuh, future SIEMs) require a
  **read-only** API key/token scoped to the log index/pattern. The Elastic
  connector's manifest spells this out: *"a READ-ONLY API key scoped to the log
  index pattern only (never kibana_system or the elastic superuser)"*
  (`connectors/elastic.py`). The agent's `es_query`/search tools read only — they
  never write a source, and the prompts state the agent can ONLY read data.
- **Push receivers** never hold a source credential at all — the source authenticates
  **to us** (§3.1); the suite has no write path back to the source.

**ES state backend (default) keeps the two-key split.** When `STATE_BACKEND` is
`elasticsearch`, the suite still uses **two physically separate least-privilege
keys** for ES (`es/client.py` `_ro` + `_mgmt`): a read-only key for `all-logs-*`
and a management key for `tlsoc-agent-*`. Neither is `kibana_system` nor the
`elastic` superuser; a missing key yields a clear error, never a silent fallback to
a write credential.

| Key (env var) | Scope | Privileges |
|---|---|---|
| `ES_API_KEY` (read-only log source) | the log index pattern | `read`, `view_index_metadata` |
| `ES_MGMT_API_KEY` (ES state backend only) | `tlsoc-agent-*` | `read`, `write`, `create_index`, `view_index_metadata`, `manage` |

> A source's superuser/admin credential is used by an operator **once**, to mint
> the read-only key, then never at runtime (non-negotiable #1).

## 3. Secrets handling

| Property | Behaviour | Where |
|---|---|---|
| Source | **Environment / `.env`** for global keys; the **secret tier** for runtime/wizard-pushed and per-source values. | `config.py:Secrets` (`SettingsConfigDict(env_file=".env")`) |
| UI exposure | The UI sees **booleans only** (`configured ✓`); secret **values are never returned**. | `config.py:configured_status`; `routes.py` `/setup/status`, `/settings`, `/models` |
| Wizard-pushed global keys | Kept **in process memory only — lost on backend restart** (`state.apply_secrets`); `.env` is the durable path. | `routes.py:setup_secrets` |
| Clearing a key | An explicit `null` **revokes** a key (`exclude_unset`, not `exclude_none`). | `routes.py:setup_secrets` |
| Never persisted | Nothing secret is written to the **state store**, to **git**, or to **logs**. | `config.py` docstring |

### 3.1 Per-source secrets (the secret tier)

A source's secrets — a pull connector's read-only key, a webhook **bearer token**,
an **HMAC shared secret**, a cloud/broker credential — go to a dedicated
**in-memory secret tier** keyed by source id (`Secrets.connector_secrets`,
`set_source_secret`). They are **never persisted** to Preferences or any state
store; only the configured field **names** are recorded on the source
(`SourceInstance.configured_secrets`) and shown in the UI as configured-only
(non-negotiable #10). `POST /api/sources/{id}/secrets` sets/clears them; an empty
value revokes. Because they are in-memory, they must be re-set after a backend
restart (or supplied via env).

> Roadmap: an optional persisted **encrypted** secret store so wizard/per-source
> keys survive a restart. Until then, set durable secrets in `.env`.

## 4. Prompt-injection posture: inbound events are untrusted

All event data is **attacker-influenceable** — and with push receivers, an attacker
may even **POST directly** to an ingest endpoint. The suite treats every
event-derived value as **UNTRUSTED DATA** in prompts:

- Every event normalises to **OCSF** first (`ocsf/`). Whatever a connector cannot
  map deterministically lands in the first-class **`unmapped`** catch-all, and the
  original source record is kept in **`raw_data`** for audit/repro
  (`ocsf/model.py`). **Both `unmapped` and `raw_data` are attacker-influenceable**
  and are treated as untrusted data exactly like any mapped field.
- Every value placed in a prompt is wrapped in labelled, delimited fences
  `<<<UNTRUSTED_LOG_DATA>>> … <<<END_UNTRUSTED_LOG_DATA>>>`
  (`constants.UNTRUSTED_OPEN`/`CLOSE`) via `fence()` in `agents/prompts.py`.
- **Every** system prompt carries the security note telling the model to treat
  fenced content strictly as DATA and **never** follow instructions, URLs, or
  commands inside the fences (`prompts._INJECTION_NOTE`).
- Fencing applies to **everything attacker-influenceable**: entity values, rule
  names, sample event JSON (including `unmapped`/`raw_data`), enrichment, standup
  aggregate keys, and — for chat — screen-context, selection, and query inputs
  (non-negotiable #9).

### 4.1 Inbound push authentication

Push receivers authenticate the sender before parsing a single byte
(`connectors/receivers/webhook.py`, `verify_auth`):

- **`bearer`** — requires `Authorization: Bearer <token>` (also accepts `Splunk
  <token>` / a bare token) to equal the source's `token` secret, compared with
  **`hmac.compare_digest`** (constant-time) to avoid timing oracles. An unset token
  rejects everything.
- **`hmac`** — requires a hex **HMAC-SHA256 of the exact request body** in the
  configured `signature_header` (a `sha256=` prefix is tolerated), keyed by the
  source's `shared_secret`, again compared constant-time.
- **`none`** — accepts anything reachable; use **only** behind a trusted proxy.

A failed check raises `PermissionError`, mapped to **HTTP 401** by the route; the
secret never leaves the secret tier. Parsing of an authenticated body never raises
(malformed bodies become best-effort events) — but the parsed content is still
fenced as untrusted (§4).

### 4.2 The model never auto-acts

The verdict is **advisory only**; the consequential decision is deterministic code:

- The **verdict** (`TRUE_POSITIVE`/`FALSE_POSITIVE`/`NEEDS_HUMAN`) is an LLM
  *recommendation* (`constants.Verdict`).
- The **close/escalate decision** is a pure function in
  `engine/case_manager.py:decide`.
- A **TRUE_POSITIVE is NEVER auto-closed** — it routes to a human, with a
  defence-in-depth assertion that raises if anything tries to close one
  (`case_manager.apply`). Non-negotiable #3.
- A FALSE_POSITIVE may auto-close **only** when `fp_auto_close.enabled` AND
  confidence ≥ `min_confidence` (0.95) AND risk ≤ `max_risk_score` (30), and then
  **only** with an objection window (`FpAutoCloseConfig`, disabled by default).
- Anything else — `NEEDS_HUMAN`, a missing verdict, or any LLM/source/tool failure —
  **fails safe to a human**: an alert is never dropped.

## 5. Read-only guarantee, audit, cost ledger, caps & kill switch

| Control | Guarantee | Where |
|---|---|---|
| Read-only sources | The suite **never writes to a log source**. Pull tools read only; push receivers have no write path back. | `connectors/*`, `tools/es_query.py`, `prompts.INVESTIGATOR_SYSTEM` |
| Audit trail (append-only) | Every agent action is audited, append-only. Action types: prompt, es_query, tool_call, verdict, decision, error, poll, scan. | `audit/audit_log.py`, `constants.ActionType` |
| Cost ledger | **100% of LLM calls** flow through one gateway, which writes a usage/cost row for **every** call (including failures, `outcome=error`). | `llm/gateway.py`; non-negotiable #6 |
| Per-case caps | `max_tool_calls` (8), `max_tokens` (20000), `timeout_seconds` (120). | `config.CapsConfig` |
| Kill switch | A global `caps.kill_switch` stops all investigations; polling is not (re)started while set. | `config.CapsConfig.kill_switch`; `routes.put_settings` |
| Cost gate | Runs **before** the expensive model so cheap/benign clusters never reach the strong investigator. | `engine/cost_gate.py` |

## 6. State-backend security

The suite's own state (cases/audit/usage/config/cursor/RAG) lives in the
`STATE_BACKEND` you choose — secure it like any datastore:

- **Postgres** — supply the async URL via `STATE_DB_URL` with a **dedicated,
  least-privilege role** (it needs DML + `CREATE EXTENSION vector` only the first
  time). Keep the credential in `.env`/the container env, never in the SPA. Place
  Postgres on an **internal network** (the agnostic compose does not publish 5432);
  use TLS for any cross-host connection. Back it up (`docs/RUNBOOK.md` §2.1).
- **SQLite** — a local file; protect it with filesystem permissions on a persistent
  volume. Fine for single-node; no network exposure.
- **Elasticsearch** — the management key is scoped to `tlsoc-agent-*` and can never
  read the log surface (§2); use TLS and verify certs.

Nothing secret is ever written to any of these — they hold **non-secret**
preferences and operational data only.

## 7. Data handling / privacy

**What is sent to the LLM.** Only **fenced, compact** OCSF fields and computed
context — never raw event dumps. The investigator prompt sends a deterministic
context block plus up to ~12 compacted sample events and any enrichment, all
fenced (`prompts.render_cluster`). The standup writer gets a **pre-aggregated**
JSON summary only — aggregate-then-summarise, never raw logs to a model
(non-negotiable #7).

**Enrichment egress.** When enabled, the suite sends **IPs/indicators** to
**AbuseIPDB**/**VirusTotal** (`tools/enrich.py`), Redis-cached to protect free-tier
limits and reduce egress (non-negotiable #8). GeoIP already in the event is read
as-is (no egress).

**Running fully local.** The single LLM gateway is the abstraction seam: a
local/GPU model server (vLLM / LiteLLM) drops in behind `llm/gateway.py` with no
caller change. Disabling enrichment removes the AbuseIPDB/VirusTotal egress.
Together these let a deployment run with **no third-party egress**.

## 8. Responsible disclosure

To report a security issue, contact the maintainers privately (do **not** open a
public issue with exploit detail). Include: affected component (web UI / backend /
connector / deploy), version (`/api/health` reports `version`), and reproduction
steps. We aim to acknowledge promptly and coordinate a fix before public
disclosure.

## 9. Hardening checklist (deploy-time)

- [ ] **TLS reverse proxy in front of the web UI**, with your own authentication —
      the SPA is a thin viewer and ships no auth of its own. Terminate TLS at the
      proxy; the SPA → backend hop stays on the internal network.
- [ ] **Read-only, scoped credential for every log source.** No source superuser at
      runtime; pull keys read-only and pattern-scoped. Verify push receivers have no
      write path back.
- [ ] **ES state backend: two scoped keys only** (read-only log key + mgmt
      `tlsoc-agent-*` key); verify the mgmt key cannot read `all-logs-*`.
- [ ] **State backend hardened** — Postgres on an internal network with a
      least-privilege role; SQLite file permissions; backups configured (§6).
- [ ] **Inbound push auth on.** Set `auth_mode` to `bearer` or `hmac` (never `none`
      on an exposed endpoint); set the per-source `token`/`shared_secret`.
- [ ] **Network egress allowlist for the backend.** Restrict outbound to exactly the
      configured LLM + enrichment endpoints (or a local vLLM gateway). Without LLM
      egress, investigations fail safe to NEEDS_HUMAN — never dropped.
- [ ] **Key rotation.** Rotate source/LLM/enrichment keys via `.env` + backend
      restart (durable) — wizard / per-source pushes are in-memory only
      (`docs/RUNBOOK.md` §4.1).
- [ ] **`read_only_settings_mode=true`** to freeze Settings after configuration.
- [ ] **No secrets in git / state store.** Confirm `.env` is git-ignored and that
      nothing secret lands in preferences or the state store.
- [ ] **Caps + kill switch reachable** from Settings.

---

## Optional API authentication (Wave 2)

API auth ships **disabled by default** — the no-auth deployment (the original
model, where the network/reverse-proxy is the trust boundary) remains fully
supported and behaviourally unchanged out of the box. Enable JWT auth per-deploy:

```bash
TLSOC_AUTH_ENABLED=true
TLSOC_AUTH_JWT_SECRET=<32+ random bytes>     # stable secret (else ephemeral, sessions die on restart)
TLSOC_AUTH_ADMIN_USERNAME=admin
TLSOC_AUTH_ADMIN_PASSWORD=<plaintext, hashed in memory at startup, never stored>
# or a multi-user map of username -> PBKDF2 hash:
# TLSOC_AUTH_USERS={"alice":"pbkdf2_sha256$...","bob":"pbkdf2_sha256$..."}
TLSOC_AUTH_COOKIE_SECURE=true                # REQUIRED behind TLS (HTTPS-only cookie)
```

When enabled, every `/api/*` route requires a valid session **except** the tiny
public allowlist (`/api/health`, `/api/auth/{login,me,logout}`) and the
self-authenticating `/api/ingest/<source>` receivers. Deny-by-default is enforced
by a router-level dependency and a CI test (`tests/test_route_auth_coverage.py`)
that fails if any route slips the gate. The webui shows a login screen and gates
the app automatically (it is a strict no-op when auth is off).

**Hardening notes:**
- Set `TLSOC_AUTH_COOKIE_SECURE=true` in production (TLS); the session cookie is
  always `HttpOnly` + `SameSite=Lax`.
- Security headers (CSP/HSTS/nosniff/frame-deny) are on by default. The Redis-free
  in-process **rate limiter** (`TLSOC_RATE_LIMIT_ENABLED`, default **off**) and
  **CSRF** (`TLSOC_CSRF_ENABLED`, default **off**) are opt-in.
- `csrf_enabled` currently expects API clients to send `X-CSRF-Token` matching a
  `tlsoc_csrf` cookie; the standalone webui does not yet issue/echo that token, so
  enable CSRF only for header-setting API clients (or after wiring the webui).
  `SameSite=Lax` already blocks the common cross-site POST CSRF vector.
- The rate limiter only trusts `X-Forwarded-For` when constructed with
  `trust_forwarded_for=True` (behind a known proxy); otherwise it keys on the
  socket peer to prevent header-spoofed bucket rotation.
