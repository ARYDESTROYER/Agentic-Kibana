---
title: MITRE ATT&CK and threat context
description: Interpret ATT&CK mappings, indicator reputation, and related cases without losing provenance.
---

# MITRE ATT&CK and threat context

The case **Threat** tab brings together indicator enrichment, MITRE ATT&CK metadata,
and related cases. The service is fail-open: missing enrichment or mapping data does
not prevent case handling.

Reading case threat context requires `cases:read`.

## ATT&CK mappings

Investigations can record technique IDs on a case. TLSOC resolves them against its
bundled Enterprise ATT&CK corpus and can fall back from an unavailable sub-technique
to its parent. The mapping is evidence context, not proof that a technique occurred.

Open **Analytics → Metrics → MITRE coverage** to see tactic and technique counts over
cases. The Navigator export uses the ATT&CK Navigator 4.5 layer format. Coverage means
“present on stored cases”; it does not measure preventive-control coverage or test
effectiveness.

## Indicator reputation

Threat context extracts supported observables and runs enabled enrichment providers.
Each result retains provider attribution and raw provider status. A configured
reputation threshold controls how malicious indicators are highlighted; it does not
set the case verdict or disposition.

## Related cases

Cases can be related by shared entities across sources and can belong to an advisory
campaign. Related does not mean merged. Inspect source identity, time overlap, rule
lineage, and evidence before treating two records as one incident.

## Imported threat intelligence

Authorized users can import threat-context text into the retrieval corpus with
`rag:manage`. Imported material is treated as untrusted data in model prompts even
when an operator supplied it. It can inform an investigation but cannot change the
deterministic decision policy.

## Analyst checklist

1. Confirm the observable came from the expected source field.
2. Compare multiple providers and their freshness.
3. Validate ATT&CK mappings against the evidence.
4. Review related cases for meaningful identity and time overlap.
5. Record the analyst conclusion and disposition in the case.

See [Enrichment](enrichment.md), [Campaigns](../analyst/campaigns.md), and
[Analytics](../analyst/analytics.md).
