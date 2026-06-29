"""Connector registry — discovery for built-in and third-party connectors.

Built-ins (the Elastic/OpenSearch pull connectors and every push receiver) are
registered here. Out-of-tree connectors register via the ``tlsoc.connectors``
entry-point group, so the community can ``pip install tlsoc-connector-<vendor>``
and have it appear in the wizard with zero core change.

The registry's primary consumers are the first-run wizard (``manifests()`` lists
every connector + its auth/config fields) and the source-wiring code (maps a
configured ``SourceType`` to its connector class).
"""

from __future__ import annotations

import importlib.metadata as importlib_metadata
import logging

from ..constants import SourceType
from .base import Connector, ConnectorManifest, PullConnector, PushReceiver
from .elastic import ElasticConnector
from .opensearch import OpenSearchConnector
from .receivers import BUILTIN_RECEIVERS
from .wazuh import WazuhConnector

logger = logging.getLogger("tlsoc.connectors.registry")

ENTRY_POINT_GROUP = "tlsoc.connectors"

# Built-in PULL connectors (push receivers come from BUILTIN_RECEIVERS).
_BUILTIN_PULL: list[type[Connector]] = [ElasticConnector, OpenSearchConnector, WazuhConnector]


class ConnectorRegistry:
    """A mapping of ``SourceType`` → connector class, with manifest listing."""

    def __init__(self) -> None:
        self._classes: dict[SourceType, type[Connector]] = {}

    def register(self, cls: type[Connector]) -> None:
        st = getattr(cls, "source_type", None)
        if st is None:
            logger.warning("Connector %s has no source_type; skipping", cls)
            return
        if st in self._classes and self._classes[st] is not cls:
            logger.info("Connector for %s overridden by %s", st.value, cls.__name__)
        self._classes[st] = cls

    def get(self, source_type: SourceType) -> type[Connector] | None:
        return self._classes.get(source_type)

    @staticmethod
    def _with_browse(cls: type[Connector], m: ConnectorManifest) -> ConnectorManifest:
        """Ensure a push receiver advertises the ``browse`` capability (it gets a
        live-tail buffer), without editing ~16 manifests. Pull connectors declare
        ``browse`` in their own manifest, so this only augments receivers. Defensive:
        a missing/odd capabilities list never raises.

        Also guarantees every manifest exposes a non-empty ``setup_help`` (Wave 5 /
        F9): connectors that ship a curated guide keep it; any that don't get a concise
        generic one synthesised from their field schema, so the wizard's contextual-help
        affordance is present for ALL ~19 connectors with zero per-connector boilerplate."""
        try:
            if issubclass(cls, PushReceiver) and "browse" not in (m.capabilities or []):
                m.capabilities = list(m.capabilities or []) + ["browse"]
        except Exception:  # noqa: BLE001 — augmentation must never break listing
            pass
        try:
            if not (m.setup_help or "").strip():
                m.setup_help = ConnectorRegistry._default_setup_help(m)
        except Exception:  # noqa: BLE001 — augmentation must never break listing
            pass
        return m

    @staticmethod
    def _default_setup_help(m: ConnectorManifest) -> str:
        """Synthesise a concise, generic setup guide from a manifest's field schema.

        Lists the required connection fields and notes which credentials are secret
        (stored in the secret tier, never echoed — #10). Used only when a connector
        ships no curated ``setup_help``."""
        required = [f.label for f in (m.auth_fields + m.config_fields) if f.required]
        secret = [f.label for f in m.auth_fields if f.secret]
        lines = [f"## Connect {m.display_name}"]
        if m.description:
            lines.append(m.description)
        if required:
            lines.append("**Required:** " + ", ".join(required) + ".")
        if secret:
            lines.append(
                "Credential field(s) (" + ", ".join(secret) + ") are stored in the "
                "secret tier and shown only as configured — never echoed back (#10)."
            )
        lines.append("Use a READ-ONLY, least-privilege credential — never an admin / "
                     "superuser. Then 'Test connection' and save.")
        return "\n".join(lines)

    def manifest(self, source_type: SourceType) -> ConnectorManifest | None:
        cls = self._classes.get(source_type)
        if cls is None:
            return None
        return self._with_browse(cls, cls.manifest())

    def manifests(self) -> list[ConnectorManifest]:
        """Every connector's manifest, sorted for stable wizard display."""
        out: list[ConnectorManifest] = []
        for cls in self._classes.values():
            try:
                out.append(self._with_browse(cls, cls.manifest()))
            except Exception as exc:  # noqa: BLE001 — one bad connector must not break listing
                logger.warning("manifest() failed for %s: %s", cls, exc)
        out.sort(key=lambda m: (m.category, m.display_name))
        return out

    def source_types(self) -> list[SourceType]:
        return list(self._classes.keys())

    def is_pull(self, source_type: SourceType) -> bool:
        cls = self._classes.get(source_type)
        return bool(cls and issubclass(cls, PullConnector))

    def is_receiver(self, source_type: SourceType) -> bool:
        cls = self._classes.get(source_type)
        return bool(cls and issubclass(cls, PushReceiver))


def _load_entry_point_connectors(reg: ConnectorRegistry) -> None:
    """Discover out-of-tree connectors registered under ``tlsoc.connectors``."""
    try:
        eps = importlib_metadata.entry_points(group=ENTRY_POINT_GROUP)
    except Exception as exc:  # noqa: BLE001 — never let discovery break startup
        logger.warning("entry-point discovery failed: %s", exc)
        return
    for ep in eps:
        try:
            cls = ep.load()
            reg.register(cls)
            logger.info("Loaded connector '%s' from entry point", ep.name)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not load connector entry point '%s': %s", ep.name, exc)


def _build_default_registry() -> ConnectorRegistry:
    reg = ConnectorRegistry()
    for cls in _BUILTIN_PULL:
        reg.register(cls)
    for cls in BUILTIN_RECEIVERS:
        reg.register(cls)
    _load_entry_point_connectors(reg)
    return reg


_registry: ConnectorRegistry | None = None


def get_registry() -> ConnectorRegistry:
    """The process-wide connector registry (built once, lazily)."""
    global _registry
    if _registry is None:
        _registry = _build_default_registry()
    return _registry
