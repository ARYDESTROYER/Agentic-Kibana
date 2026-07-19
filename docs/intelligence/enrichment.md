---
title: Enrichment
description: Configure cached, fail-open threat-intelligence lookups for supported indicator types.
---

# Enrichment

Enrichment adds external reputation and context to IPs, domains, URLs, file hashes,
and emails. It is advisory and fail-open: one provider's timeout or failure
must not drop an alert or decide a case.

Open **Settings → Integrations → Enrichment**. Reading the catalog and testing a
lookup requires `enrichment:read`; changing provider secrets requires
`enrichment:manage`.

## Built-in providers

v0.1 registers 19 provider adapters:

`AbuseIPDB`, `BinaryEdge`, `Censys`, `GreyNoise`, `HIBP`, `IPInfo`,
`MalwareBazaar`, `OTX`, `Project Honeypot`, `Pulsedive`, `RDAP`, `Shodan`,
`Shodan InternetDB`, `Spur`, `ThreatFox`, `URLhaus`, `URLScan`, `VirusTotal`, and
`IBM X-Force`.

The provider catalog is authoritative for each adapter's supported indicator types,
credential fields, and configured state. Key-gated providers run only when both
enabled and configured. Keyless providers can be enabled without storing a secret.

## Cache and fusion

Lookups are cached per provider and indicator to protect latency, cost, and provider
quotas. Redis is preferred; the cache falls back to process memory if Redis is
unavailable.

When fusion is disabled, provider results remain independently visible. When fusion
is enabled, the configured aggregation policy produces a bounded reputation score.
The default fusion behavior takes the strongest provider score; weighted fusion is
an operator opt-in.

## Configure safely

1. Enable only providers needed for your indicator mix.
2. Add credentials through the write-only secret control; saved responses expose
   configured booleans, never secret values.
3. Test with a non-sensitive indicator.
4. Confirm provider attribution, cache state, and error handling.
5. Set a cache lifetime that respects both freshness and provider quota.

Provider terms, data handling, and rate limits remain the operator's responsibility.
Do not interpret a single provider verdict as a case disposition.

See [MITRE and threat context](mitre-threat-context.md) and
[Investigation](../analyst/investigation.md).
