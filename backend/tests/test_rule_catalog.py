"""Rule catalog (C3-1) + per-rule model selection (C3-6b).

Proves:
  1. ``match_rule`` classifies ModSec events to their sub-rule (rule.id prefix)
     and the 13 ``event.module`` rules, with priority ordering (sub-rule beats
     the generic ``modsec_audit_log`` rule).
  2. An EMPTY catalog leaves ``RawEvent.from_hit`` rule tagging byte-identical.
  3. ``correlate`` uses the per-rule CorrelationRule and the matched rule name
     flows into ``TriggerReason.sentence``.
  4. ``model_for_rule`` precedence + the pipeline actually uses it (the override
     model reaches the gateway).
  5. Seeding seeds when empty and is a NO-OP once populated / at the current
     seed version, and NEVER clobbers an operator-edited catalog.
"""

from __future__ import annotations

import json

from app.config import (
    RULE_CATALOG_SEED_VERSION,
    CorrelationRule,
    ModelConfig,
    Preferences,
    RuleDefinition,
    RuleMatch,
    default_rule_catalog,
)
from app.constants import CorrelationMode, EntityType, Role, SourceSurface
from app.engine.correlation import correlate
from app.models import RawEvent
from app.state import AppState
from tests.conftest import make_log_event, make_raw_event


# --------------------------------------------------------------------------- #
# 1. match_rule classification + priority
# --------------------------------------------------------------------------- #
def _seeded() -> Preferences:
    p = Preferences()
    p.maybe_seed_rule_catalog()
    return p


def test_match_rule_modsec_xss_beats_generic_by_priority():
    p = _seeded()
    # A ModSec event carrying an OWASP CRS rule.id of 941100 (XSS) must classify
    # as the sub-rule, NOT the generic modsec_audit_log, because the sub-rule has
    # a lower priority and is evaluated first.
    # Real _source carries a SCALAR rule.id (audit #16): the seeded rule matches the
    # ``rule.id`` path, NOT the ``rule.id.keyword`` ES index sub-field (never in _source).
    src = {"event": {"module": "modsec_audit_log"}, "rule": {"id": "941100"}}
    rd = p.match_rule(src)
    assert rd is not None
    assert rd.name == "modsec_xss"

    # Each ModSec family resolves to its own sub-rule.
    families = {"942100": "modsec_sqli", "930100": "modsec_lfi",
                "932100": "modsec_rce", "913100": "modsec_scanner"}
    for rid, name in families.items():
        rd = p.match_rule({"event": {"module": "modsec_audit_log"},
                           "rule": {"id": rid}})
        assert rd is not None and rd.name == name


def test_match_rule_modsec_falls_back_to_generic_without_rule_id():
    p = _seeded()
    rd = p.match_rule({"event": {"module": "modsec_audit_log"}})
    assert rd is not None and rd.name == "modsec_audit_log"


def test_match_rule_classifies_all_13_event_modules():
    p = _seeded()
    modules = [
        "mail_apache_access", "mail_auth", "mail_fim", "ml_stats", "modsec_audit_log",
        "openvas_report", "postfix", "roundcube_login", "suricata_mail",
        "waf-nginx-access", "waf_auth", "web_apache_access", "web_auth",
    ]
    for module in modules:
        rd = p.match_rule({"event": {"module": module}})
        assert rd is not None and rd.name == module


def test_match_rule_returns_none_when_nothing_matches():
    p = _seeded()
    assert p.match_rule({"event": {"module": "totally_unknown_thing"}}) is None


def test_match_rule_ops_tag_and_exists():
    p = Preferences()
    p.rule_catalog = [
        RuleDefinition(name="xss_tag", match=RuleMatch(
            field="rule.tags", op="tag", value="OWASP_CRS/ATTACK-XSS"), priority=10),
        RuleDefinition(name="has_user", match=RuleMatch(
            field="user.name", op="exists"), priority=20),
    ]
    assert p.match_rule({"rule": {"tags": ["X", "OWASP_CRS/ATTACK-XSS"]}}).name == "xss_tag"
    assert p.match_rule({"user": {"name": "root"}}).name == "has_user"
    assert p.match_rule({"user": {"name": ""}}) is None  # exists requires non-empty


# --------------------------------------------------------------------------- #
# 2. Empty-catalog backward compat for from_hit
# --------------------------------------------------------------------------- #
def test_from_hit_empty_catalog_is_unchanged():
    p = Preferences()
    assert p.rule_catalog == []
    hit = {"_id": "x", "_index": "all-logs-1", "_source": make_log_event(rule="linux_auth")}
    ev = RawEvent.from_hit(hit, p)
    # Empty catalog -> single rule_field derivation (event.module).
    assert ev.rule == "linux_auth"


def test_from_hit_nonempty_catalog_classifies_modsec_subrule():
    p = _seeded()
    src = {
        "@timestamp": "2026-06-16T00:00:00+00:00",
        "event": {"module": "modsec_audit_log"},
        "rule": {"id": "941100"},
        "source": {"ip": "1.2.3.4"},
    }
    ev = RawEvent.from_hit({"_id": "m1", "_index": "all-logs-1", "_source": src}, p)
    assert ev.rule == "modsec_xss"


def test_from_hit_nonempty_catalog_no_match_uses_fallback():
    p = _seeded()
    # An event whose module is NOT in the catalog falls back to today's value.
    hit = {"_id": "y", "_index": "all-logs-1", "_source": make_log_event(rule="linux_auth")}
    ev = RawEvent.from_hit(hit, p)
    assert ev.rule == "linux_auth"


# --------------------------------------------------------------------------- #
# 3. correlate uses per-rule CorrelationRule; matched rule name in TriggerReason
# --------------------------------------------------------------------------- #
def test_correlate_uses_rule_definition_correlation_and_trigger_sentence():
    p = Preferences()
    # A single sub-rule with an EVERY correlation override: one event triggers.
    p.rule_catalog = [
        RuleDefinition(
            name="modsec_xss",
            match=RuleMatch(field="rule.id", op="prefix", value="941"),
            correlation=CorrelationRule(mode=CorrelationMode.EVERY, group_by=EntityType.IP),
            priority=50,
        )
    ]
    # Build a raw event already tagged modsec_xss (as from_hit would).
    ev = make_raw_event(id="e1", ip="9.9.9.9", rule="modsec_xss")
    clusters = correlate([ev], p)
    assert len(clusters) == 1
    tr = clusters[0].trigger_reason
    assert tr is not None
    assert tr.rule_value == "modsec_xss"
    assert "modsec_xss" in tr.sentence
    assert tr.mode == CorrelationMode.EVERY.value


def test_correlate_empty_catalog_still_honours_correlation_rules():
    """Backward compat: with an empty catalog, correlate keeps the legacy
    correlation_rules[name] lookup (NOT just the default)."""
    p = Preferences()
    p.default_correlation = CorrelationRule(mode=CorrelationMode.NEVER)
    p.correlation_rules = {"r": CorrelationRule(mode=CorrelationMode.EVERY, group_by=EntityType.IP)}
    ev = make_raw_event(id="e1", ip="1.1.1.1", rule="r")
    clusters = correlate([ev], p)
    assert len(clusters) == 1  # named rule (EVERY) fired despite NEVER default


# --------------------------------------------------------------------------- #
# 4. model_for_rule precedence + pipeline uses it
# --------------------------------------------------------------------------- #
def test_model_for_rule_precedence():
    p = Preferences()
    # (3) default when no override
    assert p.model_for_rule("investigator", "postfix").model == p.investigator_model.model
    # (2) rule_model_override beats default
    p.rule_model_override["postfix"] = ModelConfig(model="rule-level")
    assert p.model_for_rule("investigator", "postfix").model == "rule-level"
    # (1) RuleDefinition.model_override beats rule_model_override
    p.rule_catalog = [RuleDefinition(
        name="postfix",
        match=RuleMatch(field="event.module", op="equals", value="postfix"),
        model_override={"investigator": ModelConfig(model="def-level")},
    )]
    assert p.model_for_rule("investigator", "postfix").model == "def-level"
    # Role enum accepted, identical result
    assert p.model_for_rule(Role.INVESTIGATOR, "postfix").model == "def-level"
    # None rule_value -> role default
    assert p.model_for_rule("investigator", None).model == p.investigator_model.model


async def test_pipeline_uses_per_rule_model_override(app_state: AppState, mock_provider):
    from app.engine.correlation import cluster_from_events

    # Configure a per-rule investigator model override for a custom rule.
    p = app_state.prefs.model_copy(deep=True)
    p.rule_model_override["custom_rule"] = ModelConfig(model="custom-investigator-model")
    await app_state.update_prefs(p)

    base = 1_700_000_000_000
    events = [make_raw_event(id=f"e{i}", ip="2.2.2.2", rule="custom_rule",
                             ts_millis=base + i * 1000) for i in range(3)]
    cluster = cluster_from_events(EntityType.IP, "2.2.2.2", events)

    mock_provider.push("router", json.dumps(
        {"bucket": "needs_strong_model", "confidence": 0.9, "reason": "serious"}))
    mock_provider.push("investigator", json.dumps({
        "action": "final", "reasoning": "x",
        "verdict": {"verdict": "NEEDS_HUMAN", "confidence": 0.2,
                    "evidence": [], "mitre": [], "recommended_action": "review",
                    "reproduce_query": ""},
    }))
    await app_state.pipeline.investigate_cluster(cluster, SourceSurface.INVESTIGATE, app_state.prefs)

    inv_calls = [c for c in mock_provider.calls if c["role"] == "investigator"]
    assert inv_calls, "investigator was not called"
    assert all(c["model"] == "custom-investigator-model" for c in inv_calls)


async def test_pipeline_default_model_when_no_override(app_state: AppState, mock_provider):
    from app.engine.correlation import cluster_from_events

    base = 1_700_000_000_000
    events = [make_raw_event(id=f"e{i}", ip="3.3.3.3", rule="no_override_rule",
                             ts_millis=base + i * 1000) for i in range(3)]
    cluster = cluster_from_events(EntityType.IP, "3.3.3.3", events)
    mock_provider.push("router", json.dumps(
        {"bucket": "needs_strong_model", "confidence": 0.9, "reason": "serious"}))
    mock_provider.push("investigator", json.dumps({
        "action": "final", "reasoning": "x",
        "verdict": {"verdict": "NEEDS_HUMAN", "confidence": 0.2,
                    "evidence": [], "mitre": [], "recommended_action": "review",
                    "reproduce_query": ""},
    }))
    await app_state.pipeline.investigate_cluster(cluster, SourceSurface.INVESTIGATE, app_state.prefs)
    inv_calls = [c for c in mock_provider.calls if c["role"] == "investigator"]
    assert inv_calls
    # No override -> the role-default investigator model is used.
    assert all(c["model"] == app_state.prefs.investigator_model.model for c in inv_calls)


# --------------------------------------------------------------------------- #
# 5. Seeding: seeds when empty, no-op when populated / current version
# --------------------------------------------------------------------------- #
def test_seed_when_empty():
    p = Preferences()
    assert p.rule_catalog == [] and p.rule_catalog_seed_version == 0
    assert p.maybe_seed_rule_catalog() is True
    assert len(p.rule_catalog) == len(default_rule_catalog())
    assert p.rule_catalog_seed_version == RULE_CATALOG_SEED_VERSION


def test_seed_is_noop_when_current():
    p = _seeded()
    n = len(p.rule_catalog)
    assert p.maybe_seed_rule_catalog() is False
    assert len(p.rule_catalog) == n


def test_seeded_modsec_rules_use_real_rule_id_field():
    # audit #16: the seeded ModSec sub-rules must match the real _source ``rule.id``,
    # never the ES index sub-field ``rule.id.keyword`` (absent from _source).
    cat = default_rule_catalog()
    modsec = [r for r in cat if r.name.startswith("modsec_") and r.match.op == "prefix"]
    assert modsec, "expected seeded ModSec sub-rules"
    assert all(r.match.field == "rule.id" for r in modsec)
    # And a real event (scalar rule.id) actually classifies now (buggy shape would not).
    p = _seeded()
    assert p.match_rule({"event": {"module": "modsec_audit_log"},
                         "rule": {"id": "941100"}}).name == "modsec_xss"


def test_reseed_heals_broken_modsec_field_without_clobbering_edits():
    # audit #16: a store previously seeded with the buggy field gets healed on the
    # version bump, but an operator's OWN rule is preserved.
    p = Preferences()
    p.rule_catalog = [
        RuleDefinition(name="modsec_xss",
                       match=RuleMatch(field="rule.id.keyword", op="prefix", value="941"),
                       priority=50),
        RuleDefinition(name="my_rule",
                       match=RuleMatch(field="event.module", op="equals", value="mine")),
    ]
    p.rule_catalog_seed_version = 1  # older than current
    healed = p.maybe_seed_rule_catalog()
    assert healed is True
    by_name = {r.name: r for r in p.rule_catalog}
    assert by_name["modsec_xss"].match.field == "rule.id"   # healed
    assert by_name["my_rule"].match.field == "event.module"  # untouched
    assert [r.name for r in p.rule_catalog] == ["modsec_xss", "my_rule"]  # not clobbered
    assert p.rule_catalog_seed_version == RULE_CATALOG_SEED_VERSION


def test_seed_never_clobbers_operator_edits():
    p = Preferences()
    # Operator has a non-empty catalog but an OLD/missing seed version.
    p.rule_catalog = [RuleDefinition(
        name="my_only_rule", match=RuleMatch(field="event.module", op="equals", value="x"))]
    p.rule_catalog_seed_version = 0
    assert p.maybe_seed_rule_catalog() is False  # never overwritten
    assert [rd.name for rd in p.rule_catalog] == ["my_only_rule"]
    # version marker bumped so we stop re-checking every boot
    assert p.rule_catalog_seed_version == RULE_CATALOG_SEED_VERSION


async def test_startup_seeds_and_persists(app_state: AppState):
    # The app_state fixture already ran startup -> the catalog is seeded + saved.
    assert app_state.prefs.rule_catalog, "startup did not seed the catalog"
    assert app_state.prefs.rule_catalog_seed_version == RULE_CATALOG_SEED_VERSION
    # Re-loading from the store returns the persisted (seeded) catalog.
    reloaded = await app_state.config_store.load()
    assert len(reloaded.rule_catalog) == len(default_rule_catalog())
    # A second seeding pass is a no-op (does not duplicate or grow the catalog).
    again = await app_state.config_store.seed_rule_catalog(reloaded)
    assert len(again.rule_catalog) == len(default_rule_catalog())
