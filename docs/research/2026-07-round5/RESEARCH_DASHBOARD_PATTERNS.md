# Round 5 · P2 External Research — Dashboard & Charts Patterns

> **Target:** TLSOC Agentic Triage Suite — a data-dense operational SOC triage console.
> **Stack:** Vite + React + TS + Tailwind **v3.4.19** + shadcn/ui (Radix) SPA; charts via in-house
> `charts.tsx` + `charts-soc.tsx` wrappers over **recharts ^2.15.4** (the only chart dep); design tokens
> in `theme.css` (CSS custom props, light+dark); semantic colors in `palette.ts`.
> **Hard constraint:** prefer **NO new heavy npm deps**; any dep must be justified. This is an operator
> console, not a marketing site — favor density, drill-down, and calm defaults over decoration.

This doc consolidates external best-practice research (Grafana, Datadog, Elastic Security, Microsoft
Sentinel, Splunk ES, shadcn/ui, TanStack, recharts ecosystem) into **decisions we can implement now**.
It is opinionated on purpose. Verified against the live codebase (2026-07-01): recharts is the sole chart
dep, Tailwind is v3, `KpiTile.tsx` has a delta-color bug at line ~85, and there is no `ChartConfig`-style
abstraction yet.

---

## 0. TL;DR decisions (the ones that matter)

| Decision | Verdict | Why |
|---|---|---|
| **Chart library** | **STAY on recharts; upgrade v2.15.4 → v3** | Already our dep; the library shadcn charts are built on; v3 adds `accessibilityLayer` (keyboard + SR). Zero new heavy deps. |
| **shadcn Charts wrapper** | **Borrow the pattern, keep our wrappers** | Our `charts.tsx`/`palette.ts` already do CSS-var theming + SOC-semantic color + a11y + #9 untrusted-label safety. Adopt only the `ChartConfig` idea + `accessibilityLayer`. |
| **Tremor / nivo / visx / uPlot / ECharts** | **Reject as default** | Tremor duplicates our design system (+churn post-Vercel); nivo/ECharts heavy; visx has no a11y. **uPlot is the ONLY sanctioned escape hatch** — lazy-loaded, for a future dense live-tail chart only. |
| **shadcn `sidebar` block** | **Adopt the PRIMITIVE, port our behavior onto it** | Brings the one thing we lack (mobile Sheet drawer) with ~0 net deps. But keep our RBAC filtering, disclosure a11y, server-prefs sync. |
| **shadcn `dashboard-01` block** | **Reference only — DO NOT install** | Drags in @tanstack/react-table + 4× @dnd-kit + @tabler/icons (6 heavy deps) that duplicate our DataTable + lucide. |
| **@tanstack/react-table** | **Adopt as the ENGINE under our DataTable** (deliberate, separate) | ~15 kB, zero runtime deps, MIT; removes hundreds of lines of duplicated per-page filter/sort/slice. Not a UI replacement. |
| **Time-range + refresh control** | **Build in-house `<TimeRangePicker>`** from Radix popover/tabs/select | Standard operator idiom; ~40-line date-math parser instead of `@elastic/datemath` (drags in moment.js). |
| **Dashboard layout** | **Three-zone: compact control bar → KPI strip → widget grid (named groups)** | The converged pattern across every SIEM/observability leader. |
| **KpiTile delta color** | **FIX the sign→color bug** with a `goodDirection` prop | Correctness bug: "open alerts +30%" currently renders **green**. In a SOC, most "up" is bad. |

---

## 1. The converged dashboard skeleton (all vendors agree)

Grafana, Datadog, Elastic Security, Sentinel, and Splunk ES independently converge on the **same
three-zone above-the-fold layout** for an operational console:

```
┌───────────────────────────────────────────────────────────────────────────────┐
│  CONTROL BAR   [Time range ▾ Last 24h]  [⟳ Off ▾]  [Source ▾][Severity ▾][Owner ▾]  · last refresh 14:32 │
├───────────────────────────────────────────────────────────────────────────────┤
│  KPI STRIP  ┌──────┐┌──────┐┌──────┐┌──────┐┌──────┐┌──────┐   (4–6 tiles, sticky, drill-down)  │
│             │ Open ││ Needs││ Auto ││ MTTA ││ Cost ││ Src  │                                    │
│             │ 42 ↑ ││ Human││split ││ 12m  ││ $3.10││ 6/6✓ │                                    │
│             └──────┘└──────┘└──────┘└──────┘└──────┘└──────┘                                    │
├───────────────────────────────────────────────────────────────────────────────┤
│  WIDGET GRID (named, collapsible groups; general→specific, top-left = most critical)            │
│  ┌───────────────────────────────┐ ┌───────────────────────────────┐                          │
│  │ Attention Queue (widest)      │ │ Cases by Severity/Urgency     │  ← the operational center  │
│  └───────────────────────────────┘ └───────────────────────────────┘                          │
│  ┌───────────────┐ ┌───────────────┐ ┌───────────────┐                                         │
│  │ Trend (stack-by)│ Pipeline funnel│ Source health   │  ← trends + breakdowns                  │
│  └───────────────┘ └───────────────┘ └───────────────┘                                         │
│  ── below the fold ──  MITRE coverage heatmap · dwell-time histogram · verdict/disposition mix   │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Design principles to encode (Grafana official + SOC practice):**
- **General → specific, large → small.** Top-left = most critical. ~7–8 actionable data points per view.
- **Drill-down over cramming.** Every KPI tile, bar segment, heatmap cell, table row is a **link** into the
  filtered case list carrying the current time-range + variables as query params. No dead-end numbers.
- **Calm board.** Conditional-render: hide a panel when its filter excludes it OR it has no data — but
  **always** keep a source-health/coverage summary so "hide if no data" never masks a dead feed.
- **Consistent color semantics.** All status/verdict/risk/severity colors resolve from `palette.ts`.
  Threshold coloring: good=green/blue, warn=amber, bad=red. Never hardcode a hex.

---

## 2. Recommended TLSOC dashboard layout (concrete)

### 2.1 Control bar (new, page-level)
A compact top row driving **all** panels from one shared state:
- **Time-range pill** → popover with (a) presets grid, (b) Relative/Absolute/Now tabs. Default **Last 24h**
  with explicit **vs previous 24h** comparison (Splunk/Sentinel convention — simpler and more honest than a
  free range for an at-a-glance home; keep the full range picker on the deeper Metrics page).
- **Auto-refresh dropdown**: `Off / 30s / 1m / 5m / 15m` — **default Off or 1m** (cost-metered backend;
  Grafana explicitly warns against refresh storms). Pause on hidden tab (Page Visibility API).
- **Variables** (dashboard-scope filter dropdowns, Radix `Select`): `source · severity · verdict · status ·
  assignee/owner · tag`. Selecting one re-scopes every panel via a single shared filter state.
  **Serialize range + variables to the URL query string** so views are shareable/bookmarkable.
- **`last refreshed HH:MM` stamp** (Sentinel idiom) — sets the right expectation for a polling-default console.

**Persistence:** store the selection in the per-user KV `UserPrefsStore` (zero-migration) + snapshot
range+variables as named **Saved Views** via the existing `/api/views`. Default a per-role starter view
(`analyst_tier1 → my-queue`, `soc_manager → team-SLA`).

**Backend wiring:** thread `from`/`to` + variables as query params into `/api/metrics`, `/api/standup`, and
the case-list endpoints. The nginx `/api` proxy forwards arbitrary params — **no proxy change**. Represent a
range as `{ from: string; to: string }` using **Elasticsearch date-math strings** (`now-24h`..`now`), stored
**relative** and resolved to ms only at query time (so auto-refresh actually advances). End-of-range dates
must **round UP** (`now/d` end = end of day) or you silently drop the current bucket.

### 2.2 KPI strip (row 1) — 4–6 tiles, sticky, each a drill-down
Reuse `KpiTile`/`StatCard`. Big value + tabular-nums + threshold color + **period-over-period delta** (already
computed in `engine/metrics.py`) + optional background sparkline. Cap at ~6 (Splunk's exact convention;
working memory ~4 chunks). See §5 for the exact widget list.

### 2.3 Widget grid (named collapsible groups)
Adopt Datadog's **"wrap every widget in a named Group"** rule via a `<DashboardGroup>` (Radix
`Collapsible`/`Accordion`, already a dep). Order groups as a **narrative**, not a random grid:
`Triage Status → Attention Queue → Verdict/Quality mix → MITRE coverage → Cost/Budget → Ingest health`.

**Responsive grid (Grafana "auto grid" concept, zero dep):**
```css
/* KPI strip */
grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
/* or fixed breakpoints when card count is known/stable (avoids a lonely wide card): */
grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4
```
Equal-height cards (`h-full` — already set) + `line-clamp-1` on sub-lines so variable text doesn't jag rows.
Readability minimums (Datadog): time-series ≥ ~1/3 width, table/stream widgets ≥ ~1/2 width.

### 2.4 Role-aware landing (we already have RBAC + `<Can>` + saved views)
- `analyst_tier1` → attention queue + live feed + my-queue KPIs.
- `soc_manager`/CISO → MTTx + autonomous-split + cost + SLA/aging posture.
- Persist per-user widget/layout + `stack-by` choice + density in the zero-migration prefs store.

### 2.5 Tabs (only if the page gets crowded — Radix Tabs, no dep)
Segment by audience under the **shared control bar** (so time-range + variables apply across all tabs):
`Operations (queue/SLA/aging) · Quality (verdict/FP/feedback) · Coverage (MITRE, rule health) · Sources`.
Tabs beat N routes because the control bar is shared. Don't over-tab (hides cross-tab correlation).

---

## 3. Above-the-fold prioritized widget list (the deliverable)

The three-zone consensus answers four SOC questions instantly: **(1) What's on fire? (2) What needs a
human? (3) Are we keeping up? (4) Is the pipeline healthy?** For THIS agentic, cost-metered product there
are two differentiators competitors lack: an **autonomous-vs-human split** and a **cost/budget meter**.

**Priority-ordered above-the-fold widgets (cap the fold at ~6–8; demote the rest):**

| # | Widget | Data source | Chart type | Drill-down target |
|---|---|---|---|---|
| **1** | **Open cases by severity/urgency** (critical/high/med/low counts, threshold-colored) | `metrics.py` verdict/status/priority mix | KPI tiles + small HBar | `cases?severity=…` |
| **2** | **Needs-human / attention queue** (NEEDS_HUMAN + ESCALATED + ON_HOLD, sorted by aging vs SLA, row color by dwell) — **the #1 operator surface** | `shift_report.py` attention queue + `status_history` | DataTable (compact, aging-colored) | case detail |
| **3** | **Autonomous split** (auto-closed by `decide()` vs escalated to NEEDS_HUMAN, + FP-auto-close count) — **our differentiator; trust surface for #3** | `case_manager` disposition counts | 2 StatCards + ratio bar / small donut | `cases?status=…` |
| **4** | **MTTA / MTTR / dwell trio** (by severity, with sparklines + p50/p90) | `metrics.py` (already p50/p90) | 3 KpiTiles + Sparkline | Metrics page |
| **5** | **Cost / budget meter** (spend today, cost-per-case, budget burn %) — distinctive | cost ledger + `BudgetGate` | StatCard + progress/radial | Cost page |
| **6** | **Pipeline / data-availability strip** (per-connector green/yellow/red) — prevents triaging a dark feed | `/api/sources/health` | row of status pills | source detail |
| **7** | **New-cases-today + backlog trend** (24h volume + open-backlog delta, `stack-by` control) | `metrics.py` per-day trend | TrendArea/MultiSeriesTrend + `Select` | `cases?from=…&to=…` |
| **8** | **Live event/case feed** (append-only, newest-first) | `realtime.py` SSE EventBus (opt-in) + polling fallback | bounded feed card | case detail |
| — below fold — | MITRE coverage heatmap · dwell-time histogram · verdict/disposition mix donut · per-persona/playbook usage | `mitre_coverage.py`, `baseline` t-digest, feedback stats | `MitreHeatmap`, BarChart-over-bins, DonutChart | filtered lists |

**Quality row (2026 AI-SOC guidance — cheap from the verdict/status mix):** false-positive rate,
escalation rate, alert-to-investigation ratio. These expose over-aggressive auto-close (the #3 trust
surface) and are what managers actually report.

**The "Stack by" pattern (Elastic):** a small `Select` feeding the recharts `groupBy` field on the trend
chart (`verdict | status | severity | source | rule`). One chart answers many questions. No new dep.

---

## 4. KPI/stat card anatomy + the delta-color bug

**Canonical anatomy** (Power BI / Polaris / PatternFly / Tremor all converge): short uppercase **label** →
headline **value** (largest, `tabular-nums`, aggressively abbreviated `1.2k`/`4m 12s`) → **delta vs an
explicit period** (color + directional glyph, never color alone — WCAG 1.4.1) → optional **sparkline** →
one **context sub-line** (period/denominator/target). **3–5 per row, cap 5–6 per view.**

### 4.1 FIX: `KpiTile` colors delta by SIGN, not by MEANING (correctness bug)
`webui/src/soc/components/KpiTile.tsx` (~line 85) does:
```ts
delta.value >= 0 ? 'text-success' : 'text-critical'
```
This is **wrong for a SOC**: "open alerts +30%", "MTTR +2m", "backlog age up" would all render **green**.
Add a `goodDirection?: 'up' | 'down' | 'none'` prop (default `'up'`) and key the **color** off whether the
metric *improved*, while the **arrow** always shows the true direction of change:

```ts
// color = judgement (good/bad), NOT the sign
const improved =
  goodDirection === 'none' ? null :
  goodDirection === 'up'   ? delta.value >= 0 :
  /* 'down' */               delta.value <= 0;
const color = improved === null ? 'text-muted-foreground'
            : improved          ? 'text-success' : 'text-critical';
// arrow = true direction of change (do NOT flip it when inverting)
const Arrow = delta.value >= 0 ? ArrowUpRight : ArrowDownRight;
// a11y: announce direction + judgement so SR users don't rely on color
aria-label={`${delta.value >= 0 ? 'up' : 'down'} ${Math.abs(delta.value)}${unit} vs ${comparison} — ${improved ? 'better' : 'worse'}`}
```
Map colors to `palette.ts` tokens (`critical`/`high`/`success`), not raw green/red. Use neutral/info tone
for direction-agnostic metrics (e.g. "events ingested").

### 4.2 Add a sparkline (recharts, zero new dep)
~120×36px, `<Line>`/`<Area>` with hidden `XAxis`/`YAxis`/`CartesianGrid`/`Tooltip`, `strokeWidth 1.5`,
`currentColor`/accent stroke, `ResponsiveContainer`, `isAnimationActive={false}`. Wrap `aria-hidden` and
expose the trend in the delta/sub text so it stays decorative-but-accessible. **Do NOT add `@tremor/react`**
for this — hand-roll with our primitives.

### 4.3 Other card rules
- Always render the **comparison period** for any delta (`vs prev 24h` / `WoW` / `vs 14d baseline`) — a delta
  is meaningless without it.
- Format all values through one helper (round + abbreviate, fixed decimals per row, `tabular-nums`); exact
  value in a `title`/tooltip.
- **Consolidate `KpiTile` + `StatCard`** into one component with variants (`KpiTile` as the richer base;
  `StatCard`'s left-accent-bar becomes `variant='bar'`) to reduce design-system drift.
- Keyboard/touch: expose key context in **visible text + aria-label**, never tooltip-only.

---

## 5. Chart-type selection guide (question-driven, mapped to our stack)

Chart choice follows the **analytical question**, not the metric name:

| Question | Chart | Our component / action |
|---|---|---|
| Trend over time (MTTx, volume, spend, ingest rate) | **Line** (fluctuating) / **Area** (cumulative/volume) | `MultiSeriesTrend` / `TrendArea`. **Never stack areas for fluctuating values.** |
| Severity as a trend dimension | **Multi-series line** or **small multiples** | `MultiSeriesTrend` series OR grid of `TrendArea`. **No dual-axis** (false-correlation trap). |
| Ranking across categories (top rules/sources/entities, workload) | **Horizontal bar**, sorted desc, top-N + "Other" | `HBarChart`. HBar beats columns for long/UNTRUSTED labels. Consider a **Pareto** (bar + cumulative %) for the tuner. |
| Part-to-whole (verdict/status/disposition/cost-by-model mix) | **Donut** (≤6 slices, center total) or **100%-stacked HBar** (compare mix across groups) | `DonutChart`. **Never a pie for time series or ranking.** |
| Distribution of one variable (dwell/MTTR spread, case age, cost-per-case, risk score) | **Histogram** = `BarChart` over pre-binned data + SLA `ReferenceArea`/`ReferenceLine` bands | **GAP — add it.** Seed bins/markers from existing p50/p90/p99 (`metrics.py` + baseline t-digest). |
| Sequential drop-off (event-detection funnel; alert→triaged→escalated→closed) | **Funnel** (4–6 stages, counts + conversion %) | **GAP — add it.** recharts ships `FunnelChart`; no dep. Funnel ONLY for strictly-sequential subsets. |
| 2-D coverage matrix (MITRE tactic×technique) | **Heatmap** = CSS-grid of tiles, low→high ramp + legend | `MitreHeatmap` (already a DOM grid — a matrix is a grid, not a chart; keep it out of recharts). Keep Navigator v4.5 JSON export. |
| Bounded ratio (coverage %, SLA %, budget %) | **Radial/progress gauge** | `RiskGauge` pattern. Reserve for genuinely bounded 0–100%. |
| Inline KPI/table context | **Sparkline / MiniBars** (no axes) | `Sparkline` / `MiniBars` — extend to the new tuning/campaigns/baseline surfaces. |

**The two real gaps:** (1) **histogram** for latency/dwell distributions (a mean-only KPI hides skew and
outliers), and (2) **funnel** for the Round-4 event-detection pipeline + the triage pipeline. **Neither
needs a new dep** — recharts ships `FunnelChart`, and a histogram is a `BarChart` over server-binned data.

**MITRE (Sentinel dual-layer idea):** overlay **active coverage** (techniques with a live case/rule) vs
**simulated/potential coverage** (techniques your detection-rules *could* cover) so operators see **gaps**,
not just hits. Tactics = columns, techniques = color-scaled tiles (darkness = # detections), legend +
technique search + click-to-details pane with jump links. Count-scaled, not binary covered/not.

**Chart anti-patterns to avoid:** pie >6 slices; funnel for independent categories; stacked area for
non-cumulative values; dual-axis line; mean-only for skewed latency; vertical columns with long labels;
heatmap without a legend/contrast scrim; >4–5 series on one line chart; animating dense charts (keep
`isAnimationActive={false}`, honor `prefers-reduced-motion`).

---

## 6. Chart-library decision (the big one)

### Decision: **STAY on recharts, upgrade v2.15.4 → v3, keep our in-house wrappers as the standard.**

**Why recharts wins for us:**
- Already our **only** chart dep (~150 kB min / ~50 kB gz, MIT, zero runtime deps). Only 2 files import it;
  all pages go through `charts.tsx`/`charts-soc.tsx` wrappers.
- It is the **exact library shadcn/ui's official chart component is built on** — the token-via-CSS-var
  theming pattern is native to our `theme.css` + `palette.ts`.
- v3 adds a first-class **`accessibilityLayer`** prop (tab-into-chart, arrow-key point navigation, SR
  tooltip live-regions) that directly advances our WCAG AA goal.
- The console draws only **modest AGGREGATE charts** over pre-bucketed data — it never approaches the
  SVG-at-scale ceiling (~1k points) that hurts recharts, so the perf argument for Canvas libs is moot.

**shadcn Charts (`ChartContainer`/`ChartConfig`/`ChartTooltip`): borrow two ideas, don't standardize on it.**
Our wrappers already deliver its core value (CSS-token-driven SVG colors + custom themed tooltip) **plus**
SOC-semantic color mapping, `role="img"` + `aria-label`, sr-only `<table>` fallbacks, and #9 untrusted-label
safety — none of which shadcn's generic `--chart-1..5` ordinal slots give you. Borrow exactly:
1. A decoupled **`ChartConfig`-style map** so legend labels, tooltip names, and colors come from ONE source:
   ```ts
   // add to palette.ts (~30 lines, zero deps)
   type ChartSeriesConfig = Record<string, { label: string; color?: string; token?: string }>;
   // resolve color via existing token()/semanticColor()
   ```
2. The **`accessibilityLayer`** prop on interactive charts (verify it exists in your recharts line before
   wiring; guard with build+vitest). Keep the existing `role="img"`/`aria-label` summary as the baseline SR
   affordance (macOS VoiceOver can hijack axis focus).

**Do NOT do:**
- `npx shadcn add chart` **wholesale** — it now scaffolds a **v3-shaped** `chart.tsx` that mismatches a v2
  install AND uses `var(--chart-N)` while our tokens are **bare HSL triples** consumed as `hsl(var(--x))`;
  verbatim copy renders wrong/blank colors. (This is also why the v3 upgrade must be a **deliberate**
  migration, not a side-effect.)
- Add the generic `--chart-1..5` ordinal tokens — they'd let color drift away from **encoding severity/
  verdict**, an information-integrity regression in a SOC.

**Rejected alternatives (with the reason):**
- **Tremor** — recharts + a Tailwind layer we already own; +~200 kB / ~70 kB gz; second design opinion;
  OSS maintenance slowed post Jan-2025 Vercel acquisition. Duplicates our system for zero new capability.
- **nivo** — best-in-class a11y + Canvas variants but up to ~500 kB + separate theming model. Overkill for
  aggregate charts.
- **visx** — ~15 kB modular, TS-first, but **NO built-in a11y** and no defaults (hand-build everything).
  Confine to **one** bespoke viz only (e.g. a campaign force/graph layout) if ever needed.
- **ECharts** — ~1 MB; unjustified.
- **uPlot** — ~50 kB Canvas, 150k+ points at ~10% CPU/60fps. **The ONLY sanctioned escape hatch**, and ONLY
  if we add a genuinely dense chart (live-tail time-series over push-receiver ring buffers, or an
  events/sec EVENT-feed sparkline). Isolate behind **one lazy-loaded component**; theme via
  `getComputedStyle` CSS-var reads; never let it touch the aggregate recharts charts (and don't lose
  recharts' SVG `<text>` label placement, which is part of the #9 defense).

**Migration guardrails:** recharts v3 is NOT a v2 drop-in — Tooltip content type `TooltipProps →
TooltipContentProps`, `ResponsiveContainer` ref changes, `activeIndex` removed, z-index by render order,
axis lines render without ticks. Pin v2 until a dedicated migration; gate with `npm run build` (tsc+vite) +
`npx vitest run` (charts-soc.test.tsx + the 273-spec suite green). Keep `ResponsiveContainer` inside a
sized parent (`min-h-[…]`/`aspect-*`) or it logs `width(-1) height(-1)` and won't render.

**#9 carry-over (non-negotiable):** all chart labels come from log-derived UNTRUSTED data (OCSF
`unmapped`/`raw_data`, rule names, hostnames, IOCs, ATT&CK Navigator layer `comment`/`metadata`). Render as
SVG `<text>`/category strings/escaped DOM text **only** — never `dangerouslySetInnerHTML`, never `{{{raw}}}`.

---

## 7. Shell / sidebar decision

### Decision: **Adopt the shadcn `sidebar` PRIMITIVE, port our behavior onto it. Do NOT install `dashboard-01`.**

The shadcn `sidebar` block is a mature, MIT, copy-in primitive family (~24 exports around
`SidebarProvider`/`useSidebar`, cookie state, Cmd/Ctrl+B, `collapsible="icon"|"offcanvas"|"none"`). It
installs cleanly on **Tailwind v3.4** (shadcn maintains a parallel v3 registry) and brings **~0 net-new
runtime deps** — it needs `@radix-ui/react-slot` (present ^1.3.0), `lucide-react`, `class-variance-authority`,
and our `Sheet`/`Tooltip`/`Button`/`Separator`/`Skeleton` (all already in `src/ui/`). The only missing piece
is a **`useIsMobile` hook** (~15 lines, `matchMedia('(max-width: 767px)')`).

**The one genuine gap it closes:** our current `NavSidebar.tsx` (631 lines) is a sticky `h-screen aside`
with **no mobile off-canvas drawer** — below ~768px it eats horizontal space. The block auto-swaps to a
**Sheet overlay** on mobile.

**But our `NavSidebar` has hard-won behavior the vanilla block lacks** — keep all of it:
- **RBAC filtering** (`filterGroups` by `perm`/`hasPermission()`) — the block has no auth model.
- **Multi-level nav** (block submenus are hand-wired `Collapsible` + `SidebarMenuSub`, not built-in).
- **Disclosure a11y** with keyboard-reachable fly-outs in the collapsed rail (block collapses to
  icon-tooltips, hiding sub-destinations from the tab order).
- **Single-`aria-current`** handling for shared host/child ids; synchronous localStorage pre-hydration
  (anti-flash); **cross-device server-prefs sync** (`UserPrefsStore`, superior to the block's single-boolean
  `sidebar_state` cookie — which also has a known reload bug, shadcn #8176).

**Migration path (behind the green baseline, reversible):**
1. Land `src/ui/sidebar.tsx` (primitive) + the 7 `--sidebar-*` tokens in `theme.css` (light+dark; **none
   exist today** — grep = 0; map to the command-center palette; override `--sidebar-width-icon` to `4rem` to
   match our 64px rail) + a `useIsMobile` hook. Leave `NavSidebar` untouched.
2. Port `NavSidebar` → app-sidebar onto the block: keep `nav.ts` model + `filterGroups` RBAC + `useNavPrefs`
   server persistence + disclosure/fly-out a11y; use `SidebarMenuButton` `isActive`/`tooltip`;
   `SidebarInset` replaces manual content-offset math. **Let the block own the cookie + Cmd/Ctrl+B** (remove
   the duplicate handler in `AppShell` to avoid a double-toggle); keep `UserPrefs` as the cross-device source
   of truth via `onOpenChange → PUT /api/prefs/user`.
3. Rewrite `NavSidebar.test.tsx` against the new structure; keep 273 vitest + tsc green.

**Cheaper alternative if you only want mobile:** since `sheet.tsx` already exists, add `useIsMobile` +
render the SAME group/item tree inside `<Sheet><SheetContent side="left">` INSIDE the existing `NavSidebar`
(~1 day, preserves all a11y/RBAC/persistence). Do the full block adoption only if standardizing the whole
shell on shadcn primitives.

**Reject `dashboard-01` wholesale:** it drags in `@tanstack/react-table` ^8.21 + `@dnd-kit/{core,modifiers,
sortable,utilities}` + `@tabler/icons-react` ^3.35 — 6 heavy deps that violate the constraint and duplicate
our `DataTable` + lucide. **Adopt only its LAYOUT COMPOSITION as a reference** (app-sidebar + `site-header`
with `SidebarTrigger`/breadcrumb/health-pill/theme-toggle/`NotificationBell`/user-chip + `section-cards`
row + our charts + our DataTable).

**Tailwind trap:** the newest shadcn sidebar docs assume Tailwind **v4** (`@theme`, oklch, no
`tailwind.config.ts`). We're on **v3.4.19** — verify the CLI pulls the **v3 registry** (class-based dark
mode, `tailwind.config.js` token extend, `hsl(var())` convention); a v4-flavored `sidebar.tsx` fails on v3.
Sanity-check `npm run build` after copy-in.

---

## 8. DataTable / @tanstack/react-table decision

### Decision: **Adopt `@tanstack/react-table` as the ENGINE under our existing `DataTable.tsx` — a deliberate, separate wave. NOT a UI replacement.**

Our `DataTable.tsx` (519 lines) is solid presentation: controlled sort/pagination/row-selection, column
show/hide/reorder via `ColumnsMenu`, skeletons, empty state, density, `aria-sort`. What it does **NOT** own
is the actual **filter/sort/paginate computation** — every page (Cases, Cost, Audit, Users, …, ~13 sites)
hand-rolls `applyFilters` + `[...arr].sort()` + `.slice()`. That duplicated, drift-prone logic is the real
maintenance cost.

**Why TanStack:** industry-standard headless engine, the library shadcn's data-table is built on, **~15.2 kB
min+gzip, zero runtime deps**, MIT, tree-shakeable opt-in row models
(`getSorted/Filtered/PaginationRowModel`), and native server-side via `manualPagination/manualSorting/
manualFiltering` + `rowCount` — which maps onto our FastAPI/StateStore that already paginates.

**How (keep our UI, swap the engine):**
- Keep `DataTable.tsx`'s shadcn `<Table>` markup, tokens, density, skeleton/empty, `aria-sort`, and its
  **controlled prop API** (so all ~13 call sites are unchanged). Refactor only the body to `useReactTable` +
  `flexRender`.
- Move per-page filter/sort/slice INTO the table instance (import row models a la carte only where used).
- Map state 1:1: `SortState{id,dir}` ↔ `SortingState[{id,desc}]`; `ColumnState{order,hidden,widths}` ↔
  `columnOrder`+`columnVisibility`(+`columnSizing`); `selected:string[]` ↔ `RowSelectionState` keyed by
  `getRowId`. Keep them **controlled** so `PrefsContext` saved-views/column-state persistence keeps working.
- Flip the big table (**Cases**) to server-side (`manual*` + `rowCount`) when result sets grow (reset
  `pageIndex` on filter change — TanStack #4797). Start client-side to preserve current behavior.
- **#9:** map `flexRender` cell context to our `cell(row, i)` renderers so UNTRUSTED values keep rendering as
  plain text / `CodeBlock`, never unfenced.

**Migrate incrementally:** refactor internals + convert Cases first, run vitest (incl.
`customization.render.test.tsx`) + tsc, then roll the rest. Later unlocks (cheap, once on TanStack): column
resizing (finishes the `widths` story), faceted filters (replace hand-built facet Sets), and
`@tanstack/react-virtual` (+~10–20 kB) **only if** a table ever renders thousands of rows (prefer server-side
instead). **Reject** Material React Table (MUI ~80 kB), AG Grid (~298 kB), and the full tablecn/openstatus
template (Next.js/nuqs/Drizzle-coupled). Pin TanStack **v8** (v9 is beta/breaking).

---

## 9. Time-range + refresh control (compact UX)

### Decision: **Build an in-house `<TimeRangePicker>` from existing Radix primitives; ~40-line date-math parser (NOT `@elastic/datemath`).**

Every mature console (Grafana/Kibana/Datadog) uses the same compact toolbar: a **time-range pill** button
(shows the resolved label) opening a popover with (a) **presets grid**, (b) **Relative/Absolute/Now** tabs,
plus an adjacent **auto-refresh** interval control + manual refresh button.

**Build it from:** Radix `popover` (trigger = `button` labeled with the resolved range) + `tabs`
(Relative/Absolute) + `select` (interval). **No new dep.** Add a `useAutoRefresh(intervalMs, onTick)` hook.

**Grammar:** range = `{ from: string; to: string }` using **ES date-math** (`now`, `now-15m`, `now-1h/d`) —
1:1 with the ES/OpenSearch queries this app already runs, and the log-browse endpoints already accept
`from`/`to` (`GET /api/sources/{id}/logs`, `GET /api/logs`). Store the **relative** string; resolve to ms at
query time. **Write a ~40-line pure parser** (`now±<n><s|m|h|d|w|M|y>` + `/<unit>` rounding) instead of
`@elastic/datemath` — it drags in **moment.js** as a peer dependency (violates the no-heavy-dep rule).
Unit-test with vitest.

**SOC-tuned presets:** `Last 5m/15m/30m/1h/3h/6h/12h/24h/7d/30d` + `Today` + `This week` (overridable via
Preferences later). **Auto-refresh:** `Off/5s/10s/30s/1m/5m/15m` + manual refresh; **default Off** for
cost-sensitive views. One shared React `TimeRange` context drives all panels (Datadog "global time").

**Two non-obvious best practices:**
- **Keep relative ranges relative** — store `now-6h`, resolve at query time, or auto-refresh never shows new
  data.
- **Pause auto-refresh on hidden tab** via the **Page Visibility API** (`document.hidden`/`visibilitychange`);
  do one immediate refresh on return. Directly saves backend + LLM cost.

**More:** persist last N (~10) recently-used ranges + last interval in `UserPrefsStore` (`/api/prefs/user`).
**Apply-on-change** for presets, but **explicit Apply** for typed Relative/Absolute edits (avoid a query per
keystroke — EuiSuperDatePicker's `showUpdateButton`). Prefer `setTimeout`-recursion over `setInterval` (no
request stacking under load); coalesce panels behind one shared tick. Timezone: be explicit (SOC analysts
often need UTC); end-of-range rounds UP. a11y: trigger `aria-label` announces the resolved range; honor
`prefers-reduced-motion` on the refresh spinner.

---

## 10. Pitfalls checklist (apply to every widget)

- **Refresh storms:** default Off/≥1m; pause on hidden tab; debounce variable changes; coalesce panels.
- **Repeat fan-out explosion:** repeat rows only over **low-cardinality** dims (source/severity/tactic),
  never case IDs/hostnames; cap the count.
- **Info overload:** ~7–8 actionable points per view; use rows/tabs + drill-down, not a wall of 30 panels.
- **Hidden failures:** "hide if no data" can mask a dead feed — always keep a source-health summary.
- **Dead-end KPIs:** every tile/segment/row deep-links into the filtered list carrying range+variables.
- **Lost shareability:** serialize range+variables to the URL, not just React state.
- **Untrusted labels (#9):** render as plain text / SVG `<text>` only; never HTML.
- **Color semantics:** route ALL status/verdict/risk/severity through `palette.ts`; no hardcoded hex; WCAG AA.
- **Mean-hides-tail:** pair headline latency/dwell with p50/p90 (already computed) or a histogram.
- **Auto-close opacity:** surface the autonomous-vs-human split + FP-auto-close counts (the #3 trust surface).
- **Sticky strip eating vertical space:** make the KPI strip collapse/condense on scroll on laptops.

---

## 11. Prioritized implementation order

1. **Fix `KpiTile` delta-color bug** (`goodDirection`) + add sparkline + comparison-period sub-line.
   *(Small, high-value, unblocks the KPI strip.)*
2. **Build `<TimeRangePicker>` + `<DashboardGroup>`** + shared `TimeRange`/variables context (URL-serialized).
3. **Recompose the landing page** into the three-zone layout with the §3 above-the-fold widget list;
   wire every tile/segment/row to drill-down.
4. **Add the two missing chart types** (histogram = `BarChart`-over-bins with SLA bands; funnel =
   `FunnelChart`) into `charts-soc.tsx`.
5. **Adopt the shadcn `sidebar` primitive** (tokens + `useIsMobile` first, then port `NavSidebar`).
6. **Recharts v2 → v3 upgrade** (dedicated migration) + `accessibilityLayer` + `ChartConfig` map in
   `palette.ts`.
7. **`@tanstack/react-table` engine** under `DataTable` (deliberate, separate wave; Cases first).

Every step: additive, reversible, `pytest -q` unaffected, `npm run build` (tsc+vite) green, vitest green,
0 `react-hooks/rules-of-hooks` errors, `engine/case_manager.py` byte-identical (#3), no new heavy deps.

---

## 12. Best source citations (curated)

**Dashboard layout & controls**
- Grafana — Dynamic dashboards (auto-grid/tabs/conditional-render), GA Apr 2026: https://grafana.com/blog/dynamic-dashboards-grafana-12/ · https://grafana.com/whats-new/2026-04-08-dynamic-dashboards-is-now-generally-available/
- Grafana — Dashboard best practices (general→specific, top-left critical, thresholds): https://grafana.com/docs/grafana/latest/visualizations/dashboards/build-dashboards/best-practices/
- Grafana — Repeat rows/panels by variable: https://grafana.com/blog/2020/06/09/learn-grafana-how-to-automatically-repeat-rows-and-panels-in-dynamic-dashboards/
- Datadog — Effective dashboards guidelines (wrap-in-group, 12-col, density): https://github.com/DataDog/effective-dashboards/blob/main/guidelines.md
- Datadog — Executive dashboards + template variables: https://www.datadoghq.com/blog/datadog-executive-dashboards/ · https://docs.datadoghq.com/dashboards/template_variables/

**SOC landing / above-the-fold / KPIs**
- Elastic Security — Detection & Response dashboard (canonical SOC triage landing): https://www.elastic.co/docs/solutions/security/dashboards/detection-response-dashboard · Overview: https://www.elastic.co/guide/en/security/current/overview-dashboard.html
- Microsoft Sentinel — Get visibility (Overview four-section) + SOC metrics (MTTA/MTTR percentiles): https://learn.microsoft.com/en-us/azure/sentinel/get-visibility · https://learn.microsoft.com/en-us/azure/sentinel/manage-soc-with-incident-metrics
- Sentinel — MITRE ATT&CK coverage (active vs simulated): https://learn.microsoft.com/en-us/azure/sentinel/mitre-coverage
- Splunk ES — Security Posture + Key Indicators: https://help.splunk.com/en/splunk-enterprise-security-8/user-guide/8.5/analytics/security-posture-dashboard · https://help.splunk.com/en/splunk-enterprise-security-7/user-guide/7.2/dashboard-overview/key-indicators-in-splunk-enterprise-security
- Chris Sanders — Three useful SOC dashboards (data availability / open-case aging / watchlist): https://chrissanders.org/2016/10/three-useful-soc-dashboards/
- KPI card anatomy: https://nastengraph.substack.com/p/anatomy-of-the-kpi-card · PatternFly dashboards: https://www.patternfly.org/patterns/dashboard/design-guidelines/

**Charts / libraries / components**
- shadcn Charts (recharts wrapper, ChartConfig/accessibilityLayer): https://ui.shadcn.com/docs/components/radix/chart · Charts gallery: https://ui.shadcn.com/charts
- Recharts v3 migration guide: https://github.com/recharts/recharts/wiki/3.0-migration-guide · a11y: https://github.com/recharts/recharts/wiki/Recharts-and-accessibility
- shadcn/ui blocks (sidebar + dashboard-01): https://ui.shadcn.com/blocks · Sidebar component: https://ui.shadcn.com/docs/components/radix/sidebar
- Tailwind v3/v4 registry split (verify v3): https://ui.shadcn.com/docs/tailwind-v4 · https://github.com/shadcn-ui/ui/issues/6458
- TanStack Table (headless engine, row models, manual/server-side): https://tanstack.com/table/latest/docs/introduction · shadcn data-table: https://ui.shadcn.com/docs/components/radix/data-table
- MITRE ATT&CK Navigator (layer JSON, score→color): https://github.com/mitre-attack/attack-navigator
- uPlot (dense-chart escape hatch): https://github.com/leeoniya/uPlot

**Time controls**
- Grafana time-range + refresh: https://grafana.com/docs/learning-paths/visualization-metrics/time-range-refresh/ · semi-relative ranges: https://grafana.com/blog/2022/02/03/pro-tip-how-to-use-semi-relative-time-ranges-in-grafana/
- EUI EuiSuperDatePicker (SOC-adjacent reference): https://eui.elastic.co/docs/components/forms/date-and-time/super-date-picker/
- Page Visibility API (pause refresh on hidden tab): https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API
