"""Timestamp parsing edge cases (audit #15 / #17).

``parse_es_timestamp`` + ``relative_to_millis`` are the shared time seam used by the
OCSF normaliser, the poller windowing, and the log/query time-range resolution. A
mis-parse silently mis-dates events (collapsing distinct bursts) or corrupts a window.
"""

from __future__ import annotations

from datetime import datetime, timezone

from app.utils import parse_es_timestamp, relative_to_millis, to_millis


def test_parse_stringified_epoch_millis_and_seconds() -> None:
    # audit #15: a stringified epoch must NOT parse to None -> time 0 (1970).
    expected = datetime(2024, 6, 30, 16, 0, 0, tzinfo=timezone.utc)
    assert parse_es_timestamp("1719763200000") == expected  # millis string
    assert parse_es_timestamp("1719763200") == expected     # seconds string
    # Consistent with the int/float path.
    assert parse_es_timestamp(1719763200000) == expected
    assert parse_es_timestamp(1719763200.0) == expected


def test_parse_string_epoch_matches_numeric_and_is_not_1970() -> None:
    ts = parse_es_timestamp("1719763200000")
    assert ts is not None and ts.year == 2024  # NOT 1970


def test_distinct_epoch_strings_do_not_collapse() -> None:
    # Two different stringified epochs must yield different times (so bursts don't merge).
    a = parse_es_timestamp("1719763200000")
    b = parse_es_timestamp("1719763260000")  # +60s
    assert a is not None and b is not None
    assert to_millis(b) - to_millis(a) == 60_000


def test_parse_garbage_and_empty_still_none() -> None:
    assert parse_es_timestamp("not-a-time") is None
    assert parse_es_timestamp("") is None
    assert parse_es_timestamp("   ") is None
    assert parse_es_timestamp(None) is None
