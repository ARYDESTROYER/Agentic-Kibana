# WORK_TRACKER.md — Round 5 "UI/UX Overhaul + Customization + Loose Coupling"

> **TEMPORARY working memory** for the Round-5 effort. Survives context resets.
> **DELETE THIS FILE when everything is done and committed.** Not to be committed.
> Started: 2026-07-01. Branch: `Testing`. Baseline commit: `27f0983`.

## The ask (verbatim intent from the user)
Run 100+ Opus-4.8 sub-agents to understand the whole app; then 50+ agents to deep-research
UI/UX; then implement with 100s of agents; verify + test everything; then a *second* UI
rework pass with ~100 agents. Highest standards. All sub-agents MUST be Opus 4.8.
**Do NOT co-author commits.** Keep this tracker so context resets don't lose the plan;
delete it when done.

## Goals
- **G1 Color scheme** — better, cohesive palette (light + dark).
- **G2 Design system** — adopt an established online system (stack is already
  shadcn/ui + Radix + Tailwind → consolidate HARD onto it; one consistent standard).
- **G3 Settings IA** — Settings.tsx is 2,673 lines and confusing; too many nested
  sub-menus. Redesign the information architecture.
- **G4 Dashboard real estate** — stop wasting screen space; denser, more useful.
- **G5 Hero card** — the "Security Posture Dashboard" HeroPanel (p-8, 3xl title +
  eyebrow + long description) wastes a whole vertical band. Make it a compact header.
  (Location: webui/src/soc/pages/Overview.tsx:543-569 + components/HeroPanel.tsx +
  layouts.tsx CommandCenterLayout.)
- **G6 Rules customizability** — expose detection-rule / correlation / risk /
  auto-close / tuning config in the UI (currently thin). This was requested before.
- **G7 Custom dashboards** — let users build their own dashboards (widgets/layout).
- **G8 Loose coupling** — audit + improve; components easily moved/detached/reused.
- **G9** — deeply verified + tested; UI very well done.
- **G10** — a SECOND UI rework pass after implementation.

## Hard constraints (DO NOT VIOLATE)
- All sub-agents = **Opus 4.8** (Workflow agents inherit the main-loop model = opus-4-8;
  omit `model` to inherit, or set `model:'opus'`).
- **No `Co-Authored-By` line in commits.** No "Generated with Claude Code" either unless asked.
- Keep the **12 non-negotiables** (CLAUDE.md §5). Especially:
  - #3 `engine/case_manager.py` `decide()` **BYTE-IDENTICAL** (close/escalate is
    deterministic; never LLM/playbook/dashboard-driven).
  - #6 one usage-ledger write per LLM call.
  - #9 log/user-influenceable text is UNTRUSTED → fenced/escaped in prompts AND
    rendered as plain text in the UI.
  - #2 append-only audit for state changes.
- **Additive + default-safe.** Keep tests green:
  baseline backend **1461 pytest**, webui **273 vitest**, `tsc --noEmit && vite build`
  clean, eslint 0 rules-of-hooks errors.
- **No new npm runtime deps** without a deliberate, recorded decision (recharts is
  already present? verify; charts.tsx exists). Backend: ZERO new runtime deps.
- Keep `webui/src/lib/types.ts` in sync with `backend/app/models.py`.
- Branch `Testing`. Commit focused; push only when asked.

## Baseline facts (captured P0)
- webui: 204 TS/TSX/CSS files, ~64.6k LOC. 41 pages, ~60 soc components, 29 ui primitives.
- Big files: Settings.tsx 2673, lib/types.ts 2047, Metrics.tsx 1446, Overview.tsx 872,
  lib/api.ts 797, NavSidebar.tsx 631, AppShell.tsx 616, nav.ts 374, theme-tokens.ts 400,
  theme.css 298, SettingsGrid.tsx 247.
- Design system: tokens in webui/src/styles/theme.css (CSS vars, light/dark), semantic
  colors in soc/components/palette.ts, primitives in webui/src/ui/*, domain comps in
  soc/components/*, layouts in soc/components/layouts.tsx (CommandCenter/Worklist/Investigation).
- Nav: NAV_GROUPS in soc/nav.ts — 6 groups (overview/triage/intelligence/analytics/
  notifications/platform); host pages with disclosure `children` (deep nesting).
- backend: 184 py files. config.py 2177 (Preferences incl. threshold_tuning/batch/
  baseline/campaign, all default OFF), models.py 1319, routes.py 4751, threshold_tuner.py
  865, correlation.py 379, threshold_automation.py 346, signatures.py 45, risk.py 95.

## Plan / phases  (update STATUS as we go)
- **P0 Baseline** — DONE. git clean @27f0983 on Testing; inventory captured above.
- **P1 Understand** (100+ agents) — map webui + backend + cross-cutting audits →
  `docs/research/2026-07-round5/understand/`. STATUS: pending.
- **P2 Research** (50+ agents) — external design research (color/type/spacing, dashboard
  patterns, settings IA, custom-dashboard builders, rules-config UX, loose-coupling
  patterns) → `docs/research/2026-07-round5/RESEARCH.md`. STATUS: pending.
- **P3 Synthesize** → `PROPOSAL.md` + `DESIGN_STANDARD.md` + implementation plan.
  STATUS: pending.
- **P4 Implement** (100s agents, sequenced by shared-file contention: theme/tokens →
  primitives → layouts/nav/shell → pages → new features rules+custom-dashboards →
  backend config/routes). STATUS: pending.
- **P5 Verify + test** (pytest/vitest/tsc/build/lint) + adversarial audit. STATUS: pending.
- **P6 UI rework pass** (100 agents — second polish/consistency sweep). STATUS: pending.
- **P7 Docs sync** (CLAUDE/HANDOFF/README/ROADMAP/CHANGELOG + round5 IMPLEMENTATION.md) +
  commit (NO co-author) + **delete this tracker**. STATUS: pending.

## USER DECISIONS (2026-07-01) — LOCKED
- Feature rollout: **custom dashboards + Rules editor ON BY DEFAULT** (dashboards read-only
  until Edit; per-role default layout; Rules editor visible w/ safe defaults). Additive + reversible.
- Commit style: **focused commit per implementation wave** on `Testing` (NO co-author line).
  Do NOT push unless asked.
- Palette: **use researched default** (Radix slate neutrals + Radix blue primary, 3 semantic axes,
  colorblind-safe chart ramp, real WCAG-AA both themes; keep command-center feel, fix contrast+drift).

## EMPIRICAL BASELINE (verified green 2026-07-01, exit 0)
- backend pytest: full run PASSED, 0 failures/errors (count per CLAUDE.md ~1461; confirm exact at P5).
- webui: `npm run build` clean; **273 vitest passed (45 files)**; eslint **0 errors** (3 benign
  exhaustive-deps warnings: Knowledge.tsx:293, Models.tsx:117, Settings.tsx:1769).
- Node 20.12.0, npm 10.5.0, Python 3.11.3, backend/.venv + webui/node_modules present.

## Decisions log
- Design system: **shadcn/ui + Radix + Tailwind** is already the base — consolidate onto
  it as the single standard (do NOT introduce a competing system). Dashboard/chart
  patterns: lean on established shadcn charts / Tremor-style patterns (research to confirm).
- Custom dashboards: user-configurable widget grid persisted per-user via the existing
  UserPrefsStore pattern (zero new index) — to be confirmed in P3.

## Running workflows (for resume after context reset)
- **P1 understand** — run `wf_4a454624-d72` (task `wj89rajt9`), 127 agents. Script:
  `.../workflows/scripts/round5-understand-wf_4a454624-d72.js`. Writes maps to
  `docs/research/2026-07-round5/understand/` (WEBUI_PAGES_MAP, DESIGN_SYSTEM_MAP,
  WEBUI_SHELL_COMPONENTS_MAP, BACKEND_MAP, AUDITS, EXECUTIVE_SUMMARY).
- **P2 research** — run `wf_363766e7-3ed` (task `wqj3w2j44`), 67 agents. Script:
  `.../workflows/scripts/round5-research-wf_363766e7-3ed.js`. Writes
  `docs/research/2026-07-round5/RESEARCH_*.md` + RESEARCH_SUMMARY.md.
- Both launched 2026-07-01, running concurrently in background. Waiting on both →
  then P3 synthesize (read the 12 output docs).

## P2 RESEARCH RESULT (DONE 2026-07-01 — 55/57 agents; 2 minor topics failed, covered elsewhere)
Docs written: docs/research/2026-07-round5/RESEARCH_SUMMARY.md + 7 RESEARCH_*.md.
Repo facts verified: recharts ^2.15.4 (only chart dep), Tailwind ^3.4.19 (v3 NOT v4),
React 18.3.1, framer-motion ^11.18.2; Inter+JetBrains Mono NAMED but NOT shipped (no
@fontsource/@font-face → falls back to OS stack); `--low` is green (severity collision);
KpiTile.tsx delta colored by SIGN not meaning (bug ~line 85); no grid lib; UserPrefs +
UserPrefsStore + org←user cascade already zero-migration; routes.py 4751 lines/124
endpoints, 0 `response_model=`; types.ts 2047-line hand-mirror of models.py.

### Dependency ledger (APPROVED unless noted — all additive, most dev-only/lazy)
- @fontsource-variable/inter, @fontsource-jetbrains-mono (DEV, build-time woff2) — ship fonts
- @tailwindcss/container-queries (DEV) — per-archetype widths
- @tanstack/react-virtual (~10KB) — virtualize big tables (scoped)
- @tanstack/react-table (~15KB) — headless engine under DataTable (deliberate wave)
- react-grid-layout v2 (~18.5KB, LAZY edit-mode only) — custom-dashboard grid (the one dash dep)
- zod (~13KB) — client rule validation/defaults mirroring config.py (Rules Phase 2)
- react-querybuilder v8 (LAZY+flag-gated, via shadcn registry) — nested AND/OR (Rules Phase 3)
- CodeMirror 6 (LAZY, opt-in) — raw-YAML rule escape hatch (Rules Phase 3)
- openapi-typescript (DEV, 0 runtime) — generate request/enum TS types
- eslint-plugin-import-x (DEV) — feature-folder boundaries
- jest-axe/@axe-core + eslint-plugin-jsx-a11y (DEV, 0 prod) — a11y CI gate
- pySigma (BACKEND) — Sigma import/export (Rules Phase 3)
- @dnd-kit (~10KB) — CONDITIONAL, only when a drag surface ships
REJECTED: Tremor (needs TW v4 + competing tokens), nivo/ECharts/visx, moment.js anything,
react-awesome-query-builder, Monaco, chroma-js/d3 runtimes, gridstack, pluggy/stevedore,
react-hook-form, TanStack Query (unapproved), OKLCH+TW-v4 @theme (deferred), full FSD.

### Key P2 DECISIONS (implement these)
- COLOR: split ONE palette into 3 orthogonal axes SEVERITY/STATUS/VERDICT; drop green from
  severity (`--low`→blue 205°); FP→neutral blue-grey (kill red/green CVD); add icon+shape to
  every badge (WCAG 1.4.1). Neutral+primary from Radix slate+blue 12-step (paste as CSS vars,
  no dep). Add --surface-sunken/--hover, chart tokens --chart-1..8 (Okabe-Ito) + viridis ramp.
- TYPE/SPACING: 14px body type scale (tuples w/ line-height+tracking), tabular-nums on numerics;
  8px spacing subset; Card padding p-4/p-6 (fix px-5); DataTable density persisted to UserPrefs.
- WIDTH: per-archetype (layout-wide ≤1760-1920 fluid for ops; layout-prose ~72ch for narrative);
  add columns at 2xl not stretch; @tailwindcss/container-queries.
- DASHBOARD: three-zone = compact control bar → KPI strip (4-6) → widget grid of named
  collapsible groups; ~7-8 points/view; tiles deep-link to filtered case list w/ URL state.
  Above-fold widgets: open-by-severity, needs-human attention queue, autonomous-vs-human split
  (#3 trust), MTTA/MTTR/dwell p50/p90, cost/budget, connector health, new-today+backlog, live feed.
- CHARTS: STAY on recharts (upgrade v2→v3, accessibilityLayer); keep in-house wrappers as the
  standard; borrow shadcn ChartConfig map idea; uPlot only escape hatch (lazy). Histogram=BarChart
  over server-binned; funnel=recharts FunnelChart. FIX KpiTile delta (goodDirection prop).
- TIME PICKER: in-house <TimeRangePicker> (Radix + ~40-line ES date-math parser; no moment).
- SETTINGS IA: REFINE not rebuild. 6→5 groups: Account / General(rename Configuration) /
  Integrations / **Security & access (NEW, promote Security to top-level; split Roles out of
  Users; move Secret keys here)** / Organization(rename Administration; Danger Zone isolated,red,
  last). Rename LABELS only, keep section ids stable (#/settings?s=<id>). Cap hierarchy 2 levels.
  Head-of-section enable toggles for default-OFF engine features. Fix 4 deep-link/Cmd-K gaps;
  lift a shared settings-sections.ts single source. Add ~40-line ui/collapsible.tsx.
- CUSTOM DASHBOARDS: react-grid-layout v2 (lazy edit-mode); in-house Map widget registry
  (soc/dashboard/registry.ts: WidgetType→WidgetDef{lazy Component,defaultSize,configFields,RBAC});
  widgets REUSE KpiTile/BarList/charts/DataTable/MitreHeatmap; persist to UserPrefs.dashboards
  dict (zero-migration, like saved_views; 12-col abs coords, schema_version, per-breakpoint,
  positions+type+options only, server-side widget-type allowlist on PUT). Builder = read-only
  default → Edit mode (sticky save/discard/reset, guard) → add from gallery → per-widget config
  Sheet → drag/resize → save. Per-role defaults w/ clone-to-customize. MVP 3-5 widgets. #3/#9/#10 held.
- RULES: consolidate + add preview/versioning; DON'T rewrite. Expose 3 tiers: Detection
  Match+Threshold (RuleDefinition+CorrelationRule), Detection Anomaly/Baseline (BaselineConfig),
  Case-automation (CaseAutomationRule, post-decide(), HITL-safe, NEVER sets status #3). Editor =
  Define→About→Schedule→Actions (Define polymorphic on rule type via discriminated union; thin
  adapter maps form↔wire keys so decide() BYTE-IDENTICAL). Condition builder: BUILD flat AND rows
  (zero dep); BUY react-querybuilder for nested AND/OR (gated Phase 3). Thresholds: NumberField +
  LabeledSlider (zero dep, clamp bounds, show tuner suggestion, keep "below floor: candidate only,
  never dropped" #4). Lifecycle: enabled/disabled/shadow; Test/Preview vs 7-14d recent data (RO
  scoped, capped, NEVER decide()/NEVER bills LLM — top trust feature); version ledger+diff+rollback
  (generalize stores/tuning.py CAS); risky→Approvals/Proposals HITL; audit all (#2). zod validation
  (Phase 2). Sigma via pySigma backend-only (Phase 3).
- COUPLING: bulletproof-react feature folders (not full FSD) + eslint-plugin-import-x boundaries;
  collapse nav.ts + App.tsx renderPage switch + PageId union into ONE typed FEATURES[] registry
  (derive nav+routes+palette, single enabled(ctx) predicate); replace onNavigate prop-drill (31
  pages) with useNavigate(); expose api via useApi(). BE: finish router split one-feature-per-PR
  (paths byte-identical), auto-discovery loader, extract generic EntryPointRegistry[T] (stdlib
  importlib.metadata), add discovery to notifications/LLM providers. Contract sync: openapi-typescript
  (dev, types only) + response_model= on ~10-15 endpoints + CI drift gate.
- A11Y: SEMANTIC_ICON map beside SEMANTIC color (non-color signaling #1 risk); 4 new WCAG2.2
  criteria (2.5.8 target size, 2.4.11 focus-not-obscured, 2.5.7 dragging alt, 3.3.8 accessible auth);
  th scope+aria-sort; useLiveAnnouncer polite region; MotionConfig reducedMotion="user"; jest-axe CI.
- SEQUENCING (P2): 1 Foundations(fonts/palette/type/spacing/icons/KpiTile fix/a11y) → 2 IA+coupling
  wave1(settings regroup+security promote, FEATURES registry, useNavigate, openapi-ts) → 3 Dashboards
  MVP(three-zone+TimeRangePicker+widget registry+RGL+seed widgets) → 4 Rules Ph1-2 → 5 Coupling
  wave2-3(router split, response_model, CI gate) → 6 gated(react-querybuilder,pySigma,CodeMirror,
  react-table,dnd-kit).

## P1 UNDERSTAND RESULT (DONE 2026-07-01 — 103/103 agents)
Docs: docs/research/2026-07-round5/understand/{EXECUTIVE_SUMMARY,WEBUI_PAGES_MAP,
DESIGN_SYSTEM_MAP,WEBUI_SHELL_COMPONENTS_MAP,BACKEND_MAP,AUDITS}.md
VERDICT: consolidation not reinvention. Foundation good, NOT enforced end-to-end.
### Top structural root causes (fix ONCE up front, then codemod):
1. Auto-close UI edits DEAD field prefs.fp_auto_close (Settings.tsx:1093-1094); decide()
   reads prefs.auto_close (case_manager.py:132-138). Flagship toggle does NOTHING. Fix UI
   plumbing → prefs.auto_close.false_positive; add true_positive opt-in (OFF); lock needs_human.
   NEVER touch decide(). [G6, small, highest value]
2. Two god-files: Settings.tsx 2673 LOC + CaseDetail.tsx 4210 LOC. Split = precondition for G3/G6/G8.
3. Two card grammars: shared @/ui/card (shadow-elev1) vs hand-rolled rounded-lg border bg-card p-5/p-6
   (CaseDetail 31×, Settings 8×). Codemod to @/ui/card.
4. Two nav systems: nav.ts rail vs Settings.tsx own SECTION_GROUPS IA (#/settings?s= + scroll-spy).
   Admin surfaces have 2 homes. Nesting up to 4 deep. Collapse to one PAGE_REGISTRY. [G3 root]
5. WCAG-AA failures the comments DENY: light severity/info/success/warning 3.24-4.17:1; dark
   white-on-primary 3.35, on-critical 3.60, teal 3.74; --border ~1.3:1. Root: each --{hue} overloaded
   as text+wash+fill. Fix: split --{hue}/--{hue}-foreground/--{hue}-text (Radix Colors gen). [G1/G9]
6. Hard max-w-[1400px] shell cap, no per-page opt-out (AppShell.tsx:601). Add <PageContainer
   variant=fixed|wide|fluid>. [G4/G7 highest-leverage width fix]
7. Rule config INVISIBLE: rule_catalog (18 RuleDefinitions), correlation_rules, asset_networks/
   criticality, SlaPolicy, PriorityMatrix, suppression_rules appear 0× in webui; Round-4 blocks
   (threshold_tuning/campaign/baseline/batch, caps.max_concurrent) no Settings UI. Models expressive;
   UI missing. Consolidate → one "Detection & Rules" home. [G6]
8. Dead GET /api/settings/schema (settings_schema.py, 0 consumers, can't describe list/dict).
   Extend reflector + wire → generic renderer. [G3/G6/G8]
9. Three parallel API/type layers: lib/api.ts (120 methods) + 16 *.api.ts (111 raw call sites) +
   useEventStream; types.ts (2047) mirrors only R1/2 — AutoClosePolicy/correlation_rules/R4 UNmirrored.
   [G6/G8 — mirror real config types into types.ts FIRST]
10. Overview hero+dashboard waste ~31% of fold. Merge HeroPanel→PageHeader compact variant (~90px),
    shrink 208px gauge, un-nest 7-KPI grid, drop redundant <dl>, remove ~120 lines client posture math. [G4/G5]
11. Two semantic-color systems drifted (charts palette.ts SEMANTIC vs badges.tsx switch): escalated
    orange/red, duplicate mismatch, 4 band ladders disagree. ONE label→token map. [G1/G2/G8]
12. G7 custom dashboards = zero infra BUT proven template: per-user DashboardStore (copy inbox.py/
    tuning.py KV+kv_mutate CAS), dashboards field like saved_views, widget registry (each pure metric
    fn = a widget), <WidgetGrid>. No new index/table/migration.
13. user_prefs.py:103-122 misc write CLOBBERS (not deep-merge; test_user_prefs.py:323-325 codifies bug).
    Fix BEFORE G7; use kv_mutate CAS not user_prefs for DashboardStore. [G7/G9]
14. Layering inversions: components/ import UP into pages/*.api (CaseTriageHeader→CaseDetail.api,
    RoleMatrixEditor→Roles.api, ModelsCatalog→Models.api, NotificationPrefs→Inbox.api); SessionsTable
    page-local imported cross-page. Extract trapped editors to components/; invert deps. [G8]
15. Missing shared primitives (SegmentedControl, FilterBar, ConfirmDialog, IconInput, SecretField,
    TagInput, <Field> a11y wrapper, useAsync, useDirtyDraft) hand-rolled 2-9×; window.confirm() for
    destructive deletes; ~39 unlabeled controls. Extract once. [G2/G8/G9]
### CONFIRMED BUGS (fix regardless):
- Metrics delta green UP arrow next to "-12%" (deltaView sign-flip vs KpiTile). + KpiTile colors delta
  by sign not meaning (P2). Add goodDirection prop.
- Wizard demo toggle cosmetic (writes dead demo_mode; never arms Preferences.demo/POST demo/enable).
- Roles nav gates roles:view (not a real action); page requires roles:manage — mismatch.
- Cases one-click destructive close, NO confirm. Campaigns "Recorrelate" gated by READ perm.
- Clipboard over plain HTTP broken (navigator.clipboard undefined on http; lib/clipboard.ts copyText()
  fallback never used) — CodeBlock.tsx:99-111, ChatPanel:338-347.
- api.setup.initAdmin POSTs removed setup/init-admin (404); live flow uses setup/account.
- Automation verdict options offer suspicious/benign (Disposition, never match Verdict) → rules never fire.
- request_approval automation dead end (approve 400s); TuningLedgerRow renders every row "Active";
  SQL sort_field='risk_score' no-ops; derive_priority disagrees triage-chip vs shift-report on matrix.enabled.
### TESTS/STRINGS THAT WILL BREAK (migrate to data-testid FIRST):
- App.smoke.test.tsx boots on literal "Security Posture Dashboard" — update guard in lockstep, don't delete.
- 273 vitest specs re-snapshot in BOTH themes after token change. test_user_prefs.py:323-325 codifies misc
  clobber (must update when fixing). Class/hex-string assertions break on card codemod / hue split.
- Pages with ZERO tests (add if changed): Overview, Standup, Approvals, Memory, Investigate, Sources, Catalog.
- Respect: decide() byte-identical #3; PUT /api/settings must MERGE (full-doc-replace wipes unrendered
  blocks); secret-boolean #10; untrusted plain-text render #9; 401/reauth; deep-link back-compat 31 page ids;
  Login eager+framer-free.

## P3 SYNTHESIS RESULT (DONE 2026-07-01)
Docs: docs/research/2026-07-round5/{PROPOSAL.md (382L), DESIGN_STANDARD.md (837L, 47 measured
contrast citations — THE canonical spec agents code against), IMPLEMENTATION.md (394L wave plan)}.
### WAVE PLAN (from IMPLEMENTATION.md) — drive top to bottom, verify+commit per wave:
W0 FOUNDATIONS (serial on root files):
  W0-Z test-anchoring (data-testid + Overview.PAGE_TITLE const; migrate ~10 brittle specs) [FIRST]
  W0-A tokens [SERIAL 1 agent owns theme.css+palette.ts+tailwind.config.js+theme-tokens.ts]:
    fonts(@fontsource inter+jetbrains-mono), Radix slate+blue tiers, 3-axis palette
    (--{t}/-foreground/-text), chart ramps --chart-1..8 Okabe-Ito + viridis, shadow/radius,
    ONE label→token authority in palette.ts (+SEMANTIC_ICON, delete badges.tsx switches),
    runtime AA guard, fix false "WCAG-AA" comments, +@tailwindcss/container-queries plugin.
  W0-B [PARALLEL new files]: recipes, Card padding/elevation props, control primitives
    (SegmentedControl/FilterBar/ConfirmDialog/Field/SecretField/NumberField/LabeledSlider/
    TagInput/IconButton/collapsible), typography.tsx, hooks (useAsync/useDirtyDraft/usePosture/
    usePrefersReducedMotion/useMediaQuery/useLiveAnnouncer), errorMessage.ts+LoadError.tsx, variant adds.
  W0-C [SERIAL AppShell/App]: <PageContainer fixed|wide|fluid|prose>, KILL max-w-[1400px]
    (AppShell.tsx:601), <MotionConfig reducedMotion=user>, --header-h token, reduced-motion upgrade.
  W0-D [SERIAL PageHeader/HeroPanel/KpiTile]: KpiTile goodDirection (bug#2), merge HeroPanel→
    PageHeader variant dense|hero (G5), shrink RiskGauge ~150-160px + numeric+band.
  W0-E [PARALLEL]: wire SEMANTIC_ICON, 4 WCAG2.2 criteria, live announcer+aria-sort, CI gates
    (token-existence, ~20-line contrast checker, no-arbitrary-text-[, no-hex, CVD) + jest-axe/jsx-a11y.
  W0-F [SERIAL types.ts→api.ts→nav.ts; PARALLEL backend]: F1 mirror REAL config types into
    types.ts (AutoClosePolicy/correlation_rules/rule_catalog/RuleMatch/asset*/SlaPolicy/priority_matrix/
    R4 blocks/caps); F2 api scaffolds (api.rules/dashboards/triage + baseline/campaign/batch
    getConfig/putConfig) + DELETE api.setup.initAdmin (bug#10) + clipboard fix (bug#4); F3 FEATURES[]
    registry behind exports (nav.ts thin re-export); F4 POST /api/triage/preview-decision (pure decide()
    wrapper, no LLM, no case write); F5 typed config endpoints baseline/campaign/batch; F6 fix misc
    clobber (bug#5, flip test_user_prefs.py:323-325); F7 DashboardStore + UserPrefs.dashboards (zero-migration).
FEATURE WAVES (parallel, disjoint): Codemod (adopt primitives) · Settings (Sett-A registry/Sett-B IA
  5-group+Security promote/Sett-C schema fallback+deep-link fixes) · Dashboard (Dash-A Overview compact/
  Dash-B three-zone+TimeRangePicker/Dash-C Metrics+Cases density) · Rules G6 (R1 auto-close FIRST →
  Detection&Rules home/flat builder/NumberField/preview-no-LLM/version ledger/asset-SLA-priority/zod/
  RBAC) · Custom-Dash G7 (registry+ChartCard/DataProvider/WidgetGrid+lazy RGL/builder+role defaults/
  routes) · Coupling G8 (useNavigate/useAsync adopt/invert layering/split CaseDetail 4210/split routes.py
  4751 one-slice-per-PR/entry-points+openapi-typescript) · Bug batch (14) · A11Y pass · Gated · G10 polish.
14 CONFIRMED BUGS mapped to waves (see IMPLEMENTATION.md table).
### EXECUTION MODEL (orchestrator): run W0 sub-waves via workflows honoring SERIAL/PARALLEL markers;
end each workflow with a VERIFY agent (pytest -q / npm run build / vitest run / npm run lint /
git diff --exit-code case_manager.py). Commit focused per wave (NO co-author), don't push.
HIGH-CONTENTION FILES (never 2 concurrent agents on same file): theme.css, palette.ts,
tailwind.config.js, theme-tokens.ts, types.ts, api.ts, nav.ts, App.tsx, AppShell.tsx, Settings.tsx,
CaseDetail.tsx, config.py, models.py, routes.py.

## COMMITS (Round 5, on Testing, NO co-author)
- 5ab7c05 docs(round5): understanding + research + PROPOSAL/DESIGN_STANDARD/IMPLEMENTATION
- 0e99c76 feat(round5-w0): foundations pt1 — test anchoring (W0-Z) + color/token system (W0-A)
- 9854c36 feat(round5-w0): foundations pt2 — primitives, shell width, compact header, coupling infra
  (W0-B/C/D/E/F). New verified baseline: 1505 pytest / 348 vitest / build clean / 0 lint errors.
- 7c86706 feat(round5): Settings IA overhaul + auto-close fix (G3, bug#1, bug#7). Settings.tsx 2673→575;
  registry + pages/settings/*; 5 groups + Security promoted; 33 redirect tests; schema fallback.
  Baseline now: 1518 pytest / 414 vitest / build clean / 0 lint errors.
- f50e0b2 feat(round5): dashboard density + hero compaction + three-zone (G4/G5). Overview compact hero,
  three-zone, PageContainer wide, Metrics/Cases density. 446 vitest.
- 3e447da feat(round5): codemod primitives across pages + split CaseDetail (G2/G8). CaseDetail 4210→1529.
- NOTE: 1 FLAKY vitest test (async render timeout under CPU load; passes 2/3 runs). Stabilize in P6 polish.
- NOTE: index bundle chunk grew ~248→489kB (recharts still split). Restore code-splitting in Coupling wave
  (likely settings-sections registry / dashboard eagerly pulled into entry). Check bundle-first-paint stays green.
- WAVE STATUS: W0 done; Settings done; Dashboard done; Codemod+CaseDetail done; RULES G6 running (wf_fa238eab-20e);
  next: Custom-Dash G7 → Coupling G8 (+restore code-splitting, remaining bugs #3,#9,#11,#13,#14) → A11y → P5 → P6 → P7.
- CONTENTION for remaining waves: Rules+CustomDash both touch registry/nav (running Rules FIRST, then CustomDash).
  Coupling-A (useNavigate) touches ALL pages → run LAST after all page edits. routes.py split = one-slice serial.

## VERIFIED BASELINE NOW: backend 1505 pytest, webui 348 vitest, build clean, 0 lint errors (jsx-a11y
## warnings acceptable), case_manager.py byte-identical. W0 FOUNDATIONS COMPLETE.
## FEATURE WAVE EXECUTION MODEL: sequential wave-workflows (internal parallelism), verify+commit each.
## Order: Settings(running) → Dashboard → Codemod+CaseDetail → Rules G6 → Custom-Dash G7 → Coupling G8
## → A11y → P5 verify → P6 polish → P7 docs. Page partition (disjoint): Settings owns Settings.tsx+
## pages/settings/*; Dashboard owns Overview/Metrics/Cases; Codemod owns other pages; CaseDetail owns
## CaseDetail.tsx; Rules=new editor+settings sections; CustomDash=new soc/dashboard/*; Coupling last.

## Progress log (append newest at top)
- 2026-07-01 — W0-P2 LAUNCHED (14 agents, 2 concurrent chains: UI [B1/B2/C ‖ then B3/D ‖ then E1/E4]
  + coupling-infra [F4/F5/F67 ‖ FE F1→F2→F3]). Verify agent at end. run wf_7a7a9237-cb5 (task wqyqszaj4).
- 2026-07-01 — W0-P1 GREEN + COMMITTED (0e99c76). backend 1467 pytest / build clean / 288 vitest /
  0 lint errors / case_manager byte-identical. Baseline counts updated: pytest 1467, vitest 288.
- 2026-07-01 — P3 DONE. PROPOSAL+DESIGN_STANDARD+IMPLEMENTATION written. Starting P4 W0.
- 2026-07-01 — P1 DONE (103/103). EXECUTIVE_SUMMARY + 5 maps + AUDITS on disk. Findings above.
  Launching P3 synthesize (PROPOSAL + DESIGN_STANDARD + IMPLEMENTATION).
- 2026-07-01 — P2 DONE (55/57). Full decision brief in RESEARCH_SUMMARY.md; decisions captured
  above. Waiting on P1 understand to finish, then P3 synthesize PROPOSAL + DESIGN_STANDARD.
- 2026-07-01 — P1 (127 agents) + P2 (67 agents) launched concurrently in background.
- 2026-07-01 — P0 done. Tracker created.
