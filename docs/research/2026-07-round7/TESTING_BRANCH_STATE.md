# Testing Branch — State & What's New (Round-7 UI Overhaul reference)

> Generated 2026-07-05 by a 24-agent Sonnet documentation fleet. This is the current-state
> reference for the Round-7 UI/UX overhaul. Sections cover (a) the NEW post-Round-6
> Stage-Timeline feature and (b) a current-state map of every area the UI work touches.


## Contents

1. NEW — Case-stages backend contract
2. NEW — StageTimeline frontend + CaseDetail integration
3. NEW — Markdown component + ChatPanel refactor
4. Overview / “Security posture dashboard” page
5. RiskGauge + Active Risk Index
6. Metrics / posture page + MTTD/MTTR
7. CaseDetail full current structure
8. Cases list page
9. Nav sidebar + global search + command palette
10. Feedback flow (where feedback is collected today)
11. Case close flow + decide() + auto-close surfacing
12. Custom Dashboards page (name-card problem)
13. Feature registry + router + nav derivation
14. Design tokens + theme + palette + animations
15. Layout primitives (PageHeader/PageContainer/KpiTile/StatCard)
16. Charts + ChartCard + dataviz components
17. Backend /api/metrics + engine/metrics.py
18. Case model: severity/priority/impact + AI-vs-SIEM grading
19. Risk scoring engine (Active Risk Index math)
20. Feedback model + endpoints
21. Alerts → cases funnel data (for the infographic)
22. Backend API route inventory
23. Overall branch state recap (Rounds 3–6 + timeline)
24. Case rationale / “Why” + trace + triage chips

---


<!-- ===== [1] NEW — Case-stages backend contract ===== -->

## Case Timeline / structured reasoning — new since Round 6 (`54c8465..HEAD`)

Three commits (`7ed259d`, `1654b81`, `e6ff63a`) add a **6-stage "Timeline" narrative**
projection for a case, a matching read endpoint, structured investigator reasoning,
and a webui rendering surface. `engine/case_manager.py` (`decide()`) has **zero diff**
vs `54c8465` — byte-identical, confirmed via `git diff 54c8465..HEAD -- backend/app/engine/case_manager.py` (empty).

### New Pydantic models (`backend/app/models.py:910-951`)

- **`StageState`** (`models.py:910`) — derived scalars/labels safe to render inline
  (never raw source text): `severity: float|None`, `severity_band: str|None`,
  `severity_source: str|None` (`"source_asserted"|"derived"`), `risk_score: float|None`,
  `verdict: str|None`, `confidence: float|None`.
- **`StageStep`** (`models.py:920`) — a chronological sub-step under a stage:
  `kind: str` (`reasoning|tool|knowledge|memory|note`), `label: str`, `body: str`,
  `trusted: bool = True`, `ts: str|None`. `trusted=False` ⇒ the webui fences `body`
  in an escaped `<CodeBlock>` (non-negotiable #9); `trusted=True` renders through the
  new shared `Markdown` component.
- **`TimelineStage`** (`models.py:929`) — one of the six ordered stages: `id: str`,
  `kind: str` (`input|correlate|risk|triage|investigate|decide`), `label: str`,
  `status: str = "done"` (`done|skipped|pending`), `deterministic: bool = False`,
  `ts: str|None`, `headline: str` (always TRUSTED prose — source specifics go in a
  fenced `StageStep`), `state: StageState`, `steps: list[StageStep]`.
- **`TimelineStagesResponse`** (`models.py:945`) — the endpoint payload:
  `case_id: str`, `stages: list[TimelineStage]`, `total: int`.

### The six stages (in order, `_CANON_STAGES` in `routes_triage.py:481-488`)

| id | kind | label | deterministic | source of headline/steps |
|---|---|---|---|---|
| 1 | `input` | Alert received | `False` | member/evidence counts, `case.source_name`; first evidence summary as an UNTRUSTED note |
| 2 | `correlate` | Correlate | `True` | cluster size + `case.cluster_signature` (UNTRUSTED note) |
| 3 | `risk` | Risk | `True` | `case.risk_score` + non-zero `risk_breakdown` factors (volume/velocity/reputation/diversity/asset_criticality) |
| 4 | `triage` | Triage | `False` | `case.agent_persona` routing, `case.playbook_id` + playbook_selector audit reason, memory facts pulled from the CONTEXT audit row |
| 5 | `investigate` | Investigate | `False` | reasoning excerpt, `TOOL_CALL`/`ES_QUERY` audit rows, RAG knowledge snippets, enrichment one-liner, final verdict/confidence |
| 6 | `decide` | Decide | `True` | re-derives the existing `_decision_span()` (the same helper the `/timeline` endpoint already used) to DISPLAY the deterministic clause; never re-runs `decide()` for real |

`status` per stage is `done`/`skipped`/`pending`; an **unknown case_id returns a
6-item skeleton** built straight from `_CANON_STAGES` with every stage `status="skipped"`
— the endpoint **never 404s**.

### New/changed API endpoint

**`GET /api/cases/{case_id}/stages`** (`backend/app/api/routes_triage.py:676-694`, new)
- Auth: `Depends(require_permission("cases", "read"))` (same gate as the existing
  `/cases/{id}/timeline`).
- Response: `TimelineStagesResponse` (`.model_dump(mode="json")`) — `{case_id, stages, total}`.
- Behavior: pure read-time projection over `state.cases.get(case_id)` +
  `state.audit.records_for_case(case_id)` — the SAME facts `/timeline` and
  `/cases/{id}/rationale` already read. Mutates nothing; re-derives (never re-runs)
  `decide()`'s clause via the pre-existing `_decision_span()` helper only to surface
  it as the `decide` stage's `state`/headline/step. Untrusted source/log/tool text is
  carried only inside `steps[].body` with `trusted=False` (fenced in the UI); every
  `headline` is backend-composed TRUSTED prose (`_humanize()`, `_decide_headline()`,
  `_enrichment_line()` — no raw log/LLM text ever lands in a headline).
- No existing routes changed; this is purely additive (228 new lines to
  `routes_triage.py`, all after the pre-existing `/triage/preview-decision` and
  `/cases/{id}/{triage,timeline}` routes).
- Test coverage: `backend/tests/test_case_stages.py` (new, 213 lines) — asserts the
  6-stage skeleton on a ghost case, stage ordering/content for a populated case, and
  that `decide()` behavior is unaffected.

### Investigator: structured reasoning emission

- **`backend/app/agents/prompts.py`** (`INVESTIGATOR_SYSTEM`, +3 lines) — the LLM is now
  instructed to structure its `reasoning` string as: one-sentence summary → a
  **numbered list** of key indicators (`1.`, `2.`, ... one per line) → a final line
  starting `Recommendation:`, all `\n`-separated. This is prompt guidance only; the
  `reasoning` field itself is still plain free text in the verdict JSON contract (no
  new response schema field).
- **`backend/app/agents/investigator.py`** (`_get_verdict` / verdict-recording path,
  ~`investigator.py:298-315`) — previously only a 600-char `reasoning_excerpt` was
  folded into the `VERDICT` audit row's `result_summary` string. Now:
  - `reasoning_excerpt = truncate(reasoning, 600)` — unchanged, still appended to
    `result_summary` as `reasoning=<excerpt>`.
  - **New**: `reasoning_full = truncate(reasoning, 4000)`, stashed in a new
    `tool_input={"reasoning": reasoning_full}` on the same `ActionType.VERDICT`
    audit record (audit `tool_input` is not clipped the way `result_summary` is).
  - This full reasoning is what `routes_triage._build_stages()` reads back out (via
    the `ActionType.VERDICT` row's `tool_input.reasoning`, falling back to parsing
    `reasoning=` out of `result_summary` for older/legacy rows) to populate the
    `investigate` stage's `StageStep(kind="reasoning", trusted=True)`.

### Webui consumption (supporting the same feature, for completeness)

- `webui/src/soc/components/Markdown.tsx` (new, extracted from `ChatPanel.tsx`) — a
  dependency-free, HTML-injection-safe renderer now shared by chat and the case
  Timeline; added numbered-list support (`1.`/`1)`) alongside the prior bold/code/
  bullet/paragraph support, matching the new prompt-mandated reasoning structure.
- `webui/src/soc/pages/casedetail/StageTimeline.tsx` (new) — renders the 6 stages;
  `trusted=true` steps render via `Markdown`, `trusted=false` steps render only inside
  an escaped `CodeBlock` (enforces non-negotiable #9 client-side too); long trusted
  bodies (`step.body.length > CLAMP_CHARS`) clamp with a "Show more" toggle.
- `webui/src/soc/pages/CaseDetail.api.ts` (+50 lines) — adds the typed client
  `getCaseStages(caseId)` → `GET cases/{id}/stages`, plus the TS mirrors of
  `TimelineStage`/`StageStep`/`StageState`/`TimelineStagesResponse`.
- `webui/src/soc/pages/CaseDetail.tsx` (+49/-… lines) wires a Timeline tab to this
  new stages endpoint (per the commit message "fix: wired timeline tab in case Detail").

### Non-negotiables held

- **#3** (`decide()` is the sole close/escalate authority): `case_manager.py` has no
  diff at all since `54c8465`; the new `decide` stage only re-derives the existing
  `_decision_span()` display helper (already used by `/timeline`) and the endpoint
  is read-only/GET.
- **#9** (untrusted log/source text fenced): every `StageStep` sourced from raw
  evidence/cluster-signature/tool query text is marked `trusted=False`; only
  backend-composed headlines and derived numeric/label state are trusted; the webui
  enforces the same split by rendering `trusted=False` bodies exclusively inside
  `CodeBlock`.
- **#2** (audited): the fuller reasoning is persisted on the existing `ActionType.VERDICT`
  audit record (no new audit action type, no new index/table).


---


<!-- ===== [2] NEW — StageTimeline frontend + CaseDetail integration ===== -->

## Case Timeline (StageTimeline) — six-stage narrative

New since Round-6 commit `54c8465` (feature/timeline, PRs #21/#22, work items tagged
`#20`). Adds a read-only, deterministic-aware "story of the case" view: `input →
correlate → risk → triage → investigate → decide`, distinct from the existing
per-span `TraceTimeline` (Trace tab).

### Backend: `GET /api/cases/{case_id}/stages`

- Router: `backend/app/api/routes_triage.py:41` (`router = APIRouter(prefix="/api")`),
  endpoint at `backend/app/api/routes_triage.py:676-698` (`async def case_stages`),
  gated by `require_permission("cases", "read")`. **Never 404s** — an unknown case
  returns a 6-item skeleton (`status="skipped"`, correct `deterministic` flags) built
  from the canonical spine `_CANON_STAGES` (`routes_triage.py:480-487`):
  `("input", "Alert received", False)`, `("correlate", "Correlate", True)`,
  `("risk", "Risk", True)`, `("triage", "Triage", False)`,
  `("investigate", "Investigate", False)`, `("decide", "Decide", True)`.
- Pure read-time projection over `Case` + its audit rows (`state.audit.records_for_case`,
  the **same rows** `/rationale` and `/timeline` read) via `_build_stages()`
  (`routes_triage.py:519-673`). Mutates nothing; re-derives the `decide()` clause only
  to **display** it (#3 made visible), never to re-decide.
  - **input**: headline `"{n} alert(s) from {source_name}"`; `state.severity_band` /
    `severity_source`; one untrusted `note` step with `case.evidence[0].summary`.
  - **correlate** (deterministic=true): headline `"N alerts clustered into one case"`
    or `"Single-alert case (no cluster)"`; untrusted `note` step with
    `cluster_signature`.
  - **risk** (deterministic=true): headline `"Risk {score}/100"`, `state.risk_score`;
    a trusted `note` step listing non-zero `risk_breakdown` factors (volume/velocity/
    reputation/diversity/asset criticality).
  - **triage**: routes to `agent_persona` / `playbook_id` / operator `memory` facts
    parsed from the `ActionType.CONTEXT` audit row's `tool_input` (knowledge/memory/
    enrichment); headline `"Routed to {persona} specialist"` or `"Triaged"`/`"No
    specialist routing"`; steps = trusted `playbook` note + trusted `memory` notes.
  - **investigate**: reasoning excerpt from the `ActionType.VERDICT` row (`tool_input
    .reasoning` or `result_summary` split on `"reasoning="`), untrusted `tool` steps
    per `TOOL_CALL`/`ES_QUERY` audit row (`query_text`), untrusted `knowledge`
    snippets, trusted `enrichment` line (via `_enrichment_line()`); headline is the
    verdict+confidence once decided, else `"Investigated (no verdict recorded)"` or
    `"No investigation ran"` (status `skipped`).
  - **decide** (deterministic=true): built from the SAME decision span helper
    `_decision_span()` used by `/timeline`; headline via `_decide_headline()`
    (`"Escalated by policy"` / `"Auto-closed by policy"` / `"Held for human review"` /
    humanized status); `state.{verdict,confidence,risk_score}` from `payload_ref`; one
    trusted `note` step = the decision-rationale summary. If no decision span yet,
    stage is `status="pending"`, headline `"Awaiting decision"`.
- Models (`backend/app/models.py:910-953`, all new): `StageState` (`severity`,
  `severity_band`, `severity_source`, `risk_score`, `verdict`, `confidence` — all
  optional derived scalars, never raw text), `StageStep` (`kind: reasoning|tool|
  knowledge|memory|note`, `label`, `body`, `trusted: bool = True`, `ts`), `TimelineStage`
  (`id`, `kind`, `label`, `status: done|skipped|pending`, `deterministic: bool`, `ts`,
  `headline`, `state: StageState`, `steps: list[StageStep]`), `TimelineStagesResponse`
  (`case_id`, `stages: list[TimelineStage]`, `total`).
- Security (#9): `StageStep.trusted=False` marks source/tool/log-derived text
  (evidence summaries, cluster signatures, tool `query_text`, knowledge snippets) —
  the frontend fences these; only our own derived prose (`headline`, risk factors,
  playbook/memory notes, decision rationale) is `trusted=True`.
- New offline test file `backend/tests/test_case_stages.py` (213 lines, added this
  round) covers the skeleton-for-unknown-case path and per-stage projection.

### Frontend data layer: `webui/src/soc/pages/CaseDetail.api.ts`

- New types mirroring the backend 1:1 (`CaseDetail.api.ts:145-186`):
  `TimelineStageKind`, `TimelineStageStatus`, `StageStepKind`, `StageState`,
  `StageStep`, `TimelineStage`, `TimelineStagesResponse`.
- New client fn `getCaseStages(caseId): Promise<TimelineStagesResponse>` →
  `api.get(`cases/${id}/stages`)` (`CaseDetail.api.ts:189-191`), i.e.
  `GET /api/cases/{id}/stages` through the existing `/api` proxy.

### `StageTimeline` component: `webui/src/soc/pages/casedetail/StageTimeline.tsx`

- `export interface StageTimelineProps { data: TimelineStagesResponse | null; loading?:
  boolean; error?: unknown; onRetry?: () => void }` (`StageTimeline.tsx:213-218`).
- States: `loading` → 3 `Skeleton` blocks; `error` → `<LoadError title="Could not load
  the timeline" onRetry={onRetry}/>`; empty `stages` → `<EmptyState icon={GitBranch}
  title="No timeline yet" .../>`; otherwise renders `<ol>` of `StageRow`s
  (`StageTimeline.tsx:220-258`).
- Per-stage icon/tone map `STAGE_META` (`StageTimeline.tsx:60-70`): `input`→`Inbox`/
  info, `correlate`→`GitMerge`/info, `risk`→`Gauge`/medium, `triage`→`Compass`/info,
  `investigate`→`Search`/info, `decide`→`ShieldCheck`/low; unknown kind falls back to
  `GitBranch`/info.
- `StageRow` (`StageTimeline.tsx:144-209`): a vertical timeline `<li>` with a
  connecting spine line (`last` stage omits it), a circular icon badge (dashed/muted
  for `skipped`/`pending`, tone-colored otherwise), the stage `label`, a
  `deterministic` outline `Badge` with a `GitBranch` icon when `stage.deterministic`
  (the #3 trust signal), `skipped`/`pending` badges, an optional formatted `stage.ts`,
  the TRUSTED `headline` as plain prose (never markdown-rendered), `<StateChips>`, and
  — if `stage.steps.length > 0` — a `Collapsible` "Show N steps" trigger revealing
  `StepItem`s.
- `StateChips` (`StageTimeline.tsx:74-96`): renders `Badge`s for `severity_band` (+
  "SIEM"/"derived" suffix from `severity_source`), `risk_score` (rounded, "risk N/100"),
  `verdict` (humanized), `confidence` (rounded %). Renders nothing if no fields present.
- `StepItem` (`StageTimeline.tsx:103-140`): each step is a bordered card. Trusted steps
  (`step.trusted`) render `body` via the shared `<Markdown>` component with a
  clamp-to-~4-lines + "Show more"/"Show less" toggle when `body.length > CLAMP_CHARS`
  (320 chars). Untrusted steps (`trusted=false`) show a `Lock` icon + "untrusted" label
  and render `body` **only** inside `<CodeBlock value={step.body} wrap copyable
  maxHeightClassName="max-h-40" />` — never as prose/markdown (#9 enforced at the
  component level, matching the header comment at `StageTimeline.tsx:10-11`).
- New test file `webui/src/soc/pages/casedetail/__tests__/StageTimeline.test.tsx` (112
  lines) asserts headline/state-chip rendering, the deterministic badge, skipped
  marking, and that untrusted step bodies are fenced.

### Wiring into `CaseDetail.tsx`

- New `'timeline'` tab added to the tab union (previously `overview | why | threat |
  trace | collab | feedback | chat`), positioned second, right after Overview, before
  Why — new `<TabsTrigger value="timeline">` with a `ListTree` icon
  (`webui/src/soc/pages/CaseDetail.tsx` diff, `TabsTrigger` block near line 1328-1334).
- State: `stages: TimelineStagesResponse | null`, `stagesLoading: boolean`,
  `stagesError: unknown` — same lazy-load pattern as the existing Trace tab's
  `timeline`/`timelineLoading`/`timelineError`.
- `loadStages()` calls `getCaseStages(id)`, guarded by `activeIdRef.current === id` so
  a stale response for a since-closed/switched case is dropped.
- A `React.useEffect` triggers `loadStages()` only when `open && tab === 'timeline' &&
  stages === null && !stagesLoading && !stagesError` (lazy — fetched once, on first
  visit to the tab).
- `stages` (and its error) are reset to `null` on: case-switch (open effect), applying
  a playbook, any lifecycle action, and starting a reinvestigation — the same
  invalidation points already used for the Trace-tab `timeline` state, so the new tab
  refetches fresh data after any of those mutations.
- Render: `<TabsContent value="timeline"><StageTimeline data={stages} loading=
  {stagesLoading} error={stagesError} onRetry={loadStages} /></TabsContent>`.

### Relationship to existing panels

`StageTimeline` (new, Timeline tab) is a coarser, narrative six-stage view built from
audit rows re-projected server-side; it is separate from `TraceTimeline` (existing,
Trace tab) which renders the raw per-span `GET /api/cases/{id}/timeline` (`TraceSpan[]`
— `invoke_agent`/`chat`/`execute_tool`/`decision` spans) and from `WhyPanel` (existing,
Why tab, `GET /api/cases/{id}/rationale`). No existing endpoint, tab, or component was
removed; this is purely additive.


---


<!-- ===== [3] NEW — Markdown component + ChatPanel refactor ===== -->

## New shared `Markdown` renderer + `ChatPanel` extraction (post-Round-6, commit `e6ff63a` "ui:investigator reasoning is now structured #20")

### What shipped
A dependency-free Markdown renderer was extracted out of `ChatPanel.tsx` into its own module, `webui/src/soc/components/Markdown.tsx` (100 lines), and gained ordered-list support it didn't previously have. It ships with a co-located spec, `webui/src/soc/components/__tests__/Markdown.test.tsx`.

### `Markdown.tsx` — what it supports
Exported symbol: `export const Markdown: React.FC<{ text: string; className?: string }>` (default export too). Internal helper `renderInline(text: string, keyBase: string): React.ReactNode[]` (Markdown.tsx:15-45).

Supported syntax, block-parsed line-by-line (Markdown.tsx:47-97):
- **Bold**: `**text**` → `<strong className="font-semibold text-foreground">` (inline, parsed after code spans so bold markers inside code are inert).
- **Inline code**: `` `text` `` → `<code className="rounded border border-border bg-muted px-1 py-0.5 font-mono text-xs text-foreground">`.
- **Bullet lists**: lines matching `/^\s*[-*]\s+(.*)$/` → `<ul className="my-1 list-disc space-y-0.5 pl-5">`.
- **Numbered lists (NEW)**: lines matching `/^\s*\d+[.)]\s+(.*)$/` (both `1.` and `1)`) → `<ol className="my-1 list-decimal space-y-0.5 pl-5">`. This is new relative to the old ChatPanel-local version, which only had a `ul` path (no `ol`/ordered-list handling existed pre-extraction).
- Switching between `ul`/`ol` mid-stream flushes the prior list (`flush()`, Markdown.tsx:53-67) so adjacent numbered/bulleted runs don't merge into one list.
- **Paragraphs / blank-line spacing**: non-list, non-blank lines → `<p className="leading-relaxed">`; blank lines → a `<div className="h-2" aria-hidden />` spacer.
- **`className` prop (NEW)**: the root `<div>` wrapper now takes an optional `className` (defaults to `'space-y-0.5 text-md'`), letting callers override sizing/spacing per context — the old ChatPanel-local version hardcoded `text-md` with no override.

### Safety posture (non-negotiable #9 — untrusted rendering)
Everything the parser emits is a React element/text node built via `React.createElement` (JSX) — there is no `dangerouslySetInnerHTML`, no HTML-string concatenation, and no raw-string insertion anywhere in the module. Literal HTML in the input (e.g. `<b>x</b>`) is treated as inert text and rendered escaped, never as markup — asserted directly by the test `renders inline bold and code, never raw HTML` (`Markdown.test.tsx`), which checks `container.querySelector('b')` is null while the literal string appears via `screen.getByText(/<b>x<\/b>/)`. This makes `Markdown` itself injection-safe for arbitrary text, but it is NOT a trust boundary decision by itself — callers still classify content as trusted/untrusted before choosing to route it through `Markdown` vs. a hard-fenced code viewer:
- In `StageTimeline.tsx` (the new case Timeline tab), `Markdown` is used only for `trusted === true` narrative steps (StepItem, StageTimeline.tsx:117-123); when `step.trusted` is `false` (raw source/log/tool payload), the body instead renders through `<CodeBlock value={step.body} wrap copyable maxHeightClassName="max-h-40" />` (StageTimeline.tsx:135), never through `Markdown` — preserving the existing UNTRUSTED-fencing discipline (`fence()`/`UNTRUSTED_OPEN/CLOSE` on the backend) at the presentation layer as well. A visible `Lock` icon + "untrusted" label mark these steps (StageTimeline.tsx:109-115).
- In `ChatPanel.tsx`, `Markdown` renders the assistant's own natural-language answer text (`item.content`), which is LLM-authored prose, not raw log/source data; error messages are still rendered as plain `{item.content}` text inside an `Alert`, not through `Markdown` (ChatPanel.tsx:604-609).

### Why `ChatPanel.tsx` shrank ~85 lines
`ChatPanel.tsx` previously carried its own private copy of this exact renderer (`renderInline` + a local `Markdown` component, ~85 lines) used only for the assistant-turn bubble. That inline implementation is deleted entirely and replaced with `import { Markdown } from './Markdown';` (ChatPanel.tsx:88) and a single call site, `<Markdown text={item.content} />` (ChatPanel.tsx:612, inside the assistant-message bubble at ChatPanel.tsx:610-613). Net diff: `-85/+1` on ChatPanel.tsx — pure de-duplication, no behavior change to the chat transcript itself (bullet/bold/code rendering is byte-identical to before; it now also supports numbered lists it previously lacked).

### Where `Markdown` is now reused
Two call sites in the webui, both importing from `webui/src/soc/components/Markdown.tsx`:
1. `webui/src/soc/components/ChatPanel.tsx:88` (import), `:612` (usage) — chat transcript assistant-turn body.
2. `webui/src/soc/pages/casedetail/StageTimeline.tsx:33` (import), `:122` (usage, with `className="space-y-1 text-sm leading-relaxed"` override) — the new case-Timeline tab's trusted narrative-step bodies (`StepItem`, part of the "six-stage narrative" feature landed in the same commit range, `GET /api/cases/{id}/stages` → `TimelineStage`/`StageStep` shapes consumed via `@/soc/pages/CaseDetail.api`).

No other files import `Markdown`; grep hits in `Catalog.tsx` and `CaseDetail.tsx` for the word "Markdown" are unrelated prose strings ("Drop Markdown runbooks…", "Markdown report"), not component usage.
</markdown>


---


<!-- ===== [4] Overview / “Security posture dashboard” page ===== -->

## Current-state reference: `Overview.tsx` (Security Posture Dashboard)

**File:** `webui/src/soc/pages/Overview.tsx` (1085 lines). Registered as the default landing surface (`FEATURES[]` registry, `soc/registry.tsx`).

### Title / header text
- Exported constant `export const PAGE_TITLE = 'Security Posture Dashboard';` (`Overview.tsx:97`) — used as the `<PageHeader title={PAGE_TITLE}>` value and as the smoke-test boot-guard anchor.
- **Note:** the exact string is **"Security Posture Dashboard"**, not "Security posture" — the task's expected string does not appear verbatim anywhere in the file. The closest matches are the `PageHeader`'s `eyebrow="Security Command Center"` (`:620`) and the module docstring's phrase "Security Posture Dashboard" (`:2`).
- Header description (plain text, `:623`): *"Live triage posture across every connected source — risk pressure, alert load, and how the agent is resolving cases."*
- Header icon: `Radar` (lucide-react, `:621`).
- Header `meta` slot (`:624-640`): an SLA-attainment pill (`SLA {ratioPct(...)}`), only rendered when `posture.sla.enabled` — colored critical/high/success by breached/at-risk/clean.

### Overall layout (three zones, per the file's own docstring `:1-28`)
Rendered inside `<PageContainer variant="wide" className="space-y-6">` (`:614`, max-width `1760px`/`1920px` at 2xl, `webui/src/soc/components/PageContainer.tsx:39`):

1. **Zone 1 — compact hero**: `<PageHeader variant="hero" data-testid="page-hero">` (`:616-641`), a ~64-80px band (`p-6`, `text-2xl` title), not the old ~176px marketing hero.
2. **Zone 1b — control bar**: `<ControlBar variant="flat" label="Dashboard controls">` (`:540-568`) wrapping `<TimeRangePicker>` + a manual refresh icon-button (`RefreshCw`, spins while `loading`).
3. Optional **AutomationNudge** banner (onboarding, dismissible, `:646-657`).
4. Optional **LoadError** (`:659-665`) or **EmptyState** card (`:667-681`, "No triage activity yet" → CTA to `navigate('sources')`).
5. **Zone 2 — KPI strip**: a flat, un-nested `<Stagger>` grid (`grid-cols-2 md:grid-cols-4 2xl:grid-cols-7`, `:686-701`) of 7 `<KpiTile>`s.
6. **Zone 3 — widget grid**: three rows of named collapsible `<DashboardGroup>` bands — Row A (`xl:grid-cols-3`, `:706-865`), Row B (`xl:grid-cols-3`, `:868-990`), Row C (`xl:grid-cols-2`, `:993-1079`).

A loading skeleton (`:572-606`) mirrors this exact three-zone shape (hero/control-bar/7 KPI skeletons/3+3+2 widget skeletons) so nothing shifts on load.

### Data sources
`load()` (`:196-224`) fires 4 calls via `Promise.allSettled` (partial failure degrades one widget, never the page):
- `api.listCases({ limit: 200, from: 'now-${hours}h' })` → `GET /api/cases?limit=200&from=now-{h}h` — capped at 200, most-recent by created-desc, window-scoped by the TimeRangePicker (Round-6 #37).
- `api.getMetrics(hours)` → `GET /api/metrics?window_hours={h}`.
- `api.usageSummary(hours)` → `GET /api/usage/summary?window_hours={h}`.
- `api.ragStats()` → `GET /api/rag/stats` (no window param).

Plus `usePosture(hours)` (`webui/src/soc/hooks/usePosture.ts`) → `fetchPosture(hours)` → `GET /api/metrics/posture?window_hours={h}&compare=` (`webui/src/soc/pages/Metrics.posture.api.ts:160-169`) — the **authoritative server-side** MTTA/MTTR/dwell-p50 + SLA + quality rollup; this REPLACED ~120 lines of deleted client-side timing math.

Auxiliary onboarding fetch (`:256-268`, best-effort, typeof-guarded): `api.listSources()` and `api.get('tuning/config')` to decide whether to show `AutomationNudge`.

`refreshAll()` (`:236-239`) drives both `load()` and `reloadPosture()` from one control-bar tick (manual button or `TimeRangePicker`'s `onRefreshTick`, default auto-refresh = `'off'`).

### Every widget/tile/card

**KPI strip (7 tiles, `kpis` memo `:441-537`, each a `<KpiTile>`):**
1. **Open Cases** — `fmtNumber(derived.open)`, sub `"{cases.length} cases tracked"`, icon `Inbox`, accent `critical`, `goodDirection: 'down'`, click → `navigate('cases', { status: 'open', window })`.
2. **Total Cases** — `metrics?.total_cases ?? cases.length` (deliberately NOT window-scoped — all-time), icon `LayoutDashboard`, accent `info`, `goodDirection: 'none'`, click → `navigate('cases')`.
3. **Critical / High** — `derived.criticalHighAlerts`, sub `"{critical} critical observed"`, icon `ShieldAlert`, accent `high`, `goodDirection: 'down'`, click → `navigate('cases', { severity: critical>0?'critical':'high', window })` (drills to worst non-empty band).
4. **Escalated To Human** — `metrics?.needs_human_cases ?? autonomy.escalated`, icon `Workflow`, accent `low`, `goodDirection: 'down'`, click → `navigate('cases', { status: 'needs_human', window })`.
5. **Artifacts In Scope** — `derived.entities` (distinct `type:value` entity set size), icon `Boxes`, accent `medium`, `goodDirection: 'none'`, no click.
6. **Knowledge Signals** — `rag?.document_count`, sub `"{total_chunks} indexed chunks"`, icon `Database`, accent `success`, `goodDirection: 'up'`, click → `navigate('intelligence', { tab: 'knowledge' })`.
7. **LLM Spend** — `fmtMoney(usage?.total_cost, usage?.currency)`, sub `"{tokens} tokens · {calls} calls"`, icon `CircleDollarSign`, accent `primary`, `goodDirection: 'down'`, click → `navigate('metrics', { tab: 'cost' })`.

**Row A (`:706-865`):**
- **"Active Risk Index" `DashboardGroup`** (description "weighted pressure") → a `Card` containing `<RiskGauge score={riskIndex} size={200} label="Weighted risk pressure" />` plus a 3-col mini-stat row below it: Open / Critical / Crit-High counts (`derived.open/critical/criticalHighAlerts`). See "RiskGauge placement" below.
- **"Open cases by severity" `DashboardGroup`** (`count={derived.open}`) → a `Card` with a 5-row list (critical/high/medium/low/info via `SEV_ORDER`), each a clickable button showing dot + label + count + a progress bar (`derived.sevCounts[sev]` / `totalCases`), click → `navigate('cases', { severity: sev, window })`.
- **"Attention queue" `DashboardGroup`** (`count={needs_human_cases}`, description "awaiting a human") → a `Card`: big number of escalated cases + `Workflow` icon; if `slaPosture` present, a 2-col SLA-breached/at-risk mini-stat pair; else a muted "SLA tracking is off…" note; a full-width "Review escalations" button → `navigate('cases', { status: 'needs_human', window })`.

**Row B (`:868-990`):**
- **"Autonomous vs human" `DashboardGroup`** (description "how cases were resolved", the **#3 trust surface**) → a `Card`: big `ratioPct(autonomy.automationPct)` with `ShieldCheck` icon, a caption, a 2-color split progress bar (success=auto-resolved vs high=sent-to-human), a 2-col stat pair (Auto-resolved / Sent to human), and a footnote: *"Advisory only — the agent recommends; the deterministic case manager decides. This dashboard never influences that."*
- **"Response timing" `DashboardGroup`** (description "p50, server-computed", actions: "Detail →" button → `navigate('metrics', { tab: 'posture' })`) → 3 `<KpiTile variant="bar">` tiles for MTTD (dwell), MTTA, MTTR, each `humanizeMins(p50)` or `DASH` ("—") when unavailable, sub = `"p50 · N samples"` or the server's `reason` string.
- **"Cost & budget" `DashboardGroup`** (description "LLM spend this window") → a `Card`: big `fmtMoney(usage.total_cost)`, sub tokens/calls, `CircleDollarSign` icon, a full-width "Open cost ledger" button → `navigate('metrics', { tab: 'cost' })`.

**Row C (`:993-1079`):**
- **"Connector health" `DashboardGroup`** (`count={productItems.length}`, description "case telemetry by source") → a `Card` with `<BarList items={productItems} showRank showPercent>` (top-8 sources by case count, `derived.productCounts` keyed by `k.source_name || k.source_id || 'Unattributed'`), or an `EmptyState` ("No source signals").
- **"Case workload state" `DashboardGroup`** (`count={workloadItems.length}`) → a `Card` with a status-breakdown list (`metrics?.by_status` else derived from `cases`), each row a clickable button (label via `humanizeToken(status)`, colored progress bar via `statusBar(status)`) → `navigate('cases', { status, window })`, or an `EmptyState` ("No workload").

### RiskGauge / Active Risk Index placement
- Lives in **Row A, first column**, inside a `DashboardGroup title="Active Risk Index"`.
- Component: `webui/src/soc/components/RiskGauge.tsx` — a half-circle SVG gauge, two overlaid `<path>`s (muted track + `currentColor` progress arc via `stroke-dasharray`/`stroke-dashoffset`), a centered `{score}/100` overlay, and a text band label below (non-color signaling).
- Score computed by the `riskIndex` memo (`Overview.tsx:397-408`): `avg = metrics?.avg_risk_score` (fallback: mean of `cases[].risk_score`); `criticalDensity = derived.critical / cases.length`; `score = avg*0.7 + criticalDensity*100*0.3`, clamped 0-100, rounded.
- Band coloring inside `RiskGauge` uses `scoreBand()` from `webui/src/soc/components/palette.ts:224-229`: critical ≥74, high ≥48, medium ≥22, else low.
- **Discrepancy to note for the overhaul:** Overview's OWN `bandOf()` (`:149-156`, used for `derived.sevCounts`/`derived.critical`/`derived.criticalHighAlerts` and the "Open cases by severity" widget) uses a *different* ladder — critical ≥80, high ≥60, medium ≥35, low ≥15, else info — i.e. two divergent severity-band thresholds coexist on the same page (RiskGauge's 74/48/22 vs. Overview's local 80/60/35/15).
- Below the gauge, a 3-cell mini-stat strip (Open / Critical / Crit-High) reuses `derived` counts, each in a bordered `bg-surface` box.

### Time-range handling
- State: `range: TimeRange` (default `DEFAULT_RANGE` = "Last 24 hours", `TimeRangePicker.tsx:76`) and `refresh: RefreshValue` (default `'off'`).
- `hours = rangeHours(range)` (`Overview.tsx:114-119`) resolves the ES date-math range (`resolveRange`) to a whole-hour count (min 1), used as the single window for `listCases`/`getMetrics`/`usageSummary`/`usePosture`. `ragStats` is NOT window-scoped.
- `navWindow = hours` is carried on every drill-through `navigate('cases', { …, window: navWindow })` call so the destination Cases list matches the dashboard's selected range.
- `TimeRangePicker` (`webui/src/soc/components/TimeRangePicker.tsx`) is dependency-free (no moment/@elastic/datemath): 5 relative presets (15m/1h/24h/7d/30d), auto-refresh cadences off/30s/1m/5m via `useAutoRefresh` (pauses on a hidden tab via the Page Visibility API), and a "last refreshed HH:MM" stamp (`lastRefreshedMs`).
- `refreshAll()` is the single tick fired by both the manual refresh button and the auto-refresh interval, re-running `load()` + `reloadPosture()` together.

### Large hero / name card
- No large marketing hero or "name card" — this is the explicit Round-5 change (docstring `:4-6`): the old tall hero band was replaced by the **compact** `<PageHeader variant="hero">` (~64-80px: icon chip + `text-2xl` title + one-line description + optional SLA pill), sitting directly above the control bar. `PageHeader`'s hero variant (`webui/src/soc/components/PageHeader.tsx:113,133-141`) adds only a rounded card border + a decorative `bg-hero-glow` wash (`aria-hidden`), `p-6` padding — nothing resembling a full hero/name-card treatment remains on this page.

### Notable security/architecture invariants embedded in the file
- Explicit `#9` note (`:22-24`): every label/value on this page is a humanized enum, formatted number, or backend text rendered as plain text — no `dangerouslySetInnerHTML` anywhere.
- Explicit `#3` note (`:26-27` and the "Autonomous vs human" footnote, `:918-921`): nothing on this dashboard feeds `decide()`; it is read-only telemetry over the deterministic case manager's output.


---


<!-- ===== [5] RiskGauge + Active Risk Index ===== -->

## Active Risk Index / RiskGauge — current-state reference

### Component: `RiskGauge`
`webui/src/soc/components/RiskGauge.tsx:1-172` — a presentational half-circle SVG gauge. No data fetching, no derivation logic; purely renders whatever `score` it is given.

**Props** (`RiskGaugeProps`, line 5-13):
- `score: number` — 0-100, clamped client-side (`Math.max(0, Math.min(100, ...))`, line 63; `NaN`/non-finite → 0).
- `label?: string` — optional plain-text caption rendered under the band word (line 159-163) and folded into the SVG `<title>` (line 92-95, e.g. `"Weighted risk pressure: 62 of 100 (High)"`).
- `size?: number` — pixel width, default `160`. Stroke width, radius, font sizes all scale off `size`.
- `className?: string`.

**Banding**: delegates to `scoreBand()` in `webui/src/soc/components/palette.ts:224-227` — the canonical 0-100 ladder: `low` 0-21, `medium` 22-47, `high` 48-73, `critical` 74-100 (constants at palette.ts:216, 234-236). Band drives both the arc's `text-*`/`stroke-*` colour class (`TEXT_CLASS`, RiskGauge.tsx:23-28) and the text band word (`BAND_LABEL`, line 36-41) — non-color signaling per a11y §6.1.

**A11y/help affordance built into the gauge itself**: an SVG `<title>` (line 92-95) gives assistive tech `"<label>: <score> of 100 (<Band>)"`. This is the ONLY built-in "help" — there is no `?`/HelpTip control on `RiskGauge` itself; any tooltip has to be added by the caller.

### Two distinct "Active Risk Index" numbers exist today (naming collision)

**1. Overview dashboard tile** — `webui/src/soc/pages/Overview.tsx`
- Rendered at line 708-711 inside `<DashboardGroup title="Active Risk Index" description="weighted pressure">` → `<RiskGauge score={riskIndex} size={200} label="Weighted risk pressure" />`.
- `riskIndex` is a **client-side derived** `useMemo` (lines 397-408):
  ```
  avg = metrics.avg_risk_score>0 ? metrics.avg_risk_score : mean(cases[].risk_score)
  criticalDensity = derived.critical / (cases.length || 1)
  score = avg*0.7 + criticalDensity*100*0.3
  ```
  clamped/rounded 0-100 (line 407).
- Inputs: `metrics` from `GET /api/metrics?window_hours=<hours>` (`api.getMetrics`, `webui/src/lib/api.ts:1012-1013`), and `cases` from `GET /api/cases?limit=200&from=now-<hours>h` (`api.listCases`, api.ts:1017-1018), both loaded in `load()` (Overview.tsx:196-224).
- **Time-window subtlety**: `avg_risk_score` from `/api/metrics` is computed server-side over up to 2000 cases with **no time filter** (see backend below) — effectively all-time — while `derived.critical`/`cases.length` (the critical-density term) come from the **windowed** `listCases` call. The blended `riskIndex` therefore mixes an all-time average with a windowed critical-density term. Overview.tsx:185-187 comments acknowledge `total_cases` is intentionally all-time but the `avg_risk_score` half of this blend is not separately called out.
- **No tooltip/HelpTip** on this tile — `DashboardGroup`'s `description` prop (`"weighted pressure"`, DashboardGroup.tsx:38) is a static plain-text sub-line, not an interactive tooltip (`DashboardGroup.tsx:32-51` has no help/tooltip prop at all).

**2. Custom-dashboard widget "Active risk index"** — `webui/src/soc/dashboard/widgets/risk.tsx` (`RiskGaugeWidget`), registered in `webui/src/soc/dashboard/registry.ts:253-263` as `type: 'gauge.active_risk'`, `title: 'Active risk index'`, `description: 'The mean case risk score as a gauge.'`.
- Uses the **raw server `avg_risk_score`** directly (risk.tsx:17-19, `statNumber(data?.avg_risk_score)`) — a straight mean, with **no critical-density weighting** — via the shared dashboard data provider's `metrics` source (ultimately the same `GET /api/metrics` call, fetched once and shared, `useDashboardSource('metrics')`).
- Renders `<RiskGauge score={score ?? 0} label="mean case risk" />` (risk.tsx:33).
- So this widget computes a **materially different number** than the Overview tile despite the same display name — a concrete inconsistency for the overhaul to reconcile or clearly differentiate.

### Server-side source: `GET /api/metrics`
`backend/app/api/routes.py:1324-1332`, query param `window_hours: int = 24` (only used to scope the `cost` sub-block, line 1329). `avg_risk_score` itself comes from `compute_metrics(cases)` (`backend/app/engine/metrics.py:111-158`) over `state.cases.list(limit=2000)` (routes.py:1326) — **not time-filtered**:
```python
risks = [c.risk_score for c in cases if isinstance(c.risk_score, (int, float))]
avg_risk = round(sum(risks) / len(risks), 1) if risks else 0.0   # metrics.py:122-123
```
Returned as `"avg_risk_score": avg_risk` (metrics.py:157). Typed in `webui/src/lib/types.ts:1862` (`avg_risk_score: number` on `Metrics`).

### Per-case usage (different metric, same component): `CaseTriageHeader`
`webui/src/soc/components/CaseTriageHeader.tsx` — the case-detail "Risk" chip (`RiskCard`, lines 239-270) also renders a `RiskGauge` (`score={score}` from `risk.value`, `size={108}`, line 262) but this score is `case.risk_score` — the **deterministic engine risk score**, unrelated to the Overview blend:
- Computed by `compute_risk()` in `backend/app/engine/risk.py:53+` — weighted 0-100 blend of Reputation 30%, Volume 25%, Velocity 20%, Diversity 15%, Asset criticality 10% (weights configurable via `prefs.risk_weights`).
- Surfaced via `GET /api/cases/{case_id}/triage` (`backend/app/api/routes_triage.py:133-146`) → `derive_triage()` (`backend/app/engine/priority.py:261+`, risk chip built at lines 274-278): `value = round(case.risk_score, 2)`, `band` from the same `scoreBand`-equivalent ladder, `breakdown = case.risk_breakdown`.
- **This one DOES have a tooltip**: `<HelpTip text={help} label="What risk means" />` (CaseTriageHeader.tsx:258) where `help = risk.inputs?.definition || RISK_HELP_TEXT`, and `RISK_HELP_TEXT` (CaseTriageHeader.tsx:157-160) reads: *"Deterministic 0-100 risk score — a weighted blend of 5 factors: Reputation 30% (heaviest), Volume 25%, Velocity 20%, Diversity 15%, Asset criticality 10%. It only RANKS what an analyst looks at first; it never closes or escalates a case on its own."* Severity/Impact/Priority chips beside it get similar `HelpTip`s (lines 258, 286-287 etc., component `webui/src/soc/components/HelpTip.tsx`).
- `#3` note baked into the docstring (routes_triage.py:16-19, priority.py:9-11): this score/band is presentation/ordering only and is never fed to `case_manager.decide()`.

### All `RiskGauge` render sites (complete list)
1. `webui/src/soc/pages/Overview.tsx:711` — "Active Risk Index" dashboard tile (`riskIndex`, size 200, no HelpTip).
2. `webui/src/soc/dashboard/widgets/risk.tsx:33` — custom-dashboard "Active risk index" widget (`avg_risk_score` raw mean, no explicit size → default 160, no HelpTip).
3. `webui/src/soc/components/CaseTriageHeader.tsx:262` — per-case "Risk" triage chip (`case.risk_score`, size 108, **has** a `HelpTip`).

### Summary of the gap for the overhaul
- `RiskGauge` itself has no tooltip/help affordance — any explanatory UI is added per call-site, inconsistently: the per-case Risk chip has a `HelpTip`; the two "Active Risk Index" dashboard surfaces do not.
- Two different numbers share the label "Active risk index"/"Active Risk Index": Overview's client-blended `avg*0.7 + criticalDensity*0.3` vs. the custom-dashboard widget's plain server `avg_risk_score` mean. Neither currently explains its formula to the user in-UI.
- The Overview blend also silently mixes an all-time server average with a windowed case sample for the critical-density term.


---


<!-- ===== [6] Metrics / posture page + MTTD/MTTR ===== -->

## MTTA / MTTR / MTTD / dwell — current-state reference (Testing branch)

### Data contract: `GET /api/metrics/posture`

**Route:** `backend/app/api/routes_metrics.py:62-83` — `GET /api/metrics/posture?window_hours=24&compare=` (auth: `require_permission("metrics","view")`). Calls `posture_metrics()` in `backend/app/engine/metrics.py:497-570`, which is pure/deterministic and **never** read by `case_manager.decide()` (#3).

Response shape (`posture_metrics`, `backend/app/engine/metrics.py:524-535`):
```
{ window_hours, generated_at, case_count, lifecycle, quality, aging, sla,
  truncated, store_total, fetched,        # from truncation_marker() — NOT in the TS type, NOT rendered anywhere
  compare?  }                              # only when ?compare=prev&window_hours>0
```
`lifecycle` = `lifecycle_intervals()` (`engine/metrics.py:206-245`), a `_stat_block` per metric:
```
mtta_minutes: StatBlock, mttr_minutes: StatBlock, dwell_minutes: StatBlock
```
`StatBlock` (`engine/metrics.py:66-82`): `{p50, p90, mean, max, count, available, reason}`. When `count==0` the four numeric fields are the literal dash string `"—"` (`DASH`, `engine/metrics.py:23`, also `webui/src/lib/format.ts:12`) and `available=false` with a human `reason` — **never a fake 0**.

TS mirror: `webui/src/soc/pages/Metrics.posture.api.ts` — `StatBlock` (17-28), `PostureLifecycle` (30-34), `PostureResponse` (121-130). The TS `PostureResponse` interface **omits** `truncated`/`store_total`/`fetched` — those backend fields are silently dropped client-side; the UI never tells the user a posture rollup was computed over a partial (newest-5000) case set.

### Formulas (backend, `engine/metrics.py:174-245`) — no MTTD field exists anywhere

There is **no `mttd` field, endpoint, or computation in the backend**. `grep -rn "MTTD\|mttd" backend/app` returns nothing. The only three lifecycle stats the server computes are:

- **`mtta_minutes`** ("MTTA" / time-to-acknowledge): `created → first ACK transition` where ACK = `case.acknowledged_at` anchor, else the first `status_history` transition into `{INVESTIGATING, ESCALATED, ON_HOLD}` (`_ACK_STATUSES`, line 177-179). Missing reason: `"no case has been acknowledged yet"`.
- **`mttr_minutes`** ("MTTR" / time-to-resolve): `created → first terminal transition` (RESOLVED/CLOSED, `_TERMINAL`), or `updated_at` if already terminal with no recorded transition. Missing reason: `"no case has been resolved/closed yet"`.
- **`dwell_minutes`** (docstring: **"time-to-first-response"**): `created → first RESPONSE transition` where RESPONSE = `case.first_response_at` anchor, else first transition into `{INVESTIGATING, ESCALATED, ON_HOLD, RESOLVED, CLOSED}` (`_RESPONSE_STATUSES`, line 180-185). Missing reason: `"no case has received a first response yet"`.

`start` = `case.detected_at` if set, else `created_at` (`_created_dt`, line 201-203). All percentiles use a dependency-free linear-interpolation `percentile()` (line 47-63); p50/p90/mean/max are rounded to 1 decimal.

Period-over-period `compare` block (only when `compare=prev`, `engine/metrics.py:537-568`) includes `mtta_p50` and `mttr_p50` `CompareBlock`s (`{value, prev, delta_pct}`, `_compare_block`/`_delta_pct` line 466-477: `delta_pct = round(100*(curr-prev)/prev, 1)`; `null` = "new growth" when prev was 0 and curr isn't; `DASH` when either side is non-numeric). **There is no `dwell_p50` compare block** — dwell is never compared period-over-period, backend or UI.

### Display — Metrics page (`webui/src/soc/pages/Metrics.tsx`), Performance tab (`PerformanceTab`, lines 877-1020)

1. **Lifecycle timing KPI tiles** (lines 910-953), section heading `"Lifecycle timing ({windowLabel})"`. Three `KpiTile`s built from `lifecycleTiles` (910-923), each `goodDirection="down"` (lower is better):
   - label **`"MTTA (p50)"`**, icon `Clock`, accent `info`, `cmp: 'mtta_p50'` → delta badge wired.
   - label **`"MTTR (p50)"`**, icon `Timer`, accent `success`, `cmp: 'mttr_p50'` → delta badge wired.
   - label **`"Dwell (p50)"`**, icon `Activity`, accent `medium`, **no `cmp` key** → delta never shown (`dv = {show:false,label:''}` when `t.cmp` is undefined, line 934).
   Value/sub come from `statBlockTile()` (1022-1031): value = `humanizeMins(block.p50)` (imported as `humanizeMinutes` from `posture.format.ts`) or `DASH` when unavailable; sub = `"${count} samples"` or the backend `reason` string.

2. **Percentile distribution cards** (lines 955-965), section heading `"Percentile distribution"`. Three `PercentileCard`s (1033-1065), each a `ChartCard` rendering a `p50/p90/mean/max` `<dl>` grid (all via `humanizeMins`):
   - title **`"Time to acknowledge"`** → `lifecycle.mtta_minutes`.
   - title **`"Time to resolve"`** → `lifecycle.mttr_minutes`.
   - title **`"Time to first response"`** → `lifecycle.dwell_minutes` (this label is the one place the UI matches the backend's own semantics for dwell).
   When `!block.available`, renders `ChartEmpty` with `block.reason || 'No samples yet.'`.

3. No `HelpTip`/tooltip/`title=` attribute exists anywhere near these tiles (`grep` for `HelpTip|Tooltip` in `Metrics.tsx` returns none) — the only "explanation" is the `reason` string shown when a stat is unavailable, plus one static footnote (line 1012-1017, shown only when `compare` exists): *"Deltas compare the last {windowLabel} against the immediately-preceding equal window. A falling FP / escalation / time metric reads as an improvement (green)."*

### Display — Overview page (`webui/src/soc/pages/Overview.tsx`) — a THIRD, conflicting label set

`timing` memo (lines 362-385) builds a 3-tile "Response timing" `DashboardGroup` (heading `"Response timing"`, description `"p50, server-computed"`, `"Detail →"` button routing to `metrics`/`posture` tab), same three server fields, same `goodDirection="down"`, `variant="bar"` `KpiTile`s (942-954), but with **different label strings**:
- **`"MTTD (dwell)"`** → `dwell_minutes` (line 381) — calls the same field "MTTD" here, "Dwell (p50)" in Metrics' KPI strip, and "Time to first response" in Metrics' percentile card. Three different names for one backend field across two pages; none of the three is a true Mean-Time-To-Detect (there is no detection-latency metric in the backend at all).
- **`"MTTA"`** → `mtta_minutes` (382).
- **`"MTTR"`** → `mttr_minutes` (383).
Value = `humanizeMins(b.p50)` or `DASH`; sub = `"p50 · {count} sample(s)"` or the backend `reason`. No tooltip here either.

Note: comments in `webui/src/soc/components/KpiTile.tsx:52` and `StatCard.tsx:28` describe the `bar` variant as "used for MTTD/MTTA/MTTR-style timing metrics" — i.e. the "MTTD" name is baked into shared-component doc comments even though no MTTD metric is ever computed; it is Overview's chosen (inconsistent) alias for dwell/time-to-first-response.

### `posture.format.ts` helpers consumed by both pages (`webui/src/soc/pages/posture.format.ts`)
- `isNum` (17-19), `humanizeMinutes` (25-36, DASH-safe "Xd Yh"/"Xh Ym"/"Xm"/"<1m"), `ratioPct` (39-43, 0..1→whole-%), `statP50Duration` (46-49, unused by Metrics.tsx which inlines the same logic via `statBlockTile`), `deltaView` (73-85: number→signed `"+N%"`/`"-N%"`; `null`→`{label:'new', show:true, value:undefined}`; DASH/undefined→`{show:false}`), `compareValue` (88-94, unused in Metrics.tsx/Overview.tsx as searched). Metrics.tsx imports `humanizeMinutes` aliased as `humanizeMins` (line 91) alongside its own **local** `humanizeMinutes()` (114-125, near-duplicate logic, used only for the Operational-tab `data.mttr_minutes`/`fb.time_saved_minutes` from the plain `/api/metrics` endpoint, not the posture rollup) — two parallel minute-humanizers coexist in the same file.

### Summary of overhaul-relevant findings
1. **No MTTD exists** in the backend at all (`grep` confirms zero hits); `dwell_minutes` is the closest concept but is documented server-side as time-to-first-response, not time-to-detect.
2. **The same `dwell_minutes` field has three different display names**: `"Dwell (p50)"` (Metrics KPI tile), `"Time to first response"` (Metrics percentile card, matches backend semantics), `"MTTD (dwell)"` (Overview) — a naming inconsistency an overhaul should reconcile to one term.
3. **No tooltips/HelpTips explain the formulas anywhere** in the UI; the only in-product context is the `reason` DASH-string and one static delta-interpretation footnote on the Performance tab.
4. **Dwell has no period-over-period delta** (backend never computes `dwell_p50` in `compare`; Metrics.tsx's `lifecycleTiles` entry for dwell has no `cmp` key), so its KPI tile never shows a trend arrow while MTTA/MTTR do.
5. **`truncated`/`store_total`/`fetched`** (partial-rollup provenance) are computed server-side but dropped by the TS `PostureResponse` type and never surfaced in either page — a 5000-case-cap truncation is currently invisible to the user.


---


<!-- ===== [7] CaseDetail full current structure ===== -->

## CaseDetail current-state reference (Testing branch, 2026-07-05)

### 1. File map (Coupling-D split — orchestrator + panels)

| File | Lines | Role |
|---|---|---|
| `webui/src/soc/pages/CaseDetail.tsx` | 1648 | Orchestrator: fetch/lazy-load/mutation state, header, tab shell, footer, dialogs. No business logic of its own beyond wiring. |
| `webui/src/soc/pages/casedetail/OverviewPanel.tsx` | 868 | "Overview" tab body |
| `webui/src/soc/pages/casedetail/WhyPanel.tsx` | 332 | "Why" tab body |
| `webui/src/soc/pages/casedetail/ThreatContextPanel.tsx` | 398 | "Threat context" tab body |
| `webui/src/soc/pages/casedetail/StageTimeline.tsx` | 260 | "Timeline" tab body |
| `webui/src/soc/components/TraceTimeline.tsx` | 372 | "Trace" tab body |
| `webui/src/soc/pages/casedetail/CollaborationPanel.tsx` | 306 | "Collaboration" tab body |
| `webui/src/soc/pages/casedetail/FeedbackPanel.tsx` | 373 | "Feedback" tab body |
| `webui/src/soc/pages/casedetail/CaseChatPanel.tsx` | 177 | "Chat" tab body |
| `webui/src/soc/pages/casedetail/shared.tsx` | 531 | Action model (`ALL_ACTIONS`, `actionPlanForStatus`), tone maps, `PanelCard`/`SectionHeading`/`HeadlinePanel`/`MetaItem`/`TagInput` |
| `webui/src/soc/pages/casedetail/ConfirmActionDialog.tsx` | 245 | The one polymorphic lifecycle-action dialog |
| `webui/src/soc/pages/CaseDetail.api.ts` | 387 | Typed client for triage/timeline/stages/thread/tasks/activity/users |

Contract (frozen, `CaseDetail.tsx:20`): `CaseDetail({ caseId, onClose, onNavigate? })`. Renders inside a right-side `Sheet` (`side="right" size="full" className="w-full max-w-[min(96vw,1180px)] p-0"`, `CaseDetail.tsx:933-937`) — i.e. a near-full-width slide-over, not a routed page.

### 2. Header (`CaseDetail.tsx:941-1288`)

Row 1: shield icon, `case_number || case_id` (mono, `text-primary`), `DemoBadge`, title (`c.title || c.case_id`).
Row 2 (badges): `StatusBadge`, `DispositionBadge`, an `L{n}` escalation `Badge` (conditional), `CampaignChip` (conditional, `#51`, deep-links to `campaigns` via `onNavigate`).
Row 3: `Created {age}` · `Updated {age}` (from `c.created_at`/`updated_at`).

Header icon-button cluster (all icon-only + Tooltip, right side, `pr-8` to clear the built-in Sheet close X):
1. **Reinvestigate** (`Zap`, Popover) — model picker (`Select`, defaults to "Use configured model"), warns "Costs tokens and overwrites the verdict … Last run cost {fmtMoney}". Calls `api.reinvestigateCase(id, {model?})` → `POST /api/cases/{id}/reinvestigate`.
2. **Run a playbook** (`BookOpen`, Popover, gated `<Can resource="playbooks" action="run">`) — playbook `Select` from `api.getPlaybooks()`; explicitly states "can only recommend — the close/escalate decision is still made by deterministic code." Calls `api.cases.runPlaybook(id, pid)` → `POST /api/cases/{id}/run-playbook`.
3. **Refresh** (`RefreshCw`) → `loadCase()` → `GET /api/cases/{id}`.
4. **Ask about this case** (`MessageSquare`) → just sets `tab='chat'` (no fetch).
5. **History** (`History`) → sets `tab='trace'`.
6. **Export** (`Download`, DropdownMenu: JSON / Markdown report) → `api.exportCase(id, fmt)` → `GET /api/cases/{id}/export?format=`.
7. **Notify** (`Send`, gated `<Can resource="cases" action="write">`) → opens a separate Dialog (channel `Select`, "All enabled channels" or one), `api.cases.notify(id, channelId?)` → `POST /api/cases/{id}/notify`. Explicitly "fire-and-forget and never changes the case."

Comment at `CaseDetail.tsx:1281-1286` explicitly forbids adding a second header "X" — the Sheet's own close X is the only dismiss up there; the labeled "Close case" lifecycle button lives only in the footer.

### 3. Tabs (`CaseDetail.tsx:1328-1352`), in DOM order

`overview` (FileText, "Overview") · `timeline` (ListTree, "Timeline") · `why` (Brain, "Why") · `threat` (Globe, "Threat context") · `trace` (GitBranch, "Trace") · `collab` (Users, "Collaboration") · `feedback` (Star, "Feedback") · `chat` (MessageSquare, "Chat") — **8 top-level tabs**, single row `TabsList`.

Loading model: `overview`'s triage chips load eagerly on open (`loadTriage`, `CaseDetail.tsx:324-340`); every other tab (`timeline`/`why`/`threat`/`trace`/`collab`) is fetched lazily the first time it's selected, guarded by a `data===null && !loading && !error` effect per tab (e.g. `CaseDetail.tsx:396-400` for trace, `:418-422` timeline, `:650-654` why, `:671-675` threat, `:492-513` collab). `feedback` and `chat` have no separate fetch — they read off the already-loaded `Case` object.

### 4. Per-tab panel breakdown (source order)

**Overview** (`OverviewPanel.tsx`, endpoint: none of its own — reads `c: Case` + `triage: TriageChips` from `GET /api/cases/{id}/triage`), all wrapped in one scroll container, `space-y-6 p-6`:
1. Run-meta strip (`:548-554`) — Started / Completed / Trigger (first `rule_ids[0]`) / Profile (playbook_id or persona).
2. `CaseTriageHeader` (`:557`) — the **4 triage chips**: Risk (RiskGauge + 5-factor mini bars: Volume/Velocity/Reputation/Diversity/Asset), Severity (SIEM-asserted vs "derived"), Impact (asset criticality), Priority (ITIL Impact×Urgency P1-P4). From `GET /api/cases/{id}/triage`.
3. Headline row (`:561-564`) — 2 `HeadlinePanel`s: Verdict, Confidence (word labels, not badges).
4. Secondary badge row (`:567-595`) — `VerdictBadge`, `StatusBadge`, `DispositionBadge`, escalation badge, `RiskBadge`, `ConfidenceBadge`, source badge, persona badge. **This duplicates the verdict/confidence/risk already shown in items 2-3 above, as precise badges.**
5. "Incident Digest" `PanelCard` (`:598-616`) — `trigger_reason.sentence` + `c.summary`.
6. Auto-close-policy `Alert` (`:618-624`, conditional on `fpPolicy`) — a computed sentence about FP auto-close eligibility.
7. "Affected Assets" + "IOC Indicators" `PanelCard`s, 2-col grid (`:627-695`) — entity KV rows + enrichment scalars; evidence `query`s (es_query search strings) + `reproduce_query`, each in `<CodeBlock>`.
8. "Evidence Findings" (`:698-764`) — one `PanelCard` per `Evidence` item (subject/query/conclusion), heuristically split from...
9. "Ruled out / Checked & clean" `PanelCard` (`:767-787`) — evidence whose summary matches a `RULED_OUT_RE` regex (`:76-81`).
10. "Recommended action" + "Risk breakdown" `PanelCard`s, 2-col grid (`:790-819`) — `c.recommended_action` text, and `RiskFactorBars` over `c.risk_breakdown` (Volume/Velocity/Reputation/Diversity/Asset). **This is the SAME risk_breakdown data as chip #2's mini bars, rendered a second time, full-size, further down the same tab.**
11. `BaselineAdvisory` (`:822`, conditional, fail-quiet) — embeds `BaselineSignatureCard` (anomaly-baseline warm-up/percentiles) when `c.cluster_signature` has recorded baseline stats.
12. "MITRE ATT&CK techniques" `PanelCard` (`:825-838`, conditional on `c.mitre.length`) — badge chips only, no links/tactics/descriptions here.
13. `RelatedCrossSource` (`:841`) — "Related cases" (`c.related_case_ids`, titles best-effort fetched via `api.listCases`) + "Source breakdown" (`c.source_breakdown`), 2-col grid, conditional on any cross-source data.
14. `AutomationApplied` (`:844`, conditional on `c.automation_actions`) — threshold-automation actions taken (tag/recommend/notify/run_playbook/request_approval), explicitly "non-binding."
15. `StatusTimeline` (`:847`) — append-only lifecycle trail from `c.status_history` (from/to status + by/reason/age).
16. Footer meta line (`:850-854`) — Created / Token cost / Decided by.
17. Investigation-error `Alert` (`:856-863`, conditional on `c.error`).

→ **Up to 17 distinct sections on one tab** (several conditional, but ~11 render on a typical closed/investigated case). This is the single most cluttered tab.

**Timeline** (`StageTimeline.tsx`, `GET /api/cases/{id}/stages`): a 6-stage vertical narrative — `input → correlate → risk → triage → investigate → decide` (`STAGE_META`, `:60-67`). Each stage: label + `deterministic` badge (for correlate/risk/decide) + state chips (severity w/ SIEM-vs-derived source tag, risk score, verdict, confidence) + a collapsible list of `StageStep`s. A step with `trusted:false` renders only inside `<CodeBlock>` (labeled "untrusted"); trusted steps render as `<Markdown>` prose, clamped at 320 chars with "Show more."

**Why** (`WhyPanel.tsx`, `GET /api/cases/{id}/rationale`): 5-7 `PanelCard`s in order — (1) "Decision" (verdict/status/confidence badges + "Decided by" + an `Alert` with the exact `decision_rationale` string, explicitly framed as deterministic, not LLM); (2) "Agent reasoning" (free-text `r.reasoning`); (3) "Knowledge used" (RAG/runbook/playbook snippets, each in `<CodeBlock>`); (4) "Commands the agent ran" (tool name + query in `<CodeBlock>` + summary); (5) "Operator memory applied" (conditional); (6) "Enrichment" + "Playbook" 2-col grid (conditional); (7) "MITRE ATT&CK techniques" badges (conditional). **MITRE is now shown a 2nd time (Overview showed it too); enrichment overlaps Overview's "Affected Assets."**

**Threat context** (`ThreatContextPanel.tsx`, `GET /api/cases/{id}/threat-context`, gate: `panel?.disabled` → empty state): "Threat summary" banner (deterministic prose from `engine/threat_context.py`, + Verdict/Risk badges + "assembled {age}"), "IOC reputation" (indicator/type/score/malicious/country/source rows), "MITRE ATT&CK techniques" (**a 3rd rendering of MITRE**, this time WITH clickable `attack.mitre.org` links + tactics + descriptions — richer than the other two), "Related cases" (**a 2nd rendering of related cases**, same `related_case_ids`-derived concept as Overview's `RelatedCrossSource`, separately fetched), "Asset context" (entity/criticality/attributes), "Evidence" (**a 3rd-ish rendering of evidence**, overlapping Overview's Evidence Findings and Why's "Commands the agent ran").

**Trace** (`TraceTimeline.tsx`, `GET /api/cases/{id}/timeline`): run-totals header (step/tool counts, cost, tokens, "Deterministic decision recorded" badge) + a `ReactStep`/`DecisionStep` list. `ReactStep` kinds: `invoke_agent`/`chat`/`execute_tool`/`decision`; an `execute_tool` (or any `trusted:false`) span's summary is fenced in `<CodeBlock caption="untrusted tool / log payload">` with an "untrusted" badge — the sharpest SIEM-vs-AI separation in the whole page. The terminal `DecisionStep` (`TraceTimeline.tsx:96-198`) is visually distinct (thicker border/accent) and shows the exact `(verdict, confidence, risk_score, policy_clause)` `decide()` used.

**Collaboration** (`CollaborationPanel.tsx`, `GET /api/cases/{id}/thread`+`/tasks`+`/activity`): 2-col grid (`lg:grid-cols-[1fr_20rem]`) — main: "Discussion" (`CaseThread`, threaded human/ai/system messages, reactions, @mentions, live-nudge via SSE); aside stacked: "Ownership" (`AssigneePicker` → `POST /api/cases/{id}/assign`), "Tasks" (`CaseTasks` checklist, `POST/PATCH .../tasks`), "Activity" (`CaseActivityFeed`, merged audit+activity stream).

**Feedback** (`FeedbackPanel.tsx`, no fetch — reads `c.feedback`): ONE `PanelCard`, "Rate the AI decision" — assessment 3-way (Agree/Partially/Disagree), 3 star ratings (Accuracy/Reasoning quality/Action appropriateness), "Actual outcome" `Select` (TP/FP/TN/FN), analyst id, time-saved `LabeledSlider`, comment, Submit → `api.caseFeedback` → `POST /api/cases/{id}/feedback`; then a "Previous gradings" list. File header comment is explicit: ownership + discussion live on Collaboration, **not** duplicated here.

**Chat** (`CaseChatPanel.tsx`, no persisted fetch — local `history` state only): starter-prompt chips, transcript, composer; `api.chat(message, history, c.case_id)` → `POST /api/chat`; "Open full chat" button deep-links to the standalone Chat page (`onNavigate('chat', {caseId})`).

### 5. Footer / close+lifecycle controls (`CaseDetail.tsx:1449-1546`, model in `shared.tsx`)

The **only** place case-closing lives is the persistent footer, visible regardless of active tab:
- Left: "Dismiss" (ghost, just calls `onClose()` — does not touch the case).
- Right, in order: overflow **"More"** `DropdownMenu` (the non-primary, non-close actions for the current status) → unified **"Close case"** button (`close_disposition`, secondary unless it's the state's primary) → the single filled **primary CTA** (context-dependent).

`actionPlanForStatus(status)` (`shared.tsx:269-318`) computes `{primary, close, overflow}` per status: `new`→primary=Acknowledge, close=close_disposition, overflow=[Escalate,Resolve,Hold]; working (open/investigating/needs_human)→primary=Escalate, overflow=[Acknowledge,Resolve,Hold]; `on_hold`→primary=Resume, overflow=[Resolve,Escalate]; `escalated`→primary=Resolve, overflow=[De-escalate,Hold]; `resolved`→primary IS close_disposition (no separate secondary), overflow=[Reopen]; `closed`/`auto_closed`→primary=Reopen, overflow=[Set disposition], **no close** offered (terminal).

All 11 `ActionKind`s live in `ALL_ACTIONS` (`shared.tsx:107-231`): `close`, `confirm_fp`, `escalate`, `deescalate`, `reopen`, `acknowledge`, `hold`, `resume`, `resolve`, `set_disposition`, `close_disposition` (UI-only, `wireAction:'close'`). Every button is `<Can>`-gated via `ACTION_PERMISSION` (`cases:close` for close-class, `cases:write` otherwise). Selecting any action opens the ONE polymorphic `ConfirmActionDialog.tsx`, whose visible fields are driven by `ActionDef.fields` (`disposition`/`resolution`/`tags`/`assignee`/`priority`/`reason`, plus an always-present free-text note); submit POSTs `pending.wireAction ?? pending.key` via `api.caseActionExec(id, input)` → `POST /api/cases/{id}/action`. The **AI-decision feedback/grading** (agree/disagree, stars) is a completely separate control surface (the Feedback tab) that never touches status/verdict/disposition.

### 6. Clutter / redundancy findings (relevant to items #9/#10/#11)

- **8 tabs total**, Overview alone carries up to **17 stacked sections** — by far the densest single screen in the app.
- **MITRE ATT&CK techniques renders 3 times** across tabs (Overview badges-only; Why badges-only; Threat context with links+tactics+descriptions) — always the same `c.mitre`/`panel.mitre_techniques`, no cross-links between the three renderings.
- **Risk breakdown renders 2 times within the same Overview tab**: once as compact bars inside the Risk triage chip (`CaseTriageHeader`→`RiskCard`→`RiskBreakdownBars`), and again as a full-width "Risk breakdown" `PanelCard` (`RiskFactorBars`) further down — identical 5-factor data (Volume/Velocity/Reputation/Diversity/Asset), two different bar components.
- **Related cases renders 2 times** (Overview's `RelatedCrossSource` and Threat context's "Related cases" section) from the same `related_case_ids`, each with its own independent best-effort title-fetch.
- **Evidence/queries render in 3 places** with overlapping intent: Overview "Evidence Findings"/"IOC Indicators", Why "Commands the agent ran"/"Knowledge used", Threat context "Evidence" — all showing es_query strings + summaries, differently grouped.
- **Verdict/Confidence appear in ≥5 places**: Overview headline panels, Overview secondary badges, Why's Decision card, Threat context banner, Trace's terminal Decision step.
- Header carries **7 icon-only actions** (Reinvestigate/Run playbook/Refresh/Chat/History/Export/Notify) with only Tooltips for labels — no text labels, high a11y/discoverability burden for a first-time user.
- Footer mixes **3 tiers of action weight** (ghost Dismiss, outline overflow-menu-launcher, outline Close, filled primary) plus per-status RBAC gating — functionally sound (explicitly designed to replace an "equally-weighted button row," per the file's own header comment) but still a lot for one thin bar to communicate.

### 7. SIEM/log-derived (untrusted) vs deterministic vs AI-derived — where each shows up

- **Deterministic (engine-computed, never LLM)**: risk_score + risk_breakdown (`engine/risk.py`) — Overview chip + Overview panel; the 4 triage chips (`engine/priority.py`) — Overview only; `status`/`status_history`/`disposition`/`decision_by`/`decision_rationale` (`engine/case_manager.decide()`) — Overview footer-meta + status timeline, Why's "Decision" card, Trace's `DecisionStep` (all three independently surface the SAME deterministic clause); `automation_actions` (`engine/threshold_automation.py`) — Overview only; campaign membership (`engine/campaigns.py`) — header chip only; baseline signature (`engine/baseline.py`) — Overview `BaselineAdvisory` only; threat-context summary/IOC-reputation/asset-context (`engine/threat_context.py`, enrichment-backed) — Threat context tab only.
- **AI-derived**: `verdict`, `confidence`, `summary`, `recommended_action`, `reasoning`, playbook-selection reason, evidence "conclusions," agent_persona choice, knowledge-retrieval rationale — concentrated in Overview (headline/digest/evidence/recommended-action) and Why (reasoning/knowledge/tools), spot-repeated as badges elsewhere.
- **Raw SIEM/log-derived (UNTRUSTED, #9-fenced)**: `title`, `entity.value`, `rule_ids`, `source_name`/`source_id`, evidence `query`/`summary`, enrichment KV scalars, IOC `indicator`/`country`, tool `payload_ref`/execute_tool spans, thread bodies, task titles, activity summaries, tags, assignee strings — rendered as plain text nodes or inside `<CodeBlock>` throughout every tab; the **only** place this trust boundary is made visually explicit to the analyst is Trace (`untrusted` badge + fenced CodeBlock per non-trusted span) and Timeline (`Lock` icon + "untrusted" label per non-trusted step) — Overview/Why/Threat-context render untrusted and trusted text with the *same* plain-text styling, so the boundary is invisible there even though it's still safely fenced in code.

### 8. Endpoint inventory (method + path) used by CaseDetail

`GET /api/cases/{id}` · `POST /api/cases/{id}/action` · `POST /api/cases/{id}/reinvestigate` · `POST /api/cases/{id}/run-playbook` · `GET /api/cases/{id}/threat-context` · `GET /api/cases/{id}/rationale` · `GET /api/cases/{id}/triage` · `GET /api/cases/{id}/timeline` · `GET /api/cases/{id}/stages` · `GET /api/cases/{id}/thread` · `POST /api/cases/{id}/thread` · `PATCH /api/cases/{id}/thread/{msgId}` · `DELETE /api/cases/{id}/thread/{msgId}` · `POST /api/cases/{id}/thread/{msgId}/reactions` · `GET /api/cases/{id}/tasks` · `POST /api/cases/{id}/tasks` · `PATCH /api/cases/{id}/tasks/{tid}` · `POST /api/cases/{id}/tasks/{tid}/log` · `GET /api/cases/{id}/activity` · `POST /api/cases/{id}/assign` · `POST /api/cases/{id}/feedback` · `GET /api/cases/{id}/export?format=` · `POST /api/cases/{id}/notify` · `GET /api/playbooks` · `GET /api/models` · `GET /api/settings` · `GET /api/campaigns/for-case` (via `campaignsApi.forCase`) · `GET /api/users` (via `listPickableUsers`) · `POST /api/chat`.


---


<!-- ===== [8] Cases list page ===== -->

## Cases list — current-state reference (`webui/src/soc/pages/Cases.tsx`)

**Data source.** `GET /api/cases?limit=200` (`api.listCases`, `LIST_LIMIT=200`, Cases.tsx:97,546) — a single capped fetch into client state (`cases`, `total`); no server-side paging/filtering/sorting. All narrowing/sorting/paging below is client-side over the loaded 200. When `total > cases.length` an `Alert` banner says "Showing the first N of M cases" (:1242-1252) and a header pill shows `"N of M"`.

### Columns (`columns: DataTableColumn<Case>[]`, :789-984; order = display order; `sortable`/`width` as coded)
| id | header | sortable | width | renders |
|---|---|---|---|---|
| `case_id` | Case ID | yes | 9.5rem, `lockVisible` | `CaseHoverCard` + button (`case_number \|\| case_id`, mono, opens detail sheet) + `DemoBadge` if `isDemoCase` |
| `title` | Title | yes | auto | `CaseHoverCard` + truncated title (max-w 26rem) |
| `status` | Status | yes | 9rem | `StatusBadge` |
| `disposition` | Disposition | yes | 8rem | `DispositionBadge` |
| `alerts` | Alerts | no | 6.5rem | `CountLink` = `alertCount(c)` (member_event_ids.length or Σ evidence[].event_ids.length), click opens detail |
| `playbooks` | Playbooks | no | 6.5rem | `CountLink` = `playbookCount(c)` (0 or 1, from `c.playbook_id`) |
| `enrichments` | Enrichments | no | 7rem | `CountLink` = `enrichmentCount(c)` (`c.evidence.length`) |
| `category` | Category | yes | 7rem | `CategoryBadge(caseCategory(c))` — `entity_type` or `entity.type`, else "Uncategorized" |
| `severity` | Severity | yes | 7rem | `SeverityBadge(caseSeverity(c))` — source severity or falls back to `risk_score` |
| `severity_ai` | Severity (AI) | yes | 7.5rem | `SeverityBadge(aiSeverity(c))` = `risk_score` directly, or DASH |
| `confidence` | Confidence | yes | 7rem | `ConfidenceBadge(c.confidence)` |
| `verdict` | Verdict | no | 8rem | `VerdictBadge(c.verdict)` |
| `risk` | Risk | no | 6rem | `RiskBadge(c.risk_score)` |
| `urgency` | Urgency | no | 6rem | `UrgencyPill(createdAt, riskScore, status)` — derived, not sortable/filterable |
| `entity` | Entity | no | 11rem | `entity.type: <InlineCode>entity.value</InlineCode>` or DASH |
| `updated_at` | Updated | yes | 7rem | `humanizeAge(updated_at \|\| created_at)` |
| `actions` | Actions | no | 5rem, right-aligned | icon-only `XCircle` Close button — **only rendered when `useCan('cases','close')` is true** (RBAC-mirrored, :960-983) |

Column visibility/order is per-user, persisted via `usePrefs().tableColumns('cases')` / `updateTableColumns` (table id `CASES_TABLE_ID='cases'`), edited through `<ColumnsMenu>` folded into the filter-bar Card (:1234-1238); `case_id` is `lockVisible` (can't be hidden).

### Filters (`CaseFilters`, :169-188; all client-side over `cases`, applied in `applyFilters` :253-301)
- **Search** (`Input`, free text) over: `title, case_id, summary, entity.value, entity.type, caseRules(c), tags, assignee, source_name, cluster_signature` (substring, lowercased).
- **Status** (`Select`) — options built from `buildFacets(cases).statuses` (values actually present), sentinel `ANY='__any__'`; `needs_human` relabeled "Open · awaiting analyst".
- **Disposition** (`Select`, only rendered `if (facets.dispositions.length)`) — same facet-driven pattern.
- **Severity** (`Select`) — fixed list `critical/high/medium/low/info`, matched via the single `severityBand()` authority (palette.ts `scoreBand`) so filter/sort/badge never disagree.
- **Assignee** (`Select`) — facet-driven + `UNASSIGNED='__unassigned__'` sentinel for empty assignee.
- **Time range** (`Popover` button, `Clock` icon) — `all | 24h | 7d | 30d`, filters on `created_at`/`updated_at`.
- **Cross-source** toggle button (`Link2` icon, `aria-pressed`) — `relatedOnly`, true when `related_case_ids.length>0` or `cross_source_cluster_id` set (F6).
- **Clear** button — resets to `EMPTY_FILTERS` and drops any applied saved view.
- Filters self-heal: `healFilters()` (:222-239) drops a selected status/disposition/assignee facet value that no longer exists in the reloaded set, run in a `useEffect` on `facets` change (:582-584), so a filter can never permanently empty the list.
- Filters are seedable from the router (`initialStatus`/`initialSeverity` props, drill-throughs from Overview KPIs) and serializable to/from **Saved Views** (`SavedViewsBar`, scope `CASES_VIEW_SCOPE='cases'`; `filtersToView`/`viewToFilters`, :318-345) plus a sort token (`sortToToken`/`tokenToSort`, e.g. `-updated_at`, :348-358).
- Active-filter count badge logic: `countActiveFilters()` (:303-313); "Clear" disabled when 0.

### Sorting
- Client-side comparator table `sortComparators: Record<SortId, (a,b)=>number>` (:373-388) for `case_id | title | status | disposition | category | severity | severity_ai | confidence | updated_at` — column header clicks (via `DataTable`'s `sortable` + `onSortChange`) set `SortState {id, dir}`, default `{id:'updated_at', dir:'desc'}`.
- `severity` comparator sorts by `SEVERITY_BAND_ORDER.indexOf(severityBand(...))` (info<low<medium<high<critical), not raw numeric value.
- A dedicated header **two-way toggle button** (Sort Asc/Desc icon, label "Newest first"/"Oldest first") flips `updated_at` sort direction directly, independent of column-header sort (:1053-1068).
- No multi-column sort.

### Pagination
- Client-side slicing of `filteredSorted` (`pageRows`, :604-607): `page`, `pageSize` (default 50), `pageSizeOptions={[25,50,100]}` passed to `DataTable`. Page resets to 1 on any filter/pageSize change; clamps down if `page > pageCount`.

### Selection & bulk actions (`BulkActionBar`, :1397-1596)
- `DataTable selectable`, row checkboxes; `selected: string[]` of `case_id`s; auto-pruned when a selected id scrolls out of the filtered/visible set (:632-639).
- Floating bar (portaled to `document.body`, `position: fixed bottom-5`, appears only when `count>0`):
  - **Acknowledge** → `POST /api/cases/bulk` action `acknowledge` (`api.cases.bulk`) — cases:write tier.
  - **Assign** (popover, free-text owner) → per-case `POST /api/cases/{id}/assign` via `runBulkForEach` (status-neutral, NOT the bulk/action endpoint) — cases:assign.
  - **Add tag** (popover) → per-case `POST /api/cases/{id}/tags`, merges with existing tags client-side before posting (status-neutral) — cases:write.
  - **Set status** (`Select`, values `open/investigating/on_hold/escalated` — `BULK_STATUSES`) → `POST /api/cases/bulk` action `set_status`.
  - **Set disposition** (`Select`, values `true_positive/false_positive/benign/suspicious/duplicate` — `BULK_DISPOSITIONS`) → `POST /api/cases/bulk` action `set_disposition`.
  - **Resolve** / **Close** — wrapped in `<Can resource="cases" action="close">` (hidden entirely without the permission) → `POST /api/cases/bulk` actions `resolve`/`close`.
  - **Clear** — empties selection.
  - `runBulk`/`runBulkForEach` both: disable while `bulkBusy`, summarize per-id failures into `bulkError` Alert + `toast` (success/warning/error via `sonner`), clear selection, `reload()` after.
- Per-row **Close** icon button (Actions column, `XCircle`, only when `canClose`) opens a `ConfirmDialog` ("Close this case?") → `confirmClose()` posts `POST /api/cases/{id}/action {action:'close', resolution:'Closed by analyst'}` (`api.caseActionExec`), i.e. the same server-side `decide()`-adjudicated path as bulk close (#3).

### Badges (`webui/src/soc/components/badges.tsx`)
- **SeverityBadge** (:159): normalizes number(0-100, `severityBandFromNumber`, cut points 0-21 low/22-47 medium/48-73 high/74-100 critical, via `scoreBand`) or string alias (`critical/crit, high, medium/med/moderate, low, info/informational/none`) to one of 5 bands; variant from `SEVERITY_COLOR` (palette.ts) → `TOKEN_VARIANT`; renders `SemanticGlyph` (non-color WCAG 1.4.1 icon) + label (`Critical/High/Medium/Low/Info`); optional `showValue` appends `(NN)`.
- **StatusBadge** (:236): variant via `STATUS_COLOR` map else legacy switch (`open/in_progress`→info, `needs_human`→high labeled "Open · awaiting analyst", `auto_closed`→success, `reopened`→warning, `error/failed`→critical, default secondary).
- **DispositionBadge** (:278) / **VerdictBadge** (:314): share the `VERDICT_COLOR` value-space — `true_positive`→critical, `false_positive`/`benign`→info (neutral, not green), `suspicious`→high, `duplicate`/`undetermined`→neutral/secondary; empty/`none` renders "Undetermined"/"Unverdicted" outline badge.
- **ConfidenceBadge** (:346): percent (`fmtPercent`), variant `success` if ≥ threshold (or ≥75% default), else `medium` (or `low` <50%).
- **RiskBadge** (:388): 0-100 score rounded, reuses the same `scoreBand`/`SEVERITY_VARIANT` ladder as severity (never "info" — risk is always a real score); label prefix default "Risk".
- **UrgencyPill** (:575, `rounded-full`): NOT server data — computed client-side from `risk_score + age-bucket bonus(+25 ≥24h/+15 ≥8h/+5 ≥2h) + escalation bonus(+20 if needs_human/escalated)`, closed statuses (`closed/resolved/auto_closed`) render DASH; bands `critical(≥85)/high(≥60)/medium(≥35)/low`.
- Every badge shows a `SemanticGlyph` (Lucide icon keyed off `SEMANTIC_ICON`) beside the color chip — meaning is never color-only.

### Row layout & density
- `DataTable density="compact"` (Cases.tsx:1295) — cell padding `px-4 py-2` (vs `px-4 py-3` at `normal` density; `DataTable.tsx:306`).
- Row click (`onRowClick`) opens the shared `CaseDetail` sheet via `openCaseId` state (not full navigation).
- `loadingRows={8}` skeleton rows while loading; `EmptyState` (compact) for zero-cases vs zero-matching-filters, each with a contextual CTA.
- Page chrome: `PageContainer variant="wide"`, `PageHeader variant="dense"` with breadcrumb `Triage / Cases`, inline `CountPill` row replacing the old 4-tile KPI band (Total/Open/Needs-human/True-positives, computed over the loaded set only, not the filtered view) — G4 density convention.
- Filter bar is a single-row `Card elevation="none"` (no resting shadow, border-first) holding SavedViewsBar + search + 4 selects + time-range popover + cross-source toggle + Clear + a "Showing X of Y (of Z total)" caption + ColumnsMenu — all inline, no separate toolbar row.

### Endpoints touched from this page
- `GET /api/cases?limit=200` — list (`api.listCases`)
- `POST /api/cases/bulk` — bulk lifecycle action (`api.cases.bulk`, body `{...input, ids}}`)
- `POST /api/cases/{id}/action` — single-case lifecycle action (`api.caseActionExec`, used by per-row Close)
- `POST /api/cases/{id}/assign` — bulk-per-case assign (`api.caseAssign`)
- `POST /api/cases/{id}/tags` — bulk-per-case tag (`api.caseTags`)

File: `/Users/ary/Documents/GitHub/Agentic-Kibana/webui/src/soc/pages/Cases.tsx` (1597 lines). Related: `webui/src/soc/components/badges.tsx`, `webui/src/soc/components/palette.ts` (color/icon authority), `webui/src/soc/components/DataTable.tsx`, `webui/src/lib/api.ts` (`API_BASE='/api'`).


---


<!-- ===== [9] Nav sidebar + global search + command palette ===== -->

## Current-state reference: top nav bar, search, and command palette (webui)

### 1. Top bar structure — `webui/src/soc/AppShell.tsx`

The top bar is a `<GlassSurface as="header">` (`AppShell.tsx:527-533`), sticky (`sticky top-0 z-30`), `h-14`, `flex items-center gap-3 border-b border-border px-4`. Two zones:

- **Left: breadcrumb** (`AppShell.tsx:534-540`) — `<nav aria-label="Breadcrumb">` rendering `{productName} / {pageLabel}` as plain text spans (productName from `branding.product_name` / `branding.org_name`, fallback `'ASP'`; pageLabel from `navItem(page)?.label ?? navLabel(page)`). **No search input lives here** — it's a static breadcrumb, not a search box.
- **Right cluster** (`AppShell.tsx:542-632`, `<div className="ml-auto flex items-center gap-2">`), left to right:
  1. **"Search" button** (Cmd-K opener, not a text input) — `AppShell.tsx:544-556`: `<Button variant="outline" size="sm" className="hidden h-8 gap-1.5 text-muted-foreground sm:inline-flex" onClick={() => setPaletteOpen(true)} aria-label="Open command palette">` containing a `CommandIcon` (lucide `Command`), the literal text `"Search"`, and a `<kbd>⌘K</kbd>` hint. It is `hidden` below the `sm` breakpoint (icon-only real estate isn't reserved for it on mobile) and has **no width styling of its own** — it sizes to content (`h-8`, auto width), it is NOT a full text `<input>`.
  2. `NotificationBell` (`onNavigate` prop).
  3. Theme toggle icon button (`Sun`/`Moon`).
  4. Version badge (`v{health.version}`), hidden below `md`.
  5. Health pill → `Popover` (tone-colored pill + help popover).
  6. `UserMenu` (avatar/name/chevron → dropdown: Profile/Security/Sessions/Appearance/Log out), only when `username` is set; preceded by a vertical `Separator` hidden below `sm`.

So: **there is no persistent top-bar text search input** — the only "search" affordance in the header is the button above that opens the `CommandPalette` dialog. The actual free-text query box lives *inside* that dialog (`CommandInput`, see §3).

Keyboard shortcuts wired in `AppShell.tsx:448-462`: `Cmd/Ctrl+K` toggles `paletteOpen`; `Cmd/Ctrl+B` toggles nav collapse (`toggleCollapsed`, also bound to the hamburger `Button` at `AppShell.tsx:465-488`).

Content slot: `<main id="socMain">` → `<div key={page} className="mx-auto w-full min-w-0 px-4 py-6 ... sm:px-6 lg:px-8 2xl:px-12">` (`AppShell.tsx:645-654`) — the single gutter authority; per-page width is capped by `<PageContainer variant>` (the `max-w-[1400px]` cap was removed in Round 5).

### 2. Command palette — `webui/src/soc/components/CommandPalette.tsx`

Built on `cmdk` primitives from `@/ui/command` (`Command`, `CommandInput`, `CommandList`, `CommandEmpty`, `CommandGroup`, `CommandItem`, `CommandSeparator`, `CommandShortcut`), wrapped in `Dialog`/`DialogContent` (`hideClose`, `sm:max-w-xl`, `overflow-hidden p-0`).

- **Mount point**: instantiated once in `AppShell.tsx:657-661` as `<CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} onNavigate={onNavigate} />`.
- **Props**: `{ open: boolean; onOpenChange: (open: boolean) => void; onNavigate: Navigate }`.
- **Query input**: `<CommandInput placeholder="Jump to a page, search cases/sources, run an action…" value={query} onValueChange={setQuery} autoFocus />` (line 237-243). `Command` is run with `shouldFilter={false} loop` (line 236) — cmdk's own fuzzy filter is disabled; server ranking (for remote hits) and a local `localMatch` substring filter (for nav/action items, line 215-221) are authoritative instead.
- **Remote search**: debounced 180ms (`window.setTimeout`, line 140), fires only when `query.trim().length >= 2`, via `api.search(term, 20)` → `GET /api/search?q=&limit=` (`webui/src/lib/api.ts:849-850`). Stale-response guard via an `alive` closure flag.
- **Result groups rendered** (in order): **Recent** (localStorage `tlsoc.cmdk.recents`, max 6, only on empty query) → **Cases** (from `res.cases`, icon `Briefcase`) → **Sources** (from `res.sources`, icon `Database`) → **Actions** (New chat / Toggle theme / Go to Settings / Enable demo mode [admin-only, `hasPermission('settings','manage')`]) → **Settings** (section/card targets from `searchJumpTargets(query, hasPermission)`, sourced from `@/soc/pages/settings/settings-sections-meta`, capped to 8) → **nav groups per `NAV_GROUPS`** (rail groups + their disclosure children, RBAC-filtered, flattened into `{id, label, icon, key}` targets keyed `nav-<id>` for hosts / `navc-<parent>-<id>` for children).
- Note: `SearchResult` (`webui/src/lib/types.ts:1548-1553`) has a `nav: SearchNavHit[]` field returned by the backend, but the component does **not** consume `res.nav` — it independently rebuilds nav targets client-side from `NAV_GROUPS` (registry-derived) instead of the server's static `_NAV_TARGETS` list.
- Selecting any item calls `go(page, label)` (pushes to recents, calls `onNavigate`, closes) or an inline `onSelect` for case/source hits (`onNavigate('cases', {caseId})`, `go('sources', ...)`).
- Security (#9): all case/source/entity text is rendered as plain `<span>` text (cmdk renders children as text) — no markup interpolation.

Backend endpoint: `GET /api/search?q=&limit=` — `backend/app/api/routes_search.py:86-92`, gated `require_permission("cases", "read")`, returns `SearchResponse {query, cases: list[dict], sources: list[dict], nav: list[dict]}` (route module docstring: `routes_search.py:1-19`). Static `_NAV_TARGETS` table lives at `routes_search.py:63-83` (18 hardcoded page/settings entries with `keywords` for matching) — this is the source of the unused `res.nav`.

### 3. Nav-item derivation — registry → nav.ts → NavSidebar/CommandPalette

- **Single source of truth**: `webui/src/soc/registry.tsx` — `export const FEATURES: FeatureNode[]` (line 204-377). Each `FeatureNode`: `{ id: PageId; label; icon?: LucideIcon; group: NavGroupId; perm?: NavPerm; children?: FeatureChild[]; hidden?: boolean; enabled?: (ctx: FeatureCtx) => boolean }`. `hidden: true` entries (e.g. `dashboard`, `investigate`, `cost`, `models`, `standup`, `knowledge`, `memory`, `catalog`, `playbooks`, `account`, `sessions`, `security`, `roles`, `users`, `admin_sessions`) are routable/deep-linkable but excluded from the rendered rail.
- **Groups**: `FEATURE_GROUPS` (line 383-390) fixes rail-group order: `overview → triage → intelligence → analytics → notifications → platform` (`NavGroupId` union, `registry.tsx:104-110`).
- **Visibility**: `featureEnabled(node, ctx)` (`registry.tsx:187-193`) is the one function combining the three axes — RBAC (`ctx.hasPermission`), prefs feature-toggle (`ctx.prefsEnabled`), demo (`ctx.demoActive`) — defaulting to `!node.perm || hasPermission(...)` when no custom `enabled` is supplied.
- **Route table**: also in `registry.tsx` — `ROUTES: Record<PageId, RouteDef>` (line 474-549) maps every `PageId` to a `React.lazy` component + optional `render(ctx)` that supplies route-derived props (tab/status/severity/onRerunWizard); `renderRoute(page, ctx)` (line 555-559) resolves it, falling back to `overview` for unknown ids.
- **`webui/src/soc/nav.ts`** is a thin derivation layer over `registry.tsx` (per its own docstring, `nav.ts:1-24`): re-exports `NAV_GROUPS`, `NAV_ITEMS`, `NAV_CHILDREN`, `PageId`, `PAGE_IDS`, and helpers `navItem`/`navParentOf`/`navLabel`/`isPageId`, all computed from `FEATURES`/`FEATURE_GROUPS` — so nothing that already imports `nav.ts` (NavSidebar, CommandPalette, AppShell, router) needed to change when the registry was introduced (Round-5 W0-F F3).
- **Consumers**: `NavSidebar.tsx` imports `{ NAV_GROUPS, navParentOf, NavChild, NavGroup, NavItem, PageId }` from `../nav` (`NavSidebar.tsx:45-52`) and filters via its own `filterGroups(groups, hasPermission)` (`NavSidebar.tsx:213-227`, perm-only, not the full `featureEnabled` axes). `CommandPalette.tsx` imports `{ NAV_GROUPS, isPageId, PageId }` from `@/soc/nav` (line 50) and independently RBAC-filters (`hasPermission` check per item/child, lines 178-196) to build its nav-jump groups.

### 4. NavSidebar widths/behavior (for overhaul context)

`webui/src/soc/components/NavSidebar.tsx` — one `<aside>` with two width states toggled by the shell hamburger / Cmd-B: **collapsed** `w-16` (64px) icon rail vs **expanded** `w-60` (240px) labelled drawer (`NavSidebar.tsx:613-618`; header comment at top says "~248px" / "64px", CSS classes are `w-16`/`w-60`). Persistence: `useNavPrefs()` hook (exported from this file, `NavSidebar.tsx:109-204`) hydrates synchronously from `localStorage` keys `soc.nav.collapsed` / `soc.nav.openGroups`, then reconciles once from server `UserPrefs.misc[nav_collapsed|nav_open_groups]` via `usePrefs()`, and persists both on every change via `PUT /api/prefs/user` (`api.prefs.putUser({misc: patch})`). Expanded items with children render as WAI-ARIA disclosures (`button[aria-expanded][aria-controls]` + `<ul>`); collapsed items with children render a `position: fixed` fly-out (not a portal) driven by measured rail-button coordinates, shown on hover or focus-within.


---


<!-- ===== [10] Feedback flow (where feedback is collected today) ===== -->

## Feedback / AI-verdict grading — current state (Testing branch)

### Is there a dedicated Feedback tab/page?
Yes, at the case level only (no standalone "Feedback" page/route). `CaseDetail.tsx` renders an 8-tab layout (`overview | timeline | why | threat | trace | collab | feedback | chat`, state var `tab`, `webui/src/soc/pages/CaseDetail.tsx:197`). The **Feedback** tab (`TabsTrigger value="feedback"`, `CaseDetail.tsx:1346-1348`, `Star` icon) renders `<FeedbackTab c={c} onUpdated={(next) => setC(next)} />` (`CaseDetail.tsx:1433-1435`), imported from `webui/src/soc/pages/casedetail/FeedbackPanel.tsx:159` (component exported as `FeedbackTab`, default-exported as `FeedbackTab` too, file named `FeedbackPanel.tsx`). It is available on every case regardless of status (no closed-only gate in the tab list); it is explicitly scoped to grading the AI decision only — ownership (assignee/tags) and the notes thread live on the sibling **Collaboration** tab (`CollaborationThreadTab`), per the file's own header comment (`FeedbackPanel.tsx:1-12`).

There is also a read-only aggregate view: `Metrics.tsx` "Analyst feedback quality" `ChartCard` (`webui/src/soc/pages/Metrics.tsx:707-748`) showing agreement rate, time saved, and accuracy/reasoning/action-appropriateness bars, or an empty-state prompt "Grade closed cases to build accuracy, reasoning and time-saved metrics here" (`Metrics.tsx:747`) when `fb.graded_cases === 0`.

### Where does an analyst grade the AI verdict today?
Only inside `FeedbackTab` (`FeedbackPanel.tsx`), a self-contained form with local `useState`, not wired into the case-close flow:
- **Assessment** — 3-way segmented control `agree | partial | disagree` (`ASSESSMENTS`, `FeedbackPanel.tsx:51-60`), default `'agree'`.
- **Quality stars (optional)** — three `StarRating` 1–5 controls: Accuracy, Reasoning quality, Action appropriateness (`FeedbackPanel.tsx:242-249`); converted to a 0–1 float via `starsToScore` (`FeedbackPanel.tsx:107-110`) before submit.
- **Actual outcome** — `Select` of `true_positive | false_positive | true_negative | false_negative` or "Unknown" (`OUTCOME_OPTIONS`, `FeedbackPanel.tsx:62-67`).
- **Analyst id** (optional free text), **time saved** (`LabeledSlider`, 0–120 min step 5, `FeedbackPanel.tsx:284-295`), **comment** (optional free-text `Textarea`).
- Submit button "Submit grading" (`FeedbackPanel.tsx:314-323`), enabled only when `gradingDirty` (any field touched away from the all-default state, `FeedbackPanel.tsx:182-189`) and not mid-submit; calls `api.caseFeedback(caseId, body)` (`submitFeedback`, `FeedbackPanel.tsx:130-169`), then resets the form and calls `onUpdated(next)` to refresh the parent's case state.
- A "Previous gradings" list below renders `c.feedback` sorted newest-first (`priorFeedback`, `FeedbackPanel.tsx:171-174`); comments render as plain text (`#9` — "UNTRUSTED — plain text", `FeedbackPanel.tsx:356-361`).

This form is entirely separate from the case's lifecycle-action dialog — grading and closing are two independent UI flows today.

### What is captured — `Case.feedback` shape
Backend model `FeedbackEntry` (`backend/app/models.py:367-382`), appended (never edited/removed) to `Case.feedback: list[FeedbackEntry]` (`models.py:1155`, docstring: "Append-only analyst feedback on the AI verdict… aggregated by /api/feedback/stats"):
```python
ts: str                          # iso_now() at submit time
analyst: str = ""
assessment: str = ""             # agree | partial | disagree
accuracy: float = 0.0            # 0..1
reasoning_quality: float = 0.0   # 0..1
action_appropriateness: float = 0.0  # 0..1
actual_outcome: str = ""         # true_positive|false_positive|true_negative|false_negative|unknown
time_saved_minutes: int = 0
comment: str = ""
ai_verdict: str = ""             # server-populated snapshot of case.verdict at submit time
ai_confidence: float = 0.0       # server-populated snapshot of case.confidence
```
`ai_verdict`/`ai_confidence` are set server-side from the case, not client-supplied — a snapshot of what the analyst is grading. Frontend mirror: `CaseFeedback` interface, `webui/src/lib/types.ts:1358-1370` (optional variants of the same fields, no `ai_verdict`/`ai_confidence` mirrored client-side — they come back on the refreshed `Case` object).

### API — `POST /api/cases/{case_id}/feedback`
Route `case_feedback` (`backend/app/api/routes.py:3196-3220`). Request body `FeedbackBody` (`routes.py:3170-3178`, all fields optional with defaults — same shape as `FeedbackEntry` minus `ts`/`ai_verdict`/`ai_confidence`). Behavior:
1. Loads the case (404 if missing).
2. Builds a `FeedbackEntry`, clamping `accuracy`/`reasoning_quality`/`action_appropriateness` to `[0,1]` and `time_saved_minutes` to `>=0`, stamping `ai_verdict`/`ai_confidence` from the current case.
3. Appends to `case.feedback`, bumps `case.updated_at`, saves via `state.cases.save(case)`.
4. Writes an audit record — `ActionType.FEEDBACK`, surface `"case"`, actor `body.analyst or "analyst"`, `result_summary=f"assessment={entry.assessment} outcome={entry.actual_outcome} accuracy={entry.accuracy}"` (`routes.py:3218-3223`).
5. Returns the full updated case (`case.model_dump(mode="json")`).

Notably: **feedback submission never touches `status`/`verdict`/`disposition`** and never calls `engine/case_manager.decide()` — purely additive/append-only (consistent with non-negotiable #3). It can be posted on a case in any status (open or closed) since the route has no status guard.

Aggregate: `GET /api/feedback/stats` (`routes.py:1335-1338`) → `feedback_stats(cases)` (`backend/app/engine/metrics.py:85-108`), returning `graded_cases`, `feedback_count`, `agreement_rate` (agree=1, partial=0.5 weighted), `avg_accuracy`, `avg_reasoning_quality`, `avg_action_appropriateness`, `time_saved_minutes` (summed int), `outcome_distribution` (Counter of `actual_outcome`). Also folded into `GET /api/metrics` under `"feedback"` key (`engine/metrics.py:161`, `compute_metrics`). Frontend client: `api.caseFeedback(caseId, body: CaseFeedbackInput)` → `POST cases/{id}/feedback` (`webui/src/lib/api.ts:1023-1024`; `CaseFeedbackInput` interface at `api.ts:96-105`, requires only `assessment`).

Case export also surfaces feedback in Markdown: `GET /api/cases/{id}/export?format=md` appends an "## Analyst feedback" section when `case.feedback` is non-empty (`routes.py:3374-3376+`).

### Target of UI item #10 — "fold feedback into case close"
Today grading (`FeedbackTab`) and closing are two separate surfaces:
- **Closing** goes through the single polymorphic lifecycle dialog `ConfirmActionDialog` (`webui/src/soc/pages/casedetail/ConfirmActionDialog.tsx`), driven by `ActionDef.fields` (`shared.tsx`). For the unified close action its fields are `disposition` (required — `DISPOSITION_OPTIONS`), `resolution` (optional — `RESOLUTION_OPTIONS`), `tags`, `assignee`, `priority`, `reason`, plus an always-present free-text "Analyst note". Per the file's header comment: "the dialog NEVER posts an action itself… the orchestrator's `runAction` POSTs the EXISTING backend verb (`close_disposition` maps to `close`)" so the server still runs the real `decide()`/`apply()` (`ConfirmActionDialog.tsx:10-14`). The Close submit button is disabled until a `disposition` is chosen (`ConfirmActionDialog.tsx:234`).
- **Grading** (`assessment`/star quality scores/`actual_outcome`/`time_saved_minutes`/`comment`) is a wholly separate tab+form+endpoint (`FeedbackTab` → `POST /api/cases/{id}/feedback`), with its own submit button, not invoked by `runAction`/`ConfirmActionDialog` at all.

So the concrete gap "item #10" targets: today an analyst who closes a case is not prompted to grade the verdict at the same moment — they must separately open the Feedback tab afterward (and today's `Metrics.tsx` empty-state literally asks users to do this: "Grade closed cases to build accuracy… metrics here", `Metrics.tsx:747`, evidence closing and grading are disconnected steps). Folding feedback into case close would mean: extending `ActionDef.fields`/`ConfirmActionDialog` (or a follow-on step after `runAction` succeeds for the close verb) to also collect `assessment`/quality stars/`actual_outcome`/`time_saved_minutes`/comment inline in the same modal, and have the close handler additionally call `api.caseFeedback(caseId, body)` (or a new combined backend endpoint) alongside the existing `close`/`close_disposition` POST — while keeping the #3 contract intact (feedback stays append-only/advisory and must not be allowed to influence `decide()`; the two POSTs — lifecycle action and feedback — would need to remain logically separate calls even if triggered from one dialog, since `FeedbackBody`/`case_feedback` and the lifecycle `close` route are independent endpoints today with no combined schema).


---


<!-- ===== [11] Case close flow + decide() + auto-close surfacing ===== -->

## Current-state reference: case closing, auto-close representation, and "decided by" UI (Testing branch)

### 1. The deterministic decision — `engine/case_manager.py`

```python
def decide(
    verdict: Verdict | None,
    confidence: float,
    risk_score: float,
    policy: AutoClosePolicy,
    *,
    escalation_confidence: float = 0.6,
    critical_severity: float = 7.0,
) -> Decision                                          # case_manager.py:59
```
`Decision` (`case_manager.py:42-48`) is a frozen dataclass: `status: CaseStatus`, `decision_by: DecisionBy`, `objection_window_expires_at: str | None`, `escalate: bool`, `rationale: str`. `decide()` is pure (no I/O); `CaseManager.apply(case)` (`case_manager.py:131`) is the only caller in the pipeline and writes the result onto the `Case`. Non-negotiable #3 holds: a `NEEDS_HUMAN`/missing verdict can never reach `CLOSED` (asserted at `case_manager.py:143-144`).

Policy: `config.AutoClosePolicy` has `false_positive`/`true_positive`/`needs_human`, each a `VerdictAutoClose{enabled, min_confidence, max_risk_score, objection_window_minutes}` (`config.py:551-587`). Shipped defaults: FP `enabled=True, min_confidence=0.85, max_risk_score=30.0, objection_window_minutes=1440`; TP `enabled=False` (explicit opt-in); `needs_human` always `enabled=False` and additionally code-enforced never-auto-close regardless of config.

### 2. How an auto-close is represented on a `Case` (models.py:1104+)

There is **no `auto_closed` field and no `"auto_closed"` `CaseStatus` value**. Auto-close is reconstructed from the combination of ordinary fields:

- `status: CaseStatus = CaseStatus.OPEN` (`models.py:1129`) — the auto-closed case simply has `status == CaseStatus.CLOSED` (`constants.py:220`), same enum value a human close produces.
- `decision_by: DecisionBy | None` (`models.py:1145`) — `DecisionBy.AGENT` ("agent") when `decide()` auto-closed it, `DecisionBy.ANALYST` ("analyst") when a human ran a lifecycle action, `DecisionBy.SYSTEM` ("system") for deterministic fail-to-human routing (`constants.py:265-268`). **This is the sole authoritative "was this auto-closed" signal**: `status == CLOSED (or RESOLVED) AND decision_by == DecisionBy.AGENT`.
- `objection_window_expires_at: str | None` (`models.py:1146`) — set only on the auto-close branch (`case_manager.py:80-86`); `None` on a human close. Nothing enforces or expires it server-side (no cron/reaper found) — it is purely advisory text for the UI; a human "objects" simply by running the ordinary `reopen` action, same as reopening any closed case.
- `disposition: Disposition | None` (`models.py:1133`) — populated from `_VERDICT_TO_DISPOSITION` (`case_manager.py:35-39`: TRUE_POSITIVE→`true_positive`, FALSE_POSITIVE→`false_positive`, NEEDS_HUMAN→`undetermined`) **only when unset**; an analyst's later `set_disposition`/`confirm_fp` is never overwritten by this mapping.
- `status_history: list[StatusHistoryEntry]` (`models.py:1140`, entry shape at `models.py:394-406`: `from_status, to_status, by, at, reason`) — `CaseManager.apply()` appends an entry with `by=decision.decision_by.value` (i.e. `"agent"`) and `reason=decision.rationale` (the human-readable string, e.g. `"FALSE_POSITIVE auto-closed: confidence 0.90 >= 0.85 and risk 12.0 <= 30.0; objection window 1440m."`) whenever status actually changed (`case_manager.py:171-180`).
- `history: list[dict]` (`models.py:1197`) — a parallel append-only free-form trail; the auto-close entry is `{ts, event:"decision", status, decision_by, escalate, rationale}` (`case_manager.py:182-189`). `GET /api/cases/{id}/rationale` falls back to this (`event=="decision"` + its `rationale`) when no matching audit row exists (`api/routes.py:4084-4088`).
- Audit (`tlsoc-agent-audit-*`, non-negotiable #2): the pipeline additionally writes an `ActionType.DECISION` audit row, `actor="case_manager"`, `result_summary="verdict=... status=... decision_by=... risk=... cost=..."` (`agents/pipeline.py:439-447`) — note this string does **not** include `decision.rationale` verbatim; it's the `case.history` entry (above) that carries the rationale text used by the rationale endpoint.

A human close/lifecycle move (`_perform_case_action`, `api/routes.py:2940`) sets `case.decision_by = DecisionBy.ANALYST` unconditionally (`routes.py:3000`) and never calls `decide()`/`CaseManager.apply()` — it is a wholly separate, additive layer (comment at `routes.py:2946-2949`).

### 3. Endpoints

- **Human close/lifecycle action:** `POST /api/cases/{case_id}/action` (`routes.py:2917`), body `CaseAction` (`routes.py:2806-2824`): `action` (one of `close|confirm_fp|reopen|escalate|deescalate|hold|resume|resolve|acknowledge|set_disposition|set_status`) + optional `note|reason|resolution|assignee|priority|tags|disposition|status|level`. `_ACTION_STATUS` maps each verb to its target `CaseStatus` (`routes.py:2831-2847`); `close`/`confirm_fp`/`resolve`/`reopen` → `_CLOSE_ACTIONS`, requiring RBAC grant `cases:close` (rest need `cases:write`, upgraded to `cases:close` if a `set_status` target is terminal — `_case_action_grant`, `routes.py:2878-2896`). `_guard_transition` (`routes.py:2858-2875`) blocks illegal moves (out of a terminal status without `reopen`; blocks `set_status` from reaching `CLOSED` — must go through the dedicated `close` verb). Bulk equivalent: `POST /api/cases/bulk` (`routes.py:3115`, `BulkCaseAction` = `CaseAction` + `ids: list[str]`), which fans out to the same `_perform_case_action` per id (`routes.py:3123-3124` doc comment).
- **Explainability:** `GET /api/cases/{case_id}/rationale` (`routes.py:3607`) → `_build_rationale` (`routes.py:3982`) returns `{case_id, verdict, confidence, status, decision_by, persona, playbook, memory_used, knowledge, enrichment, tools, reasoning, decision_rationale, mitre, evidence}`.
- **ReAct trace:** `GET /api/cases/{case_id}/trace` (`routes.py:3588`) — feeds `TraceTimeline`, which renders the deterministic decide-span (thresholds, `span.summary` = rationale, and `objection_window_expires_at` if present) as a distinct trusted step (`webui/src/soc/components/TraceTimeline.tsx:170-194`).
- **Preview (never calls `decide()`/never bills the LLM, #3/#6):** `POST /api/triage/preview-decision` (`routes_triage.py`) returns a synthetic `{..., "auto_closed": decision.status == CaseStatus.CLOSED, "objection_window_expires_at": ...}` for the rule editor's Test/Preview — this `auto_closed` boolean is a **preview-response-only** field, never persisted on a `Case`.
- **Aggregate posture:** `GET /api/metrics/posture` (`routes_metrics.py:62`) → `engine/metrics.py` `posture_metrics()`; its `quality` block computes `terminal_cases` (status ∈ `{resolved, closed}`, i.e. `constants.TERMINAL_CASE_STATUSES`), `auto_closed_cases = count(terminal cases where decision_by == DecisionBy.AGENT)` (`metrics.py:276-277`), and `automation_rate = auto_closed_cases / terminal_cases` (`metrics.py:292`). This is the one place `"auto_closed_cases"` exists as a name — it's a derived count, not a stored field.

### 4. The human close dialog — webui

**One polymorphic dialog drives every lifecycle action**: `ConfirmActionDialog` (`webui/src/soc/pages/casedetail/ConfirmActionDialog.tsx`), fully controlled by the `CaseDetail.tsx` orchestrator. It renders only the fields the pending `ActionDef.fields` declares (`disposition | resolution | tags | assignee | priority | reason`, always plus a free-text "Analyst note").

Action catalogue: `ALL_ACTIONS: Record<ActionKind, ActionDef>` (`webui/src/soc/pages/casedetail/shared.tsx:107-231`). Relevant to closing:
- `close_disposition` (`shared.tsx:133-144`) — the **unified close flow**: label "Close case", `fields: ['disposition','resolution','tags']`, `wireAction: 'close'`. The dialog's confirm button is `disabled` until a disposition is chosen (`ConfirmActionDialog.tsx:234`: `disabled={acting || (pending.fields.includes('disposition') && !disposition)}`). `DISPOSITION_OPTIONS` (`shared.tsx:81-88`) mirrors the `Disposition` enum: true_positive/false_positive/benign/suspicious/duplicate/undetermined.
- `confirm_fp`, plain `close`, and `set_disposition` still exist in the catalogue (legacy verbs) but `actionPlanForStatus()` (`shared.tsx:269-318`) only ever surfaces `close_disposition` as "the" close action in the current per-status action plan (primary CTA or secondary "close" slot depending on status), plus `set_disposition` folded into the terminal-state overflow menu for re-classification.
- `runAction()` (`CaseDetail.tsx:809-860`) always posts `pending.wireAction ?? pending.key` — so `close_disposition` still hits the **existing** `close` verb server-side, and the server still runs `decide()`-adjacent `_perform_case_action` (not `decide()` itself — human closes never call `decide()`, see §2/§4 above) via `api.caseActionExec(id, input)` → `POST cases/{id}/action` (`webui/src/lib/api.ts:1042-1043`).
- RBAC gating: `ACTION_PERMISSION` (`shared.tsx:66-78`) — `close`/`confirm_fp`/`close_disposition`/`resolve`/`reopen` require `{resource:'cases', action:'close'}`; everything else `{action:'write'}`. Enforced client-side via `<Can>` and server-side per §3.

### 5. Whether/where the UI shows "auto-closed"

There is **no dedicated "Auto-closed" badge/chip** on the case-list (`Cases.tsx`) or the CaseDetail Overview tab. What exists:

- **Cases list** (`webui/src/soc/pages/Cases.tsx`): columns are `StatusBadge` (`c.status`, line ~831) and `DispositionBadge` (`c.disposition`, line ~838). `decision_by` is not surfaced anywhere in the list, its filters, or its columns.
- **CaseDetail → Overview tab** (`OverviewPanel.tsx`): header row has `VerdictBadge`, `StatusBadge`, `DispositionBadge` (`OverviewPanel.tsx:568-570`) — again no auto-close indicator there. The only trace of `decision_by` is a quiet footer line, plain text, not a badge: `{c.decision_by ? <span>Decided by {humanizeToken(c.decision_by)}</span> : null}` (`OverviewPanel.tsx:853`). The `StatusTimeline` sub-component (`OverviewPanel.tsx:87-137`) renders each `status_history` entry's `by` value inline next to the age (`... · {humanizeToken(e.by)}`, line 120) — so "agent" appears there for an auto-close transition, alongside its `reason` (the `decide()` rationale string) rendered as plain text below.
- **CaseDetail → "Why" tab** (`WhyPanel.tsx`): the only place with an explicit, styled distinction. `decisionByLabel()` (`WhyPanel.tsx:44-48`) buckets `decision_by` into human vs. not (`isHuman = d.includes('human') || d.includes('analyst') || d.includes('operator')`) and renders a `Badge` "Decided by {text}" with a `User` icon (variant `success`) when human, or a `Brain` icon (variant `info`) when not (`WhyPanel.tsx:120-123`) — this is the de facto "auto-closed" tell in the current UI, but it fires for **any** non-human `decision_by` (including `DecisionBy.SYSTEM`, e.g. a fail-safe NEEDS_HUMAN routing that never closed anything), not specifically for a closed+agent case. Below it, an `Alert` shows `r.decision_rationale` verbatim (`WhyPanel.tsx:131-139`) — the actual `decide()` rationale sentence, or a static fallback sentence when none was recorded.
- **CaseDetail → Trace tab** (`TraceTimeline.tsx`): shows the deterministic decide-span with its threshold clauses and, if present, "Objection window open until …" (line 190-194) — this is the other place an auto-close's grace period is visible.
- **Overview (dashboard) page** (`webui/src/soc/pages/Overview.tsx:327-359`): an "autonomy" split (`autoClosed` vs `escalated`) preferring the server `posture.quality.auto_closed_cases`/`automation_rate` (§3); when that's unavailable it falls back to a client-side loop that checks `st === 'auto_closed'` (a status value the backend never actually emits — dead code path) **or** `k.decision_by === 'auto'` (`Overview.tsx:348`) — but the real enum value is `"agent"`, not `"auto"`, so this local fallback branch does not actually match agent-closed cases in practice; only the server-side `posture.quality` path (§3) is reliable.
- Several other files (`badges.tsx:200,224`, `Overview.tsx:109`, `Scans.tsx:131-134`, `shared.tsx:274`) defensively special-case a literal `'auto_closed'` **status string** for badge color/icon/terminal-classification purposes, but the backend's `CaseStatus` enum (`constants.py:201-220`) has no such value — it is unreachable dead code guarding against a status the pipeline never produces (real values are `new|open|needs_human|investigating|escalated|on_hold|resolved|closed`).

### 6. Summary for the UI-overhaul targets (#10/#11)

- To reliably flag "this case was closed by the agent, not a human" anywhere new (list row, header chip, etc.), the correct predicate is `case.status in {CLOSED, RESOLVED} and case.decision_by === 'agent'` — mirroring the server's own `engine/metrics.py:277` definition — not a `status` string match.
- The rationale text worth surfacing prominently is already computed and available per-case at `GET /api/cases/{case_id}/rationale` (`decision_rationale`) and inline in `case.status_history[].reason` / `case.history[].rationale` — no new backend work is needed to show it elsewhere; it just isn't rendered outside the "Why" tab and the timeline entry text today.
- `objection_window_expires_at` is present on the `Case` and rendered in the Trace tab and nowhere else (not on Overview, not on the Cases list) — a candidate for a "closes automatically / reopen before …" affordance if #10/#11 want to make the auto-close grace period visible up front.


---


<!-- ===== [12] Custom Dashboards page (name-card problem) ===== -->

## Current-state reference: Custom Dashboards (`webui/src/soc/pages/Dashboards.tsx` + `webui/src/soc/dashboard/*`)

### 1. Route, composition, files
- Page: `webui/src/soc/pages/Dashboards.tsx` (`Dashboards()`, 217 lines). Renders `<PageContainer variant="fluid">` (`PageContainer.tsx` — `fluid` = `max-w-none`, no extra padding of its own; gutter/vertical rhythm come once from `AppShell`).
- Delegates the actual view/edit experience per-dashboard to `webui/src/soc/dashboard/DashboardBuilder.tsx` (`DashboardBuilder`, 481 lines).
- Supporting modules in `webui/src/soc/dashboard/`: `WidgetGrid.tsx` (view/edit grid host), `EditableGrid.tsx` (the sole `react-grid-layout` importer, lazy), `layout-utils.ts` (pure geometry helpers incl. `packWidgets`), `registry.ts` (widget catalogue + per-role defaults + reconcile), `WidgetGallery.tsx` (Add-widget Sheet), `WidgetConfigSheet.tsx` (per-widget config Sheet), `DashboardDataProvider.tsx` (one shared fetch context), `widgets/{kpi,mix,lifecycle,tables,mitre,risk}.tsx` (9 lazy widget bodies), `rgl-theme.css`.
- Backend: `backend/app/models.py:633` `DashboardWidget`, `:660` `DashboardLayout`; store `backend/app/stores/dashboards.py`; router `backend/app/api/routes_dashboards.py`.

### 2. Effective-dashboard resolution (org/user cascade)
`Dashboards.tsx:69-118`:
- `useAsync` calls `api.dashboards.list()` → `GET /api/dashboards` → the caller's **saved** boards (`saved`, line 93).
- `roleDefault` (line 88-91) = `buildRoleDefault(role, hasPermission)` (line 55-67) → wraps `buildDefaultWidgets(role, {can})` from `registry.ts:424-444` into a `DashboardLayout` with fixed `id: 'overview'` (`DEFAULT_DASHBOARD_ID`, line 52), `name: 'Overview'`, `columns: 12`.
- `options` (line 98-106): each saved board's widgets are re-run through `reconcileWidgets` (`registry.ts:337-380`, drops unknown widget types, RBAC-filters); the code-default is prepended **only if** no saved board already has `id === 'overview'`.
- `active` (line 109-111): `options.find(b => b.id === selectedId) ?? options[0] ?? roleDefault`.
- The role default is **never persisted until the first Save** (`DashboardBuilder.doReset`, line 286-294: a reset on an unpersisted default just calls local `reset()`, no DELETE, avoiding a spurious 404).
- `createBlank()` (line 120-141) → `POST /api/dashboards` with an empty widget list, auto-numbered name (`"New dashboard"`, `"New dashboard 2"`, …).

### 3. Header / "name card" — exact vertical footprint
`Dashboards.tsx:143-176` builds ONE `PageHeader` with **`variant="dense"`** (default variant; `hero` is NOT used here). Per `PageHeader.tsx:11-19`, `dense` is documented as "a compact **~52px** header band"; `hero` (not used on this page) is the one with `p-6`, `rounded-lg border bg-card`, `text-2xl` and a decorative `bg-hero-glow` wash.

Concretely, for the dense variant (`PageHeader.tsx:128-193`):
- The outer `<section>` gets **no** background/border/padding class (those are only added `hero && …`, line 133).
- Icon chip: `h-7 w-7` (28px) (line 154).
- Title: `text-lg sm:text-xl` (line 166) — the page title is the literal string `"Dashboards"` (`Dashboards.tsx:147`), **not** the active dashboard's name.
- Description: `text-xs sm:text-sm` (line 178) — static copy: "Your build-your-own operations view. Edit to add, arrange, and resize widgets." (`Dashboards.tsx:148`).
- `meta` slot (line 171): a `<Select>` (`h-8 w-56` trigger, `Dashboards.tsx:152-165`) whose current **value is the active dashboard's `name`** — this Select is rendered **only when `options.length > 1`** (line 151), i.e. only once a second dashboard exists. With just the single (unsaved) default, no name UI appears in the header at all.
- No vertical `padding` class is applied to the dense section; the only spacing is the page's own `gap-3`/`gap-x-3 gap-y-1` and the `mt-6` wrapper (`Dashboards.tsx:182`) before the grid.

Inside `DashboardBuilder.tsx` there is **no separate "name card"** either:
- **View mode** header row (`DashboardBuilder.tsx:372-397`): just a `Refresh dashboard data` `IconButton` and, `<Can>`-gated, an `Edit dashboard` `Button` — no dashboard name is rendered here.
- **Edit mode** header row (`DashboardBuilder.tsx:347-371`): a `Name` `<label>` + `<Input id="dashboard-name-input">` (`h-8`, `w-56`, `maxLength={80}`) in a `mb-4` flex row, plus an `Add widget` button. This is a single-line control row, not a card.

**Net**: as currently coded, nothing renders a dedicated card whose sole content is the dashboard name at anything close to ~25% of the viewport — the dense `PageHeader` is a ~52px, unbordered band (title = static "Dashboards", not the board name), and the board's own `name` only surfaces as (a) a `h-8` `Select` value in that header's `meta` slot once ≥2 boards exist, or (b) a `h-8` `Input` row visible only in edit mode. If a ~25%-tall name-only card was observed, it does not match this file's current render path — candidates to double-check against a live screenshot: the `hero` `PageHeader` variant used on *other* pages (not `Dashboards.tsx`), the pre-Round-5 `HeroPanel` (~176px, now retired per the Round-5 Journal entry — "G5 compact hero"), or the loading skeleton state (`Dashboards.tsx:184-188`: 4× `<Skeleton className="h-40 …">`, 160px each, shown before data arrives) which could visually read as an oversized empty header while the name/grid haven't painted yet.

### 4. Widget grid — view vs. edit mode
`WidgetGrid.tsx` (`WidgetGrid`, line 369-449) has two rendering paths sharing one `WidgetCard` frame (line 108-170):

- **View mode** (default, `editing=false`): `ViewGrid` (line 452-496) — a plain CSS Grid, **zero react-grid-layout import**. `gridTemplateColumns: repeat(cols, minmax(0,1fr))`, `gridAutoRows: '${rowHeight}px'` (default `rowHeight=56`), `gap: '16px'` (line 373, 466-473). Each widget is placed via inline `gridColumn`/`gridRow` computed from its clamped `{x,y,w,h}` (line 477-487) after running the list through `packWidgets` (line 463). This is the "bundle-first-paint" guardrail: importing `WidgetGrid` pulls no grid JS.
- **Edit mode** (`editing=true`): lazily `import()`s `EditableGrid.tsx` via `React.lazy` declared at module scope (`WidgetGrid.tsx:70`), wrapped in `<React.Suspense>` with a 4-widget skeleton fallback (line 411-419). `EditableGrid` (`EditableGrid.tsx:73-131`) renders RGL's `GridLayout` with `useContainerWidth({measureBeforeMount:true})`, `gridConfig:{cols, rowHeight, margin:[16,16], containerPadding:[0,0]}`, `dragConfig:{handle:'.card-drag-handle', threshold:4}`, `resizeConfig:{handles:['se']}` (SE-corner resize only). RGL + `react-resizable` CSS + `rgl-theme.css` load only in this chunk.
- Both modes share `WidgetCard` (`WidgetGrid.tsx:108-170`): resolves `getWidgetDef(widget.type)` from the registry; unknown/legacy type → `EmptyState` "Unavailable widget" (never throws). The body is the registry's lazy `Component` wrapped in its own `Suspense`. In edit mode a `WidgetEditToolbar` (line 186-314) is absolutely positioned at the card top (drag grip `.card-drag-handle`, arrow-key move/`Shift`+arrow resize per WCAG 2.5.7, a `MoreVertical` dropdown with Configure/Grow-Shrink width+height/Duplicate/Remove) and the body gets `pt-8` to avoid the toolbar occluding it.
- Empty dashboard (0 widgets): `WidgetGrid` line 391-405 renders one `EmptyState` ("No widgets yet" / "This dashboard is empty.") in either mode — no grid at all.

### 5. `packWidgets` / layout-utils (`layout-utils.ts`)
- `GRID_COLS = 12` (line 26), `MAX_ROWS = 1000` (line 29). `GridItemShape = {i,x,y,w,h,minW?,minH?,static?}` (line 32-41) — identical to the persisted `DashboardWidget` geometry and to the RGL `LayoutItem`.
- `widgetId(w)` reads `w.i` (wire/RGL key) or falls back to `w.id` (registry-produced) (line 44-49); `widgetOptions(w)` reads `w.options` or falls back to `w.config` (line 52-58).
- `widgetToItem(w, cols)` (line 71-91) clamps `w/h/x/y/minW/minH` into the grid bounds — defense against a tampered/legacy layout (#9).
- `packWidgets(widgets, cols=12)` (line 165-209), pure/O(n²), preserves original array order (stable React keys):
  - **All-at-origin regime** (every widget `x===0 && y===0` — the code-defined per-role default, or a freshly-appended widget): flow-packs left→right in array order, wrapping at the column edge, advancing rows by the tallest widget in the row just filled (line 174-191). This is what turns the per-role default's "everything piled at (0,0)" into a real grid in VIEW mode (which has no RGL compaction of its own).
  - **Placed regime** (a real saved/RGL layout): sorts by `(y, x, index)` and pushes each widget's `y` down 1 row at a time until it no longer intersects an already-placed rectangle (`rectsIntersect`, line 146-148) — i.e. collision-repair only; a valid non-overlapping layout is returned byte-identical (idempotent), so a user's arrangement is respected.
- `moveWidget`/`resizeWidget` (line 224-257): pure, 1-cell keyboard move/resize honoring `minW`/`minH` and grid bounds.
- `normalizeWidget(w)` (line 277-292): guarantees a widget always carries a concrete `i` (generating one via `freshId()`, line 265-270, `crypto.randomUUID` or a timestamp+counter fallback) — the builder works in the `i`-keyed wire shape end-to-end.
- `DashboardBuilder.toDraft()` (`DashboardBuilder.tsx:103-122`) seeds the edit-mode draft by running the incoming widgets through `packWidgets` too, specifically so the **first** entry into Edit mode shows the same flow-packed layout VIEW mode already shows (avoiding a visible "jump" from an all-at-origin default suddenly RGL-compacting into a single column).

### 6. Default layouts (per role) — `registry.ts`
- `WidgetType` union (line 53-62), 9 widgets total: `kpi.needs_human`, `kpi.cost_budget`, `chart.verdict_mix`, `chart.autonomous_vs_human`, `kpi.lifecycle_timing`, `table.connector_health`, `table.recent_cases`, `mitre.heatmap`, `gauge.active_risk`.
- Each `WidgetDef` (line 84-104, populated `DEFS` line 152-265) carries `title`, `description`, `icon`, `category` (`kpi|chart|table|coverage`), a `React.lazy` `Component`, `defaultSize:{w,h,minW,minH}`, `sources` (which shared `DashboardSourceKey`s it reads), an optional `requires:{resource,action}` RBAC gate, and `configFields` (always at least the shared `TITLE_FIELD`).
  - Example sizes: `kpi.needs_human` `{w:3,h:3,minW:2,minH:2}` (line 160); `table.recent_cases` `{w:6,h:5,minW:4,minH:4}` (line 236); `mitre.heatmap` `{w:6,h:5,minW:4,minH:4}` (line 248).
- `ROLE_DEFAULT_WIDGETS` (line 392-405) — code-defined, per-role widget-type lists (not geometry; geometry comes from each type's `defaultSize` and layout is left to `packWidgets`/RGL):
  - `analyst_tier1`/`analyst_tier2`: `['kpi.needs_human','gauge.active_risk','table.recent_cases','chart.verdict_mix']`
  - `responder`: `['kpi.needs_human','table.recent_cases','chart.verdict_mix']`
  - `soc_manager`: `['kpi.lifecycle_timing','chart.autonomous_vs_human','kpi.needs_human','table.recent_cases']`
  - `auditor`: `['mitre.heatmap','kpi.lifecycle_timing','chart.verdict_mix']`
  - `super_admin`: `['kpi.cost_budget','table.connector_health','kpi.needs_human','kpi.lifecycle_timing']`
  - `default` (also used with auth/RBAC off): `['kpi.needs_human','gauge.active_risk','chart.verdict_mix','table.recent_cases']`
- `defaultWidgetTypesForRole()` (line 408-417) RBAC-filters the role's list; `buildDefaultWidgets()` (line 424-444) instantiates each at `x:0,y:0` with the registry `defaultSize` (positions deliberately left for packing).
- `reconcileWidgets()` (line 337-380): on every load, (1) drops any widget whose `type` is no longer registered, (2) RBAC-filters by `requires`, (3) optionally appends new role-default types not already present (`appendDefaults`) at `x:0,y:0` (auto-packed).

### 7. Edit vs. view mode — the `DashboardBuilder` loop
`DashboardBuilder.tsx` state: `useDirtyDraft<DashboardDraft>` (`{name, columns, widgets}`, line 96-134) buffers the draft against the last-saved snapshot; `useUnsavedChanges(dirty, editing)` (line 148) arms `beforeunload` only while editing with unsaved changes.
- **View (default, `editing=false`)**: `shownWidgets = draft.widgets` reflects the saved snapshot (line 327). Header row = Refresh + `Edit dashboard` (`<Can resource="metrics" action="view">`-gated, line 385-395, constants `EDIT_RESOURCE='metrics'`/`EDIT_ACTION='view'` at line 69-70). `WidgetGrid` renders with `editing={false}` — no toolbar, no sticky bar.
- **Enter edit**: `setEditing(true)` (line 389) → header swaps to Name input + `Add widget` (opens `WidgetGallery`, line 367-370); `WidgetGrid` gets `editing`, `onLayoutChange`, `editActions` (configure/duplicate/remove/move/resize, line 237-246); a `StickySaveBar` appears (`Save dashboard` / `Discard`, line 418-429) plus a ghost "Reset to default layout" / "Delete dashboard" button (line 434-447, wording driven by `isDefaultBoard`).
- **Drag/resize settle**: RGL's `onLayoutChange` → `onGridLayoutChange` (line 226-234) debounces 200ms, then `applyLayout` merges geometry back onto `draft.widgets` — this is local-state-only; it is **not** itself a network write.
- **Save** (`save()`, line 250-274): builds `{...dashboard, name, columns, widgets}` and calls `api.dashboards.update(id, payload, {immediate:true})` → an immediate `PUT /api/dashboards/{id}` (bypassing the client debounce used for drag/resize auto-persist elsewhere); on success `commit()`s the server echo, exits edit mode, toasts, calls `onSaved`.
- **Discard** (line 276-280): `reset()` (draft ← saved) + exit edit mode; cancels any pending debounced layout settle first (`cancelLayoutSettle`, line 220-225) so a stale settle can't re-apply after discard.
- **Reset/Delete** (`doReset()`, line 282-323): if the default board was never persisted, purely local `reset()` (no network call); otherwise `api.dashboards.remove(id)` → `DELETE /api/dashboards/{id}` (a 404 is treated as already-succeeded, not an error).
- **Data**: `DashboardDataProvider` wraps the grid (line 402-414), fetching only `neededSources` — the union of `sources` declared by the widgets actually placed (line 334-342) — so an empty/KPI-light dashboard never fetches (or bills) anything it doesn't display; there is deliberately no `standup` source (LLM-backed) in `DashboardDataProvider.ts`'s `DASHBOARD_SOURCES` table (line 109-137) so dashboards never trigger an LLM call.

### 8. Backend contract
- `backend/app/models.py:633` `DashboardWidget`: `i:str=""`, `type:str=""`, `x/y:int=0`, `w:int=4`, `h:int=4`, `minW/minH:int|None=None`, `static:bool=False`, `options:dict=field(default)`.
- `backend/app/models.py:660` `DashboardLayout`: `id` (default `new_id("dash-")`), `name:str=""`, `schema_version:int=1`, `columns:int=12`, `widgets:list[DashboardWidget]`, `layouts:dict[str,list[DashboardWidget]]` (per-breakpoint override, unused by the current FE builder — it only ever sends the single-breakpoint `widgets` list), `created_at`/`updated_at`.
- `backend/app/api/routes_dashboards.py`: `GET /api/dashboards`, `POST /api/dashboards`, `PUT /api/dashboards/{id}`, `DELETE /api/dashboards/{id}`, `POST /api/dashboards/{id}/clone`. Server-side `WIDGET_TYPES` allowlist (frozenset mirroring the 9 client `WidgetType`s) rejects an unknown `type` with 400; a contract test (`webui/src/soc/__tests__/dashboard-widget-types.contract.test.ts` against `widget-types.contract.json`) asserts client/server sets stay byte-identical.
- `webui/src/lib/api.ts:1193-1216` `api.dashboards.{list,create,update,remove,clone}`; `update()` defaults to a client-side ~500ms trailing debounce per id (`debouncedDashboardUpdate`) and only goes immediate when the caller passes `{immediate:true}` (used by the builder's explicit Save).
- Storage: zero-migration, keyed under `UserPrefs.dashboards: Record<dashboardId, DashboardLayout>` via `backend/app/stores/dashboards.py` (`DashboardStore` over the existing KV store — no new index/table).


---


<!-- ===== [13] Feature registry + router + nav derivation ===== -->

## FEATURES[] registry, nav/route/palette derivation, and how to rename/restructure a page or group

### 1. The single source of truth: `webui/src/soc/registry.tsx`

Everything (rail nav, disclosure children, command palette, router validation, lazy
route table) derives from one array: **`FEATURES: FeatureNode[]`**
(`registry.tsx:204-377`).

**Types** (`registry.tsx:70-193`):
- `PageId` — union of every routable id (`registry.tsx:70-102`), e.g. `'overview' | 'dashboard' | 'dashboards' | 'cases' | ... | 'baseline'`. The router validates hashes against this set.
- `NavGroupId` — union of the 6 rail groups (`registry.tsx:104-110`): `'overview' | 'triage' | 'intelligence' | 'analytics' | 'notifications' | 'platform'`.
- `NavPerm { resource: string; action: string }` (`registry.tsx:117-120`) — an RBAC gate checked against the permission matrix.
- `FeatureCtx { hasPermission, prefsEnabled?, demoActive? }` (`registry.tsx:131-138`) — the 3 orthogonal visibility axes.
- `FeatureNode { id: PageId; label: string; icon?: LucideIcon; group: NavGroupId; perm?: NavPerm; children?: FeatureChild[]; hidden?: boolean; enabled?: (ctx: FeatureCtx) => boolean }` (`registry.tsx:145-171`).
  - `hidden: true` = routable/deep-linkable but NOT a rail item (used for consolidated legacy sub-pages, e.g. the six Settings-folded admin pages).
  - `children` = disclosure sub-items a host feature tabs between (a child never nests further; its id must be a registered `PageId`/route).
  - `enabled` overrides the default RBAC-only check; default behavior is `!perm || hasPermission(perm.resource, perm.action)`.
- `FeatureChild { id, label, icon?, perm?, enabled? }` (`registry.tsx:174-180`).
- `featureEnabled(node, ctx)` (`registry.tsx:187-193`) — THE single place the three axes combine; call this (or its RBAC-only wrapper `navVisible` in `nav.ts:228-233`) rather than re-checking `perm` by hand.

**Ordering is authoritative**: array order = rail item order within a group; `FEATURE_GROUPS` order (`registry.tsx:383-390`, an `{id, label}[]`) = group display order in the rail.

**Route table** (`registry.tsx:396-559`), also in this same file:
- `ROUTES: Record<PageId, RouteDef>` (`registry.tsx:474-549`) maps every `PageId` to a `RouteDef { element: React.LazyExoticComponent<...>; render?: (ctx: RouteRenderCtx) => ReactElement }`.
- Every page component is `React.lazy(() => import('./pages/X'))` (declared `registry.tsx:408-439`) — this is what keeps pages out of the first-paint entry chunk.
- `RouteRenderCtx { opts?: NavOpts; onRerunWizard: () => void }` (`registry.tsx:442-447`) is the only thing a route's `render` may read; routes never receive `onNavigate` (pages call `useNavigate()`/`useNavigateOptional()` instead — see §3).
- **Routing rule for tabbed hosts**: a disclosure child that its host renders as an in-page tab (e.g. `dashboard`, `standup`, `investigate`, `cost`, `knowledge`, `memory`, `catalog`) routes THROUGH the host with a forced `tab` prop (e.g. `standup: { element: Home, render: () => <Home tab="standup" /> }`, `registry.tsx:523`) rather than getting its own standalone page — so it still shows the host's tab strip. Only genuinely standalone children (`dashboards`, `models`, `baseline`, `batchjobs`, `inbox`) get their own route.
- `renderRoute(page, ctx)` (`registry.tsx:555-559`) — resolves a `PageId` to an element, falling back to `ROUTES.overview` for an unknown id. Called from exactly one place: `App.tsx:174` (`renderRoute(page, { opts, onRerunWizard })`).

### 2. `nav.ts` — thin derivation layer (not a second source of truth)

`webui/src/soc/nav.ts` derives everything the rail/palette need from `FEATURES`/`FEATURE_GROUPS`; it holds no data of its own:

- `NAV_GROUPS: NavGroup[]` (`nav.ts:150-154`) = for each `FEATURE_GROUPS` entry, the non-hidden `FEATURES` in that group (in array order), narrowed via `toNavItem`/`toNavChild` (`nav.ts:111-143`). Groups with zero visible items are dropped.
- `NAV_ITEMS: NavItem[]` (`nav.ts:157`) = `NAV_GROUPS.flatMap(g => g.items)`.
- `NAV_CHILDREN: NavChild[]` (`nav.ts:160`) = all children across `NAV_ITEMS`.
- `PAGE_IDS: PageId[]` (`nav.ts:172-178`) = de-duped union of `NAV_ITEMS` ids + `NAV_CHILDREN` ids + **every** `FEATURES` id (this is what makes `hidden` entries still resolve as valid routes). The router validates hashes against this.
- Lookups: `navItem(id)` (`nav.ts:185-187`, top-level only), `navParentOf(id)` (`nav.ts:194-196`, finds the host whose subtree contains `id` — used for active-rail-trail highlighting), `navLabel(id)` (`nav.ts:202-213`, resolves top-level → child → hidden-feature → humanized-id, in that order — used for the breadcrumb), `isPageId(value)` (`nav.ts:216-218`).
- `navVisible(node, has)` (`nav.ts:228-233`) wraps `featureEnabled` with just the RBAC axis. **Note (verified by grep): `navVisible` is exported but not actually called by `NavSidebar.tsx` or `CommandPalette.tsx` today** — both re-implement their own `!item.perm || hasPermission(...)` filter inline (`NavSidebar.tsx:213-227` `filterGroups`; `CommandPalette.tsx:181,184`), which silently ignores any `enabled` override a feature declares. If you add a feature that gates on `enabled` (prefs-toggle/demo) rather than `perm`, it will show in the rail/palette without honoring that predicate unless these two call sites are updated to use `featureEnabled`/`navVisible` instead.

### 3. Consumers

- **Rail**: `AppShell.tsx` renders `NavSidebar`, which imports `NAV_GROUPS` (`NavSidebar.tsx:46`) and RBAC-filters via its own `filterGroups` (`NavSidebar.tsx:213-227`, used at `:595`). Group headers render `group.label` (`NavSidebar.tsx:670`).
- **Breadcrumb**: `AppShell.tsx:73` imports `navItem`/`navLabel`; `AppShell.tsx:424` computes `navItem(page)?.label ?? navLabel(page)`.
- **Router**: `router.tsx` imports `isPageId`/`PageId` from `./nav` (`router.tsx:17`). `pageFromHash()` (`router.tsx:100-111`) parses `#/<id>`, checks `isSettingsRedirect` first, else `isPageId(raw) ? raw : 'overview'`. `RouterProvider` (`router.tsx:113-189`) owns `page`/`opts` state + `navigate(page, opts)`; `useRoute()`/`useNavigate()`/`useNavigateOptional()` (`router.tsx:192-225`) are how pages read/trigger navigation — no `onNavigate` prop-drilling.
  - `SETTINGS_REDIRECTS: Record<string,string>` (`router.tsx:47-60`) maps 6 retired standalone `PageId`s (`account`, `security`, `sessions`, `users`, `roles`, `admin_sessions`) to Settings section ids; both `pageFromHash` and `navigate()` rewrite these to `#/settings?s=<section>`.
- **Command palette**: `CommandPalette.tsx` imports `NAV_GROUPS` from `@/soc/nav` (`:50`), builds its own RBAC-filtered `navGroups` (`CommandPalette.tsx:174-196`) flattening items + children into `{id, label, icon, key}` targets (rendered `:398-426`, grouped by `group.label`). It ALSO shows Settings sections/cards via a **separate, parallel registry** — `searchJumpTargets(query, hasPermission)` from `webui/src/soc/pages/settings/settings-sections-meta.ts` (imported `CommandPalette.tsx:55`, used `:205-208`, rendered `:364-393`) — this is the Settings page's own internal section/card metadata (component-free twin of `settings-sections.ts`), NOT part of `FEATURES[]`. Jumping to a settings target calls `onNavigate('settings', { section, anchor })`.
- **App root**: `App.tsx:27` imports `renderRoute`; `:174` is the only call site.

### 4. How to rename a page or nav group

Renaming is a **label-only** edit — no id/route/permission change needed:

- **Rename a rail item or child's display label** (e.g. "Cases" → "Investigations"): edit the `label` string on its `FeatureNode`/`FeatureChild` entry in `FEATURES[]` (`registry.tsx:204-377`). This alone updates the rail, the breadcrumb (`navLabel`/`navItem`), and the command palette (both derive from `NAV_GROUPS`/`NAV_ITEMS`). No test asserts label text for the generic case (only `settings.render.test.tsx` and `overview.render.test.tsx`/`overview.a11y.test.tsx` assert specific copy — see below).
- **Rename a nav group** (e.g. "Analytics" → something else): edit the `label` on the matching entry in `FEATURE_GROUPS` (`registry.tsx:383-390`). Group `id` (the `NavGroupId`) can stay stable — only the display label changes.
- **"Security posture"**: this phrase is NOT a nav group or rail label anywhere in `FEATURES`/`FEATURE_GROUPS` (there is no group/item literally named "Security posture" — the closest rail label is `Settings`'s children context-comment "Security & access" in `registry.tsx:328`, which is actually a Settings-internal group label in `settings-sections-meta.ts:81`, not a `FEATURES` entry). The real "Security posture" string is the Overview page's own hero copy: `export const PAGE_TITLE = 'Security Posture Dashboard'` in `webui/src/soc/pages/Overview.tsx:97`, rendered as the Home/Dashboard tab's hero (`Home.tsx` renders `<Overview>` under `tab: 'dashboard'`). To rename it, edit `PAGE_TITLE` there — but note `overview.render.test.tsx:2,128` and the top-level doc comment `Overview.tsx:2` assert/describe against this exact string, and it's called out (`Overview.tsx:92-96`) as the boot smoke-test anchor, so update those together. If instead you mean the "Security & access" Settings group label, edit `settings-sections-meta.ts:81` (`{ id: 'security_access', label: 'Security & access' }`) — that's a separate registry from `FEATURES[]` (see §3).
- **Rename a Settings section** (distinct system): edit `settings-sections-meta.ts`/`settings-sections.ts` directly; `FEATURES.settings.children` only exposes `users`/`roles` as promoted top-level deep-links (`registry.tsx:340-348`), the rest of Settings' internal IA lives in that separate section registry, not in `FEATURES`.

### 5. How to add a page

1. Add the new id to the `PageId` union (`registry.tsx:70-102`).
2. Add a `FeatureNode` (or `FeatureChild` under an existing host) entry to `FEATURES[]` with `id`, `label`, `icon`, `group` (+ `perm`/`enabled`/`children` as needed).
3. Add its lazy import (`const X = React.lazy(() => import('./pages/X'))`, near `registry.tsx:408-439`) and a `ROUTES[id]` entry (`registry.tsx:474-549`) — a bare `{ element: X }` if it needs no route-derived props, or `{ element: X, render: (c) => <X foo={c.opts?.foo} /> }` if it reads `opts`/`onRerunWizard`.
4. If it's a genuinely standalone child rather than a tab of a host, give it its own route (per §1's routing rule); if it's meant to render as a tab inside a host page, route it through the host with a forced `tab` instead (mirror the `standup`/`investigate`/`cost`/`knowledge`/`memory`/`catalog` pattern, `registry.tsx:483-490,521-527`).
5. Nothing else to touch: `nav.ts`, `NavSidebar`, `CommandPalette`, and `router.tsx`'s `PAGE_IDS` check all derive automatically.
6. Update the pinned test lists: `route-registry.test.tsx:31-43` hardcodes the "31 documented page ids" `EXPECTED` array and will fail until the new id is added there too.

### 6. How to reorder

- **Reorder items within/across groups**: reorder their entries in `FEATURES[]` (array order = rail order within a group, since `NAV_GROUPS` filters `FEATURES` in-place preserving array order, `nav.ts:153`).
- **Reorder groups**: reorder `FEATURE_GROUPS[]` (`registry.tsx:383-390`) — `NAV_GROUPS` is built by mapping over `FEATURE_GROUPS` in order (`nav.ts:150-154`), so this is the only thing that controls group order in the rail and in the command palette's per-group sections.
- Moving a feature to a different group is just changing its `group: NavGroupId` field; moving it into/out of being a rail item vs. a hidden deep-link is the `hidden` boolean; converting a top-level item into a child of another host (or vice versa) means moving its object between `FEATURES[].children` and the top-level array — its `PageId` and `ROUTES[id]` entry don't need to change either way.

### 7. Endpoints touched by nav-adjacent surfaces (for context, not required for a pure rename)

- Command palette remote search: `GET /api/search?q=&limit=` (`CommandPalette.tsx:141-143`, via `api.search`).
- Demo-mode quick action: `POST /api/demo/enable` (`CommandPalette.tsx:347-350`, via `api.demo.enable()`).
- These are unaffected by any nav/registry rename — only the palette's static labels/icons live in `FEATURES`/`settings-sections-meta.ts`.


---


<!-- ===== [14] Design tokens + theme + palette + animations ===== -->

## TLSOC webui — current-state reference: color tokens + motion/animation (2026-07-05, Testing branch)

### 1. Color token system (three tiers, two themes)

Source of truth: `webui/src/styles/theme.css` (405 lines), consumed via `webui/tailwind.config.js` `theme.extend.colors`, resolved to concrete strings for charts by `webui/src/soc/components/palette.ts`.

**Tier 1 — primitives** (`theme.css:22-30` light / `:157-164` dark): bare-HSL Radix `--slate-1..12` and `--blue-1..12` 12-step ramps, pasted from radix-ui.com/colors. Declared once per theme block; nothing else references these by name outside Tier 2.

**Tier 2 — semantic** (the only tier that flips between `:root` and `.dark`): `--canvas`, `--surface`, `--surface-sunken`, `--background`, `--foreground`, `--card(-foreground)`, `--popover(-foreground)`, `--primary(-foreground)` = `--blue-9`, `--secondary`, `--muted(-foreground)`, `--accent(-foreground)` (neutral hover/selected surface, NOT brand color — `theme.css:55-60`), `--hover`, `--border` (hairline ~1.45:1, decorative only) vs `--border-strong`/`--input` (≥3:1, structural/interactive — `theme.css:63-68`), `--ring`.

**The 3 orthogonal semantic axes** (`theme.css:71-85` light, `:194-204` dark) — each token ships a triad `--<name>` (solid fill) / `--<name>-foreground` (on-fill text) / `--<name>-text` (standalone text on a card, tuned to 4.5:1+):
- **SEVERITY/RISK**: `critical` (358°), `high` (22°), `medium` (40°), `low` (212°, BLUE — deliberately no green), `info` (220° blue-grey).
- **STATUS**: `success` (158°, the *only* place green is used, always paired with a check icon per `SEMANTIC_ICON`), `warning` (36°), `danger` (aliases `critical`).
- **VERDICT**: reuses the same axis tokens via `palette.ts` `VERDICT_COLOR` map, not new CSS vars.

Consumers must not invent new hues; `palette.ts` is the single label→token authority (see below).

**Round-3 extra allow-listed tokens** (`theme.css:89-118`, gated by `ALLOWED_TOKENS` in `theme.tsx`): radius scale `--radius-sm/md/lg/xl`, `--density-unit`, `--canvas-tint`/`--surface-tint`, `--accent2` (secondary brand hue, default indigo 243°, used only by the login hero), `--font-display`, and **material-pack chrome vars** `--glass-tint`, `--glass-opacity` (0.82 light/0.78 dark), `--glow-strength` (0 = quiet default), `--grid-opacity` (0 = quiet default) — these drive `GlassSurface` (`webui/src/soc/components/GlassSurface.tsx`) and the `.command-grid` overlay utility (`theme.css:354-370`), and are neutralized under `prefers-reduced-transparency` (`theme.css:389-405`).

**Chart ramps** (`theme.css:120-131` light / `:217-219` dark): `--chart-1..8`, Okabe-Ito colorblind-safe, for *identity-arbitrary* series only (per-model bars, cost donut); semantic charts must keep using the axis tokens. `palette.ts` exports `CATEGORICAL` (array of `hsl(var(--chart-N))` strings), `CATEGORICAL_CAP = 7`, `categorical(i)`, `categoricalCapped(i,total)` (7 distinct + grey "Other" at `--chart-8`). A separate `sequential(t)` in `palette.ts:126-136` samples a 7-stop hardcoded viridis ramp (concrete `rgb()`, theme-independent) for heatmaps (MITRE coverage).

**Elevation/shadow** (`theme.css:133-140` light / `:221-226` dark): `--shadow-color` + `--elev-1`, `--elev-2`, `--shadow-menu`, `--shadow-overlay`, wired into Tailwind `boxShadow.{elev1,elev2,menu,overlay,glow}`. Policy: borders for tiled/scrolled content, shadows only for detached floating portals.

**`palette.ts` API** (267 lines): `token(name, alpha?)` → `hsl(var(--name))` or with alpha; `palette` object (primary/accent/critical/high/medium/low/info/success/warning/muted/mutedForeground/foreground/border/card); `SEVERITY_COLOR`, `STATUS_COLOR`, `VERDICT_COLOR` maps (label → token name, e.g. `false_positive: 'info'`, `escalated: 'high'`); `SEMANTIC_ICON: Record<string, LucideIcon>` for non-color redundancy (WCAG 1.4.1) — e.g. `critical: AlertOctagon`, `resolved: Check`; `semanticIcon(label)`; `scoreBand(score)` / `SCORE_BANDS` (the ONE 0-100 ladder: low 0-21, medium 22-47, high 48-73, critical 74-100); `semanticColor(label, fallbackIndex)` — the single label→color resolver used by badges + recharts.

Design system docs: `docs/research/2026-07-round5/DESIGN_STANDARD.md` (§1.1-1.6 cover exactly this token architecture).

### 2. Motion/animation primitives that exist today

**Keyframes + `animation` utilities** — all declared in `webui/tailwind.config.js` (`theme.extend.keyframes` / `.animation`), consumed as Tailwind classes (no JS animation library remains in the bundle — `framer-motion` was fully removed in Round 5; see `src/soc/__tests__/bundle-first-paint.test.ts`, which asserts no `motion-*.js` chunk and no `framer-motion` importer anywhere under `src/`):

| class | keyframe | duration/easing | used for |
|---|---|---|---|
| `animate-fade-in` | `fade-in` (opacity 0→1) | 0.24s `cubic-bezier(0.16,1,0.3,1)` | generic reveal |
| `animate-rise-in` | `rise-in` (opacity+translateY 8px→0) | 0.24s same ease | `Stagger` items (see below) |
| `animate-shimmer` | `shimmer` (translateX -100%→0) | 1.8s ease-in-out infinite | `Skeleton`/`SkeletonCard` `.shimmer::after` sweep (`theme.css:337-351`) |
| `animate-bar-indeterminate` | `bar-indeterminate` (translateX -100%→350%) | 1.1s ease-in-out infinite | `LoadingBar` |
| `animate-accordion-down/up` | height 0↔`--radix-accordion-content-height` | 0.2s ease-out | `ui/accordion.tsx` |
| `animate-settings-highlight` | boxShadow ring flash 0→3px→0 | 1.6s, both | Settings deep-link anchor highlight (`Settings.tsx`; JS fallback under reduced-motion paints a static ring ~1.4s) |
| `animate-hero-in-down` / `animate-hero-in-up` | translateY entrance | 0.5s / 0.55s (0.08s delay) | Login `BrandHero` header + copy entrance |
| `animate-aurora-a` / `animate-aurora-b` | translate+scale drift, `alternate infinite` | 22s / 28s ease-in-out | Login page decorative background blobs (`loginParts.tsx` `AuroraBlob`/`LoginIllustration`, 8 curated variants: shield/radar/grid/waves/aurora/constellation/mesh/default) |

Plus **`tailwindcss-animate`** plugin primitives (`data-[state=...]:animate-in/out`, `fade-in-0/fade-out-0`, `zoom-in-95/zoom-out-95`, `slide-in-from-{top,bottom,left,right}[-1]`) used on Radix-driven components: `ui/dialog.tsx:46-47`, `ui/alert-dialog.tsx:90-91`, `ui/sheet.tsx:28-39` (per-side slide, 200ms close/300ms open), `ui/tooltip.tsx:24-28`, `ui/popover.tsx:23-24`, `ui/hover-card.tsx:22-23`, `ui/dropdown-menu.tsx:67-68`, `ui/collapsible.tsx:32-33`. These fire only on Radix open/close state changes — no custom durations beyond the plugin default.

**Reusable motion components**:
- `Stagger` (`webui/src/soc/components/Stagger.tsx`, 60 lines) — wraps each child in an element with `animate-rise-in` + an incremental inline `animationDelay` (`step=60ms` default, `initialDelay=0`, capped at `maxDelay=600ms`); `as`/`itemAs` polymorphic tags. Used in ~13 files: `AppShell.tsx`, `SettingsGrid.tsx`, `Approvals.tsx`, `CaseDetail.tsx`, `Cases.tsx`, `Investigate.tsx`, `Login.tsx`, `Metrics.tsx`, `Overview.tsx`, `Scans.tsx`, `Standup.tsx`, `Wizard.tsx`.
- `LoadingBar` (`webui/src/soc/components/LoadingBar.tsx`, 39 lines) — indeterminate `role="progressbar"` track, `size='sm'|'default'`, used in `PageSkeleton.tsx:28` and `Wizard.tsx:465` only (not a global route-progress indicator).
- `Skeleton`/`SkeletonCard` (`webui/src/ui/skeleton.tsx`) — shimmer placeholders; `PageSkeleton` (`webui/src/soc/components/PageSkeleton.tsx`) composes them as the **single Suspense fallback** for every lazy-loaded route (`App.tsx:169-175`, keyed by `page` so each route remounts its own skeleton — but there is no fade/cross-dissolve between the old page and the new one, just an unmount/mount swap under one `<React.Suspense>`).
- `GlassSurface` (`webui/src/soc/components/GlassSurface.tsx`) — frosted chrome panel (`blur='sm'|'md'|'lg'`, optional `glow`), for header/sheets/palette/hover-popovers only, not data surfaces; opacity/blur driven by the material-pack vars, neutralized under `prefers-reduced-transparency`.
- `RiskGauge` (`webui/src/soc/components/RiskGauge.tsx:109`) — the one component with a bespoke property transition: `transition-[stroke-dashoffset] duration-500` animates the gauge arc fill on value change.
- `usePrefersReducedMotion()` (`webui/src/soc/hooks/usePrefersReducedMotion.ts`) — reactive `matchMedia('(prefers-reduced-motion: reduce)')` hook (backed by `useMediaQuery`), replacing prior one-shot inline reads in `SettingsGrid.tsx`/`ChatPanel.tsx`.

**Global reduced-motion/transparency handling** (`theme.css:373-405`): `@media (prefers-reduced-motion: reduce)` collapses all `animation-duration`/`transition-duration` to ~0 and forces `scroll-behavior: auto` globally (no per-component opt-out needed); `@media (prefers-reduced-transparency: reduce)` forces `--glass-opacity:1`/`--glow-strength:0`/`--grid-opacity:0` and strips `backdrop-filter` on `.glass-surface`.

**Plain CSS transitions** (no keyframes, just `transition-colors`/`transition-all`/`transition-[stroke-dashoffset]`): present in 63 files, essentially all hover/focus color changes on buttons/rows/links (Tailwind's default 150ms). `hover:scale-*`, `active:scale-*`, and `will-change` are effectively **unused** (0-3 incidental hits across the whole `src/` tree) — there is no press/hover scale or lift micro-interaction convention anywhere in the design system today.

**Toasts**: `sonner@^1.7.4` via `webui/src/ui/sonner.tsx` — its own internal animation, not integrated with the token/keyframe system above.

**Deps**: `tailwindcss-animate ^1.0.7`, `@tailwindcss/container-queries`, `recharts ^2.15.4`, `react-grid-layout ^2.2.3` (dashboard grid, edit-mode only, lazy-loaded). **No** framer-motion, gsap, react-spring, or any other JS animation/tweening library in `package.json`.

### 3. What is missing for "more animations, clearer UI" (#5/#12)

- **No route/page transition.** `App.tsx:169-175` swaps lazy page chunks inside one `<React.Suspense>` keyed by `page`; the old page unmounts and `PageSkeleton` flashes in, then the new page mounts — no cross-fade, no shared-element continuity, no direction-aware slide for drill-down navigation (e.g. Cases list → CaseDetail).
- **`Stagger` is list-only and coarse.** Fixed `step=60/max=600ms`, only wraps *direct children* on initial mount; it does not re-trigger on data refresh/filter changes, and is adopted in ~13 pages but not universally (many table/list pages render rows with no entrance choreography at all).
- **No number/counter animation.** `KpiTile` (`webui/src/soc/components/KpiTile.tsx`) renders `value`/`delta` as static text — no count-up, no digit-roll on refresh (dashboards refresh every 60s per Round 6 but tiles just snap to the new number).
- **No hover/press micro-interactions.** `hover:scale`/`active:scale`/`will-change` are essentially absent — buttons, cards, and KPI tiles only get a color transition on hover, no lift/scale/shadow-elevate feedback, so interactive affordance is flat.
- **`RiskGauge` is the only component with a value-change transition**; other numeric/graphical surfaces (MITRE heatmap cells, BurnDownChart, charts.tsx bars/lines, badges) have no enter/update transition — recharts renders are effectively instantaneous re-paints.
- **Toasts (`sonner`) are disconnected from the token/keyframe system** — no shared motion language between toast entrance and the rest of the app's `animate-*` vocabulary.
- **No skeleton→content cross-fade.** `Skeleton`/`SkeletonCard` just disappear when real content swaps in (React conditional render), there's no fade-through.
- **Motion tokens declared but under-used.** `theme.css:142-150` defines `--motion-fast (120ms)` / `--motion-base (200ms)` / `--motion-slow (280ms)` / `--motion-ease-standard` explicitly "to replace ad-hoc `duration-xxx`" — but a grep shows these CSS custom properties are not yet referenced by Tailwind's `transitionDuration`/`transitionTimingFunction` config (only the hand-authored keyframes above use literal `0.2s`/`0.5s`/etc. baked into `tailwind.config.js`, not `var(--motion-*)`), so there is no single dial to retune app-wide motion pacing.
- **Only one directional layout-transition pattern exists** (Sheet's per-side slide in `ui/sheet.tsx`); Dialogs/AlertDialogs only fade+zoom-95, so modal hierarchy/depth isn't reinforced motion-wise.
- **Command-material chrome (`--glow-strength`, `--grid-opacity`, `GlassSurface`) is opt-in and mostly confined to the login hero** — the "distinctive UI" glass/glow treatment from Round 3 is not exercised across the main app shell/dashboards, so the day-to-day console still reads as the flat "quiet" material even where Round 5/6 aimed for more visual distinctiveness.

Any overhaul work should (a) route new transition/stagger/counter primitives through the existing `--motion-*` tokens and axis-token colors rather than inventing new ones, and (b) keep everything gated by the existing global `prefers-reduced-motion`/`prefers-reduced-transparency` rules already in `theme.css`, per the codebase's established pattern.


---


<!-- ===== [15] Layout primitives (PageHeader/PageContainer/KpiTile/StatCard) ===== -->

## Current-State Reference: Page Header / Hero / KPI / Card Primitives (webui, Testing branch)

Files read: `webui/src/soc/components/{PageHeader,PageContainer,KpiTile,StatCard,HeroPanel}.tsx`, `webui/src/ui/card.tsx`, `webui/src/soc/AppShell.tsx`.

### 1. `PageHeader` (`webui/src/soc/components/PageHeader.tsx`)

The one page-title band component. Root is `<section>` (`data-testid` forwarded).

**Props** (`PageHeaderProps`, lines 11–49):
- `variant?: 'dense' | 'hero'` — default `'dense'`.
- `breadcrumb?: Crumb[]` (`{label, href?}`) — preferred over `eyebrow`.
- `eyebrow?: string` — **@deprecated**, kept for a transition wave (Codemod migrates to `breadcrumb`).
- `title: string` (required), `description?: string`.
- `icon?: LucideIcon`.
- `meta?: React.ReactNode` — badges or a folded KPI summary beside the title.
- `tabs?: React.ReactNode` — rendered on the header's **bottom edge**, not a second band.
- `actions?: React.ReactNode` — right-aligned.
- `sticky?: boolean` — `sticky top-[var(--header-h)] z-20` + `bg-background/95` + backdrop blur.
- `className?`, `children?` (hero-only, see below), `'data-testid'?`.

**Visual role / vertical space**:
- `variant='dense'` (default): a single ~52px compact band — breadcrumb/eyebrow (`text-xs`) over `title` (`text-lg sm:text-xl`, `font-semibold`), a small `h-7 w-7` icon chip, `meta` inline beside the title, `actions` right-aligned. Container div: `flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between` (no `p-6`, no glow wash).
- `variant='hero'`: a "compacted posture band" — root gets `overflow-hidden rounded-lg border border-border bg-card` + an absolutely-positioned decorative `bg-hero-glow` wash (`aria-hidden`); inner container adds `gap-4 p-6 sm:gap-5`; icon chip grows to `h-8 w-8`/`h-5 w-5` icon; title becomes `text-2xl`; description `text-sm` (vs `text-xs sm:text-sm` in dense). Explicitly documented (lines 13–18) as **NOT the old ~176px marketing hero** — it "folds a KPI/meta summary into the `meta`/`tabs` slots." `children` renders only in hero variant, in a `px-6 pb-6` slot below tabs.
- `tabs` render in both variants without adding a second header band — dense gets no extra padding, hero gets `px-6`.

**Security (#9)**: `safeHref()` (lines 58–62) only allows `^(https?:|\/|#)` hrefs for breadcrumb links; `javascript:`/`data:` schemes are stripped to a non-interactive `<span>`. All title/description/eyebrow text renders as plain text (no `dangerouslySetInnerHTML`).

### 2. `HeroPanel` (`webui/src/soc/components/HeroPanel.tsx`)

**@deprecated** — a thin re-export/wrapper around `PageHeader variant="hero"` (merged in W0-D D2, `DESIGN_STANDARD §4.2`). Kept for "one transition wave" so existing callers (Overview/Standup/Home/Wizard/layouts) don't need to change yet; Codemod wave is expected to migrate them directly to `<PageHeader variant="hero">`.

**Props**: `eyebrow?`, `title` (required), `description?`, `icon?`, `meta?: React.ReactNode`, `actions?: React.ReactNode`, `className?`, `children?`, `'data-testid'?`. Note: no `variant` prop — it's hard-wired to hero.

**Behavior**: folds `meta` (rendered `font-mono text-xs text-muted-foreground`) and `actions` into one `flex flex-col items-start gap-3 sm:items-end` stack, passed as `PageHeader`'s single `actions` slot (old HeroPanel had separate meta/actions rows; now unified). No independent styling — it inherits whatever `PageHeader hero` renders (`p-6`, `text-2xl` title, glow wash).

### 3. `PageContainer` (`webui/src/soc/components/PageContainer.tsx`)

The **one width authority** for routed page bodies (`DESIGN_STANDARD §4.1, §4.5`). Owns width + centering ONLY, not gutter/vertical rhythm.

**Props** (`PageContainerProps`): `variant?: ContainerVariant` (default `'fixed'`), `as?: React.ElementType` (default `'div'`, no `asChild`), `children` (required), plus all `React.HTMLAttributes<HTMLDivElement>`.

**`ContainerVariant` → `max-w`** (the `WIDTHS` map, lines 37–42):
| variant | max-width | use case |
|---|---|---|
| `fixed` (default) | `max-w-[1200px]` | focused single-column (forms/settings body) — unchanged pre-Round-5 look until pages opt in |
| `wide` | `max-w-[1760px] 2xl:max-w-[1920px]` | operational surfaces: Cases, Overview, Metrics, Standup, Campaigns, Baseline, Batch, Logs — "widen by column count on ultrawide, not by stretching rows" |
| `fluid` | `max-w-none` | full-bleed grids / custom-dashboard canvas (still gutter-framed) |
| `prose` | `max-w-[75ch]` | narrative content: CaseDetail "Why"/rationale, chat threads, long-form settings |

Root class: `'@container mx-auto w-full min-w-0'` + the variant's max-w. Establishes a `@container` context (via `@tailwindcss/container-queries`) so wrapped widgets can reflow by slot width, not viewport.

**Gutter/vertical rhythm** (owned exactly once, NOT by `PageContainer`) — `AppShell.tsx:648`:
```
mx-auto w-full min-w-0 px-4 py-6 animate-fade-in sm:px-6 lg:px-8 2xl:px-12
```
applied to every routed page's content wrapper (`<main id="socMain">`, `AppShell.tsx:645`). `AppShell.tsx:639` comment confirms the former hard `max-w-[1400px]` cap on the shell was removed (Round-5 G4) — per-page width is now `PageContainer`'s job. ~26 pages have not yet adopted `PageContainer` (still relying on the shell-level default look) per the module docstring.

### 4. `KpiTile` (`webui/src/soc/components/KpiTile.tsx`)

The KPI-strip tile primitive; `StatCard` is now a thin wrapper over it (see below).

**Props** (`KpiTileProps`, lines 29–63):
- `label: string`, `value: React.ReactNode`, `sub?: string`.
- `icon?: LucideIcon`.
- `accent?: KpiAccent` = `'primary'|'critical'|'high'|'medium'|'low'|'info'|'success'` (default `'primary'`).
- `delta?: KpiDelta` = `{value: number, label?: string}` — sign of `value` drives the arrow.
- `goodDirection?: KpiGoodDirection` = `'up'|'down'|'none'` (default `'up'`) — decouples arrow direction (always true direction of change) from color judgement (`success`/`critical`/muted). Fixes the documented "Bug #2" where e.g. "Open alerts +30%" must render as a regression (critical + up-arrow), not green.
- `variant?: 'default' | 'bar'` (default `'default'`) — `'default'` = soft tinted icon chip (`ACCENT_CHIP`, e.g. `bg-primary/10 text-primary`); `'bar'` = slim `w-0.5` colored left accent bar (`ACCENT_BAR`, e.g. `bg-primary`) — this is what absorbed `StatCard`, used for MTTD/MTTA/MTTR-style timing metrics.
- `onClick?: () => void` — when set, tile renders as a `<button>` with hover/focus-ring states; otherwise a static `<div>`.
- `testId?: string` — anchors `data-testid="kpi-<id>"`, auto-slugified from `label` if omitted.
- `className?`.

**Visual role**: card shell `relative h-full overflow-hidden rounded-lg border border-border bg-card p-4 text-left` (`+pl-5` when `variant='bar'`, to clear the accent bar). Content: uppercase `text-xs font-semibold` label row with icon chip/glyph at top; big `text-3xl font-semibold tabular-nums` value + optional delta badge below (`text-xs` arrow + number, colored `text-success-text`/`text-critical-text`/`text-muted-foreground` per `resolveDelta()`); optional `text-xs text-muted-foreground` `sub` line at bottom. a11y: delta wrapped in `role="img"` with a composed `aria-label` (direction + judgement, e.g. "changed up by 12%, worse") since color alone can't convey it.

### 5. `StatCard` (`webui/src/soc/components/StatCard.tsx`)

**@deprecated** — absorbed into `KpiTile` as `variant='bar'` (W0-D D1). Now a pure re-export: `StatCardProps` (`label, value, sub?, accent? (=StatAccent=KpiAccent), icon?, className?`) forwards straight to `<KpiTile variant="bar" .../>`. Kept for one transition wave for existing call sites (Metrics/Cost/Models/BatchJobs/Overview/BaselineGauge) — the Codemod wave is expected to migrate these to `<KpiTile variant="bar">` directly. No independent styling of its own.

### 6. Card grammar (the shared surface convention these primitives all use)

Confirmed via `webui/src/ui/card.tsx` (docstring: "the ONE card grammar", `DESIGN_STANDARD §3.2/§5.2") and repeated verbatim across `soc/components/*` (`BudgetCard`, `CaseTasks`, `ChatPanel`, `CaseTriageHeader`, `ControlBar`, `FilterBar`, `DataTable`, `KpiTile`, `NotificationsEditor`, `EnrichmentProvidersEditor`, `RoleMatrixEditor`, `SettingsGrid`, `TraceTimeline`, etc.):

- Base shell: `rounded-lg border border-border bg-card` (+ `shadow-elev1` for raised/interactive surfaces like `DataTable`, `ControlBar bordered`; `elevation='none'` drops the shadow for a border-first look per Round-5 §3.3).
- `ui/card.tsx`'s `<Card>` adds typed knobs on top of the same shell: `padding?: 'sm'|'md'|'lg'` → `px-4`/`px-6`/`px-8` (8px-rhythm; `sm`=16 for dense/nested cards, `md`=24 default for top-level/KPI cards — replaces the old off-grid `px-5`); `density?: 'default'|'compact'`; `elevation?: 'none'|'sm'`; `variant?: 'default'|'flat'` (`flat` = `border-0 bg-transparent`, for toolbars/filter bars sitting on the page rather than raised tiles). Padding cascades via `CardContext` to `CardHeader`/`CardContent`/`CardFooter`.
- `KpiTile`'s own shell (`p-4`, not the Card component) matches this grammar exactly but is hand-rolled rather than composed from `<Card>`.
- `CardTitle` renders `<h3>`, `CardDescription` renders `<p>` (a11y fix — previously bare `<div>`s).

### 7. Vertical-space accounting relevant to overhaul items #5/#6/#12

- **Dense `PageHeader`** (default for most pages): ~52px single band, no glow, no `p-6`.
- **Hero `PageHeader`** (ex-`HeroPanel`, used by Overview/Standup/Home/Wizard/layouts via the `HeroPanel` wrapper today): `p-6` band with `text-2xl` title + `bg-hero-glow` wash — the doc comment on `PageHeader` explicitly frames this as already "compacted" versus a prior **~176px** marketing hero (Round-5 G5 shrank the old hero to today's PageHeader `hero` variant, ~notionally in the ~90–110px range including padding/description/tabs, vs. the pre-Round-5 176px `HeroPanel`).
- Section `tabs`, when present, sit on the header's bottom edge (dense: flush; hero: `px-6`) — they do **not** add a second full band, only one extra row's height.
- `AppShell`'s single global gutter (`px-4 py-6 ... sm:px-6 lg:px-8 2xl:px-12`) contributes `py-6` (24px top+bottom) around whatever `PageHeader`/`PageContainer` content is placed — this is shell-level, identical for every route, and is not owned by `PageHeader`/`PageContainer` themselves.
- `KpiTile`/`StatCard` tiles are `p-4` cards with a 3-row internal stack (label row → value+delta row → optional sub row), i.e. no separate "header" chrome of their own — their height is driven purely by the `text-3xl` value line + optional delta/sub lines, so KPI strips add compact, uniform row height rather than hero-scale bands.

### Key file:line anchors
- `webui/src/soc/components/PageHeader.tsx:19` (variant doc), `:98-194` (component), `:58-62` (`safeHref`).
- `webui/src/soc/components/HeroPanel.tsx:25-33` (deprecation note), `:34-67` (wrapper).
- `webui/src/soc/components/PageContainer.tsx:34-42` (`ContainerVariant`/`WIDTHS`), `:60-81` (component).
- `webui/src/soc/components/KpiTile.tsx:29-63` (props), `:74-93` (accent maps), `:102-132` (`resolveDelta`), `:211-214` (card shell).
- `webui/src/soc/components/StatCard.tsx:1-49` (whole file, thin wrapper).
- `webui/src/ui/card.tsx:1-58` (card grammar + `Card` component).
- `webui/src/soc/AppShell.tsx:639` (max-w cap removal note), `:645-648` (gutter/rhythm ownership).


---


<!-- ===== [16] Charts + ChartCard + dataviz components ===== -->

## Charting reference: TLSOC webui (Testing branch) — current state for the UI overhaul

### 1. Library + approach

- **Library:** [`recharts`](https://recharts.org) `^2.15.4` (`webui/package.json:47`) — the only charting dependency. No d3, no visx, no chart.js.
- **Pattern:** every chart is a thin, theme-aware wrapper around recharts primitives, exported from two files:
  - `webui/src/soc/components/charts.tsx` — generic, domain-agnostic wrappers (donut, h-bar, trend area, mini sparkline variants).
  - `webui/src/soc/components/charts-soc.tsx` — SOC-domain-shaped wrappers (MITRE heatmap, burn-down, multi-series trend, area spark).
- **Not a chart, but chart-adjacent primitives:**
  - `webui/src/soc/components/BarList.tsx` — a pure-CSS/DOM ranked horizontal bar list (no SVG, no recharts) — used far more than `HBarChart` in practice.
  - `webui/src/soc/components/BaselineGauge.tsx` — `Progress`-bar-based gauges (not recharts) for the anomaly-baseline warm-up feature, plus a `Sparkline` (recharts) reuse.
  - `webui/src/soc/components/RiskGauge.tsx` — a hand-rolled SVG half-circle gauge (no recharts; a single fixed arc path drawn twice — muted track + `currentColor` progress stroke via `stroke-dasharray`/`stroke-dashoffset`). `RiskGaugeProps { score, label?, size?=160, className? }`.
  - `webui/src/soc/components/ChartCard.tsx` — the shared titled-card chrome (icon chip + title + optional header action) every chart/list sits inside; `ChartCardProps { title, icon: LucideIcon, accentClass?='text-primary', children, action?, scrollBody? }`. Also exports `ChartEmpty` for empty-state hints.
  - `webui/src/soc/components/KpiTile.tsx` (`KpiTileProps { label, value, sub?, icon?, accent?, delta?, goodDirection?='up', variant?, onClick?, testId? }`) and `StatCard.tsx` (thin `KpiTile variant="bar"` wrapper) — the KPI-tile row primitives.
  - `webui/src/soc/components/DashboardGroup.tsx` — collapsible named widget-band wrapper (`{ title, count?, description?, actions?, open?/onOpenChange?/defaultOpen? }`), built on Radix `Collapsible`.

**No funnel chart exists anywhere in the codebase today** (`grep -r "Funnel\|FunnelChart"` over `webui/src` → zero hits). recharts 2.15.4 already ships `Funnel`/`FunnelChart` (confirmed present in `node_modules/recharts` exports, alongside unused `RadialBar`/`RadialBarChart`/`Treemap`/`Sankey`/`Scatter`) — building a funnel wrapper needs **zero new npm deps**, consistent with the project's "ZERO new runtime deps" rule.

### 2. Theming mechanism (the load-bearing part)

- **Single source of truth:** `webui/src/soc/components/palette.ts`. recharts needs concrete color strings (SVG `fill`/`stroke` can't consume Tailwind classes), so every chart resolves colors via `token(name, alpha?)` → `` `hsl(var(--${name}))` `` (or `/ alpha` variant), which the browser re-resolves live against the active theme's CSS custom properties in `webui/src/styles/theme.css`. A theme toggle re-renders charts with zero JS color logic.
- **Three orthogonal semantic axes**, each a label→token map (palette.ts:146-176):
  - `SEVERITY_COLOR` (critical/high/medium/low/info) — red→orange→gold→blue→blue-grey, no green.
  - `STATUS_COLOR` (new/investigating/escalated/on_hold/resolved/closed).
  - `VERDICT_COLOR` (true_positive/false_positive/benign/needs_human/suspicious/duplicate/undetermined) — TP is `critical` red, FP/benign is `info` blue-grey (never green).
  - `semanticColor(label, fallbackIndex=0)` resolves any of the above (case-insensitive, space/hyphen-normalized) to an `hsl(var(--x))` string, falling back to `categorical(fallbackIndex)` for unknown labels.
- **Categorical ramp** (identity-arbitrary series, e.g. per-model cost bars): `CATEGORICAL` = `--chart-1..8` tokens (Okabe-Ito colorblind-safe), `categorical(i)` wraps, `categoricalCapped(i,total)` caps at `CATEGORICAL_CAP=7` distinct + a grey "Other" (`--chart-8`).
- **Sequential ramp** (magnitude, e.g. heatmap intensity): `sequential(t)` — a dependency-free viridis lerp over 7 hardcoded RGB stops (palette.ts:106-136), returns a literal `rgb()` string (intentionally theme-invariant — intensity, not theme, carries meaning). Used by `MitreHeatmap`'s `intensityAlpha()` cell shading.
- **The 0-100 threshold ladder:** `scoreBand(score)` / `SCORE_BANDS` — one definition (`low 0-21 · medium 22-47 · high 48-73 · critical 74-100`) shared by badges, `RiskGauge`, and posture; do not re-derive bands locally (Overview.tsx does have its own client-only `bandOf()` at Overview.tsx:149 with a *different* ladder — 80/60/35/15 — worth reconciling in the overhaul).
- **Beside-color redundancy (WCAG 1.4.1):** `SEMANTIC_ICON` (palette.ts:183-205) maps every severity/status/verdict label to a `lucide-react` icon; `semanticIcon(label)` looks it up. Both chart files render a `SeriesGlyph` next to every legend/tooltip swatch so color is never the only channel. Chart labels/tooltips are always plain SVG `<text>` / DOM text — never `dangerouslySetInnerHTML` (non-negotiable #9 — attacker-influenced OCSF/label strings can't inject markup).
- Shared axis tick style: `const AXIS_TICK = { fill: 'hsl(var(--muted-foreground))', fontSize: 11 }` duplicated identically in both chart files.

### 3. Chart type inventory (exact symbols + props)

**`charts.tsx`:**
| Export | Backing recharts | Key props | Notes |
|---|---|---|---|
| `DonutChart` | `PieChart`/`Pie`/`Cell` | `{ segments: {label,value,color?}[], center?, height=200, thickness=0.38, format?, ariaLabel? }` | Ring chart with an optional centered overlay node (e.g. total count). Per-segment color = explicit `color` or `categorical(i)`. |
| `HBarChart` | `BarChart` (`layout="vertical"`) | `{ data: {label,value,color?}[], height?, labelWidth=120, format?, colorToken?, valueLabel='Count', ariaLabel? }` | Ranked horizontal bars; auto-height = `rows.length*34+16`. Color resolved per-row into the datum (Bar itself carries no fill; per-`Cell` fill only) so the tooltip swatch can recover it. |
| `TrendArea` | `AreaChart`/`Area` w/ `linearGradient` | `{ data: {x,y}[], height=220, colorToken='primary', format?, showXAxis=true, showYAxis=false, ariaLabel? }` | Single-series gradient-filled trend (spend/volume over time). |
| `MiniBars` | `BarChart` | `{ data: number[], height=40, colorToken='primary', ariaLabel? }` | Axis-less bare vertical bars (inline KPI/cell spark), bar-index only as x. |
| `Sparkline` | `AreaChart` | `{ data: number[], height=40, colorToken='primary', fill=true, ariaLabel? }` | Axis-less line/area sparkline for inline KPI deltas. |

**`charts-soc.tsx`:**
| Export | Backing | Key props | Notes |
|---|---|---|---|
| `MitreHeatmap` | Pure DOM grid (no SVG) | `{ columns: {tactic,label,cells:{technique,name?,value}[]}[], maxValue?, ariaLabel? }` (`colorToken` prop deprecated/ignored — ramp is ALWAYS viridis `sequential()`, never a severity hue) | ATT&CK tactic×technique coverage grid; alpha-quantized into 5 buckets via `intensityAlpha()`; includes a visually-hidden `<table>` fallback (one row per tactic, since the grid is jagged) for screen readers. |
| `BurnDownChart` | `AreaChart` (open, gradient) + `Line` (closed) | `{ data: {x,open,closed}[], height=240, format?, openLabel='Open', closedLabel='Closed', ariaLabel? }` | Open-vs-closed backlog over time; open=`token('info')`, closed=`token('success')`. Used for "Closure vs arrival" in Metrics.tsx (fed as a 2-point series). |
| `AreaSpark` | `AreaChart` | `{ data: number[], height=44, colorToken='primary', ariaLabel? }` | Like `Sparkline` but stronger gradient floor + thinner stroke, for inline KPI context. |
| `MultiSeriesTrend` | `LineChart` (N `Line`s) | `{ data: Record<string,string|number>[], series: {key,label,color?}[], xKey='x', height=240, format?, showXAxis=true, showYAxis=true, ariaLabel? }` | Multi-series time trend w/ legend; per-series color = explicit → `semanticColor(label,i)` (falls back to categorical). Suitable for verdict-mix-over-time, per-source volume, cost-by-model. |

Both files share a private, near-identical themed tooltip (`ChartTooltip` in charts.tsx / `SocTooltip` in charts-soc.tsx) and (in charts-soc.tsx only) a custom `SemanticLegend` recharts `<Legend content={...}>` renderer that swaps the default color-only legend dots for swatch+icon+label rows.

**Empty-state convention:** every chart with `data.length === 0` renders a centered `role="img" aria-label="... (no data)"` `"No data"` div at the same height, rather than an empty SVG canvas — replicate this for any new chart (funnel included).

### 4. Dashboard composition today (Overview.tsx / Metrics.tsx)

- `Overview.tsx` (`webui/src/soc/pages/Overview.tsx`) is the primary landing dashboard: `PageContainer variant="wide"` → compact `PageHeader variant="hero"` (~64px) → control bar (`TimeRangePicker` + auto-refresh) → a flat `Stagger`-animated `KpiTile` grid (`grid-cols-2 md:grid-cols-4 2xl:grid-cols-7`) → named `DashboardGroup` bands in `xl:grid-cols-3` rows (Active Risk Index w/ `RiskGauge` · Open-cases-by-severity · Attention queue · Autonomous-vs-human split · timing trio · cost/budget · connector health · MITRE below the fold).
- **"Open cases by severity"** (Overview.tsx:741-804) is hand-rolled markup (a `<ul>` of clickable rows with a `role="progressbar"` div), **not** `BarList` or `HBarChart` — each row deep-links to `navigate('cases', { severity: sev, window })`. Severity band here is `bandOf(risk_score)` (Overview.tsx:149-156, ladder 80/60/35/15/0), a locally-defined, case-`risk_score`-derived band — **not** the same as `palette.ts`'s `scoreBand()` (74/48/22 ladder) and **not** `Case.severity_band` (the source-asserted band). This divergence is worth reconciling in the overhaul.
- **"Autonomous vs human"** (Overview.tsx:869-924) — the closest existing thing to a "before/after AI" split: a big `%` (`autonomy.automationPct`), a 2-segment split bar (`bg-success` auto-resolved vs `bg-high` sent-to-human), and two count tiles (`autonomy.autoClosed`, `autonomy.escalated`). Derived client-side from `metrics.by_status`/`decision_by` counts (Overview.tsx:330-356), captioned "Advisory only — the agent recommends; the deterministic case manager decides" (non-negotiable #3).
- `Metrics.tsx` (`webui/src/soc/pages/Metrics.tsx`) is the fuller analytics page and is where nearly every chart type above actually gets used: `ChartCard title="Verdict mix"` → `DonutChart` (line 586), `ChartCard title="Disposition mix"` → `DonutChart` (638), `BarList` for "Persona usage"/"Playbook usage"/"Age distribution"/"Corpus by source" (674, 682, 1192, 452), `MiniBars` for "Cases per day" (691), `BurnDownChart` for "Closure vs arrival" (1202), `MitreHeatmap` for MITRE coverage (1344), and a `DonutChart` for "Memory by author" (460).

### 5. Backend data available for a severity funnel ("total alerts by severity → alerts after AI")

No existing endpoint returns a pre-built funnel, but the raw ingredients exist:

- **Pre-correlation / raw-alert counts:** `Case.member_event_ids: list[str]` (`backend/app/models.py:1121`) — the raw member events folded into a case; `len(member_event_ids)` = alerts absorbed. `Cluster.trigger_reason.observed_count` / `.severity_min` / `.severity_max` (`models.py:238,243-244`) record the correlation window's raw counts and source-asserted severity range per case.
- **Post-AI outcome:** `Case.verdict` (`Verdict.TRUE_POSITIVE|FALSE_POSITIVE|NEEDS_HUMAN`), `Case.status`, `Case.decision_by` (`auto`|human), `Case.disposition`. `GET /api/metrics` (`backend/app/api/routes.py:1324`, `?window_hours=24`) → `compute_metrics()` in `backend/app/engine/metrics.py:111` returns `by_status`, `by_verdict` (`TRUE_POSITIVE`/`FALSE_POSITIVE`/`NEEDS_HUMAN`/`none` counts), `by_disposition`, `avg_risk_score`, `cases_per_day`, `feedback` — all case-level, no severity cross-tab.
- **Severity band per case:** `Case.severity_band` / `severity_source` (`models.py:1176-1177`, "source_asserted" vs "derived") — produced by `engine/priority.py::severity_band_from_events()` (reads `trigger_reason.severity_max`, scale-aware via `_normalise_severity`). This is the more "honest" source-asserted severity vs. the risk-derived bands used ad hoc on Overview.
- **Case listing for a funnel query:** `GET /api/cases` (`routes.py:2766`, `CaseListResponse{cases,total}`) accepts `status`, `surface`, `entity`, `limit`(≤200)/`offset`, `from`/`to` (relative-or-ISO, windows by `created_at`) — no `severity` or `verdict` query param server-side yet (Overview does its own client-side severity bucketing after fetching a capped 200-case page); a real funnel needs either a new aggregation route or client-side reduction over a large-enough case page.
- **No distinct "alert" entity separate from Case exists in the API surface** — an "alert" pre-triage is really `member_event_ids` count *before* clustering collapses many raw events into one `Case`; there's no `GET /api/alerts` distinct from `GET /api/cases` or `GET /api/logs` (the Round-4 unified scatter-gather browse endpoint, `routes.py`, source-agnostic raw log tail — not severity-bucketed, not case-correlated).

**What a "total alerts by severity → alerts after AI" funnel needs, concretely:**
1. A stage-1 count = raw alerts by severity **before** correlation/triage (sum `member_event_ids` length or raw ingested-event count per severity band — not currently aggregated anywhere; would need a new deterministic aggregation, likely in `engine/metrics.py`, over `Case.trigger_reason.severity_max`/`observed_count` or a new pre-correlation counter, since post-correlation `Case` objects have already collapsed N events into 1).
2. A stage-2 count = **cases after AI triage**, by the same severity axis, split by outcome (`verdict`/`decision_by`/`status`) — already computable client- or server-side from `GET /api/cases` + `GET /api/metrics`.
3. A rendering primitive — recharts `Funnel`/`FunnelChart` (unused today, zero new deps) is the natural fit, wrapped the same way `DonutChart`/`HBarChart` are: token-themed fills via `semanticColor()` per severity stage, `ChartTooltip`-style tooltip, `role="img"`+`aria-label` accessible name, `SeriesGlyph` beside-color icons, an empty-state branch, wrapped in `ChartCard`. Alternative for a QRadar/Splunk "infographic" feel without recharts' funnel geometry: a stacked/tapering `BarList`-style sequence (reuse `BarList`'s existing bar-with-percent visual language, which already reads well as a horizontal funnel step) — lower risk, matches existing visual language exactly, no new chart component needed.
4. Whichever is chosen, it should live beside the other `ChartCard`-wrapped widgets on `Metrics.tsx` or as a new `DashboardGroup` band on `Overview.tsx`, and must stay read-only/advisory (#3) — it summarizes `decide()`'s output, never feeds it.


---


<!-- ===== [17] Backend /api/metrics + engine/metrics.py ===== -->

## Current-State Reference: Metrics/Analytics Subsystem (Testing branch)

Two independent code paths compute case analytics; both are pure functions over `list[Case]` (no LLM, no writes) and never feed `case_manager.decide()` (#3). Route auth: `/api/metrics` and `/api/feedback/stats` (in the monolith router) inherit only the router-level `require_auth`; the three routes in `routes_metrics.py` additionally require `require_permission("metrics","view")`.

### 1. `GET /api/metrics` — legacy rollup (`backend/app/api/routes.py:1324-1332`)
```python
async def metrics(window_hours: int = 24, ...)
    cases, _total = await state.cases.list(limit=2000)   # newest-first (sort_field="created_at" desc), NOT window-filtered
    out = compute_metrics(cases)                          # engine/metrics.py:111
    out["cost"] = await state.usage_store.summary(window_hours=max(1, window_hours))  # only the cost block is window-scoped
```
Note the asymmetry: the case-derived fields cover the newest **2000 cases regardless of `window_hours`**; only `out["cost"]` is time-windowed. `compute_metrics()` (`engine/metrics.py:111-162`) returns:
```json
{
  "total_cases": int,
  "open_cases": int,            // by_status[CaseStatus.OPEN]
  "needs_human_cases": int,     // by_status[CaseStatus.NEEDS_HUMAN]
  "closed_cases": int,          // by_status[CaseStatus.CLOSED]
  "by_status": {"<status>": count, ...},        // Counter over every CaseStatus value seen ("unknown" if null)
  "by_disposition": {"<disposition>": count},   // Counter over Case.disposition ("undetermined" if null)
  "by_verdict": {"TRUE_POSITIVE": n, "FALSE_POSITIVE": n, "NEEDS_HUMAN": n, "none": n},
  "persona_usage": {"<agent_persona>": count},  // "generalist" if empty
  "playbook_usage": {"<playbook_id>": count},   // "none" if empty
  "avg_risk_score": float,       // mean of Case.risk_score
  "mttr_minutes": float,         // coarse: mean(updated_at - created_at) over CLOSED cases only
  "resolved_count": int,         // n cases contributing to mttr_minutes
  "cases_per_day": [{"date":"YYYY-MM-DD","count":int}, ...],  // last trend_days=14 UTC day-buckets by created_at, over the fetched 2000
  "feedback": { ...feedback_stats() shape, see below... },
  "cost": { ...usage_store.summary() shape, see §6... }
}
```
This is the ONLY metric that computes a "MTTR" style value at this level — but it is a coarse `updated_at - created_at` over `CLOSED` status only (a subset; `RESOLVED` cases are excluded), unlike the richer `lifecycle_intervals()` MTTR below.

### 2. `GET /api/feedback/stats` (`routes.py:1335-1338`) → `feedback_stats()` (`engine/metrics.py:85-108`)
Aggregates `Case.feedback: list[FeedbackEntry]` (models.py:367-382; fields `assessment` agree|partial|disagree, `accuracy`/`reasoning_quality`/`action_appropriateness` 0..1, `actual_outcome`, `time_saved_minutes`, `comment`, `ai_verdict`, `ai_confidence`). Response:
```json
{
  "graded_cases": int,             // cases with >=1 feedback entry
  "feedback_count": int,           // total feedback entries across all cases
  "agreement_rate": float,         // (agree + 0.5*partial) / feedback_count
  "avg_accuracy": float, "avg_reasoning_quality": float, "avg_action_appropriateness": float,
  "time_saved_minutes": int,       // SUM across entries — a direct "analyst time saved" number
  "outcome_distribution": {"<actual_outcome>": count}
}
```
(Also embedded verbatim as the `"feedback"` key of `GET /api/metrics` above — same function, called twice.)

### 3. `GET /api/metrics/posture?window_hours=24&compare=` (`routes_metrics.py:62-83`) → `posture_metrics()` (`engine/metrics.py:497-570`)
Fetches up to **5000** newest cases (`_STORE_FETCH_LIMIT`, `routes_metrics.py:43`) via `_load_cases()` (fails open to `[]`/`0` on store error, `routes_metrics.py:46-59`), then **internally window-filters by `created_at`/`detected_at`** (`_window_filter`, `engine/metrics.py:445-463`; a case with unparseable `created_at` is excluded from every window, symmetric current/prev). Response:
```json
{
  "window_hours": int,
  "generated_at": "<iso>",
  "case_count": int,                       // cases surviving the window filter
  "lifecycle": { "mtta_minutes": {...}, "mttr_minutes": {...}, "dwell_minutes": {...} },  // _stat_block, see below
  "quality": { ...quality_metrics()... },
  "aging": { ...aging()... },
  "sla": { ...sla_metrics()... },
  "truncated": bool, "store_total": int, "fetched": int,   // truncation_marker()
  "compare": {                              // only when compare=="prev" and window_hours>0
    "mode": "prev",
    "case_count": {"value":n,"prev":n,"delta_pct":x|"—"|null},
    "alert_to_incident_ratio": {...same shape...},
    "false_positive_rate": {...},
    "escalation_rate": {...},
    "automation_rate": {...},
    "mttr_p50": {...},
    "mtta_p50": {...}
  }
}
```
`_delta_pct` (`engine/metrics.py:466-473`): DASH `"—"` if either side is non-numeric; `null` means "new/undefined growth" (prev==0, value!=0); DASH if both are 0 at baseline `prev==0 & value==0`.

**`_stat_block` shape** (`engine/metrics.py:66-82`), used for every p50/p90 metric — empty input never fakes a 0:
```json
{"p50": 12.3, "p90": 45.6, "mean": 20.1, "max": 99.0, "count": 42, "available": true, "reason": ""}
// OR when no sample exists:
{"p50": "—", "p90": "—", "mean": "—", "max": "—", "count": 0, "available": false, "reason": "no case has been resolved/closed yet"}
```

**`lifecycle_intervals()`** (`engine/metrics.py:206-245`) — three `_stat_block`s in minutes:
- `mtta_minutes` — **MTTA**: `created_at`/`detected_at` (`_created_dt`, prefers `Case.detected_at` else `created_at`, `engine/metrics.py:201-203`) → `Case.acknowledged_at` OR first `status_history` transition into `{INVESTIGATING, ESCALATED, ON_HOLD}` (`_ACK_STATUSES`, `:177-179`).
- `dwell_minutes` — time-to-first-response: start → `Case.first_response_at` OR first transition into `{INVESTIGATING, ESCALATED, ON_HOLD, RESOLVED, CLOSED}` (`_RESPONSE_STATUSES`, `:180-185`).
- `mttr_minutes` — **MTTR**: start → first transition into a terminal status (`{RESOLVED, CLOSED}` = `TERMINAL_CASE_STATUSES`, constants.py:237-240), falling back to `updated_at` if terminal but no recorded transition.
All three read `Case.status_history: list[StatusHistoryEntry]` (`models.py:1140`; each entry `{from_status, to_status, by, at, reason}`, `models.py:394-406`).

**`quality_metrics()`** (`engine/metrics.py:252-293`) — pure tallies, never fed back into `decide()`:
```json
{
  "total_cases": int, "verdicted_cases": int,
  "true_positive_cases": int, "false_positive_cases": int, "needs_human_cases": int,
  "escalated_cases": int,          // status==ESCALATED OR escalation_level>0 OR ever transitioned to ESCALATED
  "terminal_cases": int,           // status in TERMINAL_CASE_STATUSES
  "auto_closed_cases": int,        // terminal AND decision_by==DecisionBy.AGENT
  "alert_to_incident_ratio": float,   // TP / total  — "how many alerts became real incidents"
  "false_positive_rate": float,       // FP / verdicted
  "escalation_rate": float,           // escalated / total
  "containment_rate": float,          // terminal / total  — "worked to completion"
  "automation_rate": float            // auto_closed / terminal — deterministic auto-close share
}
```

**`aging()`** (`engine/metrics.py:307-348`) — queue depth/backlog over currently OPEN (non-terminal) cases:
```json
{
  "queue_depth": int,          // == backlog
  "age_buckets": [{"bucket":"<1h|1-4h|4-24h|1-3d|3-7d|>7d","count":int}, ...],  // _AGE_BUCKETS, engine/metrics.py:297-304
  "oldest": [{"case_id","case_number","age_hours","status","risk_score"}, ...],  // top oldest_n=10, desc by age
  "arrivals": int,             // len(cases) in the window
  "closures": int,             // terminal count in the window
  "closure_vs_arrival": float, // closures/arrivals — is the queue draining or growing
  "backlog": int
}
```

**`sla_metrics()`** (`engine/metrics.py:351-429`) — advisory vs `Preferences.sla` (`SlaPolicy`/`SlaTarget`, `config.py:1176-1199`; `enabled: bool`, `targets: {"P1"..."P4": {response_minutes, resolve_minutes}}`, defaults P1 15/240m … P4 480/4320m). Returns `{"enabled": false, "evaluated": 0, "reason": "..."}` when off; otherwise:
```json
{
  "enabled": true, "evaluated": int,
  "response_breached": int, "response_at_risk": int,   // at_risk = elapsed >= 80% of target, not yet breached
  "resolve_breached": int, "resolve_at_risk": int,
  "attainment_pct": float,     // (evaluated - distinct breached case_ids) / evaluated * 100
  "breaching": [ {"case_id","case_number","priority","clock":"response|resolution","state":"breached|at_risk","elapsed_minutes","target_minutes","over_pct"}, ... ]  // top 25 by over_pct desc
}
```
Cases with no `SlaTarget` for their `priority_level` are excluded from `evaluated` (not just untargeted — `priority_level` itself is an advisory band derived elsewhere, never read by `decide()`).

**`truncation_marker(fetched_count, store_total)`** (`engine/metrics.py:480-494`) — `{"truncated": bool, "store_total": int, "fetched": int}`; `truncated` is true only when the store held more rows than the 5000-row fetch, i.e. the rollup is a lower bound, not when in-window filtering narrows the set. Reused identically in `mitre_coverage.py`.

### 4. `GET /api/mitre/coverage?window_hours=0` (`routes_metrics.py:86-106`) → `compute_mitre_coverage()` (`engine/mitre_coverage.py:88-192`)
Tallies `Case.mitre: list[str]` (technique ids) against the bundled 697-technique corpus (`engine/mitre.py` / `threat/mitre_techniques.json`), validating each id (#9 — malformed/forged ids silently dropped, counted in `invalid_dropped`). `window_hours=0` = all fetched (up to 5000); >0 time-bounds by `created_at`/`detected_at`.
```json
{
  "corpus_version": "ATT&CK v17 (enterprise, compact)",
  "total_techniques": int, "covered_techniques": int, "coverage_pct": float,
  "invalid_dropped": int,
  "by_tactic": {"<tactic>": {"tactic","covered","total","coverage_pct","techniques":[{"id","name","case_count"}, ...]}},
  "top_techniques": [{"id","name","case_count"}, ...],   // top 25
  "truncated": bool, "store_total": int, "fetched": int,
  "window_hours": int
}
```

### 5. `GET /api/mitre/coverage/navigator.layer.json?window_hours=0` (`routes_metrics.py:109-126`) → `navigator_layer()` (`engine/mitre_coverage.py:209-287`)
A pure ATT&CK Navigator v4.5 layer dict (`{name, versions, domain, description, techniques:[{techniqueID, score, color, comment, enabled, metadata}], gradient, metadata:[...]}`), heat-colored 3-band (`#f1c40f`→`#e67e22`→`#c0392b`) by case_count relative to the max. Droppable straight into the Navigator UI or reused as a heatmap widget without it.

### 6. Cost/usage ledger (`stores/usage.py: UsageStore.summary()`, merged into `/api/metrics.cost`)
```json
{
  "window_hours": int, "total_cost": float, "total_tokens": int, "today_cost": float,
  "call_count": int, "currency": "USD",
  "by_surface": [{"key","cost","tokens","calls"}, ...],   // top 10 by cost desc
  "by_model": [{"key","cost","tokens","calls"}, ...],
  "by_role": [{"key","cost","tokens","calls"}, ...],
  "cost_over_time": [{"ts": epoch_millis, "cost": float}, ...],  // hourly buckets
  "top_cost_drivers": [{"key","cost","tokens","calls"}, ...]     // top 5 by_model
}
```
Computed with an exact (unbounded, `track_total_hits`) ES aggregation when available, else a full Python scan fallback — never truncated at 10k docs.

### Case fields available for dashboard/analytics (models.py:1104-1226, non-exhaustive but complete for metrics purposes)
`status` (CaseStatus), `disposition` (Disposition, orthogonal outcome axis), `verdict`/`confidence`/`risk_score`/`risk_breakdown`, `status_history` (append-only transitions), `escalation_level`, `decision_by` (AGENT/ANALYST/SYSTEM — the automation-rate signal), `agent_persona`, `playbook_id`, `mitre`, `feedback`, `tags`/`comments`/`assignee`, `severity_band`/`severity_source`/`impact_band`/`urgency_band`/`priority_level` (advisory triage axes, never fed to `decide()`), `detected_at`/`acknowledged_at`/`first_response_at` (lifecycle anchors), `campaign_id`/`detection_source` (Round 4), `source_id`/`source_name`/`source_breakdown`/`related_case_ids`/`cross_source_cluster_id` (multi-source), `member_event_ids` (raw events folded into this case — the raw-signal-to-case ratio), `automation_actions`, `knowledge_used`, `trigger_reason`, `notifications_sent`, `verdict_history`, `token_cost`, `case_number`.

### What's available today to power an "alerts-reduction" infographic (no dedicated endpoint exists yet — must be composed from the above)
- **Volume reduction (raw signal → case):** `len(Case.member_event_ids)` per case (summed across the fetched set) vs `total_cases`/`case_count` gives "N raw events collapsed into M cases." No endpoint currently sums `member_event_ids` across cases (`routes.py:3913-3916` and `threshold_tuner.py:354` only use it per-case); a dashboard would need a new aggregate or to compute it client-side from a case list fetch.
- **Triage-yield funnel:** `quality_metrics.alert_to_incident_ratio` (TP/total), `false_positive_rate`, `containment_rate`, `automation_rate` (`engine/metrics.py:252-293`) — directly express "how much noise was auto-resolved without a human."
- **Analyst time saved:** `feedback_stats.time_saved_minutes` (summed `FeedbackEntry.time_saved_minutes`) — an honest, human-graded (not estimated) time-saved number, though coverage-limited to graded cases (`graded_cases`/`feedback_count`).
- **Cost per case / per alert:** `cost.total_cost` / `total_cases` (or / `case_count`) from the merged usage summary — "cost to triage N alerts."
- **Trend over time:** `cases_per_day` (14-day daily case-creation trend, `/api/metrics`) and `cost.cost_over_time` (hourly cost) — can be paired to show volume vs. spend.
- **Backlog health:** `aging.queue_depth`/`age_buckets`/`closure_vs_arrival` — is the reduction keeping pace with arrivals.
- **Period-over-period proof:** `posture_metrics(...,compare="prev")`'s `compare` block already computes delta% for `alert_to_incident_ratio`, `false_positive_rate`, `escalation_rate`, `automation_rate`, `mttr_p50`, `mtta_p50`, `case_count` — ready-made "before vs. after automation" deltas for an infographic.
- **Coverage framing:** `mitre.coverage_pct`/`by_tactic` can contextualize "what fraction of the ATT&CK matrix these auto-triaged alerts touched."
- **Caveats for the redesign:** (1) `/api/metrics`'s case-derived fields are NOT time-windowed (fixed newest-2000 sample) while `/api/metrics/posture` IS — a redesigned dashboard should standardize on the posture endpoint's window semantics to avoid mismatched totals; (2) both endpoints cap the store fetch (2000 / 5000) and only posture/mitre honestly flag this via `truncated`/`store_total`/`fetched` — `/api/metrics` has no such flag; (3) all percentile/rate fields render the literal string `"—"` (DASH) when the underlying sample is empty, and `_delta_pct` can also return `null` for "new" — the UI must special-case both non-numeric sentinels, not just falsy-check.


---


<!-- ===== [18] Case model: severity/priority/impact + AI-vs-SIEM grading ===== -->

## Current-state reference: SIEM-graded vs AI-graded vs deterministic-code fields on `Case` (for UI overhaul item #9)

### 0. The three distinct authorities, precisely

There are **three different graders** whose outputs land on `Case`, and the codebase does not consistently label which is which:

1. **SIEM/EDR/source-asserted** — a number/label the connector's native rule engine put on the raw event, before it ever reaches this suite.
2. **AI/LLM-derived** — `verdict` + `confidence`, produced by the two-tier LLM (router → investigator → formatter), non-deterministic, a *recommendation*.
3. **Deterministic code** — `risk_score`/`risk_breakdown` (`engine/risk.py`), the close/escalate `status` decision (`engine/case_manager.decide()`), and the read-time advisory bands `severity_band`/`impact_band`/`urgency_band`/`priority_level` (`engine/priority.py`). None of these are AI; they are pure functions over recorded facts + operator policy.

### 1. Field-by-field, with WHO grades it and where

| Field (on `Case`, `backend/app/models.py`) | Grader | Set where | Notes |
|---|---|---|---|
| `verdict: Verdict \| None` (models.py:1123) | **AI (LLM)** | `agents/pipeline.py:598` (`VerdictResult` from `Formatter`/`Investigator`); `NEEDS_HUMAN` synthetic fallback at pipeline.py:367/416/665 on error/budget-fail | `Verdict` enum (constants.py:193) = `FALSE_POSITIVE`\|`TRUE_POSITIVE`\|`NEEDS_HUMAN`. Docstring: "a *recommendation*." |
| `confidence: float` (models.py:1124) | **AI (LLM)** | `agents/pipeline.py:599`, same `VerdictResult` | 0..1, LLM self-reported |
| `risk_score: float` (models.py:1122) | **Deterministic code** | `agents/pipeline.py:315,505` → `cluster.risk_score = breakdown.total`; computed by `engine/risk.compute_risk()` | Weighted blend: Reputation 30% (heaviest) / Volume 25% / Velocity 20% / Diversity 15% / Asset criticality 10% (`risk.py:76-86`). **Not AI** — pure math over `Cluster` + enrichment reputation. |
| `risk_breakdown: RiskBreakdown` (models.py:1163) | **Deterministic code** | same `compute_risk()` | volume/velocity/reputation/diversity/asset_criticality/total, each 0-100 |
| `trigger_reason.severity_max/min` (models.py TriggerReason:243-244) | **SIEM/source-asserted** | `engine/correlation.py:230-269` `_build_trigger_reason()`, from `meta.get("severity_min"/"severity_max")` computed off member events' native severity field | This is the ONLY place a raw source severity number is captured on the case |
| `severity_band`, `severity_source` (models.py:1176-1177, presentation-only) | **Mixed — labeled** | `engine/priority.severity_band_from_events()` (priority.py:143-184) | Reads `trigger_reason.severity_max`, projects onto 0-100 via the source's declared scale (`_scale_for_case`: OCSF 0-100 / Wazuh 0-15 / suite's own 0-10). Returns `source: "source_asserted"` when a real source severity existed, else `source: "derived"` (falls back to `risk_score`) — **this `source` flag is the one place in the whole system that explicitly says who graded a value.** |
| `impact_band` (models.py:1178) | **Deterministic code** | `engine/priority.impact_band()` (priority.py:187-202), via `risk._asset_criticality()` (risk.py:30-50) | Asset-criticality map/CIDR policy, not AI, not source |
| `urgency_band` (models.py:1179) | **Deterministic code** | `engine/priority.urgency_band()` (priority.py:205-218) | = `risk_score` blended with `escalation_level` |
| `priority_level` (models.py:1180, "P1".."P4") | **Deterministic code (ITIL lookup)** | `engine/priority.derive_priority()` (priority.py:221-258) | Impact×Urgency lookup against operator's `PriorityMatrix`; advisory only |
| `status: CaseStatus` (models.py:1129) | **Deterministic code (with policy)** | `engine/case_manager.decide()` (`case_manager.py:59-121`) — pure fn of `(verdict, confidence, risk_score, policy)`; applied in `CaseManager.apply()` | Non-negotiable #3: verdict *feeds* this, never decides it directly |
| `disposition: Disposition \| None` (models.py:1133) | **Ambiguous / not explicitly attributed** | Auto-populated from `verdict` in `case_manager.py:163-168` ONLY if unset ("Never overrides an analyst-confirmed disposition"); OR explicitly set by an analyst via `POST /api/cases/{case_id}/action` (`action=set_disposition`, routes.py:2983-2989, or `action=confirm_fp`, routes.py:2991-2995) | **Gap:** there is no `disposition_source`/`disposition_by` field — a UI cannot tell, from the `Case` alone, whether the current `disposition` was auto-derived-from-verdict or an analyst's explicit call. Only `status_history` entries (if the analyst action happened to log one) hint at it. |
| `decision_by: DecisionBy \| None` (models.py:1145) | **Explicit WHO, but only for the close/escalate act** | Set by `case_manager.decide()`'s outcome (`AGENT`\|`ANALYST`\|`SYSTEM`, constants.py:265-268) | This is WHO/WHAT made the **status transition**, not who graded severity/verdict/risk. It is the single clearest "who" field that exists today, and it's easy to conflate with "who set the verdict" (it isn't). |
| `feedback: list[FeedbackEntry]` (models.py:1155, `FeedbackEntry` at 367-382) | **Human grading the AI** | `POST /api/cases/{case_id}/feedback` (routes.py:3196) | This is the one place a human explicitly grades the AI: `analyst`, `assessment` (agree/partial/disagree), plus a **snapshot** `ai_verdict`/`ai_confidence` so the grade stays pinned to what was actually graded even if the case's live verdict later changes. Good model to reuse for "who graded this." |
| `status_history: list[StatusHistoryEntry]` (models.py:1140, entry at 394-406) | **Whoever moved the lifecycle** | Appended on every status transition | `by` field is free text (analyst name / "case_manager" / persona); the only append-only WHO trail on the case, but scoped to lifecycle, not to verdict/severity/risk grading |
| `agent_persona` (models.py:1150) | AI routing metadata | set by `agents/personas.py` deterministic router | Which specialist persona investigated — not a grade, but explains provenance of the verdict |

### 2. Endpoints that expose these, and their exact shape

- `GET /api/cases/{case_id}` (routes.py:2794) → raw `Case` (all fields above, undifferentiated).
- `GET /api/cases/{case_id}/triage` (`backend/app/api/routes_triage.py:133-150`) → **the one endpoint that already separates the graders**: `{case_id, found, chips: {risk, severity, impact, priority}}` via `engine.priority.derive_triage()`. Each chip carries `inputs.definition` (a plain-English "who computes this and why") and, for `severity`, `source: "source_asserted"|"derived"`.
- `GET /api/cases/{case_id}/rationale` (routes.py:3607, builder `_build_rationale` at routes.py:3982-4106) → `{verdict, confidence, status, decision_by, persona, playbook, memory_used, knowledge, enrichment, tools, reasoning, decision_rationale, mitre, evidence}`. `decision_rationale` is explicitly the **deterministic** `case_manager` audit text (labelled `actor == "case_manager"`); `reasoning` is explicitly the **LLM's** verdict-time reasoning excerpt. This endpoint is the backend's best existing "who said what" object but is not surfaced as a first-class WHO/WHY view in the case UI (only feeds the "Why" tab, `TraceTimeline`/`StageTimeline`).
- `POST /api/cases/{case_id}/feedback` (routes.py:3196) — human grades AI (`FeedbackEntry`).
- `POST /api/cases/{case_id}/action` (routes.py:2917), `disposition`/`set_disposition`/`confirm_fp` (routes.py:2982-2995) — analyst grades/overrides disposition; no distinct provenance field recorded beyond `status_history`.

### 3. webui: where these render, and the concrete confusions found

- `webui/src/soc/components/CaseTriageHeader.tsx` (RiskCard/SeverityCard/ImpactCard/PriorityCard, backed by `TriageChips` types in `webui/src/soc/pages/CaseDetail.api.ts:28-83`) is the **only** place in the whole UI that labels a value's provenance to the user: `SeverityCard` renders `"source-asserted"` vs `"derived (no source rating)"` (CaseTriageHeader.tsx:274,289-292). Risk/Impact/Priority chips show a `HelpTip` with `inputs.definition` text but no explicit "AI" vs "code" vs "SIEM" badge/icon.
- `webui/src/soc/pages/casedetail/OverviewPanel.tsx` renders `Verdict`/`Confidence` headline panels (line 562-563) and a secondary badge row (`VerdictBadge`, `StatusBadge`, `DispositionBadge`, `RiskBadge`, `ConfidenceBadge`, lines 568-580) with **no grader label at all** — an analyst cannot tell from these badges that Verdict/Confidence are LLM output while Risk is deterministic math. The only "who" text on the page is `"Decided by {humanizeToken(c.decision_by)}"` (OverviewPanel.tsx:853), which is about the status transition, not the verdict/severity/risk grading.
- **Concrete bug/inconsistency found** — `webui/src/soc/pages/Cases.tsx`:
  - `caseSeverity()` (Cases.tsx:154-159, feeds the **"Severity"** column, header literal `'Severity'` at line 885) reads `(c as Record<string, unknown>).severity`, a field that **does not exist** anywhere on the wire `Case` model (confirmed absent from both `backend/app/models.py` `Case` and `webui/src/lib/types.ts` `Case` interface, types.ts:1418+) — it always falls through to `c.risk_score`.
  - `aiSeverity()` (Cases.tsx:149-152, comment literally says `"AI-derived severity proxy: the normalised risk score"`) feeds the **"Severity (AI)"** column (header literal `'Severity (AI)'`, line 892) and also reads `c.risk_score`.
  - Net effect: the "Severity" and "Severity (AI)" columns in the Cases list **render the identical value** (`risk_score`) today, while their labels imply two different graders (source vs AI) — and neither label is accurate, since `risk_score` is **deterministic code**, not AI, and not source-asserted. This is the single clearest concrete instance of the exact confusion item #9 is meant to fix, and it directly contradicts the correctly-separated `severity_band_from_events()` logic already built for the CaseDetail triage chip.
- **Second inconsistency** — `Urgency` is computed two different ways with two different formulas: `engine/priority.urgency_band()` (server, `risk_score` + `escalation_level` only) vs. `webui/src/soc/components/badges.tsx` `computeUrgency()` (badges.tsx:523-548, client-side, adds age-since-`created_at` buckets: +25 if ≥24h, +15 if ≥8h, +5 if ≥2h, +20 if escalated). The Cases-list `UrgencyPill` (Cases.tsx:924-929) uses the client formula; the CaseDetail `PriorityCard`'s urgency sub-value uses the server `/triage` chip. Same word, two different numbers depending on which screen you're on.
- Badge components with no grader indicator at all: `SeverityBadge`, `RiskBadge`, `VerdictBadge`, `ConfidenceBadge`, `DispositionBadge`, `StatusBadge`, `UrgencyPill` (all in `webui/src/soc/components/badges.tsx`) — purely color/icon/text, none carry a source/AI/code provenance marker.

### 4. Design implication for the overhaul

A durable fix needs a **single shared "provenance" primitive** (e.g. a small `GradedBy` tag: `source` | `ai` | `code`) applied consistently to every chip/badge that currently looks like a peer of the others but isn't:
- `verdict`, `confidence` → tag `ai`.
- `risk_score`, `risk_breakdown`, `impact_band`, `urgency_band`, `priority_level`, `status` (the decide() outcome) → tag `code` (deterministic).
- `trigger_reason.severity_max/min`, `severity_band` when `severity_source == "source_asserted"` → tag `source`.
- `severity_band` when `severity_source == "derived"` → tag `code` (with the existing "(derived)" language, already correct on `CaseTriageHeader`'s `SeverityCard`).
- `disposition` needs a new provenance field (`disposition_source: "verdict_derived"|"analyst"`, mirroring `severity_source`'s pattern) since none exists today — currently indistinguishable at the `Case` level.
- The already-correct pattern to copy everywhere is `engine/priority.py`'s `{band, value, source, inputs.definition}` chip shape (routes_triage.py `GET /api/cases/{case_id}/triage`) — extend it (or its `inputs.definition` convention) to verdict/confidence/status/disposition displays so every triage-relevant number on every screen (Cases list, CaseHoverCard, Overview KPIs, Metrics, Standup) carries the same three-way (`source`/`ai`/`code`) label instead of only the CaseDetail chips having it.


---


<!-- ===== [19] Risk scoring engine (Active Risk Index math) ===== -->

## Reference: "Active Risk Index" / risk-score computation (for the UI (?) tooltip)

There are **three distinct risk numbers** rendered by the UI today, computed by two different formulas, sharing one underlying per-case primitive. Any tooltip copy must say *which* number it's explaining — they are not the same thing.

### 1. The base primitive — per-case deterministic `risk_score` (0-100)

File: `backend/app/engine/risk.py`, fn `compute_risk(cluster, prefs, reputation) -> RiskBreakdown` (full file, lines 1-96). Pure, synchronous, reproducible. Called from `backend/app/agents/pipeline.py:314-315` (real ingest path, `reputation` from enrichment) and `:504-505` (candidate/fallback path, `reputation=0.0`); result stored as `Cluster.risk_score` / `Cluster.risk_breakdown`, later copied onto `Case.risk_score` (`models.py:1122`) and `Case.risk_breakdown` (`models.py:1163`, type `RiskBreakdown`, `models.py:217-223`).

Formula — weighted average of 5 sub-scores, each independently normalised to 0-100, then combined by operator-configured weights and renormalised by the weight sum (so disabling a factor doesn't shrink the max):

```
total = ( wV·volume + wE·velocity + wR·reputation + wD·diversity + wA·asset ) / (wV+wE+wR+wD+wA)
```

Sub-scores (`risk.py:24-27, 56-74`):
- **volume** — `_log_norm(cluster.count, ref=50)` = `100·ln(1+count)/ln(1+50)`, clamped 100. Log-normalised so it levels off ~50 events.
- **velocity** — `count / (max(window_seconds,1)/60)` events/min, scaled to 100 at `10/min`, clamped. **Guard**: if `cluster.count < 3`, velocity = 0 outright (prevents a same-millisecond 2-event burst from pinning velocity at 100 via a near-zero window).
- **reputation** — passed in verbatim (already fetched via the Redis-cached `enrich` tool), clamped 0-100. 0 when the cluster's entity has no IP / no reputation signal.
- **diversity** — `100 · len(cluster.rule_values) / 5`, clamped 100 (distinct rule types that fired).
- **asset_criticality** — `_asset_criticality(entity.value, prefs)` (`risk.py:30-50`): if the entity is an IP inside any `Preferences.asset_networks` CIDR, the **max** matching CIDR criticality wins; else falls back to an exact-value lookup in `Preferences.asset_criticality` (dict); default 0 if uncatalogued.

**Default weights** (`backend/app/config.py:514-522`, class `RiskWeights`, operator-tunable): `volume=0.25, velocity=0.20, reputation=0.30 (heaviest), diversity=0.15, asset_criticality=0.10`.

Result shape `RiskBreakdown{volume, velocity, reputation, diversity, asset_criticality, total}` (all rounded to 2dp); `total` is the number shown as "risk_score" everywhere.

**Existing tooltip copy (ship it verbatim / reuse, don't re-author):**
- Backend-authored, served live per-case: `backend/app/engine/priority.py:280-290` (`derive_triage()` → `risk_chip.inputs.definition`).
- Webui fallback + factor-by-factor breakdown, authored to match: `webui/src/soc/components/CaseTriageHeader.tsx:157-173` — exported consts `RISK_HELP_TEXT` (short) and `RISK_FACTOR_HELP` (per-factor, used as the HelpTip on the "Factors" bars, line 191). A code comment there flags these two copies must stay in sync with `priority.py`'s string — a real drift risk to watch/fix in the overhaul (unify to one source, e.g. serve `RISK_FACTOR_HELP` content from the backend too).

### 2. Where the per-case number surfaces + its existing tooltip (already solved — reuse this pattern)

- **Endpoint**: `GET /api/cases/{case_id}/triage` (`backend/app/api/routes_triage.py:133-150`) → `derive_triage(case, prefs)` (`priority.py:261-334`) returns `{risk, severity, impact, priority}` chips, each with an `inputs` bag for a UI HelpTip. `risk_score`/`risk_breakdown` are passed through unchanged, never recomputed.
- **Component**: `RiskCard` inside `webui/src/soc/components/CaseTriageHeader.tsx:239-270` — renders `<RiskGauge score={score} size={108}/>` + `<RiskBreakdownBars breakdown={risk.breakdown}/>` (bars per factor, `:176-220`), with a `<HelpTip text={risk.inputs?.definition || RISK_HELP_TEXT} label="What risk means">` (`:258` in the file — the "?" already exists here) and a second HelpTip on the factor-bars header (`:191`).
- Tone/band cut-points used for THIS chip's accent colour: `toneForScore()` (`CaseTriageHeader.tsx:85-91`) — `>=80 critical, >=60 high, >=35 medium, >=15 low, else info` (a 5-band ladder, distinct from #3 below — noted divergence, see Inconsistency).

### 3. The dashboard/Overview "Active Risk Index" gauges — NOT the same formula, and NO tooltip today

Two separate call sites render a `RiskGauge` (`webui/src/soc/components/RiskGauge.tsx`, half-circle arc + numeric value; itself has no help affordance — only an SVG `<title>` for a11y, no `HelpTip`) under the label "Active risk index" / "Weighted risk pressure", but they compute **different numbers**:

**(a) Overview page** (`webui/src/soc/pages/Overview.tsx`) — `riskIndex` useMemo, lines 397-408:
```js
avg = metrics?.avg_risk_score > 0 ? metrics.avg_risk_score
      : mean(cases.map(k => k.risk_score ?? 0))          // client-side fallback
criticalDensity = derived.critical / (cases.length || 1)   // fraction of sampled cases in "critical" band
riskIndex = clamp(round(avg*0.7 + criticalDensity*100*0.3), 0, 100)
```
Rendered at `Overview.tsx:711`: `<RiskGauge score={riskIndex} size={200} label="Weighted risk pressure" />` inside a `DashboardGroup title="Active Risk Index" description="weighted pressure"` (`:708`) — **no HelpTip on this card at all** (grep confirms zero `HelpTip` usage in `Overview.tsx`). `derived.critical` comes from `bandOf(k.risk_score)` (`Overview.tsx:148-156`) counted per-case over the currently-loaded case sample — its OWN 5-band ladder (`>=80 critical, >=60 high, >=35 medium, >=15 low, else info`), **different cut points from `RiskGauge`'s own band** (see Inconsistency below).

**(b) Custom-dashboard widget** `gauge.active_risk` (`webui/src/soc/dashboard/widgets/risk.tsx:13-37`, registered `webui/src/soc/dashboard/registry.ts:254-255`, default-included for `analyst_tier1`/`analyst_tier2`/`default` roles at `registry.ts:394-404`) — simply:
```js
score = statNumber(data.avg_risk_score)   // straight passthrough, NO critical-density blend
```
Also **no HelpTip** (`grep HelpTip widgets/risk.tsx` → no hits).

**Backend source for `avg_risk_score`**: `GET /api/metrics?window_hours=24` (`backend/app/api/routes.py:1324-1332`) → `state.cases.list(limit=2000)` (up to 2000 most-recent cases, **all statuses, NOT time-windowed** — `window_hours` only scopes the separate `cost` sub-block) → `compute_metrics()` (`backend/app/engine/metrics.py:111-162`):
```python
risks = [c.risk_score for c in cases if isinstance(c.risk_score, (int, float))]
avg_risk_score = round(sum(risks)/len(risks), 1) if risks else 0.0   # metrics.py:122-123, 157
```
Plain arithmetic mean of `Case.risk_score` over up to 2000 cases (any status: open + closed + needs_human all included) — no severity weighting, no recency weighting, no exclusion of closed/benign cases.

The `cases` array Overview.tsx falls back on (when `avg_risk_score` is 0/missing) is instead `api.listCases({limit:200, from:'now-{hours}h'})` (`Overview.tsx:204`, comment `:182-187`/`:201-204`) — i.e. the TimeRangePicker-scoped, 200-cap, most-recent-first sample. So the Overview fallback mean and the metrics-endpoint mean can legitimately disagree (different sample, different window).

### Inconsistencies to flag/fix (relevant to the overhaul, not just the tooltip)

1. **Two different "Active Risk Index" formulas** render under the same name/label: Overview's `avg*0.7 + criticalDensity*100*0.3` vs. the dashboard widget's raw `avg_risk_score`. A tooltip must disclose which formula is on-screen; ideally unify to one.
2. **Three divergent severity-band ladders** all called "risk bands" in different files:
   - `RiskGauge`/`RiskBadge`/`CaseTriageHeader`'s `toneForScore` line up on `webui/src/soc/components/palette.ts` `scoreBand()` (`:224-227`): `>=74 critical, >=48 high, >=22 medium, else low` (4 bands, no "info").
   - `Overview.tsx`'s local `bandOf()` (`:149-156`) and `CaseTriageHeader.tsx`'s local `toneForScore()` (`:85-91`): `>=80 critical, >=60 high, >=35 medium, >=15 low, else info` (5 bands, incl. "info").
   A code comment in `CaseTriageHeader.tsx:242-244` already flags this exact drift ("the 5-band toneForScore read 'info' … while the gauge collapses <15 into 'low' … coloured the same number differently").
3. **No tooltip infrastructure at all on the two dashboard gauges** (Overview `DashboardGroup`/`RiskGauge` at `Overview.tsx:708-738`, and `RiskGaugeWidget` at `widgets/risk.tsx:13-37`) — the `HelpTip` pattern, copy, and backend `inputs.definition` payload only exist for the per-case chip (`GET /api/cases/{id}/triage`). Adding the (?) to the aggregate gauges means either (a) reusing `RISK_HELP_TEXT`/`RISK_FACTOR_HELP` from `CaseTriageHeader.tsx` plus new copy for the aggregation step (mean + critical-density blend, sample size/window caveat), or (b) a new backend-served definition string parallel to `priority.py`'s pattern.
4. `avg_risk_score` (backend) is an unweighted mean across **all** cases regardless of status/age — a tooltip claiming "current risk pressure" should disclose it's a lifetime/2000-case-cap mean, not filtered to open/recent cases (that filtering only happens client-side in Overview's fallback branch, not in the primary `metrics.avg_risk_score` path the widget uses).

### Key files/symbols for the tooltip implementation
- `backend/app/engine/risk.py` — `compute_risk`, `_log_norm`, `_asset_criticality`, `_VOLUME_REF=50`, `_VELOCITY_REF=10.0`, `_DIVERSITY_REF=5`.
- `backend/app/config.py:514-522` — `RiskWeights` defaults.
- `backend/app/engine/priority.py:261-334` — `derive_triage`, existing `risk_chip.inputs.definition` copy.
- `backend/app/engine/metrics.py:111-162` — `compute_metrics`, `avg_risk_score`.
- `backend/app/api/routes.py:1324-1332` — `GET /api/metrics`.
- `backend/app/api/routes_triage.py:133-150` — `GET /api/cases/{case_id}/triage`.
- `webui/src/soc/components/RiskGauge.tsx` — the gauge component (props `score,label,size`; no help affordance yet).
- `webui/src/soc/components/CaseTriageHeader.tsx:157-220,239-270` — `RISK_HELP_TEXT`, `RISK_FACTOR_HELP`, `RiskBreakdownBars`, `RiskCard` (the one place a (?) already exists — model any new tooltip on this).
- `webui/src/soc/pages/Overview.tsx:148-156,397-408,707-738` — `bandOf`, `riskIndex` calc, the gauge's JSX (no tooltip).
- `webui/src/soc/dashboard/widgets/risk.tsx:13-37` — `RiskGaugeWidget` (no tooltip).
- `webui/src/soc/components/palette.ts:216-236` — `scoreBand`, `SCORE_BANDS` (the "canonical" 74/48/22 ladder per its own comment, yet not what Overview/CaseTriageHeader's local band helpers use).


---


<!-- ===== [20] Feedback model + endpoints ===== -->

## Current-state reference: analyst feedback (eval/quality loop) and the close flow

### 1. Data model — `FeedbackEntry` (backend `app/models.py:367-382`)

```python
class FeedbackEntry(BaseModel):
    ts: str = Field(default_factory=iso_now)
    analyst: str = ""
    assessment: str = ""                    # agree | partial | disagree
    accuracy: float = 0.0                   # 0..1
    reasoning_quality: float = 0.0          # 0..1
    action_appropriateness: float = 0.0     # 0..1
    actual_outcome: str = ""                # true_positive|false_positive|true_negative|false_negative|unknown
    time_saved_minutes: int = 0
    comment: str = ""
    ai_verdict: str = ""                    # snapshot of the AI verdict that was graded
    ai_confidence: float = 0.0
```

Attached append-only on `Case` (`models.py:1154-1155`):
```python
feedback: list[FeedbackEntry] = Field(default_factory=list)
```
`ai_verdict`/`ai_confidence` are server-stamped snapshots (not client-supplied) — see §2.

### 2. `POST /api/cases/{case_id}/feedback` (backend `app/api/routes.py:3196-3225`)

Request body — `FeedbackBody` (`routes.py:3170-3178`), **no RBAC/auth gate on this route** (unlike `/action`, which enforces `cases:close`/`cases:write`):
```python
class FeedbackBody(BaseModel):
    analyst: str = ""
    assessment: str = ""                  # agree | partial | disagree
    accuracy: float = 0.0
    reasoning_quality: float = 0.0
    action_appropriateness: float = 0.0
    actual_outcome: str = ""              # true_positive|false_positive|true_negative|false_negative|unknown
    time_saved_minutes: int = 0
    comment: str = ""
```
Handler behavior (`routes.py:3196-3225`):
- 404 if case not found.
- Builds a `FeedbackEntry`, clamping `accuracy`/`reasoning_quality`/`action_appropriateness` to `[0,1]` and `time_saved_minutes` to `≥0`; **`ai_verdict`/`ai_confidence` are snapshotted server-side from the CURRENT `case.verdict`/`case.confidence` at submit time** — not passed by the client.
- `case.feedback.append(entry)`; `case.updated_at = iso_now()`; `state.cases.save(case)`.
- Audits `ActionType.FEEDBACK` (surface `"case"`, actor = `body.analyst or "analyst"`), summary `"assessment=… outcome=… accuracy=…"`.
- Returns the **full updated `Case`** (`case.model_dump(mode="json")`), not just the entry.
- This route is entirely independent of case lifecycle/status: it can be called on a case in ANY status (open, closed, etc.) and never touches `status`/`disposition`/`decide()` — it is purely additive/append-only.

Also: `case.feedback` is rendered into the Markdown case export (`routes.py:3374-3376`, inside `GET /api/cases/{id}/export?format=md`, under a `## Analyst feedback` section).

### 3. `GET /api/feedback/stats` (backend `app/api/routes.py:1335-1338`, aggregation in `app/engine/metrics.py:85-108`)

```python
@router.get("/feedback/stats")
async def feedback_stats_route(state=Depends(get_state)) -> dict[str, Any]:
    cases, _total = await state.cases.list(limit=2000)
    return feedback_stats(cases)
```
`feedback_stats(cases)` flattens `entries = [fb for c in cases for fb in (c.feedback or [])]` and returns:
```python
{
  "graded_cases": int,              # cases with ≥1 feedback entry
  "feedback_count": int,            # total entries across all cases
  "agreement_rate": float,          # (agree_count + 0.5*partial_count) / n, rounded 4dp
  "avg_accuracy": float,            # mean of accuracy, rounded 4dp
  "avg_reasoning_quality": float,   # mean, rounded 4dp
  "avg_action_appropriateness": float,  # mean, rounded 4dp
  "time_saved_minutes": int,        # sum
  "outcome_distribution": {str: int},  # Counter of non-empty actual_outcome values
}
```
Empty-state (no entries) returns zeroed fields with `outcome_distribution: {}`. This is also nested as `feedback` inside `GET /api/metrics` output structure and consumed by `webui` `Metrics` type (`webui/src/lib/types.ts:1867 feedback: FeedbackStats`).

### 4. Frontend contracts (webui `src/lib/`)

- `CaseFeedback` interface (`types.ts:1358-1373`) mirrors `FeedbackEntry` (optional fields, `assessment` widened to `'agree'|'partial'|'disagree'|string`); attached at `Case.feedback?: CaseFeedback[]` (`types.ts:1459-1460`).
- `CaseFeedbackInput` (`api.ts:96-105`) — the POST body type, identical shape to `FeedbackBody` (no `ai_verdict`/`ai_confidence`, no `ts` — server-set).
- `api.caseFeedback(caseId, body)` → `api.ts:1023` → `POST cases/{id}/feedback`.
- Separately, `api.caseActionExec(caseId, input: CaseActionInput)` → `api.ts:1042-1043` → `POST cases/{id}/action` (the lifecycle/close endpoint, §5). **These are two distinct API calls today; feedback is never sent alongside a close action.**

### 5. The close flow today — `POST /api/cases/{case_id}/action` (backend `routes.py:2806-3070+`)

`CaseAction` body (`routes.py:2806-2824`):
```python
class CaseAction(BaseModel):
    action: str                # close | reopen | escalate | confirm_fp | acknowledge |
                                # hold | resume | resolve | set_disposition | deescalate | set_status
    note: str = ""
    analyst: str = "analyst"
    reason: str = ""
    resolution: str | None = None
    assignee: str | None = None
    priority: str | None = None
    tags: list[str] | None = None
    disposition: str | None = None   # set_disposition / close-with-disposition target
    status: str | None = None        # set_status target
    level: int | None = None         # escalate level
```
**Notably absent from `CaseAction`: any of the feedback fields** (`assessment`, `accuracy`, `reasoning_quality`, `action_appropriateness`, `actual_outcome`, `time_saved_minutes`, `comment`). The close/resolve/confirm_fp path (`_perform_case_action`, `routes.py:2940-3070+`) never writes to `case.feedback` and never calls `state.audit.record(ActionType.FEEDBACK, ...)` — grading is 100% decoupled from closing today.

RBAC: `close`/`confirm_fp`/`resolve`/`reopen` require grant `cases:close` (`_CLOSE_ACTIONS`, `routes.py:2851`); everything else `cases:write`; `set_status`/other actions targeting a terminal status (`RESOLVED`/`CLOSED`) are upgraded to require `cases:close` too (`_case_action_grant`, `routes.py:2878-2896`). This is stricter than the feedback route, which has no RBAC check at all.

On `action in ("close", "confirm_fp")` the handler additionally (`routes.py:3057-3067+`): indexes the resolved case into RAG (`state.rag.index_resolved_case`) and drafts a HITL suppression `Proposal` — both fail-open/best-effort, unrelated to feedback.

### 6. Frontend close UI — the unified "Close with disposition" dialog

- `ActionKind` (`webui/src/soc/pages/casedetail/shared.tsx:46-61`) includes a UI-only verb `close_disposition` that maps via `ActionDef.wireAction` to the existing backend `close` verb (never invents a new backend verb, per #3).
- `ActionField` (`shared.tsx:62`): `'resolution' | 'tags' | 'assignee' | 'priority' | 'disposition' | 'reason'` — the exhaustive set of fields the polymorphic `ConfirmActionDialog` can render for ANY lifecycle action. **No feedback-shaped field (assessment/accuracy/reasoning_quality/action_appropriateness/actual_outcome/time_saved_minutes) exists in this enum.**
- `ConfirmActionDialog` (`webui/src/soc/pages/casedetail/ConfirmActionDialog.tsx`) is the ONE dialog driving every lifecycle action; for `close_disposition` it renders (in order): Disposition (required, gates Submit), Resolution (optional), Tags, Assignee, Priority, Reason, and an always-present Analyst note (`note`) — then calls `onSubmit`, and the orchestrator POSTs via `wireAction ?? key` (i.e. `close`) so `decide()`/`apply()` still runs server-side (#3 contract, stated in the file's own header comment).
- Feedback capture today lives on a **separate tab**: `FeedbackTab` (`webui/src/soc/pages/casedetail/FeedbackPanel.tsx`), explicitly scoped ("Rate the AI decision") to grading ONLY — assessment (agree/partial/disagree buttons), 3 star-ratings (accuracy/reasoning/action-appropriateness, converted `n/5 → 0..1` via `starsToScore`), Actual outcome select (`true_positive|false_positive|true_negative|false_negative`, no "unknown" sent), optional Analyst id, a `LabeledSlider` for time-saved (0-120 min, step 5), and a Comment textarea. Submits independently via `api.caseFeedback` (its own network round-trip, its own `onUpdated(next)` case refresh) — **not part of the close submit path**, so an analyst can close a case without ever grading it, or grade without closing.

### 7. Implication for folding feedback into close (#10)

To merge these flows, the overlap/gaps to reconcile:
- **Two separate endpoints** (`/feedback` no-RBAC vs `/action` RBAC-gated `cases:close`) with two separate audit `ActionType`s (`FEEDBACK` vs `STATUS`) and two separate `Case` sub-lists (`case.feedback` vs `case.status_history`/`case.history`) — folding into one submit means either (a) the frontend fires both requests on one dialog submit, or (b) `CaseAction`/`_perform_case_action` gains optional feedback fields and internally also appends a `FeedbackEntry` + fires the `FEEDBACK` audit record when action is `close`/`confirm_fp`/`close_disposition`→`close`.
- `ai_verdict`/`ai_confidence` are stamped from `case.verdict`/`case.confidence` **at feedback-submit time** — if feedback submission moves to happen after the close mutation (or in the same handler after `case.status`/`disposition` is set), verify ordering so the snapshot still reflects the AI's original verdict, not any close-time override.
- Frontend: `ActionField` enum + `ConfirmActionDialog` would need new optional fields (assessment/quality stars/outcome/time-saved/comment) gated to the `close_disposition`/`confirm_fp` action kinds only (not `hold`/`escalate`/etc.), and `CaseActionInput` (api.ts) would need the corresponding optional fields alongside the existing `CaseFeedbackInput` shape.
- `FeedbackTab` currently double-serves as both a grading UI AND a historical log (`priorFeedback` list of past gradings) — if grading moves into the close dialog, the tab likely becomes read-only history, or stays as a secondary/late-grading path for cases already closed (e.g. post-close outcome confirmation once ground truth is known later, which the current design already anticipates via `actual_outcome`/`time_saved_minutes` being freely re-submittable after close since `/feedback` has no status gate).


---


<!-- ===== [21] Alerts → cases funnel data (for the infographic) ===== -->

## Current-state reference: alert/case funnel metrics (TLSOC, `Testing` branch)

Scope: what counts exist end-to-end today (raw ingestion → clusters → cases → verdict/disposition), exact symbols/endpoints, and precisely what is missing to build a "total alerts by severity → what the AI reduced it to" funnel.

### 1. Raw ingestion counts — exist only as transient, per-cycle, unaggregated numbers; NO severity breakdown

- `Poller.poll_once()` (`backend/app/engine/poller.py:213-378`) computes a `stats` dict per poll tick: `polled`, `new`, `window_events`, `funnel_routed`, `clusters`, `investigated`, `candidates`, `attached`, `ignored`, `suppressed`, optional `cross_source_linked` (built at `poller.py:289-291`, filled by `handle_clusters()`).
- `IngestService.ingest_events()` (push path, `backend/app/engine/ingest.py:438-514`) computes the equivalent for pushed batches: `received`, `clusters`, `investigated`, `candidates`, `attached`, `suppressed`, `ignored`.
- `handle_clusters()` (`backend/app/engine/ingest.py:178-256`) is the single stats producer shared by both paths: `{"clusters", "investigated", "candidates", "attached", "suppressed", "ignored"}`.
- **These numbers are never persisted or aggregated.** They are:
  - Written into ONE audit row per poll/ingest cycle as a free-text `result_summary` string (e.g. `"polled=5 new=3 clusters=1 investigated=1 candidates=0 attached=0"`, `poller.py:372-377`; `"received=… clusters=… investigated=… candidates=… attached=…"`, `ingest.py:508-512`). `AuditDoc` (`backend/app/models.py:1232-1244`) has no structured numeric fields — only `result_summary: str | None`, so these are not queryable/summable without string-parsing, and **severity never appears in the string at all**.
  - Returned as the HTTP response body of `POST /api/poll` (`backend/app/api/routes.py:3733-3741`) — a **manual, one-shot** trigger; the value is the stats for that single cycle only, not a running total.
  - Discarded entirely by the background loop (`Poller._run`, `poller.py:385-404`, and `PollerManager` loop, `backend/app/engine/poller_manager.py:340-350` — both call `poll_once()`/`ingest_events()` without capturing/aggregating the return value).
- **No severity field exists anywhere in these stats.** `RawEvent.severity: float` (`backend/app/models.py:67`) is set per event from `Preferences.severity_field` / OCSF `severity_score` (`RawEvent.from_hit`/`from_ocsf`, `models.py:99-136`), but nothing buckets or counts events by severity at ingest.
- The only place raw events persist in-process at all is `IngestService._recent` (`ingest.py`, a per-push-source `collections.deque(maxlen=...)` live-tail ring buffer) — for browse/live-tail UI only, not for metrics.
- Conclusion: **there is no "total alerts/events ingested" counter, cumulative or otherwise, and no severity breakdown of ingested volume.** The log surface itself (Elasticsearch/OpenSearch/OCSF store) presumably holds the true volume, but the backend never runs an aggregation query against it for this purpose — `GET /api/logs` (`routes.py:582-654`) and `GET /api/sources/{id}/logs` are row-browse endpoints hard-capped at 200 rows, not aggregations.

### 2. Cluster/case-formation counts — exist, but only per-cycle (see §1); no durable "alerts reduced to N cases" ratio

`ignored` / `suppressed` / `attached` / `investigated` / `candidates` are the only drop/dedup counters that exist, and they live entirely within the ephemeral per-cycle stats above. There is no lifetime or windowed rollup of "N alerts arrived → M formed clusters → K became new cases vs attached to existing cases."

### 3. Case-level counts — this is what actually exists and is queryable today

`GET /api/metrics` (`backend/app/api/routes.py:1324-1332`, calls `compute_metrics()` in `backend/app/engine/metrics.py:111-162`) over `state.cases.list(limit=2000)` (**hard cap 2000**, no time filter beyond default):
- `total_cases`, `open_cases`, `needs_human_cases`, `closed_cases`
- `by_status: dict[str,int]` (all `CaseStatus` values)
- `by_disposition: dict[str,int]` (all `Disposition` values — true_positive/false_positive/benign/suspicious/duplicate/undetermined)
- `by_verdict: {TRUE_POSITIVE, FALSE_POSITIVE, NEEDS_HUMAN, none}` (`VerdictBreakdown`, mirrored in `webui/src/lib/types.ts:1840-1847`)
- `persona_usage`, `playbook_usage`, `avg_risk_score`, `mttr_minutes`, `resolved_count`, `cases_per_day`, `feedback` (agreement/accuracy rollup)
- webui type: `Metrics` interface, `webui/src/lib/types.ts:1849-1872`.

`GET /api/metrics/posture?window_hours=&compare=` (`backend/app/api/routes_metrics.py:62-83`, calls `posture_metrics()` in `metrics.py:497-570`) over up to the newest 5000 cases (`_STORE_FETCH_LIMIT = 5000`, `routes_metrics.py:43`), window-filtered:
- `lifecycle_intervals()` (`metrics.py:206-245`): MTTA/MTTR/dwell as p50/p90/mean/count, each honestly `DASH`-labelled when no case ever made that transition.
- `quality_metrics()` (`metrics.py:252-293`) — **the closest thing to a funnel today**, but over cases only, no severity axis:
  - `total_cases`, `verdicted_cases`, `true_positive_cases`, `false_positive_cases`, `needs_human_cases`
  - `escalated_cases` (status==ESCALATED OR `escalation_level>0` OR ever transitioned to ESCALATED)
  - `terminal_cases` (status in `TERMINAL_CASE_STATUSES` = RESOLVED/CLOSED, `constants.py:237-240`)
  - `auto_closed_cases` = terminal cases where `decision_by == DecisionBy.AGENT` (`constants.py:265-268`) — this is the exact count of AI auto-closes (FP-by-default, or opt-in TP auto-close; NEEDS_HUMAN can never appear here, enforced in `case_manager.apply()`, `backend/app/engine/case_manager.py:141-144`)
  - Ratios: `alert_to_incident_ratio` (tp/total), `false_positive_rate` (fp/verdicted), `escalation_rate`, `containment_rate`, `automation_rate` (auto_closed/terminal)
- `aging()` — queue depth, age buckets, oldest-N, arrivals vs closures.
- `sla_metrics()` — breach/at-risk counts vs `Preferences.sla` targets.
- `truncation_marker()` (`metrics.py:480-494`) — honestly flags `truncated: true` when the store holds more cases than were fetched (so any of the above can be a lower bound over large corpora).
- No corresponding hand-maintained TS interface in `webui/src/lib/types.ts` for this payload (types come from generated `webui/src/lib/api-types.gen.ts`); consumed via `webui/src/soc/hooks/usePosture.ts` / `webui/src/soc/pages/Metrics.posture.api.ts`.

### 4. Severity on a Case — the field exists on the model but is **never populated** in the write path

- `Case.severity_band: str | None` (`models.py:1176`), `severity_source` (`models.py:1177`) are declared "advisory" fields, but a repo-wide grep of `severity_band\s*=` finds **zero assignments anywhere in `app/`** — no pipeline/investigator/formatter code ever sets them on a persisted case. They stay `None` forever on real cases.
- The only place severity is derived is `severity_band_from_events()` (`backend/app/engine/priority.py:143-186`), part of `derive_triage()` (`priority.py:261-` ), which reads `case.trigger_reason.severity_max`/`severity_min` (source-asserted min/max severity of the cluster's *member events*, set at correlation time in `backend/app/engine/correlation.py:127,240,269` → `TriggerReason.severity_max/min`, `models.py:243-244`) and normalises it via a scale-aware heuristic (`_scale_for_case`, `priority.py:72-113` — handles OCSF 0-100, Wazuh 0-15, suite 0-10, or falls back to a magnitude heuristic).
- This is **read-time only, per-case, on demand**: the sole consumer is `GET /api/cases/{case_id}/triage` (`backend/app/api/routes_triage.py:133-152`) — a single-case endpoint. **No route ever calls `severity_band_from_events()`/`derive_triage()` across the whole case list**, so there is no aggregate "cases by severity" tally anywhere server-side. (`engine/campaigns.py:214` and `engine/shift_report.py:121,179` also read `case.severity_band` directly off the model — i.e. they silently get `None`/empty for every real case today, since nothing ever writes it.)
- The OCSF severity scale itself: `severity_id` 0..6 → `OCSF_SEVERITY_TO_SCORE = {0:0, 1:10, 2:30, 3:50, 4:75, 5:90, 6:100}` (`backend/app/constants.py:618`), used by `severity_id_to_score()`/`score_to_severity_id()` (`constants.py:92-100`). This is the canonical severity taxonomy connectors normalise into, but it is not tallied anywhere either.

### 5. What the webui actually shows today (closest existing "funnel-ish" visual)

`webui/src/soc/pages/Overview.tsx`:
- Fetches `api.listCases({ limit: 200, from: 'now-{hours}h' })` (`Overview.tsx:204`) — **hard-capped at 200 cases**, newest-created-first, within the selected time range.
- `bandOf(risk_score)` (`Overview.tsx:148-156`) derives a **client-side** severity band from `risk_score` (thresholds: ≥80 critical, ≥60 high, ≥35 medium, ≥15 low, else info) — this is NOT `Case.severity_band` (unpopulated, see §4) and NOT the source-asserted severity (`trigger_reason.severity_max`); it's a proxy over the deterministic risk score.
- "Open cases by severity" widget (`Overview.tsx:741` `<DashboardGroup title="Open cases by severity" …>`) tallies this band **only over currently-OPEN cases** in the 200-row/window-capped sample (`derived` memo, `Overview.tsx:287-`), with deep-links to a severity-filtered Cases view (`Overview.tsx:474-488, 760`).
- `GET /api/cases` (`backend/app/api/routes.py:2766-2791`) itself caps `limit` at 200 server-side (`min(limit, 200)`, line 2780) and, when a `from`/`to` window is applied, recomputes `total = len(cases)` **over the already-capped page** (explicitly flagged as a known gap in the code comment at `routes.py:2785-2787`: "Full store-level windowing … is a follow-up handoff"). So even the case-side counts a UI overhaul would reuse are a bounded sample, not an authoritative total, once volume exceeds ~200/2000/5000 depending on which endpoint is used.
- `webui/src/soc/dashboard/widgets/mix.tsx` has an "open by verdict" bar-list widget (reads `Metrics.by_verdict`) but no severity axis and no ingestion-volume axis.
- No `Funnel`/funnel component exists anywhere in `webui/src` (only an unrelated hit on `Baseline.tsx`).

### 6. Net gap list — what must be added to build "total alerts by severity → what the AI reduced it to"

1. **A durable, cumulative (or windowed) count of raw ingested alerts/events by severity band**, sourced from the log surface itself (an ES/OCSF aggregation) or from a new counter incremented in `handle_clusters()`/`ingest_events()`/`poll_once()` — today these functions see individual `RawEvent.severity` values but never bucket or persist them.
2. **A structured (non-string) audit/metrics record** for poll/ingest cycles, or a dedicated rolling counter store, since `AuditDoc.result_summary` is free text and the per-cycle `stats` dicts are discarded after each tick.
3. **Populate `Case.severity_band`/`severity_source` at write time** (currently dead fields) or add a new aggregate function alongside `compute_metrics()`/`quality_metrics()` that runs `severity_band_from_events()` across the full case list (today it only runs per-case, on demand, via `/api/cases/{id}/triage`).
4. **A severity axis crossed with outcome** (auto-closed-FP / escalated / needs-human / true-positive) — today `quality_metrics()` gives verdict/disposition/auto-close counts with NO severity dimension, and the severity widget on Overview gives severity with NO outcome dimension (and is open-cases-only, client-side, risk_score-derived, not true severity).
5. **Remove/raise the sampling caps** that would otherwise silently truncate a funnel: `GET /api/cases` limit≤200 with page-bounded `total`; `GET /api/metrics` case fetch capped at 2000; `GET /api/metrics/posture` capped at 5000 (this one at least self-reports via `truncation_marker()`/`truncated`/`store_total` — the pattern to replicate for any new funnel endpoint).

### Key files for this work
- `backend/app/engine/metrics.py` (case-side aggregation — the pattern to extend)
- `backend/app/engine/priority.py` (severity derivation — currently per-case only)
- `backend/app/engine/ingest.py`, `backend/app/engine/poller.py`, `backend/app/engine/poller_manager.py` (ingestion-side counters — currently ephemeral)
- `backend/app/api/routes.py:1324-1332` (`/api/metrics`), `backend/app/api/routes_metrics.py` (`/api/metrics/posture`, `/api/mitre/coverage`)
- `backend/app/models.py` (`Case`, `RawEvent`, `TriggerReason`, `AuditDoc`)
- `backend/app/constants.py` (`Verdict`, `CaseStatus`, `Disposition`, `DecisionBy`, `ActionType`, `OCSF_SEVERITY_TO_SCORE`)
- `webui/src/soc/pages/Overview.tsx` (existing severity-band UI pattern, client-derived)
- `webui/src/lib/types.ts:1840-1872` (`VerdictBreakdown`, `Metrics`)


---


<!-- ===== [22] Backend API route inventory ===== -->

## `/api` Endpoint Inventory (Testing branch, `backend/app/api/`)

All routers use `APIRouter(prefix="/api")`; mounted in `main.py:102` (`app.include_router(router, dependencies=[Depends(require_auth)])`) plus each feature router at `main.py:111`. Endpoint list below is `METHOD path` — purpose — `file:line` of the `@router.*` decorator.

### `routes.py` (the core UI-contract router — ~3700 lines)
- `GET /health` — liveness + store_type/version/setup_complete — `routes.py:81`
- `GET /events` — SSE EventBus subscribe (notifications/cases/agent topics, Last-Event-ID replay; default-OFF → 204) — `routes.py:105`
- `GET /setup/status` — public first-run/OOBE status (wizard + auth fields) — `routes.py:177`
- `POST /setup/secrets` — push global secrets (exclude_unset; null clears) — `routes.py:219`
- `POST /setup/complete` — mark wizard done, start poller if enabled — `routes.py:229`
- `GET /connectors` — list connector types + wizard field schemas — `routes.py:262`
- `GET /connectors/{source_type}` — one connector's schema — `routes.py:269`
- `POST /connectors/test` — test a connector config before saving — `routes.py:282`
- `GET /sources` — list configured source instances — `routes.py:292`
- `POST /sources` — create/update a source (`SourceUpsert`) — `routes.py:300`
- `DELETE /sources/{source_id}` — remove a source — `routes.py:350`
- `POST /sources/{source_id}/secrets` — set per-source connector secrets — `routes.py:365`
- `POST /sources/{source_id}/analyze-sample` — suggest field mappings from an UNTRUSTED sample (never persisted) — `routes.py:399`
- `POST /ingest/{source_id}` — push/webhook/HEC ingestion endpoint → OCSF → pipeline — `routes.py:423`
- `GET /sources/{source_id}/logs` — browse bounded recent logs for one source (pull=scoped search, push=live-tail ring) — `routes.py:487`
- `GET /logs` — unified scatter-gather browse across all browse-capable sources — `routes.py:582`
- `GET /sources/health` — per-source health/buffer-depth/last-poll status — `routes.py:696`
- `GET /sources/{source_id}/feeds` — resolved effective per-source feeds (Wave 6) — `routes.py:763`
- `GET /settings` — full prefs + configured-secret booleans — `routes.py:807`
- `GET /settings/schema` — settings UI schema — `routes.py:816`
- `PUT /settings` — deep-merge update Preferences — `routes.py:911`
- `POST /settings/case-id/preview` — preview a case-ID nomenclature template — `routes.py:964`
- `GET /settings/{section}` — one settings section — `routes.py:980`
- `POST /chat` — the one chat engine entry point — `routes.py:1000`
- `POST /investigate` — trigger investigation for a cluster/selection — `routes.py:1076`
- `POST /overview` — overview summary for a source/query — `routes.py:1097`
- `GET /models` — providers + configured-secret status — `routes.py:1109`
- `GET /personas` — list AgentPersona roster — `routes.py:1118`
- `GET /runbooks` — list loaded Markdown runbooks — `routes.py:1137`
- `GET /proposals` — list HITL threshold/automation proposals (optional status filter) — `routes.py:1160`
- `POST /proposals/{proposal_id}/approve` — approve a proposal — `routes.py:1174`
- `POST /proposals/{proposal_id}/reject` — reject a proposal — `routes.py:1239`
- `GET /playbooks` — list Markdown playbooks — `routes.py:1262`
- `POST /playbooks/reload` — atomic hot-reload of playbooks dir — `routes.py:1290`
- `GET /playbooks/selection/{case_id}` — why a case's playbook was selected (audit trail) — `routes.py:1300`
- `GET /metrics` — verdict/status/persona/playbook mix, MTTR, trend, feedback rollup — `routes.py:1324`
- `GET /feedback/stats` — AI-verdict feedback agreement/quality stats — `routes.py:1335`
- `GET /demo/status` — Demo Mode status — `routes.py:1356`
- `POST /demo/enable` — enable Demo Mode (seeded org, sandboxed policy) — `routes.py:1361`
- `POST /demo/reset` — reset demo data (admin) — `routes.py:1383`
- `POST /demo/disable` — disable Demo Mode (admin) — `routes.py:1391`
- `POST /auth/login` — password login (sets cookie, may require MFA step) — `routes.py:1500`
- `GET /auth/me` — current auth/session identity — `routes.py:1556`
- `POST /auth/logout` — logout, revokes current sid — `routes.py:1578`
- `POST /auth/change-password` — change own password — `routes.py:1606`
- `GET /sessions` — caller's own sessions (current flagged) — `routes.py:1674`
- `POST /sessions/{sid}/revoke` — revoke one of caller's own sessions — `routes.py:1689`
- `POST /sessions/revoke-others` — revoke all other sessions of caller — `routes.py:1704`
- `POST /auth/refresh` — refresh-token rotation → new access token — `routes.py:1728`
- `POST /auth/reauth` — step-up re-auth for `require_fresh_auth` gates — `routes.py:1794`
- `GET /account/activity` — caller's recent audit/account activity — `routes.py:1815`
- `GET /admin/sessions` — all sessions (admin) — `routes.py:1830`
- `POST /admin/sessions/{sid}/revoke` — admin revoke one session — `routes.py:1840`
- `POST /admin/users/{username}/revoke-all` — admin revoke all sessions of a user — `routes.py:1858`
- `GET /account/me` — caller's own account/profile view — `routes.py:1955`
- `PUT /account/me` — update own profile (display_name/alias/timezone/…) — `routes.py:1994`
- `PUT /me/avatar` — update own avatar (data-url, magic-byte checked) — `routes.py:2041`
- `POST /auth/mfa/setup` — begin TOTP enrollment (returns secret+QR+recovery codes once) — `routes.py:2104`
- `POST /auth/mfa/confirm` — confirm TOTP code, activate MFA — `routes.py:2134`
- `POST /auth/mfa/verify` — verify TOTP/recovery code during login (2nd phase) — `routes.py:2181`
- `POST /auth/mfa/disable` — disable own MFA — `routes.py:2261`
- `GET /auth/sso/providers` — public list of enabled SSO providers — `routes.py:2330`
- `GET /auth/sso/authorize` — start OIDC code-exchange flow — `routes.py:2340`
- `GET /auth/sso/callback` — OIDC callback → session — `routes.py:2368`
- `POST /auth/sso/providers/{provider_id}/secret` — set an SSO provider's client secret — `routes.py:2521`
- `GET /roles` — role→resource→actions permission matrix — `routes.py:2543`
- `GET /users` — list users (manage perm) — `routes.py:2600`
- `POST /users` — create user — `routes.py:2609`
- `PUT /users/{username}` — update user — `routes.py:2651`
- `DELETE /users/{username}` — delete user — `routes.py:2703`
- `GET /cases` — list cases (status/surface filters) — `routes.py:2766`
- `GET /cases/{case_id}` — get one case — `routes.py:2794`
- `POST /cases/{case_id}/action` — lifecycle action (ack/close/escalate/hold/etc via decide()) — `routes.py:2917`
- `POST /cases/bulk` — bulk case action across multiple case_ids — `routes.py:3115`
- `POST /cases/{case_id}/feedback` — analyst feedback grading AI verdict — `routes.py:3196`
- `POST /cases/{case_id}/comment` — add a legacy comment — `routes.py:3228`
- `POST /cases/{case_id}/tags` — set case tags — `routes.py:3256`
- `POST /cases/{case_id}/assign` — assign case to analyst — `routes.py:3288`
- `GET /cases/{case_id}/export` — export case as json/md — `routes.py:3314`
- `POST /cases/{case_id}/investigate` — human-triggered (re-)investigation — `routes.py:3384`
- `POST /cases/{case_id}/reinvestigate` — re-investigate with new context — `routes.py:3425`
- `POST /cases/{case_id}/run-playbook` — context-only re-investigation w/ a specific playbook — `routes.py:3488`
- `GET /cases/{case_id}/threat-context` — IOC reputation + MITRE + related cases panel — `routes.py:3531`
- `POST /threat-context/import` — import external threat-context data — `routes.py:3563`
- `GET /cases/{case_id}/trace` — ordered agent-pipeline trace — `routes.py:3588`
- `GET /cases/{case_id}/rationale` — assembled "why" explainability object — `routes.py:3607`
- `GET /cases/{case_id}/forwarding` — explain auto-forward-gate decision (read-only) — `routes.py:3624`
- `GET /scans` — automated-scan case list (Surface 3) — `routes.py:3667`
- `GET /scans/notifications` — new-scan count since a relative time — `routes.py:3673`
- `GET /standup` — daily standup summary (never 500s; degrades gracefully) — `routes.py:3685`
- `GET /usage/summary` — cost/usage ledger summary — `routes.py:3723`
- `POST /poll` — manual poll trigger (or demo tick while Demo Mode engaged) — `routes.py:3733`

### `routes_baseline.py` — entity baselining (Round 4)
- `GET /baseline/stats` — aggregate baseline stats — `routes_baseline.py:90`
- `GET /baseline/config` — baseline config (default OFF) — `routes_baseline.py:148`
- `PUT /baseline/config` — update baseline config — `routes_baseline.py:159`
- `GET /baseline/{signature}` — per-cluster-signature EWMA/EWMV + t-digest stats — `routes_baseline.py:191`

### `routes_batch.py` — LLM batch/flex jobs (Round 4)
- `GET /batch/jobs` — list batch jobs — `routes_batch.py:83`
- `GET /batch/jobs/{job_id}` — one batch job's status/results — `routes_batch.py:103`
- `GET /batch/config` — batch/flex config — `routes_batch.py:125`
- `PUT /batch/config` — update batch/flex config — `routes_batch.py:136`

### `routes_campaigns.py` — campaign correlation (Round 4)
- `GET /campaigns` — list campaigns (status/limit filters) — `routes_campaigns.py:103`
- `GET /campaigns/config` — campaign correlation config — `routes_campaigns.py:137`
- `PUT /campaigns/config` — update campaign config — `routes_campaigns.py:148`
- `GET /campaigns/{campaign_id}` — one campaign (referenced case_ids) — `routes_campaigns.py:179`
- `GET /cases/{case_id}/campaign` — the campaign a case belongs to, if any — `routes_campaigns.py:200`
- `POST /campaigns/recorrelate` — manually trigger the daily shared-entity re-correlation pass — `routes_campaigns.py:224`

### `routes_cases_collab.py` — per-case ticket collaboration (Round 3)
- `GET /cases/{case_id}/activity` — aggregate activity feed — `routes_cases_collab.py:384`
- `GET /cases/{case_id}/thread` — threaded human/ai/system messages — `routes_cases_collab.py:434`
- `POST /cases/{case_id}/thread` — post a message (human or ai) — `routes_cases_collab.py:459`
- `PATCH /cases/{case_id}/thread/{msg_id}` — edit a thread message — `routes_cases_collab.py:537`
- `DELETE /cases/{case_id}/thread/{msg_id}` — delete a thread message — `routes_cases_collab.py:572`
- `POST /cases/{case_id}/thread/{msg_id}/reactions` — react to a message — `routes_cases_collab.py:601`
- `GET /cases/{case_id}/tasks` — list case tasks — `routes_cases_collab.py:636`
- `POST /cases/{case_id}/tasks` — create a task — `routes_cases_collab.py:655`
- `PATCH /cases/{case_id}/tasks/{tid}` — update a task — `routes_cases_collab.py:684`
- `POST /cases/{case_id}/tasks/{tid}/log` — log/comment on a task — `routes_cases_collab.py:726`

### `routes_dashboards.py` — custom per-user dashboards (Round 5)
- `GET /dashboards` — list caller's dashboards (+ role defaults) — `routes_dashboards.py:245`
- `GET /dashboards/widget-types` — widget registry for the builder — `routes_dashboards.py:266`
- `POST /dashboards` — create a dashboard layout — `routes_dashboards.py:279`
- `PUT /dashboards/{dashboard_id}` — update a dashboard layout — `routes_dashboards.py:310`
- `DELETE /dashboards/{dashboard_id}` — delete a dashboard — `routes_dashboards.py:344`
- `POST /dashboards/{dashboard_id}/clone` — clone-to-customize a (default) dashboard — `routes_dashboards.py:371`

### `routes_enrichment.py` — enrichment provider SPI (Round 3)
- `GET /enrichment/providers` — list 19 registered providers + configured status — `routes_enrichment.py:86`
- `GET /enrichment/lookup` — type-routed indicator enrichment (Redis-cached, fail-open) — `routes_enrichment.py:145`
- `POST /enrichment/providers/{name}/secrets` — set a provider's API key — `routes_enrichment.py:194`

### `routes_inapp.py` — in-app notification inbox (Round 3)
- `GET /notifications/inbox` — caller's fan-out inbox — `routes_inapp.py:42`
- `GET /notifications/inbox/unread-count` — unread badge count — `routes_inapp.py:69`
- `POST /notifications/inbox/{notification_id}/read` — mark one read — `routes_inapp.py:81`
- `POST /notifications/inbox/read-all` — mark all read — `routes_inapp.py:100`
- `POST /notifications/inbox/{notification_id}/dismiss` — dismiss one — `routes_inapp.py:113`
- `GET /notifications/prefs` — per-category×channel notification prefs — `routes_inapp.py:143`
- `PUT /notifications/prefs` — update notification prefs — `routes_inapp.py:158`

### `routes_metrics.py` — posture dashboard (Round 3)
- `GET /metrics/posture` — MTTA/MTTR/dwell p50/p90 + SLA/aging + period deltas — `routes_metrics.py:62`
- `GET /mitre/coverage` — per-tactic MITRE coverage % vs the 697-corpus — `routes_metrics.py:86`
- `GET /mitre/coverage/navigator.layer.json` — ATT&CK Navigator v4.5 layer export — `routes_metrics.py:109`

### `routes_models.py` — LLM model registry + budget (Round 3)
- `GET /llm/models` — bundled model registry + price overlays + assigned roles — `routes_models.py:76`
- `GET /llm/providers` — provider registry (incl. Azure/Bedrock/Vertex/OpenAI-compat) — `routes_models.py:110`
- `POST /llm/models/test` — test a model/provider config — `routes_models.py:159`
- `PUT /llm/models/{model_id}/pricing` — set a per-model price overlay — `routes_models.py:230`
- `DELETE /llm/models/{model_id}/pricing` — remove a price overlay — `routes_models.py:252`
- `POST /cost/estimate` — estimate cost for a hypothetical call — `routes_models.py:277`
- `GET /budget` — budget ceiling config — `routes_models.py:305`
- `PUT /budget` — update budget config — `routes_models.py:314`
- `GET /budget/status` — current spend vs. budget (pre-flight BudgetGate state) — `routes_models.py:331`

### `routes_notifications.py` — outbound channels (email/webhook/etc.)
- `GET /notifications/providers` — list channel providers/presets — `routes_notifications.py:49`
- `POST /notifications/preview` — server-side render a template sample (escaping authoritative) — `routes_notifications.py:75`
- `POST /notifications/test` — send a test notification — `routes_notifications.py:122`
- `POST /notifications/channels/{channel_id}/secret` — set a channel's secret (SMTP/webhook token) — `routes_notifications.py:144`
- `POST /cases/{case_id}/notify` — manually fire a notification for a case — `routes_notifications.py:188`

### `routes_prefs.py` — branding + per-user/org customization (Round 2/3)
- `GET /branding` — public branding config — `routes_prefs.py:42`
- `PUT /branding` — update branding (admin) — `routes_prefs.py:47`
- `GET /prefs/effective` — merged org←user customization cascade — `routes_prefs.py:134`
- `GET /prefs/user` — caller's raw personal prefs bucket — `routes_prefs.py:143`
- `PUT /prefs/user` — patch personal prefs — `routes_prefs.py:151`
- `GET /prefs/org` — org customization defaults (readable by any user) — `routes_prefs.py:162`
- `PUT /prefs/org` — update org defaults (admin) — `routes_prefs.py:170`
- `GET /terminology` — org label-override map — `routes_prefs.py:192`
- `PUT /terminology` — update terminology (admin) — `routes_prefs.py:199`
- `GET /views` — personal + org-shared saved views — `routes_prefs.py:224`
- `POST /views` — create a saved view — `routes_prefs.py:234`
- `PUT /views/{view_id}` — update a saved view — `routes_prefs.py:254`
- `DELETE /views/{view_id}` — delete a saved view — `routes_prefs.py:271`
- `POST /views/{view_id}/clone` — clone a view — `routes_prefs.py:284`
- `PUT /prefs/user/tables/{table_id}` — persist per-table column state — `routes_prefs.py:318`

### `routes_rag.py` — RAG corpus management + agent memory
- `GET /rag/stats` — corpus stats (chunks/docs/embedding model) — `routes_rag.py:67`
- `GET /rag/documents` — list RAG documents (seeds grouped `seed:<source>`) — `routes_rag.py:73`
- `GET /rag/documents/{document_id}` — one document + its chunks — `routes_rag.py:80`
- `POST /rag/import` — import a document into the corpus (UNTRUSTED-fenced) — `routes_rag.py:89`
- `DELETE /rag/documents/{document_id}` — delete a document (force= for seeds) — `routes_rag.py:111`
- `GET /rag/search` — live hybrid BM25+vector retrieval — `routes_rag.py:131`
- `GET /memory` — list durable operator-memory entries — `routes_rag.py:170`
- `POST /memory` — add a memory entry — `routes_rag.py:183`
- `PUT /memory/{entry_id}` — update a memory entry — `routes_rag.py:200`
- `DELETE /memory/{entry_id}` — delete a memory entry — `routes_rag.py:214`

### `routes_reset.py` — tiered reset (Round 4)
- `POST /admin/reset` — admin, fresh-auth, type-to-confirm tiered reset (cases/sources/factory; env secrets untouched) — `routes_reset.py:63`

### `routes_roles.py` — custom RBAC (Round 3)
- `POST /roles` — create a custom role — `routes_roles.py:208`
- `PUT /roles` — update a custom role — `routes_roles.py:230`
- `DELETE /roles/{name}` — delete a custom role — `routes_roles.py:251`
- `POST /roles/preview` — preview effective permissions for a role body — `routes_roles.py:278`
- `GET /roles/simulate` — simulate one role/resource/action permission check — `routes_roles.py:314`
- `GET /account/permissions` — caller's own effective permission set — `routes_roles.py:345`
- `PUT /users/{username}/roles` — assign roles to a user — `routes_roles.py:439`

### `routes_rules.py` — Detection & Rules editor (Round 5)
- `GET /rules` — list all rules across 3 tiers (detection/anomaly/case-automation) — `routes_rules.py:193`
- `PUT /rules/detection/{rule_name}` — upsert a detection/threshold rule — `routes_rules.py:242`
- `POST /rules/detection/{rule_name}/enabled` — enable/disable a detection rule — `routes_rules.py:279`
- `DELETE /rules/detection/{rule_name}` — delete a detection rule — `routes_rules.py:306`
- `PUT /rules/correlation/{rule_key}` — upsert a correlation rule — `routes_rules.py:333`
- `DELETE /rules/correlation/{rule_key}` — delete a correlation rule — `routes_rules.py:365`
- `PUT /rules/case-automation/{rule_id}` — upsert a `CaseAutomationRule` — `routes_rules.py:391`
- `POST /rules/case-automation/{rule_id}/enabled` — enable/disable a case-automation rule — `routes_rules.py:438`
- `DELETE /rules/case-automation/{rule_id}` — delete a case-automation rule — `routes_rules.py:467`
- `GET /rules/{kind}/{rule_id}/versions` — rule version ledger — `routes_rules.py:496`
- `POST /rules/{kind}/{rule_id}/rollback/{version_id}` — rollback a rule to a prior version — `routes_rules.py:517`
- `POST /rules/preview` — Test/Preview a rule vs. recent data; NEVER calls `decide()`/bills the LLM (#3/#6) — `routes_rules.py:611`

### `routes_search.py` — global search + audit viewer (Round 2)
- `GET /search` — global cross-entity free-text search — `routes_search.py:86`
- `GET /audit` — audit-log viewer (actor/action filters) — `routes_search.py:171`

### `routes_setup.py` — first-admin OOBE (Round 4)
- `POST /setup/account` — create the first super_admin (self-locking, strong-password-enforced) — `routes_setup.py:113`

### `routes_standup.py` — forward-looking standup (Round 3)
- `GET /standup/report` — deterministic attention queue + SLA/aging + workload — `routes_standup.py:104`
- `GET /standup/action-items` — list standup action items — `routes_standup.py:162`
- `POST /standup/action-items` — create an action item — `routes_standup.py:180`
- `PUT /standup/action-items/{item_id}` — update an action item — `routes_standup.py:195`
- `DELETE /standup/action-items/{item_id}` — delete an action item — `routes_standup.py:211`
- `POST /standup/acknowledge` — acknowledge a shift handoff — `routes_standup.py:228`
- `GET /standup/acknowledgements` — list handoff acknowledgements (window/user filters) — `routes_standup.py:245`

### `routes_triage.py` — read-only triage chips + trace (Round 3)
- `POST /triage/preview-decision` — pure what-if over `decide()` (never mutates, #3-safe) — `routes_triage.py:66`
- `GET /cases/{case_id}/triage` — 4 advisory chips: risk/severity/impact/priority — `routes_triage.py:133`
- `GET /cases/{case_id}/timeline` — typed ReAct trace timeline w/ terminal decision step — `routes_triage.py:171`
- `GET /cases/{case_id}/stages` — case progress folded into pipeline stages — `routes_triage.py:676`

### `routes_tuning.py` — adaptive threshold auto-tuning (Round 4)
- `GET /tuning/recommendations` — pending tuning recommendations — `routes_tuning.py:127`
- `GET /tuning/config` — threshold-tuning config (default OFF) — `routes_tuning.py:193`
- `PUT /tuning/config` — update tuning config — `routes_tuning.py:202`
- `POST /tuning/{rule_id}/apply` — apply a bounded +1 tuning change (audited) — `routes_tuning.py:225`
- `POST /tuning/{rule_id}/rollback` — rollback a tuning change — `routes_tuning.py:301`

### Not routers (support files, no endpoints)
- `backend/app/api/deps.py` — `get_state`, `require_permission`, `require_admin`, `require_fresh_auth`, custom-role union enforcement.
- `backend/app/api/settings_schema.py` — settings UI schema builder consumed by `GET /settings/schema`.
- `backend/app/api/__init__.py` — package init.

**Totals:** 21 router files (`routes.py` + 20 feature routers), **~155 endpoint decorators** total. All paths prefixed `/api`; auth enforced globally via `main.py:102` `Depends(require_auth)`, with per-route `Depends(require_permission(resource, action))` for RBAC-gated actions.
</markdown>


---


<!-- ===== [23] Overall branch state recap (Rounds 3–6 + timeline) ===== -->

## Executive Summary — `Testing` branch state (verified 2026-07-05)

### Round 3 — "useful, distinctive, fine-grained" (commits `bffe4b8`→`3610147`+docs wave)
12 user requests across Waves 0–4, additive, zero new runtime deps, `decide()` byte-identical. Shipped: posture metrics (`engine/metrics.py` MTTA/MTTR/dwell p50/p90) + MITRE coverage (`engine/mitre_coverage.py`, ATT&CK Navigator export); a forward-looking Standup (`engine/shift_report.py`); an `EnrichmentProvider` SPI with 19 registered providers (17 new: AbuseIPDB/VirusTotal/GreyNoise/Shodan(+InternetDB)/Censys/BinaryEdge/IPinfo/OTX/Pulsedive/Spur/X-Force/URLscan/HIBP/ProjectHoneypot/abuse.ch×3/RDAP); a Models registry + `engine/budget.py` `BudgetGate`; in-app notifications (`InAppChannel`→`InboxStore`); per-case threaded collaboration (human/ai/system messages, reactions, tasks, @mentions); fine-grained custom-role RBAC (`effective_matrix()`, inheritance + explicit DENY); a multiplexed SSE `EventBus` (`realtime.py`, `GET /api/events`, default OFF); 4 honest triage chips (risk/severity/impact/priority) + a typed ReAct `TraceTimeline`. Plus a shipped security fix: RAG knowledge fencing inverted to a TRUSTED allowlist (OWASP LLM01). 8 new KV stores, 8 new `api/routes_*.py` routers. Baseline at close: **1109 backend / 175 Vitest**.

### Round 4 — "fix the logic, fine-tune the product" (commits `3aeab6c`→`1df27ac`)
3 confirmed bugs + 12 requests across Waves 0–6, default-OFF, zero new deps, `decide()` byte-identical. Bugs: (1) single-source poller — new `engine/poller_manager.py` `PollerManager` fans out over every enabled PULL source on a `{source.id}:{feed.id}` cursor + per-signature `asyncio.Lock`; (2) `claude-opus-4-8` mispriced $15/$75 → corrected $5/$25 + cache rates (read 0.1×, write 1.25×[5m]/2×[1h]) + batch 0.5× applied; (3) `acknowledge` now sets `CaseStatus.INVESTIGATING` (was `None`). New capabilities: adaptive threshold auto-tuning (`engine/threshold_tuner.py`, Wilson-LB + EWMA, config-writer only); two-tier ALERT/EVENT ingestion (`engine/event_detection.py` funnel whose survivors re-enter the same correlate/decide pipeline); daily campaign correlation (`engine/campaigns.py`, `Campaign` objects referencing `case_ids` only); entity baselining (`engine/baseline.py`, online EWMA/EWMV over 168 hour-of-week buckets + t-digest, modified-z |M|>3.5); `llm/batch.py` `BatchProvider` SPI (Anthropic Batches + OpenAI Batch + flex, `custom_id`-keyed); `GET /api/logs` unified scatter-gather; tiered reset (`engine/reset.py`) + OOBE (`routes_setup.py`). A 16-dimension audit found 16 confirmed issues (2 HIGH: poller concurrency, EVENT-detection not really creating cases), all fixed. Baseline at close: **1461 backend / 273 Vitest**.

### Round 5 — "UI/UX overhaul + rules customization + custom dashboards + loose coupling" (commits `5ab7c05`→`05552c7`)
9 goals (G1–G9), `decide()` byte-identical vs `27f0983`. G1: Radix slate+blue base, 3 semantic axes (severity/status/verdict) each `token`/`-foreground`/`-text`, measured WCAG-AA both themes, self-hosted Inter+JetBrains Mono. G2: one shadcn/Radix/Tailwind standard via a codemod; ~15 new primitives (`Field`, `SegmentedControl`, `ConfirmDialog`, `NumberField`, `LabeledSlider`, `SecretField`, `TagInput`, `IconButton`, `PageContainer`, `TimeRangePicker`); `CaseDetail.tsx` split 4210→1529 LOC. G3: Settings god-file 2673→575 LOC via a data-driven section registry, 6→5 nav groups, Security promoted top-level; fixed the auto-close dead-field bug. G4/G5: `PageContainer` wide mode + ~52px `PageHeader` (was ~176px `HeroPanel`). G6: Detection & Rules home (3 tiers) + polymorphic editor + `POST /api/triage/preview-decision` (never calls `decide()`, never bills the LLM) + `stores/rule_versions.py` version ledger. G7: custom dashboards — widget registry, `react-grid-layout` (lazy, edit-mode only), `stores/dashboards.py`, `api/routes_dashboards.py`. G8: single `FEATURES[]` registry (`soc/registry.tsx`) deriving nav+routes+palette; entry chunk 537→264 kB via restored `React.lazy`. G9: `jsx-a11y` 48→0 violations + a 16-dimension audit (23 findings, 9 must-fix, all resolved). Baseline at close: **1601 backend / 625 Vitest / entry 264 kB**.

### Round 6 — "fleet glitch-hunt + integration polish" (commit `54c8465`)
A ~500-agent Opus fleet audited every webui file (155 units) → 466 claimed / 464 verified findings (423 fixed, 47 refuted), applied in 30 conflict-free batches. Flagship fix: custom-dashboard view-mode stacking (`packWidgets` + curated per-role default layouts filling 12 cols). Also: `PageContainer` made the single width authority app-wide; `CaseDetail` thread-edit/task-patch 405s fixed via a new `api.patch`; rules version ledger made to actually record + rollback live; Settings Automation section deferred to Detection & Rules; per-source connector secrets no longer dropped (`SecretField` unified everywhere); KPI delta-arrow sign fixes; WCAG-AA contrast fixes both themes; a beginner `AutomationNudge` (one-click safe automation). `decide()` untouched; API paths byte-identical (additive only). Baseline at close: **1613 backend / 1051 Vitest (199 files) / entry 281.6 kB / lint 0 errors**.

### Green baseline
- Documented (Round 6, 2026-07-02): backend **1613 pytest**; webui **1051 Vitest** / 199 files; build clean, entry **281.6 kB**; eslint **0 errors** (3 warnings); zero new deps; `engine/case_manager.py` byte-identical to `27f0983`.
- Re-verified live in this session (2026-07-05, includes the undocumented Timeline work below): backend **1628 pytest passed, 0 failed**; webui build clean, entry chunk `dist/assets/index-KsEugFeH.js` **281.65 kB** (essentially unchanged; `CaseDetail-URTt28f_.js` now 119.58 kB, up from absorbing `StageTimeline.tsx`); `npx vitest run` → **200/201 test files pass, 1059/1060 tests pass** — the one failure is `src/soc/__tests__/design-gates.test.ts` (`no file exceeds its committed grep baseline`), because `webui/src/soc/pages/casedetail/StageTimeline.tsx` introduces 2 occurrences of the `arbitrary-text-size` pattern (`text-[10px]` at line 114, `text-[11px]` at line 184) against a committed baseline of 0 for that file — **an unreconciled design-gate regression from the new Timeline component, not yet fixed/rebaselined**; `npm run lint` → 0 errors, 3 warnings (unchanged); `git diff 27f0983 -- backend/app/engine/case_manager.py` is empty (decide() still byte-identical).

### Newest work: Timeline / structured investigator reasoning (commits `51ff7bf`→`e6ff63a`, PRs #21/#22, tag `#20` — undocumented in CLAUDE.md/HANDOFF/CHANGELOG/ROADMAP/Journal.md as of this read)
A new **"Timeline" tab** on `CaseDetail` that reframes a case as a **six-stage narrative** (`input → correlate → risk → triage → investigate → decide`), read-time-projected from the Case + its audit rows — advisory only, never feeds `decide()` (#3), untrusted text fenced (#9):
- **Data contract** (`backend/app/models.py:910-960`): `StageState` (severity/severity_band/severity_source/risk_score/verdict/confidence), `StageStep` (`kind: reasoning|tool|knowledge|memory|note`, `label`, `body`, `trusted: bool`, `ts`), `TimelineStage` (`id`, `kind`, `label`, `status: done|skipped|pending`, `deterministic: bool`, `ts`, `headline`, `state: StageState`, `steps: list[StageStep]`), `TimelineStagesResponse` (`case_id`, `stages`, `total`). Mirrored 1:1 in `webui/src/soc/pages/CaseDetail.api.ts:143-190`.
- **Endpoint**: `GET /api/cases/{case_id}/stages` (`backend/app/api/routes_triage.py:677`, `require_permission("cases","read")`) — never 404s (returns the `_CANON_STAGES` skeleton, `routes_triage.py:480`, for an unknown case). `_build_stages()` (`routes_triage.py:519`) partitions audit rows by `ActionType` (CONTEXT→triage basis: playbook + memory facts; TOOL_CALL/ES_QUERY→investigate tool steps; VERDICT→reasoning) and re-derives the deterministic decision clause via `_decide_headline()` (`routes_triage.py:507`) purely for display.
- **Structured investigator reasoning**: `INVESTIGATOR_SYSTEM` (`backend/app/agents/prompts.py:250`) now instructs the model to format `reasoning` as a one-sentence summary + a numbered list of indicators + a `Recommendation:` line. `Investigator._verdict_from_response` (`backend/app/agents/investigator.py:306-315`) keeps a 600-char `reasoning_excerpt` in `result_summary` (for the one-line trace) and stashes a fuller 4000-char `reasoning_full` in the VERDICT audit row's `tool_input["reasoning"]` (unclipped by the audit layer) so the Timeline can show it in full behind "Show more."
- **webui**: new `webui/src/soc/components/Markdown.tsx` — a dependency-free, HTML-injection-safe renderer (bold/`code`/bulleted+numbered lists/paragraphs, everything a React node) extracted out of `ChatPanel.tsx` (which now imports it, net −85/+1 lines) and reused by the Timeline. New `webui/src/soc/pages/casedetail/StageTimeline.tsx` (240 LOC) renders the six stages as a vertical chronological list with per-stage icon/tone (`STAGE_META`), state chips, a "deterministic" badge on correlate/risk/decide, and collapsible steps; a trusted step body over `CLAMP_CHARS = 320` chars clamps to `max-h-28` with a "Show more/less" toggle (`StageTimeline.tsx:101-105`); untrusted steps render only inside an escaped `<CodeBlock>`. `CaseDetail.tsx` wires a new `'timeline'` tab (`CaseDetail.tsx:197`) lazily loaded via `getCaseStages()` (`CaseDetail.api.ts:189`, called at `CaseDetail.tsx:407`), invalidated (`setStages(null)`) alongside the existing `/timeline` and `/why` caches on every reinvestigate/close/playbook-apply action.
- **Tests**: `backend/tests/test_case_stages.py` (7 tests: never-404-skeleton, six-ordered-stages, no-verdict-skips-investigate, fence-untrusted-text, fold-why-into-expansions, reasoning-prefers-full-tool_input, decide-reflects-deterministic-decide) + `webui/src/soc/components/__tests__/Markdown.test.tsx` (new) + `webui/src/soc/pages/casedetail/__tests__/StageTimeline.test.tsx` (new, 112 LOC) — all pass.
- **Outstanding**: the design-gate Vitest failure above (2 arbitrary text-size utilities in `StageTimeline.tsx` vs. Round 5's `text-[10px]`/`text-[11px]` → token-class baseline) is a real, currently-unfixed regression against the Round 5/6 design standard; and no CLAUDE.md/HANDOFF.md/CHANGELOG.md/ROADMAP.md/Journal.md entry exists yet for this Timeline feature — docs are stale relative to `HEAD` (`c57e8f5`).


---


<!-- ===== [24] Case rationale / “Why” + trace + triage chips ===== -->

## Case explainability ("Why") — current state (Testing branch)

### 1. Fragmentation: the "why" story is split across 4 independently-fetched surfaces
`CaseDetail.tsx` (`webui/src/soc/pages/CaseDetail.tsx`) renders **8 tabs** (lines 1328–1351): `overview · timeline · why · threat · trace · collab · feedback · chat`. Three of them independently re-derive overlapping "why" content from the **same underlying audit rows** (`tlsoc-agent-audit-*`, `ActionType.CONTEXT/TOOL_CALL/ES_QUERY/VERDICT/DECISION`), each with its own fetch, loading/error state, and shape:

| Tab label | Component | Endpoint | What it shows |
|---|---|---|---|
| Overview | `CaseTriageHeader` (embedded in `OverviewPanel`) | `GET /api/cases/{id}/triage` | 4 advisory chips: risk/severity/impact/priority |
| **Timeline** | `StageTimeline` (`casedetail/StageTimeline.tsx`) | `GET /api/cases/{id}/stages` | 6-stage narrative (input→correlate→risk→triage→investigate→decide), each stage re-parses the audit rows itself (`routes_triage.py:564-673`) |
| **Why** | `WhyPanel` (`casedetail/WhyPanel.tsx`) | `GET /api/cases/{id}/rationale` | flat "why" object: decision, reasoning, knowledge, tools, memory, enrichment, playbook, MITRE |
| Trace | `TraceTimeline` (`components/TraceTimeline.tsx`) | `GET /api/cases/{id}/timeline` | typed ReAct span list (`invoke_agent/chat/execute_tool/decision`) with cost/tokens/latency |
| Threat context | `ThreatContextPanel` | `GET /api/cases/{id}/threat-context` | IOC reputation, MITRE, related cases |

`routes_triage.py:564-567` explicitly comments that `/stages` extracts its "why" pieces "from the SAME audit rows the rationale endpoint reads" — i.e. `/stages` and `/rationale` are two separate, independently-maintained parsers over the same audit trail, producing different shapes (`TimelineStage[]` vs a flat object) for what is conceptually the same story. `/timeline` is a third, span-oriented view of a subset of the same data. This is the concrete fragmentation problem UI item #9 ("tell a clean story") needs to resolve.

### 2. `GET /api/cases/{id}/rationale` — the "Why" tab's data source
- Route: `backend/app/api/routes.py:3607-3621` (`case_rationale`). No `require_permission` gate (GET-only; unlike `/triage`, `/timeline`, `/stages`, `/forwarding` which all gate on `require_permission("cases","read")`).
- Assembly: `_build_rationale(case_id, case, rows)` at `routes.py:3982-4106`. Pure/defensive, **never calls the LLM**, never 404s. Reads `state.cases.get(case_id)` + `state.audit.records_for_case(case_id)` and parses:
  - `ActionType.CONTEXT` row's `tool_input` → `knowledge` (list of `{source, snippet}`), `memory_used` (`str[]`), `enrichment` (`{reputation_score, is_malicious, country}`) — only the **first** CONTEXT row is used.
  - `ActionType.TOOL_CALL` / `ActionType.ES_QUERY` rows → `tools` (list of `{tool, query, summary}`).
  - `ActionType.VERDICT` row's `result_summary`, split on the literal marker `"reasoning="` → `reasoning` (first match only).
  - Row with `actor == "playbook_selector"` → `playbook_reason` (first match only).
  - Row with `actor == "case_manager" and action_type == ActionType.DECISION` → `decision_rationale`; falls back to the last `case.history` entry where `event == "decision"` and it has a `rationale` key.
  - Case fields directly: `verdict`, `confidence`, `status`, `decision_by`, `agent_persona` → `persona`, `playbook_id`, `mitre`, `evidence` (`{summary, event_ids, query}`).
- Response shape (also `CaseRationale` in `webui/src/lib/types.ts:2063-2081`):
  ```
  { case_id, verdict?, confidence?, status?, decision_by?, persona?,
    playbook?: {id, reason} | null,
    memory_used?: string[], knowledge?: {source, snippet}[],
    enrichment?: {reputation_score?, is_malicious?, country?} | null,
    tools?: {tool, query, summary}[], reasoning?: string,
    decision_rationale?: string, mitre?: string[], evidence?: Evidence[] }
  ```
  Every one of these fields (reasoning, snippet, tool.query/summary, enrichment.country, memory strings, playbook.reason, decision_rationale) is documented UNTRUSTED (log/model-derived, #9) and consumed by the renderer as plain text / inside a `<CodeBlock>` — never markup.

### 3. `WhyPanel.tsx` (`webui/src/soc/pages/casedetail/WhyPanel.tsx`) — how it's rendered
Props: `{ c: Case; rationale: CaseRationale | null; loading: boolean; error: unknown; onRetry: () => void }`. States: `loading` → 3 `Skeleton`s; `error` → `LoadError` w/ retry; `!rationale` → `EmptyState` ("No rationale recorded yet"). When present, renders 6 `PanelCard` sections in order:
1. **Decision** — `VerdictBadge`/`StatusBadge`/`ConfidenceBadge` + a "Decided by {human|Automated pipeline}" badge (`decisionByLabel()`, line 44-48, keys off `decision_by` containing `"human"/"analyst"/"operator"`) + persona badge; an `Alert` showing `r.decision_rationale` verbatim as plain text (or a canned fallback sentence).
2. **Agent reasoning** — `r.reasoning` as `whitespace-pre-wrap` plain text, or "No reasoning excerpt was recorded".
3. **Knowledge used** — `r.knowledge[]`, each a `Badge` (source) + `CodeBlock` (snippet); `EmptyState` if empty.
4. **Commands the agent ran** — `r.tools[]`, each a `Badge` (tool name) + `CodeBlock` (query) + plain-text summary; `EmptyState` if empty.
5. **Operator memory applied** — only rendered if `r.memory_used` has non-empty entries, one `Badge`+text row each.
6. **Enrichment + Playbook** (two-column grid, only rendered if either is present) — enrichment: `reputation_score` (rounded int), `is_malicious` (Malicious/Clean badge), `country` (plain text); playbook: `playbook.id` as a mono badge + `playbook.reason` as plain text.
7. **MITRE ATT&CK techniques** — `r.mitre[]` as outline badges, only if non-empty.

`hasEnr` gating (line 100-104) requires at least one of `reputation_score`/`is_malicious`/`country` to be truthy — a fail-open `{}` enrichment result renders nothing rather than an empty card.

### 4. `CaseTriageHeader.tsx` (`webui/src/soc/components/CaseTriageHeader.tsx`) — the 4 triage chips
Props: `CaseTriageHeaderProps = { chips: TriageChips | null; loading?: boolean; className?: string }`. Data comes from `GET /api/cases/{id}/triage` (`routes_triage.py:133-150`, `require_permission("cases","read")` gated), which wraps `derive_triage(case, prefs)` (`backend/app/engine/priority.py:261-334`) — a pure, `decide()`-independent derivation (#3). Never 404s; unknown case → `_empty_chips()` shell (`routes_triage.py:153-165`).

Four chips, each a `ChipShell`/custom card with an accent-bar tone, a `HelpTip` carrying the backend's `inputs.definition` string, and a `data-testid`:
- **`triage-chip-risk`** (`RiskCard`) — `RiskChip {value, band, breakdown, inputs}`. Renders the existing `RiskGauge` (0-100, `scoreBand()` from `palette.ts`, thresholds 74/48/22) + `RiskBreakdownBars` (5 factors: Volume 25% / Velocity 20% / Reputation 30% / Diversity 15% / Asset criticality 10%, each 0-100 bar). Passed through from `case.risk_score`/`case.risk_breakdown`, never recomputed.
- **`triage-chip-severity`** (`SeverityCard`) — `SeverityChip {band, value, raw, source, inputs}`. `source` is `'source_asserted'` vs `'derived'`; sub-line shows "derived (no source rating)" or "source-asserted" + `raw` value.
- **`triage-chip-impact`** (`ImpactCard`) — `ImpactChip {band, value, criticality, entity, inputs}`. Sub-line: "asset criticality N/100".
- **`triage-chip-priority`** (`PriorityCard`) — `PriorityChip {level, impact, matched, default, urgency:{band,value,escalated}, inputs}`. ITIL Impact×Urgency; tone tracks urgency band; sub-line shows "impact X × urgency Y" + "· default" if `matched === false`.

Loading → 4 `Skeleton`s (`h-[10.75rem]`, sized to match the real chip height so header footprint doesn't jump). `!chips` (fetch failed, since success always returns a shell) → renders `null`, and `OverviewPanel` then falls back to its **legacy** `verdictHeadline`/`confidenceHeadline` panels (`OverviewPanel.tsx:466-467`) — i.e. there is a second, older "verdict/confidence headline" presentation still live as a silent fallback path.

### 5. `TraceTimeline.tsx` (`webui/src/soc/components/TraceTimeline.tsx`) — the "Trace" tab
Props: `{ data: TimelineResponse | null; loading?; error?; onRetry? }`. Consumes `GET /api/cases/{id}/timeline` (`routes_triage.py:171+`, same permission gate), which returns `{case_id, spans: TraceSpan[], total, totals:{cost,tokens}}`. `TraceSpan = {id?, case_id?, step_index, kind: 'invoke_agent'|'chat'|'execute_tool'|'decision'|string, name, ts, latency_ms, cost, tokens, trusted, summary, payload_ref}`.
- Non-decision spans → `ReactStep`: a `Badge` per `kind` (Agent/Chat/Tool/fallback via `humanizeToken`), `span.name` as plain text, optional `tool_name`/`model` from `payload_ref`, cost/tokens/timestamp. If `trusted === false` the `summary` renders **only** inside a `<CodeBlock caption="untrusted tool / log payload">`; if `trusted === true` it renders as plain `whitespace-pre-wrap` text.
- The terminal `kind === 'decision'` span → `DecisionStep`, a visually distinct bordered card: `DecisionPayload` fields `{verdict, confidence, risk_score, decision_status, decision_by, escalate, objection_window_expires_at, policy_clause:{verdict_class, auto_closable, min_confidence, max_risk_score, objection_window_minutes, note}}` are shown as 4 `DecisionFact` tiles (Verdict/Confidence/Risk score/Result) plus a "Policy clause evaluated" box (the exact `AutoClosePolicy` clause `decide()` matched) plus `span.summary` (the deterministic rationale prose) plus the objection-window expiry. This is the one place the deterministic `decide()` output is shown as a literal, itemized policy-clause comparison rather than free text.
- Header strip: step count, tool count, `fmtMoney(totals.cost)`, `fmtTokens(totals.tokens)`, and a "Deterministic decision recorded" badge if any span has `kind==='decision'`.

### 6. Net effect for the UI overhaul (item #9)
There is no single "why" surface — a user must open **3 different tabs** (Timeline/stages, Why/rationale, Trace/spans) to get: (a) a chronological 6-stage narrative, (b) a flat decision+reasoning+knowledge+tools object, and (c) a raw ReAct span log with cost/tokens — plus the 4 header chips on Overview and IOC/MITRE context on a 4th tab (Threat context). All are fetched/loaded/error-handled independently (`CaseDetail.tsx` holds 5 separate `useState` triples: `rationale/rationaleLoading/rationaleError`, `stages/stagesLoading/stagesError` (not shown but same pattern), `timeline/timelineLoading/timelineError`, `triage/triageLoading`, `threat/threatLoading/threatError`), each lazy-loaded on first tab visit (`open && tab === 'X' && data === null` guards, e.g. line 651 for `why`, line 397 for `trace`, line 419 for `timeline`). Backend-side, `/stages` and `/rationale` duplicate the same audit-row parsing logic (CONTEXT/TOOL_CALL/ES_QUERY/VERDICT/playbook_selector/case_manager DECISION) independently in `routes.py:_build_rationale` and `routes_triage.py` (the stage-builder), so consolidating the UI would likely also want to consolidate/share that backend parsing.


---
