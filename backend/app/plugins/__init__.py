"""Generic plugin infrastructure — the ONE entry-point registry pattern.

Round 5 (Coupling-F / G8) factored the byte-identical entry-point discovery +
register-with-override-log + defensive manifest-listing logic that the connector and
enrichment registries each duplicated into ONE tested helper
(:class:`app.plugins.registry.EntryPointRegistry`). Every keyed plugin registry in
the suite (connectors, enrichment providers, notification channels, LLM providers)
now composes it, so there is a SINGLE place for the discovery contract:

* one bad third-party plugin can never break startup or listing (per-item try/except),
* discovery order is stable/deterministic (sorted),
* built-in-vs-third-party precedence is explicit ("overridden by" log), and
* discovery never raises out of ``_discover`` (a broken entry-point group is warned).

See :mod:`app.plugins.registry` for the SPI.
"""

from __future__ import annotations

from .registry import EntryPointRegistry, discover_entry_points

__all__ = ["EntryPointRegistry", "discover_entry_points"]
