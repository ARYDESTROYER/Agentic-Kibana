# Round 6 — Fleet glitch-hunt + integration polish (2026-07-02)

## Mission

User re-issued the Round-5 brief with a screenshot of the post-Round-5 **Dashboards
page glitching** (widgets stacked in one cell, a clipped edit control, ~90% of the
screen empty) plus "a tonne of UI glitches, fix them". Round 5 was complete, so
Round 6 = **audit the entire app with a large Opus agent fleet, adversarially verify
every finding, fix everything at root cause, and fill the genuine gaps** (the
beginner auto-improvement journey).

## Method (fleet architecture)

1. **Audit fleet** — 155 finder units: every webui source file (253 files in ~139
   grouped units) + 12 thematic deep-dives (dashboard packing, page chrome,
   settings IA, rules UX, theme tokens, overflow/responsive, z-index layering,
   loading/empty/error states, nav registry, charts, forms/dirty-state, beginner
   onboarding) + 4 frontend↔backend API-contract audits. Every unit's findings were
   re-verified by an adversarial second agent (critical/high individually; medium/
   low deferred to their fixer's verify-first step). **466 claimed → 464 verified**
   (21 high / 240 medium / 203 low after calibration; 2 refuted).
2. **Fix fleet** — findings partitioned into **30 conflict-free batches** (each
   batch exclusively owns its files; >24-finding batches staged sequentially).
   37 Opus fixers: verify-first, root-cause fixes per the Round-5 design standard,
   regression tests mandatory, scoped tsc self-checks, foreign-file needs reported
   as handoffs. **379 fixed, 32 refuted at fix time, 54 handoffs, 167 tests.**
3. **Handoff fleet** — 6 dependency-ordered packages (API helpers → dashboards;
   backend contracts → frontend consumers; settings IA; secret fields; component
   consistency; CaseDetail mounts) + a solo page-width sweep + a closer agent that
   drove the repo to fully green. **44 more fixes, 55 more tests.**

Total: ~500 Opus agent invocations, ~28M subagent tokens, across two session-limit
interruptions (workflows resumed from cache both times).

## Headline fixes (of 423 applied)

- **The screenshot bug:** `buildDefaultWidgets()` emitted `x:0,y:0` for every
  widget; view mode renders persisted coords in a plain CSS grid (no RGL
  compaction) → all default widgets stacked on one cell. Fixed with a pure
  deterministic `packWidgets()` in `layout-utils.ts` (applied in view mode, seeds,
  and edit-mode entry so view↔edit geometry is identical) + **curated per-role
  default layouts** that fill all 12 columns (KPI row on top, tables/charts below).
- **Broken actions:** CaseDetail thread-edit + task-patch sent PUT to PATCH-only
  routes (always 405) — added `api.patch`; bulk "Add tag" no longer rides the
  acknowledge action; rules Test/Preview 422 fixed (limit 1000 → server cap 200).
- **Dead features made real:** anomaly/baseline-tier rule Save no longer silently
  discarded; the **rule version ledger now records** (hooked into the settings-save
  path) so G6 diff/rollback is live; cost-budget widget permission fixed
  (`cost:read` → `cost:view`); the built-but-unmounted baseline gauge + campaign
  chips now ship on CaseDetail.
- **Data-loss fixes:** per-source connector secrets (Kafka/S3/SQS/Azure/GCS) no
  longer dropped on save; second Elastic source no longer clobbers global creds;
  org-theme save no longer wipes sibling org customization; Roles edit/clone no
  longer opens a blank matrix that could wipe grants; one **SecretField** primitive
  everywhere (an empty save can never clobber a stored secret).
- **Layout/width:** PageContainer is the single width authority (double gutters
  removed); every bare page wrapped (`wide` variant); TabbedPage hosts aligned;
  NavSidebar collapsed-rail flyouts unclipped; Approvals/Cases sticky bulk bars
  fixed; Dialog/Dropdown/Sheet internal scroll so nothing renders unreachable.
- **Honest numbers:** KPI delta arrows on lower-is-better metrics (MTTA/MTTR/
  FP-rate), Cost KPI arrow, close-vs-arrival >100%, `fmtMoney` symbols ("$0.05"
  not "USD0.0500").
- **A11y/theme (WCAG AA both themes):** dark `--critical` fill 4.71:1, alert
  variants, focus ring at full opacity, SegmentedControl radiogroup semantics,
  slider thumb labelling, 19+ combobox names, FOUC on dark load fixed.
- **Beginner journey (new feature):** `AutomationNudge` — a one-click "recommended
  automation" card (wizard final step + dismissible Overview nudge when ≥1 source
  is live and tuning/baseline are OFF) enabling threshold-tuning + baseline +
  campaign correlation with conservative bounds; suppression DROPs stay HITL; #3
  untouched. Plus window-scoped `GET /api/cases?from/to` so Overview's
  TimeRangePicker really filters, and severity KPI → filtered-Cases drill-downs.
- **Perf/UX:** search inputs debounced (Audit/SourceLogs/UnifiedLogs), dashboard
  explicit Save is immediate while drag streams stay debounce-coalesced,
  DashboardDataProvider gained visibility-aware 60s refresh + manual refresh.

## Wire-compat

`engine/case_manager.py` untouched. All API paths byte-identical. Additive only:
PATCH usage on already-PATCH routes, optional `from`/`to` on `GET /api/cases`, raw
custom-role definitions on `GET /api/roles`, per-provider SSO `configured` map
(old boolean kept), optional `CaseAutomationRule.name`.

## Green baseline (verified independently, 2026-07-02)

- backend: **1613 pytest** passed (was 1601; +12 incl. contract + time-bomb fixes)
- webui: **1051 Vitest** specs / 199 files (was 625/98); build clean, entry
  **281.61 kB** (gzip 83.1); eslint **0 errors** (3 warnings, was 4); design-gate
  regenerated (violations reduced) + route_auth_coverage green
- zero new runtime deps; no `package.json`/`requirements` changes

## Deferred (small, non-blocking)

- Rename the nav child "Dashboards" → "Custom dashboards" (needs an atomic
  registry+test rename; consistent as-is).
- Consolidate `Tuning.api.ts` / `automation.ts` local config helpers onto the new
  `api.tuning` client (they coexist correctly).
- Space Grotesk is not self-hosted; the branding "grotesk" choice falls back to
  Inter Variable (honest fallback documented).
