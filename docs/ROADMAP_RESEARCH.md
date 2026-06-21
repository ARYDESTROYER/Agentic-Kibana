# What to build next — research-backed roadmap (2026)

> Synthesis of a multi-agent landscape study (open-source + commercial agentic
> SOC platforms, agentic-AI frameworks, detection-engineering AI, eval research)
> plus a codebase gap analysis. Companion to `ROADMAP.md` and
> `docs/AGNOSTIC_ARCHITECTURE.md`. Every recommendation maps to where we are today.

## 0. ⚠️ Critical finding — the API has no authentication

The gap analysis confirmed (file-grounded): `backend/app/main.py` mounts the
router with **no auth dependency/middleware**, `api/deps.py` injects only
`AppState`, and `webui/nginx.conf` proxies `/api/*` straight to the backend. The
old security model assumed the Kibana plugin's session carried through its proxy —
but the **standalone webui is now the primary surface and has no such session**.

**Impact:** anyone with network reach can read every case, the audit trail and (via
`es_query`/chat) the underlying logs; mutate settings/secrets; flip the kill
switch; trigger costly investigations; and **spoof alerts via `POST
/api/ingest/{id}`**. It also undermines the audit story — `/cases/{id}/action`
records the actor as a caller-supplied string with no verified identity.

**This is the #1 thing to build.** Shape: a FastAPI auth dependency on the router
(API key for machine-to-machine + OIDC bearer for users), per-route authorization
(read-only / analyst / admin / response-action roles), wired to the audit actor.
Until then, restrict network access to the stack (e.g. keep `:8088`/`:8080` behind
a VPN/reverse proxy with auth) — note this in DEPLOY.md.

## 1. Where we sit in the landscape

The closest open-source analogue is **Vigil** (DeepTempo, Apache-2.0, RSA 2026):
13 specialized agents, an LLM gateway, **confidence-gated HITL** (auto >0.90,
review <0.85), Sigma rule integration, Slack/Jira, and **MCP as the integration
bus**. Other peers: **AiSOC**, **FunnyWolf/agentic-soc-platform**, **SecurityClaw**,
**SocTalk** (LangGraph + Wazuh/Cortex/TheHive/MISP via MCP — a near-mirror of our
two-tier + HITL design), and **Tracecat** (AI-native open SOAR). Commercial
benchmarks (Microsoft Security Copilot, CrowdStrike Charlotte, SentinelOne Purple
AI, Dropzone, Simbian, Intezer, Radiant, Exaforce, 7AI, Prophet) converge on:
autonomous triage → investigation → **approval-gated response**, feedback loops,
and consumption pricing.

**What we already do well (keep leading on):** OCSF normalization (rare in
OSS — only Matano), the vendor-agnostic connector SPI, the selectable state
backend, the single cost/usage ledger (no commercial product exposes this), and a
genuinely strong safety default (deterministic close/escalate; a TRUE_POSITIVE is
never auto-closed). Recurring convergent patterns the leaders share that we lack:
HITL approval gates, response/SOAR actions, notifications/ticketing, detection-as-
code, threat-intel/IOC, evals/feedback, agent-run observability, and MCP.

## 2. Prioritized roadmap

### NOW — security + highest-leverage, mostly low effort
1. **API authN/authZ** (see §0). *Critical; blocks everything multi-user.*
2. **Case-detail UI + agent-trace timeline** — surfaces evidence/MITRE/trace/
   lifecycle that already exist in the backend. *(In progress in the UI pass.)*
3. **Agent-run observability** — add a LangGraph **Postgres checkpointer**
   (reuses our asyncpg pool) + **Langfuse** (MIT, self-hostable) via OpenLLMetry.
   Low effort; it complements the cost ledger and is the prerequisite for HITL,
   streaming and evals.
4. **Prompt caching** — structure each agent's system prompt as a stable prefix +
   enable provider cache_control. ~90% cost cut on cached tokens, ~zero infra.
5. **Outbound notifications + ticketing** — Slack/Teams/email/PagerDuty + Jira/
   ServiceNow on escalate/NEEDS_HUMAN. An agentic SOC that escalates silently is
   operationally useless. (Pattern: TheHive/Cortex responders, Vigil, Shuffle.)

### NEXT — depth + trust
6. **HITL approval gates + confidence routing** — LangGraph `interrupt()` (needs
   the checkpointer) + Vigil-style confidence thresholds; a pending-approval queue
   + UI. Prerequisite for any write action.
7. **Response / SOAR actions** (block IP / disable user / isolate host) behind a
   **separate, write-scoped credential**, **always approval-gated**, never
   auto-executed, dual-audited. The single biggest capability gap; design the
   trust boundary carefully (do it after #1 and #6).
8. **Eval + feedback loop** — a 50-case golden set + DeepEval/promptfoo CI gate;
   capture analyst verdict-overrides as labeled feedback feeding evals + RAG.
   Research is unambiguous that the feedback loop is the top accuracy lever
   (L2DHF, AACT). Benchmarks to track against: CyberSOCEval, ExCyTIn-Bench,
   CTI-REALM (Claude models lead these).
9. **Threat intel / IOC** — hash/domain/URL enrichers + a sandbox tool; a STIX/
   TAXII or **MISP/OpenCTI** feed matched at correlation time; IOC allow/deny
   lists. (OpenCTI ships an MCP server.)
10. **Detection-as-code (Sigma)** — import/translate Sigma via **pySigma** (note
    `pySigma-pipeline-ocsf` aligns with our schema) and, post-verdict, have a
    detection-engineer agent draft a Sigma rule for analyst approval (Intezer/
    Panther closed-loop; SigmAIQ/Uncoder/SigmaGen for generation/translation).
11. **Streaming investigation to the UI** — SSE from LangGraph `astream_events`
    so analysts watch tool calls + reasoning live. Big UX win.
12. **Case collaboration** — assignee/owner, comments, tags, SLA, linking/merging.
13. **More pull connectors + multi-cluster** — Splunk + Sentinel (enum'd, not
    built); a poller pool so several pull sources run concurrently.

### LATER — scale + ecosystem
14. **Multi-agent specialization** — split the investigator into evidence-gathering
    + reasoning sub-agents (CORTEX reports ~10% FP reduction); LangGraph subgraphs.
15. **Memory** — entity memory (host/user/IP rollups auto-injected) + episodic
    investigation traces (Mem0 integrates with LangGraph's Store).
16. **MCP** — expose our tools/cases as an MCP server (Claude Code/Cursor/IDEs);
    optionally consume external MCP servers (treat all MCP I/O as UNTRUSTED — 30+
    MCP CVEs in early 2026; fence like we fence OCSF `unmapped`).
17. **Ops metrics** — MTTR/MTTI/FP-rate/auto-close-rate dashboards (data already
    in cases/audit/usage; partly surfaced by the new Overview).
18. **Reporting/exports** (per-case PDF/MD, CSV), **multi-tenancy/RBAC/SSO**
    (after #1), **scale-out** (Kafka/workers — Epoch E).

## 3. Library shortlist (permissive, self-hostable)
- **Langfuse** (MIT) + **OpenLLMetry** (Apache-2.0) — tracing/observability.
- **langgraph-checkpoint-postgres** — HITL/streaming/resume on our PG pool.
- **DeepEval** / **Ragas** / **promptfoo** — eval + red-team CI.
- **LlamaFirewall** (PromptGuard 2) — prompt-injection pre-pass on log fields.
- **pySigma** (+ ocsf pipeline + backends) — detection-as-code.
- **Mem0** — long-term entity/episodic memory (LangGraph Store).
- **LiteLLM** (optional) — gateway routing/fallback/budgets/semantic cache.

## 4. The one-line take
We have a best-in-class **spine** (OCSF, connectors, deterministic funnel, cost
ledger, audit). To become a complete agentic SOC the order is: **secure it
(auth)** → **make it observable + cheap (tracing + prompt cache)** → **close the
loop (notifications, then approval-gated response)** → **make it learn (evals +
feedback)** → **broaden (threat-intel, detection-as-code, more connectors)**.
