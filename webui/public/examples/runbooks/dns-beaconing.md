---
id: dns_beaconing
title: Repetitive DNS beaconing
summary: Investigate periodic outbound DNS queries that may represent command and control.
persona: network
applies_to_rules: [dns_beaconing, periodic_dns_queries]
applies_to_techniques: [T1071.004]
applies_to_entities: [host, domain, ip]
keywords: [dns, beaconing, periodic queries, command and control]
---

SIGNAL
A host sends repeated DNS queries with timing, volume, or domain characteristics consistent with beaconing.

EVIDENCE REQUIRED
Collect query timestamps, domains, answers, host identity, process attribution, resolver logs, and domain reputation.

INVESTIGATION STEPS
1. Measure query regularity, response changes, subdomain entropy, and recurrence across other hosts.
2. Attribute the queries to a process and compare the domain with approved software and infrastructure.
3. Review related connections, endpoint activity, and threat intelligence for corroborating behavior.

TRUE POSITIVE SIGNALS
An unapproved process contacts a suspicious domain periodically and related endpoint or network activity is malicious.

FALSE POSITIVE SIGNALS
A verified application owner confirms the domain, process, cadence, and destination as expected service behavior.

NEEDS HUMAN WHEN
Process attribution, resolver history, ownership, or related endpoint and network telemetry is missing.

RECOMMENDED NEXT ACTION
Escalate confirmed beaconing, isolate the affected host, and preserve DNS, process, and connection evidence.
