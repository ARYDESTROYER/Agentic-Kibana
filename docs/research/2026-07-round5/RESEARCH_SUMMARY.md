# Round 5 P2 — Research Summary & Decision Brief

**TLSOC Agentic Triage Suite — the standalone SOC triage console (webui).**

This is the top-level decision brief for Round 5 P2. It synthesizes seven domain
research documents into a single set of crisp DECISIONS with rationale and an
explicit new-dependency ledger. It is written for a **data-dense operational
console for security analysts** — not a marketing site — and it holds the project's
standing constraints: prefer **NO new heavy npm deps**; every change is
**additive + reversible**; the 12 non-negotiables hold (esp. #3 `case_manager.decide()`
byte-identical, #9 untrusted-label fencing, #10 calm defaults).

**Verified against the live repo (2026-07-01):** `charts.tsx` uses **recharts ^2.15.4**
(the sole chart dep), **Tailwind ^3.4.19** (v3, not v4), **React 18.3.1**,
**framer-motion ^11.18.2**. Inter + JetBrains Mono are *named but never shipped*
(no `@fontsource`/`@font-face` — prod falls back to the OS system stack). `--low` is
green (severity-palette collision confirmed). `KpiTile.tsx` colors deltas by sign
not meaning (real bug). No grid library today. `UserPrefs` + `UserPrefsStore` +
org←user cascade already exist zero-migration. `routes.py` is a 4751-line /
124-endpoint monolith; `types.ts` is a 2047-line hand-mirror of `models.py`;
`response_model=` appears **0** times.

The seven source docs (same directory):
`RESEARCH_COLOR_TYPE_SPACING.md` · `RESEARCH_DASHBOARD_PATTERNS.md` ·
`RESEARCH_SETTINGS_IA.md` · `RESEARCH_CUSTOM_DASHBOARDS.md` ·
`RESEARCH_RULES_UX.md` · `RESEARCH_COUPLING.md` · `RESEARCH_A11Y_MOTION.md`.

---

## 0. The new-dependency ledger (the whole approval list, in one place)

Every other section refers back here. Nothing outside this table gets installed.

| Dep | Type | Size | For | Verdict |
|---|---|---|---|---|
| `@fontsource-variable/inter` | **dev** (build-time WOFF2) | assets only, 0 runtime JS | Ship the font we already claim to use | **APPROVE** |
| `@fontsource-jetbrains-mono` | **dev** (build-time WOFF2) | assets only, 0 runtime JS | Mono for IDs/logs/numerics | **APPROVE** |
| `@tailwindcss/container-queries` | **dev** (Tailwind plugin) | tiny, 0 runtime | Per-archetype responsive widths | **APPROVE** |
| `@tanstack/react-virtual` | runtime | ~10 KB gz | Virtualize cases/logs tables (1000+ rows) | **APPROVE (scoped)** |
| `@tanstack/react-table` | runtime | ~15 KB gz | Headless engine under existing `DataTable` (kills ~13 duplicated filter/sort/slice paths) | **APPROVE (deliberate wave)** |
| `react-grid-layout` v2.2.3 | runtime, **lazy (edit mode only)** | ~18.5 KB gz | Custom-dashboard drag/resize grid | **APPROVE (the one dashboard dep)** |
| `zod` | runtime | ~13 KB gz | Single source of client-side rule validation + defaults mirroring `config.py` | **APPROVE (Rules Phase 2)** |
| `react-querybuilder` v8 | runtime, **flag-gated + lazy** | RQB core only (tree-shake formatters) | Nested AND/OR condition trees (exceptions) — via official shadcn registry | **APPROVE (Rules Phase 3, gated)** |
| CodeMirror 6 | runtime, **lazy** | ~300 KB | Optional raw-YAML rule escape hatch | **APPROVE (Rules Phase 3, opt-in only)** |
| `openapi-typescript` | **dev** | 0 runtime bytes | Generate request/enum TS types from OpenAPI | **APPROVE** |
| `eslint-plugin-import-x` | **dev** | 0 runtime | Enforce feature-folder boundaries | **APPROVE** |
| `jest-axe` / `@axe-core` | **dev** | 0 prod bundle | A11y assertions in Vitest/CI | **APPROVE** |
| `eslint-plugin-jsx-a11y` | **dev** | 0 prod bundle | Lint a11y at author time | **APPROVE** |
| `pySigma` | **backend** only | n/a (Python) | Sigma rule import/export (frontend needs nothing) | **APPROVE (Rules Phase 3)** |
| `@dnd-kit` | runtime | ~10 KB | Drag surfaces (column/saved-view reorder) | **CONDITIONAL — install only when a drag surface actually ships** |

**Runtime bytes added to the default (read-only, non-edit) bundle:** effectively
**zero** — the two chart-adjacent runtime deps (`react-grid-layout`,
`react-querybuilder`, CodeMirror) are all **lazy-loaded** and never touch the hot
read paths. `react-table`/`react-virtual`/`zod` are small and load with the pages
that need them.

**Explicitly REJECTED:** Tremor (needs Tailwind v4 — hard blocker; competing token
system; re-opens #9), nivo / ECharts / visx (heavy or no a11y), `@elastic/datemath`
(drags moment.js), `react-awesome-query-builder` (deprecated moment.js + immutable +
lodash), Monaco (2–5 MB), `chroma-js` / `d3` color runtimes, `windy-radix-palette`,
gridstack / dnd-kit-for-grids / snapgrid, pluggy / stevedore, `react-hook-form`
(controlled draft-snapshot model already works), TanStack Query (optional; must be
separately justified — not approved here), OKLCH + Tailwind-v4 `@theme` (deferred),
Module Federation / runtime plugin loaders, full Feature-Sliced-Design, `moment.js`
in any form.

---

## 1. Design direction — color, type, spacing

**DECISION 1.1 — Ship the fonts we declare (self-host, build-time).**
Add `@fontsource-variable/inter` + `@fontsource-jetbrains-mono` as **dev-deps**
(build-time WOFF2 assets, subset latin, preload one weight). Today "we use Inter" is
false in prod — this is the single highest-impact fix and adds zero runtime JS.
*Rationale:* consistency across OSes, no FOUT surprises, no CDN dependency, offline-safe.

**DECISION 1.2 — Split the conflated palette into 3 orthogonal axes.**
Replace the single semantic map with **SEVERITY / STATUS / VERDICT** as independent
axes. Drop green from severity (`--low` → **blue `205°`**); verdict FP → **neutral
blue-grey**, not green (kills the red/green CVD hazard); **add icon + shape** to every
badge (WCAG 1.4.1) plus a left-edge severity band on rows. Concrete light+dark HSL
values are in `RESEARCH_COLOR_TYPE_SPACING.md`. This is the shared root fix that
sections 1.7 (charts) and 7 (a11y non-color signaling) both build on.

**DECISION 1.3 — Density-tuned type scale.**
Redefine the Tailwind `fontSize` scale to `[size,{lineHeight,letterSpacing,fontWeight}]`
tuples anchored at **14px body** (16px root retained), line-heights on 4px multiples,
`tabular-nums` on all numerics. Upgrades ~806/855 existing usages with **zero JSX
churn** (the class names are unchanged; only the tuple definitions change).

**DECISION 1.4 — Sanction an 8px spacing subset + fix off-grid padding.**
Card `px-5` (20px) → `p-4`/`p-6` via the primitive + a codemod (~37 files). Persist
**DataTable density** to `UserPrefsStore` (compact default for analyst tables).
*Rejected:* a global 4px spacing base (too fine for an 8px-grid console).

**DECISION 1.5 — Re-derive neutral + primary chrome from Radix slate + blue 12-step
scales.** Paste the step values as CSS vars (zero dep). Gives the
surface/border/state/text separation dense tables need. Full token mapping in the
color doc. Add `--surface-sunken` + `--hover`; formalize elevation/shadow tokens
(borders for tiled/scrolled content, shadows only for portals; the dark ladder is
already correct).

**DECISION 1.6 — Per-archetype content width (not one global cap).**
Replace the blunt global `max-w-[1400px]` with `layout-wide` (≤1760–1920px fluid) for
operational pages and `layout-prose` (~72ch) for narrative. Add columns at `2xl`
instead of stretching. Adopt the tiny first-party `@tailwindcss/container-queries`
plugin (dev-dep).

**DECISION 1.7 — Colorblind-safe chart ramps as new tokens.**
Add `--chart-1..8` (Okabe-Ito categorical) + a viridis sequential ramp as CSS var
tokens; rewrite `CATEGORICAL` off these (fixes the Cost-donut color collisions). No
`chroma-js`/`d3` — static token lists. **Trim `CATEGORICAL` from 8 → ≤6** and
CVD-verify (agrees with the a11y doc).

**DEFERRED (not now):** OKLCH + Tailwind-v4 `@theme inline`. Real upside but flips the
shadcn token contract and needs a full retest — a scoped follow-up, not this round.

---

## 2. Dashboards + chart library

**DECISION 2.1 — Adopt the universal three-zone dashboard layout.**
Grafana / Datadog / Elastic Security / Sentinel / Splunk ES all converge on:
**compact control bar** (time-range pill + auto-refresh + variable dropdowns + a "last
refreshed" stamp) → **KPI strip** of 4–6 drill-down tiles → **widget grid of named,
collapsible groups** ordered as a narrative (general → specific, top-left = most
critical). Universal rules: ~7–8 actionable points per view; every tile/segment/row
**deep-links into the filtered case list** carrying the current range + variables
(**serialized to the URL** for shareability); all color resolves from the semantic
palette tokens.

**DECISION 2.2 — Chart library: STAY on recharts; upgrade v2.15.4 → v3; keep our
in-house wrappers as the standard.** recharts is already our only chart dep and is
exactly what shadcn Charts is built on. Our wrappers already do CSS-var theming +
SOC-semantic color + `role="img"`/`aria-label` + sr-only table fallbacks + #9
untrusted-label safety — everything shadcn Charts offers, plus more. **Borrow two
ideas only** from shadcn: (a) a `ChartConfig`-style `{key:{label,color,token}}` map in
the palette module; (b) the `accessibilityLayer` prop (keyboard + screen-reader, new
in v3). **uPlot is the single sanctioned escape hatch** — lazy-loaded, only if we ever
add a dense live-tail time-series. *Rejected:* Tremor, nivo, ECharts, visx (see the
ledger).

**DECISION 2.3 — The two genuine chart gaps need NO new dep.**
A **histogram** (dwell/latency distribution) is a `BarChart` over **server-binned**
data; a **funnel** (event-detection / triage pipeline) is recharts' built-in
`FunnelChart`.

**DECISION 2.4 — Prioritized above-the-fold widgets (cap ~6–8).**
(1) open cases by severity/urgency; (2) the **needs-human attention queue** sorted by
aging-vs-SLA (the #1 operator surface); (3) the **autonomous-vs-human split**
(auto-closed by `decide()` vs escalated — our differentiator and the #3 trust
surface); (4) MTTA/MTTR/dwell trio with p50/p90; (5) cost/budget meter; (6)
per-connector pipeline-health strip; (7) new-cases-today + backlog trend with a
"stack-by" control; (8) live event feed. **Below the fold:** MITRE heatmap, dwell
histogram, verdict/disposition mix.

**DECISION 2.5 — Fix the `KpiTile` delta bug.**
`delta.value >= 0 ? success : critical` (~line 85) colors deltas by **sign, not
meaning** — "open alerts +30%" renders green. Add a `goodDirection` prop: **color =
improvement, arrow = true direction.** Must-fix.

**DECISION 2.6 — Build an in-house `<TimeRangePicker>`.**
Radix popover/tabs/select + a **~40-line ES date-math parser** (avoid
`@elastic/datemath` → moment.js). Pause auto-refresh on hidden tabs to save LLM cost.

**DECISION 2.7 (deliberate waves, not speculative):**
- Adopt the **shadcn `sidebar` primitive** (~0 net deps) to close our only real nav
  gap — a mobile Sheet drawer — but **port our RBAC / disclosure-a11y / server-prefs
  onto it**. Do NOT install `dashboard-01` (pulls 6 heavy deps).
- Adopt **`@tanstack/react-table` (~15 KB) as the headless engine under the existing
  `DataTable`** to kill duplicated per-page filter/sort/slice logic across ~13 pages.
  Additive and reversible; our component API stays.

---

## 3. Settings + navigation IA

**DECISION 3.1 — Refine, don't rebuild.** The Settings surface is already ~80% aligned
(two-scope split, persistent section rail, RBAC-filtered visibility, keyword search,
sticky-save, Cmd-K palette). Every recommendation below is achievable with **zero new
heavy npm deps** — the one net-new UI file is a ~40-line Radix `collapsible.tsx`
copy-paste.

**DECISION 3.2 — Promote Security to its own top-level group (the single
highest-leverage change).** Every reference product (GitHub/Linear/Slack/Notion/
Stripe/Vercel) does this; we currently bury SSO + token/session policy under
"Administration." Target IA (6 groups → 5):

- **Account** (personal): Profile · Security & two-factor · Sessions · Appearance
- **General** (rename of Configuration): Data scope · Models · Detection · Cases ·
  Automation · Standup
- **Integrations**: Sources & feeds (new rail entry) · Notifications · Enrichment ·
  Knowledge
- **Security & access** (NEW): Users · **Roles (split out of Users)** · SSO ·
  Session/token policy · Active sessions · **Secret keys (moved here)**
- **Organization** (rename of Administration): Branding · Advanced ·
  Experimental/Demo · **Danger zone (isolated, red, last)**

**Rename display labels only — keep section `id`s stable** (deep-linked via
`#/settings?s=<id>`); ship redirect aliases if any id must change.

**DECISION 3.3 — Count-driven page-vs-tab-vs-section rule.** Inline for 1–3 fields;
in-page shadcn `<Tabs>` for 3–6 non-comparable peer views (e.g.
`Security [SSO | Sessions | Policy]`); a section for a cohesive field cluster; its
**own page** when it's a distinct object (Users, Roles, Sources), long-form config,
has sub-structure, or a different scope. Cap the hierarchy at **two levels** (rail
group → section page → in-page cards/tabs; never a third menu level).

**DECISION 3.4 — Two disclosure tiers only.** Gate the default-OFF engine features
(tuning/batch/baseline/campaigns/event-detection) behind a **head-of-section enable
toggle**; keep the Danger Zone **visible-but-guarded, never hidden**; search/anchors
must auto-expand collapsed cards. Vendor `ui/collapsible.tsx` (Radix, MIT); keep
`Accordion type="multiple"`; put `aria-expanded` on the trigger button.

**DECISION 3.5 — Close four zero-dep search/deep-link gaps.**
(1) The router strips `?` / clears `opts` on hashchange, so palette→section deep-links
silently drop — **write the full hash directly**. (2) Register sections as Cmd-K jump
targets from a **lifted shared `settings-sections.ts`** (single source of truth, same
RBAC filter). (3) Add card-level `&a=<anchor>` deep-links with a reduced-motion-safe
highlight flash. (4) Deepen the inline filter from section- to **setting-level**
(optionally VS Code `@modified`/`@advanced` scoping).

**WATCH-OUTS:** don't grey-out RBAC items (remove whole groups); don't let
"Experimental" become a dumping ground; preserve the Rules-of-Hooks ordering
(visibility `useMemo`s above the early returns, per the `Settings.tsx:2340` comment).

---

## 4. Custom dashboards architecture

**DECISION 4.1 — Grid library: `react-grid-layout` v2.2.3 (the one justified new
dep).** MIT, ~18.5 KB gz, **lazy-loaded in edit mode only**. React-native (layout is a
serializable prop; `onLayoutChange` emits `Record<breakpoint, Layout[]>`), TS-first,
v2 supports React 18, and its item shape `{i,x,y,w,h,minW,minH,static}` **is** our
persistence schema. Grafana/Metabase/Kibana/ilert precedent. *Rejected:* dnd-kit (no
grid/resize — the expensive 80% you'd rebuild; reserve it for kanban/sortable lists),
gridstack (imperative React wrapper), snapgrid (not npm-resolvable).

**DECISION 4.2 — Charts: KEEP recharts, reject Tremor.** (Same call as §2.2 — Tremor
needs Tailwind v4, a hard blocker, and brings a competing `tremor-brand-*` token
system that ignores shadcn CSS vars and re-opens #9.) If we want richer chart
containers, port shadcn's own `<ChartContainer>` (`--chart-1..5` CSS vars) — zero new
dep.

**DECISION 4.3 — Widget registry: in-house `Map`-based.**
`webui/src/soc/dashboard/registry.ts`: `enum WidgetType → WidgetDef` (lazy
`Component`, `defaultSize`, declarative `configFields`, RBAC `requires`). Widget bodies
**reuse** existing `KpiTile` / `BarList` / `charts.tsx` / `DataTable` / `MitreHeatmap`.
Separates "what a widget is" (code) from "where it sits" (data), Grafana-style.
**Reconcile-on-load** drops unknown types + RBAC-filters + appends new role defaults.

**DECISION 4.4 — Persistence: one additive field on `UserPrefs`.**
`dashboards: dict[str, DashboardLayout]` (zero-migration, same pattern as
`saved_views`). **Absolute grid-unit coordinates over 12 cols** (Grafana/Metabase
model, NOT Superset's tree), `schema_version` from day one, per-breakpoint `layouts`,
store **positions + type + options only** (never data, never pixels). Org/role
defaults via `CustomizationConfig` + role-tier resolution in the existing org←user
cascade; reset = delete the user's bucket key. **Server-side widget-type allowlist on
PUT**; debounce ~500ms, persist on settle.

**DECISION 4.5 — Builder UX: the universal 5-step loop.**
Read-only default → explicit **Edit mode** (sticky Save/Discard/Reset bar,
unsaved-changes guard, `<Can>`-gated) → **Add from a curated gallery** (never a blank
canvas) → per-widget config **Sheet** → RGL drag/resize → explicit **Save**. Per-role
immutable default dashboards with **clone-to-customize on first edit** (analyst =
triage, manager = SLA/MTTR, auditor = posture, admin = cost/health). **MVP = 3–5
widgets;** defer sharing/ACLs, cross-filtering, import/export.

**Non-negotiables held:** #3 (layout is advisory, never feeds `decide()`), #9
(titles/labels plain-text/SVG only, allowlist-validated), #10 (calm read-only
default), lazy-load keeps hot paths lean.

---

## 5. Rules customization UX

**DECISION 5.1 — Consolidate + add a preview/versioning layer; do NOT rewrite.** The
backend is already ~70% there. The default editor ships with **zero new npm deps**.

**DECISION 5.2 — Expose three rule tiers (each already backed by code — do NOT copy
Elastic's seven):**
1. **Detection rule — Match + Threshold** (`RuleDefinition` + `CorrelationRule`):
   predicate rows → group-by + trigger-after-N + within-window (`n=1` = simple match,
   `n>1` = brute-force/threshold).
2. **Detection rule — Anomaly/Baseline** (`BaselineConfig`): fire on deviation from
   the learned hour-of-week baseline.
3. **Case-automation rule** (`CaseAutomationRule`): post-`decide()`, HITL-safe
   (tag/recommend/notify/run_playbook/request_approval) — **never sets status** (#3).

Keep **Threshold / Suppression / Exceptions / MITRE-mapping** as *distinct,
clearly-labeled* concepts — conflating them is the #1 analyst footgun.

**DECISION 5.3 — Editor shell: Elastic's four-section Define → About → Schedule →
Actions** (Radix `Tabs`), where **Define is polymorphic on rule type** (a TS
discriminated union). A thin deterministic adapter maps the form ↔ existing wire keys,
so `case_manager.decide()` stays **byte-identical** (#3).

**DECISION 5.4 — Condition builder: split build-vs-buy.**
- **Simple all-AND predicates → BUILD** (flat `{field, op, value}` rows over Radix
  `Select`/`Input` — exactly what `RuleMatch` is). Zero deps; covers the common case.
- **Nested AND/OR (exceptions) → BUY, gated:** `react-querybuilder` v8 (MIT, category
  standard, React-18-compatible) via its **official shadcn registry**
  (`npx shadcn add …/r/query-builder.json` — copies editable source in). Tree-shake
  formatters, cap nesting at 3, feed it OCSF-typed fields, flag-gate it.
- **Raw YAML escape hatch → optional, lazy CodeMirror 6** (~300 KB); never Monaco.

**DECISION 5.5 — Threshold UX: never slider-only for load-bearing values.** Build two
zero-dep components — a **`NumberField`** (stepper + clamp-on-blur + unit + reset;
primary for integers and 0..1 rates shown as %) and a **`LabeledSlider`** (Radix
slider ⇄ linked input + ticks, for ordinal `severity_floor` + exploration). Enforce
bounds in the UI; surface the tuner's suggestion inline; keep the live "effective
config" preview and the copy **"below floor: candidate only — never dropped" (#4)**.

**DECISION 5.6 — Lifecycle.** Three states **enabled / disabled / shadow(preview)**; a
**Test/Preview against 7–14 days of recent data** (histogram via existing recharts, RO
scoped key, hard-capped, **never `decide()` / never bills LLM** — the single
highest-value trust feature); an **immutable version ledger + red/green diff +
one-click rollback** (generalize the existing `stores/tuning.py` CAS ledger; tiny
inline diff, **no diff library**); risky changes routed through the existing
**Approvals/Proposals** HITL queue; a per-rule **health chip**; all lifecycle events
to the append-only audit index (#2). Make **"Tune" the primary CTA** over "Disable."

**DECISION 5.7 — Portability: Sigma via `pySigma` on the backend only** (frontend
needs nothing) — instant access to the public SigmaHQ library while staying
vendor-neutral.

**DECISION 5.8 — Validation: `zod` (~13 KB) as the single source of client-side
validation + defaults** mirroring `config.py`. `react-hook-form` is **not** required
(the controlled draft-snapshot + minimal-PATCH save model already works; keep explicit
save, add the missing nav guard).

**Phasing:** **Phase 1 (dep-free)** — NumberField/LabeledSlider, four-section editor,
flat builder, preview panel, version ledger, shadow state. **Phase 2** — zod + MITRE
coverage view. **Phase 3 (gated)** — react-querybuilder, pySigma, optional CodeMirror.

---

## 6. Loose-coupling plan

**The three couplings to break:**
1. **Three parallel FE tables that drift** — `nav.ts` (`NAV_GROUPS`), `App.tsx`
   (~35 `React.lazy` + a ~90-line `renderPage` switch), and the `PageId` union +
   `HIDDEN_ROUTE_IDS`. This causes the observed bug class (page code-split but missing
   from nav; or dropped from nav yet still deep-linkable). Plus `onNavigate` is
   prop-drilled across **31 pages**.
2. **`routes.py` is a 4751-line / 124-endpoint monolith** across ~40 unrelated path
   domains — while 15 feature routers already show the target pattern. A completion
   job, not a rewrite; `main.py` already has a *partial* loader to finish.
3. **`types.ts` is a 2047-line hand-mirror of `models.py`** — pure drift risk, and
   with **0 `response_model=`** anywhere, response codegen is worthless until models
   are added.

**DECISION 6.1 — FE structure: bulletproof-react feature folders** (NOT full 7-layer
FSD — widgets/entities are ceremony here). One public `index.ts` per feature slice;
enforce with **`eslint-plugin-import-x`** `no-restricted-paths` (dev-dep), rolled out
**warn → error per feature**.

**DECISION 6.2 — FE registry: collapse the 3 tables into one typed `FEATURES[]`**
(`registry.ts`) deriving nav + routes + palette, with a single **`enabled(ctx)`
capability predicate** (RBAC / prefs-toggle / demo-mode kept as three distinct axes).
Migrate **behind existing exports** — non-breaking. (This is the same single-source
registry the dashboards §4.3 and settings §3.5 sections both lean on.)

**DECISION 6.3 — FE DI: replace `onNavigate` with `useNavigate()`**; expose the `api`
singleton via `useApi()` context for test injection. **TanStack Query is optional and
must be separately justified** (real runtime dep — not approved here); the `.api.ts`
builder path gets ~80% of the value at 0 bytes.

**DECISION 6.4 — BE: finish the router split.** Clean `operationId`s
(`generate_unique_id_function`) + `Annotated` DI aliases; split `routes.py` **one
feature per PR** (paths byte-identical → webui contract untouched; run `pytest` (1461)
+ `test_route_auth_coverage` after each slice); upgrade the loader to sorted,
raise-on-failure auto-discovery; extract **one generic `EntryPointRegistry[T]`**
(collapses ~120 LOC dup) and add discovery to notifications (`tlsoc.channels`) + LLM
providers (`tlsoc.llm_providers`). Use **stdlib `importlib.metadata`, NOT
pluggy/stevedore.**

**DECISION 6.5 — Contract sync: `openapi-typescript` (dev-dep, 0 runtime bytes).**
Types only — fits the plain fetch wrapper. Add `response_model=` to the ~10–15
highest-churn endpoints to unlock response types. Commit `openapi.json` + the
generated file (offline-safe); enforce with a **CI `git diff --exit-code` gate.** Mind
the Pydantic-v2 `Optional` → `anyOf[...,null]` gotcha.

**Sequencing.** **Wave 1 (no runtime dep):** operationIds, openapi-typescript
request/enum types, `FEATURES[]` registry, `useNavigate`, generic registry. **Wave 2:**
loader + `routes.py` split across PRs. **Wave 3:** ESLint boundaries, `response_model`s,
entry-point discovery, CI drift gate. **Deferred:** State-store / OCSF-mapper SPIs;
TanStack Query only if approved.

**REJECTED:** big-bang rewrites, Module Federation / runtime plugin loaders for
first-party code, full FSD, mega barrel files, two boundary enforcers, pluggy/stevedore,
and fat handlers post-split (protects #3 — `decide()` stays out of HTTP).

---

## 7. Accessibility (WCAG 2.2 AA) + motion

**Baseline is good on plumbing** (focus rings, table semantics, a global reduced-motion
reset already correct). The Round-5 work is a short, high-ROI list — **zero new
production deps.** Note the ground-truth correction: **every chart series already ships
`isAnimationActive={false}`**, so "gate chart animation on reduced motion" is a no-op;
the real chart gap is **non-color encoding.**

**DECISION 7.1 — Non-color signaling (WCAG 1.4.1) is the #1 SOC risk.** Add a
`SEMANTIC_ICON` map beside the existing `SEMANTIC` color map; wire it into `badges.tsx`,
RiskGauge (must show **numeric value + band label**, not just a colored arc), chart
legends, and the MITRE heatmap. One source of truth: **class → color AND icon.** (This
consumes the §1.2 3-axis palette split.)

**DECISION 7.2 — Ship the four NEW WCAG 2.2 AA criteria most consoles miss:**
- **2.5.8 Target Size** — dense icon buttons ≥24×24px hit area (glyph can stay 16px);
  ship a shared `IconButton` recipe.
- **2.4.11 Focus Not Obscured** — sticky header/table headers/Settings save-bar can
  cover a focused control while tabbing; fix with `scroll-margin-top` = sticky height.
- **2.5.7 Dragging** — every drag surface needs a non-drag alternative (up/down buttons
  for column/saved-view reorder). *(This is why `@dnd-kit` is conditional — a drag
  surface implies this obligation.)*
- **3.3.8 Accessible Auth** — allow paste + correct `autocomplete` (`one-time-code`) on
  login/MFA/recovery fields.

**DECISION 7.3 — Charts.** Trim `CATEGORICAL` 8 → ≤6 and CVD-verify (agrees with §1.7);
Viridis/Cividis for the MITRE heatmap; per-series shape/dash (dep-free SVG); `role=img`
+ `aria-label`; extend the existing export pattern to a **"view as table"** alternative;
never bury load-bearing data in hover-only tooltips.

**DECISION 7.4 — Sort + announcements.** Add `<th scope>` + `aria-sort` (omit when
unsorted; SVG arrow, not color) and a **shared `useLiveAnnouncer()`** polite live
region (reused for bulk-action outcomes + DnD), because `aria-sort` is silently ignored
by VoiceOver-macOS and TalkBack.

**DECISION 7.5 — Motion: three surgical changes** (functional, fast, quiet;
120/200/280ms tokens):
- Add `<MotionConfig reducedMotion="user">` at the app root (reaches imperative Framer
  animations the CSS reset can't; keeps opacity crossfades).
- Upgrade the theme.css reduced-motion block from "kill everything" to
  **crossfade-preserving + spinner-exempt** (WCAG 2.3.3 exempts functional loaders).
- Consolidate the two duplicated `matchMedia` sites into one SSR-safe
  `usePrefersReducedMotion()` hook.
- **Don't over-animate live data:** one-shot fade-highlight for streaming case inserts;
  never reorder-animate a list being read; no KPI count-up tickers.

**DECISION 7.6 — Testing gate.** Add **jest-axe/@axe-core + eslint-plugin-jsx-a11y**
(dev-only, 0 prod bundle) to the Vitest/CI gate, plus an in-repo **~20-line contrast
checker** (no dep) to gate 4.5:1/3:1 so a token edit can't silently regress. Automated
scanners catch ~⅓–½ of issues — **keyboard-only + NVDA/VoiceOver spot checks remain
mandatory.**

---

## 8. Cross-cutting through-lines (where the seven docs reinforce each other)

- **The 3-axis palette (§1.2) is the shared root** for chart colors (§1.7/§2.2),
  non-color a11y signaling (§7.1), and every badge across dashboards + rules.
- **recharts stays** — asserted independently by the charts (§2.2), dashboards (§4.2),
  rules-preview (§5.6), and a11y (§7.3) docs. Tremor rejected four times over.
- **One single-source registry** underpins the FE decoupling (§6.2), the settings Cmd-K
  jump targets (§3.5), and the dashboard widget catalog (§4.3).
- **`UserPrefsStore` zero-migration cascade** carries DataTable density (§1.4), custom
  dashboards (§4.4), and personal appearance/settings (§3) — one persistence pattern.
- **Every new interactive surface is HITL/#3-safe:** dashboards advisory-only, rules
  never touch `decide()`/never bill LLM in preview, automation rules never set status.
- **Lazy-loading is the discipline that keeps "no heavy deps" honest** — RGL,
  react-querybuilder, and CodeMirror all stay off the default read path.

---

## 9. Recommended overall sequencing

1. **Foundations (dep-light, unblock everything):** fonts (§1.1), 3-axis palette +
   chart ramps (§1.2/§1.7), type + spacing scales (§1.3/§1.4), chrome tokens (§1.5),
   `SEMANTIC_ICON` (§7.1), the `KpiTile` fix (§2.5), the four WCAG-2.2 criteria (§7.2),
   a11y CI gate (§7.6).
2. **IA + coupling Wave 1:** Settings regroup + Security promotion (§3.2), deep-link
   fixes (§3.5), `FEATURES[]` registry + `useNavigate` (§6.1–6.3), operationIds +
   openapi-typescript (§6.5).
3. **Dashboards MVP:** three-zone layout + TimeRangePicker (§2.1/§2.6), widget registry
   + RGL edit mode + `UserPrefs.dashboards` (§4), 3–5 seed widgets per role.
4. **Rules Phase 1–2:** four-section editor + NumberField/LabeledSlider + flat builder
   + preview + version ledger + shadow state (§5, dep-free), then zod + MITRE view.
5. **Coupling Wave 2–3:** router split one-feature-per-PR (§6.4), ESLint boundaries +
   `response_model`s + entry-point discovery + CI drift gate.
6. **Gated / conditional:** react-querybuilder + pySigma + CodeMirror (§5.4/§5.7),
   `@tanstack/react-table` under DataTable (§2.7), `@dnd-kit` iff a drag surface ships
   (§7.2).

**Every step:** additive + reversible, `case_manager.py` byte-identical (#3), #9
fencing upheld, `pytest -q` green + `npm run build` clean + `vitest run` green +
`npm run lint` (no rules-of-hooks errors), docs + Journal updated.
