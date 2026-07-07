# What to build next — research-backed roadmap (2026)

> Synthesis of a multi-agent landscape study (open-source + commercial agentic
> SOC platforms, agentic-AI frameworks, detection-engineering AI, eval research)
> plus a codebase gap analysis. Companion to `ROADMAP.md` and
> `docs/AGNOSTIC_ARCHITECTURE.md`. **Captured as a point-in-time snapshot in
> 2026-06** (before Round 2) — re-verify any of its facts before citing them
> competitively; the landscape moves fast and this repo has shipped a lot since.
> The prioritized roadmap in §2 is tagged **✅ shipped / ◔ partially shipped /
> ○ not started** against the current repo (~2/3 of the 18 items have moved since
> this was written) — read the tags, not the original NOW/NEXT/LATER framing, for
> current priority. Still-genuinely-open items are tracked in `ROADMAP.md`'s
> backlog; this doc keeps the original research framing + the landscape/library
> reference material (§§1, 3).

## 0. ⚠️ Critical finding (RESOLVED) — the API had no authentication

> **Status update: this is no longer true.** It was accurate when this research
> was captured (before Round 2). Full auth/RBAC/MFA/SSO/session management shipped
> in the 7-wave SOC overhaul's W1 "Identity" + W2 "MFA + SSO" and Round 2's W3
> "Sessions" (see `CLAUDE.md` §10) and remains in the suite today: **6 built-in
> roles + operator-defined custom roles, RFC-6238 TOTP MFA, OIDC SSO
> (Google/Microsoft/generic), a `require_permission`-gated dependency on every
> state-changing route, and a CI test (`test_route_auth_coverage`) that fails the
> build if any `/api` route lacks an authZ gate.** The one real caveat: **auth
> defaults OFF** (`Secrets.auth_enabled=false`), so an unconfigured deployment
> behaves like the historical no-auth "old version" and the offline test suite
> keeps working unchanged; set `TLSOC_AUTH_ENABLED=true` to turn it on (seeds
> `Admin`/`Admin@123`, change immediately). See `SECURITY.md` and `CLAUDE.md` §10
> for the current model — don't re-derive auth status from this file.
>
> The rest of this section is preserved as the **original 2026-06 finding**: it
> correctly describes the gap analysis that motivated building auth in the first
> place, and is a useful record of *why* auth was prioritized as it was.

The gap analysis confirmed (file-grounded, **at the time**): `backend/app/main.py`
mounted the router with **no auth dependency/middleware**, `api/deps.py` injected
only `AppState`, and `webui/nginx.conf` proxied `/api/*` straight to the backend.
The old security model had assumed the Kibana plugin's session carried through its
proxy — but the standalone webui had become the primary surface and had no such
session.

**Impact (at the time):** anyone with network reach could read every case, the
audit trail and (via `es_query`/chat) the underlying logs; mutate settings/
secrets; flip the kill switch; trigger costly investigations; and **spoof alerts
via `POST /api/ingest/{id}`**. It also undermined the audit story — `/cases/{id}/
action` recorded the actor as a caller-supplied string with no verified identity.

**This was flagged as the #1 thing to build (now built, see the status update
above).** Planned shape: a FastAPI auth dependency on the router (API key for
machine-to-machine + OIDC bearer for users), per-route authorization (read-only /
analyst / admin / response-action roles), wired to the audit actor. This shape
was, in fact, roughly what shipped.

## 1. Where we sit in the landscape

> Landscape snapshot as of 2026-06 — re-verify vendor/OSS-project claims below
> before citing them; they are not re-checked in this pass. Kept as reference
> material alongside the library shortlist (§3).

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
genuinely strong safety default (a **pure, deterministic** `decide()` makes the
close/escalate call, never the raw LLM output or playbook text; FALSE_POSITIVE
auto-close is on by default above a confidence/risk bar, TRUE_POSITIVE auto-close
is a real, explicit **opt-in** off by default, and only NEEDS_HUMAN is the
code-enforced, non-tunable never-auto-close case). Recurring convergent patterns
the leaders share that we lack (see the ✅/◔/○ tags in §2 for current status):
HITL approval gates, response/SOAR actions, notifications/ticketing, detection-as-
code, threat-intel/IOC, evals/feedback, agent-run observability, and MCP.

## 2. Prioritized roadmap

Each item is tagged against the current repo: **✅ shipped**, **◔ partially
shipped**, **○ not started**. The original NOW/NEXT/LATER groupings are kept as
written (they're the historical prioritization); read the tags for current
status, not the grouping.

### NOW — security + highest-leverage, mostly low effort
1. **✅ API authN/authZ** (see §0). *Critical; blocks everything multi-user.*
   Shipped as auth/RBAC/MFA/SSO/sessions — see §0's status update (default OFF).
2. **✅ Case-detail UI + agent-trace timeline** — surfaces evidence/MITRE/trace/
   lifecycle that already exist in the backend. Shipped: `CaseDetail`'s
   Investigation tab carries a pinned `DecisionCard` + a full `TraceTimeline`.
3. **◔ Agent-run observability** — add a LangGraph **Postgres checkpointer**
   (reuses our asyncpg pool) + **Langfuse** (MIT, self-hostable) via OpenLLMetry.
   **Not built as specified** — no LangGraph checkpointer, Langfuse, or
   OpenLLMetry integration exists. What *does* exist covering the same need: the
   full audit trail (`tlsoc-agent-audit-*`, non-negotiable #2), the `CONTEXT`
   audit record + `GET /api/cases/{id}/rationale` "why" endpoint, and the cost/
   usage ledger. Tagged ◔ because the underlying observability data exists, just
   not via this specific tracing stack.
4. **◔ Prompt caching** — structure each agent's system prompt as a stable prefix
   + enable provider cache_control. **Partially shipped**: cache-token
   extraction + cache-rate pricing math (`llm/providers.py`/`llm/pricing.py`,
   Round 4) is fully wired — so a cached call is billed correctly — but no code
   path sets an explicit `cache_control` breakpoint on outgoing Anthropic system
   prompts (`payload["system"]` is built as a plain joined string, not content
   blocks), so proactive Anthropic prompt-caching isn't actually engaged today;
   OpenAI's automatic read-side caching is accounted for.
5. **✅ Outbound notifications + ticketing** — Slack/Teams/email/PagerDuty + Jira/
   ServiceNow on escalate/NEEDS_HUMAN. **Mostly shipped**: Slack/Teams/generic
   webhook/PagerDuty/Telegram + email (SMTP/Resend/SES) all ship with
   per-condition triggers + dedup/rate-limit/digest (`notifications/`). Jira/
   ServiceNow *ticketing* specifically (creating/updating an external ticket, not
   just notifying) was not built.

### NEXT — depth + trust
6. **◔ HITL approval gates + confidence routing** — LangGraph `interrupt()`
   (needs the checkpointer) + Vigil-style confidence thresholds; a
   pending-approval queue + UI. **Shipped differently**: a `Proposal`-backed HITL
   workflow (draft → pending → human approve/reject, `stores/proposals.py` +
   `routes.py` `/proposals`) plus an Approvals UI page cover suppression rules and
   memory-fact drafts and tuning proposals — not a LangGraph `interrupt()`-based
   pause on arbitrary write actions (there are no write/response actions to gate
   yet, see #7).
7. **○ Response / SOAR actions** (block IP / disable user / isolate host) behind a
   **separate, write-scoped credential**, **always approval-gated**, never
   auto-executed, dual-audited. **Not built** — still the single biggest
   capability gap. Genuinely open; tracked in `ROADMAP.md`'s backlog.
8. **◔ Eval + feedback loop** — a 50-case golden set + DeepEval/promptfoo CI gate;
   capture analyst verdict-overrides as labeled feedback feeding evals + RAG.
   **The feedback half shipped** (`Case.feedback`, `POST /api/cases/{id}/
   feedback`, `GET /api/feedback/stats` — analyst grades the AI verdict,
   agreement/quality stats roll up); **the formal golden-set/DeepEval/promptfoo CI
   eval gate was not built.** Genuinely open; tracked in `ROADMAP.md`'s backlog.
9. **✅ Threat intel / IOC** — hash/domain/URL enrichers + a sandbox tool; a STIX/
   TAXII or **MISP/OpenCTI** feed matched at correlation time; IOC allow/deny
   lists. **Substantially shipped**: 19 enrichment providers across IP/domain/
   hash/url/email indicator types (`enrichment/providers/`) + a
   `threat_context.py` panel (IOC reputation + MITRE + related cases, fail-open).
   A live MISP/OpenCTI/STIX-TAXII feed specifically was not wired — the shipped
   design is direct-provider enrichment, not a threat-intel-platform feed.
10. **○ Detection-as-code (Sigma)** — import/translate Sigma via **pySigma** (note
    `pySigma-pipeline-ocsf` aligns with our schema) and, post-verdict, have a
    detection-engineer agent draft a Sigma rule for analyst approval (Intezer/
    Panther closed-loop; SigmAIQ/Uncoder/SigmaGen for generation/translation).
    **Not built.** The suite does have its own Detection & Rules editor (Round 5)
    with a version ledger + rollback, but no Sigma import/export. Genuinely open;
    tracked in `ROADMAP.md`'s backlog.
11. **◔ Streaming investigation to the UI** — SSE from LangGraph `astream_events`
    so analysts watch tool calls + reasoning live. **Partially shipped**: a
    multiplexed SSE `EventBus` (`realtime.py`, Round 3, `GET /api/events`,
    default OFF — polling is the graceful fallback) streams case/state updates,
    but not the granular per-tool-call/reasoning-token live view
    `astream_events` implies; that finer-grained trace streaming was not built.
12. **✅ Case collaboration** — assignee/owner, comments, tags, SLA, linking/
    merging. Shipped: threaded human/ai/system messages, reactions, tasks,
    @mentions, an activity feed (Round 3); assignee/tags/comments (Wave 3).
13. **◔ More pull connectors + multi-cluster** — Splunk + Sentinel (enum'd, not
    built); a poller pool so several pull sources run concurrently. **The poller
    pool shipped** (`engine/poller_manager.py`'s `PollerManager` fans out over
    every enabled pull source — this was in fact a confirmed Round-4 bug fix, not
    just a nice-to-have); **the additional connectors did not** — still 3 built
    (Elastic/OpenSearch/Wazuh), with Splunk/Sentinel/QRadar/Chronicle/CrowdStrike/
    SentinelOne/Defender still enum'd-but-unbuilt slots (see `docs/INGESTION.md`).

### LATER — scale + ecosystem
14. **◔ Multi-agent specialization** — split the investigator into
    evidence-gathering + reasoning sub-agents (CORTEX reports ~10% FP reduction);
    LangGraph subgraphs. **Shipped as a different, deliberately lighter design**:
    a declarative `AgentPersona` registry (Wave 1) routes each cluster to a
    specialist system-prompt/tool-allowlist config over the ONE investigator loop
    — not a literal LangGraph subgraph split of evidence-gathering vs. reasoning.
15. **◔ Memory** — entity memory (host/user/IP rollups auto-injected) + episodic
    investigation traces (Mem0 integrates with LangGraph's Store). **Shipped as a
    different shape**: an operator-authored, durable `MemoryStore` (Claude.ai-
    style facts, auto-injected into investigations + chat) — not auto-captured
    entity rollups or Mem0-backed episodic traces.
16. **○ MCP** — expose our tools/cases as an MCP server (Claude Code/Cursor/IDEs);
    optionally consume external MCP servers (treat all MCP I/O as UNTRUSTED — 30+
    MCP CVEs in early 2026; fence like we fence OCSF `unmapped`). **Not built.**
    Genuinely open; tracked in `ROADMAP.md`'s backlog.
17. **✅ Ops metrics** — MTTR/MTTI/FP-rate/auto-close-rate dashboards (data already
    in cases/audit/usage; partly surfaced by the new Overview). Shipped
    extensively: server-side MTTA/MTTR-as-first-response/dwell p50/p90, SLA/aging,
    verdict/quality mix, period-over-period deltas (Round 3), plus real MTTD and a
    burndown chart (Round 9c).
18. **◔ Reporting/exports** (per-case PDF/MD, CSV), **multi-tenancy/RBAC/SSO**
    (after #1), **scale-out** (Kafka/workers — Epoch E). RBAC/SSO **✅ shipped**
    (#1); case export **✅ shipped** but JSON/Markdown only, no PDF/CSV
    (`GET /api/cases/{id}/export?format=json|md`); true multi-tenancy and
    scale-out (Kafka/Redpanda, stateless workers) **○ not built** — scale-out is
    the suite's own open Epoch E, tracked in `ROADMAP.md`'s backlog.

## 3. Library shortlist (permissive, self-hostable)
- **Langfuse** (MIT) + **OpenLLMetry** (Apache-2.0) — tracing/observability. Not
  adopted (see §2 #3).
- **langgraph-checkpoint-postgres** — HITL/streaming/resume on our PG pool. Not
  adopted.
- **DeepEval** / **Ragas** / **promptfoo** — eval + red-team CI. Not adopted
  (the feedback-capture half of the loop shipped without a formal eval harness).
- **LlamaFirewall** (PromptGuard 2) — prompt-injection pre-pass on log fields. Not
  adopted (the suite's UNTRUSTED-fencing approach, non-negotiable #9, is the
  shipped mitigation instead).
- **pySigma** (+ ocsf pipeline + backends) — detection-as-code. Not adopted.
- **Mem0** — long-term entity/episodic memory (LangGraph Store). Not adopted (the
  shipped `MemoryStore` is a simpler operator-authored-facts design, see §2 #15).
- **LiteLLM** (optional) — gateway routing/fallback/budgets/semantic cache in
  *front of* our gateway. **Not adopted in this form.** What did ship under the
  LiteLLM name (Round 9) is a different, narrower thing: an optional **local/
  self-hosted LiteLLM-compatible model provider** — the gateway can call any
  OpenAI-compatible endpoint (LiteLLM/vLLM/Ollama/LM Studio) as one more
  `llm/providers.py` provider (`POST /api/llm/models/custom`, $0 pricing). Don't
  conflate the two: this list's "LiteLLM" is a routing/budget proxy layered in
  front of the gateway; what shipped is a provider the gateway calls directly.

## 4. The one-line take
We have a best-in-class **spine** (OCSF, connectors, deterministic funnel, cost
ledger, audit). The original one-line take: to become a complete agentic SOC the
order is **secure it (auth)** → **make it observable + cheap (tracing + prompt
cache)** → **close the loop (notifications, then approval-gated response)** →
**make it learn (evals + feedback)** → **broaden (threat-intel, detection-as-code,
more connectors)**.

**Where that order actually landed:** step 1 (auth) shipped in full (default OFF).
Step 2 landed partially — cost/audit observability is strong, but the specific
tracing stack (Langfuse/OpenLLMetry) and active prompt-cache engagement weren't
built. Step 3 landed halfway — notifications shipped broadly, but approval-gated
**response actions** don't exist yet because there are no response actions to gate
(the single biggest remaining capability gap). Step 4 landed halfway — the
feedback loop shipped, formal evals didn't. Step 5 is the most broadened of all:
threat-intel/IOC enrichment shipped deeply (19 providers), case collaboration and
ops metrics shipped, more pull connectors did not. See §2 for the item-by-item
detail and `ROADMAP.md` for what's still live backlog.
