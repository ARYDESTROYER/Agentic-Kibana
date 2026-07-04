# Round-7 Design Direction — distilled from 25-agent UX research

> The actionable, convergent guidance from studying QRadar, Splunk ES, Sentinel, Chronicle/SecOps,
> Elastic Security, CrowdStrike Falcon, and Cortex XSIAM/XSOAR. Full detail: `UX_RESEARCH.md`.
> Every recommendation here is achievable with ZERO new npm deps and respects the 12 non-negotiables.

## The one principle that answers item #9 (every vendor agrees)
**3-lane separation, never interleaved:**
1. **FACTS** — SIEM/source-asserted + deterministic engine data (what fired, from where, source severity, risk math). Neutral styling, drill-to-evidence, `#9`-fenced. Leads the story.
2. **AI ASSESSMENT** — verdict/confidence/reasoning. ALWAYS visually marked (icon + distinct tint), labeled "AI". Verdict + confidence as a *structured* badge separate from the reasoning prose.
3. **DETERMINISTIC DECISION** — `decide()` output. Its OWN, most-prominent, pinned card (this is the authority per #3).

→ CaseDetail becomes a clean story: a zero-cost deterministic **reason line** at top ("Alert {sig} on {host} by {user}, N correlated events") → FACTS → AI ASSESSMENT → the pinned DECISION card. Give the AI lane a persistent marker; never blend AI prose into the fact stream or human thread.

## Convergent rules (apply everywhere)
- **Never show a composite score without its breakdown one click away** (risk/severity/priority). We already compute the breakdowns — add a drill-in popover/hover-card.
- **Every tile/row/funnel-stage is a drill-down launchpad** into a pre-filtered Cases list. One consistent destination.
- **Single-source severity/risk** — list, detail, KPIs, dashboard all read the SAME computed field (`engine/priority.py`), never recompute. (Elastic shipped a real bug from duplicating this — add a regression test asserting list vs detail render identical severity/priority for one case.)
- **Percentiles, not just mean** for MTTA/MTTR (show p50 + p90). Already computed.
- **Provenance is never hue-only** — the VERDICT axis reuses SEVERITY hues, so add an explicit "AI" microlabel/glyph beside verdict (item #9b `ProvenanceTag`).
- **Rich list-view infographics MUST ship with a per-user hide toggle + degrade at 1280–1440px** (the QRadar 7.5 backlash). Wire the toggle through the existing `UserPrefsStore`.

## Noise-Reduction funnel (feature ★) — how to make it credible
- **Live, per-tenant, drill-downable** — not a static marketing graphic. Every stage clickable into filtered Cases.
- Stages mapped to OUR real pipeline: **Ingested (by severity) → Correlated into clusters → Cases opened → decide(): Auto-cleared FP / Escalated / Needs-human / True-positive.**
- Show **absolute counts AND %-retained** per stage (and, where cheap, $ saved from the cost ledger — a real differentiator).
- **Distinct icon for deterministic vs LLM stages** (reuse the TraceTimeline vocabulary) — operationalizes #3 as a visible signal.
- Headline: a **live reduction %** ("Noise reduced by N%"), honest framing (don't overclaim).
- Build as **one inline SVG**, stages staggered left→right via the existing `Stagger` delay-step; count-up each stage synced to its own reveal.

## Risk index / gauge (item #1)
- **Exactly ONE gauge per screen** (hero), never in a table row (use flat chips/bars for N-item comparison). Keep the current semicircle arc-fill + centered numeral + band label — do NOT add needle/ticks/donut.
- Add a **delta/trend beside** the gauge (level ≠ trend; trend is what a header-scanner needs). Reuse KpiTile delta util.
- Add a **threshold notch** on the track at the auto-escalate boundary + a **HelpTip** spelling out bands ("Critical ≥74 · High ≥48 · Medium ≥22 · Low <22") — this IS the (?) the user asked for.
- Canonical ARI = mean deterministic `risk_score` over OPEN (non-terminal) cases (backend `active_risk_index`). Do NOT reuse the gauge for AI confidence (confidence = a pill in the AI lane).

## KPI strip (item #3)
- **4–5 primary "signal" tiles** (Open / Critical-High / Escalated-to-human / FP-rate), demote the rest (Total/Artifacts/Knowledge/Spend) into widget rows below. 7-tile flat row reads as "a pile of stats."
- **Wire the delta arrows** — `usePosture(hours,'prev')` already returns `compare` (case_count/escalation_rate/false_positive_rate); populate `KpiTile.delta` from it (arrow = true direction, color = good/bad, not sign).
- State the comparison window **once per row**, not per tile. Optional sparkline slot gated at ≥5 real points.
- Keep calm: no full-card color fills except genuine breach states. Every tile keeps color+icon (already done — a superiority over Splunk's color-only).

## Cases list (item #8) — dormant-code wins
- **Wire `rowAccent`** (already built in `DataTable.tsx`, invoked nowhere): a 3px left severity band → scan severity down the margin. Highest-leverage, lowest-effort.
- **Wire the `sticky` header** (already built on `ui/table.tsx TableHeader`, dead from Cases' view) — but fix the offset to `top-[var(--header-h)]` (not `top-0`) so it parks under the app bar, not behind it.
- **Collapse the 7 overlapping "how bad/how sure" columns** (Severity, Severity(AI), Risk, Confidence, Verdict, Disposition, Urgency) → ONE dominant Priority signal + curate the default visible set to ~7-8; hide the rest by default (reversible via ColumnsMenu). **Drop the bogus "Severity (AI)" column** (there is no AI severity — it renders identical `risk_score`; the AI output is Verdict/Confidence, already columns).
- `tabular-nums` on RiskBadge/ConfidenceBadge. Optional pin-left for Case ID.

## Feedback into close (item #10) — the smart pattern
- **Derive agree/disagree automatically** from the disposition-vs-verdict diff — NO separate "I agree" button (avoids automation bias; keep disposition unset-by-default). Show a live inline badge "Matches AI verdict" / "Overrides AI verdict (FP → TP)".
- **Only on a mismatch**, reveal one optional line: "What did the AI miss?". Keep the 3 stars behind a "Rate in detail →" disclosure so a routine close stays a 2-second action.
- In `runAction`, fire `api.caseFeedback(...)` as a non-blocking side-effect alongside the existing action POST (two separate calls, #3 intact). Skip when no verdict (NEEDS_HUMAN) or cancelled.
- Retire the standalone Feedback tab (keep aggregate in Metrics + a read-only "prior gradings" history). Optionally compute an IMPLICIT whole-fleet agreement (verdict vs disposition across all closed cases) as the headline calibration number (the opt-in sample is biased).

## Motion (items #5/#12) — subtle, purposeful, reduced-motion-safe, ZERO new deps
- **Formalize `ease-premium` = cubic-bezier(0.16,1,0.3,1)** + wire the existing `--motion-fast/base/slow` tokens into Tailwind duration/easing utilities (one app-wide dial).
- **useCountUp** (~30-line rAF hook): 400–600ms, tween prev→new (never 0→N), animate only on TRUE value change (diff via ref), skip when `document.hidden`, run through the same formatter, **integers only** (exclude money/%), announce once via `useLiveAnnouncer`. **Explicitly branch on `usePrefersReducedMotion()`** — the CSS reset does NOT cover JS tweens. Opt-in prop on KpiTile.
- Fix `charts.tsx` blanket `isAnimationActive={false}` → **mount-only draw-in** keyed on filter/time-range change (never replay on the 60s poll).
- Hover lift **2px** (not 8px) on clickable tiles/cards; reuse the `shadow-elev1` token. **No spring/bounce on badges. No confetti on close.**
- Gate case-open reveals on `key={case.id}` (replay on case switch, not on poll).

## Color/a11y (items #5/#9b/#12)
- **Extend `gate-contrast.mjs` + `gate-cvd.mjs`** to cover severity/status/verdict tokens (not just `--chart-*`); make CVD a permanent CI gate. `--medium` likely fails 3:1 on light (~2.97:1) → nudge lightness.
- Never abut two severity fills without a 1–2px stroke/gap (pairwise band contrast is ~1:1). Keep severity color ONLY in the per-row badge, never a full-row wash. Keep green scoped to STATUS only (severity low = blue).
- Independently-authored per-theme severity values (already the Round-5 approach — validate, don't HSL-invert). Brand accent ≠ critical color.

## Header compaction (item #6)
- One compact header pattern (~52–68px): primary controls (time range/refresh/CTA) in `PageHeader.actions`, status/stat chips in `PageHeader.meta`; NO second full-width control band under the header. Hero title `text-xl` (was 2xl); line-clamp descriptions. (Await user screenshot for the exact "25% card" culprit; compact all headers regardless.)

## Top-nav search (item #7)
- Replace the small Cmd-K "Search" button with a wider input-styled trigger (`flex-1 max-w-md lg:max-w-lg`, `bg-background/60` over the glass header) that still opens the CommandPalette; add a `sm:hidden` icon opener for mobile; distinct accessible names for jsdom.

## Anti-patterns to avoid (from real vendor backlash)
- Black-bg/white-text-only "dark mode" (QRadar eye-strain complaint) — validate small chip/table legibility in both themes.
- Opaque scores with no breakdown (Splunk/Cortex both shipped follow-on features to fix this).
- Color-only signaling; red/green severity; full-row severity washes ("traffic-light overload").
- Animation replaying on every poll (reads as a glitch, erodes trust).
- Node-link investigation graph as the DEFAULT case view (opt-in only).
- Rich infographic on a list view with no hide toggle + no laptop-width testing.
- Client-side filtering of unbounded lists (flag the 200-row cap; server-side when >~1000).
