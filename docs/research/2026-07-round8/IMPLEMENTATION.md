# Round 8 — UI cleanup + glitch fixes (what shipped)

> Follow-up to the Round-7 overhaul, from user feedback (screenshots). Branch `feature/round7-ui-overhaul`,
> commits `58745fa` (Wave A) + `f56f812` (Wave B). Process: plan fleet (opus) → research fleet (**sonnet only**,
> per the user) → consolidated plan → Wave A (10 opus, disjoint files) → Wave B (Overview integration) →
> 10-agent adversarial QA (**0 findings**). Green throughout: build ✓, **pytest ✓**, **vitest 1238/1238**,
> lint 0 errors, `engine/case_manager.py decide()` **byte-identical**, ZERO new deps.

## The 8 asks → what shipped
1. **Risk index glitch + own card.** `ActiveRiskIndex` is now a bordered `<Card>` mounted top-right of the
   masthead; the gauge is sized up (128) and the stray notch tick is dropped (band cuts live in the `(?)` HelpTip).
2. **Cases page glitch.** Root cause = a double-nested overflow (`DataTable` outer `overflow-hidden` + `Table`
   inner `overflow-auto`) trapped the sticky `<thead>` → header scrolled away. Fix: removed the broken `sticky`
   on the Cases table (a clean non-sticky header) + a fixed status-cell `min-h` so rows/accent bars are uniform.
3. **CaseDetail other tabs cleaned (Investigation left alone).** Overview tab deduped (Verdict/Confidence rendered
   2×, Risk 3× → once), sentence-case headings, "IOC Indicators" → "Search queries", consistent `EmptyState`,
   grouped ~13 sections into a few bands. Threat tab tidied for consistency.
4. **Visible cleanliness.** The design system existed but was applied timidly — so we enforced it boldly:
   `PageHeader` title bumped to `text-2xl/3xl` app-wide (now outranks card titles), Overview collapsed into an
   inverted pyramid ("Deeper analytics" `defaultOpen={false}`), and a spacing-rhythm normalization pass across 12 pages.
5. **Reinvestigate error fixed.** `_cluster_for_case(..., allow_stored_reconstruction=True)` rebuilds a cluster
   from the case's STORED evidence (synthetic member events, cap 200) when the log window aged out, so reinvestigate
   works offline of live logs. Empty-case 400 reworded. `decide()` untouched. (#5b auto-on-key: default-OFF pref
   seeded; full auto-trigger flagged as a follow-up.)
6. **Chat + Collaboration cleaner.** The Chat tab now reuses the shared `<ChatPanel compact/>` (deleted the
   ~150-line hand-rolled second chat). Collaboration got a sticky ownership/tasks rail, shared `SectionHeading`,
   and off-scale `text-[0.65rem]` → `text-2xs`.
7. **Command Center header, no card.** Overview header switched from the `hero` card treatment to a plain
   Sources-style big title on the page background; the card treatment moved onto the risk-index instrument (#1).
8. **Noise Reduction, new UI.** Redesigned as a **horizontal QRadar-style Sankey ribbon** — severity strands
   entering from the left, thinning through the pipeline (ingested → clustered → cases), fanning into the 4
   outcome ribbons (verdict-colored), with drop-off badges on connectors and a `ribbon-grow` draw-in. Reuses the
   existing `deriveFunnel()` data + the `GET /api/metrics/noise-reduction` contract unchanged (a pure visual swap).

## Research/plan artifacts (this folder)
`PLAN.md` (opus plan fleet) · `RESEARCH.md` (sonnet research incl. the QRadar-flow spec + cleanliness patterns)
· `MEMORY.md` (working memory — deleted on completion).
