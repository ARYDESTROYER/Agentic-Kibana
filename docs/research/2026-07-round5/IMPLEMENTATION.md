# Round 5 — IMPLEMENTATION PLAN (orchestrator-executable, contention-aware waves)

> **Status:** AUTHORITATIVE build plan · **Branch:** `Testing` · **Date:** 2026-07-01
>
> This is the sequenced, parallelization-aware build plan an orchestrator drives with
> many Opus coding agents. It turns `PROPOSAL.md` + `DESIGN_STANDARD.md` (the canonical
> spec agents code against) + the `understand/` maps + `RESEARCH_*.md` into ORDERED WAVES
> with **exact files, contracts, acceptance tests, test-migration steps, and
> serialize-vs-parallel markers.**
>
> **How to read this doc:**
> - Each wave has TASKS. Each task lists: **FILES** (exact paths), **CONTRACT** (new
>   endpoints/stores/types/components + props), **ACCEPTANCE** (pytest/vitest/tsc/lint to
>   add/keep green), **BREAKS + MIGRATE** (which tests break, how — `data-testid` first),
>   **DEPENDS ON** (earlier tasks), and **[SERIALIZE]** / **[PARALLEL-SAFE]**.
> - **[SERIALIZE]** = touches a HIGH-CONTENTION shared root file; two agents editing it
>   collide. The orchestrator runs these one at a time, in the stated order, on the stated file.
> - **[PARALLEL-SAFE]** = disjoint file set; fan out freely.
>
> **Verified ground truth (2026-07-01, live repo):** `theme.css` 298 LOC · `palette.ts`
> 107 · `tailwind.config.js` · `types.ts` 2047 · `api.ts` 797 · `nav.ts` 374 · `App.tsx`
> 277 · `AppShell.tsx` 616 · `Settings.tsx` 2673 · `CaseDetail.tsx` 4210 · `KpiTile.tsx`
> 131 · `PageHeader.tsx` 67 · `HeroPanel.tsx` 86 · `router.tsx` 92 · `theme-tokens.ts` 400
> · `layouts.tsx` 138 · `settings-dirty.ts` 177. Backend: `settings_schema.py` 219 ·
> `routes.py` 4751 · `routes_tuning.py` 361 · `stores/user_prefs.py` 293 · `stores/tuning.py`
> 243 · `stores/inbox.py` 366 · `models.py` 1319 · `config.py` 2177 · `case_manager.decide`
> at `case_manager.py:59` reads `self._prefs.auto_close` (line ~78). 16 `*.api.ts` modules.
> 45 webui test files (target ≥273 specs), 107 backend test files (target ≥1461 pytest).
> Feature routers auto-mounted in `main.py:83-99` under `require_auth`.

---

## 0. The bright-line guards every wave/PR/codemod holds (repeat before each commit)

| Guard | Enforcement in this plan |
|---|---|
| **#3 `decide()` BYTE-IDENTICAL** | CI diff on `backend/app/engine/case_manager.py`. NO wave edits it. G6 auto-close writes `prefs.auto_close` (the field `decide()` already reads at `case_manager.py:78`). Preview uses a NEW read-only wrapper over the pure `decide()` — never re-implements it. |
| **#6 one ledger write / LLM call** | No preview/what-if/dashboard/widget path calls the LLM. `POST /api/triage/preview-decision` asserts zero `UsageDoc` writes. |
| **#9 untrusted → plain** | Every new widget title/label, rule name, rule field value, dashboard name, saved-view name renders plain text / SVG `<text>` / `<CodeBlock>`. NO `dangerouslySetInnerHTML`, NO `{{{raw}}}`, NO CSS-injected user value. Server + client allowlist-validate dashboard/widget names. |
| **#2 append-only audit** | Every rule create/edit/enable/disable/rollback + auto-close change writes to `tlsoc-agent-audit-*`. New lifecycle events extend; never mutate history. |
| **#10 secrets = booleans** | New `SecretField` primitive shows `configured ✓`/`not set`. Rule model-overrides never echo a key. |
| **`PUT /api/settings` deep-MERGE** | Verified `put_settings` does `_deep_update(model_dump, body)` then re-validates + force-preserves `demo`. Every new Settings section sends ONLY its changed keys. Round-trip test `test_settings_roundtrip.py` extended to prove no sibling block is wiped by any new section. |
| **Deep-link back-compat, all 31 page ids** | `PAGE_IDS`/`nav.ts:53-84` + `#/settings?s=<id>` + `#/cost`/`#/investigate` `NavOpts` + old standalone routes (`#/users`, `#/security`) resolve — relabel + redirect, never delete a route id. Redirect test. Anchor ids (`detection-correlation`, `advanced-suppression`, `tuning-policy`) preserved. |
| **`types.ts` ⇔ `models.py`** | Every backend model change is hand-mirrored in `lib/types.ts` in the SAME PR (no response codegen until `response_model=` lands in Wave F). Additive + defaulted. |
| **Dep ledger closed (DESIGN_STANDARD §13)** | No runtime dep outside the approved ledger. Lazy-load RGL / react-querybuilder / CodeMirror off the hot read path. |

**Per-wave VERIFY step (run before every commit in that wave):**
```
cd backend && python -m pytest -q                 # ≥1461, rising with net-new G6/G7/bug tests
cd webui && npm run build                          # tsc --noEmit && vite build — clean
cd webui && npx vitest run                         # ≥273, re-snapshot light+dark after token changes
cd webui && npm run lint                           # 0 react-hooks/rules-of-hooks errors
git diff --exit-code backend/app/engine/case_manager.py   # #3 guard — must be empty
```

---

## HIGH-CONTENTION ROOT FILES (the collision map — memorize before dispatching)

These files are edited by MANY tasks. **Never assign two concurrent agents to the same
file in the same wave.** Wave 0 does the foundational edits SERIALLY; later waves append.

| Root file | Waves that touch it | Serialization rule |
|---|---|---|
| `webui/src/styles/theme.css` | W0-A (tokens/fonts/motion), W0-D (header/density tokens) | One agent owns it per wave; W0-A before W0-D. |
| `webui/src/soc/components/palette.ts` | W0-A (3-axis map + chart ramps + SEMANTIC_ICON) | Single owner in W0-A; downstream only READS it. |
| `webui/tailwind.config.js` | W0-A (fontSize/shadow/container-queries plugin) | Single owner W0-A. |
| `webui/src/soc/theme-tokens.ts` | W0-A (ALLOWED_TOKENS + AA guard) | Single owner W0-A. |
| `webui/src/lib/types.ts` (2047) | W0-F (mirror real config types), G6 (rule types), G7 (dashboard types) | Append-only; each wave owns a distinct trailing section; never reflow existing blocks. |
| `webui/src/lib/api.ts` (797) | W0-F (preview + config clients scaffold), G6, G7 | Append methods to distinct namespaces (`api.rules`, `api.dashboards`, `api.triage`); no reorder. |
| `webui/src/soc/nav.ts` (374) | W0-F (FEATURES scaffold behind exports), Sett-B (relabels+redirects), G7 (dashboards id) | Sett-B owns nav labels; G7 appends the dashboards route AFTER Sett-B. |
| `webui/src/soc/App.tsx` (277) | W0-C (PageContainer + MotionConfig wire), Coupling-A (renderPage→registry), G7 (dashboards route) | W0-C first (MotionConfig/root), then Coupling-A rewrites renderPage, then G7 appends. |
| `webui/src/soc/AppShell.tsx` (616) | W0-C (kill max-w-[1400px] → PageContainer), a11y (live announcer/skip) | W0-C owns the width change; a11y appends the announcer region after. |
| `webui/src/soc/pages/Settings.tsx` (2673) | Sett-A/B/C (decompose to registry) | ONE dedicated workstream; do NOT let any other wave touch it until decomposed. |
| `webui/src/soc/pages/CaseDetail.tsx` (4210) | Coupling-D (split into panels) | ONE dedicated workstream, visual-review gated; contract `{caseId,onClose,onNavigate?}` frozen. |
| `backend/app/config.py` (2177) | W0-F none (read-only), G6 (typed config blocks already exist — mostly no edits), audit | Additive only; never touch `_migrate_fp_auto_close` / `AutoClosePolicy` shape. |
| `backend/app/models.py` (1319) | G7 (`UserPrefs.dashboards`), bug batch (as needed) | Additive fields, defaulted; mirror in `types.ts` same PR. |
| `backend/app/api/routes.py` (4751) | Coupling-E (split one-feature-per-PR), bug batch (#8,#13) | Coupling-E is one-slice-per-PR SERIAL; paths byte-identical. |

---

# WAVE DEPENDENCY GRAPH (one screen)

```
W0  FOUNDATIONS  (mostly serial on root files, unblocks everything)
 ├─ W0-Z  test-anchoring: data-testid + PAGE_TITLE constant        [FIRST, gates all UI edits]
 ├─ W0-A  tokens: fonts + 3-axis palette + chart ramps + AA guard  [SERIAL: theme.css, palette.ts, tailwind.config, theme-tokens.ts]
 ├─ W0-B  extract shared primitives + hooks (new files)            [PARALLEL after W0-A]
 ├─ W0-C  PageContainer + AppShell width + MotionConfig + PageHeader-merge  [SERIAL: AppShell, App.tsx]
 ├─ W0-D  KpiTile fix (#2) + compact PageHeader/HeroPanel merge (G5) [after W0-A/W0-B]
 ├─ W0-E  a11y foundation: Field wrapper, IconButton, SEMANTIC_ICON wiring, live announcer, contrast+a11y CI gate
 └─ W0-F  loose-coupling infra: mirror real config types, api scaffolds, FEATURES[] behind exports, misc-clobber fix (#5), DashboardStore infra
        │
        ▼  (feature waves — parallelize; disjoint files)
 ┌──────────────┬──────────────┬──────────────┬──────────────┬──────────────┐
 ▼              ▼              ▼              ▼              ▼              ▼
COLOR          SETTINGS       DASHBOARD      RULES (G6)     CUSTOM-DASH    COUPLING (G8)
codemod        decompose      density+hero   Sett-A/B/C     (G7)           Coupling-A..F
(cards/btns    (Sett-A/B/C)   three-zone     auto-close     DashboardStore renderPage→registry
/tabs/badges)  IA regroup     (Dash-A/B)     FIRST(#1),     +registry+     useNavigate
Codemod-*      Security promo               Detection&Rules WidgetGrid+RGL routes.py split
                              needs W0-C     home,preview,   needs W0-F     CaseDetail split
needs W0-A     needs W0-F     +W0-D          ledger          +Dash-A        needs W0-B/W0-F
                              +Codemod                       needs W0-F
        │              │              │              │              │              │
        └──────────────┴──────────────┴──────────────┴──────────────┴──────────────┘
                                        ▼
                              BUG-BATCH (backend/misc bugs #5,#11,#12,#13,#14 land in Coupling; UI bugs land in-wave)
                                        ▼
                              A11Y-PASS (jest-axe on load-bearing surfaces, keyboard, WCAG 2.2)
                                        ▼
                              GATED (G6 Ph3: react-querybuilder, pySigma, CodeMirror; react-table under DataTable; @dnd-kit iff drag ships)
                                        ▼
                              G10 POLISH + adversarial audit + docs + Journal
```

**Critical path:** `W0-Z → W0-A → W0-C/W0-D → Codemod → Dashboard-density`, and
`W0-F → {Rules, Custom-Dash, Coupling}`. Everything after W0 fans out.

---

# WAVE 0 — FOUNDATIONS (serial on root files; unblocks everything)

> Goal: fix the structural root causes and extract the missing primitives ONCE, before any
> feature work, so every later change lands on the consolidated version. W0-Z runs first.
> W0-A/C are SERIAL (root files). W0-B/E/F fan out once their prerequisite lands.

## W0-Z — Test anchoring (FIRST — before any UI edit) **[PARALLEL-SAFE, but gates all UI waves]**

**Why first:** ~10 test files hardcode strings/classes/source-text. Migrating them to
`data-testid` up front stops every later reword/codemod from cascading into test churn.

- **Task Z1 — Extract the boot-guard string constant.** **[SERIALIZE with Overview edits]**
  - FILES: `webui/src/soc/pages/Overview.tsx` (add `export const PAGE_TITLE = 'Security Posture Dashboard'`), `webui/src/soc/__tests__/App.smoke.test.tsx` (lines 94/104), `webui/src/soc/__tests__/settings.render.test.tsx` (line 177).
  - CONTRACT: source + all 3 test files reference `Overview.PAGE_TITLE`. **DO NOT delete the smoke boot guard** (white-screen safety net) — just point it at the constant.
  - ACCEPTANCE: `vitest run` green; smoke test still asserts the app boots on that title.
- **Task Z2 — Add stable `data-testid` anchors on load-bearing surfaces.** **[PARALLEL-SAFE]**
  - FILES: Overview hero (`data-testid="page-hero"`), each Metrics tab trigger (`data-testid="metrics-tab-<id>"`), each nav item in `NavSidebar.tsx` (`data-testid="nav-<id>"`), each Settings section rail button (`data-testid="settings-section-<id>"`), KpiTile (`data-testid="kpi-<id>"`).
  - MIGRATE these specs to testids while keeping the aria assertions (the real value): `App.smoke.test.tsx`, `NavSidebar.test.tsx` (import labels from `nav.ts`, keep `aria-expanded`/`aria-controls`/`aria-current`), `analytics-consolidation.test.tsx`, `metrics-posture.test.tsx`, `settings.render.test.tsx`.
  - ACCEPTANCE: all migrated specs assert testids + aria + generic behavior; no incidental string/class assertions remain on those surfaces. `vitest run` green.
- **Task Z3 — Neutralize class/hex-string assertions in token-adjacent specs.** **[PARALLEL-SAFE]**
  - FILES: `RiskGauge.test.tsx` (assert numeric value + band label + `role=img` generically, not exact `stroke-muted`/`text-*` classes where they'll change), `ui-glitch-fixes.test.tsx`, `theme-tokens.test.tsx` (assert the SECURITY behavior — allowlist enforced, sanitizer strips injection, AA advisory present — NOT individual token value literals), `settings-dirty.test.ts` (track `auto_close` in addition to `--critical`/`--font-display`/`--radius`).
  - ACCEPTANCE: token/palette changes in W0-A do not break these; `vitest run` green.

**VERIFY W0-Z:** `vitest run` green with the migrated anchors; no source behavior changed.

## W0-A — Design tokens: fonts + 3-axis palette + chart ramps + AA guard (G1) **[SERIALIZE — one agent owns the token chain]**

**Owns (in lockstep, single agent):** `theme.css`, `tailwind.config.js`, `theme-tokens.ts`,
`palette.ts`. These four are a coupling chain (DESIGN_STANDARD §1.0); one agent edits all four.

- **Task A1 — Ship the declared fonts.** DEV deps `@fontsource-variable/inter` + `@fontsource-jetbrains-mono`. Import `wght.css` + JetBrains 400/500/700 in `main.tsx` (or new `styles/fonts.css`), preload one sans weight in `index.html` (`crossorigin`), `font-display:swap` sans / `optional` mono. Verify tailwind family string matches Fontsource export (`'Inter Variable','Inter',…`). Enable `ss01`/`cv01`/`zero`/`calt` on body+tables; turn `calt` OFF on mono/log surfaces (DESIGN_STANDARD §2.1-2.2).
- **Task A2 — Tier-1 Radix slate+blue primitives + Tier-2 aliases** in `theme.css` `:root`/`.dark` (DESIGN_STANDARD §1.1-1.2). Add `--surface-sunken`, `--hover`, `--border-strong`. Delete `--destructive`/`--destructive-foreground` (keep the `destructive` VARIANT names pointing at `--critical`); visual+AA pass on DangerZone/AlertDialog/ErrorBoundary after.
- **Task A3 — 3 orthogonal semantic axes** (SEVERITY/STATUS/VERDICT) each with `--{t}`/`--{t}-foreground`/`--{t}-text` triad, both themes, MEASURED AA (DESIGN_STANDARD §1.3). Drop green from severity (`--low` → blue); verdict FP → `--info` blue-grey; medium hue 40 vs warning hue 36.
- **Task A4 — Chart ramps** `--chart-1..8` (Okabe-Ito) + viridis 7-stop `sequential(t)` lerp in `palette.ts` (DESIGN_STANDARD §1.4). Rewrite `CATEGORICAL` off `--chart-*`, cap 7+Other, fix the `--accent`-as-series bug (`Metrics.tsx:379` donut — repoint to `--chart-*`/`--primary`).
- **Task A5 — Elevation/shadow + radius/density tokens.** Per-theme `--shadow-color` + `--elev-1/2` + `--shadow-menu/overlay` in `theme.css`; point `tailwind.config.js` `boxShadow` at them (DESIGN_STANDARD §1.5). Declare radius/density/font-display ONCE in `:root`.
- **Task A6 — The ONE label→token authority in `palette.ts`** (DESIGN_STANDARD §1.6): `SEVERITY_COLOR`/`STATUS_COLOR`/`VERDICT_COLOR` maps + `SEMANTIC_ICON` + one 0-100 thresholds module (`0-21 low/22-47 medium/48-73 high/74-100 critical`). Delete the parallel `badges.tsx` switches (they now consume `palette.ts`). Fixes drift: escalated→`high`, FP→`info`.
- **Task A7 — Runtime AA guard** in `theme-tokens.applyBranding` (reuse `contrastRatio` at `branding.api.ts:111`): auto-darken/reject an operator accent failing 4.5:1. Mirror the `ALLOWED_TOKENS` allowlist + `sanitizeTokenValue` server-side in `config.py:_check_theme_tokens`. Derived `*-foreground`/`*-text` tokens are NOT operator-writable. Give `--accent2` a real `:root` default. Set an ownable default `--primary`.
- **Task A8 — Correct the false in-code "WCAG-AA" comments** at `theme.css:49,82,175,203` + `theme-tokens.ts:237-239`.

- CONTRACT: no token NAME removed that a consumer references (add new, keep old where consumed); Badge/Button variant names unchanged; `applyBranding` accent→material→theme_tokens last-wins order preserved.
- BREAKS + MIGRATE: color snapshots (re-snapshot light+dark); `theme-tokens.test.tsx`/`settings-dirty.test.ts`/`RiskGauge.test.tsx` — already neutralized in W0-Z. Update snapshots in the same PR.
- ACCEPTANCE: `npm run build` clean; `vitest run` green (re-snapshotted both themes); contrast checker (W0-E) passes 4.5:1/3:1 both themes.
- DEPENDS ON: W0-Z.

## W0-B — Extract missing shared primitives + hooks (G2/G8) **[PARALLEL-SAFE — all NEW files]**

New files under `webui/src/ui/*` and `webui/src/soc/components/*` and `webui/src/soc/hooks/*`
(or `webui/src/lib/*`). Because these are net-new, multiple agents can fan out by primitive.
Each primitive keeps future consumers on ONE grammar.

- **B1 shared class utilities** (`lib/ui-recipes.ts` or `ui/recipes.ts`): `focusRing`, `overlaySurface`, `menuItem`, `modalOverlay` (DESIGN_STANDARD §5.1). Refactor `select.tsx`/`dropdown-menu.tsx`/`popover.tsx`/`hover-card.tsx`/`command.tsx`/`badge.tsx`/`dialog.tsx`/`alert-dialog.tsx`/`sheet.tsx` internals onto them — **exports unchanged**.
- **B2 `Card` variant/padding props** (`ui/card.tsx`): `padding`/`density`/`elevation` props (`p-4`/`p-6`, not `px-5`); `variant="flat"`; Title=`<h3>`, Desc=`<p>`. (DESIGN_STANDARD §3.2, §5.2).
- **B3 control primitives:** `SegmentedControl` (Radix Tabs styled), `FilterBar`, `ConfirmDialog` (replaces `window.confirm`), `Field` (label+control+description+error, auto `useId()`+`htmlFor`+`aria-describedby`), `SecretField` (#10 boolean), `NumberField` (stepper+clamp-on-blur+unit+reset, `aria-invalid`), `LabeledSlider` (Radix slider ⇄ input + ticks), `TagInput`, `IconButton` (`min-h-6 min-w-6`), `ui/collapsible.tsx` (~40-line Radix vendor). (DESIGN_STANDARD §5.2).
- **B4 typography layer** (`ui/typography.tsx`): `<Heading level>`, `<Text variant>`, `<Eyebrow>`, `<Label>`, `<Metric>` (DESIGN_STANDARD §2.4). Also extend `tailwind.config.js fontSize` (owned by W0-A) with `micro`/`2xs` rungs + retune the named scale tuples — **that specific edit is on W0-A's file, so it lands in W0-A**; B4 only builds the components.
- **B5 hooks** (`soc/hooks/`): `useAsync<T>(fn,deps)→{data,loading,error,reload}`, `useDirtyDraft`/`useUnsavedChanges` (lift from `settings-dirty.ts`), `usePosture(hours,period)`, `usePrefersReducedMotion` (SSR-safe, replaces 2 inlined matchMedia), `useMediaQuery`/`useIsMobile`, `useLiveAnnouncer`. Plus `lib/errorMessage.ts` (`errorMessage(e, fallback)` built on `ApiError`) + `soc/components/LoadError.tsx` (promote `Catalog.tsx:179`).
- **B6 variant additions** (additive, defaults unchanged): `Progress` cva variant; `Alert` success/info variants; `Avatar` size scale; `Table` density/sticky/no-wrapper-escape. Fix `Select` viewport clip; remove nested `TooltipProvider`s; `AlertDialog` suppress dismiss-on-overlay/Escape for destructive gates. (DESIGN_STANDARD §5.2).

- CONTRACT: every primitive documented with props in a header comment; barrel exports unchanged; no consumer migration in W0-B (that's the Codemod wave) — just SHIP the primitives + adopt them inside existing `ui/*` internals only.
- ACCEPTANCE: `npm run build` clean; `vitest run` green; new primitives each get a minimal render/behavior spec (`Field` associates label, `NumberField` clamps, `ConfirmDialog` gates, `SecretField` never shows value).
- DEPENDS ON: W0-A (recipes reference the new tokens). B files are disjoint — fan out.

## W0-C — PageContainer + AppShell width + MotionConfig + header merge scaffold (G4/G5) **[SERIALIZE: AppShell.tsx, App.tsx]**

- **C1 `<PageContainer variant='fixed'|'wide'|'fluid'|'prose'>`** new file `soc/components/PageContainer.tsx` (DESIGN_STANDARD §4.1, §4.5). Adopt `@tailwindcss/container-queries` (dev plugin, owned by W0-A's tailwind.config edit — coordinate: W0-A adds the plugin, W0-C uses `@container`).
- **C2 kill the hard cap** in `AppShell.tsx:601`: remove `max-w-[1400px]`, let each page opt into a width via `PageContainer`. Default shell wrapper becomes `mx-auto w-full px-4 sm:px-6 lg:px-8 2xl:px-12 py-6` and pages wrap their body. Preserve `min-w-0` on flex/grid children. Add `--header-h:52px` token (theme.css — coordinate with W0-A/D).
- **C3 `<MotionConfig reducedMotion="user">` at the app root** (`App.tsx` or `AppShell`) (DESIGN_STANDARD §6.4). Upgrade the `theme.css:272-281` reduced-motion block: keep the `*` safety net, re-enable opacity crossfades on dialog/tooltip/popper/toast, add `.motion-essential` exempt class for spinners. (This theme.css edit is coordinated with W0-A — W0-A ships the motion tokens `--motion-fast/base/slow`; W0-C wires MotionConfig + the reduced-motion block upgrade.)

- CONTRACT: no page assigned a width yet (that's the density/codemod waves); `PageContainer` default = `fixed` so nothing visibly changes until a page opts in. `NavOpts` semantics + `HIDDEN_ROUTE_IDS`/`PAGE_IDS` untouched.
- BREAKS + MIGRATE: none expected (default preserves current width). If any snapshot pins the shell wrapper class, update.
- ACCEPTANCE: `npm run build` clean; `vitest run` green; a responsive test (NEW) asserts `wide` widens past 1400 at ≥1920 while `prose` stays ~72ch.
- DEPENDS ON: W0-A (tailwind plugin + `--header-h` token).

## W0-D — KpiTile delta fix (#2) + merge HeroPanel into PageHeader (G5) **[SERIALIZE: PageHeader.tsx/HeroPanel.tsx/KpiTile.tsx]**

- **D1 KpiTile `goodDirection` prop** (bug #2, DESIGN_STANDARD §5.3): color = improvement, arrow = true direction; `goodDirection?: 'up'|'down'|'none'` default `'up'`. a11y label announces direction AND judgement. Absorb `StatCard` as `variant='bar'`. `p-4` padding, `tabular-nums`. Update every call site with the correct direction (lower-is-better for MTTA/MTTR/dwell/FP/open) — **that call-site sweep is a Codemod task**, D1 ships the prop + default-`'up'` so nothing regresses.
- **D2 merge `HeroPanel`→`PageHeader`** with `variant?: 'dense'|'hero'` (DESIGN_STANDARD §4.2). `dense` = default ~52px band (`text-lg/xl`, `h-7/h-8` icon chip); `hero` = compacted posture band (`p-6`, `text-2xl`, folds KPI summary into `meta`/`tabs`). Props: `{variant, breadcrumb, title, icon, description, meta, tabs, actions, sticky}`. Retire `HeroPanel` (compose PageHeader). All header content plain text (#9).
- **D3 shrink RiskGauge** to ~150-160px, show numeric value + band label (a11y §6.1), consumable in the KPI row.

- CONTRACT: `PageHeader` gains props additively; `HeroPanel` kept as a thin re-export of `<PageHeader variant="hero">` for one transition wave (then Codemod removes usages).
- BREAKS + MIGRATE: `RiskGauge.test.tsx` (neutralized in W0-Z; re-assert value+band); Overview hero — the Codemod/Dashboard-density wave swaps it, guarded by `PAGE_TITLE` (W0-Z Z1). `metrics-posture.test.tsx` tile labels unchanged (KpiTile props only).
- ACCEPTANCE: `npm run build` clean; `vitest run` green; NEW KpiTile spec asserts `goodDirection='down'` + `delta=-12%` renders green with a down arrow.
- DEPENDS ON: W0-A, W0-B.

## W0-E — a11y foundation + CI gates (G9) **[PARALLEL-SAFE — new files + additive]**

- **E1 wire `SEMANTIC_ICON`** (from W0-A palette) into `badges.tsx`, `RiskGauge`, chart legends, MITRE heatmap — non-color signaling (DESIGN_STANDARD §6.1). Left-edge severity band on dense table rows.
- **E2 the 4 WCAG-2.2 criteria** (DESIGN_STANDARD §6.2): `scroll-margin-top: var(--header-h)` on focusable rows/inputs (2.4.11); `IconButton` ≥24px sweep readiness (2.5.8); non-drag alternative contract documented for future drag surfaces (2.5.7); allow paste + correct `autocomplete` (`one-time-code`) on Login/MFA/recovery (3.3.8).
- **E3 live announcer + aria-sort** — mount one `<VisuallyHidden aria-live="polite">` at root via `useLiveAnnouncer` (B5); DataTable pushes "sorted by X, descending" + bulk outcomes.
- **E4 CI gates** (DESIGN_STANDARD §12): (1) token-existence checker (every `ALLOWED_TOKENS` + `palette.ts token()` name exists in `theme.css` `:root`+`.dark`); (2) ~20-line contrast checker (4.5:1 text / 3:1 non-text, both themes); (3) grep guard: no new `text-\[<number>` in `.tsx`; (4) grep guard: no new `#[0-9a-fA-F]{6}` in `.tsx`; (5) CVD ramp check. Add dev deps `jest-axe`/`@axe-core` + `eslint-plugin-jsx-a11y` to the Vitest/lint gate.

- CONTRACT: gates run in CI + `npm run lint`; a11y assertions on load-bearing surfaces land incrementally (full pass is the A11Y-PASS wave).
- ACCEPTANCE: contrast checker passes for the W0-A palette (proves G1 real); token-existence checker green; `npm run lint` with jsx-a11y passes (warn→error rollout).
- DEPENDS ON: W0-A (tokens), W0-B (`IconButton`/`useLiveAnnouncer`).

## W0-F — loose-coupling infra + typed foundation + misc-clobber fix (#5) + DashboardStore infra (G8/G6/G7) **[SERIALIZE on types.ts/api.ts/nav.ts; backend PARALLEL-SAFE]**

This wave lays the typed + persistence + registry rails that Rules/Custom-Dash/Coupling all
need. Split into a FE-contract sub-agent (serial on `types.ts`/`api.ts`) and a BE sub-agent.

- **F1 mirror the REAL config types into `types.ts`** (append a new trailing section): `AutoClosePolicy`+`VerdictAutoClose`, `correlation_rules`/`CorrelationRule`, `rule_catalog`/`RuleDefinition`/`RuleMatch`, `asset_networks`/`asset_criticality`, `SlaPolicy`, `priority_matrix`, Round-4 blocks (`ThresholdTuningConfig` all 8 fields, `BatchConfig`, `BaselineConfig`, `CampaignConfig`), `caps.max_concurrent`, `BrandingConfig.login_*`. Hand-mirror from `config.py` exactly. Move `NavOpts` OUT of `types.ts` into `soc/nav-types.ts` (leave a re-export shim for one wave). **[SERIALIZE: types.ts]**
- **F2 api client scaffolds** (`api.ts`, distinct namespaces): stub `api.rules.*`, `api.dashboards.*`, `api.triage.previewDecision`, `api.<feature>.getConfig/putConfig` for baseline/campaign/batch mirroring `routes_tuning`'s `getConfig/putConfig`. **[SERIALIZE: api.ts]** Delete dead `api.setup.initAdmin` stub (bug #10). Route `CodeBlock.tsx`/`ChatPanel.tsx` copy through `lib/clipboard.ts copyText()` (bug #4).
- **F3 `FEATURES[]` registry behind existing exports** (`soc/registry.ts`): one typed table deriving nav+routes+palette-targets with `enabled(ctx)` (RBAC/prefs-toggle/demo as 3 axes). Export the SAME `NAV_GROUPS`/`PageId`/`PAGE_IDS` shapes from it so nothing breaks; `nav.ts` becomes a thin re-export. **[SERIALIZE: nav.ts]** (Migration behind exports = non-breaking.)
- **F4 backend: `POST /api/triage/preview-decision`** — thin read-only wrapper over the pure `decide()` (`case_manager.py`), on the existing `triage_router` (`routes_triage.py`). Input `{verdict,confidence,risk_score, policy?}`; returns `{decision, rationale}`. **Never bills LLM, never writes a case, never re-implements decide().** NET-NEW pytest asserting parity with `decide()` + zero UsageDoc writes. **[PARALLEL-SAFE — backend]**
- **F5 backend: typed config endpoints** for baseline/campaign/batch mirroring `routes_tuning`'s `GET/PUT /tuning/config` (only tuning has one). Deep-merge PUT semantics; audited; RBAC. Add the 3 missing tuner fields' round-trip coverage. NET-NEW pytest. **[PARALLEL-SAFE — backend]**
- **F6 backend: fix `misc` prefs clobber (#5)** — `stores/user_prefs.py` deep-merges the `misc` bag (use the `kv_mutate` CAS pattern from `inbox.py`/`tuning.py`). **This REQUIRES updating `test_user_prefs.py:323-325`** (it codifies the wrong replace-behavior) → assert deep-merge instead. **[PARALLEL-SAFE — backend, but coordinate: it's the same file as F7's read path]**
- **F7 backend: `DashboardStore` infra + `UserPrefs.dashboards` field** — additive `dashboards: dict[str, DashboardLayout]` on `UserPrefs` (`models.py`, defaulted `{}`, mirror `saved_views`); a `DashboardStore` copying `inbox.py`/`tuning.py` (KVStore + `kv_mutate` CAS + per-user key, ES/SQL/SQLite), `schema_version` from day one. NO new ES index / SQL table / migration. Mirror `DashboardLayout`/`DashboardWidget` in `types.ts` (F1's section). NET-NEW pytest (zero-migration load, CAS lost-update safety). **[SERIALIZE with F6 on user_prefs read path; otherwise PARALLEL-SAFE]**

- CONTRACT: everything additive + behind existing exports; wire keys byte-identical; `types.ts` ⇔ `models.py` in the same PRs.
- ACCEPTANCE: `pytest -q` ≥ baseline + net-new (preview-decision parity, config round-trips, misc deep-merge, dashboard store); `npm run build` clean; `vitest run` green; `git diff --exit-code case_manager.py` empty.
- DEPENDS ON: W0-Z (test anchors). F1 before F2/F3 (types before clients/registry).

**VERIFY W0 (all sub-waves):** full VERIFY block. Gate: contrast checker green (G1 real), `decide()` byte-identical, all 273+ specs green re-snapshotted, no new deps outside ledger, misc deep-merge test flipped.

---

# FEATURE WAVES (parallelize — disjoint file sets)

## Codemod — adopt the primitives everywhere (G2) **[PARALLEL-SAFE by page batch; each batch its own commit + vitest gate]**

> Mechanical adoption of W0-B primitives. Batch by page group so each is independently
> reviewable/revertable. **CaseDetail is EXCLUDED here** (it's Coupling-D, a dedicated
> visual-review workstream). Run `vitest run` after each batch.

- **CM1 raw cards → `<Card>`** across the 44 hand-rolled `rounded-lg border bg-card p-5/p-6` divs in the 18 non-importing pages (Cases, Models, Roles, Audit, Tuning, Campaigns, BatchJobs, Sessions, Users, Scans, Chat, Analytics, Home, Intelligence, Workspace, AdminSessions, Baseline) — fixes elevation+padding together. `variant="flat"` for filter bars.
- **CM2 raw `<button>` (45×) → `<Button>`** preserving `aria-pressed`/`role=group`.
- **CM3 hand-rolled segmented strips → `SegmentedControl`** (Overview/Metrics window toggle, Cost, Approvals, Investigate, Memory).
- **CM4 route ALL severity/status/verdict/disposition chips through `badges.tsx`** (Approvals, CaseDetail-excluded, Metrics, Overview, Settings).
- **CM5 arbitrary `text-[..]` (101×) → scale steps** (`micro`/`2xs` + named rungs). CM6 error idioms → `LoadError` + `errorMessage`; loading → SkeletonCard; empties → `EmptyState`/DataTable `empty=`. CM7 `window.confirm` → `ConfirmDialog`. CM8 KpiTile call sites → correct `goodDirection`.

- BREAKS + MIGRATE: class-string snapshots per page — re-snapshot per batch; already anchored to testid in W0-Z where load-bearing.
- ACCEPTANCE per batch: `npm run build` clean; `vitest run` green; no mixed-elevation screen remains; grep guards (no new `text-[<n>`, no new hex) pass.
- DEPENDS ON: W0-A, W0-B, W0-D.

## Settings — decompose god-file + IA regroup (G3) **[DEDICATED workstream — owns Settings.tsx; serialize its own sub-tasks]**

Owns `Settings.tsx` exclusively. No other wave touches it until decomposed.

- **Sett-A — data-driven section registry.** Extract a `settings-sections.ts`: array of `{id, group, perm, ownedKeys, title, blurb, icon, Component}` as the SINGLE source; derive `SectionId`, `SECTION_GROUPS`, `SECTION_KEYS` (`settings-dirty.ts`), and the render switch from it (kills the 3-file sync). Extract each renderer to `pages/settings/<section>.tsx` (`{prefs, update}`). Fix the `GRID_SECTIONS` Automation double-wrap. Unify the 3 save mechanisms onto the one `StickySaveBar` changed-key PUT. **[SERIALIZE: Settings.tsx]**
- **Sett-B — IA regroup 6→5 + Security promoted** (PROPOSAL §G3 / RESEARCH_SETTINGS_IA): Account / General / Integrations / Security & access (NEW) / Organization (Danger zone isolated, red, last). **Rename display labels only; keep section `id`s stable**; ship redirect aliases for any changed id. Collapse the 6 duplicate standalone/embedded homes (Users/Security/Sessions/Account/AdminSessions/Roles) — keep the `*Inner` bodies, route nav children to `#/settings?s=<id>`, add redirects from old standalone routes. **[SERIALIZE: nav.ts (after W0-F F3), Settings.tsx]**
- **Sett-C — schema-driven fallback + deep-link/search fixes.** Extend `settings_schema.py` to descend into element models (fix the list/dict `general`-bucket collapse); wire dead `GET /api/settings/schema` → a generic "Advanced (all settings)" renderer (special-case `demo` + `read_only_settings_mode`). Fix router hash-strip (write full hash directly); register sections as Cmd-K jump targets from the lifted `settings-sections.ts`; add card-level `&a=<anchor>` deep-links; deepen filter to setting-level. Two disclosure tiers (head-of-section enable toggle for default-OFF engine features; Danger Zone visible-but-guarded). **[SERIALIZE backend: settings_schema.py — coordinate with Rules G6 R7 which also extends it]**

- BREAKS + MIGRATE: `settings.render.test.tsx` (group/section labels + `#/settings?s=admin_users` deep-link) — near-certain break; ship redirect + update labels + testids (from W0-Z). Preserve Rules-of-Hooks ordering (`useMemo`s above early returns). `test_settings_roundtrip.py`/`test_rule_catalog.py` — SAFE unless config wire-keys renamed (they aren't).
- ACCEPTANCE: `vitest run` green; redirect test proves old ids + old standalone routes resolve; `pytest -q` green (schema reflector net-new tests); ≤2 menu levels; no 2673-line file remains.
- DEPENDS ON: W0-F (FEATURES[] + registry), W0-B (`Field`/`collapsible`).

## Dashboard density + hero compaction + three-zone (G4/G5) **[PARALLEL-SAFE — Overview/Metrics/Cases; disjoint from Settings/Rules]**

- **Dash-A — Overview.** Swap `HeroPanel`→`<PageHeader variant="hero">` (compact, ~64px), guarded by `PAGE_TITLE` (W0-Z Z1). Un-nest the KPI grid (drop `col-span-2`, `xl:grid-cols-4`/`2xl:grid-cols-7`), delete the redundant `<dl>` + the ~120 lines of client posture math (use the server posture endpoint via `usePosture` hook). Wrap in `PageContainer variant="wide"`. Update the loading skeleton in LOCKSTEP with the grid (else layout shift).
- **Dash-B — three-zone layout + TimeRangePicker.** Compact control bar (time-range pill + auto-refresh default Off/1m + last-refresh stamp) → KPI strip (4-6 drill-down tiles) → widget grid of named `<DashboardGroup>` (Radix Collapsible). Build in-house `<TimeRangePicker>` (Radix + ~40-line ES date-math parser, no `@elastic/datemath`); serialize range to URL query; pause auto-refresh on hidden tab. Every tile deep-links to the filtered case list carrying range. (DESIGN_STANDARD §4.3.)
- **Dash-C — Metrics + Cases density.** Metrics: fold window toggle+refresh into the TabsList row, one responsive column formula, drop the standalone description. Cases: collapse KPI band → inline pill counts, merge SavedViews/Columns into the filter bar (~150px reclaimed), `PageContainer variant="wide"`, add columns at `2xl`.

- BREAKS + MIGRATE: Overview has ZERO tests except smoke (add net-new); `metrics-posture.test.tsx` (tab names + tile labels — testid-anchored in W0-Z); `analytics-consolidation.test.tsx` (4 tabs — keep count, testid tabs); `cases-bulk.test.tsx` (keep behavior). Skeleton-mirrors-grid risk — re-verify.
- ACCEPTANCE: `vitest run` green; hero band ≤~64px (assert via testid + computed height in a jsdom-safe way or visual review); first metric row above the ~820px fold; NEW responsive test for `wide`.
- DEPENDS ON: W0-C (PageContainer + width), W0-D (PageHeader merge + KpiTile), W0-B (`usePosture`), Codemod (cards/segmented).

## Rules customization (G6) **[PARALLEL-SAFE for editors; auto-close fix FIRST + serial with Settings on the Detection home]**

> Phase 1 (dep-free) + Phase 2 (zod). Phase 3 is the GATED wave. Editors are config writers
> via deep-merge PUT; NEVER touch `decide()`; preview via F4's pure wrapper.

- **R1 — auto-close dead-field fix (#1) FIRST.** ONE `VerdictAutoClose` sub-editor rendered twice (`false_positive` + `true_positive`), posting to `prefs.auto_close` (the field `decide()` reads at `case_manager.py:78`). Lock `needs_human` (code-enforced never-auto-close). `true_positive` opt-in OFF by default. **DO NOT touch `decide()`; DO NOT delete `fp_auto_close`** (legacy migrate path via `_migrate_fp_auto_close`). Update `settings-dirty.ts` to track `auto_close` (done in W0-Z Z3 partly; finalize). Prove via F4 preview-decision that the toggle changes what `decide()` acts on. **[SERIALIZE with Settings: this is a Settings section]** NET-NEW pytest + vitest.
- **R2 — "Detection & rules" home** exposing 3 tiers, each backed by existing code: Detection rule Match+Threshold (`RuleDefinition`+`CorrelationRule`), Anomaly/Baseline (`BaselineConfig`), Case-automation rule (`CaseAutomationRule`, HITL-safe, never sets status — asserted `threshold_automation.py`). Editor shell = Define→About→Schedule→Actions (Radix Tabs), Define polymorphic on a TS discriminated union. Keep Threshold/Suppression/Exceptions/MITRE distinct. Thin deterministic adapter form↔wire keys. **[PARALLEL-SAFE — new page/components; lands under the Settings General group registered in Sett-B]**
- **R3 — condition builder (flat, dep-free):** flat `{field, op, value}` AND rows over Radix `Select`/`Input` (= what `RuleMatch` is). Nested AND/OR = Phase 3 (gated). **[PARALLEL-SAFE]**
- **R4 — threshold UX:** `NumberField` primary + `LabeledSlider` for ordinal `severity_floor`; enforce bounds; surface tuner suggestion inline; live "effective config" preview + copy **"below floor: candidate only — never dropped" (#4)**. Add the 3 missing tuner fields (`max_n_step`/`wilson_z`/`ewma_alpha`) to `Tuning.tsx`. **[PARALLEL-SAFE]**
- **R5 — lifecycle + preview + version ledger:** enabled/disabled/shadow states; Test/Preview against 7-14 days RO-scoped data (histogram via recharts, hard-capped, **never `decide()`/never bills LLM**); safe what-if via F4 `POST /api/triage/preview-decision`; immutable version ledger + red/green diff + one-click rollback (generalize `stores/tuning.py` CAS ledger, no diff library); risky changes → Approvals/Proposals HITL; all events → append-only audit (#2). "Tune" is the primary CTA. **[PARALLEL-SAFE — new store + endpoints]**
- **R6 — editors for asset criticality (map+CIDR), SLA policy, priority matrix, operator suppression-rule builder** (still audited via proposal/audit path). Add missing typed config endpoints (baseline/campaign/batch — done in W0-F F5; wire the UI here). **[PARALLEL-SAFE]**
- **R7 — schema-driven fallback** (shared with Sett-C): extend `settings_schema.py` to descend into element models; wire `GET /api/settings/schema` → generic renderer for the long tail. Blueprint = connector `AuthField`/manifest SPI. Respect `maybe_seed_rule_catalog()`/`RULE_CATALOG_SEED_VERSION` (empty catalog could trigger reseed). **[SERIALIZE with Sett-C on settings_schema.py]**
- **R8 — zod (Phase 2)** as the single client-side rule validation + defaults mirroring `config.py`. + MITRE coverage view. **[PARALLEL-SAFE]**
- **R9 — RBAC cleanup:** unify fragmented grants (baseline→settings:read, campaigns→cases:read, batch→models:read, tuning→automation:read) under one rules permission; labels/aria on every control from the start. **[SERIALIZE backend: permission matrix in auth/service.py]**

- CONTRACT: editing `correlation` `n`/`window`/`group_by` changes case formation going forward — surface it; do NOT retroactively re-key open cases (#4). All controls have `Field`-wrapped labels (a11y cluster). `types.ts` mirrors any new rule model.
- BREAKS + MIGRATE: G6 has thin UI test coverage (only `Tuning.render.test.tsx`) — write NET-NEW tests for each editor. `test_rule_catalog.py`/`test_settings_roundtrip.py` safe unless config keys renamed (don't).
- ACCEPTANCE: `pytest -q` green (preview parity, config round-trips, ledger CAS, schema reflector); `vitest run` green (auto-close FP+TP+locked-needs_human, flat builder, NumberField clamp, preview no-LLM assertion); operator can edit all listed knobs end-to-end.
- DEPENDS ON: W0-F (types, F4 preview, F5 config endpoints, misc fix), W0-B (Field/NumberField/LabeledSlider/SegmentedControl/TagInput/ConfirmDialog), Sett-A/B (Settings registry home).

## Custom dashboards (G7) **[PARALLEL-SAFE — new dashboard subtree; depends on W0-F + Dash-A]**

- **CD1 — widget registry** (`soc/dashboard/registry.ts`): `enum WidgetType → WidgetDef {lazy Component, defaultSize, declarative configFields, RBAC requires}`. Widget bodies REUSE `KpiTile`/`BarList`/`charts.tsx`/`DataTable`/`MitreHeatmap`. Promote `ChartCard` (`Metrics.tsx:174`) → `soc/components/ChartCard.tsx`. Reconcile-on-load drops unknown types + RBAC-filters + appends role defaults. **[PARALLEL-SAFE]**
- **CD2 — `DashboardDataProvider` context** fetches each source once, hands results to all widgets (avoid N-widget fan-out). Respect DASH/`available:false` sentinels (never print `'—'` as a number). **[PARALLEL-SAFE]**
- **CD3 — `<WidgetGrid>` + RGL edit mode.** `react-grid-layout` v2.2.3 runtime dep, **lazy-loaded edit-mode only**; item shape `{i,x,y,w,h,minW,minH,static}` IS the persistence schema (F7's `DashboardLayout`). View mode ships ZERO grid JS. `PageContainer variant="fluid"`. **[PARALLEL-SAFE]**
- **CD4 — builder UX (5-step loop):** read-only default → explicit Edit mode (sticky Save/Discard/Reset, unsaved-changes guard, `<Can>`-gated) → Add from curated gallery → per-widget config Sheet → drag/resize → explicit Save. Keyboard-operable move/resize (roving tabindex + arrow keys) + non-drag "move" buttons (WCAG 2.5.7). Per-role immutable defaults (analyst/manager/auditor/admin) with clone-to-customize on first edit via org←user cascade + `CustomizationConfig.default_dashboards`. **[PARALLEL-SAFE]**
- **CD5 — routes + persistence.** `api.dashboards.{list,create,update,remove,clone}` (F2 scaffold); backend routes `require_auth` + `require_permission('metrics','view')`, never-raise, server-side widget-type allowlist on PUT, cap dashboards/user + widgets/dashboard, debounce ~500ms. New `dashboards` PageId + route appended to `nav.ts`/registry (AFTER Sett-B). **[SERIALIZE: nav.ts append after Sett-B]** `@dnd-kit` added ONLY if a non-RGL drag surface ships.
- MVP = 3-5 widgets; defer sharing/ACLs, cross-filtering, import/export.

- CONTRACT: #3 (layout advisory, never feeds `decide()` — `metrics.py:165-172`), #9 (titles/labels plain-text/SVG, allowlist-validated), #10 (calm read-only default). Widget name is UNTRUSTED — never `dangerouslySetInnerHTML`.
- BREAKS + MIGRATE: G7 has NO existing test surface — all NET-NEW (registry reconcile, RGL lazy-load, allowlist reject, DASH sentinel handling, keyboard move).
- ACCEPTANCE: `pytest -q` green (store round-trip, allowlist reject, never-raise); `vitest run` green; operator creates a dashboard, adds 3-5 widgets, drags (mouse+keyboard), saves, reloads persisted per-user; read-only default = one `DashboardDataProvider` fetch (no extra round-trips).
- DEPENDS ON: W0-F (F7 DashboardStore + `UserPrefs.dashboards` + misc fix), Dash-A (three-zone patterns), W0-C (PageContainer fluid).

## Loose coupling (G8) **[mixed — FE registry serial on shared files; backend router split one-slice-per-PR serial]**

- **Coupling-A — `useNavigate()`-only.** Delete `onNavigate` prop-drilling across ~31 pages (Cases/Audit already show the fallback `onNavigate ?? route.navigate`). Expose `api` via `useApi()` context for test injection. Replace `renderPage` switch + lazy table with the F3 `FEATURES[]`-derived registry. Preserve `NavOpts` in-memory semantics + `HIDDEN_ROUTE_IDS`/`PAGE_IDS` + TabbedPage `NavOpts.tab` round-trip. **[SERIALIZE: App.tsx (after W0-C, Dashboard, G7 routes)]**
- **Coupling-B — adopt `useAsync`/`errorMessage`/`LoadError`** (W0-B B5) across the ~29 hand-rolled load/error pages (start Baseline/Campaigns/Tuning/BatchJobs). Kills 25 error copies + 3 idioms. **[PARALLEL-SAFE by page batch]**
- **Coupling-C — invert layering inversions:** move trapped editors (`RoleMatrixEditor`, `TemplateEditor`, `SessionsTable`, config editors) from pages→`components/`; shell components stop importing `pages/*.api`. Enforce with `eslint-plugin-import-x` `no-restricted-paths` (dev-dep, warn→error per feature). **[PARALLEL-SAFE]**
- **Coupling-D — split `CaseDetail.tsx` (4210)** into its conceptual panels (header/trace/thread/tasks/related/close-dialog — several extractions exist). **Contract `{caseId, onClose, onNavigate?}` FROZEN** (4 hosts + `route.opts.caseId`). Close-with-disposition keeps POSTing through `decide()` (#3). **[DEDICATED workstream, visual-review gated; owns CaseDetail.tsx]** Update `CaseDetail.tabs.test.tsx`/`CaseDetail.live.test.tsx` `readFileSync` targets + `bundle-first-paint.test.ts` (keep lazy imports lazy).
- **Coupling-E — split `routes.py` (4751) one feature per PR.** Paths byte-identical (webui contract untouched). Run `pytest` (≥1461) + `test_route_auth_coverage` after EACH slice (every non-GET keeps `require_permission`). Upgrade the `main.py` loader to sorted, raise-on-failure auto-discovery. **[SERIALIZE: routes.py — one slice per PR, sequential]**
- **Coupling-F — entry-point registry + openapi codegen.** Extract one generic `EntryPointRegistry[T]` (collapses ~120 LOC dup); add discovery to notifications (`tlsoc.channels`) + LLM providers via stdlib `importlib.metadata`. Give `poller_manager`/`reset` a narrow `Protocol` instead of whole `AppState`; promote 3 setter-injected pipeline collaborators to optional ctor kwargs; route OIDC-state + `_real_audit` through public accessors. Add `response_model=` to ~10-15 highest-churn endpoints; `openapi-typescript` (dev) generates request/enum types; commit `openapi.json` + generated file; CI `git diff --exit-code` gate (mind Pydantic-v2 `Optional`→`anyOf[...,null]`). **[PARALLEL-SAFE backend modules; SERIALIZE the openapi gate setup]**

- CONTRACT: `_wire()` ordering preserved (load-bearing for #6 cost-ledger); demo/real store split untouched; `decide()` untouched; Login stays eager + framer-motion-free.
- BREAKS + MIGRATE: `bundle-first-paint.test.ts` + `CaseDetail.*.test.tsx` `readFileSync`/`path.resolve` targets; NavSidebar aria assertions preserved. Backend `test_route_auth_coverage` is the router-split gate.
- ACCEPTANCE: `pytest -q` green after each router slice; `test_route_auth_coverage` green; `npm run build` clean; `vitest run` green; CI drift gate green; onNavigate prop gone; both god-files split.
- DEPENDS ON: W0-B, W0-F (F3 registry). Coupling-A after Dashboard + G7 routes exist. Coupling-D independent workstream.

## Bug batch — the confirmed 14 (each with a NET-NEW regression test) **[distributed across waves]**

UI bugs ship in the wave that touches their surface; backend/misc bugs ship in Coupling.

| # | Bug | Ships in | Fix summary |
|---|---|---|---|
| 1 | Auto-close edits dead field | **Rules R1** | Point at `prefs.auto_close.false_positive` + TP opt-in + lock needs_human; prove via F4 preview. |
| 2 | KpiTile delta color-by-sign | **W0-D D1** | `goodDirection` prop. |
| 3 | Wizard demo toggle cosmetic | **W0-F / Wizard batch** | Call `POST /api/demo/enable/disable`; stop writing dead `demo_mode`; hide if non-admin. |
| 4 | Clipboard fails over HTTP | **W0-F F2** | Route both sites through `lib/clipboard.ts copyText()`; show "Copied" only on truthy. |
| 5 | `misc` prefs clobber | **W0-F F6** | Deep-merge via `kv_mutate`; flip `test_user_prefs.py:323-325`. |
| 6 | Automation `suspicious`/`benign` verdict never fires | **Rules R2** | Populate verdict dropdown from real `Verdict` enum (3); migrate/reject impossible saved rules. |
| 7 | Roles nav/page perm mismatch | **Sett-B / Rules R9** | Unify nav + page on the same resolvable grant. |
| 8 | One-click destructive close no confirm | **Codemod CM7 / Cases** | Route through `ConfirmDialog`; keep close via `decide()`. |
| 9 | Campaigns "Recorrelate" gated by READ | **Coupling / Campaigns** | Gate on manage/admin; disable-with-tooltip for read-only. |
| 10 | Dead `api.setup.initAdmin` 404 stub | **W0-F F2** | Delete the stub. |
| 11 | `request_approval` automation dead end | **Coupling** | Wire the approval kind so it round-trips (prefer) or remove the action. |
| 12 | `TuningLedgerRow` always "Active" | **Rules R5 / Coupling** | Render real per-row state from the ledger. |
| 13 | SQL `sort_field='risk_score'` no-ops | **Coupling-E** | Map to the real column (or reject unknown sort). +regression test. |
| 14 | `derive_priority` disagrees chip vs shift report | **Coupling** | Single source of truth for `engine/priority.py`; both consumers call it. +agreement test. |

## A11Y-PASS (G9) **[PARALLEL-SAFE — additive on already-migrated surfaces]**

- jest-axe assertions on load-bearing surfaces (Settings, a rule editor, a custom dashboard, Cases, Overview). `<Field>` sweep for the ~39 unlabeled controls (clustered in G6 rule builder). Non-color `SEMANTIC_ICON` verified everywhere. Keyboard-only + NVDA/VoiceOver spot-checks on Settings/rule editor/dashboard. Reduced-motion ON manual pass (spinners spin, dialogs fade, charts static). Both themes eyeballed on a dense table + CaseDetail.
- ACCEPTANCE: contrast checker + token-existence checker green; jsx-a11y warn→error passed; jest-axe clean on the 5 surfaces; the 4 WCAG-2.2 criteria met.
- DEPENDS ON: W0-E foundation + all feature waves (surfaces must exist).

## GATED / conditional (G6 Phase 3 + deliberate deps) **[PARALLEL-SAFE — each flag-gated + lazy]**

- react-querybuilder v8 (flag-gated + lazy, nesting≤3, OCSF-typed fields, official shadcn registry) for nested AND/OR exceptions. pySigma (backend-only Sigma import/export). Optional lazy CodeMirror 6 raw-YAML escape hatch (never Monaco). `@tanstack/react-table` under `DataTable` (deliberate wave, API unchanged) + `@tanstack/react-virtual` for Cases/logs when sets grow. `@dnd-kit` ONLY if a non-RGL drag surface ships (implies the 2.5.7 non-drag alternative).
- ACCEPTANCE: each dep lazy-loaded (bundle-first-paint test proves it stays off the hot read path); default read bundle bytes unchanged.

## G10 — second polish pass + adversarial audit + docs **[final]**

- Visual rhythm sweep (spacing/elevation/padding consistency); empty/error/loading consistency via `LoadError`/`EmptyState`/skeletons; micro-copy + terminology one-verb-per-concept (extend `prefs.tsx` DEFAULT_TERMS: event/detection/detection_rule/alert/case/campaign/case_automation/correlation/suppression/verdict/disposition; route top-traffic labels through `useTerm()` — NEW keys, never repurpose existing; wire keys byte-identical). Adversarial audit (mirror Round-4's 16-dimension pass). Update `CLAUDE.md`/`HANDOFF.md`/`README.md`/`ROADMAP.md`/`CHANGELOG` + this `IMPLEMENTATION.md` + Journal.

---

# ORCHESTRATOR CHECKLIST (drive top-to-bottom)

**Wave 0 (serial where marked; everything else blocks on it):**
- [ ] W0-Z Z1 `PAGE_TITLE` constant (3 files, lockstep) → Z2 data-testid anchors → Z3 neutralize class/hex specs — **vitest green**
- [ ] W0-A [SERIAL, 1 agent] fonts + Radix tiers + 3-axis palette + chart ramps + shadow/radius + label→token authority + AA guard + fix false AA comments — **build clean, both-theme snapshots, contrast checker green**
- [ ] W0-B [PARALLEL] recipes, Card props, control primitives, typography, hooks, LoadError/errorMessage, variant additions — **primitive specs green**
- [ ] W0-C [SERIAL AppShell/App.tsx] PageContainer + kill max-w-[1400px] + MotionConfig + reduced-motion upgrade + `--header-h` — **responsive test green**
- [ ] W0-D [SERIAL PageHeader/HeroPanel/KpiTile] `goodDirection` (#2) + hero merge (G5) + RiskGauge shrink — **KpiTile direction spec green**
- [ ] W0-E [PARALLEL] SEMANTIC_ICON wiring + 4 WCAG-2.2 + live announcer + CI gates (token-existence, contrast, no-arbitrary-text, no-hex, CVD) + jest-axe/jsx-a11y — **gates green**
- [ ] W0-F [SERIAL types.ts→api.ts→nav.ts; PARALLEL backend] mirror config types, api scaffolds, FEATURES[] behind exports, preview-decision endpoint (#3 parity), config endpoints, misc-clobber fix (#5, flip test), DashboardStore infra + `UserPrefs.dashboards` — **pytest net-new green, decide() byte-identical**

**Feature waves (fan out; disjoint files):**
- [ ] Codemod [PARALLEL by page batch, exclude CaseDetail] cards/buttons/segmented/badges/text/errors/confirm/kpi-directions — **per-batch vitest gate**
- [ ] Settings [DEDICATED] Sett-A registry decompose → Sett-B IA regroup + Security promo + dup-home collapse + redirects → Sett-C schema fallback + deep-link fixes — **redirect test, ≤2 levels, no god-file**
- [ ] Dashboard [PARALLEL] Dash-A Overview compact+un-nest+kill client math → Dash-B three-zone+TimeRangePicker → Dash-C Metrics/Cases density — **hero ≤64px, wide width, skeleton lockstep**
- [ ] Rules G6 [auto-close R1 FIRST] → Detection&Rules home + flat builder + NumberField/LabeledSlider + preview(no-LLM)+ledger+shadow → asset/SLA/priority/suppression → schema fallback (share Sett-C) → zod+MITRE → RBAC unify — **preview parity, editors end-to-end, net-new tests**
- [ ] Custom-Dash G7 [PARALLEL after W0-F+Dash-A] registry+ChartCard → DataProvider → WidgetGrid+RGL(lazy) → builder(keyboard)+role defaults → routes(allowlist,never-raise)+nav append — **create/add/drag/save/reload, net-new tests**
- [ ] Coupling G8 [mixed] useNavigate(A) + useAsync/LoadError(B) + invert layering(C) + split CaseDetail(D, visual-review) + split routes.py one-slice-per-PR(E, auth-coverage each) + entry-points+openapi(F) — **auth-coverage green each slice, CI drift gate**
- [ ] Bug batch: #1(R1) #2(D1) #3(F/Wizard) #4(F2) #5(F6) #6(R2) #7(Sett-B/R9) #8(CM7) #9(Coupling) #10(F2) #11(Coupling) #12(R5) #13(E) #14(Coupling) — **each a net-new regression test**
- [ ] A11Y-PASS jest-axe + Field sweep + keyboard/AT + reduced-motion + both-theme eyeball
- [ ] GATED react-querybuilder + pySigma + CodeMirror + react-table/virtual + dnd-kit(iff) — **all lazy, hot bundle unchanged**
- [ ] G10 polish + terminology + adversarial audit + docs + Journal

**Every commit, every wave:** `pytest -q` (≥1461+) · `npm run build` clean · `vitest run` (≥273, both themes) · `npm run lint` (0 rules-of-hooks) · `git diff --exit-code case_manager.py` empty (#3) · `PUT /api/settings` round-trip proves deep-MERGE (no sibling wiped) · deep-links + wire keys byte-identical · `types.ts` ⇔ `models.py` · docs + Journal updated.

---

*Round 5 implementation plan. Grounded in the live repo (2026-07-01) + PROPOSAL.md +
DESIGN_STANDARD.md + understand/{EXECUTIVE_SUMMARY,AUDITS} + RESEARCH_SUMMARY + domain docs.
Every wave additive + reversible; `case_manager.decide()` byte-identical; the 12
non-negotiables held.*
