# Round 5 P2 — Color, Typography & Spacing: External Best-Practices Synthesis

> **Scope.** A decision-oriented design-foundations spec for the TLSOC Agentic Triage
> Suite webui (standalone Vite + React + TS + Tailwind **3.4.19** + shadcn/Radix SPA,
> charts via **recharts** in `soc/components/charts.tsx`, tokens as CSS custom
> properties in `styles/theme.css`, semantic colors in `soc/components/palette.ts`).
> This is a **data-dense operational console for security analysts, not a marketing
> site.** Constraint honored throughout: **no new heavy npm deps** — every
> recommendation is a token/config/CSS change except two small, justified additions
> (`@fontsource-variable/*` build-time assets and, optionally, `@tanstack/react-virtual`).
>
> **How to read this.** Each section ends with a **DECISION** block (adopt / defer /
> reject) and, where relevant, **copy-pasteable token values**. Ground truth verified
> against the live repo on 2026-07-01: `charts.tsx` imports recharts; Tailwind is
> `^3.4.19`; there is **no `@fontsource`/font dependency and no `@font-face`** (Inter +
> JetBrains Mono are *named but not shipped* — the app silently falls back to the OS
> system stack); `--low` is green (`150 58% 35%` light / `150 60% 50%` dark), confirming
> the severity-palette collision the research flags.

---

## 0. Executive priorities (the short list)

Ordered by impact-to-effort for a console analysts live in all day:

| # | Change | Effort | Why it matters |
|---|--------|--------|----------------|
| 1 | **Ship the fonts you already declare** (self-host Inter + JetBrains Mono via `@fontsource-variable`) | S | Today production renders in the OS system stack, not Inter. Highest-impact single fix. |
| 2 | **Fix the severity palette** (drop green from severity; split severity / status / verdict into 3 axes; add icon+shape) | M | Current `--low`=green and red/green verdict are a **colorblind + semantic hazard** (~5% of users, mostly male analysts). |
| 3 | **Redefine the Tailwind fontSize scale** to a 14px-body, density-tuned tuple scale + `tabular-nums` on numerics | S | 806/855 text usages are already `xs`/`sm`; this upgrades rhythm app-wide with zero JSX churn. |
| 4 | **Sanction an 8px spacing subset + fix off-grid card padding** (`px-5`/`p-5` → 16/24) + **persist table density** per user | M | `px-5` (20px) is off the 8px rhythm in ~37 files; density is the #1 dense-table lever and is unwired to prefs. |
| 5 | **Re-derive neutral + primary chrome from Radix 12-step scales**, emit as the token DEFAULTS | M | Gives predictable surface/border/state/text separation for thousand-row tables; keeps the shadcn token contract intact. |
| 6 | **Add a dedicated colorblind-safe `--chart-1..8` categorical ramp** (Okabe-Ito) + viridis sequential | S | The current `CATEGORICAL` reuses semantic tokens → red/green/orange collisions on the Cost donut. |
| 7 | **Formalize elevation + shadow tokens; borders-for-tiled, shadows-for-floating** | S | The dark ladder is already correct; it just needs naming + an explicit shadow scale for portals. |
| 8 | **Per-archetype content width** (fluid ≤1760–1920px for operational pages, ~72ch prose cap for narrative) | M | The single global `max-w-[1400px]` strands a narrow column on ultrawide *and* over-caps dense pages. |

Everything below is **additive** and preserves the branding runtime-override contract
(`--primary`/`--accent2` + the Round-3 allow-listed theme-token overrides in
`theme-tokens.ts`): the new values become **DEFAULTS** branding can still override.

---

## 1. Color system

### 1.1 Strategy — a hybrid, not an either/or

**Keep the shadcn semantic-token contract you already ship** (`background`/`foreground`/
`card`/`popover`/`primary`/`secondary`/`muted`/`accent`/`destructive`/`border`/`input`/
`ring` + the SOC severity scale), and **re-derive the NEUTRAL + PRIMARY token VALUES
from Radix Colors' 12-step scales** instead of hand-tuned one-off HSL. Radix is the only
mainstream system that ships a purpose-built, semantically-labelled 12-step ramp with
per-step roles and automatic light/dark inversion under identical step numbers — exactly
what dense tables need (predictable surface / border / text separation without fatigue):

```
Radix 12-step role map:
 1–2  app / subtle backgrounds
 3–5  component surfaces (normal / hover / active)   ← state deltas dense UIs lack OOTB
 6–8  borders (subtle / interactive / focus)         ← dedicated border ramp
 9–10 solid (highest-chroma bg for buttons/badges)   ← NOT a text color
 11–12 text (low-contrast / high-contrast)
```

Do **not** rename tokens or change the `hsl(var(--x))` consumption pattern — that keeps
`palette.ts`, recharts, and every shadcn primitive working untouched.

**Integration mechanics (both zero-heavy-dep):**
- **(A) PREFERRED for this repo:** *paste the generated Radix CSS custom properties
  directly into `theme.css`* (from the Radix Colors site / a codegen script). **Zero npm
  dependency** — honors the constraint outright.
- **(B) Acceptable:** add `@radix-ui/colors` (CSS-only files, no JS runtime, a few KB),
  import only `slate`/`slateDark`/`blue`/`blueDark`, alias steps to tokens.
- **Reject** `windy-radix-palette` (adds a Tailwind plugin + build coupling) — it scatters
  color into markup and fights the centralized-token model.

Pick **Radix `slate`** for neutrals (cool navy-slate, matches the current 222° dark
theme; its dark scale steps up in **lightness not saturation** = the "calm, not glowy"
brief) and **Radix `blue`** (or `indigo`) for the primary accent.

### 1.2 Dark-mode surfaces & elevation

The current dark ladder is **already on-spec** and only needs formalizing:
- Never pure black — the current `--canvas 222 24% 8%` (≈#0f131a) sits between Material
  `#121212` and GitHub `#0d1117`, low-chroma, gives white text >15:1. **Keep it.**
- Convey depth by making higher surfaces **lighter** (~+2–3% L per level), not by shadow.
- **Borders for tiled/scrolled content** (cards, tables, KPI tiles), **shadows only for
  detached floating layers** (Dialog/Sheet/Popover/HoverCard/DropdownMenu/Tooltip/Command).
- Keep chroma low (chroma already drops 24%→15–16% as surfaces rise). Cap at 4–6 levels.
- Text emphasis ladder: high ~87% (`--foreground 213 28% 93%`), medium ~60%
  (`--muted-foreground`), disabled ~38% (add a token).

**Add** an explicit elevation + shadow scale (currently absent). Suggested named levels
(HSL L targets, dark): `e0 canvas 8%` · `e1 card 11–12%` · `e2 raised/popover 13%` ·
`e3 overlay/dialog 15%` · `e4 menu-on-overlay 18%`, plus a **`--surface-sunken`** (one
step *darker* than card, ~L9–10%) for log/JSON/code wells instead of yet-another-lighter
card. Add a distinct **`--hover`** token (~L15–16%) so hover is perceptibly different from
the heavier selected/`--accent` (L22%).

Shadow tokens (dark = darker + larger, color near-black not gray):
```css
--shadow-menu:    0 4px 16px -2px rgba(0,0,0,.50);
--shadow-overlay: 0 8px 24px -4px rgba(0,0,0,.55), 0 2px 8px -2px rgba(0,0,0,.45);
```
Rule for the team: *tiles/scrolls in-page → 1px border; floats on a portal → shadow +
raised surface.* Always pair a floating shadow with the raised surface color (Atlassian).

### 1.3 Recommended NEUTRAL + PRIMARY token values

Mapping Radix **slate** (neutrals) + **blue** (primary) onto the existing tokens. These
are the DEFAULTS; branding may still override `--primary`/`--accent2`. (Values below are
the intended step *roles*; regenerate exact triples from the Radix scale — prefer OKLCH
output if/when you flip the wrapper, see §1.6.)

| Token | Dark (Radix step) | Light (same step, light scale) | Role |
|---|---|---|---|
| `--canvas` / `--background` | slate-1 / slate-1–2 | slate-1 | app canvas / lowest |
| `--card` | slate-2 (slate-3 if floated) | slate-2 (white ok) | card surface |
| `--popover` | slate-2 | slate-2 | popover surface |
| `--surface-sunken` *(new)* | slate-1 (below card) | slate-2 | wells / code / log viewer |
| `--secondary` / `--muted` | slate-3 | slate-3 | muted surface |
| `--hover` *(new)* | slate-4 | slate-4 | interactive hover |
| `--accent` (selected surface) | slate-5 | slate-5 | selected/pressed surface |
| `--border` | slate-6 | slate-6 | subtle separators |
| `--input` | slate-7 | slate-7 | interactive/input border |
| *(hovered border)* | slate-8 | slate-8 | hovered border |
| `--ring` | blue-8 | blue-8 | focus ring |
| `--muted-foreground` | slate-11 | slate-11 | low-contrast text |
| `--foreground` / `--card-foreground` | slate-12 | slate-12 | high-contrast text |
| `--primary` | blue-9 (hover blue-10) | blue-9 | primary solid bg |
| `--primary-foreground` | white | white | text on primary |

**Pitfalls to enforce:** never map `--foreground` to step 9 (that's the solid-bg step;
text is 11/12). Import **only** the 2–3 scales you use (slate + blue [+ severity hues]) —
all ~30 hues × light/dark × alpha × P3 would balloon CSS. Keep branding overrides working
(Radix steps are defaults, not hardcoded). Re-verify specific pairings against WCAG 2.x AA
(Radix's guarantee is APCA; they usually agree at 11/12 vs 1/2 but spot-check
`muted-foreground` on `card`).

### 1.4 Severity / status / verdict — the biggest functional fix

**The problem (confirmed in the repo).** `palette.ts` conflates three orthogonal axes and
reuses green in severity:
- `--low` = green (`150°`) — collides with `--success` ("low severity" looks like
  "resolved").
- verdict TP → critical-red vs FP/benign → success-green — the classic **red/green** CVD
  failure, and the *only* differentiator.
- `--high` (24°) and `--medium` (36°) are ~12° apart — both read "orange" under
  deuteranopia/protanopia.
- `--medium` (36°) collides with `--warning` (36°) — a severity chip and a status chip
  look identical.

**The fix — 3 orthogonal axes** (Elastic Borealis + PatternFly consensus):
1. **SEVERITY/RISK** ramp: critical → high → medium → low → info, rendered red → orange →
   amber/gold → **blue** → blue-grey. **No green.** Info is neutral.
2. **STATUS** ramp: success (green) / warning (amber) / danger (red) — the *only* place
   green lives, always with a check icon.
3. **VERDICT**: TP = critical-red **solid** dot + "confirmed" label; FP/benign = **blue /
   blue-grey neutral** (NOT green) **hollow** dot + label; needs_human = hand/`?` icon.

Split the single flat `SEMANTIC` map in `palette.ts` into three:
`SEVERITY_COLOR`, `STATUS_COLOR`, `VERDICT_COLOR` (also mirror in `lib/types.ts`) so
future contributors can't re-conflate them.

**Recommended severity token values** (AA-verified against `--card`; darker end for text,
lighter tints for fills/bands):

```css
/* LIGHT (>=4.5:1 text on white; use tints for backgrounds) */
--critical: 0   72% 45%;   /* red   ~#C61E25 (Elastic Danger 90) */
--high:     22  90% 44%;   /* deep orange ~#C1440E */
--medium:   40  92% 38%;   /* amber/gold ~#B37400 — darkened, distinct from high */
--low:      205 75% 40%;   /* BLUE ~#1A6FB0 — REPLACES green */
--info:     220 12% 46%;   /* blue-grey/neutral ~#6B7688 */

/* DARK (lighten ~12–16% L, drop saturation slightly to hold AA on card L=12%) */
--critical: 0   78% 63%;
--high:     24  90% 60%;
--medium:   42  90% 58%;
--low:      205 80% 62%;
--info:     220 14% 68%;
```

Keep `--success`/`--warning`/`--danger` on the **status** axis only; shift severity-medium
toward gold (40–44°) so it no longer equals warning (36°).

**Redundant encoding (WCAG 1.4.1 — non-negotiable).** Color is never the only channel.
Add a shape/icon column to `badges.tsx`: critical = filled diamond/octagon, high = filled
triangle, medium = filled square, low = filled circle, info = hollow circle; verdict TP =
solid dot, FP = hollow dot. Prefer the **left-edge severity band** on dense table rows
(Fluent/Sentinel) — far more legible than a tiny colored word at high row counts.

**Optional alignment:** adopt Elastic/Splunk numeric thresholds so RiskGauge bands match
Kibana expectations — 0–21 low / 22–47 medium / 48–73 high / 74–100 critical.

### 1.5 Colorblind-safe CHART palette (`--chart-1..8`)

The current `CATEGORICAL` array reuses semantic tokens (critical=red, low/success=green,
high/medium=orange) → adjacent series collide under CVD, most visibly on the **Cost page
per-model donut/legend** where categories are identity-arbitrary. **Fix:** add a dedicated
Okabe-Ito ramp as NEW tokens (shadcn `--chart-n` convention), per-theme so mid-luminance
colors survive the dark bg. **Keep** the semantic severity/verdict tokens for charts where
color carries *meaning* (Metrics donuts) — only identity-arbitrary charts switch.

```css
/* :root (LIGHT — on white cards; yellow darkened, black→grey) */
--chart-1: 217 90% 40%;  /* blue          #0072B2 */
--chart-2: 32 100% 45%;  /* orange        #E69F00 */
--chart-3: 163 100% 31%; /* bluish-green  #009E73 */
--chart-4: 326 42% 63%;  /* reddish-purple#CC79A7 */
--chart-5: 202 76% 63%;  /* sky-blue      #56B4E9 */
--chart-6: 24 100% 42%;  /* vermillion    #D55E00 */
--chart-7: 44 74% 45%;   /* DARKENED yellow (raw #F0E442 fails on white) */
--chart-8: 0 0% 45%;     /* grey (replaces Okabe black) */

/* .dark (lift L ~12–18pts, drop chroma slightly; keep yellow bright) */
--chart-1: 212 78% 66%;
--chart-2: 35 95% 62%;
--chart-3: 160 62% 52%;
--chart-4: 326 55% 72%;
--chart-5: 202 80% 72%;
--chart-6: 20 90% 62%;
--chart-7: 50 90% 65%;
--chart-8: 0 0% 72%;
```

Then in `palette.ts`: `export const CATEGORICAL = [token('chart-1'), … token('chart-8')]`
(keep `categorical(i)` and the semantic map). Add a **sequential viridis** helper for
heatmaps (MITRE coverage, risk gradients) — hardcode ~7 stops, no `d3-scale-chromatic`:
`#440154 #443983 #31688e #21918c #35b779 #90d743 #fde725` + a `sequential(t)` lerp, and a
single-hue Blues fallback derived from `--primary`. Cap arbitrary categorical series at 7
+ "Other" (`--chart-8` grey). Optionally offer index-keyed SVG `<pattern>` fills for
print/grayscale robustness (default off to keep the calm look). **Validate in a CVD
simulator + grayscale** before merge; add a vitest guard asserting `CATEGORICAL` resolves
to `--chart-n` and all 8 exist in `:root` **and** `.dark`. **Do not** add `chroma-js` /
`d3-scale-chromatic` — the palettes are static hex/HSL lists.

### 1.6 OKLCH — a fast-follow, not now

shadcn/Tailwind v4 moved to **OKLCH** in 2025 because HSL makes dark-surface/border
derivation muddy (goes purple/desaturated as you nudge lightness). Since tokens are
wrapped values consumed via `var()`, switching the triple format is a one-line wrapper
change. **Recommendation:** keep Tailwind v3 + HSL for now (Radix ships HSL/hex too);
treat OKLCH as a scoped fast-follow bundled with any Tailwind-v4 migration (see §4.3). Do
**not** migrate casually — OKLCH changes actual rendered colors vs the hand-tuned HSL
severity palette; you'd re-verify AA for every severity/verdict/status color in both
themes.

> **DECISION.** **Adopt** the hybrid: re-derive neutral+primary chrome from Radix
> slate+blue (paste vars, zero dep); **adopt** the 3-axis severity/status/verdict split
> with the token values in §1.4 + icon/shape encoding; **adopt** the `--chart-1..8`
> Okabe-Ito ramp + viridis sequential. **Defer** OKLCH + full-severity Radix backing to a
> scoped follow-up. **Reject** `windy-radix-palette`, `chroma-js`, `d3-scale-chromatic`.

---

## 2. Typography

### 2.1 Base & root

**14px body is correct** for a dense console (Atlassian, Carbon, Primer, Geist all anchor
product text at 14px). The repo is already de facto there (806/855 usages are `text-xs`
12px or `text-sm` 14px) — but via Tailwind's 16px-anchored default, with no `tabular-nums`.

**Keep the root at browser-default 16px.** Do **not** set `html { font-size: 14px }` /
`87.5%` — that silently shrinks every rem-based shadcn/Radix primitive and defeats
accessibility zoom. Express 14px on **body**:
```css
body { font-size: 0.875rem; line-height: 1.25rem; font-variant-numeric: tabular-nums; }
```

### 2.2 Type scale (replace Tailwind's default `fontSize` in `tailwind.config.js`)

Density-tuned `[size, { lineHeight, letterSpacing, fontWeight }]` tuples; **line-heights as
fixed rem on 4px multiples** (snaps to the 8px grid). rem @ 16px root → px shown:

```js
fontSize: {
  '2xs': ['0.6875rem', { lineHeight: '0.875rem', letterSpacing: '0.02em' }],  // 11/14 micro: badges/timestamps ONLY
  xs:    ['0.75rem',   { lineHeight: '1rem',     letterSpacing: '0.01em' }],   // 12/16 labels, table meta, chips
  sm:    ['0.8125rem', { lineHeight: '1.125rem' }],                            // 13/18 dense table cells, secondary UI
  base:  ['0.875rem',  { lineHeight: '1.25rem' }],                             // 14/20 PRIMARY body/UI default
  md:    ['0.9375rem', { lineHeight: '1.375rem' }],                            // 15/22 comfortable body in reading panels
  lg:    ['1rem',      { lineHeight: '1.5rem' }],                              // 16/24 long-form / card titles
  xl:    ['1.125rem',  { lineHeight: '1.5rem',   fontWeight: '600' }],         // 18/24 H3
  '2xl': ['1.25rem',   { lineHeight: '1.625rem', letterSpacing: '-0.01em', fontWeight: '600' }], // 20/26 H2 page heading
  '3xl': ['1.5rem',    { lineHeight: '1.875rem', letterSpacing: '-0.015em', fontWeight: '650' }],// 24/30 H1
  '4xl': ['1.875rem',  { lineHeight: '2.25rem',  letterSpacing: '-0.02em',  fontWeight: '650' }],// 30/36 hero/display
}
```

Because usage is overwhelmingly `xs`/`sm`/`base`, **redefining what those resolve to
upgrades the whole app's rhythm with zero JSX churn.** Add `2xs`/`md` for the few new spots.

### 2.3 Heading hierarchy & weight discipline

Map to `PageHeader` / `KpiTile` / card titles; weight-and-color driven, not size-only:
- **Display/Hero** 30/36 semibold-650 · **H1** 24/30 650 · **H2** 20/26 600 ·
  **H3/card title** 18/24 600 · **H4** 16/24 600 · **eyebrow/overline** 12px uppercase,
  `letter-spacing 0.06em`, 600, muted-foreground.
- **Cap weight:** body 400, emphasis/labels 500, headings/KPI values 600, display 650 max.
  Avoid 700+ (smears at 12–14px; Geist/Vercel refuse >600 for UI). Never `font-weight:300`
  below ~20px. Use ≤4 visible heading levels per screen; pair with `--muted-foreground`
  for hierarchy, not just size.

### 2.4 Line-height & WCAG

Density line-heights: body/UI 1.4–1.45 (14→20), dense rows 13→18 (~1.38), micro 12→16
(1.33), headings 1.2–1.25. **But WCAG 2.1 SC 1.4.12** requires **≥1.5** on blocks of
running prose — chat messages, case narratives, rationale/"Why", runbook/knowledge bodies
get a dedicated `.prose`/`text-md` treatment (15/24 or 14/22.5), never the tight table
default. 12px is the practical floor; `2xs` (11px) badges/timestamps only — re-check AA
contrast for muted text at 11–12px.

### 2.5 Numerics & security-data legibility

- **`tabular-nums` everywhere numbers live and change:** KpiTile/StatCard values,
  DataTable numeric columns, cost ledger, risk scores, p50/p90/MTTR — including
  animated/SSE-streaming values (stops digit-width jitter). Inter and JetBrains Mono both
  support tabular figures.
- **Disambiguation for security data:** enable Inter's `ss02`/`zero`/`cv01` (0/O, 1/l/I,
  slashed zero) on **body + tables** (theme.css currently sets `ss01`/`cv01` on headings
  only). Add `font-feature-settings: 'ss01' 1, 'zero' 1` on mono/code contexts (log rows,
  IOC values, case-XXXX IDs) — a real misread-prevention win for a SOC.

### 2.6 Fonts — SHIP what you declare (the top typography fix)

The repo **names** Inter (sans) + JetBrains Mono (mono) in `tailwind.config.js` + theme.css
but ships **no `@fontsource` dep, no local woff2, no `@font-face`, no CDN link** —
production silently uses the OS system stack. The pairing is an excellent, SIL-OFL,
data-dense default; **keep it and actually deliver it:**

- **Self-host, do not use Google Fonts CDN** (privacy/GDPR, CWV latency, air-gapped SOC
  networks may block it). Add build-time-only assets:
  `npm i -D @fontsource-variable/inter @fontsource-jetbrains-mono`. Fontsource ships
  subsettable WOFF2 files, **not a runtime JS lib** — consistent with the no-heavy-dep
  constraint. Import `@fontsource-variable/inter/wght.css` + the JetBrains Mono weights you
  use (400/500/700) in `main.tsx` (or `styles/fonts.css`); Vite fingerprints + long-caches.
- Verify the family string in tailwind.config matches Fontsource's exported name
  (`'Inter Variable', 'Inter', …`).
- **Subset to latin, preload exactly ONE critical sans weight** via `?url` import + a
  `<link rel="preload" as="font" type="font/woff2" crossorigin>` (crossorigin is required
  even same-origin or the font downloads twice). `font-display: swap` for sans,
  `optional` for the non-critical mono. Realistic cost: ~40–120 KB sans (subset variable)
  + the mono, cacheable.
- **Scope JetBrains Mono** to genuinely fixed-width surfaces (raw logs, `_raw` JSON,
  hashes/IOCs/IPs, code, log viewer). For numeric **table columns** prefer Inter +
  `tabular-nums` — proportional-with-tabular reads better at 13px density than monospace.
  **Turn ligatures OFF** on log/IOC surfaces (`calt`) so `->`/`!=`/`===` don't distort
  attacker-controlled tokens.
- Do **not** swap to Geist (lateral, aesthetic-only) or IBM Plex (Sans lacks a variable
  font → heavier payload; institutional tone) unless there's a brand reason. If you want an
  operator-selectable alternative, add `geist` as a **vetted enum** in the branding
  `FONT_ALLOWLIST` (`theme-tokens.ts`) — never loosen the injection-safe validator.
- Add a tiny visual guard rendering `0O 1lI 8B 5S` + a tabular numeric column so a future
  regression (lost tabular-nums / disambiguation set) is caught.

> **DECISION.** **Adopt:** self-host Inter + JetBrains Mono (`@fontsource-variable/*`,
> dev-dep, build-time assets); the density type-scale tuples in §2.2; `tabular-nums` +
> Inter disambiguation features; the ≥1.5 prose exception. **Reject:** a 14px root, Geist
> or IBM Plex as default, weights >650. **This section adds no runtime JS dependency.**

---

## 3. Spacing, grid & layout

### 3.1 Spacing scale — 8px base, 4px sub-grid

Tailwind's default scale is already a 4px unit with 8px multiples, and the repo declares
`--density-unit: 0.25rem` (4px) + a 1440/1400px container. **Adopt an EXPLICIT sanctioned
subset** (= Atlassian's `space.050..800`, 1:1) so authors stop free-styling:

```
1 = 4px   2 = 8px   3 = 12px   4 = 16px   6 = 24px   8 = 32px   12 = 48px   16 = 64px
```

8px is the base rhythm; 4px is the sub-grid for **in-component tightness only** (badge
padding, icon–label gaps, cell vertical padding). **Do NOT drop to a 4px base globally** —
a SOC triage console is *medium* density, not a trading terminal; 4px-base trades rhythm
for marginal density and decision fatigue. Keep `--density-unit` as the sub-grid unit.

**Section rhythm to codify:** `space-y-6` (24px) between major page blocks · `gap-4`
(16px) inside a block · `gap-2` (8px) inside a row/chip cluster. Enforce **internal ≤
external** (padding inside an element ≤ the gap around it) so groups read as groups at
density: card inner padding (16px) ≤ inter-card gap (24px, `gap-6`).

### 3.2 Fix off-grid card padding

`webui/src/ui/card.tsx` uses `px-5 py-4` / `px-5 pb-5` = **20px = 2.5 grid units** (off the
8px rhythm), and ~37 files reference `px-5`/`p-5`. Standardize via the card **primitive +
codemod** (not by hand): **`p-4` (16px)** for dense/nested cards, **`p-6` (24px)** for
top-level page cards / KPI tiles.

### 3.3 Table density — the highest-leverage lever

`DataTable.tsx` has a `density: 'normal' | 'compact'` prop (comfortable cells `px-4 py-3` =
16H/12V; compact `px-4 py-2` = 16H/8V; header `h-11` = 44px — all in-spec) but it's **not
persisted**. Every source says the correct row height is the one each analyst *picked*:

- **Wire density to `UserPrefsStore`** under the existing per-table `table_id` key
  (`PUT /api/prefs/user/tables/{table_id}`), zero-migration. Default **compact** for
  all-day analyst surfaces (Cases, logs, audit), **comfortable** as the org default
  elsewhere.
- Compact rows land ~40–44px (power-user target); consider a 3rd **comfortable/spacious**
  mode (`py-3.5`/`py-4`, ~48–52px) for touch/casual review.
- Keep column padding **≥16px horizontal / ≥32px total between columns** (below that,
  columns visually merge and scanning collapses).
- Keep interactive controls **≥24×24 CSS px** even in compact mode (WCAG 2.2 target size).
- Optional global density switch: a `data-density` attribute on the shell scaling the
  row/card padding tokens, persisted alongside theme via the existing prefs cascade.

### 3.4 Page gutters & vertical rhythm

The shell's `max-w-[1400px] px-4 py-6 sm:px-6` is grid-correct — **keep 24px desktop
gutter, 16px < 640px**; container padding `1.5rem` (24px) agrees. Line-heights on 4px
multiples so rows land predictably (a 15px line-height in a `py-2` cell computes to a clean
~40px row).

### 3.5 Data density above the fold (Tufte + Datadog/Grafana)

- Ship the **density toggle** (compact default for analyst surfaces) — done in §3.3.
- **Tufte data-ink cleanup** on the recharts components: drop chart borders/backgrounds,
  thin/remove gridlines, remove redundant axis titles; separate sections with
  **whitespace, not boxes/fills**. Zero layout change, pure density win.
- **Sparklines** (~20-line inline SVG in `charts.tsx`, no dep) in case rows / KPI tiles /
  source health — **always paired with the current numeric value** (micro/macro).
- **Small multiples** (shared axes) for per-source alert volume + per-tactic MITRE trend,
  replacing several full-size charts.
- **Row virtualization** for the case table + unified `/api/logs` sheet — the one
  **justified new dep**, `@tanstack/react-virtual` (~10 KB, TanStack-family; TanStack
  Table has no built-in virtualization). Without it, compact rows + 1,000+ cases stutter.
  Keep it behind the shared DataTable (opt-in per table).
- **Sticky headers + frozen first column** (pure CSS `position: sticky` + edge shadow).
- **12-column grid discipline** on Overview/Metrics (timeseries ≥4 cols, log/stream ≥6
  cols; group even singletons); **QA at 1280px AND 2560px**.
- **SOC hierarchy + F/Z scan:** summary KPIs top-left, actionable queue mid, raw
  drill-down low; put the log/stream widget last so it doesn't trap scroll.
- **Progressive disclosure:** expand CaseHoverCard usage, expandable detail rows,
  collapsed advanced filters — never bury triage-decisive fields.

### 3.6 Compact page headers

Every operational design system converges on a **single dense header row**: breadcrumb
above title (left) + actions right on the same baseline (~48–56px tall) — **not** a stacked
marketing hero. `PageHeader.tsx` is close but the 40px icon chip + `text-2xl` title +
always-rendered description make it tall.

- Add a **`dense` (default)** vs `spacious` variant: icon chip 28–32px (`h-7`/`h-8`) not
  40px; title `text-lg`/`text-xl font-semibold` not `text-2xl`; band ~48–56px.
- Replace the decorative `eyebrow` with a real **breadcrumb** (shadcn `<Breadcrumb>`,
  already in `ui/*`) above the title.
- Make `description` optional and non-tall (inline-muted on wide screens or behind
  `HelpTip`); never a forced 3rd line.
- Add a **`tabs` slot** so `TabbedPage` section tabs live on the header's bottom edge
  (no second band). Add a **`meta` slot** for status/severity badges beside the title
  (denser + scannable than prose).
- Optional **sticky + condense-on-scroll** (IntersectionObserver sentinel, no dep) for
  CaseDetail. Constrain actions to **1 primary + 1 secondary**, rest into a kebab
  `DropdownMenu`; on `<sm`, collapse to the kebab (don't flex-wrap → header doubles).
- Set a shared **`--header-h: 52px`** token in theme.css for both the header and the
  condensed sticky bar (keeps the 8px grid). Keep all header content plain text (UNTRUSTED-
  safe; never `dangerouslySetInnerHTML`).

### 3.7 Content width — per-archetype, not one global cap

The single global `max-w-[1400px]` in `AppShell.tsx` is too blunt: it wastes ultrawide
space on dense operational pages *and* is fine only for reading pages. **Split by
archetype:**

- **`layout-wide`** (operational: Cases, Overview, Metrics, Standup/Shift, Campaigns,
  Baseline, Batch, unified Logs): `w-full max-w-[1760px] 2xl:max-w-[1920px] mx-auto px-4
  sm:px-6 lg:px-8` — fluid, framed, not full-bleed.
- **`layout-prose`** (narrative: CaseDetail "Why"/rationale, chat threads, long-form
  settings): `w-full max-w-[75ch] mx-auto` — readable ~60–75 char line length.
- **Do NOT go truly uncapped** (Datadog High Density Mode caps at 2×12; Grafana panels
  live within chrome). Use scaling gutters (`px-4 → sm:px-6 → lg:px-8 → 2xl:px-12`) so
  content on a 3440px monitor is framed, not floating.
- **Add columns, don't stretch:** KPI/card grids widen by column *count* at large
  breakpoints (`grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4`) — the codebase
  currently has almost no `2xl:` grid variants.
- **Container queries** for card/panel components so they reflow by *slot*, not viewport
  (fixes the "looks right full-width, breaks in a half-panel" bug). Add the first-party
  free **`@tailwindcss/container-queries`** plugin (tiny, no runtime) in v3.4, or get
  `@container` built-in on a v4 upgrade. Media queries stay for the page shell.
- **Tables** don't go edge-to-edge on ultrawide (long rows kill scannability): cap
  readable content, truncate + tooltip/hover, and spend extra width on a **master-detail
  right pane** — a second information region, not longer rows.

> **DECISION.** **Adopt:** the sanctioned 8px subset; fix `px-5`→16/24 via the card
> primitive; persist table density (compact default for analyst surfaces) via
> `UserPrefsStore`; compact-header variant + header-embedded tabs; per-archetype width
> (`layout-wide` ≤1760–1920px / `layout-prose` ~72ch) + add-columns-at-2xl; the
> `@tailwindcss/container-queries` plugin. **Adopt (justified dep):**
> `@tanstack/react-virtual` for the case/logs tables + inline-SVG sparklines (no dep).
> **Reject:** a global 4px base, uncapped full-bleed, monospace numeric columns.

---

## 4. Token architecture, migration order & guardrails

### 4.1 Three-tier token model (within Tailwind v3, no migration)

Adopt the industry-standard **primitive → semantic → component** layering *inside*
`theme.css`, additively:

- **Tier 1 — primitives/reference** (new): theme-agnostic ramps as bare HSL triples
  (`--blue-500`, `--slate-900`, or the Radix step vars from §1.3) so `hsl(var())` still
  works.
- **Tier 2 — semantic/system** (your existing role tokens, redefined to *alias*
  primitives, e.g. `--primary: var(--blue-600)`): **only this tier flips** `:root`↔`.dark`.
  Purpose-named only — never `--red-bg`.
- **Tier 3 — component/branding** = the existing `ALLOWED_TOKENS` allow-list in
  `theme-tokens.ts` (already your de-facto contract). Grow deliberately; **only promote a
  component token when 3+ components share the decision** (EightShapes). Use `cva` (already
  a dep) as the component-variant layer — do **not** invent per-component CSS vars
  speculatively.

**Give the SOC scale proper role sets**, not single values: for each severity/status add
partners — a fill (`--critical`), an **on-color** (`--critical-foreground`) for AA text on
that fill, and a **subtle surface** (`--critical-subtle`) for row-tint/badge backgrounds
(mirrors Material 3's error/on-error/error-container triad). This stops components
hand-rolling `bg-critical/10` and guessing text color. **Keep the derived on-/subtle
tokens computed and NOT operator-overridable** (preserve AA); expose only
`--primary`/`--accent2`/`--radius`/font to branding.

**Kill the raw hex leaks:** `grep -rnE '#[0-9a-fA-F]{6}' src` finds ~36 — each bypasses
theming + branding. Route through Tier 1/2 and add a **CI grep guard** that fails the build
on new raw hex in `.tsx`.

### 4.2 Recommended migration order

1. Generate Radix slate+blue light/dark step vars (paste into theme.css as Tier-1
   primitives).
2. Redefine the ~15 neutral/primary Tier-2 tokens to alias them (§1.3).
3. Split severity/status/verdict into 3 axes + new severity values (§1.4); add icon/shape
   to `badges.tsx`.
4. Add `--chart-1..8` + viridis; rewrite `CATEGORICAL` (§1.5).
5. Add elevation + shadow + `--surface-sunken` + `--hover` tokens (§1.2).
6. Ship fonts (`@fontsource-variable/*`) + redefine the fontSize scale + `tabular-nums`
   (§2).
7. Sanction the 8px subset; fix card padding; persist table density; compact header;
   per-archetype width + container-queries plugin (§3).
8. Add on-/subtle SOC partner tokens (Tier-2) + the raw-hex CI guard (§4.1).
9. **Validate:** visually diff a dense table + CaseDetail + charts in both themes; run
   every pairing through a contrast checker (AA: 4.5:1 text, 3:1 large/UI) **and** a CVD
   simulator (protan/deuter/tritan) + grayscale; `npm run build` (tsc+vite) + `vitest run`
   + `npm run lint` green.

### 4.3 Tailwind v4 + OKLCH — a separate optional follow-up

v4's `@theme inline` collapses the config into CSS and auto-generates utilities from
`--color-*` vars (delete the ~40-line color block in tailwind.config; one source of truth;
wide-gamut OKLCH). But it flips shadcn to OKLCH and needs a retest of the 273 vitest specs.
**Do it as a scoped task, not a drive-by.** If you migrate, follow shadcn's exact pattern:
keep raw vars in `:root`/`.dark` as full `oklch()` colors, map them under `@theme inline`
as `--color-*: var(--role)` so `palette.ts` can still read them for recharts.

### 4.4 Guardrails / non-negotiables preserved

- Branding runtime override contract (`--primary`/`--accent2` + `ALLOWED_TOKENS` +
  `sanitizeTokenValue`) stays intact — all new values are **defaults**; new
  branding-writable tokens must go through the allow-list + sanitizer; derived AA tokens
  are **not** operator-writable.
- recharts consumes concrete `hsl(var(--x))` strings resolved in `palette.ts` (can't take
  Tailwind classes) — keep the `token()` helper pattern; point `CATEGORICAL`/`semanticColor`
  at semantic role tokens so theme/branding changes re-color charts consistently.
- **Zero new *runtime* deps.** The only additions: `@fontsource-variable/*` (dev-dep,
  build-time WOFF2 assets), `@tailwindcss/container-queries` (tiny first-party, no runtime),
  and `@tanstack/react-virtual` (~10 KB, justified for table scale). No `chroma-js`,
  `d3-scale-chromatic`, `windy-radix-palette`, or a JS color runtime.

---

## 5. Key sources (curated)

**Color / dark mode / severity**
- Radix Colors — understanding the 12-step scale, aliasing, theme color:
  https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale ·
  https://www.radix-ui.com/colors/docs/overview/aliasing ·
  https://www.radix-ui.com/themes/docs/theme/color
- shadcn theming + Tailwind v4: https://ui.shadcn.com/docs/theming ·
  https://ui.shadcn.com/docs/tailwind-v4
- OKLCH rationale: https://evilmartians.com/chronicles/oklch-in-css-why-quit-rgb-hsl
- Material dark elevation: https://m2.material.io/design/color/dark-theme.html ·
  Atlassian elevation: https://atlassian.design/foundations/elevation ·
  GitHub Primer color: https://github.blog/engineering/user-experience/unlocking-inclusive-design-how-primers-color-system-is-making-github-com-more-inclusive/
- Elastic Borealis shared severity ramp (exact hexes, no green in severity):
  https://github.com/elastic/kibana/issues/203387
- PatternFly status vs severity (color+icon+text): https://www.patternfly.org/patterns/status-and-severity/
- Okabe-Ito colorblind-safe palette: https://www.nature.com/articles/nmeth.1618 ·
  https://jfly.uni-koeln.de/color/ · viridis/ColorBrewer: https://colorbrewer2.org/
- USWDS color / WCAG 1.4.1: https://designsystem.digital.gov/design-tokens/color/overview/

**Typography**
- Atlassian typography: https://atlassian.design/foundations/typography/ · Carbon:
  https://carbondesignsystem.com/elements/typography/overview/ · Primer:
  https://primer.style/foundations/typography/ · Geist: https://vercel.com/geist/typography
- Tailwind font-size + variant-numeric: https://tailwindcss.com/docs/font-size ·
  https://tailwindcss.com/docs/font-variant-numeric
- Inter: https://rsms.me/inter/ · JetBrains Mono: https://www.jetbrains.com/lp/mono/ ·
  Fontsource preload: https://fontsource.org/docs/getting-started/preload ·
  web fonts best practices: https://web.dev/articles/font-best-practices
- WCAG SC 1.4.12 Text Spacing: https://www.w3.org/WAI/WCAG21/Understanding/text-spacing.html

**Spacing / density / layout**
- setproduct data-table density: https://www.setproduct.com/blog/data-table-ui-design ·
  Atlassian spacing: https://atlassian.design/foundations/spacing · MUI X row height:
  https://mui.com/x/react-data-grid/row-height/
- Datadog effective dashboards: https://github.com/DataDog/effective-dashboards/blob/main/guidelines.md ·
  Grafana best practices: https://grafana.com/docs/grafana/latest/dashboards/build-dashboards/best-practices/
- Container queries: https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Containment/Container_queries ·
  https://github.com/tailwindlabs/tailwindcss-container-queries · Tailwind v4:
  https://tailwindcss.com/blog/tailwindcss-v4
- Compact headers: https://www.atlassian.design/guidelines/product/patterns/page-header ·
  https://carbondesignsystem.com/patterns/global-header/ · Cloudscape hero-header:
  https://cloudscape.design/patterns/general/hero-header/
- Ultrawide/width: https://css-tricks.com/optimizing-large-scale-displays/
- TanStack Virtual: https://tanstack.com/virtual/latest

**Token architecture**
- Material 3 tokens: https://m3.material.io/foundations/design-tokens · EightShapes naming:
  https://medium.com/eightshapes-llc/naming-tokens-in-design-systems-9e86c7444676 ·
  shadcn Tailwind v4 theming: https://www.shadcnblocks.com/blog/tailwind4-shadcn-themeing
