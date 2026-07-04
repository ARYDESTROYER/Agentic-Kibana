# Round-7 UI/UX Overhaul — Locked Decisions & Scope

> Source of truth for all Round-7 agents. Read this + `TESTING_BRANCH_STATE.md` before any work.
> Non-negotiables from `CLAUDE.md` still hold — especially **#3** (`decide()` is the sole
> close/escalate authority; never regress it), **#2** (audit), **#6** (one LLM ledger),
> **#9** (untrusted log/source text fenced). All new work is ADDITIVE and must keep the
> green baseline (`pytest` + `webui build` + `vitest` + `eslint`).

## User-confirmed product decisions (2026-07-05)

1. **Rename the landing/dashboard page** "Security Posture Dashboard" → **"Security Command Center"**
   (`Overview.tsx` `PAGE_TITLE`). Keep the `Radar` icon; the eyebrow already says "Security Command Center".
2. **MTTD/MTTR:** there is NO real Mean-Time-To-Detect in the backend. Do an **honest rename +
   `(?)` tooltips** — consistent **MTTA / MTTR / Dwell (time-to-first-response)** labels across
   Overview + Metrics, each with a HelpTip explaining the exact formula. Do NOT fabricate an MTTD.
3. **Noise-Reduction funnel (feature request):** build **durable raw-alert-by-severity counters**
   at ingest — a true "total alerts by severity → what the AI reduced it to" funnel. New backend
   counter store + increments in the ingest/poll paths + an aggregation endpoint + severity bucketing.
4. **Infographic name:** **"Noise Reduction"** (headline value-prop; shows how much the AI cut the load).

## The 12 UI changes + 1 feature (mapped to current-state findings)

| # | Ask | Key finding / approach |
|---|-----|------------------------|
| 1 | Active Risk Index → top-right + `(?)` explaining the math | Two conflicting "Active Risk Index" numbers today (Overview blend vs raw mean). Unify + move to top-right of the Command Center; reuse the per-case `HelpTip`/`RISK_HELP_TEXT` pattern (`CaseTriageHeader.tsx`). |
| 2 | Rename "Security posture dashboard" | → "Security Command Center" (decision #1). `Overview.tsx:97 PAGE_TITLE`. |
| 3 | Make the dashboard extremely clean (QRadar/Splunk inspiration) | Rework Overview 3-zone layout; tighter grid, clearer hierarchy, real charts (recharts already bundled). |
| 4 | MTTD & MTTR formula with `(?)` | Honest labels + tooltips (decision #2). `Overview.tsx timing`, `Metrics.tsx PerformanceTab`, unify the 3 conflicting dwell names. |
| 5 | Animations, clearer UI | Extend motion primitives (`Stagger`, `LoadingBar`); respect `prefers-reduced-motion`; add subtle enter/count-up/transition animations. |
| 6 | ~25% of the main page is a name card — make it space-efficient | Could NOT find a 25% name card in current `Testing` code (Overview hero ~64–80px; Dashboards header ~52px). Compact ALL headers regardless; await user screenshot to target the exact culprit. |
| 7 | Expand the top-nav search horizontally | `NavSidebar.tsx` / `CommandPalette` — widen the search affordance in the top bar. |
| 8 | Make the Cases list more appealing | `Cases.tsx` — visual polish, better density/badges. |
| 9 | Case view is cluttered/confusing; tell it like a story; SIEM data first, then AI; show WHO graded severity (AI vs SIEM) | **CaseDetail has 8 tabs; MITRE ×3, risk breakdown ×2, verdict in ≥5 places.** Consolidate into a story spine (the 6-stage Timeline is the seed). Add a shared **`source \| ai \| code` provenance tag** to every chip/badge. **Fix the real bug:** Cases "Severity" & "Severity (AI)" columns render the identical `risk_score`, both mislabeled. |
| 10 | Feedback collected at close, not its own tab | Fold `FeedbackPanel` grading into the close dialog (`ConfirmActionDialog`); keep the two POSTs separate (#3). Drop the standalone Feedback tab (keep aggregate in Metrics). |
| 11 | Show "Auto-closed" when AI closes | No `auto_closed` field. Correct predicate: `status∈{closed,resolved} && decision_by==='agent'`. Add badge; remove dead `'auto'`/`'auto_closed'` checks. |
| 12 | Overall: reduce clutter, add/fix animations, very clean UI | Cross-cutting polish pass. |
| ★ | Feature: Noise-Reduction funnel infographic | Decision #3/#4. Durable raw-alert-by-severity counters → funnel → "reduced by N%" hero on the Command Center. |

## Non-negotiable guardrails for every Round-7 change
- `engine/case_manager.py` `decide()` stays **byte-identical**. New counters/aggregations never feed it.
- New ingest counters must not slow or break the poll/ingest path; fail-open, additive.
- Every attacker-influenceable string stays fenced/plain-text (#9).
- Keep `pytest` / `webui build` / `vitest` / `eslint` green; add tests for new logic.
- Fix the pre-existing `StageTimeline.tsx` design-gate failure (2 off-scale text sizes) as part of #9.
