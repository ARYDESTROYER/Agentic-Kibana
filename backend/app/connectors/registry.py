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

import logging

from ..constants import SourceType
from ..plugins.registry import EntryPointRegistry
from .base import Connector, ConnectorManifest, PullConnector, PushReceiver
from .elastic import ElasticConnector
from .opensearch import OpenSearchConnector
from .receivers import BUILTIN_RECEIVERS
from .wazuh import WazuhConnector

logger = logging.getLogger("tlsoc.connectors.registry")

ENTRY_POINT_GROUP = "tlsoc.connectors"

# Built-in PULL connectors (push receivers come from BUILTIN_RECEIVERS).
_BUILTIN_PULL: list[type[Connector]] = [ElasticConnector, OpenSearchConnector, WazuhConnector]


def _connector_key(cls: type[Connector]) -> SourceType | None:
    """The registry key for a connector class (its declared ``source_type``)."""
    return getattr(cls, "source_type", None)


class ConnectorRegistry:
    """A mapping of ``SourceType`` → connector class, with manifest listing.

    Round 5 (Coupling-F): the ``SourceType -> class`` map, ``register`` precedence
    log, ``get`` + entry-point discovery are the shared
    :class:`app.plugins.registry.EntryPointRegistry`; this class keeps its connector-
    specific manifest augmentation (push-receiver ``browse`` capability + generic
    ``setup_help``) + the pull/receiver type checks on top. Behaviour is byte-identical.
    """

    def __init__(self) -> None:
        self._reg: EntryPointRegistry[SourceType, type[Connector]] = EntryPointRegistry(
            ENTRY_POINT_GROUP, _connector_key, what="connector", log=logger,
        )

    # The historical ``self._classes`` dict is preserved as a live view onto the
    # generic's store so any in-tree caller that reached ``registry._classes`` (e.g. the
    # demo toggle's ``._classes.pop``) keeps working byte-identically.
    @property
    def _classes(self) -> dict[SourceType, type[Connector]]:
        return self._reg._items  # noqa: SLF001 — same package, deliberate live view

    def register(self, cls: type[Connector]) -> None:
        self._reg.register(cls)

    def get(self, source_type: SourceType) -> type[Connector] | None:
        return self._reg.get(source_type)

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
        out: list[ConnectorManifest] = self._reg.iter_manifests(  # type: ignore[assignment]
            lambda cls: cls.manifest(),
            transform=lambda cls, m: self._with_browse(cls, m),
        )
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
    reg._reg.discover()  # noqa: SLF001 — same package; discovery is isolated + warned


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


# NOTE (audit #46): there is intentionally NO ``set_demo_registered`` toggle. The old
# one was orphaned dead code — nothing ever called it, so the "DemoPullConnector is
# registered only while demo is active" behavior it documented never actually happened.
# Demo Mode is driven by the seeded demo sources + the deterministic demo runtime
# (``engine/demo_sources.py`` / ``engine/demo_runtime.py``), NOT by registering a live
# connector. ``connectors/demo.DemoPullConnector`` is a TEST-ONLY class (directly
# instantiated in tests); it is not auto-registered in the connector registry.
