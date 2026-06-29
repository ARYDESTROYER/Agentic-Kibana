# Bundled MITRE ATT&CK technique map — source & freshness

`mitre_techniques.json` is a **compact, curated subset** of MITRE ATT&CK
Enterprise, used by `app/engine/mitre.py` to label a case's techniques in the
threat-context panel (F11). It is **data, not code**.

## Source

- **Upstream:** [`mitre-attack/attack-stix-data`](https://github.com/mitre-attack/attack-stix-data)
  → `enterprise-attack/enterprise-attack.json` (the public STIX 2.1 bundle).
- **License:** MITRE ATT&CK is © The MITRE Corporation, redistributed under the
  ATT&CK [Terms of Use](https://attack.mitre.org/resources/legal-and-branding/terms-of-use/).
- **Why a subset?** The full STIX bundle is ~50MB. The triage engine only needs
  `{technique_id: {name, tactics[], platforms[], url, description}}` per live
  (non-revoked, non-deprecated) `attack-pattern`, which compacts to **< ~400KB**.

## Refresh

ATT&CK ships roughly twice a year (spring + autumn). To re-bundle:

```bash
cd backend
python -m app.threat.refresh_mitre               # latest master
python -m app.threat.refresh_mitre --version 15.1  # a pinned ATT&CK release
```

The script downloads the STIX bundle (stdlib `urllib`, **zero new deps**), extracts
the compact map, and writes `mitre_techniques.json`. Commit the regenerated JSON —
**never** the 50MB STIX bundle.

If GitHub raw is blocked in your environment, hand-curate / patch
`mitre_techniques.json` directly: it is a flat `{ "T1110": { ... }, ... }` map and
`engine/mitre.py` treats it as plain data (degrading to an empty map if it is
missing or unparseable, so a stale/absent file never breaks the panel).

## Freshness

- **Generated from:** `enterprise-attack.json` @ `master` (≈ ATT&CK v17, mid-2026).
- **Technique count:** ~697 (Enterprise, live techniques + sub-techniques).
- Re-run the refresh each ATT&CK release to stay current.
