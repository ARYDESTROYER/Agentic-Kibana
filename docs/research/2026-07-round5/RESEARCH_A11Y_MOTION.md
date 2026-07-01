# Round 5 · P2 External Research — Accessibility (WCAG 2.2 AA) + Motion

> **Scope:** A concrete, decision-oriented a11y + motion spec for the **TLSOC Agentic
> Triage Suite** webui — a data-dense operational SOC console (Vite + React + TS +
> Tailwind + shadcn/Radix, framer-motion ^11, recharts ^2.15, cmdk ^1.1,
> tailwindcss-animate ^1). **No new heavy npm deps** unless justified inline.
>
> **Audience:** engineers implementing Round 5. Everything here is written as
> "do X, in file Y, with value Z."
>
> **How to read this:** §1 is the WCAG 2.2 AA checklist (the contract).
> §2 is the keyboard/SR spec for our three hard widgets (tables, palette, drag).
> §3 is the motion spec. §4 is the concrete implementation plan + DoD. §5 is
> tooling + citations.

---

## 0. Verified starting position (audited this repo, do not re-discover)

The generic research assumed several gaps we have **already closed**. Ground-truth
before you plan work:

| Claim in raw research | Reality in this repo | Action |
|---|---|---|
| "wire `isAnimationActive={!reduced}` on recharts" | **All** recharts series already ship `isAnimationActive={false}` (charts.tsx L148/240/350/393/446; charts-soc.tsx L311/321/376/481) | **No-op** — charts already render statically for everyone. Do NOT add animation just to gate it. The real chart gap is **non-color encoding** (§1.C). |
| "never ship `outline:none` without a ring" | Every shadcn primitive + DataTable already uses `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2` (button/input/tabs/dialog/sheet/switch/checkbox/slider/radio/accordion + DataTable rows L384) | **Verify contrast of `--ring` in both themes** (§1.A); otherwise keep. |
| "make DataTable emit real table semantics + aria-labels" | DataTable already renders `<Table aria-label>`, `aria-label="Select all rows"`, `aria-label={`Select row ${id}`}`, `aria-label="First page"` etc. (DataTable.tsx) | Semantics OK. Remaining gaps: **`<th scope>`, `aria-sort`, sort live-region** (§2.A). |
| "add a global reduced-motion reset" | Present in theme.css **L272–281** (`0.001ms`, iteration-count 1, scroll-behavior auto) — correct 0.001ms, correct scope | **Upgrade** from "kill everything" to "crossfade-preserving" + exempt spinners (§3.B). |
| "consolidate duplicated matchMedia" | Duplicated in ChatPanel.tsx L862 + SettingsGrid.tsx L214 (both reduced-motion); theme.tsx L191 + theme-tokens.ts L301 (color-scheme) | Extract **`usePrefersReducedMotion()`** hook (§3.E). |
| "cap categorical series ≤6, colorblind-safe" | `CATEGORICAL` in palette.ts has **8** entries, mapped to semantic tokens (primary/info/success/high/medium/critical/low/accent), never CVD-verified | **Trim to ≤6 + run a CVD sim** (§1.C). |

**Net:** our focus-ring and table-semantics story is genuinely good. The load-bearing
Round-5 work is: **(a) non-color redundancy on verdict/status/risk/severity**,
**(b) the 3 NEW WCAG 2.2 criteria (2.4.11 focus-not-obscured, 2.5.8 target size,
2.5.7 dragging, 3.3.8 auth)**, **(c) chart non-color encoding + text alternatives**,
**(d) sort announcements + a shared live-region**, and **(e) a crossfade-preserving,
spinner-exempt motion model.**

---

## 1. WCAG 2.2 AA CHECKLIST (the contract)

WCAG 2.2 AA is a strict superset of 2.1 AA. Below, ⚠️ = a repo-specific risk we must
actively fix; ✅ = largely satisfied, verify only.

### 1.A — Contrast (1.4.3 text / 1.4.11 non-text)

- [ ] **Text 4.5:1** (normal) / **3:1** (large = **≥24px normal or ≥18.66px/19px bold**).
      Audit `theme.css` light **and** dark token pairs. SOC offenders to check by name:
      `--muted-foreground` (used for axis/tick/legend labels — these are **text**,
      need **4.5:1**, the single most common failure), placeholder text, disabled-but-
      readable states, small badge text.
- [ ] **Non-text 3:1** (1.4.11): the focus **`--ring`** color, input/card/`--border`,
      switch tracks, and **every chart mark** (bar fill, line stroke, point, threshold
      rule) vs. background **and vs. neighboring marks** in stacked/multi-series charts.
- [ ] **Gate it in CI.** Add a ~20-line relative-luminance contrast function over
      `palette.ts` + the resolved theme tokens; fail the build if any declared
      text-on-bg pair < 4.5:1 or any chart-series / focus-ring pair < 3:1. Zero prod
      dep (algorithm is public; see §5). This is what stops a token edit from silently
      regressing contrast.

### 1.B — Use of Color / non-color signaling (1.4.1) — ⚠️ HIGHEST SOC RISK

Meaning must **never** be color-only. Our four semantic axes (`palette.ts SEMANTIC`)
all currently map to a hue; each needs a redundant non-color cue:

- [ ] **Verdict** (true_positive / false_positive / benign / needs_human / suspicious /
      duplicate / undetermined): every badge carries a **text label** (we have this) +
      a **distinct icon** per class. Standardize the icon set in `badges.tsx`.
- [ ] **Status** (new / investigating / escalated / on_hold / resolved / closed):
      text + icon or shape; do not rely on the status color alone in dense tables.
- [ ] **Severity** (critical / high / medium / low / info): text label + icon; if a
      severity is shown as a bare colored dot anywhere, add a shape (●■▲) or letter.
- [ ] **RiskGauge**: must show a **numeric value + a text band label** ("High"), not
      only a colored arc. (Called out explicitly in research.)
- [ ] Audit every consumer of `semanticColor()` / `palette` for a spot where hue is the
      **only** carrier of meaning (colored borders, colored dots, colored gauge arcs).

**Standardize once:** a `SEMANTIC_ICON: Record<key, LucideIcon>` beside `SEMANTIC` in
`palette.ts`, consumed by `badges.tsx`, RiskGauge, chart legends, and the MITRE heatmap.
One source of truth for "this class = this color **and** this icon."

### 1.C — Charts (charts.tsx / charts-soc.tsx) — encode with MORE than hue

Because charts don't animate (already `isAnimationActive={false}`), the work here is
comprehension, not motion:

- [ ] **Trim `CATEGORICAL` to ≤6** and verify it against **protanopia/deuteranopia/
      tritanopia** (Chrome DevTools › Rendering › *Emulate vision deficiencies*, or
      Coblis). Current 8-color adjacency is not CVD-verified. Prefer a Wong-8 /
      ColorBrewer qualitative ordering (paste hex or re-order token refs; no dep).
- [ ] **Sequential / heatmap** data (MITRE coverage heatmap, burn-down density): use a
      **Viridis or Cividis** ramp (strong monotonic lightness → readable in grayscale &
      all CVD types), not a hue-only red→green ramp.
- [ ] **Non-hue channel per series** (dep-free SVG): per-series marker **shape**
      (circle/square/triangle), line **`strokeDasharray`** (solid/dashed/dotted), and/or
      SVG `<pattern>` fills on bars/areas. Add the same distinguisher to the **legend**
      swatch so users don't cross-reference hue.
- [ ] **Direct data labels** where density allows, so the legend is a convenience not a
      requirement.
- [ ] **Accessible name + summary** per chart: `role="img"` + `aria-label` (or a
      visually-hidden `<figcaption>`) stating *type + what it shows + the key trend*
      (e.g. "Bar chart, cases by verdict, last 7 days; true-positives up 18%").
- [ ] **Text/data alternative**: expose the underlying series as a table or CSV export.
      We already have case export — **extend the same pattern to charts** (a "View as
      table" / "Download CSV" affordance).
- [ ] **Never put load-bearing info only in hover tooltips** — keyboard/SR/touch users
      can't hover. Ensure the same values are reachable via focus or present on-canvas.

### 1.D — Focus family

- [ ] **2.4.7 Focus Visible (AA)** — ✅ present everywhere; just **verify `--ring` is
      ≥3:1** vs. background in **both** themes (the dark theme is the usual place a ring
      disappears). Test the whole console with Tab / Shift+Tab / arrows, mouse untouched.
- [ ] **2.4.11 Focus Not Obscured (NEW in 2.2, AA)** — ⚠️ real risk here. Our sticky
      `PageHeader` / AppShell top bar, **sticky table headers**, and the **sticky
      Settings save-bar** can cover a focused control as you tab through a long list/form.
      Fix: add `scroll-margin-top: <sticky-header-height>` on focusable rows/inputs (or
      `scroll-padding-top` on the scroll container) so a focused element scrolls into a
      clear area. Also confirm Cmd-K palette & dialogs don't hide the trigger behind the
      overlay while focused.
- [ ] **2.4.13 Focus Appearance (AAA — optional cheap win)**: our `ring-2` +
      `ring-offset-2` already approaches the AAA "thicker, 3:1 focused-vs-unfocused"
      bar. Note it, don't chase it.

### 1.E — Target Size (2.5.8, NEW in 2.2, AA) — ⚠️ dense-console classic

Interactive targets **≥24×24 CSS px**, OR ≥24px center-to-center spacing. Audit our
smallest hit areas:

- [ ] Table row action icons (assign / tag / expand), bulk-select checkboxes,
      pagination arrows, chart legend toggles, close **X** buttons, toolbar icon buttons.
- [ ] Rule: the **glyph** may stay 16px, but the **hit target** must be ≥24px — wrap
      icon-only buttons in `min-h-6 min-w-6` (24px) with the icon centered, or space them
      ≥24px apart. Add a shared `IconButton` (or a Tailwind class recipe) so this can't
      regress per-component.

### 1.F — Dragging Movements (2.5.7, NEW in 2.2, AA)

- [ ] Any drag-to-reorder (columns via saved-views/column-state, draggable dashboard
      tiles, drag-to-assign) needs a **non-drag alternative**: up/down "move" buttons or
      a "move to…" menu. Our **per-user column/saved-views prefs** is the natural home
      for reorder buttons. See §2.C for the full keyboard-drag spec.

### 1.G — Accessible Authentication (3.3.8, NEW in 2.2, AA) — login flow

- [ ] **Allow paste + autofill** on username, password, **TOTP code**, and
      **recovery-code** fields (do not block paste). TOTP itself is compliant (a device
      does the cognitive work) *as long as the field accepts paste/autofill*.
- [ ] Correct `autocomplete` tokens: `username`, `current-password`, `new-password`,
      **`one-time-code`** (MFA), and `autocomplete="off"` is fine for recovery-code but
      **still allow paste**. SSO/OIDC is inherently compliant.

### 1.H — Reflow + Text Spacing (1.4.10 / 1.4.12, carried from 2.1)

- [ ] **Reflow (1.4.10):** works at 320 CSS px / 400% zoom with no loss. Wide tables:
      scope horizontal scroll to the **table container only** (`overflow-x-auto` on the
      wrapper), never the page; consider a stacked/responsive fallback for the densest
      tables.
- [ ] **Text spacing (1.4.12):** must survive user overrides (line-height 1.5, paragraph
      spacing 2×, letter-spacing 0.12em, word-spacing 0.16em) without clipping. Use
      `min-height` + rem/em on text containers — **no fixed-px heights on text**.

### 1.I — Programmatic structure (1.3.1) + live announcements (4.1.3)

- [ ] Radix gives correct roles for dialog/tabs/menu/combobox. Keep DataTable as real
      `<table>`; **add `<th scope="col">`** and a `<caption>` (or keep the `aria-label`).
- [ ] Every icon-only button has an accessible name (`aria-label`) — we mostly do; sweep
      for stragglers.
- [ ] **One app-level `aria-live="polite"` region** (§2.D) announces state changes
      (case saved, verdict rendered, "12 cases acknowledged", sort changed, DnD moves).

---

## 2. KEYBOARD + SCREEN-READER SPEC (our three hard widgets)

Principle for all three: **adopt a battle-tested headless model, don't hand-roll ARIA.**

### 2.A — Tables / grids (DataTable.tsx)

**Decision: keep the native `<table>` for read/scan lists; only escalate to
`role="grid"` where cells are interactive/inline-editable.** Native semantics give SR
table navigation for free and are the most robust. Graduate to the WAI-ARIA **Grid
pattern** only for editable cells (e.g. inline AutoClosePolicy thresholds, inline
tag/assignee edit).

- [ ] Add **`<th scope="col">`** to every column header (and `scope="row"` if a row has a
      header cell). Free SR association, minimal change.
- [ ] **Sortable columns:** put a `<button>` inside the `<th>`; set **`aria-sort`** on
      the `<th>` (`ascending` | `descending`). **OMIT `aria-sort` entirely when
      unsorted — never `aria-sort="none"`**, and only one header at a time. The visual
      sort arrow is an **SVG shape change** with `aria-hidden="true"` (not color-only —
      1.4.1).
- [ ] **Sort announcement (required):** `aria-sort` is **silently ignored** by
      VoiceOver-macOS, TalkBack-Chrome, and TalkBack-Firefox. So on sort, push
      `"Cases sorted by risk, descending"` into the shared polite live region (§2.D) and
      **clear it after ~1s** so re-sorting the same column re-announces.
- [ ] If/when a grid is needed: one tab-stop in, **roving `tabindex`** (preferred — the
      browser auto-scrolls the focused cell into view) or `aria-activedescendant`; arrow
      keys (no wrap), Home/End (row), Ctrl+Home/End (corners), PageUp/Down (rows),
      **F2/Enter** to edit, **Escape** back to nav.

### 2.B — Command palette (CommandPalette.tsx / cmdk)

cmdk already implements the ARIA **combobox + listbox** pattern (input `role=combobox` +
`aria-expanded` + `aria-controls` + `aria-activedescendant`; results `role=listbox` /
`role=option`; DOM focus **stays in the input**). Our job is to verify + wrap:

- [ ] Confirm the rendered attributes: active option has `aria-selected="true"` and its
      `id` is mirrored into the input's `aria-activedescendant`.
- [ ] **Do NOT add an `aria-live` region to the results list** — correct
      `aria-expanded` + `aria-activedescendant` announce for free; a live region
      double-announces every keystroke.
- [ ] Mount cmdk inside a **Radix `Dialog` (`aria-modal` + focus trap + focus-restore)**
      so background isn't reachable and **focus returns to the trigger on close** (a
      commonly-missed step). Since focus never leaves the input, **scroll the active
      option into view in JS** (aria-activedescendant does not auto-scroll).
- [ ] Keyboard contract to enforce: Cmd/Ctrl+K opens with input focused → typing filters
      → Up/Down move active option → Home/End first/last → Enter runs → **Escape closes
      + returns focus**.

### 2.C — Draggable surfaces (if/when we add reorderable columns, kanban case boards, or draggable tiles)

There is **no official ARIA APG pattern for DnD** — you must supply the keyboard model +
polite announcements. **Recommendation: `@dnd-kit` (`@dnd-kit/core` + `@dnd-kit/sortable`).**

- **Why dnd-kit over React Aria DnD here:** ~10kb core, MIT, React-first, closest to our
  stack, ships a keyboard sensor (Space/Enter grab, arrows move, Escape cancel) + default
  ARIA + off-screen instructions + **customizable announcements**. React Aria's
  Tab-between-valid-drop-targets model is *more robust for very large boards* (it hides
  non-targets from AT), so **scope React Aria to a single hard surface** (e.g. drag a case
  across many campaigns) rather than adopting it app-wide. **New dep — justified** only
  when we actually ship a drag surface; do not add speculatively.
- [ ] **Always override dnd-kit's default announcements** (`onDragStart/Over/End/Cancel`)
      with domain, ordinal-position text: *"Picked up case CASE-1042. Use arrow keys to
      move. Now position 2 of 8 in the Escalated column."* Use ordinals + named
      source/target column, never raw indices. dnd-kit renders these into its own polite
      region — **don't add a second one.**
- [ ] Pull announcement + `screenReaderInstructions` strings from our **per-user
      terminology layer** so "case"/"campaign"/"alert" language stays consistent for SR
      users; note `aria-roledescription` does **not** auto-translate.
- [ ] Provide the **non-drag alternative** (2.5.7): reorder up/down buttons in the
      saved-views / column-state prefs UI.

### 2.D — Shared live-announcer (build once, use everywhere)

- [ ] Build one `useLiveAnnouncer()` hook + a single `<VisuallyHidden aria-live="polite">`
      node at the app root. Feed it from: **sort changes** (§2.A), **bulk-action
      outcomes** ("12 cases acknowledged"), **DnD moves** (if not using dnd-kit's own),
      case-saved / verdict-rendered, and any async that changes what the analyst is
      looking at. Default `aria-live="off"`, flip to `polite` on action, clear text after
      ~1s. This one utility is the announcement half of every widget above.

### 2.E — Testing DoD for the three widgets

- [ ] Manual pass with **NVDA + Firefox** and **VoiceOver + Safari** for each widget
      (support is genuinely uneven — "correct ARIA" ≠ "it works").
- [ ] Add **jest-axe / @axe-core** to the existing Vitest suite for static ARIA
      regressions (dev-only dep).
- [ ] Keyboard-only smoke test (sort a table, open+run a palette command, reorder a
      column) with **zero mouse**.

---

## 3. MOTION SPEC (functional, fast, quiet)

**Philosophy for this product:** motion exists to explain cause/effect, confirm actions,
and preserve context — **never to entertain**. An analyst sees these transitions dozens
of times per shift; anything slow or decorative is a tax. Peers to emulate:
Linear/Stripe/GitHub Primer (fast + quiet), Grafana/Kibana (don't over-animate live data).

### 3.A — Duration + easing tokens (add to theme.css)

Standardize a small scale; use it instead of ad-hoc `duration-xxx`:

```css
:root {
  --motion-fast: 120ms;   /* hover / press / focus, toasts, badges, chips */
  --motion-base: 200ms;   /* popover / hover-card / tooltip, tab switch, row expand */
  --motion-slow: 280ms;   /* Sheet / Dialog enter, drawer */
  --motion-ease-standard: cubic-bezier(0.2, 0, 0, 1); /* Material "standard" */
  /* enters: ease-out; exits: ease-in */
}
```

Budget: **100–200ms** UI micro-interactions, **200–300ms** larger surfaces
(sheets/dialogs). ease-out on enter, ease-in on exit (or the single standard curve).

### 3.B — Upgrade the global reduced-motion reset (theme.css L272–281)

Keep the 0.001ms **`*` reset as the safety net** (0.001ms not 0 so `transitionend`/
`animationend` still fire — required by Radix exit animations & focus-return logic). But
**"reduced" ≠ "none"**: opacity/color crossfades are safe and should be **kept** so the
UI still communicates state. Two surgical additions inside the reduced-motion block:

1. **Re-enable short opacity crossfades** on state surfaces so reduced-motion users get a
   gentle fade instead of a hard cut:
   ```css
   @media (prefers-reduced-motion: reduce) {
     /* keep the * nuke... */
     [data-reduced-crossfade],
     [role="dialog"], [role="tooltip"], [data-radix-popper-content-wrapper], .toast {
       transition: opacity 120ms linear !important;
     }
   }
   ```
2. **Exempt functional indeterminate spinners / LoadingBar** — WCAG **2.3.3 exempts
   motion essential to conveying information**; a "still working" loader must keep moving.
   Give it a `.motion-essential` class the reset skips (re-set its
   `animation-duration`/`iteration-count` inside the block):
   ```css
   @media (prefers-reduced-motion: reduce) {
     .motion-essential { animation-duration: revert !important;
                         animation-iteration-count: infinite !important; }
   }
   ```

### 3.C — Framer Motion: `<MotionConfig reducedMotion="user">` at the app root

Add to `App.tsx` / `AppShell`. In `"user"` mode every motion component **auto-drops
transform + layout animations while keeping opacity/backgroundColor** — exactly the
"crossfade-preserving" behavior — with **zero per-component branching**, and it reaches
**imperative/JS Framer animations the CSS reset cannot touch** (the CSS reset only
governs CSS animations/transitions). This is the single most important motion change.

### 3.D — recharts: no action (already static)

All series are `isAnimationActive={false}`. **Do not add animation to gate it.** If a
future chart opts into animation, gate that one prop with the §3.E hook —
`isAnimationActive={!prefersReducedMotion}`.

### 3.E — Consolidate the reduced-motion hook

Extract the duplicated `matchMedia('(prefers-reduced-motion: reduce)')` (ChatPanel L862,
SettingsGrid L214) into one SSR-safe `usePrefersReducedMotion()` (webui `src/lib` or
`src/soc/hooks`). Use the Josh Comeau pattern (`useState` + `useEffect` + `matchMedia`
`addEventListener('change')`) so it stays reactive when the OS setting is toggled
**mid-session**, and **default toward reduced motion on first render** to avoid a
hydration-flash of animation on reduced-motion machines. Feed it to any future Framer
branch, chart-animation opt-ins, and smooth-scroll/auto-scroll behaviors.

### 3.F — Which micro-interactions to keep vs. kill

**Keep (functional):**
- Press/hover state on interactive rows & buttons — `var(--motion-fast)` (120ms).
- Directional **Sheet/Dialog** entering from the trigger side (analyst tracks where the
  detail panel came from) — `var(--motion-slow)`.
- Toast / notification-bell = crossfade + tiny `translateY ≤8px` (never a fly-across).
- Skeleton → content fade-in (already have it, reduced-motion-safe).
- Cases DataTable row insert/remove = quick height/opacity, **disabled under reduced
  motion**.

**Kill / avoid (decorative or vestibular):** parallax, looping ambient animation, **KPI
count-up tickers** (distracting on a live-updating dashboard), auto-carousels, and any
**scale on large surfaces** (vestibular trigger).

### 3.G — Operational-tool caveat: don't over-animate LIVE data

New cases/alerts arrive continuously. **Do not animate every insert** — it drags the eye
off the alert being read. Prefer a **one-shot background-color flash that fades**
(safe under reduced motion) over a motion-based entrance for real-time rows, and **never
reorder-animate a list while the analyst is reading it.** Keep the existing gated
smooth-scroll (ChatPanel/SettingsGrid) — a smooth "jump to latest" on a long transcript
is a vestibular trigger; don't regress that gate.

### 3.H — Verify

- [ ] Manual pass with OS **Reduce Motion ON** (macOS: System Settings › Accessibility ›
      Motion): spinners still spin, toasts still crossfade, charts render statically,
      dialogs fade (no snap).
- [ ] Chrome DevTools › Rendering › **Emulate CSS `prefers-reduced-motion`**.
- [ ] No new dep — all of the above uses existing framer-motion + tailwindcss-animate +
      Tailwind `motion-reduce:` / `motion-safe:` variants.

---

## 4. IMPLEMENTATION PLAN (Round-5 concrete, ordered by ROI)

**Tier 1 — highest impact, low cost, no new prod deps:**
1. **Non-color redundancy (1.4.1):** add `SEMANTIC_ICON` map to `palette.ts`; wire into
   `badges.tsx`, RiskGauge (numeric + band label), chart legends, MITRE heatmap. *(§1.B)*
2. **Contrast CI gate:** ~20-line luminance checker over `palette.ts`/theme tokens; fail
   build < 4.5:1 text / < 3:1 non-text. *(§1.A)*
3. **`<MotionConfig reducedMotion="user">`** at app root + upgrade the theme.css
   reduced-motion block (crossfade-preserving + `.motion-essential` spinner exempt).
   *(§3.B/§3.C)*
4. **`usePrefersReducedMotion()`** hook; replace the two inlined matchMedia sites. *(§3.E)*
5. **Motion tokens** in theme.css; migrate ad-hoc durations opportunistically. *(§3.A)*

**Tier 2 — WCAG 2.2 new criteria + table SR:**
6. **Target size (2.5.8):** shared `IconButton` recipe (`min-h-6 min-w-6`); sweep table
   row actions, pagination, close-X, chart toggles. *(§1.E)*
7. **Focus not obscured (2.4.11):** `scroll-margin-top`/`scroll-padding-top` = sticky
   header height on focusable rows/inputs; audit sticky save-bar + palette. *(§1.D)*
8. **Sort a11y:** `<th scope>`, `aria-sort` (omit when unsorted, SVG arrow
   `aria-hidden`), **shared `useLiveAnnouncer()`** + sort announcement. *(§2.A/§2.D)*
9. **Chart non-color encoding:** trim `CATEGORICAL` ≤6 + CVD-verify; Viridis/Cividis for
   heatmaps; per-series shape/dash; `role=img`+`aria-label`; "view as table" export.
   *(§1.C)*
10. **Accessible auth (3.3.8):** allow paste + correct `autocomplete` on login/MFA/
    recovery fields. *(§1.G)*

**Tier 3 — conditional / larger:**
11. **Reflow/text-spacing sweep (1.4.10/1.4.12):** table-container-scoped overflow;
    `min-height`+rem on text containers. *(§1.H)*
12. **DnD a11y (only if we ship drag):** `@dnd-kit` + customized announcements +
    non-drag reorder buttons. React Aria only for one very large board. *(§2.C/§1.F)*
13. **Test harness:** jest-axe/@axe-core + eslint-plugin-jsx-a11y (dev-only);
    keyboard-only smoke test; NVDA+FF / VoiceOver+Safari manual pass. *(§2.E/§5)*

**Definition of Done:** contrast CI green; `npm run build` clean; jest-axe specs green;
keyboard-only smoke test passes for table-sort / palette / (drag if present); manual
reduced-motion + CVD emulation pass; no color-only meaning on verdict/status/risk/
severity; all new interactive targets ≥24px.

### Dependency decisions (respecting "no new heavy deps")
| Dep | Verdict | Justification |
|---|---|---|
| `@axe-core/react` / `jest-axe` | **Add (dev-only)** | Catches ~30–50% of a11y regressions automatically in the existing Vitest/CI; **zero prod bundle**. |
| `eslint-plugin-jsx-a11y` | **Add (dev-only)** | Static lint for missing label/alt/aria; zero runtime. |
| `@dnd-kit/core` + `@dnd-kit/sortable` | **Add only when a drag surface ships** | ~10kb, MIT, React-first; no dep exists today, don't add speculatively. |
| React Aria DnD | **Only for one very large board** | Heavier + different mental model; scope narrowly. |
| Contrast checker | **In-repo function, no dep** | Relative-luminance math is ~20 lines. |
| Colorblind-safe palettes (Wong/ColorBrewer/Viridis) | **Hex values only, no dep** | Paste into `palette.ts`. |
| SVG `<pattern>` / `strokeDasharray` / marker shapes | **No dep** | Native SVG, works with our hand-rolled + recharts charts. |

---

## 5. Tooling + best-source citations

**Dev tooling (all free / dev-only):** axe-core + @axe-core/react (de-facto a11y engine;
catches contrast/roles/names — not color-meaning/focus-obscured/target-size intent);
eslint-plugin-jsx-a11y (static JSX lint); WebAIM Contrast Checker (manual) or in-repo
luminance gate; Chrome DevTools *Emulate vision deficiencies* + *Emulate
prefers-reduced-motion*; Coblis / Color Oracle (CVD sim). **Automated scanners catch
~⅓–½; keyboard-only + NVDA/VoiceOver spot checks are mandatory.**

**Reference design systems:** GOV.UK (exemplary high-contrast focus + non-color status
tags), USWDS (documented contrast/target-size/icon+text status), **IBM Carbon**
(explicit accessible data-viz palettes + non-color encoding — directly analogous),
Datawrapper (built-in CVD check + direct labeling + patterns), Adobe Spectrum / Atlassian
(status always icon+label + CVD-safe chart palettes), Material 3 (motion duration/easing
scale), Radix/shadcn (our primitive layer), Apple HIG (crossfade-as-reduced-motion
fallback).

**Authoritative sources (numbers come from these, not blog paraphrases):**
- WCAG 2.2 spec — https://www.w3.org/TR/WCAG22/
- New in WCAG 2.2 — https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/
- Understanding Focus Appearance — https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance.html
- Understanding Animation from Interactions (2.3.3) — https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html
- WCAG2 checklists — https://webaim.org/standards/wcag/WCAG2Checklist.pdf · https://usability.yale.edu/web-accessibility/articles/wcag2-checklist · https://www.levelaccess.com/blog/wcag-2-2-aa-summary-and-checklist-for-website-owners/
- Charts + WCAG 2.2 AA — https://wsu.edu/digital-accessibility/event/graphs-charts-meeting-wcag-2-2-level-aa-requirements/ · https://it.wisc.edu/learn/make-it-accessible/accessible-data-visualizations/
- Accessible data-viz palettes — https://medium.com/carbondesign/color-palettes-and-accessibility-features-for-data-visualization-7869f4874fca · https://www.getgalaxy.io/learn/glossary/color-palettes-for-accessible-data-visualization
- **APG Grid pattern** — https://www.w3.org/WAI/ARIA/apg/patterns/grid/ · examples: https://www.w3.org/WAI/ARIA/apg/patterns/grid/examples/data-grids/ · keyboard interface: https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/
- **APG Combobox** (Cmd-K) — https://www.w3.org/WAI/ARIA/apg/patterns/combobox/examples/combobox-select-only/ · https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/combobox_role
- **Sortable columns + aria-sort** (Adrian Roselli) — https://adrianroselli.com/2021/04/sortable-table-columns.html · https://adrianroselli.com/2020/09/sortable-table-column-mad-libs.html
- **dnd-kit a11y** — https://dndkit.com/guides/accessibility · https://github.com/clauderic/dnd-kit
- **React Aria DnD** — https://react-aria.adobe.com/blog/drag-and-drop · https://react-spectrum.adobe.com/react-aria/dnd.html
- **cmdk** — https://github.com/pacocoursey/cmdk
- **prefers-reduced-motion** — https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion · https://css-tricks.com/nuking-motion-with-prefers-reduced-motion/ · https://www.joshwcomeau.com/react/prefers-reduced-motion/
- **Framer Motion a11y** — https://motion.dev/docs/react-accessibility · https://motion.dev/docs/react-use-reduced-motion · https://motion.dev/docs/react-motion-config
- Tailwind motion variants — https://tailwindcss.com/docs/animation · https://www.epicweb.dev/tips/motion-safe-and-motion-reduce-modifiers
- Material 3 motion — https://m3.material.io/styles/motion/easing-and-duration

---

*Round 5 · P2 external research synthesis. Ground-truthed against the repo
(theme.css, palette.ts, charts.tsx, DataTable.tsx, ChatPanel.tsx, SettingsGrid.tsx,
package.json) on 2026-07-01.*
