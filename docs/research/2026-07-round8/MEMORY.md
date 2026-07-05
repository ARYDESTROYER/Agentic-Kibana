# ROUND 8 — SAVIOR MEMORY (delete when done)

> Working memory in case context auto-compacts. Branch: **feature/round7-ui-overhaul**.
> Round 7 shipped + green (last commit 7355a9a). This round = UI-cleanup + glitch fixes from user feedback.

## META-RULES (from the user, this round)
- **Research tasks = ONLY sonnet 5.** Plan = opus ok. Implement/test = opus 4.8. Counts: ≥10 plan, ≥25 research, ≥30 implement/test.
- **NO co-author.** Commits human-authored (`Aryan Pawar <littlemasteraryan@gmail.com>`), **SUPER short 2-3 lines**.
- Follow same process: plan → research → plan → implement → test → fix → test → brief → ask to raise PR.
- Keep this MEMORY.md updated; **delete it when the task is done.** Update all real docs too.
- UI cleanliness is the headline. User feels the overhaul isn't visible yet — make it VISIBLE + fix glitches.

## THE 8 ASKS
1. **Risk index buggy** (gauge renders glitchy — "8/100" cramped, notch overlaps). Put it back in **its OWN individual card, top-right** (Round 7 moved it into the header actions, size 64 — revert to a distinct card top-right).
2. **Cases page UI severely glitched** — fix ASAP (sticky header/rowAccent/columns look broken in the screenshot; header row cut off, orange bar odd).
3. **Leave the Investigation/timeline tab ALONE.** Clean up the OTHER CaseDetail tabs (Overview, Threat, Collab, Chat).
4. **"Still don't see any UI cleanup/overhaul"** — make the cleanliness VISIBLE + impactful.
5. **Reinvestigate throws "No events remain for ip … aged out of retained log window."** Fix it — reinvestigate should work from STORED case evidence/events, not re-query the aged-out log window. Bonus: auto-reinvestigate when the model/provider API key is (re)provided.
6. **Chat + Collaboration tabs need cleaner UI.**
7. **Security Command Center header: DON'T use a card** for the title — do it like the Sources page (plain, bigger title/header font). (Risk index keeps its own card per #1.)
8. **Noise Reduction: cleaner, DIFFERENT UI** — inspired by QRadar's horizontal IP-trace/attack-path graph: multiple lines entering from the left, each phase shown, thinning down (fewer/fewer). RESEARCH this (sonnet).

## KEY FILES
- Risk index: webui/src/soc/components/ActiveRiskIndex.tsx, RiskGauge.tsx; mounted in Overview.tsx header actions.
- Cases: webui/src/soc/pages/Cases.tsx (rowAccent, sticky header top-[var(--header-h)], CASES_DEFAULT_HIDDEN), DataTable.tsx, badges.tsx.
- Overview header: webui/src/soc/pages/Overview.tsx (PageHeader hero variant → change per #7); Sources page = webui/src/soc/pages/Sources.tsx (reference for #7 header style).
- Reinvestigate: backend — grep `reinvestigate` in routes; the "No events remain" string; the flow that re-queries logs.
- Chat: webui/src/soc/pages/casedetail/CaseChatPanel.tsx + components/ChatPanel.tsx. Collab: casedetail/CollaborationPanel.tsx.
- Noise funnel: webui/src/soc/components/NoiseFunnel.tsx (redesign) + backend GET /api/metrics/noise-reduction (contract stays).

## GUARDRAILS (unchanged)
Additive; decide() BYTE-IDENTICAL (#3); #9 fencing; ZERO new deps; design tokens + type scale (no raw hex/arbitrary text); keep green (build/pytest/vitest/lint).

## DIAGNOSED ROOT CAUSES (confirmed from code)
- #5 reinvestigate: `_cluster_for_case` (routes.py:3909) re-queries logs, returns None when aged out → 400. FIX = stored-evidence fallback (rebuild Cluster from case member_events/evidence/entity/trigger_reason).
- #1 risk index: RiskGauge notch `<line>` at 74 reads as a stray glitch at size 78; mounted inline in Overview PageHeader actions (no card). FIX = own card top-right, bigger gauge (~120-140), DROP notch.
- #2 cases: `<DataTable sticky rowAccent density=compact>` (Cases.tsx:1318-1343). Sticky header in the overflow-hidden card + page-scroll flow → row peeks above header. FIX = verify --header-h defined + opaque bg + z-index, OR remove sticky.

## PLAN DECISIONS (from the opus plan fleet — full in docs/research/2026-07-round8/PLAN.md)
- #1: ActiveRiskIndex → own `<Card>`, gauge size 128, DROP the notch; Overview masthead = flex-row [plain title | risk card right]. Coordinate #1/#7/#4 (all touch Overview header + PageHeader).
- #2: `--header-h`=56px IS defined; sticky header floats in the overflow-hidden card → **REMOVE `sticky`** from Cases DataTable (Tier1) + optionally delete the dead sticky primitive plumbing (Tier2). Keep rowAccent; status-cell flex-col ok.
- #7 (agent failed): Overview header → plain (NOT hero card) big title like Sources page + risk card top-right (#1). Title-size bump owned once by #4 in PageHeader.
- #8: current = vertical stack of 7 centered bars (reads as a plain chart). Redesign = horizontal QRadar-style flow: severity strands from left, thinning L→R through stages, 4 outcome ribbons; viewBox ~1000x320; keep the §D contract/props. Confirm QRadar specifics from research fleet.
- #3: OverviewPanel renders Verdict/Confidence 2× + Risk 3× → dedupe (remove duplicate HeadlinePanel grid); tidy Threat; LEAVE Investigation.
- #6: CaseChatPanel hand-rolls a 2nd chat impl → reuse ChatPanel (compact, maybe hidePickers prop); tidy Collaboration 2-col.
- #5a: `_cluster_for_case` re-queries logs only → add `allow_stored_reconstruction=True` fallback building synthetic member_events (cap 200) from stored case data; reword the empty-case 400.
- #5b: gateway raises on missing key → case NEEDS_HUMAN/SYSTEM/error. MINIMAL: a one-click "Reinvestigate key-blocked cases" reusing #5a + a default-OFF auto-on-key-save pref. Keep bounded/cost-safe.
- #4/#4b: design system exists but applied timidly. VISIBLE wins: bigger page-title (PageHeader once), enforce spacing rhythm (space-y-6, gap-4/6, kill px-5 + off-grid 5/7/9/10/11), calmer Overview density, card-grammar + badge restraint.

## RESEARCH DECISIONS (full in docs/research/2026-07-round8/RESEARCH.md)
- #2 Cases root cause: DOUBLE-nested overflow — DataTable outer `overflow-hidden` + Table inner `overflow-auto` wrapper traps the sticky <thead> against a never-scrolling ancestor. **FIX (safe, ASAP): remove `sticky` from Cases DataTable** + fix uneven row height (min-h on the status-cell flex-col so the accent bar is uniform). (Proper primitive fix = Table `unwrapped` + outer `overflow-x-auto overflow-y-visible` — deferred, broader blast radius.)
- #8 ribbon: keep NoiseFunnel exported surface (`deriveFunnel`,`FunnelRow`,`NoiseFunnelProps`, data-testids, copy). Horizontal Sankey: ribbonPath(x0,sy0,sy1,x1,ty0,ty1)= `M x0,sy0 C xm,sy0 xm,ty0 x1,ty0 L x1,ty1 C xm,ty1 xm,sy1 x0,sy1 Z` (xm=(x0+x1)/2). ONE global k=plotHeight/topTotal; SEV_ORDER by_severity strands ingested→cases (severity color), fan into 4 outcome ribbons (VERDICT color) at right. drop-off badge on connectors; suppressed/ignored dashed side-spur; gradient strands (survival=opacity); circular ShieldCheck/Bot phase markers; viewBox ~640x220 preserveAspectRatio xMidYMid meet; text as HTML overlay (svg aria-hidden); `ribbon-grow` keyframe (scaleX, transform-box fill-box, 70ms stagger). NO new deps.
- #7 header: Overview drops `variant="hero"` + glow → plain dense band, title `text-2xl sm:text-3xl font-semibold` (route via PageHeader). Card treatment moves ONTO the ActiveRiskIndex card (#1).
- #4 cleanliness (biggest visible wins): PageHeader h1 → text-2xl (outrank card titles); Overview collapse Rows B/C/D into ONE `defaultOpen={false}` "Deeper analytics" DashboardGroup (inverted pyramid); enforce spacing tiers (space-y-6 sections / space-y-4 card-internal); card grammar (no nested cards, DecisionCard wins via accent not shadow); badge restraint on Cases rows.
- #6 chat: replace CaseChatPanel ChatTab body with `<ChatPanel caseId compact starters=…/>` (deletes ~150 lines), wrap in PanelCard. Collab: sticky ownership/tasks rail, swap 5× `text-[0.65rem]`→`text-2xs`, SectionHeading for CaseTasks.
- #3 OverviewPanel: dedupe Verdict/Confidence (2×) + Risk (3×); sentence-case headings; rename 'IOC Indicators'→'Search queries'; EmptyState consistency; group ~13 sections into 2-3 bands. Threat: minor tidy. LEAVE Investigation.
- #1: ActiveRiskIndex→own <Card>, gauge size 128, DROP notch.
- #5a: `_cluster_for_case(..., allow_stored_reconstruction=True)` builds synthetic member_events (cap 200) from stored case fields when the log re-query is empty; reword empty-case 400.
- #5b (minimal): detect key-blocked cases (NEEDS_HUMAN + decision_by SYSTEM + gateway error) → a one-click "Reinvestigate key-blocked" action reusing #5a; default-OFF auto-on-key-save pref (flag if too big).

## WAVE PLAN
- Wave A (parallel, disjoint files): A1 ActiveRiskIndex card; A2 Cases fix; A3 NoiseFunnel ribbon; A4 OverviewPanel dedupe; A4t ThreatPanel tidy; A5 Chat reuse ChatPanel; A5c Collab tidy; A6 reinvestigate #5a; A7 PageHeader title bump + non-Overview consistency; A8 #5b minimal.
- Wave B (after A1+A3+A7): Overview.tsx integration — plain header (#7), ARI card top-right (#1), mount ribbon (#8), collapse deeper-analytics (#4). ONE owner.
- Wave C: QA review fleet + fixes + green baseline.

## PROGRESS
- [x] Diagnose + Plan fleet (wbrgndwi1) → PLAN.md + Research fleet (w0igg4ycp) → RESEARCH.md
- [ ] Wave A implement (opus)
- [ ] Wave B Overview integration
- [ ] QA + fixes + green
- [ ] Implement (opus ≥30)
- [ ] QA review + fixes
- [ ] Green baseline + update docs + brief + PR ask
- [ ] Delete this MEMORY.md
