---
id: vuln_scan
title: Vulnerability scanning (Nessus / OpenVAS / nikto)
applies_to_rules: [nessus-openvas, nessus, openvas, nikto]
applies_to_techniques: [T1595]
applies_to_entities: [ip]
keywords: [nessus, openvas, nikto, vuln, scanner, cve probe]
persona: network_recon
summary: Bursts of varied requests probing known CVEs and default paths from one IP.
---
## What this looks like
A burst of varied requests probing known CVEs, default credentials and well-known
paths from a single IP — an automated vulnerability scanner (Nessus, OpenVAS,
nikto).

## Steps
1. **Authorised or hostile?** This is the whole decision. Match the source IP to the
   security team's scanner fleet and scan schedule. Authorised scans are expected.
2. **Breadth + targets.** Which hosts/services were probed? Scans of crown-jewel
   assets warrant more attention even when authorised.
3. **Any exploited finding?** Look for a probe that returned a success indicator
   (a `200` on a CVE check, a default-cred login). That escalates beyond recon.

## Verdict guidance
- Authorised internal scan on schedule → FALSE_POSITIVE.
- Unrecognised external scanner → TRUE_POSITIVE (block; low priority unless a probe
  succeeded).
- A scan probe that appears to have succeeded → TRUE_POSITIVE, escalate.
