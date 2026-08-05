---
title: Terminology
description: Use the stable Agentic SOC 0.1 names for the product, technical compatibility namespace, telemetry, cases, and releases.
---

# Terminology

This glossary applies to **Agentic SOC 0.1**. Use these names in source configuration,
operator procedures, API integrations, and support requests.

## Product and release names

| Term | Meaning |
| --- | --- |
| **Agentic SOC** | Full and preferred operator-facing product name |
| **Console** | Standalone Agentic SOC web interface |
| **Agentic SOC API** | Backend application and `/api` surface |
| **TLSOC** | Compatibility namespace retained in technical identifiers; not the operator-facing product name |
| **Testing** | Integration branch and pre-stable validation channel |
| **Stable** | Supported release channel built from the `main` branch |
| **0.1** | Documentation and human-facing release line |
| **0.1.7** | Current SemVer artifact version; immutable tag `v0.1.7` only after verified Stable promotion |

Do not use “Bleeding Edge,” `next`, or “alpha” for the active 0.1 release model.

### Technical namespace compatibility

The rename does not alter wire or deployment contracts. Keep existing identifiers
such as `TLSOC_*` environment variables, `tlsoc-*` containers and images,
`tlsoc-agent-*` indices, `tlsoc_*` cookies/storage keys, `X-TLSOC-*` headers,
`tlsoc.connectors` entry points, Python import paths, and existing API fields exactly
as documented. A copy-only change must never rename one of those values. In prose,
say **Agentic SOC**, **Console**, or **Agentic SOC API** as appropriate.

## Security data lifecycle

| Term | Definition |
| --- | --- |
| **Source** | One configured connector instance, such as a particular Wazuh indexer or webhook sender |
| **Feed** | A source-specific stream or index pattern with an `events`, `alerts`, or `ignore` role |
| **Event** | A source record normalized to the Agentic SOC OCSF subset |
| **Detection** | A source-provided or Agentic SOC-produced finding that identifies suspicious activity |
| **Alert** | A source-native detection feed whose signals are prioritized for investigation |
| **Candidate** | A correlated record visible in Agentic SOC but not necessarily admitted to model investigation |
| **Case** | The human-reviewable unit containing provenance, evidence, assessment, decision, status, and collaboration |
| **Campaign** | An advisory grouping that references related case IDs; it does not merge or close cases |

Keep these records distinct. A source alert is not silently relabeled as an Agentic SOC
detection, and a campaign never rewrites a member case's history.

## Case terms

- **Verdict** is the model assessment: true positive, false positive, or needs
  human review.
- **Decision** is the deterministic policy result that closes, escalates, or routes
  a case to a human.
- **Status** is lifecycle state, such as new, investigating, escalated, on hold,
  resolved, needs human, or closed.
- **Disposition** is the analyst's classification, such as true positive, false
  positive, benign, suspicious, duplicate, or undetermined.
- **Risk** is a deterministic score used for prioritization and investigation
  routing. It is not the model's confidence.
- **Confidence** is the model's confidence in its verdict. It never acts alone.

## Automation terms

- **Autopilot** is the bundle of default-enabled deterministic and bounded
  behaviors, including comprehensive ingestion, risk admission, tuning, campaigns,
  cross-source correlation, baselines, SLA policy, and coverage signals.
- **Detection rule** describes source matching, thresholding, or anomaly logic.
- **Case-automation rule** can tag, recommend, notify, request approval, or queue
  an allowed playbook action after a decision. It cannot bypass case policy.
- **Playbook** is trusted operator-authored investigation context. It recommends;
  it does not decide.

## Source and state terms

- **Log source** is the external system of record for telemetry.
- **State backend** is Agentic SOC's own bookkeeping store. Changing it does not move or
  select the log source.
- **Primary source** is the enabled pull source used for the primary ad-hoc query
  surface. A push receiver cannot be primary.
- **Secret tier** is the non-persisted runtime store for source and integration
  secret values. Persisted source configuration contains only configured field names.

## Related pages

- [Architecture](architecture.md)
- [Feeds and field mapping](../sources/feeds-mapping.md)
- [Deterministic decisions](deterministic-decisions.md)
- [Versioning](../releases/channels.md)
