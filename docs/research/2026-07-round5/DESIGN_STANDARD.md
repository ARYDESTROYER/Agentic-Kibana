# DESIGN STANDARD — Round 5 (the single canonical spec ALL agents code against)

> **Status:** AUTHORITATIVE. This is the one design standard for `webui/` (Vite + React 18 +
> TS + Tailwind **v3.4.19** + shadcn/ui on Radix). Every implementation agent codes against
> THIS document; when a page and this doc disagree, this doc wins and the page is wrong.
> **Stack is fixed:** consolidate the existing shadcn/Radix/Tailwind stack — do **NOT** invent
> a new system, do **NOT** migrate to Tailwind v4/OKLCH in this round (deferred, see §1.7).
>
> **Grounded in:** `understand/DESIGN_SYSTEM_MAP.md`, `RESEARCH_COLOR_TYPE_SPACING.md`,
> `RESEARCH_DASHBOARD_PATTERNS.md`, `RESEARCH_A11Y_MOTION.md`, `RESEARCH_SUMMARY.md`
> (dep ledger §0), and the live files (`styles/theme.css`, `palette.ts`, `theme-tokens.ts`,
> `tailwind.config.js`, `ui/card.tsx`, `ui/badge.tsx`, `KpiTile.tsx`, `PageHeader.tsx`,
> `HeroPanel.tsx`, `AppShell.tsx`, `nav.ts`) read on 2026-07-01.
>
> **All contrast ratios below are MEASURED** (WCAG relative-luminance over the exact HSL
> triples), not claimed. Where the map/comments said "AA" and it was false
> (`theme.css:49,82,175,203`), these values fix it or the comment gets corrected.

---

## 0. Hard invariants (every agent re-reads these before touching a file)

| # | Invariant | What it means for UI work |
|---|-----------|---------------------------|
| **#3** | `engine/case_manager.py` `decide()` **BYTE-IDENTICAL** | No dashboard/badge/chart/rule-editor may influence close/escalate. A rules editor writes *config*; `decide()` still adjudicates. Close-with-disposition posts through `decide()`. |
| **#6** | ONE usage-ledger write per LLM call | No UI change touches this; do not add client-side "retry" that re-fires an LLM call. |
| **#9** | Log/user-influenceable values are UNTRUSTED | Render as **plain text / `<CodeBlock>` / SVG `<text>` ONLY**. Never `dangerouslySetInnerHTML`, never `{{{raw}}}`, never as a CSS value. Chart labels, IOCs, hostnames, rule names, OCSF `unmapped`/`raw_data`, Navigator `comment`/`metadata` — all untrusted. |
| **#2** | Append-only audit | Any new state-changer surfaces the action; never a silent write. |
| **#10** | Secrets are **booleans** in UI | Show `configured ✓` / `not set`, never a secret value. New `SecretField` primitive (§5) enforces this. |
| — | `PUT /api/settings` **deep-MERGE** | The client must PATCH only changed blocks; a full-doc replace wipes unrendered `Preferences` blocks. Rule/dashboard editors save partials. |
| — | **Deep-link back-compat for all 31 page ids** | The 31 `PageId`s in `nav.ts:53-84` (`overview dashboard cases investigate chat intelligence metrics models scans standup catalog playbooks approvals knowledge memory sources cost inbox account sessions settings security roles users audit admin_sessions logs campaigns tuning batchjobs baseline`) MUST remain routable. IA changes re-parent/re-tab; they never drop an id. |
| — | `webui/src/lib/types.ts` ⇔ `backend/app/models.py` in sync | New rule/dashboard/pref shapes are additive + defaulted (no migration). |
| — | **Dep ledger is closed** (§13) | No runtime npm dep outside the approved ledger. All additive + default-safe + reversible. `applyTokens` allow-list + `sanitizeTokenValue` are a security control — do not widen without re-vetting. |

---

## 1. COLOR SYSTEM (G1) — the full token set, exact before→after, both themes

### 1.0 Architecture: three tiers, ONE source of truth

Adopt **primitive → semantic → component** layering *inside* `styles/theme.css` (additive; no
migration). All tokens stay **bare HSL triples** consumed via `hsl(var(--x))` so `palette.ts`,
recharts, and every shadcn primitive keep working unchanged.

- **Tier 1 — primitives** (NEW): Radix `slate` (neutrals) + Radix `blue` (primary) 12-step ramps,
  pasted as `--slate-1..12` / `--slate-dark-1..12` / `--blue-1..12` / `--blue-dark-1..12`.
  Zero dep (paste, do not `npm i @radix-ui/colors`).
- **Tier 2 — semantic** (existing role tokens, **redefined to alias Tier-1**): `--primary`,
  `--card`, `--border`, `--foreground`, the SOC scale, … Only this tier flips `:root`↔`.dark`.
- **Tier 3 — component/branding** = the `ALLOWED_TOKENS` allow-list in `theme-tokens.ts`
  (unchanged contract). Grow only when **3+ components** share the decision.

**The four-file coupling chain stays in lockstep by hand** (`theme.css` → `tailwind.config.js`
→ `theme-tokens.ts ALLOWED_TOKENS` → `palette.ts`). §12 adds the CI test that fails when a token
name exists in one but not the others (closes the silent-transparent-SVG gap the map flags at
DESIGN_SYSTEM_MAP §1.1).

> Numbers below are **role targets** verified for AA. Regenerate exact Radix triples from
> radix-ui.com/colors if you re-tune; keep the measured ratios ≥ the stated bar.

### 1.1 Tier-1 primitives — Radix slate + blue (paste into `theme.css`)

Declare ONCE in `:root` (light) and `.dark` (dark). These are the ramp; Tier-2 aliases them.

```css
:root {
  /* Radix SLATE (light) — bare HSL triples */
  --slate-1: 240 20% 99%;  --slate-2: 240 20% 98%;  --slate-3: 240 11% 95%;
  --slate-4: 240 10% 92%;  --slate-5: 230 11% 89%;  --slate-6: 226 12% 85%;
  --slate-7: 225 12% 80%;  --slate-8: 222 12% 70%;  --slate-9: 220 9%  46%;
  --slate-10: 220 9% 42%;  --slate-11: 220 12% 40%; --slate-12: 222 47% 11%;
  /* Radix BLUE (light) */
  --blue-1: 210 100% 99%;  --blue-6: 213 62% 84%;   --blue-7: 213 71% 76%;
  --blue-8: 214 90% 48%;   --blue-9: 214 90% 42%;   --blue-10: 214 92% 38%;
  --blue-11: 213 90% 40%;  --blue-12: 216 60% 20%;
}
.dark {
  /* Radix SLATE DARK — steps up in LIGHTNESS not saturation (the "calm, not glowy" brief) */
  --slate-1: 222 24% 9%;   --slate-2: 222 20% 13%;  --slate-3: 222 16% 17%;
  --slate-4: 222 15% 20%;  --slate-5: 222 15% 23%;  --slate-6: 220 14% 27%;
  --slate-7: 219 13% 33%;  --slate-8: 218 12% 46%;  --slate-9: 218 10% 50%;
  --slate-10: 218 11% 56%; --slate-11: 216 14% 68%; --slate-12: 214 15% 91%;
  /* Radix BLUE DARK */
  --blue-1: 216 50% 12%;   --blue-6: 216 40% 40%;   --blue-7: 215 55% 48%;
  --blue-8: 213 90% 62%;   --blue-9: 214 88% 46%;   --blue-10: 214 90% 52%;
  --blue-11: 210 85% 70%;  --blue-12: 209 90% 90%;
}
```

### 1.2 Tier-2 neutrals / chrome — BEFORE → AFTER (aliases Tier-1)

**LIGHT (`:root`).** "before" = current `theme.css:16-58`. Ratios measured on the resulting value.

| Token | BEFORE | AFTER (alias) | AFTER value | Contrast (measured) |
|---|---|---|---|---|
| `--canvas` | `220 20% 97%` | `var(--slate-2)` | `240 20% 98%` | app body |
| `--background` | `0 0% 100%` | `var(--slate-1)` | `240 20% 99%` | lowest |
| `--surface` | `220 20% 99%` | `var(--slate-2)` | `240 20% 98%` | raised tile |
| **`--surface-sunken`** (NEW) | — | `var(--slate-3)` | `240 11% 95%` | wells/code/log/JSON |
| `--card` | `0 0% 100%` | `var(--slate-1)` | `240 20% 99%` | card surface |
| `--card-foreground` | `222 39% 14%` | `var(--slate-12)` | `222 47% 11%` | fg 16.1:1 on card ✓ |
| `--popover` | `0 0% 100%` | `var(--slate-1)` | `240 20% 99%` | **all** floating surfaces |
| `--popover-foreground` | `222 39% 14%` | `var(--slate-12)` | `222 47% 11%` | ✓ |
| `--foreground` | `222 39% 14%` | `var(--slate-12)` | `222 47% 11%` | **16.1:1** on canvas ✓ |
| `--muted` | `220 18% 96%` | `var(--slate-3)` | `240 11% 95%` | muted surface |
| `--muted-foreground` | `218 14% 40%` | `220 12% 40%` | `220 12% 40%` | **6.14:1** on card ✓ (was borderline for tick/axis text) |
| `--secondary` | `220 18% 95%` | `var(--slate-3)` | `240 11% 95%` | — |
| `--secondary-foreground` | `222 33% 22%` | `var(--slate-11)` | `220 12% 40%` | ✓ |
| `--accent` (NEUTRAL selected surface — keep neutral!) | `220 18% 93%` | `var(--slate-5)` | `230 11% 89%` | hover/selected only |
| `--accent-foreground` | `222 33% 22%` | `var(--slate-12)` | `222 47% 11%` | ✓ |
| **`--hover`** (NEW) | — | `var(--slate-4)` | `240 10% 92%` | interactive hover (one notch below `--accent`) |
| `--border` (hairline delimiter) | `220 18% 90%` (1.27:1) | `var(--slate-6)` | `226 12% 85%` | **1.45:1** — decorative delimiter (see note) |
| **`--border-strong`** (NEW, structural/interactive) | — | `220 15% 58%` | `220 15% 58%` | **3.27:1** ✓ (≥3.0 non-text) |
| `--input` (interactive control border) | `220 16% 87%` | `220 15% 58%` | `220 15% 58%` | **3.27:1** ✓ |
| `--ring` | `217 88% 50%` | `var(--blue-8)` | `214 90% 48%` | **4.86:1** on white ✓ (≥3.0) |
| `--primary` | `217 88% 50%` (5.06) | `var(--blue-9)` | `214 90% 42%` | white-on-fill **6.02:1** ✓ |
| `--primary-foreground` | `0 0% 100%` | `0 0% 100%` | white | ✓ |

**DARK (`.dark`).** "before" = current `theme.css:95-128`.

| Token | BEFORE | AFTER (alias) | AFTER value | Contrast (measured) |
|---|---|---|---|---|
| `--canvas` | `222 24% 8%` | `var(--slate-1)` | `222 24% 9%` | never pure black ✓ |
| `--background` | `222 23% 9%` | `var(--slate-1)` | `222 24% 9%` | — |
| `--surface` | `222 20% 11%` | `var(--slate-2)` | `222 20% 13%` | +L per level, not shadow |
| **`--surface-sunken`** (NEW) | — | `var(--slate-1)` | `222 24% 9%` | one step *darker* than card |
| `--card` | `222 20% 12%` | `var(--slate-2)` | `222 20% 13%` | — |
| `--card-foreground` | `213 28% 93%` | `var(--slate-12)` | `214 15% 91%` | 15.9:1 ✓ |
| `--popover` (was `222 22% 11%` — drifted 1% off card) | `222 22% 11%` | `var(--slate-2)` | `222 20% 13%` | **now == card** (fixes surface drift, map §3.2) |
| `--foreground` | `213 28% 93%` | `var(--slate-12)` | `214 15% 91%` | **15.9:1** ✓ |
| `--muted-foreground` | `217 16% 66%` | `216 14% 68%` | `216 14% 68%` | **7.16:1** on card ✓ |
| `--accent` (NEUTRAL selected) | `222 16% 22%` | `var(--slate-5)` | `222 15% 23%` | hover/selected only |
| **`--hover`** (NEW) | — | `var(--slate-4)` | `222 15% 20%` | interactive hover |
| `--border` (hairline) | `218 16% 21%` (1.34) | `var(--slate-6)` | `220 14% 27%` | **1.47:1** decorative delimiter |
| **`--border-strong`** (NEW) | — | `218 12% 50%` | `218 12% 50%` | **3.90:1** on card ✓ |
| `--input` | `218 16% 23%` | `218 12% 50%` | `218 12% 50%` | **3.90:1** ✓ |
| `--ring` | `217 84% 62%` | `var(--blue-8)` | `213 90% 62%` | **5.46:1** on card ✓ |
| `--primary` (white-on-fill was 3.35 ✗) | `217 84% 62%` | `var(--blue-9)` | `214 88% 46%` | white-on-fill **5.22:1** ✓ |
| `--primary-foreground` | `0 0% 100%` | `0 0% 100%` | white | ✓ |

> **BORDER POLICY (resolves the map's border-contrast tension, §3.3).** `--border` is a
> **decorative hairline** delimiter (~1.45:1) and is deliberately below the 3.0 non-text bar —
> matching every calm console (Radix step 6). **When a border is the ONLY thing conveying a
> control boundary or an interactive/focusable edge, use `--border-strong`/`--input` (≥3.0:1).**
> Form controls, focusable rows, and any "click here" edge use the strong token; card/table
> gridlines use the hairline. Never rely on hairline alone to convey state — pair with
> surface/fill/icon.

> **`--destructive` is DEAD — delete it, standardize on `--critical`** (map §3.1). Today
> button/badge/alert `destructive` variants already resolve to `--critical`; the `--destructive`
> token is defined but unused and its value *differs*. **Decision: remove `--destructive` /
> `--destructive-foreground` from `theme.css` + tailwind; keep the `destructive` *variant
> NAMES* (public API) pointing at `--critical`.** This is NOT a no-op recolor — do a visual +
> AA pass on DangerZone / AlertDialog / ErrorBoundary after the swap.

### 1.3 The 3 orthogonal semantic axes (G1) — each with `/-foreground/-text`, all AA

The biggest functional fix. Split the single flat `SEMANTIC` map into **SEVERITY · STATUS ·
VERDICT** so they can never re-conflate (Elastic Borealis + PatternFly consensus,
RESEARCH_COLOR §1.4). **Drop green from severity** (`--low` → **blue**); **verdict FP → neutral
blue-grey**, not green (kills the red/green CVD hazard). Each token ships a **triad**:

- `--{t}` = the **solid fill** (badge/bar background, dot).
- `--{t}-foreground` = **on-color** text for AA text *on that fill* (white or near-black).
- `--{t}-text` = the **standalone text/tint color** for `text-{t}` on card + the `/10` wash
  (this is the value tuned to clear **4.5:1 as text on the card**).

This replaces the ad-hoc `bg-critical/10 text-critical` pattern re-implemented in ~33 places
(map §3.11) with one authoritative triad, and stops the `text-{t}` chips that currently fail AA
(map §3.3: light high 3.83 / medium 3.54 / info 4.08 / warning 3.24 as text).

**SEVERITY / RISK axis** — red → orange → gold → **blue** → blue-grey. No green. Info neutral.

```css
:root { /* LIGHT — *-text measured as text on white card */
  --critical: 358 75% 45%;  --critical-foreground: 0 0% 100%;  --critical-text: 358 75% 42%; /* 6.36:1 */
  --high:     22 90% 44%;    --high-foreground: 0 0% 100%;      --high-text: 22 90% 40%;      /* 4.81:1 */
  --medium:   40 96% 40%;    --medium-foreground: 222 47% 11%;  --medium-text: 40 96% 32%;    /* 4.54:1 */
  --low:      212 90% 45%;   --low-foreground: 0 0% 100%;       --low-text: 212 90% 42%;      /* 5.63:1 (BLUE, was green) */
  --info:     220 12% 46%;   --info-foreground: 0 0% 100%;      --info-text: 215 16% 42%;     /* 5.65:1 (blue-grey) */
}
.dark { /* DARK — *-text measured as text on card L13 */
  --critical: 358 78% 62%;  --critical-foreground: 0 0% 100%;  --critical-text: 358 80% 68%; /* 5.56:1 */
  --high:     26 90% 58%;    --high-foreground: 222 47% 11%;    --high-text: 28 90% 62%;      /* 7.50:1 */
  --medium:   42 92% 58%;    --medium-foreground: 222 47% 11%;  --medium-text: 42 92% 62%;    /* 10.06:1 */
  --low:      210 85% 62%;   --low-foreground: 222 47% 11%;     --low-text: 210 85% 68%;      /* 7.02:1 (BLUE) */
  --info:     214 14% 66%;   --info-foreground: 222 47% 11%;    --info-text: 214 14% 72%;     /* 8.12:1 */
}
```

**STATUS axis** — the **only** place green lives (always with a check icon). Fills for pills.

```css
:root {
  --success: 158 74% 34%;   --success-foreground: 0 0% 100%;   --success-text: 158 74% 30%; /* ~4.6:1 */
  --warning: 36 92% 42%;     --warning-foreground: 222 47% 11%; --warning-text: 36 96% 32%;  /* ~4.5:1 — hue 36, DISTINCT from severity-medium hue 40 */
  --danger:  358 75% 45%;    --danger-foreground: 0 0% 100%;    --danger-text: 358 75% 42%;  /* aliases critical */
}
.dark {
  --success: 158 64% 48%;   --success-foreground: 222 47% 11%; --success-text: 158 60% 56%;
  --warning: 40 90% 56%;     --warning-foreground: 222 47% 11%; --warning-text: 40 90% 62%;
  --danger:  358 78% 62%;    --danger-foreground: 0 0% 100%;    --danger-text: 358 80% 68%;
}
```

**VERDICT axis** — resolves the escalated/duplicate drift by construction. FP → **neutral
blue-grey** (NOT green), TP → critical-red.

| Verdict label | Token used | Shape (non-color) |
|---|---|---|
| `true_positive` | `--critical` | **solid** dot |
| `false_positive` / `benign` | `--info` (blue-grey neutral) | **hollow** dot |
| `needs_human` | `--warning` | hand/`?` icon |
| `escalated` | `--high` (was drift: badges said critical, palette said high — **standardize on `--high`**) | filled triangle |
| `suspicious` | `--high` | filled triangle |
| `duplicate` / `undetermined` | `--muted-foreground` fill / `secondary` badge | hollow square |

> **Medium/warning collision fixed:** severity-medium moves to hue **40** (gold), warning stays
> **36** (amber) — no longer identical (map §3.8, RESEARCH_COLOR §1.4).

### 1.4 Chart tokens `--chart-1..8` (Okabe-Ito) + viridis sequential

The current `CATEGORICAL` reuses semantic hues → red/green/orange collisions on identity-arbitrary
charts (Cost donut). Add a **dedicated colorblind-safe** ramp as NEW tokens; free the semantic
tokens from double duty. Semantic charts (Metrics verdict/severity donuts) KEEP semantic tokens;
only identity-arbitrary charts (per-model bars, cost) switch to `--chart-*`.

```css
:root { /* LIGHT — on white cards; yellow darkened, black→grey. All ≥3.0 UI, most ≥4.5 */
  --chart-1: 211 100% 36%; /* blue           6.75:1 */
  --chart-2: 32 100% 37%;  /* orange         4.20:1 */
  --chart-3: 163 100% 26%; /* bluish-green   4.67:1 */
  --chart-4: 326 40% 50%;  /* reddish-purple ~4.6:1 */
  --chart-5: 202 75% 40%;  /* sky-blue       4.67:1 */
  --chart-6: 24 100% 38%;  /* vermillion     4.81:1 */
  --chart-7: 45 92% 32%;   /* dark yellow    4.14:1 (raw #F0E442 fails on white) */
  --chart-8: 0 0% 42%;     /* grey (Other)   5.32:1 */
}
.dark { /* DARK — lift L, drop chroma slightly; yellow bright */
  --chart-1: 212 78% 66%;  --chart-2: 35 95% 62%;  --chart-3: 160 62% 52%;  --chart-4: 326 55% 72%;
  --chart-5: 202 80% 72%;  --chart-6: 20 90% 62%;  --chart-7: 50 90% 65%;   --chart-8: 0 0% 72%;
}
```

**Sequential (viridis) for heatmaps** (MITRE coverage, risk gradients) — hardcode 7 stops + a
`sequential(t)` lerp in `palette.ts` (no `d3-scale-chromatic`):
`#440154 #443983 #31688e #21918c #35b779 #90d743 #fde725`.

Then in `palette.ts`: `CATEGORICAL = [token('chart-1'), … token('chart-8')]`; cap arbitrary
series at 7 + "Other" (`--chart-8` grey). **Fix the `--accent`-as-series bug** (`Metrics.tsx:379`
donut "Agent" slice) — repoint to `--chart-*` / `--primary` (map §3.8: `--accent` must stay a
neutral hover surface).

### 1.5 Elevation / shadow tokens (replace the hardcoded `hsl(222 30% 12%)`)

Today `boxShadow.elev1/elev2/glow` hardcode a fixed dark-navy in `tailwind.config.js` — invisible
on the dark canvas, un-brandable (map §1.5). **Add per-theme `--shadow-color` + composed levels
in `theme.css`; point tailwind at the token.** Rule: **borders for tiled/scrolled content, shadows
only for detached floating portals** (Dialog/Sheet/Popover/HoverCard/DropdownMenu/Tooltip/Command).

```css
:root {
  --shadow-color: 222 30% 12%;
  --elev-1: 0 1px 2px hsl(var(--shadow-color) / 0.06), 0 1px 3px hsl(var(--shadow-color) / 0.08);
  --elev-2: 0 4px 12px -4px hsl(var(--shadow-color) / 0.12), 0 8px 24px -10px hsl(var(--shadow-color) / 0.14);
  --shadow-menu:    0 4px 16px -2px hsl(var(--shadow-color) / 0.18);
  --shadow-overlay: 0 8px 24px -4px hsl(var(--shadow-color) / 0.22), 0 2px 8px -2px hsl(var(--shadow-color) / 0.18);
}
.dark {
  --shadow-color: 0 0% 0%;  /* near-black in dark, larger + darker */
  --elev-1: 0 1px 2px hsl(0 0% 0% / 0.40), 0 1px 3px hsl(0 0% 0% / 0.30);
  --elev-2: 0 4px 12px -4px hsl(0 0% 0% / 0.50), 0 8px 24px -10px hsl(0 0% 0% / 0.45);
  --shadow-menu:    0 4px 16px -2px hsl(0 0% 0% / 0.55);
  --shadow-overlay: 0 8px 24px -4px hsl(0 0% 0% / 0.60), 0 2px 8px -2px hsl(0 0% 0% / 0.50);
}
```
`tailwind.config.js`: `boxShadow.elev1: 'var(--elev-1)'`, `elev2: 'var(--elev-2)'`,
`menu: 'var(--shadow-menu)'`, `overlay: 'var(--shadow-overlay)'`. **Always pair a floating shadow
with the raised surface color** (`bg-popover`).

### 1.6 The ONE label→token authority (charts AND badges use it)

**Single source of truth** lives in `palette.ts`. Both the Tailwind Badge variant AND the recharts
`hsl()` string derive from it. Delete the parallel `badges.tsx` switches and the independent
`palette.ts SEMANTIC` copy (map §3.7 drift). **Preserve currently-shipped colors per label**
(tests + muscle memory), except the two documented fixes (escalated→`high`, FP→`info` neutral).

```ts
// palette.ts — the ONE authority. Every axis is a separate map (can't re-conflate).
export const SEVERITY_COLOR = { critical:'critical', high:'high', medium:'medium', low:'low', info:'info' } as const;
export const STATUS_COLOR   = { new:'muted', investigating:'primary', escalated:'high', on_hold:'warning', resolved:'success', closed:'success' } as const;
export const VERDICT_COLOR  = { true_positive:'critical', false_positive:'info', benign:'info', needs_human:'warning', suspicious:'high', duplicate:'muted', undetermined:'muted' } as const;
// non-color redundancy — beside every color (WCAG 1.4.1), consumed by badges + gauge + legend + heatmap
export const SEMANTIC_ICON: Record<string, LucideIcon> = { /* §6.1 */ };
// recharts consumes token(name) → hsl(var(--{name})); badges consume the same key as a bg-/text- variant.
```
**Collapse the four 0–100 band ladders** (`badges.tsx severityBandFromNumber`, `riskVariant`,
`RiskGauge bandOf`, `postureFromScore`) into ONE thresholds module. Adopt Elastic numeric bands:
`0–21 low / 22–47 medium / 48–73 high / 74–100 critical`.

### 1.7 OKLCH / Tailwind v4 — DEFERRED (do not do this round)

Keep Tailwind v3 + HSL. OKLCH changes rendered colors and would force re-verifying every AA value.
Bundle it with a future scoped v4 migration only (RESEARCH_COLOR §1.6, §4.3).

---

## 2. TYPOGRAPHY (G2)

### 2.1 Ship the fonts you already declare (the #1 typography fix)

Today Inter + JetBrains Mono are **named in tailwind but never shipped** — prod renders in the OS
stack (map §1.5, RESEARCH_COLOR §2.6). **Self-host via `@fontsource` dev-deps** (build-time WOFF2,
zero runtime JS, offline/air-gap safe — no Google CDN):

```
npm i -D @fontsource-variable/inter @fontsource-jetbrains-mono
```
In `main.tsx` (or `styles/fonts.css`): `import '@fontsource-variable/inter/wght.css';` + the
JetBrains Mono weights actually used (400/500/700). Preload exactly ONE sans weight
(`<link rel="preload" as="font" type="font/woff2" crossorigin>` — crossorigin required even
same-origin). `font-display: swap` for sans, `optional` for mono. Verify the family string in
`tailwind.config.js` matches Fontsource's exported name (`'Inter Variable', 'Inter', …`).

### 2.2 Root + base

**Keep root at browser-default 16px** (never `html { font-size:14px }` — it shrinks every
rem-based Radix primitive and breaks zoom). Express 14px on **body**:

```css
body { font-size: 0.875rem; line-height: 1.25rem; font-variant-numeric: tabular-nums; }
```
Enable Inter disambiguation on **body + tables** (0/O, 1/l/I): `font-feature-settings: 'ss01' 1,
'cv01' 1, 'zero' 1, 'calt' 1` (theme.css currently sets `ss01`/`cv01` on headings only). On
log/IOC/code surfaces (mono) **turn `calt` OFF** so `->`/`!=`/`===` don't distort attacker tokens.

### 2.3 The type scale — replace Tailwind's default `fontSize` (14px-base tuples)

Because 806/855 usages are already `xs`/`sm`, redefining what these resolve to upgrades the whole
app with **zero JSX churn**. Line-heights are fixed rem on 4px multiples (snaps to the 8px grid).
Paste into `tailwind.config.js theme.extend.fontSize`:

```js
fontSize: {
  '2xs': ['0.6875rem', { lineHeight: '0.875rem', letterSpacing: '0.02em' }],   // 11/14 — badges/timestamps ONLY
  xs:    ['0.75rem',   { lineHeight: '1rem',     letterSpacing: '0.01em' }],    // 12/16 — labels, table meta, chips
  sm:    ['0.8125rem', { lineHeight: '1.125rem' }],                             // 13/18 — dense table cells
  base:  ['0.875rem',  { lineHeight: '1.25rem' }],                             // 14/20 — PRIMARY body/UI default
  md:    ['0.9375rem', { lineHeight: '1.375rem' }],                            // 15/22 — comfortable reading panels
  lg:    ['1rem',      { lineHeight: '1.5rem' }],                              // 16/24 — long-form / card titles
  xl:    ['1.125rem',  { lineHeight: '1.5rem',   fontWeight: '600' }],         // 18/24 — H3
  '2xl': ['1.25rem',   { lineHeight: '1.625rem', letterSpacing: '-0.01em', fontWeight: '600' }], // 20/26 — H2 page heading
  '3xl': ['1.5rem',    { lineHeight: '1.875rem', letterSpacing: '-0.015em', fontWeight: '650' }],// 24/30 — H1
  '4xl': ['1.875rem',  { lineHeight: '2.25rem',  letterSpacing: '-0.02em',  fontWeight: '650' }],// 30/36 — hero/display
}
```

### 2.4 Heading hierarchy & weight discipline

- **Display/Hero** 30/36 · **H1** 24/30 · **H2 (page heading)** 20/26 · **H3/card title** 18/24 ·
  **H4** 16/24 · **eyebrow/overline** 12px UPPERCASE `tracking-[0.06em]` 600 `text-muted-foreground`.
- **Weight cap:** body 400 · emphasis/labels 500 · headings/KPI values 600 · display **650 max**.
  Never `font-weight:300` below ~20px, never 700+ for UI text (smears at 12–14px). ≤4 visible
  heading levels per screen; use `--muted-foreground` for hierarchy, not just size.

### 2.5 `tabular-nums` rule (non-negotiable for numerics)

Apply `tabular-nums` to **everything where numbers live and change**: KpiTile/StatCard values,
DataTable numeric columns, cost ledger, risk scores, p50/p90/MTTR, SSE-streaming values (stops
digit-width jitter). `KpiTile.tsx:78` already does this — extend it everywhere.

### 2.6 Prose exception (WCAG 1.4.12) + kill arbitrary sizes

Running prose (chat messages, case narratives, rationale/"Why", runbook/knowledge bodies) uses a
dedicated `text-md` / `.prose` treatment at **line-height ≥1.5** (15/24) — never the tight table
default. **Kill the 102 arbitrary `text-[..]` sizes** (grep-verified) — map each to a scale step;
add a CI grep guard (§12) failing the build on new `text-[<number>` in `.tsx`.

---

## 3. SPACING / GRID / ELEVATION (G2/G4/G5)

### 3.1 The sanctioned 8px spacing subset (authors stop free-styling)

8px is the base rhythm; 4px is the sub-grid for **in-component tightness only** (badge padding,
icon–label gap, cell vertical padding). **Do NOT drop to a 4px base globally** — this is a *medium*
density triage console, not a trading terminal.

```
1 = 4px   2 = 8px   3 = 12px   4 = 16px   6 = 24px   8 = 32px   12 = 48px   16 = 64px
```
**Section rhythm to codify:** `space-y-6` (24) between major page blocks · `gap-4` (16) inside a
block · `gap-2` (8) inside a row/chip cluster. **Rule: internal ≤ external** (padding inside an
element ≤ the gap around it) so groups read as groups: card inner padding (16) ≤ inter-card gap
(24, `gap-6`). Off-grid values `5`(20)/`7`(28)/`9`(36)/`10`(40)/`11`(44) are **banned** in new
code except where a shadcn primitive already ships them.

### 3.2 Card padding — kill `px-5` (20px, off-grid)

`ui/card.tsx` uses `px-5 py-4` / `px-5 pb-5` = **20px = 2.5 units** (off the 8px rhythm), and 17
files reference `px-5`/`p-5`. **Fix in the Card primitive** (§5), not by hand: `p-4` (16) dense/
nested; `p-6` (24) top-level page cards / KPI tiles. Add a `padding`/`density` prop so the 37
padding overrides the map counts (DESIGN_SYSTEM_MAP §3.13) collapse to a prop.

### 3.3 Elevation & radius scale

- **Elevation:** use the §1.5 tokens. `shadow-elev1` on resting tiles is optional (border-first);
  `shadow-menu`/`shadow-overlay` (= `elev2`) on portals only. **Tiled/scrolled → 1px border;
  float on a portal → shadow + raised surface.**
- **Radius scale** (keep the existing tokens; `--radius` = lg anchor): `--radius-sm 0.375rem` ·
  `--radius-md 0.5rem` · `--radius-lg 0.625rem` · `--radius-xl 0.875rem`. Tailwind: `rounded-sm/md/lg`
  anchored to `--radius`; `rounded-r-sm..r-xl` = the explicit scale. **Declare radius/density/
  font-display ONCE in `:root`** (they're mode-agnostic; today twice-declared → drift, map §1.5).
  Kill `checkbox.tsx`'s magic `rounded-[4px]` → `rounded-sm`.
- **Wire the dead `--density-unit`** (`0.25rem`, never consumed today, map §4.4) OR delete it. If
  kept, drive card padding + form-control density from it as the one spacing source (G4/G5).

---

## 4. LAYOUT (G4/G5)

### 4.1 `<PageContainer>` — kill the hard `max-w-[1400px]`

Today `AppShell.tsx:601` wraps **every** page in `mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6`
— strands a narrow column on ultrawide *and* over-caps dense pages. Replace with a width strategy
by archetype (RESEARCH_COLOR §3.7):

```tsx
// PageContainer.tsx — the ONE width authority. variant per page archetype.
type ContainerVariant = 'fixed' | 'wide' | 'fluid' | 'prose';
const WIDTHS: Record<ContainerVariant, string> = {
  fixed: 'max-w-[1200px]',                           // forms/settings body, focused single-column
  wide:  'max-w-[1760px] 2xl:max-w-[1920px]',        // operational: Cases, Overview, Metrics, Standup, Campaigns, Baseline, Batch, Logs
  fluid: 'max-w-none',                               // full-bleed grids/dashboards (still gutter-framed, never edge-to-edge tables)
  prose: 'max-w-[75ch]',                             // narrative: CaseDetail "Why"/rationale, chat threads, long-form settings
};
// every variant: `mx-auto w-full px-4 sm:px-6 lg:px-8 2xl:px-12 py-6`
```
**Per-archetype assignment:** `wide` for all operational pages; `prose` for narrative; `fixed` for
focused forms; `fluid` only for the custom-dashboard canvas (G7). **Add columns, don't stretch:**
KPI/card grids widen by column *count* at large breakpoints
(`grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4`). Tables never go edge-to-edge on
ultrawide — spend extra width on a **master-detail right pane**, not longer rows.

### 4.2 Compact PageHeader (merged HeroPanel) — the G5 lever

Today `PageHeader.tsx` (40px icon chip + `text-2xl` + always-rendered description) and `HeroPanel.tsx`
(the tall `p-8` posture hero) are two components. **Merge into ONE `PageHeader` with a `variant`;
retire `HeroPanel`** (posture band becomes `variant="hero"` but compact). Every operational design
system converges on a **single dense header row** (~48–56px), not a stacked marketing hero.

```tsx
interface PageHeaderProps {
  variant?: 'dense' | 'hero';        // dense = default (~52px band); hero = the compacted posture band
  breadcrumb?: Crumb[];              // replaces the decorative eyebrow (real <Breadcrumb>)
  title: string;                     // dense: text-lg/xl font-semibold (NOT text-2xl)
  icon?: LucideIcon;                 // dense: h-7/h-8 chip (NOT h-10/h-11)
  description?: string;              // optional, NON-tall (inline-muted on wide OR behind HelpTip)
  meta?: React.ReactNode;           // status/severity badges beside the title (denser than prose)
  tabs?: React.ReactNode;           // section tabs on the header's BOTTOM edge (no 2nd band)
  actions?: React.ReactNode;        // 1 primary + 1 secondary; rest → kebab DropdownMenu; on <sm collapse to kebab
  sticky?: boolean;                  // optional condense-on-scroll (IntersectionObserver, no dep)
}
```
Add a shared **`--header-h: 52px`** token (theme.css) used by the header AND the condensed sticky
bar (keeps the 8px grid + powers `scroll-margin-top`, §6). **All header content is plain text**
(UNTRUSTED-safe; never `dangerouslySetInnerHTML`).

**Compact the posture "Security Posture Dashboard" hero band (G5):** `variant="hero"` uses
`p-6` (not `p-8`), `h-8` icon chip, `text-2xl` title, and folds the KPI summary INTO the header's
`meta`/`tabs` slot instead of a separate tall wash section — the whisper `bg-hero-glow` stays but
the band height drops ~40%.

### 4.3 The three-zone dashboard (G4) — the converged operational layout

All SIEM/observability leaders converge here (RESEARCH_DASHBOARD §1). Compose with `PageContainer
variant="wide"` (or `fluid` for the custom-dashboard canvas):

```
┌ CONTROL BAR ─ [Time range ▾ Last 24h] [⟳ Off ▾] [Source ▾][Severity ▾][Owner ▾] · last refresh HH:MM
├ KPI STRIP ─── 4–6 KpiTiles, grid-cols auto-fit minmax(220px,1fr), sticky, each a drill-down link
├ WIDGET GRID ─ named collapsible <DashboardGroup>s, narrative order (general→specific, top-left=critical)
└ ── below fold ── MITRE heatmap · dwell histogram · verdict/disposition mix
```
- **Control bar** drives ALL panels from one shared `TimeRange` + variables context; serialize
  range+variables to the **URL query string** (shareable) + persist to `UserPrefsStore`. Auto-refresh
  **default Off/1m** (cost-metered), pause on hidden tab (Page Visibility API). Ranges are **ES
  date-math strings** stored relative, resolved at query time.
- **KPI strip:** cap ~6; big `tabular-nums` value + threshold color + period-over-period delta +
  optional sparkline; every tile deep-links.
- **Widget grid:** wrap every widget in a named `<DashboardGroup>` (Radix Collapsible). Equal-height
  cards (`h-full`) + `line-clamp-1` on sub-lines. Readability minimums: time-series ≥ ~1/3 width,
  table/stream ≥ ~1/2 width. **Every tile/segment/row deep-links** into the filtered case list
  carrying range+variables — no dead-end numbers.

### 4.4 Container queries — reflow by slot, not viewport

Add the first-party **`@tailwindcss/container-queries`** plugin (dev-dep, tiny, no runtime). Use
`@container` on card/panel/widget components so they reflow by their **slot** width (fixes the
"looks right full-width, breaks in a half-panel" bug). **Media queries stay for the page shell;
container queries for reusable widgets** (KPI tiles, dashboard widgets, master-detail panes).

### 4.5 Per-archetype widths (quick reference)

| Archetype | Pages | `PageContainer` | Grid at 2xl |
|---|---|---|---|
| Operational | overview/dashboard, cases, metrics, standup, campaigns, baseline, batchjobs, logs, sources | `wide` | +columns |
| Dashboard canvas (G7) | custom dashboards | `fluid` | react-grid-layout |
| Narrative | CaseDetail "Why", chat, long-form settings sections | `prose` | 1 col |
| Focused form | account, security, settings body, rule editors | `fixed` | 1–2 col |

---

## 5. COMPONENT STANDARD (G2/G8) — extract once, use everywhere

**ONE card grammar. ONE focus ring. ONE overlay surface. ONE menu item.** Refactor internals, NOT
exports (Select×27, Input×35, Switch×16, Badge/Button variant names are public contracts). Every
primitive keeps its barrel export shape.

### 5.1 Shared class utilities (add to `ui/` or `lib/`) — collapse the drift

```ts
// focusRing — ONE recipe (map §3.5: today FIVE spellings). Applied to input/textarea/checkbox/
// switch/radio/slider/select/button; fix Badge (focus:→focus-visible:) + SelectTrigger.
export const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 ' +
  'focus-visible:ring-offset-2 focus-visible:ring-offset-background';

// overlaySurface — ONE floating surface (map §3.2/§3.4: fixes Select's bg-card/rounded-md/fade outlier).
// Consumed by SelectContent/DropdownMenuContent/PopoverContent/HoverCardContent/CommandContent.
export const overlaySurface =
  'bg-popover text-popover-foreground rounded-lg border border-border shadow-overlay ' +
  'data-[state=open]:animate-in data-[state=closed]:animate-out ' +
  'data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 ' +
  'data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95';

// menuItem — ONE item (map §3.11: today 5 near-identical copies). Bridges Radix focus: and cmdk data-[selected].
export const menuItem =
  'relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none ' +
  'focus:bg-accent focus:text-accent-foreground data-[selected=true]:bg-accent ' +
  'data-[disabled]:pointer-events-none data-[disabled]:opacity-50';

// modalOverlay — the triplicated dialog/alert/sheet backdrop (map §3.11).
export const modalOverlay = 'fixed inset-0 z-50 bg-black/45 backdrop-blur-[2px] ' +
  'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0';
```

### 5.2 Shared primitives to extract + use everywhere

| Primitive | What it does | Fixes (map ref) |
|---|---|---|
| **Card** (`padding`/`density`/`elevation` props; `p-4`/`p-6` not `px-5`; Title=`<h3>`/Desc=`<p>`) | one card grammar | §3.13 (37 padding + 3 shadow overrides, div-not-heading) |
| **PageHeader** (dense/hero variant, §4.2; merges HeroPanel) | one header | §3.9 tab-spacing drift |
| **KpiTile** (add `goodDirection`, §5.3; absorb `StatCard` as `variant='bar'`) | one KPI card | §4.1 delta-color bug |
| **SegmentedControl** (Radix Tabs styled as segments) | Chat/Investigate toggle, density, stack-by | NEW (today hand-rolled) |
| **FilterBar** (dashboard variables + saved-view + density) | control-bar filters | NEW |
| **ConfirmDialog** (replaces the 2 `window.confirm` in `Roles.tsx:216`/`Users.tsx:153`) | one destructive gate | replaces native confirm |
| **Field** (label + control + description + error + auto `id`/`htmlFor` + `aria-describedby`) | a11y form wrapper | §3.13 no invalid state; §4 rules editors |
| **SecretField** (shows `configured ✓`/`not set` boolean; never the value; #10) | secret inputs | invariant #10 |
| **NumberField** (validated numeric, min/max/step, `aria-invalid`) | rule thresholds (G6) | §4.1 |
| **LabeledSlider** (Slider + numeric readout + min/max/step markers + value tooltip) | risk-weight/threshold/tuning (G6) | §4.2 Slider no readout |
| **TagInput** (chip entry, keyboard-add/remove) | tags, rule allowlists | NEW |
| **Collapsible/`<DashboardGroup>`** (named group, persisted open state) | dashboard widget groups | §3.9 Accordion under-adopted |
| **IconButton** (`min-h-6 min-w-6` hit target ≥24px) | row/toolbar/close-X icons | §1.E target size |
| **DataTable** (compact-default density persisted; sticky header; `containerClassName` no-double-wrap escape; `aria-sort`) | one table | §3.9 double-wrap, §7 density |

**Variant additions (additive, defaults unchanged):**
- **Progress:** add cva `variant` (default/success/warning/critical) — kills the `[&>div]:bg-*`
  hack in `BaselineGauge.tsx:100,366` (map §3.13). Default an accessible `aria-valuenow`/label.
- **Alert:** add `success` + `info` variants (today only default/destructive/warning); replace
  `opacity-90` with a muted token; explicit icon slot.
- **Avatar:** `size` scale (sm/md/lg) driving container + fallback text.
- **Table:** `density` prop on Cell/Head, optional `sticky` header, no-wrapper escape hatch (fixes
  the double scroll/clip context, map §3.9).

**Fix the functional defects while here:** the likely **Select viewport clip**
(`select.tsx:85` pins Viewport height to trigger height — verify + fix to width); the redundant
nested **TooltipProviders** (App wraps once with `delayDuration=200`; remove the ~7 nested ones,
map §3.12); **AlertDialog** must suppress dismiss-on-overlay/Escape for destructive gates (map §3.16).

### 5.3 KpiTile `goodDirection` — FIX the delta-color correctness bug

`KpiTile.tsx:85` colors the delta by **sign** (`>=0 → text-success`) — wrong for a SOC
("open alerts +30%" renders green). **Color = judgement (improved?), arrow = true direction:**

```ts
// props: goodDirection?: 'up' | 'down' | 'none'  (default 'up')
const improved = goodDirection === 'none' ? null
               : goodDirection === 'up'   ? delta.value >= 0
               : /* 'down' */                delta.value <= 0;
const color = improved === null ? 'text-muted-foreground'
            : improved          ? 'text-success' : 'text-critical';
const Arrow = delta.value >= 0 ? ArrowUpRight : ArrowDownRight;   // NEVER flip the arrow
// a11y: aria-label announces BOTH direction and judgement (not color-only)
```
Always render the comparison period (`vs prev 24h`). Add an optional recharts sparkline (~120×36,
axes hidden, `isAnimationActive={false}`, `aria-hidden`, value in the sub-line).

### 5.4 Charts — recharts stays; ONE `ChartConfig` map

Stay on **recharts** (upgrade v2→v3 as a **deliberate** wave for `accessibilityLayer` — not a
drive-by; v3 is not a v2 drop-in). recharts consumes **`hsl()` STRINGS** from `palette.ts token()`
(cannot take Tailwind classes) — a renamed token silently yields transparent SVG (§12 guards it).
Borrow shadcn's `ChartConfig` idea so legend labels + tooltip names + colors come from ONE source:

```ts
type ChartSeriesConfig = Record<string, { label: string; color?: string; token?: string }>;
// color resolved via token()/semanticColor(); labels rendered as SVG <text> only (#9).
```
Keep all series `isAnimationActive={false}` (already true everywhere). Add histogram
(`BarChart`-over-server-bins + SLA `ReferenceLine`) and funnel (`FunnelChart`) — no new dep.

---

## 6. ACCESSIBILITY (WCAG 2.2 AA) — G9

### 6.1 `SEMANTIC_ICON` beside color (non-color signaling, 1.4.1 — HIGHEST SOC RISK)

Meaning is **never** color-only. One `SEMANTIC_ICON` map in `palette.ts` beside the color maps,
consumed by `badges.tsx`, `RiskGauge`, chart legends, MITRE heatmap:

| Class | Shape / icon | Class | Shape / icon |
|---|---|---|---|
| critical | filled diamond/octagon | true_positive | **solid** dot |
| high | filled triangle | false_positive/benign | **hollow** dot (blue-grey) |
| medium | filled square | needs_human | hand / `?` |
| low | filled circle | escalated | filled triangle |
| info | hollow circle | resolved/closed | check |

Prefer a **left-edge severity band** on dense table rows (far more legible than a tiny colored word
at high row counts). **RiskGauge shows numeric value + text band label** ("High"), not only an arc.

### 6.2 The 4 new WCAG 2.2 AA criteria (each a real risk here)

- **2.4.11 Focus Not Obscured:** sticky PageHeader / sticky table headers / sticky Settings
  save-bar can cover a focused control. Add `scroll-margin-top: var(--header-h)` on focusable
  rows/inputs (or `scroll-padding-top` on the scroll container).
- **2.5.8 Target Size (≥24×24 CSS px):** wrap icon-only buttons in `min-h-6 min-w-6` via the shared
  `IconButton`. Sweep: row action icons, bulk-select checkboxes, pagination arrows, chart legend
  toggles, close-X. Glyph may stay 16px; the *hit target* must be ≥24px.
- **2.5.7 Dragging:** any drag-to-reorder (column/saved-view reorder, draggable dashboard tiles)
  needs a **non-drag alternative** (up/down "move" buttons or a "move to…" menu).
- **3.3.8 Accessible Authentication:** **allow paste + autofill** on username/password/**TOTP**/
  recovery fields (never block paste). Correct `autocomplete`: `username`, `current-password`,
  `new-password`, **`one-time-code`** (MFA).

### 6.3 Focus rings, `aria-sort`, live announcer

- **Focus ring:** the ONE `focusRing` recipe (§5.1); verify `--ring` ≥3:1 both themes (measured:
  light 4.86, dark 5.46 ✓).
- **Sortable columns:** `<button>` inside `<th scope="col">`; set `aria-sort` (`ascending`/
  `descending`); **OMIT `aria-sort` when unsorted** (never `"none"`); the sort arrow is an SVG shape
  change `aria-hidden`. Because `aria-sort` is silently ignored by VoiceOver/TalkBack, **push
  "Cases sorted by risk, descending" into the shared live region** and clear after ~1s.
- **One app-level `useLiveAnnouncer()`** + a single `<VisuallyHidden aria-live="polite">` at root;
  feed sort changes, bulk-action outcomes ("12 cases acknowledged"), DnD moves, case-saved.
- **Contrast CI gate:** ~20-line relative-luminance function over `palette.ts` + resolved tokens;
  fail the build on any text-on-bg < 4.5:1 or chart-series/ring pair < 3:1 (zero dep).

### 6.4 MotionConfig + motion tokens

- **`<MotionConfig reducedMotion="user">` at the app root** (`App.tsx`/`AppShell`) — auto-drops
  transform/layout animation while keeping opacity/color crossfades, reaches imperative Framer
  animations the CSS reset can't. **The single most important motion change.**
- **Motion tokens** in `theme.css` (use these, not ad-hoc `duration-xxx`):
  ```css
  --motion-fast: 120ms;  /* hover/press/focus, toasts, chips */
  --motion-base: 200ms;  /* popover/tooltip/tab-switch/row-expand */
  --motion-slow: 280ms;  /* Sheet/Dialog/drawer enter */
  --motion-ease-standard: cubic-bezier(0.2, 0, 0, 1);   /* enters ease-out, exits ease-in */
  ```
- **Upgrade the reduced-motion block** (`theme.css:272-281`): keep the `*` 0.001ms safety net, but
  (1) re-enable short opacity crossfades on `[role="dialog"]`/`[role="tooltip"]`/popper/toast
  (`transition: opacity 120ms linear`), and (2) exempt functional spinners/LoadingBar via a
  `.motion-essential` class (WCAG 2.3.3 exempts essential motion — a "still working" loader must
  keep moving). Extract ONE SSR-safe `usePrefersReducedMotion()` (replaces the 2 inlined matchMedia
  sites). **Do NOT add animation to recharts just to gate it** (already static). **Never
  reorder-animate a live list while the analyst reads it** — one-shot bg-flash for new rows.

---

## 7. DENSITY (G4)

`DataTable.tsx` already has `density: 'normal' | 'compact'` (compact `px-4 py-2` ≈ 40–44px rows,
header `h-11` = 44px — all in-spec) but it is **not persisted**. **Wire density to `UserPrefsStore`**
under the per-table `table_id` key (`PUT /api/prefs/user/tables/{table_id}`, zero-migration).

- **Default `compact`** for all-day analyst surfaces (Cases, logs, audit); **normal** as the org
  default elsewhere.
- Keep column padding ≥16px horizontal (below that columns visually merge); interactive controls
  ≥24×24 even in compact (WCAG 2.5.8).
- Optional global `data-density` attribute on the shell scaling row/card padding tokens, persisted
  alongside theme via the existing prefs cascade.
- Virtualize the Cases + unified `/api/logs` tables with `@tanstack/react-virtual` (approved,
  scoped) only when result sets grow; prefer server-side pagination first.

---

## 8. RULE CUSTOMIZATION (G6) — the UI contract

Rules editors (detection/correlation/risk/auto-close/tuning) are **config writers** — they write
`Preferences` blocks via **deep-merge `PUT /api/settings`** and NEVER touch `decide()` (#3). Build
them from the §5 primitives (`Field` + `NumberField` + `LabeledSlider` + `SegmentedControl` +
`TagInput` + `ConfirmDialog`), inside `PageContainer variant="fixed"`. Validate client-side with
`zod` (approved) mirroring `config.py` defaults. Any DROP/suppression proposal routes to a **HITL
Proposal**, never a silent close. Keep `webui/src/lib/types.ts` in sync with the backend rule
models (additive + defaulted).

---

## 9. CUSTOM DASHBOARDS (G7)

User-created dashboards render via `PageContainer variant="fluid"`; the drag/resize grid is
**`react-grid-layout` (approved, lazy-loaded, edit-mode only)**. View mode ships zero grid JS.
Widgets are the same §5 primitives + §5.4 charts, colored via the ONE label→token authority (§1.6)
and `--chart-*` for identity-arbitrary series. Layouts persist to `UserPrefsStore`. A drag surface
means the DnD a11y contract (§6.2, 2.5.7) applies — provide non-drag "move" alternatives; add
`@dnd-kit` only when the drag surface actually ships (conditional dep).

---

## 10. SETTINGS DECLUTTER (G3)

`Settings.tsx` (2673 lines) hand-rolls its left rail with raw `<button>` + `useState('section')`
(map §3.9) — the declutter lever (Tabs/Accordion) exists but was never adopted. **Rebuild the
section rail on a vertical-Tabs / Accordion primitive; flatten nested submenus.** Preserve all
routable page ids (settings hosts account/sessions/security/roles/users/audit/admin_sessions as
sub-sections — every id stays deep-linkable). Save via **deep-merge PUT** (partial blocks only).
Split the god-file into per-section components behind the rail.

---

## 11. RUNTIME THEMING / BRANDING (G1 security)

- Keep the `ALLOWED_TOKENS` allow-list + `sanitizeTokenValue` (a security control, #9/#10). New
  branding-writable tokens go through the allow-list + sanitizer; **derived `*-foreground`/`*-text`
  AA tokens are NOT operator-writable** (preserve AA). **Mirror the allow-list + sanitizer
  server-side** in `config.py:_check_theme_tokens` (today accepts any key/value ≤200 chars).
- New defaults are **defaults** branding can override (`--primary`/`--accent2` + the allow-list).
- Consolidate the three branding-apply implementations into `theme-tokens.applyBranding`
  (accent → material → `theme_tokens` last-wins order is contract-tested — preserve it).
- Give `--accent2` a real `:root` default (today unset → monochrome login hero).
- Add a **FOUC-guard inline script** in `index.html` (read `soc.theme` + prefers-color-scheme, set
  `.dark` before paint, reuse `resolveDark` precedence) + a `@media (prefers-color-scheme: dark)`
  CSS fallback for JS-off. Make `setThemeMode` the sole public theme API; surface a failed PUT.

---

## 12. TESTING & GUARDS (G9) — every change must keep these green

- `npm run build` (tsc --noEmit && vite build) clean · `npx vitest run` green · `npm run lint` (0
  `react-hooks/rules-of-hooks` errors) · `pytest -q` unaffected · `engine/case_manager.py`
  byte-identical.
- **NEW CI guards (add this round):**
  1. **Token existence** — every `ALLOWED_TOKENS` entry AND every `palette.ts token()` name exists
     in `theme.css` in BOTH `:root` and `.dark` (closes the four-file drift, map §5.9).
  2. **Contrast gate** — luminance checker fails build on text-on-bg < 4.5:1 / non-text < 3:1 (§6.3).
  3. **No arbitrary text size** — grep fails on new `text-\[<number>` in `.tsx` (§2.6).
  4. **No raw hex** — grep fails on new `#[0-9a-fA-F]{6}` in `.tsx` (45 exist today; route through
     tokens).
  5. **CVD verify** — the `--chart-*` ramp asserted to resolve to `--chart-n`, all 8 present both
     themes; eyeball in a CVD simulator (protan/deuter/tritan) + grayscale before merge.
- Dev-only a11y deps (approved): `jest-axe`/`@axe-core` in Vitest + `eslint-plugin-jsx-a11y`.
- Manual: keyboard-only smoke (sort table / open+run palette / reorder column), reduced-motion ON
  (spinners spin, dialogs fade, charts static), both themes eyeballed on a dense table + CaseDetail.

---

## 13. APPROVED DEP LEDGER (closed — nothing else installs)

From `RESEARCH_SUMMARY.md §0`. Runtime bytes added to the default read-only bundle ≈ 0 (grid/table
deps lazy-load with their pages).

| Dep | Type | For | Verdict |
|---|---|---|---|
| `@fontsource-variable/inter` | dev (WOFF2) | ship declared font | **APPROVE** |
| `@fontsource-jetbrains-mono` | dev (WOFF2) | mono for IDs/logs/numerics | **APPROVE** |
| `@tailwindcss/container-queries` | dev (plugin) | per-slot responsive widths | **APPROVE** |
| `@tanstack/react-virtual` | runtime ~10 KB | virtualize cases/logs tables | **APPROVE (scoped)** |
| `@tanstack/react-table` | runtime ~15 KB | headless engine under DataTable | **APPROVE (deliberate wave)** |
| `react-grid-layout` | runtime, **lazy (edit mode only)** ~18.5 KB | custom-dashboard grid | **APPROVE (the one dashboard dep)** |
| `zod` | runtime ~13 KB | client rule validation mirroring config.py | **APPROVE (Rules)** |
| `react-querybuilder` v8 | runtime, **flag-gated + lazy** | nested AND/OR condition trees | **APPROVE (Rules, gated)** |
| `jest-axe` / `@axe-core`, `eslint-plugin-jsx-a11y` | dev | a11y assertions/lint | **APPROVE** |
| `pySigma` | backend only | Sigma import/export | **APPROVE (Rules)** |
| `@dnd-kit/core` + `@dnd-kit/sortable` | runtime ~10 KB | drag surfaces | **CONDITIONAL — only when a drag surface ships** |

**REJECTED:** Tremor, nivo, ECharts, visx (default), `windy-radix-palette`, `chroma-js`,
`d3-scale-chromatic`, `@elastic/datemath` (drags moment.js), Material-React-Table, AG Grid,
`react-hook-form`, TanStack Query (unapproved), OKLCH + Tailwind-v4 (deferred), swapping the
vendored AlertDialog onto `@radix-ui/react-alert-dialog`.

---

## 14. DO / DON'T CHEAT-SHEET

**DO**
- Derive neutrals from Radix `slate`, primary from Radix `blue`; alias Tier-1 → Tier-2; consume as
  `hsl(var(--x))`.
- Use the `--{t}` fill / `--{t}-foreground` on-color / `--{t}-text` triad — never guess a text color
  on a colored fill.
- Resolve EVERY severity/status/verdict color from the ONE `palette.ts` authority (§1.6); pair it
  with `SEMANTIC_ICON` + a shape (color is never the only channel).
- Use `text-*` scale steps; `tabular-nums` on all changing numbers; prose blocks ≥1.5 line-height.
- Use `PageContainer variant=` (wide/prose/fixed/fluid) and the compact `PageHeader` (dense default).
- `p-4`/`p-6` card padding; sanctioned 8px subset; internal padding ≤ external gap.
- Extract to the shared primitive/utility (`focusRing`, `overlaySurface`, `menuItem`, `Field`,
  `IconButton`, `ConfirmDialog`) and reuse.
- Deep-merge `PUT /api/settings`; keep `types.ts` ⇔ `models.py`; keep all 31 page ids routable.
- `<MotionConfig reducedMotion="user">`; motion tokens (120/200/280ms); ≥24px hit targets;
  allow paste on auth fields.
- Keep `decide()` byte-identical; rule/dashboard editors write config only.

**DON'T**
- Don't invent a new design system, don't migrate to Tailwind v4/OKLCH this round.
- Don't put green in **severity** (`--low` is blue); don't make verdict FP green (it's blue-grey).
- Don't use `--accent` as a data/brand color (it's the neutral hover/selected surface).
- Don't rely on a hairline `--border` alone to convey a control/focus edge (use `--border-strong`/
  `--input` ≥3:1).
- Don't hardcode hex, don't use arbitrary `text-[..]` sizes, don't `px-5`/off-grid spacing.
- Don't `dangerouslySetInnerHTML`/`{{{raw}}}`/CSS-inject any log-derived value (#9); chart labels
  are SVG `<text>` only.
- Don't `window.confirm` (use `ConfirmDialog`); don't leave a destructive AlertDialog dismissible on
  overlay/Escape.
- Don't rename primitive exports or Badge/Button variant names (public contracts) — refactor
  internals only.
- Don't add a runtime dep outside the §13 ledger; don't widen `ALLOWED_TOKENS`/`sanitizeTokenValue`
  without re-vetting injection safety.
- Don't animate recharts, don't reorder-animate a live list, don't full-doc-replace settings.
- Don't claim "AA" — measure it (the last comments that lied are being deleted).

---

*Round 5 canonical design standard. All contrast ratios measured 2026-07-01 via WCAG
relative-luminance over the exact HSL triples. Cites: DESIGN_SYSTEM_MAP.md,
RESEARCH_COLOR_TYPE_SPACING.md, RESEARCH_DASHBOARD_PATTERNS.md, RESEARCH_A11Y_MOTION.md,
RESEARCH_SUMMARY.md, and the live webui source.*
