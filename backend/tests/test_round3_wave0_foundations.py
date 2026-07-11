"""Round 3 — Wave 0 backend hot-file foundations.

Locks the additive scaffolding ALL twelve Round-3 features build on:

* the new ADVISORY ``Case`` axes (severity/impact/urgency/priority + SLA lifecycle
  timestamps) serialise round-trip;
* the new additive model classes + config blocks exist with sane defaults; and
* ⚠ NON-NEGOTIABLE #3 — none of the new advisory ``Case`` fields is ever referenced
  inside ``engine/case_manager.py`` (the deterministic close/escalate decision stays a
  pure fn of verdict/confidence/risk_score/policy). This test is the Round-3 guard
  that keeps it that way.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path

import app.engine.case_manager as case_manager_module
from app.config import (
    BudgetConfig,
    EnrichmentConfig,
    Preferences,
    PriorityMatrix,
    RealtimeConfig,
    SlaPolicy,
)
from app.constants import (
    AuthorType,
    IndicatorKind,
    Material,
    NotificationCategory,
)
from app.constants import ActionType
from app.models import (
    ActionItem,
    Case,
    CaseActivity,
    CaseMessage,
    CaseTask,
    CustomRole,
    Entity,
    InAppNotification,
    NotificationPref,
    Observable,
    ProviderResult,
    ShiftAck,
    TraceSpan,
)
from app.constants import EntityType, SourceSurface


# The new ADVISORY Case fields added in Round 3 Wave 0. NONE of these may be read by
# case_manager.decide() (#3). Kept here as the single source of truth for the guard.
_ADVISORY_CASE_FIELDS = (
    "severity_band",
    "severity_source",
    "impact_band",
    "urgency_band",
    "priority_level",
    "detected_at",
    "acknowledged_at",
    "first_response_at",
)


def _case(**extra) -> Case:
    return Case(
        case_id="case-r3w0",
        cluster_signature="sig",
        source_surface=SourceSurface.INVESTIGATE,
        entity=Entity(type=EntityType.IP, value="203.0.113.7"),
        **extra,
    )


def test_advisory_case_fields_round_trip() -> None:
    """A Case with EVERY new advisory field set serialises + deserialises unchanged."""
    now = datetime.now(timezone.utc)
    case = _case(
        severity_band="critical",
        severity_source="derived",
        impact_band="high",
        urgency_band="high",
        priority_level="P1",
        detected_at=now,
        acknowledged_at=now,
        first_response_at=now,
    )
    dumped = case.model_dump(mode="json")
    restored = Case.model_validate(dumped)

    assert restored.severity_band == "critical"
    assert restored.severity_source == "derived"
    assert restored.impact_band == "high"
    assert restored.urgency_band == "high"
    assert restored.priority_level == "P1"
    assert restored.detected_at == now
    assert restored.acknowledged_at == now
    assert restored.first_response_at == now
    # Full-model equality after a canonical re-validate (catches any silent coercion).
    assert Case.model_validate(restored.model_dump(mode="json")) == restored


def test_advisory_case_fields_default_none() -> None:
    """The advisory axes default to None so legacy stored cases load unchanged."""
    case = _case()
    for name in _ADVISORY_CASE_FIELDS:
        assert getattr(case, name) is None, f"{name} must default None (back-compat)"


def test_case_manager_never_references_advisory_fields() -> None:
    """⚠ #3 LOCK: the new advisory Case field names appear NOWHERE in case_manager.py.

    Reads the deterministic Case Manager source directly and asserts that none of the
    Round-3 advisory axes is referenced — guaranteeing decide()/apply() can never come
    to depend on severity/impact/urgency/priority/SLA timing. If a later wave wires one
    of these into the decision, THIS test fails loudly."""
    src = Path(case_manager_module.__file__).read_text(encoding="utf-8")
    for name in _ADVISORY_CASE_FIELDS:
        assert not re.search(rf"\b{name}\b", src), (
            f"NON-NEGOTIABLE #3 violated: case_manager.py references advisory field "
            f"'{name}' — the deterministic decision must stay a pure fn of "
            f"verdict/confidence/risk_score/policy."
        )


def test_new_model_classes_construct_with_defaults() -> None:
    """Every new additive model class instantiates with sane defaults + round-trips."""
    models = [
        Observable(type="ip", value="203.0.113.7"),
        ProviderResult(provider="greynoise", indicator="203.0.113.7", indicator_kind="ip"),
        CaseMessage(case_id="case-r3w0", author="alice", body="hello"),
        CaseActivity(case_id="case-r3w0", kind="assigned", actor="alice"),
        CaseTask(case_id="case-r3w0", title="contain host"),
        InAppNotification(recipient="alice", category="mention", title="t", body="b"),
        NotificationPref(user="alice"),
        CustomRole(name="triage_lead"),
        ActionItem(title="follow up"),
        ShiftAck(user="alice", window="2026-06-30/day"),
        TraceSpan(case_id="case-r3w0", kind="invoke_agent", name="router"),
    ]
    for m in models:
        # generated ids are non-empty where the model declares one
        restored = type(m).model_validate(m.model_dump(mode="json"))
        assert restored == m


def test_new_enums_have_expected_members() -> None:
    assert IndicatorKind.URL.value == "url"
    assert IndicatorKind.EMAIL.value == "email"
    assert {k.value for k in IndicatorKind} >= {"ip", "domain", "url", "file_hash", "email", "host"}
    assert {a.value for a in AuthorType} == {"human", "ai", "system"}
    assert NotificationCategory.MENTION.value == "mention"
    assert {m.value for m in Material} == {"quiet", "command"}
    # New collaboration/notification audit action types are additive.
    for name in ("THREAD_POST", "REACTION", "TASK_UPDATE", "INAPP_NOTIFY"):
        assert hasattr(ActionType, name)


def test_new_config_blocks_default_safe() -> None:
    """The new Preferences blocks exist, default to safe values, and round-trip.

    Autopilot overhaul: the advisory SLA / priority / realtime blocks + the budget
    backstop default ON (all $0 / #3-safe), with a hard provider-spend ceiling."""
    prefs = Preferences()
    assert isinstance(prefs.sla, SlaPolicy) and prefs.sla.enabled is True
    assert isinstance(prefs.priority_matrix, PriorityMatrix)
    assert prefs.priority_matrix.matrix["high/high"] == "P1"
    assert isinstance(prefs.budget, BudgetConfig) and prefs.budget.enabled is True
    assert prefs.budget.on_exceed == "block"         # hard spend ceiling; never drops a case
    assert prefs.budget.daily_usd == 10.0
    assert isinstance(prefs.realtime, RealtimeConfig) and prefs.realtime.enabled is True
    # Full prefs canonical round-trip (no new field breaks the serializer).
    assert Preferences.model_validate(prefs.model_dump(mode="json")) == prefs


def test_enrichment_provider_defaults() -> None:
    """Keyless providers default ON; every key-gated provider defaults OFF."""
    e: EnrichmentConfig = Preferences().enrichment
    # keyless → ON
    for f in ("use_shodan_internetdb", "use_ipinfo", "use_urlhaus", "use_threatfox",
              "use_malwarebazaar", "use_rdap"):
        assert getattr(e, f) is True, f"{f} should default ON (keyless)"
    # key-gated → OFF (opt-in after configuring a key)
    for f in ("use_greynoise", "use_shodan", "use_censys", "use_binaryedge", "use_otx",
              "use_pulsedive", "use_spur", "use_xforce", "use_urlscan", "use_hibp"):
        assert getattr(e, f) is False, f"{f} should default OFF (key-gated)"
    assert e.fusion_enabled is False


def test_new_provider_secret_keys_are_boolean_only() -> None:
    """The new provider API-key fields surface as configured-booleans only (#10) and
    are never present as raw values in the settings-facing status view."""
    from app.config import Secrets

    status = Secrets().configured_status()
    for key in ("greynoise_api_key", "shodan_api_key", "censys_api_id", "censys_api_secret",
                "binaryedge_api_key", "ipinfo_token", "otx_api_key", "pulsedive_api_key",
                "spur_api_key", "xforce_api_key", "xforce_api_password", "urlscan_api_key",
                "hibp_api_key"):
        assert key in status
        assert status[key] is False  # nothing configured by default
