# TLSOC Agentic Triage Suite

> Agentic SOC triage for the TrustLab / IIT Bombay ELK pipeline.
> **Phase 1 POC** — Elastic / Kibana **8.12.2**. A loosely-coupled backend does
> all the agentic work; a thin Kibana plugin renders five surfaces.

The suite sits **next to** an existing production pipeline
(`rsyslog → Kafka → foss-soc-engine → Logstash → Elasticsearch (all-logs-*) → Kibana`)
as a **read-only consumer**. It polls the high-quality, ECS-normalized log surface
in Elasticsearch, correlates and risk-scores in deterministic code, runs a
two-tier LLM investigation, and produces audited, cost-metered cases — never
auto-closing a true positive.

```
┌─────────────────────────── Kibana 8.12.2 ───────────────────────────┐
│  Plugin (thin viewer): Chat · Investigate · Automated Scans ·        │
│  Standup · Cost · Settings/Wizard   ── core.http →  /api/tlsoc/* ──┐  │
└───────────────────────────────────────────────────────────────────┼──┘
                                                                      │ (Kibana server proxy)
┌───────────────────────── tlsoc-backend (FastAPI + LangGraph) ──────▼──┐
│  poll(cursor) → correlate → risk → cost-gate → router → investigator  │
│  → formatter → Case Manager (deterministic close/escalate)            │
│  tools: es_query(read-only) · enrich(Redis-cached) · rag_retrieve     │
│  single LLM gateway → usage/cost ledger                               │
│  owns: tlsoc-agent-{cases,audit,usage,config,cursor}                  │
└──────── read-only key → all-logs-*  ·  mgmt key → tlsoc-agent-* ──────┘
```

## Repository layout

```
backend/        FastAPI + LangGraph backend (all agentic logic) + tests + Dockerfile
  app/
    config.py constants.py models.py utils.py        # contracts
    es/           client (real) · fake (in-memory) · querybuilder · indices
    llm/          gateway (the single cost-ledger point) · providers · pricing
    tools/        es_query · enrich (Redis-cached) · rag · vectorstore
    engine/       correlation · risk · cost_gate · case_manager · poller · signatures
    agents/       router · investigator (ReAct) · formatter · chat · standup · graph (LangGraph)
    stores/       cases · usage · config · cursor    audit/  audit_log
    api/          routes (the plugin contract)       state.py  main.py
  tests/          spine + breadth tests (fake ES + mock LLM, no network)
plugin/           Kibana 8.12.2 plugin source + dist/<built zip> + BUILD.md
deploy/
  docker-compose.tlsoc.yml     # the ONE service block to add to TLSOCDockerDeploy
  mappings/                    # index templates (cases/audit/usage)
  dashboards/                  # bundled saved-object dashboards (audit + cost)
.env.example     DEPLOY.md     COMPATIBILITY.md
```

## Quickstart

### Deploy (cold, on the SIEM server) → see **[DEPLOY.md](DEPLOY.md)**
Mint two scoped ES keys, set `.env`, add the compose block, bring up the backend,
install the **pre-built** plugin zip, run the wizard, import dashboards. No plugin
compilation happens on the server.

### Local backend (developer)
```bash
cd backend
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
pytest -q                       # full suite runs offline (fake ES + mock LLM)
uvicorn app.main:app --port 8088    # runs in-memory with no keys (mock provider paths)
```
With no ES keys it uses an in-memory store; with no LLM keys, model-dependent
paths fail safe to a human. Set the env vars from `.env.example` for a real run.

### Rebuild the plugin zip → see **[plugin/BUILD.md](plugin/BUILD.md)**
Requires the cloned Kibana 8.12.2 source and Node 18.18.2. The committed
`plugin/dist/tlsocAgenticTriage-8.12.2.zip` is the deploy artifact.

## The non-negotiables (and where they live)

| # | Guarantee | Enforced in |
|---|---|---|
| 1 | Read-only, scoped ES key for the agent; never the superuser | `es/client.py` (two separate clients), `tools/es_query.py` |
| 2 | Every agent action audited, append-only, from commit one | `audit/audit_log.py` (`tlsoc-agent-audit-*`) |
| 3 | Verdict from LLM; **close/escalate decision from code; never auto-close a TP** | `engine/case_manager.py` |
| 4 | Durable cursor (no skip / no dup); cases keyed by cluster signature | `models.Cursor`, `engine/poller.py`, `engine/signatures.py` |
| 5 | One chat engine, two entry points | `agents/chat.py` |
| 6 | 100% of LLM calls through one gateway → usage/cost ledger | `llm/gateway.py` (`tlsoc-agent-usage-*`) |
| 7 | Aggregate-then-summarise (never raw logs to a model) | `agents/standup.py`, `es/querybuilder.py` |
| 8 | Enrichment Redis-cached | `tools/enrich.py`, `cache.py` |
| 9 | Log values are untrusted DATA in prompts (delimited & labelled) | `agents/prompts.py` |
| 10 | Sane defaults; only keys + scope required to run | `config.py` |
| 11 | Spine first & tested (Gate 1); breadth degrades gracefully (Gate 2) | `tests/`, graceful fallbacks throughout |
| 12 | Read-only consumer; upstream untouched; cold-deployable | `COMPATIBILITY.md`, `DEPLOY.md` |

## Phase-2 seams (left clean, not implemented)
Persistent plugin (derived image / mount) · MCP tool transport (tools are already
MCP-shaped) · GPU-local models via vLLM/LiteLLM (single gateway abstraction) ·
prompt-injection hardening (fencing seam in place) · suppression/resolved-case
feedback into RAG (persisted now, wiring later).
