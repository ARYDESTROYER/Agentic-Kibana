"""In-memory Elasticsearch fake for tests and key-less local runs.

It implements exactly the query/aggregation shapes the suite emits (see
``querybuilder.py``): bool(filter/must/should/must_not), term/terms/range/ids/
exists/match/match_all, sort, size/from, and the standup aggregations
(terms/cardinality/value_count/date_histogram). It is NOT a general ES emulator;
it is a faithful stand-in for the structures this codebase actually issues.
"""

from __future__ import annotations

import fnmatch
from typing import Any

from .base import BaseESClient
from ..utils import coerce_float, dotted_get, new_id, parse_es_timestamp


def _to_comparable(value: Any) -> float | None:
    """Best-effort conversion of a field value to a sortable/range-comparable
    number (timestamps become epoch millis)."""
    if value is None:
        return None
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        dt = parse_es_timestamp(value)
        if dt is not None and any(c in value for c in (":", "-", "T")):
            return dt.timestamp() * 1000.0
        return coerce_float(value, None)  # type: ignore[arg-type]
    return None


class InMemoryESClient(BaseESClient):
    def __init__(self) -> None:
        self.docs: dict[str, dict[str, dict[str, Any]]] = {}
        self.alias_to_index: dict[str, str] = {}
        self.templates: dict[str, dict[str, Any]] = {}

    # ----- test helpers -----
    def add_log(self, index: str, source: dict[str, Any], doc_id: str | None = None) -> str:
        """Seed a log-surface document (what upstream would have written)."""
        return self._store(index, source, doc_id)

    def _resolve(self, index: str) -> str:
        return self.alias_to_index.get(index, index)

    def _store(self, index: str, source: dict[str, Any], doc_id: str | None) -> str:
        target = self._resolve(index)
        self.docs.setdefault(target, {})
        did = doc_id or new_id()
        self.docs[target][did] = source
        return did

    def _matching_indices(self, pattern: str) -> list[str]:
        names: list[str] = []
        for part in pattern.split(","):
            part = self.alias_to_index.get(part.strip(), part.strip())
            for name in self.docs:
                if fnmatch.fnmatch(name, part):
                    if name not in names:
                        names.append(name)
        return names

    # ----- BaseESClient -----
    async def ping(self) -> bool:
        return True

    async def search_logs(self, index: str, body: dict[str, Any]) -> dict[str, Any]:
        return self._evaluate(index, body)

    async def index_template_exists(self, name: str) -> bool:
        return name in self.templates

    async def put_index_template(self, name: str, body: dict[str, Any]) -> None:
        self.templates[name] = body

    async def index_exists(self, name: str) -> bool:
        return self._resolve(name) in self.docs

    async def create_index(self, name: str, body: dict[str, Any] | None = None) -> None:
        self.docs.setdefault(name, {})
        for alias in (body or {}).get("aliases", {}):
            self.alias_to_index[alias] = name

    async def index_doc(
        self, index: str, doc: dict[str, Any], doc_id: str | None = None, refresh: bool = False
    ) -> str:
        # Production code writes to the contract write *aliases* (e.g.
        # ``tlsoc-agent-usage``) and reads back via the date-rolling pattern
        # ``<base>-*``. In a real cluster the alias points at a backing index
        # such as ``<base>-000001`` (created by bootstrap_indices), so the read
        # pattern resolves it. If the suite writes through such an alias without
        # having bootstrapped, auto-provision the backing index + alias exactly
        # like bootstrap_indices would, so the alias write lands somewhere the
        # ``<base>-*`` read pattern matches.
        if index not in self.alias_to_index and index not in self.docs:
            backing = f"{index}-000001"
            self.docs.setdefault(backing, {})
            self.alias_to_index[index] = backing
        return self._store(index, doc, doc_id)

    async def get_doc(self, index: str, doc_id: str) -> dict[str, Any] | None:
        target = self._resolve(index)
        return self.docs.get(target, {}).get(doc_id)

    async def update_doc(
        self, index: str, doc_id: str, doc: dict[str, Any], refresh: bool = False
    ) -> None:
        target = self._resolve(index)
        self.docs.setdefault(target, {})
        existing = self.docs[target].get(doc_id, {})
        merged = {**existing, **doc}
        self.docs[target][doc_id] = merged

    async def search(self, index: str, body: dict[str, Any]) -> dict[str, Any]:
        return self._evaluate(index, body)

    async def count(self, index: str, body: dict[str, Any]) -> int:
        result = self._evaluate(index, {"query": body.get("query", {"match_all": {}}), "size": 0})
        return int(result["hits"]["total"]["value"])

    async def close(self) -> None:
        return None

    # ----- query engine -----
    def _all_hits(self, pattern: str) -> list[tuple[str, str, dict[str, Any]]]:
        hits: list[tuple[str, str, dict[str, Any]]] = []
        for name in self._matching_indices(pattern):
            for did, src in self.docs[name].items():
                hits.append((name, did, src))
        return hits

    def _evaluate(self, pattern: str, body: dict[str, Any]) -> dict[str, Any]:
        query = body.get("query", {"match_all": {}})
        candidates = self._all_hits(pattern)
        matched = [(idx, did, src) for (idx, did, src) in candidates if _matches(query, did, src)]

        # Sorting
        sort = body.get("sort")
        if sort:
            for clause in reversed(_normalise_sort(sort)):
                field, order = clause
                reverse = order == "desc"
                matched.sort(
                    key=lambda t, f=field: _sort_key(t[1], t[2], f),
                    reverse=reverse,
                )

        total = len(matched)
        frm = int(body.get("from", 0) or 0)
        size = int(body.get("size", 10))
        window = matched[frm: frm + size] if size > 0 else []
        hits = [
            {
                "_index": idx,
                "_id": did,
                "_score": None,
                "_source": src,
                "sort": _sort_values(did, src, _normalise_sort(sort)) if sort else None,
            }
            for (idx, did, src) in window
        ]
        result: dict[str, Any] = {
            "hits": {"total": {"value": total, "relation": "eq"}, "hits": hits},
        }
        aggs = body.get("aggs") or body.get("aggregations")
        if aggs:
            result["aggregations"] = _aggregate(aggs, [src for (_i, _d, src) in matched])
        return result


# --------------------------------------------------------------------------- #
# Query matching
# --------------------------------------------------------------------------- #
def _matches(query: dict[str, Any], doc_id: str, src: dict[str, Any]) -> bool:
    if not query or "match_all" in query:
        return True
    if "bool" in query:
        return _matches_bool(query["bool"], doc_id, src)
    if "term" in query:
        (field, value), = query["term"].items()
        return _term_match(src, field, value)
    if "terms" in query:
        (field, values), = query["terms"].items()
        actual = dotted_get(src, field)
        actual_list = actual if isinstance(actual, list) else [actual]
        return any(str(a) in {str(v) for v in values} for a in actual_list)
    if "range" in query:
        (field, bounds), = query["range"].items()
        return _range_match(src, field, bounds)
    if "ids" in query:
        return doc_id in {str(v) for v in query["ids"].get("values", [])}
    if "exists" in query:
        return dotted_get(src, query["exists"]["field"]) is not None
    if "match" in query:
        (field, value), = query["match"].items()
        actual = dotted_get(src, field)
        return actual is not None and str(value).lower() in str(actual).lower()
    if "multi_match" in query:
        mm = query["multi_match"]
        needle = str(mm.get("query", "")).lower()
        return any(
            needle in str(dotted_get(src, f)).lower()
            for f in mm.get("fields", [])
            if dotted_get(src, f) is not None
        )
    return False


def _matches_bool(b: dict[str, Any], doc_id: str, src: dict[str, Any]) -> bool:
    for clause in b.get("filter", []) + b.get("must", []):
        if not _matches(clause, doc_id, src):
            return False
    for clause in b.get("must_not", []):
        if _matches(clause, doc_id, src):
            return False
    should = b.get("should", [])
    if should:
        has_hard = bool(b.get("filter") or b.get("must"))
        min_should = int(b.get("minimum_should_match", 0 if has_hard else 1))
        hits = sum(1 for c in should if _matches(c, doc_id, src))
        if hits < min_should:
            return False
    return True


def _term_match(src: dict[str, Any], field: str, value: Any) -> bool:
    actual = dotted_get(src, field)
    if actual is None:
        return False
    if isinstance(actual, list):
        return str(value) in {str(a) for a in actual}
    return str(actual) == str(value)


def _range_match(src: dict[str, Any], field: str, bounds: dict[str, Any]) -> bool:
    actual = _to_comparable(dotted_get(src, field))
    if actual is None:
        return False
    for op in ("gte", "gt", "lte", "lt"):
        if op in bounds:
            bound = _to_comparable(bounds[op])
            if bound is None:
                continue
            if op == "gte" and not actual >= bound:
                return False
            if op == "gt" and not actual > bound:
                return False
            if op == "lte" and not actual <= bound:
                return False
            if op == "lt" and not actual < bound:
                return False
    return True


# --------------------------------------------------------------------------- #
# Sorting
# --------------------------------------------------------------------------- #
def _normalise_sort(sort: Any) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for item in sort or []:
        if isinstance(item, str):
            out.append((item, "asc"))
        elif isinstance(item, dict):
            for field, spec in item.items():
                order = spec.get("order", "asc") if isinstance(spec, dict) else str(spec)
                out.append((field, order))
    return out


def _sort_key(doc_id: str, src: dict[str, Any], field: str) -> Any:
    if field in ("_id", "_doc"):
        return doc_id
    val = _to_comparable(dotted_get(src, field))
    return val if val is not None else float("-inf")


def _sort_values(doc_id: str, src: dict[str, Any], sort: list[tuple[str, str]]) -> list[Any]:
    return [_sort_key(doc_id, src, f) for (f, _o) in sort]


# --------------------------------------------------------------------------- #
# Aggregations
# --------------------------------------------------------------------------- #
def _aggregate(aggs: dict[str, Any], sources: list[dict[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for name, body in aggs.items():
        if "terms" in body:
            field = body["terms"]["field"]
            size = int(body["terms"].get("size", 10))
            counts: dict[str, int] = {}
            for src in sources:
                val = dotted_get(src, field)
                if val is None:
                    continue
                for v in (val if isinstance(val, list) else [val]):
                    counts[str(v)] = counts.get(str(v), 0) + 1
            buckets = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:size]
            out[name] = {"buckets": [{"key": k, "doc_count": c} for k, c in buckets]}
        elif "cardinality" in body:
            field = body["cardinality"]["field"]
            distinct = {
                str(v)
                for src in sources
                for v in ([dotted_get(src, field)] if not isinstance(dotted_get(src, field), list)
                          else dotted_get(src, field))
                if v is not None
            }
            out[name] = {"value": len(distinct)}
        elif "value_count" in body:
            field = body["value_count"]["field"]
            out[name] = {"value": sum(1 for src in sources if dotted_get(src, field) is not None)}
        elif "date_histogram" in body:
            dh = body["date_histogram"]
            field = dh["field"]
            interval_ms = _interval_to_ms(dh.get("fixed_interval", dh.get("calendar_interval", "1h")))
            buckets_map: dict[int, int] = {}
            for src in sources:
                ts = _to_comparable(dotted_get(src, field))
                if ts is None:
                    continue
                bucket = int(ts // interval_ms) * interval_ms
                buckets_map[bucket] = buckets_map.get(bucket, 0) + 1
            out[name] = {
                "buckets": [
                    {"key": k, "doc_count": c} for k, c in sorted(buckets_map.items())
                ]
            }
    return out


def _interval_to_ms(interval: str) -> int:
    units = {"s": 1000, "m": 60_000, "h": 3_600_000, "d": 86_400_000}
    try:
        return int(interval[:-1]) * units.get(interval[-1], 3_600_000)
    except (ValueError, IndexError):
        return 3_600_000
