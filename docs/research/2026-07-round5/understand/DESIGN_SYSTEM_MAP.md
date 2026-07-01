# DESIGN SYSTEM MAP — Round 5 P1 (Understanding)

> **Domain:** Design system + color/type audit (webui, the primary surface).
> **Scope:** READ-ONLY mapping of the current token system, the shadcn/Radix/Tailwind
> primitives, and every design inconsistency + contrast issue found — plus a single
> consolidated direction for the overhaul.
> **Out of scope / do not touch:** `backend/app/engine/case_manager.py` `decide()` must
> stay **byte-identical** (non-negotiable #3). This document proposes NO backend logic
> changes.
> **Overhaul goals referenced:** G1 cohesive light+dark color scheme · G2 ONE consistent
> design standard on the *existing* shadcn/Radix/Tailwind stack (do not invent a new
> system) · G3 declutter Settings / reduce nesting · G4 dashboard uses more real-estate ·
> G5 compact posture hero · G6 real rules customizability · G7 custom dashboards · G8
> loosely coupled/reusable components · G9 highest quality, fully tested.

---

## 0. TL;DR

The color system is **well-architected but not enforced end-to-end and not actually
WCAG-AA compliant despite in-code comments claiming it is.** There are **two parallel
semantic-color code paths** (charts vs badges/gauges) that have already drifted; **four
different focus-ring recipes** and **two overlay-surface tokens** across primitives; a
**dead `--destructive` token** shadowed by `--critical`; **hardcoded, non-themeable
elevation shadows**; a **dead `--density-unit` token** (no working spacing scale); and a
**client-only branding security allow-list** with no server-side mirror. The remediation
is *consolidation, not reinvention*: unify the token names, fix the measured contrast
values, collapse the duplicated recipes into shared primitives/utilities, and wire the
dead tokens (shadow/density/chart) into the system.

---

## 1. The token system — source of truth

### 1.1 Where tokens live and how they wire

All design tokens are **bare HSL triples** (e.g. `217 88% 50%`) declared as CSS custom
properties and consumed via `hsl(var(--x))`. There is a **four-file coupling chain** that
must stay in lockstep by hand:

1. **`webui/src/styles/theme.css`** — the SINGLE source of truth. Declares every token in
   `:root` (light, `theme.css:16-89`) and `.dark` (dark, `theme.css:91-146`), plus the
   base layer, display-heading layer, scrollbars/shimmer/command-grid utilities, and
   reduced-motion/transparency guards.
2. **`webui/tailwind.config.js`** — maps tokens to Tailwind utilities (`bg-*`, `text-*`,
   `border-*`, `rounded-r-*`, `shadow-*`), keyframes/animations, and gradients.
3. **`webui/src/soc/theme-tokens.ts`** — the runtime branding layer: `ALLOWED_TOKENS`
   allow-list (`theme-tokens.ts:69-99`), `sanitizeTokenValue` (`:118-136`), and the
   appliers that write inline CSS vars on `<html>`.
4. **`webui/src/soc/components/palette.ts`** — resolves token NAMES (as strings) into
   concrete `hsl()` strings for **recharts/SVG** (which cannot consume Tailwind classes).

> **Coupling hazard (G8):** adding/renaming ONE token requires editing 3–4 files. The
> coupling to `palette.ts` and `ALLOWED_TOKENS` is **stringly-typed, not type-checked**
> — a rename silently yields transparent SVG fills or dropped branding, and `tsc` won't
> catch it. A test asserts `ALLOWED_TOKENS` entries are `--`-prefixed
> (`theme-tokens.test.tsx:86-87`) but does NOT assert they exist in `theme.css`, so
> name-drift is uncaught.

### 1.2 Global side-effects (repaint the whole app)

- `* { border-color: hsl(var(--border)) }` — `theme.css:149`. Every element inherits the
  border color; any `--border` refactor repaints the whole app.
- `body { background: hsl(var(--canvas)); color: hsl(var(--foreground)) }` +
  font-feature-settings/smoothing — `theme.css:156-162`.

### 1.3 Color tokens — LIGHT (`:root`, theme.css:16-89)

| Token | Value | Role |
|---|---|---|
| `--canvas` | `220 …` | app background (body) |
| `--surface` / `--surface-tint` | `220 20% 99%` | near-white surface (≈ background) |
| `--background` | `0 0% 100%` | pure white |
| `--foreground` | `222 …` | primary text |
| `--card` / `--card-foreground` | — | card surface + text |
| `--popover` / `--popover-foreground` | — | floating-surface + text |
| `--primary` / `--primary-foreground` | primary ≈ `217 88% 50%` (5.06:1) | CTA fill + label |
| `--secondary`, `--muted`, `--accent` (+ `-foreground`) | `220 …` neutrals | neutral surfaces |
| `--destructive` `0 72% 50%` / `--destructive-foreground` | — | **DEFINED BUT DEAD** (see §3.1) |
| `--critical` | `0 72% 49%` (5.06:1 ✓) | severity/critical + de-facto destructive |
| `--high` | `24 86% 45%` (**3.83:1 ✗**) | severity high |
| `--medium` | `36 88% 40%` (**3.54:1 ✗**) | severity medium |
| `--low` | `150 58% 35%` (**4.17:1 ✗**) | severity low |
| `--info` | `199 85% 40%` (**4.08:1 ✗**) | info |
| `--success` | `158 70% 33%` (**4.07:1 ✗**) | success/benign/resolved |
| `--warning` | `36 88% 42%` (**3.24:1 ✗**) | warning/needs-human |
| `--border` | `220 18% 90%` (**1.27:1 on white ✗**) | hairline borders |
| `--input` | `220 16% …` | input outline (distinct from `--border`) |
| `--ring` | — | focus ring |
| `--radius` (+ `--radius-sm/md/lg/xl`) | — | corner radius scale |
| `--density-unit` | `0.25rem` | **DEAD — never consumed** (see §4.4) |
| `--canvas-tint`, `--surface-tint`, `--glass-tint` | `220 20% 97/99%` | tints (near-dupes) |
| `--font-display` | — | opt-in display heading font |
| `--glass-tint`, `--glass-opacity` `0.82`, `--glow-strength`, `--grid-opacity` | — | material chrome |

### 1.4 Color tokens — DARK (`.dark`, theme.css:91-146)

Mirrors the same token NAMES with dark values. Notable divergences from light:

| Token | Dark value | Note |
|---|---|---|
| `--canvas` | `222 24% 8%` | near-black |
| `--card` | `222 20% 12%` | card surface |
| `--popover` | `222 22% 11%` | **1% L + 2% sat lighter/different than `--card`** → visible surface drift (see §3.2) |
| `--foreground` | `213 28% 93%` | text |
| `--primary` | `217 84% 62%` | brighter |
| `--primary-foreground` (white) on `--primary` | **3.35:1 ✗** | primary button label fails AA (see §3.3) |
| `--critical` | `0 78% 62%`; white-on-fill **3.60:1 ✗** | destructive/critical label fails AA |
| `--destructive` | `0 74% 58%` | still dead; differs from `--critical` |
| severity hues | 56–62% L (brighter) | amber cluster still borderline for tinted-text badges |
| `--border` | `218 16% 21%`; **1.34:1 on card ✗** | hairlines invisible to low-vision |
| `--glass-opacity` | `0.78` | load-bearing for "quiet" material logic |

### 1.5 Radius / shadow / spacing / typography

- **Radius:** `--radius` + a scale `--radius-sm/md/lg/xl` (`theme.css:66-88`), mapped to
  `r-sm..r-xl` utilities in tailwind. Scale is **mode-agnostic but declared twice** (in
  `:root` AND `.dark`, `theme.css:66-88` / `133-145`) — hand-sync drift risk.
- **Shadow / elevation:** `shadow-elev1`/`elev2`/`glow` are defined ONLY in
  `tailwind.config.js` and **hardcode `hsl(222 30% 12% / …)`** — a fixed dark-navy. There
  is **NO `--shadow-*` CSS token**. In dark mode a dark-navy shadow on a near-black canvas
  is invisible, and elevation cannot be re-themed by branding. Card always applies
  `shadow-elev1` (`card.tsx:9`); a few sites override to `elev2`.
- **Spacing:** **NO working spacing scale.** `--density-unit` (`theme.css:71`) exists but
  is never consumed, not in `ALLOWED_TOKENS`, not wired to Tailwind spacing. Vertical
  rhythm / 8px grid is enforced only by ad-hoc `p-*`/`gap-*` utilities in components — no
  single source of truth (undercuts G2/G4).
- **Typography:** `--font-display` drives opt-in heading treatments
  (`.text-display`/`.text-display-xl`/`.text-display-lg`/`.hero-display h1`,
  `theme.css:177-212`). Font choice is bounded to a 4-family enum
  (`FONT_ALLOWLIST`, `theme-tokens.ts:102-107`). Base body sets font-feature-settings +
  smoothing (`theme.css:156-162`). There is **no type scale token set** — sizes are
  ad-hoc Tailwind `text-*` at call sites.

### 1.6 Chart / data-viz palette (`palette.ts`)

- `token(name, alpha?)` → `hsl(var(--name)[ / alpha])` (`palette.ts:17-21`) — the single
  token resolver for SVG.
- `palette` named object (`palette.ts:24-39`), `CATEGORICAL` 8-color sequence +
  `categorical(i)` (`palette.ts:47-61`), `SEMANTIC` label→color map (`palette.ts:67-100`),
  `semanticColor(label, fallbackIndex)` (`palette.ts:103-107`).
- **No dedicated `--chart-1..n` token scale exists** — categorical reuses semantic hues.

---

## 2. The primitives layer (`webui/src/ui/*`)

All primitives are shadcn/Radix wrappers whose only shared dependency is `@/lib/cn`
(clsx + tailwind-merge, `cn.ts`) — cleanly decoupled and portable (good for G8), except
`Skeleton` (couples to global `.shimmer` CSS) and `sonner` (couples to sonner's internal
classes). Adoption is generally excellent (zero raw `<input>`/`<table>`/Radix bypasses),
with two exceptions: **`ScrollArea` (1 consumer)** and **`Accordion` (2 consumers)** are
effectively dead, and **`Settings.tsx` hand-rolls its nav with raw `<button>`** instead of
using these primitives (see §3.9).

| Primitive | File | Notes |
|---|---|---|
| Button | `ui/button.tsx` | CVA; variants default/secondary/outline/ghost/destructive/link; sizes sm/default(h-9)/lg/icon; `asChild` via Slot |
| Badge | `ui/badge.tsx` | CVA; +8 SOC variants; renders `<div>`, no `asChild`, `focus:` (not `focus-visible:`) |
| Card | `ui/card.tsx` | compound; fixed `px-5` padding, always `shadow-elev1`; Title/Description render `<div>` (no heading semantics) |
| Separator | `ui/separator.tsx` | textbook Radix; no variants; under-reused (~10 importers) |
| Input / Textarea | `ui/input.tsx` `ui/textarea.tsx` | native + cn; 35 importers; no invalid state |
| Label | `ui/label.tsx` | pointless single-variant cva; no auto-association |
| Checkbox / Switch / RadioGroup / Slider | `ui/*.tsx` | Radix; four different focus recipes; Slider has no value readout |
| Select | `ui/select.tsx` | 27 importers; **outlier surface/radius/animation** (see §3.2/§3.4); likely viewport-clip bug (§3.10) |
| DropdownMenu / Command / Popover / HoverCard | `ui/*.tsx` | overlay layer; `bg-popover` + `rounded-lg` + animate-in/out |
| Dialog / AlertDialog / Sheet / Tooltip | `ui/*.tsx` | overlay/tooltip; triplicated overlay+content shells |
| Progress | `ui/progress.tsx` | hardcoded `bg-primary`, no variant → callers hack `[&>div]:bg-*` |
| Skeleton (+Card/Row) | `ui/skeleton.tsx` | driven by global `.shimmer` (`theme.css:237-249`) |
| Avatar | `ui/avatar.tsx` | fixed `h-9 w-9`, fallback locked `text-xs` |
| Alert | `ui/alert.tsx` | cva default/destructive/warning; **no success/info**; `destructive`→`--critical` |
| Toaster (sonner) | `ui/sonner.tsx` | pre-themed; `!important` group-selector overrides |

**The REAL app-wide color authority is split**, not centralized in `palette.ts`:
`badges.tsx` switch fns + `ui/badge.tsx` cva variants + `tailwind.config` token map +
`RiskGauge.tsx` literal classes all encode semantic colors independently. Any "one design
standard" (G2) refactor must reconcile all of these.

---

## 3. Design inconsistencies (consolidated, de-duplicated)

### 3.1 Dead `--destructive` token shadowed by `--critical` (HIGH — G1/G2)

`--destructive`/`--destructive-foreground` are defined for both themes
(`theme.css:42-43`, `115-116`) and mapped in tailwind, but **nothing uses them**:
- `button.tsx:19` destructive variant → `bg-critical`
- `badge.tsx:15` destructive variant → `bg-critical`
- `alert.tsx:13-14` destructive variant → `bg-critical/10 text-critical`
- `AlertDialogAction variant='destructive'` → passes through `buttonVariants` → `bg-critical`

The values also **differ**: light `--critical 0 72% 49%` vs `--destructive 0 72% 50%`;
dark `--critical 0 78% 62%` vs `--destructive 0 74% 58%`. Net: two names for one concept,
one dead. This also couples the **destructive ACTION** concept to the **critical SEVERITY**
palette — retuning `--critical` for severity legibility moves every destructive confirm
button. **Decision needed:** standardize on ONE error token.

### 3.2 Overlay/floating-surface token split (HIGH — G1/G2)

Two different surface tokens for floating layers, visibly different in DARK:
- `SelectContent` → `bg-card` (`select.tsx:71`)
- `DropdownMenu`/`Popover`/`HoverCard`/`Command` → `bg-popover` (`dropdown-menu.tsx:42`,
  `popover.tsx:20`, `hover-card.tsx:19`, `command.tsx:13`)
- `Tooltip` → `bg-popover` + `shadow-elev1` (`tooltip.tsx:18`) vs Dialog/Alert/Sheet →
  `bg-card` + `shadow-elev2` (`dialog.tsx:36-41`, `alert-dialog.tsx:52-57`, `sheet.tsx`)

Dark tokens differ: `--card 222 20% 12%` vs `--popover 222 22% 11%`. A Select dropdown
renders a hair lighter than a DropdownMenu opened next to it; tooltips sit on a different
surface + elevation than dialogs. **`--popover` exists for exactly this** — all floating
surfaces should use it.

### 3.3 WCAG AA failures (HIGH — G1/G9) — comments claim AA that isn't real

`theme.css:49` claims "AA on white" and `theme.css:82-84/175/203` repeatedly assert AA is
preserved. **Measured, most fail the 4.5:1 normal-text bar** (they pass the 3.0:1
large-text/UI-component bar):

- **Light, severity hues as text on white:** high 3.83, medium 3.54, low 4.17, info 4.08,
  success 4.07, warning 3.24 — ALL below 4.5. Used as chip/badge foregrounds in
  `badges.tsx`, so real chips fail. Only `--critical` (5.06) and `--primary` (5.06) clear.
- **Dark, white-on-fill:** `--primary-foreground` on `--primary` = **3.35** (every primary
  CTA); `--destructive-foreground`/critical white-on-fill = **3.60**.
- **Borders as delimiters:** light `--border` on white = **1.27**; dark `--border` on card
  = **1.34** — far below the 3.0 non-text UI bar, so the entire "lean on hairline borders"
  intent (`theme.css:18-19,45`) is not AA-perceivable.

**The overhaul must EITHER fix the values OR correct the comments** (future agents trust
the stale "WCAG-AA" claims at `theme.css:49,82,175,203`).

### 3.4 Radius + animation inconsistency on overlays (G2)

- **Radius:** `SelectContent`/`SelectTrigger` use `rounded-md` (`select.tsx:71,17`) vs
  DropdownMenu/Popover/HoverCard/Command outer surfaces use `rounded-lg`.
- **Animation (two systems):** `SelectContent` fades via the custom keyframe
  `animate-fade-in` ONLY (opacity, 0.24s, no exit, no zoom/slide — `select.tsx:72`;
  keyframe `tailwind.config.js:80/107`). Every other overlay uses tailwindcss-animate
  `animate-in fade-in-0 zoom-in-95` + `animate-out ... zoom-out-95` + directional
  `slide-in-from-*`. Select is the odd one out on both axes.

### 3.5 Focus-ring fragmentation (G2/a11y) — four+ recipes

- input/textarea/checkbox: `focus-visible:border-ring focus-visible:ring-2
  focus-visible:ring-ring/40 focus-visible:ring-offset-0` (`input.tsx:15` etc.)
- switch/slider: `focus-visible:ring-ring focus-visible:ring-offset-2
  focus-visible:ring-offset-background` (`switch.tsx:13`, `slider.tsx:26`)
- radio-group: `focus-visible:ring-ring focus-visible:ring-offset-0` (no border-ring)
  (`radio-group.tsx:26`)
- SelectTrigger: `focus:` (NOT `focus-visible:`) + `ring-ring/40` + `data-[state=open]`
  ring mirroring (`select.tsx:19-20`)
- Badge: `focus:` (not `focus-visible:`, `badge.tsx:7`) while Button uses `focus-visible:`
- Overlay triggers (Popover/DropdownMenu/HoverCard) are raw Radix passthroughs with no
  wrapper ring at all — focus affordance depends on the slotted child.

Same intent, five spellings. Extract ONE shared focus-ring utility.

### 3.6 Border / hover / disabled token drift in form controls (G2)

- Resting border: input/textarea/checkbox/select use `border-input`; RadioGroupItem uses
  `border-border` (`radio-group.tsx:25`) — distinct tokens, so an unchecked radio has a
  different border weight than an adjacent checkbox.
- Hover: input/textarea/checkbox add `hover:border-border`; switch/radio/slider have no
  hover state — half light up, half stay inert.
- Disabled: most use `disabled:opacity-50`; Slider Root uses `data-[disabled]:opacity-50`
  AND a dead `disabled:opacity-50` on the Thumb (`slider.tsx:13,27`, never fires).
- Off-grid: Checkbox uses magic `rounded-[4px]` (`checkbox.tsx:13`) vs the `rounded-md/sm`
  scale.

### 3.7 Dual semantic-color source of truth → confirmed drift (HIGH — G1/G2/G8)

Chart colors from `palette.ts SEMANTIC` vs badges/pills/gauges from an INDEPENDENT switch
in `badges.tsx` (`statusVariant:93-123`, `verdictVariant:200-214`,
`dispositionVariant:159-175`) resolving through `ui/badge.tsx:11-22`. Nothing keeps them in
sync. **Confirmed drift:**
- `escalated`: `palette.ts:84` → `high` (orange) vs `badges.tsx:107-108` → `critical` (red).
- `duplicate`/`undetermined`: `palette.ts:98-99` → `muted` FILL vs `badges.tsx:170-171` →
  `secondary` (bg-muted text-muted-foreground) — different surfaces.
- Four hand-rolled 0–100 band ladders with different cutoffs:
  `badges.tsx severityBandFromNumber:22-30`, `riskVariant:276-282`,
  `RiskGauge bandOf:19-23` (collapses info→low), `postureFromScore:313-317`.

### 3.8 Semantic hue collisions / misuse (G1)

- `--medium (36 88% 40%)` ≈ `--warning (36 88% 42%)` — same hue ~2% L apart
  (`theme.css:52,56`); a medium-severity slice is indistinguishable from a warning/on-hold
  slice. `palette.ts` exposes both with different meanings.
- Three close greens for different meanings: `--success` (FP/benign/closed/resolved),
  `--low` (low severity), benign — hurts at-a-glance disambiguation.
- **`--accent` misused as a data color:** `theme.css:36-41` explicitly documents `--accent`
  as a NEUTRAL hover/selected surface ("must stay a quiet neutral"), but
  `palette.ts accent:26` + `Metrics.tsx:379` use it as the "Agent" donut fill (near-invisible
  gray slice) and `tailwind.config accent-bar` uses it in a brand gradient. Overloaded
  meaning = cohesion trap.
- **CATEGORICAL mixes brand + severity hues** (`palette.ts:47-56`): a non-semantic series
  (per-model bars, `Cost.tsx:161,448`) can render "critical red"/"high orange" by list
  position, falsely implying danger. `semanticColor()` fallback is index-based
  (`palette.ts:104-106`) — an unknown/benign label can silently render red.

### 3.9 Structural primitives under-adopted; Settings ignores them (G3/G8)

- `ScrollArea` has **1** consumer (`NotificationBell.tsx:271`) while ~19 raw
  `overflow-y-auto` containers exist under `src/soc` — dead primitive, no consistent scroll
  chrome. Its thumb color (`scroll-area.tsx:34 bg-muted-foreground/30`) also duplicates the
  global scrollbar rule (`theme.css:219-232`, `/0.35`) — two sources of truth.
- `Accordion` has **2** consumers; consumers fight its baked-in chevron/hover
  (`ChatPanel.tsx:416-417 hover:no-underline`).
- **`Settings.tsx` (2673 lines) hand-rolls its left-rail nav** with raw `<button>` +
  `useState('section')` (`Settings.tsx:2211,2596`) instead of Tabs/Accordion — the G3
  declutter lever exists as a primitive but was never adopted there.
- Tab spacing drifts: `TabsContent` default `mt-4` (`tabs.tsx:47`) vs `TabbedPage mt-6`
  (`TabbedPage.tsx:82`) vs page `space-y-4/6`; `CaseDetail.tsx:1656` re-specifies the
  primitive's own `h-9`.
- `Table.tsx:8` hardcodes an inner `overflow-auto` wrapper (non-overridable, no className
  passthrough); consumers wrap AGAIN in `overflow-hidden rounded-lg border`
  (`DataTable.tsx:278`, `UnifiedLogsSheet.tsx:328`) → two nested scroll/clip contexts,
  scrollbar inside the border, corner-clip risk. No sticky-header support anywhere.

### 3.10 Select viewport likely-clip bug (G9 — functional)

`SelectContent` sets `h-[var(--radix-select-trigger-height)]` on the Viewport in popper
mode (`select.tsx:85`) — pins the dropdown list HEIGHT to the trigger height (~36px),
clipping the option list to ~one row. A known copy-paste error in older shadcn templates
(the intended var is WIDTH). Verify live; very likely a real defect on a 27-importer
primitive.

### 3.11 Duplicated shells / recipes (G2/G8)

- **Overlay string triplicated verbatim:** `fixed inset-0 z-50 bg-black/45
  backdrop-blur-[2px]` in `dialog.tsx:17-21`, `alert-dialog.tsx:31-35`, `sheet.tsx:18-22`.
- **Content shell duplicated:** `rounded-lg border border-border bg-card p-6 shadow-elev2`
  + zoom/fade in `dialog.tsx:36-41` and `alert-dialog.tsx:52-57`.
- **Close-X duplicated verbatim** between `dialog.tsx:47-57` and `sheet.tsx:100-110`.
- **`DropdownMenuShortcut` == `CommandShortcut`** byte-for-byte (`dropdown-menu.tsx:170`,
  `command.tsx:112`).
- **No shared menu-item primitive:** SelectItem/DropdownMenuItem/CheckboxItem/RadioItem/
  CommandItem re-declare near-identical class strings → the muted-vs-accent focus and
  py-1.5-vs-py-2 density divergences exist precisely because it's 5 copies.
- **`/10 bg + /20 border + colored text` severity recipe** (`badge.tsx:16-22`)
  re-implemented ad-hoc in ~33 places that bypass Badge (`KpiTile.tsx:42-47`,
  `CaseActivityFeed.tsx:52-53`, `RoleMatrixEditor.tsx:124-130`, `NotificationPrefs.tsx:295`,
  …).
- **Three branding-apply implementations:** `theme.tsx applyBranding`+`applyMaterialClass`,
  `theme-tokens.applyBranding`+`applyMaterial`, and `BrandingEditor`'s five hand-rolled
  `*Preview` fns (`BrandingEditor.tsx:191-264`) — high drift risk.

### 3.12 Redundant TooltipProviders (G2/perf)

`App.tsx:264` wraps the whole app in `<TooltipProvider delayDuration={200}>`, yet
`ChatPanel.tsx:970`, `CaseDetail.tsx:1263`, `Memory.tsx:116/453`, `Knowledge.tsx:216/1192`,
`EnrichmentProvidersEditor.tsx:254`, `HelpTip.tsx:58` each mount their own — all redundant,
and several omit `delayDuration` (default 700ms vs root 200ms → inconsistent open timing).

### 3.13 Component-level rigidity forcing hand-rolls (G6/G7/G8)

- **Progress:** hardcoded `bg-primary` (`progress.tsx:15`), no variant → callers hack the
  private-DOM selector `[&>div]:bg-success` (`BaselineGauge.tsx:100,368`) which breaks if
  Radix markup changes. No accessible value/label default.
- **Alert:** only default/destructive/warning — **no success/info** despite tokens +
  sonner theming all four. Uses `opacity-90` (`alert.tsx:55`) to dim body instead of a
  muted token; icon layout is brittle `[&>svg]` selector soup (`alert.tsx:6-8`) that
  consumers override ad-hoc (`DemoBanner.tsx:102`, `NotificationPrefs.tsx:216`).
- **Avatar:** fixed `h-9 w-9`, fallback locked `text-xs` (`avatar.tsx:11,32`) — every other
  size is a className override; large avatars get tiny initials.
- **Card:** fixed `px-5` padding; **37 of 69** Card consumers re-pass `p-*/px-*/py-*`
  overrides → the default is wrong for the app. No density prop, no elevation variant (3+
  sites hand-override to `shadow-elev2`). Title/Description are `<div>` not `<h*>/<p>` (a11y
  outline gap).
- **Form controls:** NO built-in error/invalid state on any primitive — callers hand-roll
  inconsistently (`Investigate.tsx:555 border-critical focus-visible:ring-critical`,
  `SourceEditor.tsx:550 border-critical` only, `BrandingEditor.tsx:340 aria-invalid` with no
  visual). Slider has no numeric readout / min-max labels for the threshold sliders G6 needs.

### 3.14 Runtime-theming / branding architecture gaps (G1/G6/G7/security)

- **Client-only security allow-list:** `ALLOWED_TOKENS` + `sanitizeTokenValue`
  (`theme-tokens.ts:69-136`) are the ONLY guard. Backend `_check_theme_tokens`
  (`config.py:720-736`) accepts ANY key/value ≤200 chars — no name allow-list, no
  `url()`/brace/`expression()` rejection. Enforcement is a single client choke point
  (`applyTokens`); any other consumer iterating `theme_tokens` bypasses it. #9/#10 risk.
- **Stored-vs-frontend default mismatch:** backend `default_theme='dark'`
  (`config.py:671`) vs frontend org default `'system'` (`theme-tokens.ts:335-342`,
  `BrandingEditor.tsx:129`) — a returned default doc can push 'system' users into dark
  unexpectedly (contradicts the calm-default G1 intent).
- **Dead `ThemePreset` feature:** modeled end-to-end (`theme-tokens.ts:30-38`,
  `BrandingLike.presets`, `branding.api.ts:38`, `config.py:676-678`) but **zero consumers** —
  the data model promises curated presets the UI never delivers (blocks G6/G7).
- **Allow-listed-but-unwired tokens:** `--canvas-tint`, `--surface-tint`, `--density-unit`,
  `--glass-tint`, `--radius-sm/md/lg/xl` are in `ALLOWED_TOKENS` but the editor
  (`BrandingEditor.tsx TOKEN_SPECS:153-163`) only exposes 7 severity colors + `--radius` +
  `--font-display` → false customizability; density/tint cannot actually be tuned.
- **Single-value tokens override BOTH themes:** `theme_tokens`/`applyTokens` write ONE
  inline value on `<html>`, but `theme.css` gives each token separate light/dark values. An
  operator customizing `--critical` to a light-tuned hue gets the same hue in dark (likely
  failing AA in the other mode) — architecturally at odds with the dual-theme system.
- **No AA guardrail on custom hues:** `sanitizeTokenValue` is syntax-only; the AA advisory
  in `BrandingEditor` covers ONLY the accent, not the 7 editable severity hues.
- **`--accent2` unset in `:root`** (`theme.css:78-79`) relying on `var(--accent2,
  var(--primary))` → the shipped login-hero aurora is monochrome (primary→primary) until
  branding sets accent2 — no real secondary color out of the box (undercuts G1).

### 3.15 FOUC + prefers-color-scheme + dead code (G1/G9)

- **FOUC:** no inline pre-hydration theme script in `index.html` (only
  `<meta name=color-scheme>` at `index.html:6`). `.dark` is applied in a useEffect
  (`theme.tsx:178-180`) AFTER first paint; theme resolves three times (localStorage →
  branding fetch `theme.tsx:208-209` → prefs fetch `prefs.tsx:123`), so users can flash
  light→dark. `theme.tsx:170` also resolves WITHOUT branding initially.
- **No CSS `@media (prefers-color-scheme: dark)` fallback** — `.dark` is JS-only, so if JS
  fails the app is stuck light regardless of OS.
- **Split theme ownership / name confusion:** `ThemeProvider.setTheme` (low-level applier +
  localStorage) vs `PrefsProvider.setThemeMode` (persistor + PUT). Every control must call
  `setThemeMode`; a dev calling `setTheme` silently drops the server persist. A failed PUT
  (swallowed, `prefs.tsx:154-156`) silently reverts the choice on reload.
- **Dead code:** `ThemeContextValue.toggle` (`theme.tsx:153,228-235`) has zero consumers
  (AppShell defines its own). `palette.ts SEMANTIC` has redundant space-keyed entries
  (`'true positive'`) that are dead because `semanticColor()` normalizes to underscore
  first (`palette.ts:105`).

### 3.16 AlertDialog semantics gap (G9)

`alert-dialog.tsx` is vendored over `react-dialog` (deliberate, zero-new-deps). It sets
`role='alertdialog'` (`:51`) but does NOT suppress dismiss-on-overlay-click /
dismiss-on-Escape the way real `@radix-ui/react-alert-dialog` does — a destructive-confirm
gate can be dismissed by backdrop click/Escape. Neither Alert/AlertDialog nor Dialog
enforces a Title/Description for AT accessible names. No z-index scale (everything `z-50`) —
a tooltip inside a dialog can render behind it.

---

## 4. Customization gaps (for G6 rules + G7 dashboards)

1. **No error/validation affordance in form primitives** — G6 rules editors (detection/
   correlation/risk/auto-close/tuning) lean on validated numeric fields; today each
   hand-builds an invalid border + message (`Investigate.tsx:555-561`).
2. **Slider has no numeric readout / min-max / step markers / value tooltip** — poor fit
   for threshold + risk-weight + tuning sliders G6 needs.
3. **No shadow/elevation token** — not user-configurable, not theme-correct in dark; custom
   dashboards (G7) can't get themeable elevation.
4. **`--density-unit` is dead** — no working compact/comfortable knob despite the 8px-grid
   intent (blocks G4/G5 space efficiency and a density preference).
5. **No chart-palette tokens** — a user-built dashboard chart (G7) cannot get a distinct
   categorical palette independent of semantic severity colors.
6. **Semantic colors are not operator/user-configurable** — hardcoded across theme.css +
   palette.ts + badges.tsx; no per-tenant semantic overlay, no colorblind-safe/high-contrast
   ramp toggle (the amber medium/high/warning cluster is exactly what deuteranopes struggle
   with). Branding can only touch accent/severity/radius via the allow-list, NOT the base
   neutrals or contrast.
7. **Dead ThemePreset** — a whole curated-preset customization axis modeled but never
   surfaced (G6/G7).
8. **No per-user appearance beyond mode** — per-user prefs carry only `theme_mode`; no
   personal accent/radius/font/material (asymmetric vs the rich per-user saved-views/
   terminology/columns).
9. **No sticky headers / column-resize UI / density toggle on Table** — a rules or
   dashboard builder wants dense, resizable, sticky tables (widths exist as
   `ColumnState.widths` in `DataTable.tsx:43` but no drag-resize UI).
10. **No vertical-tabs / nested-tabs variant** — a side-nav rules/dashboard builder must
    hand-roll it (as Settings already did), perpetuating non-reuse.

---

## 5. Proposed consolidated direction (single shadcn-based standard)

> Principle: **consolidate the existing stack, don't invent a new one (G2).** All changes
> stay additive-with-defaults where possible; every color change must be re-measured for AA
> and eyeballed in BOTH themes; `case_manager.py` untouched.

### 5.1 Fix the color values (G1/G9) — resolve the AA debt

- **Darken the light-theme severity/info/success/warning hues** until each clears 4.5:1 as
  text on white (they currently sit 3.24–4.17). Keep the amber pair distinguishable by
  pushing `--warning` off `--medium`'s hue (currently both hue 36).
- **Dark mode:** either darken `--primary`/`--critical` fills or switch their `-foreground`
  from white to a near-black so button/badge labels clear 4.5:1 (currently 3.35/3.60).
- **Borders:** raise `--border`/`--input` contrast to ≥3.0:1 vs their adjacent surface in
  both themes so hairline delimiters are actually perceivable — the "lean on borders"
  design intent depends on it.
- **Correct or delete the stale "WCAG-AA" comments** (`theme.css:49,82,175,203`) to match
  reality (or the new compliant values).
- Add an optional **`.high-contrast` variant / colorblind-safe ramp** (a third token
  profile alongside light/dark), addressing the deuteranopia risk and prefers-contrast.

### 5.2 Unify the semantic-color source of truth (G1/G2/G8)

- Create ONE `label → token-name` map (severity/verdict/status/disposition) and derive
  BOTH the Tailwind Badge variant AND the recharts `hsl()` (via `token()`) from it. Delete
  the parallel `badges.tsx` switches and `palette.ts SEMANTIC`'s independent copy. This
  fixes the `escalated`/`duplicate` drift by construction. **Preserve currently-shipped
  colors per label** (tests + muscle memory depend on them).
- Collapse the four 0–100 band ladders into one thresholds module consumed by
  `RiskGauge`/`riskVariant`/`severityBandFromNumber`/`postureFromScore`.
- Standardize on ONE error token (§3.1): fold `destructive` onto `--critical` OR revive
  `--destructive` everywhere — pick one and delete the other. (Note: values differ, so the
  swap is NOT a no-op — visual pass required on DangerZone/AlertDialog/ErrorBoundary.)

### 5.3 New / wired tokens

- **`--shadow-color` (+ `--elev-1`/`--elev-2` composed from it)** in `theme.css`, per-theme;
  point `tailwind.config` `boxShadow.elev1/elev2` at the token instead of the hardcoded
  `hsl(222 30% 12%)`. Makes elevation theme-correct in dark and brandable (G8).
- **`--chart-1..--chart-6`** categorical scale (AA-distinct in both themes); repoint
  `palette.ts CATEGORICAL` at it; free semantic tokens from double duty; fix the gray
  `--accent`-as-series bug (`Metrics.tsx:379` must move to `--chart-*` or `--primary`).
- **Wire `--density-unit`** into Tailwind spacing (or delete it). If kept, drive Card
  padding + form control density from it so there's one spacing source of truth (G4/G5).
- **Give `--accent2` a real `:root` default** so the shipped hero has a genuine secondary
  color out of the box.

### 5.4 Collapse duplicated tokens + fix drift (G8)

- Declare mode-agnostic tokens (`--radius-*`, `--density-unit`, `--font-display`) ONCE in
  `:root`; let `.dark` inherit — removes the twice-declared hand-sync drift.
- Collapse `--surface`/`--surface-tint`/`--glass-tint` where identical, OR give them a
  deliberate stepped elevation ramp (canvas < surface < card).

### 5.5 Shared primitive utilities (G2/G8)

- **`focusRing`** — one shared class (standardize on `focus-visible:` + `border-ring` +
  `ring-2 ring-ring/40`) applied to input/textarea/checkbox/switch/radio/slider/select/
  button; fix Badge (`focus:`→`focus-visible:`) and SelectTrigger (`focus:`→`focus-visible:`).
- **`overlaySurfaceClasses`** — `bg-popover rounded-lg border-border shadow-elev2
  text-popover-foreground` + the animate-in/out+zoom+slide stack; consumed by
  SelectContent/DropdownMenuContent/SubContent/PopoverContent/HoverCardContent (fixes the
  Select surface/radius/animation outlier in one edit).
- **`menuItemClasses` (or a headless `<MenuItem>`)** bridging Radix `focus:` and cmdk
  `data-[selected=true]` — one density/color for SelectItem/DropdownMenuItem/Checkbox/Radio/
  CommandItem.
- **`<ModalOverlay>` + `surfaceCard` + `<DialogCloseButton>`** — extract the triplicated
  overlay/content/close-X from dialog/alert/sheet.
- **`MenuShortcut`** — collapse the duplicate DropdownMenuShortcut/CommandShortcut.
- **`aria-[invalid=true]:border-critical` + focus ring** on input/textarea/SelectTrigger so
  the three hand-rolled error styles collapse to just setting `aria-invalid` (prereq for
  clean G6 rules editors).

### 5.6 Primitive variant surface (G6/G7)

- **Progress:** cva `variant` (default/success/warning/critical) — kills the `[&>div]:bg-*`
  hack. Default an accessible label/valuetext.
- **Alert:** add `success` + `info` variants; replace `opacity-90` with a muted token; add
  an explicit icon slot.
- **Avatar:** `size` scale (sm/md/lg) driving container + fallback text; default `h-9 w-9`.
- **Card:** `padding`/`density` prop + `elevation` variant (removes 37 padding + 3 shadow
  overrides; serves G4/G5). Consider `asChild`/semantic heading for Title/Description.
- **Slider:** optional `showValue` + min/max labels for threshold/risk/tuning UIs.
- **Table:** `density` prop on TableCell/TableHead, optional `sticky` header,
  `containerClassName`/no-wrapper escape hatch (fixes the double-wrap), and a column-resize
  affordance — the substrate a rules/dashboard builder needs.
- **Consider a thin `<Field>`** (label + control + description + error + auto id/htmlFor +
  aria-describedby) to absorb the repeated scaffold in SourceEditor/BrandingEditor/
  NotificationPrefs/BudgetCard.

### 5.7 Runtime theming / branding (G1/G6/G7/security)

- **Consolidate the three branding-apply implementations** into `theme-tokens.applyBranding`
  (accent → material → theme_tokens last-wins order is load-bearing, tested at
  `theme-tokens.test.tsx:150-157` — preserve it). BrandingEditor preview should just call
  `applyBranding(draft)`; delete the five `*Preview` fns.
- **Mirror the client allow-list + sanitizer server-side** in `_check_theme_tokens`
  (`config.py:720-736`) so #9/#10 is enforced regardless of consumer.
- **Wire the dead `ThemePreset`** end-to-end (an `applyPreset` + a picker) → turns modeled
  data into the G7 story; reconcile the `default_theme` dark-vs-system default.
- **Expand TOKEN_SPECS** to the already-allow-listed canvas/surface tint + radius scale +
  density so the editor exposes the full bounded surface (G6). Add an AA advisory to the 7
  severity hues, not just the accent.
- **Add a FOUC-guard inline script** in `index.html` (read `soc.theme` + prefers-color-scheme,
  set `.dark` before paint) reusing the `resolveDark` precedence; add a
  `@media (prefers-color-scheme: dark)` CSS fallback for the JS-off case.
- **Make `setThemeMode` the sole public theme API**; demote `ThemeProvider.setTheme` to
  internal to remove the name-confusion + silent-persist-drop bypass. Surface the failed-PUT
  case instead of swallowing it.

### 5.8 Adopt the under-used structural primitives (G3)

- Rebuild `Settings.tsx`'s hand-rolled section rail on Accordion or a vertical-Tabs variant
  (the G3 declutter lever — the primitive already exists, unused).
- Promote ONE `<Scrollable>` (thin ScrollArea) and migrate the ~19 raw `overflow-y-auto`
  containers; reconcile `scroll-area.tsx:34` with the global scrollbar rule
  (`theme.css:219-232`).
- Remove the ~7 redundant nested TooltipProviders (keep test-only ones); standardize
  `delayDuration` once.
- Fix the likely Select viewport clip (`select.tsx:85`).

### 5.9 Testing (G9)

- Add a test asserting every `ALLOWED_TOKENS` entry AND every `palette.ts token()` name
  actually exists in `theme.css` (both `:root` and `.dark`) — closes the name-drift gap
  across the four consumers.
- Add unit tests for the untested pure fns (`accentPreset`, `clearTokens`, `prefersDark`
  SSR guard, mid-hue `hexToHslTriplet` rounding) and for the four structural primitives
  (tabs/table/accordion/scroll-area — currently zero dedicated tests).
- Re-snapshot the 273 Vitest specs after any token/focus/border change; eyeball both themes.

---

## 6. Hard constraints & regression risks (must preserve)

- **`case_manager.py` `decide()` byte-identical** (#3) — not touched by this domain.
- **Barrel export names/shapes are public contracts** — Select (27) / Popover (7) /
  DropdownMenu (4) / HoverCard (2) / Command (1); Input (35) / Switch (16); Badge/Button
  variant names typed into `badges.tsx`/`alert-dialog.tsx`/hundreds of call sites. Refactor
  internals, not exports.
- **`* { border-color }` + body bg/fg globals** (`theme.css:149,156-162`) repaint the whole
  app — re-verify visually across pages.
- **`applyTokens` allow-list + `sanitizeTokenValue`** is a security control
  (`theme-tokens.test.tsx`, `settings-dirty.test.ts`) — do not widen without re-vetting
  injection safety; keep `--font-display` idempotency (`theme-tokens.ts:128-134`).
- **"quiet" material MUST keep OMITTING `--glass-opacity`** and `applyMaterial` MUST keep
  clearing it (`theme-tokens.ts:215-218`; tested `theme-tokens.test.tsx:114-141`) or
  dark-mode chrome darkens.
- **`resolveDark` precedence** (explicit user > org default > OS) is contract-tested
  (`theme-tokens.test.tsx:175-192`) and mirrors backend `effective_theme` — do not change.
- **Provider order** ThemeProvider(outer) > … > PrefsProvider(inner) (`App.tsx:262/265`):
  PrefsProvider requires `useTheme()`; reordering throws.
- **Graceful degradation:** both providers must keep flipping `ready=true` on fetch
  failure; the no-branding path must resolve to the byte-identical "quiet" default.
- **recharts requires `hsl()` STRINGS** (not Tailwind classes) — keep `palette.ts token()`
  returning strings; a renamed token silently yields transparent SVG (not caught by tsc).
- **`--accent` must stay a NEUTRAL** hover/selected surface — any G1 recolor that treats it
  as brand breaks hover chrome app-wide; fix the `Metrics.tsx:379` consumer FIRST.
- **Zero new runtime deps** — do NOT swap the vendored AlertDialog onto
  `@radix-ui/react-alert-dialog`.
- **Global `.shimmer` + `@keyframes shimmer`** (`theme.css:237-249`) and reduced-motion
  neutraliser (`theme.css:272-298`) must remain — Skeleton (and ~15 pages) break without them.
- **Additive changes with existing defaults** (new variants/props) per project convention;
  a token VALUE swap (critical↔destructive) is NOT a no-op — visual + AA pass required.
