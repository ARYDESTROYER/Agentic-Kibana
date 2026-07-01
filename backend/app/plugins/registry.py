"""``EntryPointRegistry[T]`` — the one generic keyed-plugin registry.

The connector registry (``connectors/registry.py``) and the enrichment-provider
registry (``enrichment/registry.py``) each hand-rolled the SAME ~120 lines: a
``key -> class`` dict, a ``register()`` that logs an intentional "overridden by"
precedence, a ``get()``, a defensive per-item ``manifests()`` (one bad plugin never
breaks listing), and an ``importlib.metadata`` entry-point discovery pass that warns
(never raises) on a bad group / bad plugin. Round 5 factors that into ONE generic,
tested helper; the two registries (plus notifications + LLM providers) now compose it.

The generic is deliberately SMALL and stdlib-only (``importlib.metadata`` — never
pluggy/stevedore, which would be new runtime deps). It keys a plugin by a caller-
supplied ``key_of`` function so it works for ``SourceType``-keyed connectors AND
``str``-name-keyed providers/channels without change. Precedence (built-in vs a later
third-party registration) is EXPLICIT and logged, never load-order-dependent.
"""

from __future__ import annotations

import importlib.metadata as importlib_metadata
import logging
from typing import Callable, Generic, Iterable, Iterator, TypeVar

logger = logging.getLogger("tlsoc.plugins.registry")

# The registered VALUE is usually a class (``type[...]``), but the generic never
# assumes that — a factory or instance works too. K is the key type (SourceType | str).
T = TypeVar("T")
K = TypeVar("K")


def discover_entry_points(
    group: str,
    register: Callable[[T], None],
    *,
    what: str = "plugin",
    log: logging.Logger | None = None,
) -> None:
    """Discover + register every object exported under the ``group`` entry-point group.

    The ONE discovery routine both registries used verbatim: enumerate
    ``importlib.metadata.entry_points(group=...)``, ``ep.load()`` each, and hand it to
    ``register``. Every failure mode is isolated + WARNED, never raised:

    * a broken/absent entry-point GROUP (or an old metadata API) warns once + returns,
    * a single entry point that fails to import/load warns + is skipped,

    so third-party discovery can NEVER break startup or listing. ``what`` only labels
    the log lines (``"connector"`` / ``"enrichment provider"`` / ...).
    """
    lg = log or logger
    try:
        eps: Iterable = importlib_metadata.entry_points(group=group)
    except Exception as exc:  # noqa: BLE001 — never let discovery break startup
        lg.warning("%s entry-point discovery failed for group '%s': %s", what, group, exc)
        return
    for ep in eps:
        name = getattr(ep, "name", "?")
        try:
            obj = ep.load()
            register(obj)
            lg.info("Loaded %s '%s' from entry point", what, name)
        except Exception as exc:  # noqa: BLE001 — one bad plugin never breaks discovery
            lg.warning("Could not load %s entry point '%s': %s", what, name, exc)


class EntryPointRegistry(Generic[K, T]):
    """A ``key -> plugin`` registry with entry-point discovery + safe manifest listing.

    Construct with:

    * ``group`` — the ``importlib.metadata`` entry-point group
      (``"tlsoc.connectors"`` / ``"tlsoc.enrichers"`` / ...).
    * ``key_of`` — extract a plugin's key (``lambda cls: cls.source_type`` /
      ``lambda cls: cls.name``). Returning ``None``/empty SKIPS registration (warned).
    * ``what`` — a short label used only in log lines.
    * ``log`` — an optional module logger (so warnings read from the right namespace).

    Subclasses/consumers add their manifest shape on top via :meth:`iter_manifests`
    (which already applies the per-item try/except); the generic owns key handling,
    the "overridden by" precedence log, ``get``, iteration + discovery.
    """

    def __init__(
        self,
        group: str,
        key_of: Callable[[T], K | None],
        *,
        what: str = "plugin",
        log: logging.Logger | None = None,
    ) -> None:
        self._group = group
        self._key_of = key_of
        self._what = what
        self._log = log or logger
        self._items: dict[K, T] = {}

    # ------------------------------------------------------------------ #
    # Registration + lookup.
    # ------------------------------------------------------------------ #
    def register(self, item: T) -> None:
        """Register ``item`` under its extracted key.

        A missing/empty key is skipped + warned (never raises). Re-registering a key
        with a DIFFERENT object logs the intentional "overridden by" precedence (a
        third-party plugin deliberately shadowing a built-in) — the LAST registration
        wins, matching the historical connector/enrichment behaviour."""
        try:
            key = self._key_of(item)
        except Exception as exc:  # noqa: BLE001 — a bad key extractor never breaks registration
            self._log.warning("%s %s has no resolvable key (%s); skipping", self._what, item, exc)
            return
        if key is None or (isinstance(key, str) and not key):
            self._log.warning("%s %s has no key; skipping", self._what, item)
            return
        existing = self._items.get(key)
        if existing is not None and existing is not item:
            self._log.info(
                "%s for '%s' overridden by %s", self._what, _key_label(key),
                getattr(item, "__name__", item),
            )
        self._items[key] = item

    def get(self, key: K) -> T | None:
        return self._items.get(key)

    def keys(self) -> list[K]:
        return list(self._items.keys())

    def values(self) -> list[T]:
        return list(self._items.values())

    def __contains__(self, key: object) -> bool:
        return key in self._items

    def __iter__(self) -> Iterator[T]:
        return iter(self._items.values())

    def pop(self, key: K) -> T | None:
        """Remove + return the plugin under ``key`` (used by the demo-connector toggle)."""
        return self._items.pop(key, None)

    # ------------------------------------------------------------------ #
    # Manifest listing (defensive — one bad plugin never breaks the list).
    # ------------------------------------------------------------------ #
    def iter_manifests(
        self,
        manifest_of: Callable[[T], object],
        *,
        transform: Callable[[T, object], object] | None = None,
    ) -> list[object]:
        """Every plugin's manifest via ``manifest_of``, each wrapped in try/except so
        one raising plugin is logged + skipped (the list stays complete for the rest).

        ``transform(item, manifest)`` optionally post-processes each manifest (the
        connector registry uses it to augment push-receiver capabilities/setup_help).
        Caller sorts; the generic keeps insertion order."""
        out: list[object] = []
        for item in self._items.values():
            try:
                m = manifest_of(item)
                if transform is not None:
                    m = transform(item, m)
                out.append(m)
            except Exception as exc:  # noqa: BLE001 — one bad plugin must not break listing
                self._log.warning("manifest() failed for %s: %s", item, exc)
        return out

    # ------------------------------------------------------------------ #
    # Discovery.
    # ------------------------------------------------------------------ #
    def discover(self) -> None:
        """Discover + register every plugin exported under this registry's entry-point
        group. Isolated + warned end-to-end (see :func:`discover_entry_points`)."""
        discover_entry_points(self._group, self.register, what=self._what, log=self._log)


def _key_label(key: object) -> str:
    """A short, log-safe label for a registry key (``SourceType`` value or a str)."""
    return getattr(key, "value", None) or str(key)
