"""Vendor-agnostic source connectors (AGNOSTIC_ARCHITECTURE.md §4).

The SPI lives in :mod:`app.connectors.base`. Concrete connectors register
themselves with :mod:`app.connectors.registry` (built-ins) and can also be added
out-of-tree via the ``tlsoc.connectors`` entry-point group, so the community can
``pip install tlsoc-connector-<vendor>`` with no core change.
"""

from __future__ import annotations

from .base import (
    AuthField,
    Connector,
    ConnectionTest,
    ConnectorManifest,
    EmitFn,
    PullConnector,
    PushReceiver,
    QueryRendering,
    SearchResult,
    StructuredQuery,
)

__all__ = [
    "AuthField",
    "Connector",
    "ConnectionTest",
    "ConnectorManifest",
    "EmitFn",
    "PullConnector",
    "PushReceiver",
    "QueryRendering",
    "SearchResult",
    "StructuredQuery",
]
