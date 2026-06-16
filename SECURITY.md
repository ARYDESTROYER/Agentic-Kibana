# SECURITY.md — Threat model & security posture

This document describes the security posture of the **TLSOC Agentic Triage
Suite** — an LLM-driven SOC triage tool that runs **next to** a production ELK
pipeline as a **read-only consumer**. Because the suite reads attacker-influenced
log data and drives Large Language Models with it, its design treats every
external surface as hostile and makes its safety guarantees **deterministic
code**, not model behaviour.

Every claim below is enforced somewhere in the tree; the enforcement point is
cited inline. See also the 12 non-negotiables in [`CLAUDE.md`](CLAUDE.md) §5 and
[`README.md`](README.md), the two-key rationale in [`COMPATIBILITY.md`](COMPATIBILITY.md) §C,
and the environment/secrets detail in [`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md) §2.3.

## 1. Trust boundaries

The suite spans five tiers. Each arrow crosses a trust boundary; the suite
**never** holds a write credential to the log surface and **never** uses the
`elastic` superuser or `kibana_system` at runtime.

```
┌──────────────┐  authenticated   ┌──────────────┐  Kibana server proxy   ┌──────────────────┐
│  Analyst     │  Kibana session  │   Kibana     │  /api/tlsoc/{path*} →   │  tlsoc-backend   │
│  browser     │ ───TLS (5601)──▶ │  (plugin +   │ ──▶ ${backendUrl}/api/* │  (FastAPI +      │
│ (React/EUI)  │                  │ server proxy)│   server-side ONLY      │   LangGraph)     │
└──────────────┘                  └──────────────┘                         └───────┬──────────┘
        ▲  booleans only,                                                          │
        │  never secret values                                                     │
   TRUST BOUNDARY 1                  TRUST BOUNDARY 2                               │
   (untrusted client)               (proxy: no secrets in browser bundle)          │
                                                                                   ▼
                       ┌───────────────────────────── TRUST BOUNDARY 3 ───────────────────────────┐
                       │                                                                           │
                 read-only key                  mgmt key                  egress (outbound HTTPS)  │
                       │                            │                            │                 │
                       ▼                            ▼                            ▼                 │
            ┌────────────────────┐     ┌────────────────────┐     ┌──────────────────────────┐    │
            │ Elasticsearch       │     │ Elasticsearch       │     │ LLM:  api.anthropic.com  │    │
            │ all-logs-*  (READ)  │     │ tlsoc-agent-* (R/W) │     │       api.openai.com     │    │
            │  — UNTRUSTED DATA   │     │  — suite's own      │     │ Enrich: AbuseIPDB /      │    │
            │    (logs)           │     │    bookkeeping      │     │         VirusTotal       │    │
            └────────────────────┘     └────────────────────┘     │ Cache:  Redis (internal) │    │
                                                                   └──────────────────────────┘    │
                       └───────────────────────────────────────────────────────────────────────────┘
```

| # | Boundary | Posture |
|---|----------|---------|
| 1 | Analyst browser ↔ Kibana | Kibana's own authenticated session; the plugin is a thin viewer. The UI is shown **booleans only** for secrets (`configured ✓`), never values (`config.py:configured_status`). |
| 2 | Kibana ↔ backend | Crossed **only** through the Kibana server-side proxy at `/api/tlsoc/{path*}` → `${backendUrl}/api/*`. The browser bundle contains **no** backend URL (server-side config only). |
| 3 | Backend ↔ ES / LLM / enrichment | Two physically separate scoped ES clients (§2); outbound HTTPS to LLM/enrichment providers; Redis cache. **Log data crossing inbound here is treated as UNTRUSTED** (§4). |

## 2. The two-scoped-key Elasticsearch model

The spec mandates a **read-only** key for the agent's log access, but the backend
must also **own its own indices**. A single key cannot do both safely, and the
superuser / `kibana_system` are **forbidden at runtime**. The suite therefore
uses **two least-privilege API keys**, wired to **two physically separate ES
clients** in `es/client.py` (`RealESClient._ro` and `RealESClient._mgmt`). The
read-only client backs `search_logs` **and nothing else**; the management client
can never read the log surface. If a key is missing, the corresponding client is
`None` and operations raise a clear error — the suite **never silently falls back
to a write credential** (`_require_ro` / `_require_mgmt`).

| Key (env var) | Scope | Privileges | Used by |
|---|---|---|---|
| `TLSOC_ES_API_KEY` | `all-logs-*` | `read`, `view_index_metadata` | the agent's `es_query` tool — the **only** path to log data (`_ro`) |
| `TLSOC_ES_MGMT_API_KEY` | `tlsoc-agent-*` | `read`, `write`, `create_index`, `view_index_metadata`, `manage` | the backend's own cases/audit/usage/config/cursor indices (`_mgmt`) |

> Neither key is `kibana_system` nor the `elastic` superuser. The superuser is
> used by an operator **once**, to mint these two keys, then never again at
> runtime (`config.py:Secrets` docstring; non-negotiable #1).

### Least-privilege role descriptors (copy these when minting keys)

Read-only key (the agent reads logs with **only** this):

```json
{
  "name": "tlsoc_agent_readonly",
  "role_descriptors": {
    "tlsoc_agent_readonly": {
      "indices": [
        { "names": ["all-logs-*"], "privileges": ["read","view_index_metadata"] }
      ]
    }
  }
}
```

Management key (the backend owns its **own** `tlsoc-agent-*` indices — it can
never read the log surface):

```json
{
  "name": "tlsoc_agent_mgmt",
  "role_descriptors": {
    "tlsoc_agent_mgmt": {
      "indices": [
        { "names": ["tlsoc-agent-*"],
          "privileges": ["read","write","create_index","view_index_metadata","manage"] }
      ]
    }
  }
}
```

These are the exact descriptors in [`DEPLOY.md`](DEPLOY.md) §2. Mint them with
`POST /_security/api_key` (or Kibana → Stack Management → Security → API keys →
Create → Restrict privileges).

## 3. Secrets handling

| Property | Behaviour | Where |
|---|---|---|
| Source | **Environment / `.env` only** (`TLSOC_*` vars). | `config.py:Secrets` (`SettingsConfigDict(env_file=".env")`) |
| UI exposure | The UI sees **booleans only** (`configured ✓`); secret **values are never returned to the plugin**. | `config.py:configured_status`; `routes.py` `/setup/status`, `/settings` |
| Wizard-pushed keys | The wizard **can** push key values at runtime, but they are kept **in process memory only — lost on backend restart** (`state.apply_secrets`). | `routes.py:setup_secrets`; `docs/ENVIRONMENT.md` §2.3 |
| Durable path | `.env` / the container environment is the **only durable** secret store. | `DEPLOY.md` §3 |
| Never persisted | Nothing secret is written to **Elasticsearch**, to **git**, or to **logs**. The `tlsoc-agent-config` index holds **non-secret** preferences only. | `config.py` module docstring; `constants.py` (`CONFIG_INDEX`) |
| Clearing a key | The wizard can send an explicit `null` to **revoke** a key (`exclude_unset`, not `exclude_none`). | `routes.py:setup_secrets` |

> Roadmap (Phase 2): an optional persisted **encrypted** secret store so wizard
> keys survive a restart. Until then, set every `TLSOC_*` secret in `.env`.

## 4. Prompt-injection posture

All log data is **attacker-influenceable** (an attacker can put text into a
username, URL, or message field that the suite later reads). The suite treats
every log-derived value as **UNTRUSTED DATA** in prompts:

- Every log-derived value is wrapped in labelled, delimited fences
  `<<<UNTRUSTED_LOG_DATA>>> … <<<END_UNTRUSTED_LOG_DATA>>>` (`constants.py`
  `UNTRUSTED_OPEN`/`UNTRUSTED_CLOSE`) via `fence()` in `agents/prompts.py`.
- **Every** system prompt carries the security note instructing the model to
  treat fenced content strictly as DATA and to **never** follow instructions,
  URLs, or commands inside the fences (`prompts.py:_INJECTION_NOTE`, applied to
  the router, investigator, formatter, chat, and standup system prompts).
- Fencing applies to **everything attacker-influenceable**: cluster entity
  values, rule names, sample event JSON, enrichment data, standup aggregate
  bucket keys, and — for chat — screen-context, selection, and query inputs
  (non-negotiable #9; `CLAUDE.md` §5).

### The model never auto-acts

The verdict is **advisory only**; the consequential decision is **deterministic
code**, not model output:

- The **verdict** (`TRUE_POSITIVE` / `FALSE_POSITIVE` / `NEEDS_HUMAN`) is a
  *recommendation* produced by the LLM (`constants.py:Verdict`).
- The **close/escalate decision** is computed by a pure, side-effect-free
  function in `engine/case_manager.py:decide`.
- A **TRUE_POSITIVE is NEVER auto-closed** — it always routes to a human, with a
  defence-in-depth assertion that *raises* if anything ever tries to close one
  (`case_manager.py:apply`). Non-negotiable #3.
- A FALSE_POSITIVE may auto-close **only** when `fp_auto_close.enabled` AND
  confidence ≥ `min_confidence` (default 0.95) AND risk ≤ `max_risk_score`
  (default 30), and then **only** with an **objection window** in which a human
  can reopen it (`FpAutoCloseConfig`, disabled by default).
- Anything else — `NEEDS_HUMAN`, a missing verdict, or any LLM/ES/tool failure —
  **fails safe to a human**: an alert is never dropped (gateway raises
  `GatewayError` → fail-to-human; conventions in `CLAUDE.md` §8).

## 5. Read-only guarantee, audit, cost ledger, caps & kill switch

| Control | Guarantee | Where |
|---|---|---|
| Read-only log surface | The suite **never writes to the log surface**. The agent's only log path is `search_logs` on the read-only client; the investigator tools are read-only and the prompts state "you can ONLY read data". | `es/client.py` (`_ro`), `tools/es_query.py`, `prompts.py:INVESTIGATOR_SYSTEM` |
| Audit trail (append-only) | Every agent action is audited, append-only, into `tlsoc-agent-audit-*`. Action types: prompt, es_query, tool_call, verdict, decision, error, poll, scan. | `audit/audit_log.py`, `constants.py:ActionType`, `AUDIT_INDEX` |
| Cost ledger | **100% of LLM calls** flow through one gateway, which writes a usage/cost row for **every** call (including failures, recorded `outcome=error`) into `tlsoc-agent-usage-*`. No call can escape the ledger. | `llm/gateway.py:_record`, `constants.py:USAGE_INDEX`; non-negotiable #6 |
| Per-case caps | Each investigation is bounded: `max_tool_calls` (8), `max_tokens` (20000), `timeout_seconds` (120). | `config.py:CapsConfig` |
| Kill switch | A global `caps.kill_switch` stops all investigations; polling is not (re)started while it is set. | `config.py:CapsConfig.kill_switch`; `routes.py:put_settings` (`not prefs.caps.kill_switch`) |
| Cost gate | A cost gate runs **before** the expensive model so cheap/benign clusters never reach the strong investigator. | `engine/cost_gate.py`; `TriageBucket` |

## 6. Data handling / privacy

**What is sent to the LLM.** Only **fenced, compact** event fields and computed
context — never raw log dumps. The investigator prompt sends a deterministic
context block (entity, counts, risk breakdown) plus up to ~12 **compacted**
sample events (`id, ts, ip, user, host, rule, severity`) and any enrichment, all
fenced (`prompts.py:render_cluster`). The standup writer is given a **compact,
pre-aggregated** JSON summary only — **aggregate-then-summarise, never raw logs
to a model** (non-negotiable #7; `agents/standup.py`).

**Enrichment egress.** When enrichment is enabled, the suite sends **IPs/indicators**
outbound to **AbuseIPDB** and **VirusTotal** (`tools/enrich.py`; toggles in
`config.py:EnrichmentConfig`, `use_abuseipdb` / `use_virustotal`). Results are
Redis-cached (`cache_ttl_seconds` default 6h) to protect free-tier limits and
reduce egress (non-negotiable #8). GeoIP the upstream engine already added is read
as-is (no egress).

**Running fully local later.** The single LLM gateway is the abstraction seam: a
local/GPU model server (vLLM / LiteLLM) drops in behind `llm/gateway.py` with no
caller changes (Phase-2 seam; `README.md` "Phase-2 seams"). Disabling enrichment
(`EnrichmentConfig.enabled=false`) removes the AbuseIPDB/VirusTotal egress.
Together these let a deployment run with **no third-party egress**.

**RAG corpus.** RAG retrieves from runbooks / MITRE / resolved cases /
suppression rules (`config.py:RagConfig`). **Phase 1 ships NO IIT-Bombay-sensitive
data in the corpus** — keep institutional/sensitive content out of the RAG seed.
Resolved-case feedback is persisted now but wired into RAG later (`README.md`
Phase-2 seams; `RagConfig.use_resolved_cases`).

## 7. Responsible disclosure

This is a Phase-1 POC. To report a security issue, contact the maintainers
privately (do **not** open a public issue with exploit detail). Please include:
affected component (plugin / backend / deploy), version (`/api/health` reports
`version`), and reproduction steps. We aim to acknowledge promptly and coordinate
a fix before any public disclosure.

## 8. Hardening checklist (deploy-time)

- [ ] **TLS everywhere.** Verify ES certs (`es_verify_certs=true`, mount
      `./certs/ca/ca.crt:ro`, `es_url=https://elasticsearch:9200`). Terminate
      Kibana over TLS. (`config.py:Secrets`; `COMPATIBILITY.md` §B.)
- [ ] **Two scoped keys only.** Confirm both keys are scoped per §2 and that
      neither is the superuser or `kibana_system`. Verify the management key
      cannot read `all-logs-*` and the read-only key cannot write.
- [ ] **Network egress allowlist for the backend.** Restrict `tlsoc-backend`
      outbound to exactly the configured LLM + enrichment endpoints (or a local
      vLLM gateway). Without LLM egress, investigations fail safe to NEEDS_HUMAN
      — never dropped (`docs/ENVIRONMENT.md` §2.4).
- [ ] **Key rotation.** Rotate the two ES keys and the LLM/enrichment keys via
      `.env` + backend restart (durable) — wizard pushes are in-memory only. See
      [`docs/RUNBOOK.md`](docs/RUNBOOK.md) for the rotation procedure.
- [ ] **`read_only_settings_mode`.** Set `read_only_settings_mode=true` to freeze
      Settings after configuration; `PUT /settings` then rejects changes
      (`routes.py:put_settings`).
- [ ] **No secrets in git / ES.** Confirm `.env` is git-ignored and that nothing
      secret lands in `tlsoc-agent-config` (preferences are non-secret).
- [ ] **No IITB-sensitive data in the RAG corpus** (Phase 1).
- [ ] **Caps + kill switch reachable.** Confirm an operator can set
      `caps.kill_switch` and tighten per-case caps from Settings.
