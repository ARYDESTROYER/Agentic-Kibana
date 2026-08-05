"""Fail-closed decision for reusing or replacing a bootstrap supervisor."""

from __future__ import annotations

from typing import Any, Literal

from . import PROTOCOL_VERSION


class BootstrapStatusError(ValueError):
    pass


_CAPABILITIES = ("preflight", "start", "cancel", "rollback")


def replacement_decision(
    status: Any,
    expected_version: str | None = None,
) -> Literal["reuse", "replace"]:
    if not isinstance(status, dict) or status.get("available") is not True:
        raise BootstrapStatusError("existing updater did not return a valid available status")
    active = status.get("active_job")
    if active is not None:
        raise BootstrapStatusError("existing updater has an active job; wait for it to finish")
    protocol = status.get("protocol_version")
    capabilities = status.get("capabilities")
    compatible = str(protocol) == str(PROTOCOL_VERSION)
    version_matches = (
        expected_version is None
        or status.get("updater_version") == expected_version
    )
    complete = isinstance(capabilities, dict) and all(
        capabilities.get(name) is True for name in _CAPABILITIES
    )
    ready = status.get("state") == "ready"
    return "reuse" if compatible and version_matches and complete and ready else "replace"
