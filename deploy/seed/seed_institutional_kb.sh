#!/usr/bin/env bash
# Seed the canonical TLSOC institutional network topology into a running backend.
# Idempotent for asset_networks (PUT replaces). Memory facts are append-only — the
# script skips any whose text already exists, so re-running won't duplicate them.
#
# Source of truth: docs/INSTITUTIONAL_KNOWLEDGE_BASE.md §1.
# Re-run after any backend restart when STATE_BACKEND uses the in-memory store.
#
#   ./seed_institutional_kb.sh                 # defaults to http://localhost:8088
#   BACKEND=http://host:8088 ./seed_institutional_kb.sh
set -euo pipefail

BACKEND="${BACKEND:-http://localhost:8088}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "▶ Seeding institutional KB into ${BACKEND}"

echo "  • asset_networks (PUT /api/settings)"
curl -fsS -X PUT "${BACKEND}/api/settings" \
  -H 'Content-Type: application/json' \
  -d @"${HERE}/asset_networks.json" >/dev/null
echo "    done"

echo "  • asset_criticality — per-host map (PUT /api/settings)"
curl -fsS -X PUT "${BACKEND}/api/settings" \
  -H 'Content-Type: application/json' \
  -d @"${HERE}/asset_criticality.json" >/dev/null
echo "    done"

echo "  • memory facts (POST /api/memory, skip-if-exists)"
existing="$(curl -fsS "${BACKEND}/api/memory")"
python3 - "$BACKEND" "$existing" "${HERE}/memory_facts.json" <<'PY'
import json, sys, urllib.request
backend, existing_raw, facts_path = sys.argv[1], sys.argv[2], sys.argv[3]
existing = {e.get("text","") for e in json.loads(existing_raw).get("entries", [])}
with open(facts_path) as fh:
    facts = json.load(fh)
added = skipped = 0
for f in facts:
    if f["text"] in existing:
        skipped += 1; continue
    req = urllib.request.Request(
        f"{backend}/api/memory", data=json.dumps(f).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    urllib.request.urlopen(req).read()
    added += 1
print(f"    added={added} skipped(existing)={skipped}")
PY

echo "▶ Verify"
curl -fsS "${BACKEND}/api/settings" | python3 -c "import sys,json;p=json.load(sys.stdin)['prefs'];print('    asset_networks      =',len(p.get('asset_networks',[])));print('    asset_criticality   =',len(p.get('asset_criticality',{})))"
curl -fsS "${BACKEND}/api/memory"   | python3 -c "import sys,json;print('    memory facts        =',json.load(sys.stdin)['count'])"
echo "✓ done"
