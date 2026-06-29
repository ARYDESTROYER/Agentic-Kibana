"""Refresh the bundled COMPACT MITRE ATT&CK technique map (F11).

The triage engine only needs a small, retrieval-friendly slice of MITRE ATT&CK —
``{technique_id: {name, tactics[], platforms[], url, description}}`` — NOT the full
~50MB enterprise-attack STIX bundle. This script downloads the public STIX bundle
from the MITRE ``attack-stix-data`` GitHub repo and extracts that compact subset
(< ~1MB) into ``mitre_techniques.json`` beside this file.

USAGE (run from the backend dir, online):

    python -m app.threat.refresh_mitre              # latest master bundle
    python -m app.threat.refresh_mitre --version 15.1   # a pinned ATT&CK version

ZERO new pip deps: stdlib ``urllib`` only. The download is large + transient; the
COMMITTED artefact is the compact JSON, not the STIX bundle. Re-run quarterly to
follow ATT&CK releases (see ``SOURCE.md`` for the freshness note).

If GitHub raw is blocked in your environment, hand-curate / patch
``mitre_techniques.json`` directly — the loader (``engine/mitre.py``) treats it as
plain data and degrades to an empty map if it is missing/unparseable.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT_PATH = HERE / "mitre_techniques.json"

# The public, versioned STIX bundles. ``master`` is the latest release.
_BASE = "https://raw.githubusercontent.com/mitre-attack/attack-stix-data/{ref}/enterprise-attack/enterprise-attack.json"

_CITATION_RE = re.compile(r"\(Citation:[^)]*\)")


def _bundle_url(version: str | None) -> str:
    ref = "master" if not version else version
    # A pinned ATT&CK version ships as ``enterprise-attack-<version>.json``.
    if version:
        return (
            "https://raw.githubusercontent.com/mitre-attack/attack-stix-data/master/"
            f"enterprise-attack/enterprise-attack-{version}.json"
        )
    return _BASE.format(ref=ref)


def _external_id(obj: dict) -> tuple[str | None, str | None]:
    for ref in obj.get("external_references", []) or []:
        if ref.get("source_name") == "mitre-attack":
            return ref.get("external_id"), ref.get("url")
    return None, None


def compact_from_bundle(bundle: dict, *, max_desc: int = 280) -> dict[str, dict]:
    """Extract the compact ``{technique_id: {...}}`` map from a STIX bundle."""
    objects = bundle.get("objects", [])
    tactics: dict[str, str] = {}
    for obj in objects:
        if obj.get("type") == "x-mitre-tactic":
            shortname = obj.get("x_mitre_shortname")
            if shortname:
                tactics[shortname] = obj.get("name", shortname)

    out: dict[str, dict] = {}
    for obj in objects:
        if obj.get("type") != "attack-pattern":
            continue
        if obj.get("revoked") or obj.get("x_mitre_deprecated"):
            continue
        tid, url = _external_id(obj)
        if not tid:
            continue
        tac = [
            tactics.get(ph["phase_name"], ph["phase_name"])
            for ph in obj.get("kill_chain_phases", []) or []
            if ph.get("kill_chain_name") == "mitre-attack"
        ]
        platforms = list(obj.get("x_mitre_platforms", []) or [])
        desc = (obj.get("description") or "").strip()
        desc = _CITATION_RE.sub("", desc).split("\n")[0].strip()
        if len(desc) > max_desc:
            desc = desc[: max_desc - 3].rstrip() + "..."
        out[tid] = {
            "name": obj.get("name", ""),
            "tactics": tac,
            "platforms": platforms,
            "url": url or f"https://attack.mitre.org/techniques/{tid.replace('.', '/')}",
            "description": desc,
        }
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Refresh the compact MITRE technique map.")
    ap.add_argument("--version", default=None, help="ATT&CK version (e.g. 15.1); default = master")
    ap.add_argument("--out", default=str(OUT_PATH), help="output JSON path")
    args = ap.parse_args(argv)

    url = _bundle_url(args.version)
    print(f"Fetching STIX bundle: {url}", file=sys.stderr)
    with urllib.request.urlopen(url, timeout=120) as resp:  # noqa: S310 — pinned MITRE host
        bundle = json.loads(resp.read().decode("utf-8"))

    compact = compact_from_bundle(bundle)
    text = json.dumps(compact, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    Path(args.out).write_text(text, encoding="utf-8")
    size = len(text.encode("utf-8"))
    print(f"Wrote {len(compact)} techniques → {args.out} ({size/1024:.0f} KB)", file=sys.stderr)
    if size > 1_000_000:
        print("WARNING: artefact exceeds ~1MB; trim max_desc or the field set.", file=sys.stderr)
    return 0


if __name__ == "__main__":  # pragma: no cover - operator tool
    raise SystemExit(main())
