#!/usr/bin/env python3
"""Classify one exact Stable GitHub Release without mutating it.

The release workflow uses this helper before every mutation.  A draft may be
resumed only when its tag, title, commit-bound canonical notes, and canonical
asset inventory are unambiguous.  Published releases are immutable from the
workflow's point of view: anything other than the exact metadata and complete
canonical pair is rejected.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


PLAN_NAME = "upgrade-plan.json"
BUNDLE_NAME = "upgrade-plan.sigstore.json"
CANONICAL_NAMES = frozenset((PLAN_NAME, BUNDLE_NAME))
COMMIT_MARKER_RE = re.compile(r"<!-- agentic-soc-release-commit:([0-9a-f]{40}) -->")


class ReleaseInventoryError(ValueError):
    """The remote release inventory is not safe to resume or publish."""


def canonical_release_name(tag: str) -> str:
    return f"Agentic SOC {tag}"


def canonical_release_body(*, commit_sha: str, release_notes: str) -> str:
    return (
        f"<!-- agentic-soc-release-commit:{commit_sha} -->\n\n"
        f"{release_notes}"
    )


def _require_positive_id(value: object, subject: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ReleaseInventoryError(f"{subject} has an invalid id")
    return value


def _flatten_inventory(raw: object) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        raise ReleaseInventoryError("release inventory must be a JSON array")
    if raw and all(isinstance(page, list) for page in raw):
        raw = [release for page in raw for release in page]
    if not all(isinstance(release, dict) for release in raw):
        raise ReleaseInventoryError("release inventory contains a non-object entry")
    return raw  # type: ignore[return-value]


def classify_release_inventory(
    raw: object,
    *,
    tag: str,
    commit_sha: str,
    release_notes: str,
) -> dict[str, object]:
    if not re.fullmatch(r"[0-9a-f]{40}", commit_sha):
        raise ReleaseInventoryError("expected commit SHA is invalid")
    releases = _flatten_inventory(raw)
    matches = [release for release in releases if release.get("tag_name") == tag]
    if len(matches) > 1:
        raise ReleaseInventoryError(f"multiple releases use exact tag {tag!r}")
    if not matches:
        return {
            "release_state": "absent",
            "release_exists": False,
            "release_id": None,
            "plan_exists": False,
            "bundle_exists": False,
            "plan_asset_id": None,
            "bundle_asset_id": None,
            "delete_asset_ids": [],
        }

    release = matches[0]
    release_id = _require_positive_id(release.get("id"), "release")
    draft = release.get("draft")
    if not isinstance(draft, bool):
        raise ReleaseInventoryError("release draft state is missing or invalid")
    if release.get("prerelease") is not False:
        raise ReleaseInventoryError("Stable release must not be a prerelease")
    published_at = release.get("published_at")
    if draft and published_at is not None:
        raise ReleaseInventoryError("draft was previously published and cannot be repaired")
    if not draft and not isinstance(published_at, str):
        raise ReleaseInventoryError("published release has no publication timestamp")
    if release.get("name") != canonical_release_name(tag):
        raise ReleaseInventoryError("release title does not equal the canonical title")
    body = release.get("body")
    if not isinstance(body, str):
        raise ReleaseInventoryError("release body is missing or invalid")
    markers = COMMIT_MARKER_RE.findall(body)
    if markers != [commit_sha]:
        raise ReleaseInventoryError(
            "release commit marker does not equal the exact tagged commit"
        )
    if body != canonical_release_body(
        commit_sha=commit_sha,
        release_notes=release_notes,
    ):
        raise ReleaseInventoryError(
            "release body does not equal the canonical versioned release notes"
        )

    assets = release.get("assets")
    if not isinstance(assets, list):
        raise ReleaseInventoryError("release assets are missing or invalid")

    uploaded: dict[str, int] = {}
    delete_asset_ids: list[int] = []
    for asset in assets:
        if not isinstance(asset, dict):
            raise ReleaseInventoryError("release contains a non-object asset")
        name = asset.get("name")
        if name not in CANONICAL_NAMES:
            raise ReleaseInventoryError(f"unexpected release asset {name!r}")
        asset_id = _require_positive_id(asset.get("id"), f"asset {name!r}")
        state = asset.get("state")
        if state == "starter":
            if not draft:
                raise ReleaseInventoryError(
                    f"published release contains incomplete asset {name!r}"
                )
            delete_asset_ids.append(asset_id)
            continue
        if state != "uploaded":
            raise ReleaseInventoryError(
                f"asset {name!r} has unsupported state {state!r}"
            )
        size = asset.get("size")
        if isinstance(size, bool) or not isinstance(size, int) or size <= 0:
            raise ReleaseInventoryError(f"asset {name!r} is empty or has invalid size")
        if name in uploaded:
            raise ReleaseInventoryError(f"release contains duplicate asset {name!r}")
        uploaded[name] = asset_id

    plan_asset_id = uploaded.get(PLAN_NAME)
    bundle_asset_id = uploaded.get(BUNDLE_NAME)
    if not draft:
        if plan_asset_id is None or bundle_asset_id is None:
            raise ReleaseInventoryError(
                "published release is missing a canonical upgrade-plan asset"
            )
    elif plan_asset_id is None and bundle_asset_id is not None:
        # A detached signature bundle cannot be authenticated without its exact
        # payload.  It is safe to discard only while this exact release is draft.
        delete_asset_ids.append(bundle_asset_id)
        bundle_asset_id = None

    return {
        "release_state": "draft" if draft else "published",
        "release_exists": True,
        "release_id": release_id,
        "plan_exists": plan_asset_id is not None,
        "bundle_exists": bundle_asset_id is not None,
        "plan_asset_id": plan_asset_id,
        "bundle_asset_id": bundle_asset_id,
        "delete_asset_ids": sorted(set(delete_asset_ids)),
    }


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--commit-sha", required=True)
    parser.add_argument("--release-notes", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    try:
        raw = json.loads(args.inventory.read_text(encoding="utf-8"))
        result = classify_release_inventory(
            raw,
            tag=args.tag,
            commit_sha=args.commit_sha,
            release_notes=args.release_notes.read_text(encoding="utf-8"),
        )
    except (OSError, json.JSONDecodeError, ReleaseInventoryError) as exc:
        print(f"unsafe release inventory: {exc}", file=sys.stderr)
        return 2
    json.dump(result, sys.stdout, sort_keys=True, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
