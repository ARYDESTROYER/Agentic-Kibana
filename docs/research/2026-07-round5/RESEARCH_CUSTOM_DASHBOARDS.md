# Research — Custom Dashboards Architecture (Round 5, P2)

> **Scope.** How to give TLSOC analysts a **customizable, per-user, drag/resize
> dashboard** (the Overview/Home surface) without regressing the calm, data-dense,
> WCAG-AA operational console we ship today. This doc consolidates external
> best-practice research (Grafana, Kibana, Datadog, Superset, Metabase, ilert +
> react-grid-layout / gridstack / dnd-kit / Tremor) into a **concrete, opinionated,
> implementable architecture**: grid-lib decision, widget-registry design, per-user
> layout persistence schema, and the builder UX flow.
>
> **Stack facts verified against the repo (2026-07-01):**
> - `webui/package.json`: React `18.3.1`, Tailwind `^3.4.19`, recharts `^2.15.4`,
>   framer-motion `^11.18.2`. **No grid lib, no dnd-kit today.**
> - Chart widgets already exist as token-aware recharts wrappers:
>   `webui/src/soc/components/charts.tsx` + `charts-soc.tsx`.
> - Per-user prefs already persisted zero-migration: `UserPrefs`
>   (`backend/app/models.py:633`) + `UserPrefsStore`
>   (`backend/app/stores/user_prefs.py`) + `resolve_effective_prefs`
>   (org ← user cascade) + `CustomizationConfig` org defaults
>   (`backend/app/config.py:590`) + routes `GET/PUT /api/prefs/{user,org,effective}`,
>   `GET/POST /api/views` (`backend/app/api/routes.py:1553+`).
> - Non-negotiables in play: **#9** (untrusted/source-derived text is plain data,
>   never markup / never unfenced into a prompt), **#3** (layout is advisory
>   presentation, must NEVER feed `decide()`/risk), **#10** (sane, calm defaults),
>   **#11** (spine first, breadth degrades gracefully).

---

## 0. TL;DR — the decisions

| Decision | Verdict | Why (one line) |
|---|---|---|
| **Grid library** | **`react-grid-layout` v2.2.3** (MIT, ~18.5 KB gz), **lazy-loaded in edit mode only** | Purpose-built, React-native, TS-first, serializable layout maps 1:1 to our persistence schema; Grafana/Metabase/Kibana/ilert precedent. |
| **Chart lib for widgets** | **KEEP `recharts`** — do **NOT** adopt Tremor | Tremor Raw needs **Tailwind v4** (we're on v3.4.19); `@tremor/react` brings a **competing token system** and re-opens the #9 label surface. |
| **Widget registry** | **In-house `Map`-based registry** in `webui/src/soc/dashboard/registry.ts` | Enum widget `type` → code-defined metadata (component, default size, config schema, RBAC). Separates "what a widget is" from "where it sits." |
| **Layout persistence** | **Additive `dashboards: dict[str, DashboardLayout]` field on `UserPrefs`** (zero-migration KV) | Same pattern as `saved_views`/`tables`; rides the existing org←user cascade; reset == delete the user's bucket key. |
| **Coordinate model** | **Absolute grid units** (Grafana/Metabase style: `{i,x,y,w,h}` over a 12-col grid) — NOT Superset's hierarchical tree | Flat is diff-friendly and byte-identical to react-grid-layout's `Layout` item. |
| **Builder UX** | **Explicit Edit mode** (read-only default) → **Add-from-gallery** → **config Sheet** → **drag/resize** → **explicit Save** (Apply/Discard/Reset) | The universal 5-step loop every mature builder converges on; safe-to-experiment. |
| **Defaults** | **Per-role, code-defined, immutable presets** → **clone-to-customize** on first edit | A single all-purpose SOC dashboard fails; analyst/manager/auditor/admin need different landing widgets. |
| **New deps** | **ONE** justified add (`react-grid-layout` + its `react-resizable`/`react-draggable` peers). **Zero** other. | Rolling our own resize/compaction/breakpoints on dnd-kit rebuilds the expensive 80% for no bundle win. |

---

## 1. Grid library decision

### 1.1 The candidates, weighed for OUR stack

| Lib | Size (gz) | License | React fit | Built-in resize/compaction/breakpoints | Verdict |
|---|---|---|---|---|---|
| **react-grid-layout (RGL) v2.2.3** | ~18.5 KB (+ `react-draggable`, `react-resizable`, `fast-equals`) | MIT | **Native** — layout is a serializable prop, changes via `onLayoutChange` | **Yes, all of it** | **ADOPT** |
| gridstack.js 12.6.0 | ~22 KB, **zero deps** | MIT | Wrapper (`gridstack/dist/react`) is imperative DOM + portals; `useGridStack` must live inside `<GridStack>`; `refreshDragHandles` gotchas | Yes (+ nested grids) | Only if we need **nested/multi-level** grids (we don't) |
| dnd-kit (`@dnd-kit/core` ~10 KB + sortable + modifiers) | ~15 KB combined | MIT | Native, accessible, tree-shakeable | **No grid, no resize** — you own collision/compaction/resize | Reserve for **sortable lists/kanban**, not the dashboard |
| snapgrid | n/a | ? | "RGL with dnd-kit's DNA" | Yes (claimed) | **Reject** — not resolvable on npm during research, too immature for a security console |
| Custom CSS-grid + framer-motion | 0 (already a dep) | — | Native | **No** (you build it) | **Fallback only** — reorder + preset-span, no free resize |

### 1.2 Why react-grid-layout, concretely

1. **It's the boring, maintained, battle-tested answer** for exactly this use case.
   Grafana's dashboard grid is an RGL fork (`grafana/react-grid-layout`,
   `DashboardGrid.tsx`); Metabase, Kibana's dashboard app, HubSpot, and ilert all use
   it. That is the strongest possible signal for a **data-dense operational console**,
   not a marketing site.
2. **v2 revived it** — RGL is no longer the stagnant library people remember. v2.2.3
   shipped **2026-03-24**: a full **TypeScript rewrite**, **React 18/19** support (no
   `flushSync` warnings), a `ResizeObserver`-based `useContainerWidth` hook, composable
   config, and serializable layouts. We are on React 18.3.1 — clean fit.
3. **Its item shape IS our persistence schema.** `onLayoutChange` emits
   `Record<breakpoint, Layout[]>` where each item is `{i,x,y,w,h,minW,maxW,minH,maxH,
   static,isDraggable,isResizable}`. We persist that verbatim — no translation layer.
4. **The hard part is the layout math, and RGL owns it.** Cell snapping, resize
   handles, collision detection, downward/leftward **compaction**, and responsive
   **breakpoints** are the bulk of the effort. dnd-kit does the *drag gesture*
   beautifully but explicitly ships **none** of that (see dnd-kit discussions #1560 /
   #1605, where maintainers steer this use case away from bare dnd-kit; the community
   spun up "snapgrid" precisely to fill the gap).

### 1.3 Integration rules (these prevent the known pitfalls)

- **Width detection:** use the v2 **`useContainerWidth` hook with
  `measureBeforeMount: true`**, NOT the legacy `WidthProvider` HOC (RGL docs warn
  `WidthProvider` creates a component during render → remount/flicker + SSR width=0).
- **Breakpoints** mapped to our Tailwind screens so the grid reflows consistently
  with the rest of the SPA's 8px grid:
  `{ lg: 1200 (12 col), md: 996 (10 col), sm: 768 (6 col), xs: 480 (4 col), xxs: 0 (2 col) }`.
- **Drag handle scoped to the card header:** `draggableHandle=".card-drag-handle"`.
  Without it, dragging over a chart tooltip / link / button hijacks the interaction.
  Put the handle in the existing `Card` header.
- **Resize on the SE corner only** (`resizeHandles={['se']}`) to keep the console calm
  and avoid mis-grabs in dense widgets.
- **Grid item wrapper must forward the ref + spread injected props**
  (`style`, `className`, `onMouseDown`, `onMouseUp`, `onTouchEnd`) onto the real DOM
  node. Wrap our shadcn `Card` in a thin `React.forwardRef` `<GridItem>` — otherwise
  drag/resize silently breaks.
- **CSS:** import `react-grid-layout/css/styles.css` + `react-resizable/css/styles.css`
  **once**, then **override** `.react-grid-item`, `.react-resizable-handle`, and
  `.react-grid-placeholder` colors/z-index via our `theme.css` CSS custom properties
  (accent + border tokens) so drag/resize affordances match the command-center
  light/dark theme and hold WCAG AA. Watch z-index vs. Radix Dialog/Sheet.
- **Code-splitting:** `React.lazy` + `Suspense` the whole editable-grid route. RGL +
  peers add ~18 KB gz (plus `react-resizable`/`react-draggable`) — the login / wizard /
  case-detail hot paths must not pay for it. This also aligns with the existing
  `bundle-first-paint.test.ts` guardrail.
- **Perf:** `React.memo` each widget with stable props so dragging one widget does not
  re-render the recharts in the others (a documented dashboard jank source). Do **not**
  animate during drag (RGL owns that); reserve framer-motion for add/remove enter/exit
  with reduced-motion awareness.

### 1.4 What we explicitly do NOT do

- **Do not roll a custom resizable grid on dnd-kit + CSS grid.** It duplicates RGL's
  collision/compaction/resize/breakpoint logic (the expensive 80%) for no bundle win
  once resize is in scope.
- **Do not adopt gridstack** unless a real nested-grid requirement appears; its React
  wrapper is imperative and less idiomatic in a hooks/JSX SPA.
- **Do not depend on third-party gridstack React shims**
  (`@declarative-gridstack/react`, `Aysnine/gridstack-react`, `pitrho/react-gridstack`)
  — they trail core and are maintenance risks.
- **Do not bet on snapgrid** — early/niche, not npm-resolvable at research time.

---

## 2. Chart library — KEEP recharts, reject Tremor

**Decision: keep `recharts` (already `^2.15.4`); do not add Tremor in any variant.**

- **Tremor Raw** (tremor.so, the copy-paste variant Vercel steered to after acquiring
  Tremor in Jan 2026) **hard-requires Tailwind v4.0+**. We are on **v3.4.19** → hard
  blocker without a Tailwind v4 migration (out of scope this round).
- **`@tremor/react`** (classic npm) works on Tailwind v3.4+ **but** introduces its own
  `tremor-brand-*` color tokens in `tailwind.config.js` that must be enumerated at
  build time and **do not read shadcn's `--background/--primary/--foreground` CSS
  variables**. That is a **parallel/competing token system** that fights our
  `theme.css` + `palette.ts` light/dark tokens and the runtime branding-accent
  override. It also ships recharts underneath (~200 KB min / ~70 KB gz vs recharts
  ~150/50) — we'd ship recharts twice-abstracted for a look we already own.
- **#9 regression risk:** our `charts.tsx`/`charts-soc.tsx` render UNTRUSTED labels as
  plain SVG `<text>` (never HTML) and resolve every color through `palette.ts`. Tremor
  renders labels/tooltips inside black-box components — a real markup-injection surface
  we'd have to re-audit.

**If we want richer/standardized chart widgets:** port shadcn/ui's own
`<ChartContainer>`/`<ChartTooltip>` pattern (a thin recharts wrapper driven by CSS
variables `--chart-1..--chart-5`). Add those five vars to `theme.css` (light+dark),
map them from `palette.ts`. That gives Tremor-like ergonomics with **zero new heavy
dep** and full token composition. Widgets remain thin recharts wrappers in
`soc/components/charts*.tsx`. (A separate recharts v2→v3 bump is orthogonal to this
decision — plan it independently with a `charts-soc.test.tsx` smoke test.)

---

## 3. Widget registry design

**Principle (Grafana panel-type vs. gridPos):** SEPARATE the widget **registry**
(what a widget *is* — code-defined, versioned) from the per-user **layout**
(where it sits — data). A stale user layout must never break when a widget is removed.

### 3.1 Shape — an in-house `Map`-based registry

`webui/src/soc/dashboard/registry.ts`:

```ts
// A widget TYPE is a compile-time enum string. Layouts reference it by id.
export type WidgetType =
  | 'kpi.open_cases' | 'kpi.mtta' | 'kpi.mttr' | 'kpi.budget'
  | 'chart.cases_per_day' | 'chart.verdict_mix' | 'chart.cost_per_day'
  | 'barlist.top_mitre' | 'barlist.top_sources' | 'barlist.top_verdicts'
  | 'mitre.heatmap' | 'table.recent_cases' | 'table.campaigns'
  | 'queue.attention';           // ...small, curated, SOC-relevant set

export interface WidgetDef<O = Record<string, unknown>> {
  type: WidgetType;
  title: string;                 // default title (user can override, plain text)
  description: string;           // one line for the gallery card
  icon: LucideIcon;             // gallery + toolbar
  category: 'kpi' | 'chart' | 'list' | 'table' | 'triage';
  Component: React.LazyExoticComponent<React.ComponentType<WidgetProps<O>>>;
  defaultSize: { w: number; h: number; minW: number; minH: number };
  defaultOptions: O;             // discriminated by type; validated on save
  // Optional gating: only show/allow for these roles (uses existing <Can>).
  requires?: Permission;
  configFields?: ConfigField[];  // declarative form -> options (renders in the Sheet)
  previewThumbnail?: string;     // static gallery preview (Datadog/Grafana pattern)
}

export const WIDGET_REGISTRY: ReadonlyMap<WidgetType, WidgetDef> = new Map([...]);
```

- **Widget bodies reuse what we already own:** `KpiTile`/`StatCard` (KPIs), `charts.tsx`
  AreaChart/BarChart (timeseries/mix), `BarList` (top-lists), `DataTable` (tables),
  `MitreHeatmap` (coverage), the deterministic attention queue from `shift_report.py`.
  **No new charting dep.**
- **`Component` is `React.lazy`** so a dashboard only pulls the code for widgets it
  actually renders.
- **Config is declarative** (`configFields` → the Sheet form → `options`), a
  discriminated union `WidgetSpec = { id, type, title, options }` kept in sync with a
  server-side allowlist (mirrors the `models.py ↔ types.ts` discipline).

### 3.2 Reconcile-on-load (the anti-corruption step)

On dashboard load, **intersect** persisted widget instances with the current registry:
1. **Drop** any instance whose `type` is no longer registered (renamed/removed widget)
   — and drop its layout item so RGL doesn't render a hole.
2. **Append** any new registry widgets marked as "default-on for role" at the bottom
   (RGL auto-packs via negative gravity).
3. **Filter by RBAC:** drop instances whose `requires` permission the current user
   lacks (defense-in-depth; the server also validates on PUT).

This is Grafana's schema-migration philosophy applied at read time — zero-migration,
forward-compatible.

---

## 4. Per-user layout persistence schema

### 4.1 Reference-model choice

The three references converge on the idea but differ in shape:

- **Grafana** — array of panels, each with absolute `gridPos {x,y,w,h}` over a 24-col
  grid (`h` in 30px units), plus integer `version` + `schemaVersion` for migrations.
- **Metabase** — per-card `{row,col,size_x,size_y}` over an 18-col grid (same
  absolute-coordinate model, simpler).
- **Superset** — flat map of a **hierarchical** LayoutItem tree over 12 cols, tagged
  `DASHBOARD_VERSION_KEY:"v2"`. Powerful (nested rows/cols/tabs) but **overkill** for a
  fixed SOC widget set — every nesting level multiplies migration + validation surface.

**We adopt the Grafana/Metabase absolute-coordinate model** because it maps 1:1 onto
react-grid-layout's item shape. A 12-col grid (matching RGL's `lg` default and our
Tailwind grid) is the sweet spot.

### 4.2 The schema — one additive field on `UserPrefs`

**Zero-migration**, same read-modify-write KV-doc pattern as `saved_views`/`tables`.
Add to `UserPrefs` (`backend/app/models.py:633`):

```python
class GridItem(BaseModel):
    """react-grid-layout Layout item, byte-identical to onLayoutChange output.
    Grid UNITS, never pixels."""
    i: str                       # == WidgetInstance.id
    x: int; y: int; w: int; h: int
    minW: int | None = None
    minH: int | None = None
    static: bool = False

class WidgetInstance(BaseModel):
    id: str                      # uuid; == GridItem.i
    type: str                    # a WidgetType from the registry (server-allowlisted)
    title: str | None = None     # optional override — PLAIN TEXT (#9), never markup
    options: dict[str, Any] = Field(default_factory=dict)  # validated per-type

class DashboardLayout(BaseModel):
    schema_version: int = 1                       # Grafana's schemaVersion pattern
    cols: int = 12
    row_height: int = 56                          # ~8px-grid-friendly
    widgets: list[WidgetInstance] = Field(default_factory=list)
    layouts: dict[str, list[GridItem]] = Field(default_factory=dict)  # per breakpoint
    updated_at: str = Field(default_factory=iso_now)

class UserPrefs(BaseModel):
    ...
    dashboards: dict[str, DashboardLayout] = Field(default_factory=dict)  # keyed by dashboard id, e.g. 'overview'
```

**Rules baked into the schema:**

- **Persist grid UNITS, not pixels** (x/y/w/h in columns/rows) so layouts survive
  screen-width changes. This is why Grafana/Metabase/RGL are all grid-unit based.
- **Persist positions + type + options only. NEVER data.** The widget data is fetched
  live from `/api/metrics` etc. Mixing data into the layout doc bloats the KV doc and
  creates staleness (Grafana keeps queries but never the *data*).
- **`schema_version` from day one** (starts at `1`) — a tiny pure `migrate()` upgrades
  old docs on read. Without it we lock into the first grid model forever.
- **`layouts` is a `Record<breakpoint, GridItem[]>`.** Decision: **persist all
  breakpoints** for stable cross-window layouts (analysts move between monitors). If we
  want minimal, persist only `lg` and let RGL derive the rest — but be consistent.
- **`title` and any log-derived series labels are UNTRUSTED (#9)** — plain text / SVG
  `<text>` only, never HTML, both in the widget and in the config UI.

### 4.3 Org/role defaults + the cascade

- Add an org-default `dashboards` (per role) to `CustomizationConfig`
  (`backend/app/config.py:590`), admin-edited.
- Extend `resolve_effective_prefs` so the **effective dashboard = per-user override,
  else role default, else the shipped code-defined built-in** (insert **role-tier
  resolution between org and user**). This reuses the existing ORG←USER cascade — no
  new store.
- **Reset semantics** (label them precisely; do NOT overload the platform factory
  reset in `engine/reset.py`):
  - **Discard changes** = drop the in-flight edit session → last saved (client-side
    revert, no API call).
  - **Reset to default layout** = `DELETE` the user's `dashboards[id]` bucket so the
    cascade falls back to the role/org/code default (shadcn `AlertDialog` confirm).

### 4.4 Endpoints + write discipline

- Reuse the prefs router. Either extend `PUT /api/prefs/user` or add a dedicated
  `GET/PUT /api/dashboards/{id}/layout` that read-modify-writes `dashboards[id]` via
  `UserPrefsStore`. No new ES index / SQL table.
- **Server-side validation on PUT:** reject any `WidgetInstance.type` not in the
  registry allowlist and any unknown option keys — a tampered prefs doc must not inject
  a rogue widget (defense-in-depth for #9).
- **Debounce persistence:** RGL's `onLayoutChange` fires per drag tick. **Debounce
  ~500ms** and PUT on **settle only** (drag-stop / resize-stop / config-apply) — one KV
  write per settle, not per pixel. The whole `DashboardLayout` is small; PUT it whole.

---

## 5. Builder UX flow

Every mature builder (Grafana, Kibana, Datadog, Metabase, HubSpot) converges on the
same **five-step loop**. We implement exactly this.

### 5.1 The loop

1. **Read-only by default.** The Overview renders clean, distraction-free, with a
   single primary **"Edit dashboard"** button in the `PageHeader` (shadcn `Button` +
   lucide `Pencil`), **gated by `<Can>`** on a new `dashboard:edit` permission.
   Personal-layout customization can be allowed for all roles; editing the **org/role
   default** is admin-only.
2. **Edit mode is explicit + visually distinct.** Entering edit mode reveals RGL drag
   handles + resize corners and swaps the header for a **sticky action bar**
   (`Save` · `Discard` · `Reset to default`) — reuse the existing Settings sticky-save
   pattern (`SettingsGrid` / `settings-dirty.ts`). Show an **"Unsaved changes"** badge;
   guard navigate-away (router guard) + browser unload.
3. **Add widget from a curated gallery** (NOT a blank canvas). An "Add widget" button
   opens a Radix `Dialog`/`Sheet` gallery: each entry is a card with icon + one-line
   description + static preview thumbnail (Datadog/Grafana pattern), filtered by
   category and RBAC. **Structured flexibility, not a blank canvas** — the single most
   important MVP rule.
4. **Configure per-widget in a side Sheet.** Selecting/adding a widget opens a Radix
   `Sheet` whose fields (`configFields`) map 1:1 to `options` (metric/query select,
   time range, viz sub-type, color-by, title). Fully keyboard-operable (Radix focus
   trap).
5. **Drag/resize on the RGL grid**, then **explicit Save** (persist) vs **Apply**
   (close editor, keep pending) — mirror Grafana's Apply-vs-Save split.

### 5.2 Per-widget affordances (cheap, high-value)

On hover in edit mode, a small toolbar (existing `dropdown-menu` + lucide): **drag
handle**, **edit/gear**, **duplicate** (1-line state op), **remove**. `EmptyState` in
empty slots; a brand-new dashboard shows `EmptyState` offering **"Start from a preset"**
vs **"Add your first widget."**

### 5.3 Default vs. custom — clone-to-customize, per role

- Ship **curated, immutable per-role default dashboards** (code-defined presets),
  keyed to the 6 existing roles. A user **cannot edit a default in place**; the first
  edit **forks it into their own bucket** (Kibana managed-dashboard / Datadog clone
  model). Suggested defaults:
  - `analyst_tier1/2` → triage/attention-queue + risk gauge (what to investigate
    first).
  - `soc_manager` → SLA/aging + MTTA/MTTR + workload (already computed in
    `engine/metrics.py` + `shift_report.py`).
  - `auditor` → posture/coverage + audit volume.
  - `super_admin` → cost/budget + source health.
- A **single all-purpose SOC dashboard fails** — the research is explicit that
  analysts, managers, and auditors need different landing widgets.

### 5.4 Accessibility (we hold a WCAG-AA bar)

RGL's keyboard a11y is weaker than dnd-kit's. Compensate: make the drag handle a real
focusable `button` with `aria-label`; keep all config keyboard-operable via the Sheet;
provide a **non-drag fallback** to move/resize (a "Move to" / size-preset select in the
widget menu) so keyboard users aren't blocked. (dnd-kit is the a11y-first alternative
but you'd rebuild resize + snapping — not worth it for the dashboard.)

### 5.5 MVP scope vs. v2

- **MVP (validate "do analysts build & keep custom boards"):** 3–5 widget types
  (timeseries, KPI, top-list/bar, table + attention-queue), edit-mode toggle,
  add-from-gallery, config Sheet, RGL drag/resize, explicit Save, 1–2 built-in role
  presets, Reset-to-default.
- **Defer to v2:** sharing/ACLs beyond "Save as org default", cross-widget filtering,
  JSON import/export, per-widget alerting, multi-tab dashboards, nested grids.

### 5.6 Pitfalls to design against (from the research)

- Blank-canvas paralysis → seed curated gallery + preset.
- Persist-per-pixel → debounce, persist on settle only.
- Drag stealing widget clicks → scoped `draggableHandle`, edit-mode-only drag.
- All-widgets re-render on drag → `React.memo` + child-keyed data.
- Missing RGL CSS / width → `useContainerWidth` + themed CSS imports.
- Overloading "reset" → distinct labels vs. the platform factory reset.
- Untrusted titles/labels → plain text / SVG `<text>` only (#9).
- Bundle regression on hot paths → lazy-load the edit grid.

---

## 6. Implementation checklist (ordered)

1. **Backend, zero-migration:** add `GridItem`/`WidgetInstance`/`DashboardLayout` +
   `UserPrefs.dashboards` (`models.py`); add per-role `dashboards` to
   `CustomizationConfig` (`config.py`); extend `resolve_effective_prefs` with role-tier
   resolution; add `migrate()` on read; endpoint `GET/PUT /api/dashboards/{id}/layout`
   with server-side widget-type allowlist validation. Keep `case_manager.decide()`
   byte-identical (#3 — layout never feeds it). Add offline tests.
2. **webui deps:** `npm i react-grid-layout` (pulls `react-draggable`,
   `react-resizable`, `fast-equals`) + `@types/react-grid-layout`. Pin `2.2.3`. Verify
   `tsc --noEmit && vite build` + tree-shaking; add to the lazy route so
   `bundle-first-paint.test.ts` stays green.
3. **Registry:** `webui/src/soc/dashboard/registry.ts` (Map of `WidgetDef`, lazy
   `Component`s) reusing `KpiTile`/`StatCard`/`BarList`/`charts.tsx`/`DataTable`/
   `MitreHeatmap`/attention-queue.
4. **Grid shell:** lazy `DashboardGrid` route using `ResponsiveGridLayout` +
   `useContainerWidth(measureBeforeMount:true)`, Tailwind-mapped breakpoints,
   `draggableHandle=".card-drag-handle"`, `resizeHandles={['se']}`, `GridItem`
   forwardRef wrapper, themed RGL CSS overrides in `theme.css`.
5. **Builder UX:** edit-mode toggle + sticky action bar + unsaved-changes guard;
   add-widget gallery (Sheet/Dialog); config Sheet; per-widget hover toolbar
   (edit/duplicate/remove); debounced persistence; Reset-to-default (`AlertDialog`).
6. **Defaults:** code-defined per-role presets + reconcile-on-load (drop unknown types,
   append new defaults, RBAC-filter).
7. **Tests:** vitest for reconcile/migrate/debounce/RBAC-gating + a Discard-restores-
   exact-snapshot test (Kibana bug #183785 lesson). Keep `npm run lint` clean.

---

## 7. Best sources (curated)

**Grid libraries**
- react-grid-layout — https://github.com/react-grid-layout/react-grid-layout ·
  https://www.npmjs.com/package/react-grid-layout (v2.2.3, MIT, 2026-03-24) ·
  v2 RFC: https://github.com/react-grid-layout/react-grid-layout/blob/master/rfcs/0001-v2-typescript-rewrite.md ·
  bundle: https://bundlephobia.com/package/react-grid-layout
- Grafana's RGL fork (proof at scale) — https://github.com/grafana/react-grid-layout ·
  https://fossies.org/linux/grafana/public/app/features/dashboard/dashgrid/DashboardGrid.tsx
- gridstack.js — https://gridstackjs.com/ · https://gridstackjs.com/demo/react.html ·
  https://www.npmjs.com/package/gridstack (12.6.0, MIT, zero deps)
- dnd-kit (why it's the wrong altitude here) — https://dndkit.com/ ·
  https://github.com/clauderic/dnd-kit/discussions/1560 · .../discussions/1605
- Comparison — https://puckeditor.com/blog/top-5-drag-and-drop-libraries-for-react ·
  https://www.ilert.com/blog/building-interactive-dashboards-why-react-grid-layout-was-our-best-choice

**Persistence models**
- Grafana JSON model / schema —
  https://grafana.com/docs/grafana/latest/dashboards/build-dashboards/view-dashboard-json-model/ ·
  https://grafana.com/docs/grafana/latest/observability-as-code/schema-v2/layout-schema/ ·
  https://deepwiki.com/grafana/grafana/12.2-dashboard-serialization-and-schema
- Superset position_json — https://deepwiki.com/apache/superset/3.3-dashboard-system
- Metabase dashcards — https://www.metabase.com/docs/latest/dashboards/introduction

**Builder / edit-view UX**
- Datadog widgets & dashboards — https://docs.datadoghq.com/dashboards/widgets/ ·
  https://docs.datadoghq.com/getting_started/dashboards/ ·
  https://docs.datadoghq.com/dashboards/configure/
- Grafana panel editor / edit-mode & Scenes —
  https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/panel-editor-overview/ ·
  https://grafana.com/blog/2024/10/31/grafana-dashboards-are-now-powered-by-scenes-big-changes-same-ui/ ·
  https://grafana.com/events/grafanacon/2022/dashboard-ux-best-practices/
- Kibana view/edit + managed dashboards + reset —
  https://www.elastic.co/docs/explore-analyze/dashboards/open-dashboard ·
  https://github.com/elastic/kibana/issues/183785
- SOC dashboard design (per-role) — https://www.fanruan.com/en/blog/soc-dashboard ·
  https://armorpoint.com/2025/05/07/soc-dashboards-key-features-functions-and-kpis/

**Charts (Tremor decision)**
- shadcn charts pattern (the real alternative) — https://ui.shadcn.com/charts ·
  https://ui.shadcn.com/docs/theming
- Tremor Tailwind-v4 requirement — https://www.tremor.so/docs/getting-started/installation ·
  https://npm.tremor.so/docs/getting-started/theming
- recharts v2→v3 migration — https://github.com/recharts/recharts/wiki/3.0-migration-guide
