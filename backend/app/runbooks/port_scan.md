---
id: port_scan
title: Port scan / network reconnaissance
applies_to_rules: [suricata, et_scan]
applies_to_techniques: [T1046, T1595]
applies_to_entities: [ip]
keywords: [suricata, et scan, scan, nmap, port, recon, probe, sweep, masscan]
persona: network_recon
summary: Many connection attempts to distinct ports/hosts from one source IP.
---
## What this looks like
Suricata "ET SCAN" alerts, or many connections to distinct ports/hosts from one
source IP in a short window — classic reconnaissance.

## Steps
1. **Measure breadth.** How many distinct ports and hosts were probed, over what
   window? A wide, fast sweep is a scanner; a few connections may be benign.
2. **Did anything respond?** A probe that got a service banner / SYN-ACK / `200` is
   more interesting than blind SYNs into closed ports.
3. **Authorised or hostile?** Match the source IP against known internal scanners
   and their maintenance schedule (see suppression guidance). Internal vuln scans
   on schedule are expected.
4. **Enrich the source IP** reputation for external sources.

## Verdict guidance
- Recon alone (no successful connection, hostile external IP) → usually
  TRUE_POSITIVE but LOW priority (monitor / block), rarely an incident by itself.
- Authorised internal scanner on schedule → FALSE_POSITIVE.
- Recon immediately followed by a successful connection to a sensitive service →
  TRUE_POSITIVE, escalate.
