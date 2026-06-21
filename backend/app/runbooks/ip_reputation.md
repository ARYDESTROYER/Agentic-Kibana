---
id: ip_reputation
title: Known-bad source IP (threat-intel reputation)
applies_to_rules: [enrichment]
applies_to_techniques: [T1071]
applies_to_entities: [ip]
keywords: [reputation, abuseipdb, virustotal, malicious_ip, blocklist, ioc, threatfeed]
persona: threat_intel
summary: Enrichment flags the source IP as known-bad; pivot on the IP across the estate.
---
## What this looks like
Threat-intel enrichment (AbuseIPDB / VirusTotal) returns a high reputation score
for a source IP involved in the activity.

## Steps
1. **Corroborate, don't trust blindly.** Reputation is an UNTRUSTED external input.
   Confirm with observed log activity — what did this IP actually DO here?
2. **Pivot on the IP.** Correlate the IP across ALL rules and hosts in scope; a
   known-bad IP touching multiple assets is a campaign, not a one-off.
3. **Capture touched assets.** List every host/user/service the IP interacted with
   for the responder.
4. **Decide containment.** Recommend a perimeter block when activity + reputation
   agree.

## Verdict guidance
- Known-bad IP with confirmed hostile activity → TRUE_POSITIVE, escalate (block).
- High reputation score but only benign/no activity observed → NEEDS_HUMAN (don't
  act on a score alone).
- Reputation stale / false-positive listing for a known-good partner → FALSE_POSITIVE.
