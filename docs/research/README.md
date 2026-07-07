# docs/research/ — index of design & implementation records

> **These are point-in-time records, not living docs.** Each folder below captures
> the research, proposal, and implementation notes for one development round at the
> moment it shipped — correct for its own date, not maintained afterward. For the
> **current** state of the suite, read [`CLAUDE.md`](../../CLAUDE.md) §10 (status +
> roadmap), [`CHANGELOG.md`](../../CHANGELOG.md) (full per-round change detail), or
> [`ROADMAP.md`](../../ROADMAP.md) (live backlog). This index exists only to help you
> find the design rationale behind a past round without re-reading all of them.

## Rounds, in order

| Round | Shipped | Commits | What shipped (one line) | Record |
|---|---|---|---|---|
| Vendor-agnostic pivot + 7-wave SOC overhaul | 2026-06-29 | — | Connector SPI + OCSF, selectable `StateStore` (ES/Postgres/SQLite), standalone webui, Wazuh connector, multi-user identity + 6-role RBAC, MFA/TOTP + OIDC SSO, case status/disposition taxonomy, pluggable notification channels, multi-source + cross-source correlation, threshold automation + threat-context, consolidated Settings/UI | [`2026-06-overhaul/`](2026-06-overhaul/) |
| Round 2 | 2026-06-30 | `9ab2954`→`3cd7eec` | Login redesign + account self-service, session policy (idle/absolute/revocation, refresh rotation), Settings-centric IA, Demo Mode, per-feed source config, Resend/SES + customizable email templates, per-user customization (saved views/columns/terminology/theme), command palette + global search + bulk actions + audit viewer | [`2026-06-round2/`](2026-06-round2/) |
| Round 3 | 2026-06-30 | `bffe4b8`→`3610147` | 12 requests: threaded human+AI case collaboration, posture dashboard (MTTA/MTTR/dwell + MITRE coverage), fine-grained custom-role RBAC, a 19-provider `EnrichmentProvider` SPI, in-app notifications, a standardized Models page + pre-flight `BudgetGate`, a forward-looking Standup, and a shipped security fix (RAG knowledge fencing inverted to a TRUSTED allowlist) | [`2026-06-round3/`](2026-06-round3/) |
| Round 4 | 2026-07-01 | `068ede4`→`1df27ac` | 12 requests + 3 confirmed bugs fixed (single-source poller → fan-out, `claude-opus-4-8` mispriced, `acknowledge` not moving status); two-tier ALERT/EVENT ingestion, adaptive threshold auto-tuning, campaign correlation, entity baselining, LLM batch/flex + cache-aware pricing, tiered reset + fresh OOBE | [`2026-07-round4/`](2026-07-round4/) |
| Round 5 | 2026-07-02 | `5ab7c05`→`05552c7` | A cohesive color/type/spacing system (3 semantic axes, measured WCAG-AA both themes), ONE shadcn/Radix design standard, Settings decluttered into a section registry, a wider dashboard + compact hero, a Detection & Rules editor, per-user custom dashboards, a `FEATURES[]` loose-coupling registry, and an a11y pass + 16-dimension adversarial audit | [`2026-07-round5/`](2026-07-round5/) |
| Round 6 | 2026-07-02 | `54c8465` | A ~500-agent fleet glitch-hunt across every webui file (155 audited units); 464 adversarially-verified findings fixed (dashboard-packing, rules ledger, secrets unification, KPI deltas, WCAG contrast, and more) | [`2026-07-round6/`](2026-07-round6/) |
| Round 7 | 2026-07-05 (PR #23) | `850600f`→`7355a9a` | Overview rebuilt as a "Security Command Center"; a durable-counter Noise-Reduction funnel introduced; shared `ProvenanceTag`; CaseDetail told as an 8→5-tab story | [`2026-07-round7/`](2026-07-round7/) |
| Round 8 | 2026-07-05 (PR #24) | `58745fa`→`91aae40` | UI cleanup + glitch fixes: risk-index own card, Cases sticky-header fix, Noise-Reduction redesigned as a horizontal Sankey ribbon (superseded twice since — see Round 9/9b below), de-carded page headers | [`2026-07-round8/`](2026-07-round8/) |
| Round 9 | 2026-07-05 (PR #25, `a69233b`) | `709e758`→`26c4266` | 11-ask overhaul: removed redundant in-page tab strips duplicating the left nav; Sources rebuilt as a QRadar-style "Log Source Management" `DataTable`; CaseDetail Investigation split into Timeline + Investigation; local/self-hosted LiteLLM (OpenAI-compatible) model provider shipped; Login/Wizard polish; fixed a pre-existing `POST /api/sources` secret-dropping bug | **No folder** — see [`Journal.md`](../../Journal.md) lines 1457–1466 |
| Round 9b | 2026-07-05, later (PR #26, `749bce6`) | `e9a6daa`→`0db265b` | Hover-to-expand sidebar; Noise-Reduction reverted flat-bars→ribbon (prettier, per-stage hover detail); CaseDetail redesign (Timeline = "what happened" only, Investigation = AI assessment + pinned `DecisionCard` + full trace); wider case Sheet; Overview → Decision-Brief hero + SOURCE SAYS/AGENT FOUND/CODE DECIDED provenance row | **No folder** — see [`Journal.md`](../../Journal.md) lines 1467–1473 |
| Round 9c | 2026-07-06 (PR #27, `559ce88`, current `Testing` HEAD) | `20118a7`→`2cc94c5` | Dashboard rebuilt from scratch (Prisma/XSIAM-style); real MTTD + honest MTTR-as-first-response (ACK clock, not dwell); a burndown chart; noise-counters gained a terminal "closed by human" stage; Cases list rebuilt (summary strip, monogram Assignee column) | **No folder** — see [`Journal.md`](../../Journal.md) lines 1474–1483 |

Rounds 9, 9b, and 9c have **no `docs/research/2026-07-round9*/` folder by design** —
they were run "efficiency-first," without the research-brief fan-out the earlier
rounds used. Their only paper trail is the `Journal.md` entries linked above plus
`git log`; don't expect a matching folder to turn up later.

## Two loose files (pre-round research, not folder-scoped)

- [`CUSTOMIZATION_AND_RBAC.md`](CUSTOMIZATION_AND_RBAC.md) — a competitor research
  synthesis (Elastic Security, Splunk ES, Microsoft Sentinel, Google SecOps/Chronicle,
  Panther, Wazuh, CrowdStrike Falcon LogScale) on multi-source customization and RBAC,
  mapped to a concrete TLSOC design. Fed into the 2026-06 overhaul and Round 3 RBAC/
  source-customization work.
- [`UX_AND_DESIGN.md`](UX_AND_DESIGN.md) — a UX/visual-design research brief surveying
  SOC console patterns (layout density, navigation, AI-chat, tables, design
  standardization) across the same competitor set. **Written before the EUI removal**
  (Round 5) — it describes the webui's *then-current* `@elastic/eui` stack as the
  implementation baseline for its recommendations. Read it as a historical snapshot of
  that research, not as a description of today's Tailwind + shadcn/Radix stack.

Both predate the round-numbered folders above and are companion documents to each
other (each cross-references the other).
