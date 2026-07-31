# Vigil SOC — deep study & what we should take from it

> **Status: HISTORICAL — a 2026-06-21 point-in-time study.** The comparative
> analysis below (Vigil vs. us, §§1–4) is a snapshot of Vigil `v0.2.3` and our repo
> as they stood that day; it is **not re-verified against Vigil's current state**
> and shouldn't be cited as a live comparison. The **execution plan (§5)** it
> produced has since **~90% shipped, under different round names** than the
> Wave 1–4 labels below — see each Wave's status tag inline and `AGENTS.md` §10 for
> what actually landed and when.
>
> Author: orchestrator (Opus) + a fleet of 10 Opus sub-agents that read Vigil
> (`github.com/Vigil-SOC/vigil`, v0.2.3) and its `mempalace` memory submodule
> end-to-end, plus a fresh ground-truth map of our own repo.
> Date: 2026-06-21. This is the analysis the user asked for ("read it heavily and
> tell me what you think") and the design basis for the overhaul.

---

## 0. TL;DR — my honest take

Vigil is an **ambitious, broad, well-marketed** open-source "AI SOC." Its best
ideas are genuinely worth stealing. But a large fraction of the headline features
are **thinner than the README implies**, and several core pieces are **actively
worse** than what we already have. The right move is not to chase parity — it's to
**lift Vigil's good architectural ideas onto our cleaner spine** (typed OCSF,
`StateStore` abstraction over ES/Postgres/SQLite, the single in-process LLM
gateway + cost ledger, the deterministic case manager, the durable cursor).

**Where Vigil is genuinely ahead of us (steal these):**
1. **A roster of specialized agent personas** instead of one investigator. (Their
   13 agents are just *config* over one engine — very portable.)
2. **Plain-text runbooks/playbooks** as first-class, user-editable files.
3. **A tool safety-tier model** (`safe` / `managed` / `requires_approval` /
   `forbidden`) — a declarative capability firewall.
4. **A graduated-autonomy ladder** (confidence + projected-cost gating) and a real
   **human approval workflow**, with the StackStorm principle *"the system can
   only demote itself; only humans promote autonomy."*
5. **Auth-by-default with a CI test** that fails the build if any route is
   unauthenticated — the exact fix for our known #1 gap.
6. **Richer RAG/memory**: hybrid (BM25+vector) retrieval, cross-case memory, and a
   bitemporal knowledge graph.
7. **Cost provenance everywhere** (`pricing_source` = exact/heuristic/zero/unknown)
   and pre-flight projected-cost estimates.
8. **Operational maturity**: a Helm chart, ARQ workers + KEDA queue-depth
   autoscaling, OTEL + Grafana cost dashboards, CSRF/rate-limit/security-headers
   middleware.
9. **UX surfaces we lack**: an Auto-Ops orchestrator console, an AI-Decisions / HITL
   page (approvals + retrospective grading), reasoning-trace + chain-of-custody
   viewers.

**Where Vigil is weaker than us (do NOT copy):**
- **No typed canonical schema.** Findings are ad-hoc dicts normalized per-adapter;
  embeddings stubbed `[0.0]*768`. Our **OCSF** layer is strictly better.
- **No `StateStore` abstraction** — hard-bound to Postgres (JSONB/ARRAY/GIN), no
  SQLite/ES option, **no migrations** (raw `create_all()` + numbered seed SQL).
- **The "multi-agent workflows" are largely an illusion.** The five shipped
  `WORKFLOW.md` files are **pasted into one mega-prompt**; the daemon ignores the
  markdown and uses a separate hardcoded Python step map. The "master agent review"
  is `completeness >= 0.8` arithmetic, not an LLM.
- **MITRE + detection-rule "intelligence" is demo-grade.** A hardcoded 15-technique
  dict; detection "search" is `query.lower() in str(rule).lower()`; `identify_gaps`
  is hardcoded to "ransomware."
- **`DEV_MODE=true` is the *default*** and the README admits full auth is "untested";
  default creds `admin/admin123`. Their security *patterns* are great; their
  *defaults* are not.
- **A mandatory external Bifrost LLM proxy** (a second network hop, "fails loudly if
  unhealthy") and a **two-gateway / two-cost-ledger** design with reconciliation
  debt. Our single in-process gateway is simpler and more robust.
- **God-objects**: `claude_service.py` is 4,156 lines; 70+ services; 38 route
  modules. Port ideas, never the monolith.
- **No deterministic close-guard.** `update_case` `setattr`s anything; nothing
  stops auto-closing a true positive. Our non-negotiable #3 is the right model.

Bottom line: **Vigil is a great source of ideas and a cautionary tale about
breadth-over-depth.** We should take ~8 well-chosen capabilities, implement them
properly on our spine, and keep our discipline (typed schema, backend-agnostic
state, one gateway, deterministic decisions, everything audited & fenced).

---

## 1. How Vigil is built (ground truth)

Multi-process, Postgres-only, Anthropic-first (via `claude-agent-sdk` + the raw
`anthropic` SDK), heavy MCP:

```
Browser ─HTTP─▶ backend(FastAPI) ─serves SPA─┐
SIEM/EDR/Kafka ─poll/push─▶ daemon ──────────┼─▶ Redis(arq:llm) ─▶ llm-worker(s)
                              │               │                        │
                              ▼               ▼                        ▼
                       Postgres+pgvector  (all state)   Bifrost(Go LLM proxy) ─▶ Anthropic/OpenAI/Ollama
30+ MCP servers (stdio) ◀── tools (Splunk, CrowdStrike, VT, Jira, Slack, mempalace…)
OTEL ─▶ collector ─▶ Jaeger + Prometheus ─▶ Grafana
```

- **Agents** = a declarative `AgentProfile` (system prompt + tool whitelist +
  thinking budget + model tier + `component_category`) parameterizing ONE shared
  `ClaudeService` ReAct loop. 13 built-ins + DB-backed custom agents (forkable).
- **Workflows** = `WORKFLOW.md` (YAML frontmatter `name/agents/tools-used/...` +
  prose phases). Two engines consume them: a synchronous `WorkflowsService`
  (one-shot mega-prompt) and an autonomous `Orchestrator` + `AgentRunner` daemon
  (per-investigation workdir of `plan.md`/`state.json`/`context.md`; the agent
  edits its own plan via an `update_plan_step` tool).
- **Integrations** = "everything is MCP": a `mcp-config.json` catalog (~35 servers,
  4 tiers) spawned as stdio children with dormancy-by-design + live-connection
  gating; plus DB-backed **Skills** (Anthropic `SKILL.md` prompt templates exposed
  as synthetic `skill_*` tools) and an AI **custom-integration builder** (Claude
  writes a new MCP server's Python — powerful but an RCE surface they had to
  harden after a disclosure).
- **LLM** = ARQ priority queue → `LLMRouter` → **Bifrost** → provider. A 4-layer
  **model registry** (exact catalog → tier-prefix heuristic → zero → unknown) with
  a `pricing_source` tag on everything; derived cache pricing; budgets enforced by
  Bifrost virtual keys (402/429).
- **Autonomy** = confidence bands (`<0.70 monitor` / `0.70–0.90 human` / `≥0.90
  auto`) + tool tiers + **pre-flight** projected-cost gate + hourly/daily ceilings
  with **self-demotion** (orchestrator disables its own intake on cost breach; only
  a human re-enables). A DB-backed approval workflow with resume.
- **Memory/RAG** = `mempalace` (ChromaDB + local ONNX embeddings): verbatim
  "drawers" + lossy index "closets", drawer-floor-first **hybrid BM25+vector**
  retrieval, a bitemporal entity **knowledge graph**, per-agent **diaries**, and a
  token-budgeted 4-layer wake-up. RAG is injected pre-prompt into `context.md` and
  pulled mid-loop via MCP tools.
- **Security** = auth-by-default (`AUTH_DEPENDENCY` on every router +
  `PUBLIC_API_PATHS` allowlist + a CI route-coverage test), JWT cookie/bearer +
  Redis token-blacklist, CSRF double-submit, slowapi+Redis rate-limit, CSP/HSTS
  headers, a Fernet encrypted-secret store, an OTEL attribute scrubber, and a
  `prompt_security` module (`scan_for_injection` + `wrap_tool_result` fencing).
- **Ops** = Helm chart (backend Deployment; daemon as a **single-replica
  StatefulSet** to avoid double-polling; KEDA scales llm-workers on `arq:llm`
  depth; External-Secrets; NetworkPolicy; ServiceMonitor; idempotent db-init Job).

---

## 2. Subsystem-by-subsystem: Vigil vs us, and the verdict

| Subsystem | Vigil | Agentic SOC | Verdict |
|---|---|---|---|
| **Agents** | 13 declarative personas over 1 engine | 1 investigator persona | **Adopt personas** |
| **Runbooks** | Plain-text `WORKFLOW.md` (but mega-prompted) | 6 hardcoded RAG runbook strings | **Adopt real runbook files** |
| **Orchestration** | 2 engines; markdown largely illusory | 1 typed LangGraph spine | **Keep ours**; add light playbook selection |
| **Tools** | MCP (real) + in-process ladder | In-process, MCP-shaped, no client | **Add tiers now; MCP client later** |
| **RAG/Memory** | Hybrid + KG + cross-case memory (ChromaDB) | Plain vector, resolved-case reindex | **Adopt hybrid + case memory on pgvector** |
| **MITRE / det-rules** | Demo-grade (hardcoded dict / substring) | None | **Build properly from STIX (don't copy)** |
| **LLM gateway** | ARQ → router → external Bifrost; 2 ledgers | 1 in-process gateway + 1 ledger | **Keep ours**; add provenance + projection |
| **Cost control** | Pre-flight + budgets + self-demotion | Token/tool/time caps only | **Add $-budget + projection + provenance** |
| **Autonomy/approvals** | Confidence ladder + approval workflow | Deterministic close/escalate only | **Adopt approval workflow + tiers** |
| **Data model** | Rich (SLA/evidence/IOC/collab/templates) but Postgres-locked, drift | Lean, typed, backend-agnostic | **Adopt additively via StateStore** |
| **Security/auth** | Auth-by-default + CI test (defaults insecure) | **No auth at all (#1 gap)** | **Adopt the pattern, default ON** |
| **Frontend** | Auto-Ops, AI-Decisions, builders, graph/timeline (MUI) | Wizard/Cases/Chat/Cost (EUI) | **Re-implement top surfaces in EUI** |
| **Ops** | Helm + ARQ/KEDA + OTEL/Grafana | docker-compose only | **Adopt as Epoch E/F** |

*(Table preserved as originally written for this 2026-06-21 snapshot — do not
re-read the "Us" column as current state. Two cells are now stale in ways worth
flagging: **Security/auth** — auth shipped, but defaults OFF rather than ON, see
the Wave 2 note in §5; **Frontend** — the webui was never built in EUI at all; it
shipped and was later fully re-skinned on Tailwind + shadcn/Radix, so "re-
implement top surfaces in EUI" was never the path taken. See `AGENTS.md` §10 for
current state.)*

---

## 3. What to port — ranked, with where it lives in our tree

**Tier A — high value, low risk, fits our seams, matches the user's named asks:**

1. **Agent personas (the "multiple agents" ask).** A declarative
   `AgentPersona` registry (`backend/app/agents/personas.py`): id, label,
   specialization, system-prompt addendum, tool allowlist, model/thinking tier.
   The **router** picks a persona deterministically from the cluster
   (rule/technique/OCSF category/entity type); the **investigator** composes the
   addendum, filters its tools, and uses the persona's model via the existing
   per-rule model selection. Recorded on the `Case` + audit. **The deterministic
   spine (cost_gate, case_manager) is untouched.** This is the single biggest
   alignment with what the user wants and the lowest-risk way to do it.

2. **Runbooks as first-class plain-text files (the "runbooks" ask).** A
   `backend/app/runbooks/*.md` directory + a loader (`backend/app/engine/runbooks.py`):
   frontmatter `id/title/applies_to(rule_ids|techniques|entity_types)/persona/tools`
   + a markdown body of investigation guidance. The best-matching runbook is (a)
   injected as **TRUSTED** guidance into the investigator prompt and (b) indexed
   into RAG. This delivers Vigil's "your playbooks are plain text" pillar *honestly*
   (guidance, not fake multi-agent orchestration).

3. **Hybrid RAG retrieval (the "RAG" ask).** Upgrade `tools/vectorstore.py` +
   `tools/rag.py` to **drawer-floor-first hybrid**: vector is the floor, dependency-
   free **BM25** re-ranks, convex-combined. Big recall win on IOC/log/rule/runbook
   text that embeds as noise. No new deps, works on all three state backends.

4. **Tool safety tiers.** Add `tier ∈ {safe, managed, requires_approval,
   forbidden}` to the `Tool` base (`tools/base.py`), enforced in the investigator's
   dispatch + `CaseBudget`. All current tools are `safe`; this is a capability
   firewall that future-proofs any write/response tool and generalizes #3.

5. **Stronger untrusted-data fencing + cost provenance.** Upgrade `fence()`
   (`agents/prompts.py`) to carry `source`/`tool` provenance and **escape the close
   delimiter** (idempotent) — Vigil's `wrap_tool_result` is a strict improvement on
   our bare fence (#9). Add `pricing_source` (exact/heuristic/default) to
   `llm/pricing.py` + `UsageDoc`.

**Tier B — high value, needs a product decision or more work (recommend next):**

6. **Auth-by-default + CI route-coverage test (our flagged #1 gap).** Port Vigil's
   pattern verbatim *but default ON*: a shared auth dependency on every router, a
   tiny `PUBLIC_API_PATHS` allowlist (health, setup, inbound receivers), JWT
   cookie/bearer + Redis blacklist, and `backend/tests/test_route_auth_coverage.py`
   that walks `app.routes` and fails CI on any unauthenticated `/api/*` route.
   Pair with CSRF + security-headers + rate-limit middleware. *This is arguably the
   most important thing in the whole study; it just needs a "who manages users"
   decision.*

7. **Approval workflow + graduated autonomy.** An `ApprovalAction` StateStore repo +
   `/approvals` routes; the case_manager routes irreversible/low-confidence actions
   to a pending approval instead of acting. Pre-flight projected-cost gate
   (`llm/cost_estimator.py`) feeding `cost_gate`, a `$`-budget ceiling, and
   self-demotion on rolling spend. Treat all LLM-derived confidence as UNTRUSTED.

8. **Cross-case agent memory + knowledge graph.** A `memory` StateStore repo +
   `memory_search`/`memory_write` tools; persist verdict+reasoning keyed by cluster
   signature/observables on close; deterministically inject prior intel (fenced
   UNTRUSTED) into the investigator. Optional bitemporal `triples` table + `kg_*`
   tools.

**Tier C — operational maturity (Epoch E/F):**

9. ARQ workers + KEDA autoscaling (our roadmap's scale-out). 10. A Helm chart
   (poller as single-replica StatefulSet; our durable cursor is the real dedup
   guarantee). 11. OTEL GenAI metrics + a Grafana cost dashboard from our ledger.
12. UX: an Auto-Ops/Orchestrator surface, an **AI-Decisions/HITL** page (blocking
   approvals + retrospective multi-axis grading), reasoning-trace + chain-of-custody
   viewers, cache-aware cost analytics — all doable without new deps (graph/
   timeline viz being the only dep-requiring extras, webui-only; written when the
   plan was still "in EUI" — the webui ended up on Tailwind + shadcn/Radix
   instead, see §2's footnote). 13. A real MITRE module from a bundled STIX file
   (NOT Vigil's hardcoded dict) — **shipped as a bundled 697-technique JSON
   corpus**, not literally STIX-formatted, but no longer a hardcoded dict either;
   detection rules embedded into the RAG corpus (NOT substring search) — not
   built.

---

## 4. Anti-patterns to consciously avoid (lessons from Vigil)

- **Don't fake orchestration.** A markdown file pasted into one prompt is not a
  multi-agent workflow. If we add playbooks, they select/sequence *real* graph
  nodes; the spine stays typed.
- **Don't regress the schema.** Keep OCSF + typed Pydantic contracts; never go to
  ad-hoc dict findings or stub embeddings.
- **Don't introduce ChromaDB or a mandatory external LLM proxy.** Reuse our
  `StateStore`/pgvector and the single in-process gateway.
- **Don't ship insecure defaults.** If we add auth, it defaults ON; no `DEV_MODE`
  bypass in prod bundles; no default creds.
- **Don't let log-derived confidence trip irreversible actions.** Confidence is
  attacker-influenceable; fence it and gate irreversible actions on humans.
- **Don't port god-objects.** Small, focused modules that match our `engine/` +
  `agents/` split.
- **Don't ship schema fields we don't execute** (Vigil's `execution_steps`,
  `conditions`, `parallel_group`, MTTD/dwell columns are all hollow).

---

## 5. Execution plan (this overhaul)

**✅ Wave 1 (this session) — additive, fully offline-tested, spine intact:**
agent personas · plain-text runbooks · hybrid RAG · tool tiers · fencing+pricing
provenance. Plus: archive the legacy Kibana plugin (done), this study doc, journal.
Acceptance: `pytest -q` green (was 221), `webui` build green, all 12
non-negotiables intact. **Shipped in full** as "the Vigil-inspired overhaul — Wave
1" (see `AGENTS.md` §10).

**⚠️ Wave 2 (recommended next) — auth-by-default + CI coverage test + CSRF/headers/
rate-limit; approval workflow + pre-flight cost projection + `$`-budget.** **Shipped,
but with one deliberate deviation from this plan:** auth, RBAC (6 roles + custom
roles), MFA/TOTP, OIDC SSO, session policy, CSRF/rate-limit/security-headers
middleware, and the CI route-auth-coverage test all shipped (the 7-wave SOC
overhaul's W1–W3, plus Round 2's session work) — but **auth defaults OFF**
(`Secrets.auth_enabled=false`), not ON as this plan recommended (§4 "if we add
auth, it defaults ON"). This was a conscious choice to keep the no-auth "old
version" and the offline test suite working unchanged for existing deployments;
an operator opts in with `TLSOC_AUTH_ENABLED=true`. The approval workflow (HITL
`Proposal`s), pre-flight `BudgetGate`, and `$`-ceiling all shipped too (Round 3/4).
**Do not read this deviation as accidental — it's the one place we knowingly
diverged from this document's own recommendation.**

**◔ Wave 3 — cross-case memory + KG; MITRE-from-STIX; detection-rule RAG corpus;
HITL/Auto-Ops/reasoning-trace UI surfaces.** **Partially shipped:** an operator
`MemoryStore` (durable, Claude.ai-style facts auto-injected into investigations +
chat) and a `Proposal`s-backed HITL Approvals surface + a full `TraceTimeline`
reasoning-trace UI all shipped — but as a different shape than sketched here (the
memory store is operator-authored facts, not an auto-captured cross-case
verdict/reasoning memory keyed by cluster signature, and there's no bitemporal
knowledge graph). MITRE shipped as a bundled 697-technique JSON corpus (not a
hardcoded 15-technique dict, and not literally STIX-formatted). A dedicated
detection-rule RAG corpus and a standalone Auto-Ops orchestrator console were not
built.

**○ Wave 4 (Epoch E/F) — ARQ/KEDA scale-out; Helm chart; OTEL+Grafana.** **Not
started** — this remains the one open item on the suite's own Epoch E backlog; see
`ROADMAP.md`.
