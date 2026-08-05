#!/usr/bin/env python3
"""Read one required boolean from the release classifier's JSON output.

``jq -e`` exits non-zero for the valid JSON value ``false``.  Release workflow
branches must therefore validate the field's type separately from its value,
then emit a shell-safe lowercase boolean without treating ``false`` as an
error.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any


BOOLEAN_FIELDS = frozenset(("release_exists", "plan_exists", "bundle_exists"))


class ReleaseStateBooleanError(ValueError):
    """The classifier output did not contain the required boolean field."""


def read_required_boolean(document: Any, field: str) -> bool:
    """Return an exact classifier boolean, rejecting absent or mistyped data."""

    if field not in BOOLEAN_FIELDS:
        raise ReleaseStateBooleanError(f"unsupported release-state field {field!r}")
    if not isinstance(document, dict):
        raise ReleaseStateBooleanError("release state must be a JSON object")
    if field not in document or type(document[field]) is not bool:
        raise ReleaseStateBooleanError(
            f"release-state field {field!r} is missing or is not a boolean"
        )
    return document[field]


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--field", choices=sorted(BOOLEAN_FIELDS), required=True)
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    try:
        document = json.load(sys.stdin)
        value = read_required_boolean(document, args.field)
    except (json.JSONDecodeError, ReleaseStateBooleanError) as exc:
        print(f"release-state boolean error: {exc}", file=sys.stderr)
        return 1
    print("true" if value else "false")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
