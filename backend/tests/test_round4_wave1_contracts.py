"""Round 4 — Wave 1 additive-contract foundations.

Locks the additive scaffolding ALL Round-4 features build on (this wave is contracts
ONLY — no behaviour, no wiring):

* the new enums (CampaignStatus / BatchJobState / DetectionSource / ResetScope) + the
  two new audit ActionTypes (TUNING / RESET) exist with the right values;
* the new KV-namespace triples (CAMPAIGNS / BASELINE / BATCH_JOBS / TUNING) exist;
* UsageDoc gains cache_read_tokens / cache_write_tokens / batch (defaulted 0/0/False)
  and an OLD UsageDoc dict (without them) still validates + cost is untouched;
* the new models (Campaign / BaselineState / BatchJob / DetectionRule) instantiate with
  defaults and round-trip;
* the new Preferences blocks (threshold_tuning / batch / baseline / campaign) default
  disabled, caps.max_concurrent == 3, and the BrandingConfig login_* fields default +
  reject markup ('<');
* AutomationRule IS CaseAutomationRule (the Round-4 alias) and a legacy stored
  ``threshold_automation`` config still parses byte-compatibly; and
* ⚠ NON-NEGOTIABLE #3 — the new advisory Case field names (campaign_id /
  detection_source) appear NOWHERE in ``engine/case_manager.py``.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

import app.engine.case_manager as case_manager_module
from app import constants
from app.config import (
    AutomationRule,
    BaselineConfig,
    BatchConfig,
    BrandingConfig,
    CampaignConfig,
    CaseAutomationRule,
    Preferences,
    ThresholdAutomationConfig,
    ThresholdTuningConfig,
)
from app.constants import (
    ActionType,
    BatchJobState,
    CampaignStatus,
    DetectionSource,
    ResetScope,
)
from app.models import (
    BaselineState,
    BatchJob,
    Campaign,
    CampaignEntity,
    DetectionRule,
    UsageDoc,
)


# The new ADVISORY Case fields added in Round 4 Wave 1. NONE may be read by
# case_manager.decide() (#3). Single source of truth for the guard below.
_R4_ADVISORY_CASE_FIELDS = ("campaign_id", "detection_source")


# --------------------------------------------------------------------------- #
# Enums + audit action types
# --------------------------------------------------------------------------- #
def test_new_enums_have_expected_members() -> None:
    assert {s.value for s in CampaignStatus} == {"open", "monitoring", "resolved"}
    assert {s.value for s in BatchJobState} == {
        "submitted", "polling", "retrieving", "retrieved", "errored", "expired",
    }
    assert {s.value for s in DetectionSource} == {"detection", "anomaly", "rule"}
    assert {s.value for s in ResetScope} == {"cases", "sources", "factory"}


def test_new_action_types() -> None:
    assert ActionType.TUNING.value == "tuning"
    assert ActionType.RESET.value == "reset"


# --------------------------------------------------------------------------- #
# KV-namespace triples (mirror the Round-3 CASE_THREAD / INBOX / PRICE_OVERLAY style)
# --------------------------------------------------------------------------- #
def test_new_kv_namespace_triples_exist() -> None:
    for prefix in ("CAMPAIGNS", "BASELINE", "BATCH_JOBS", "TUNING"):
        for suffix in ("NS", "KEY", "DOC_ID"):
            name = f"{prefix}_{suffix}"
            assert hasattr(constants, name), f"missing constant {name}"
            assert isinstance(getattr(constants, name), str)
    # The DOC_ID is the ES doc id within CONFIG_INDEX (same convention as Round 3).
    assert constants.CAMPAIGNS_NS == "campaigns"
    assert constants.BASELINE_NS == "baseline"
    assert constants.BATCH_JOBS_NS == "batch_jobs"
    assert constants.TUNING_NS == "tuning"


# --------------------------------------------------------------------------- #
# UsageDoc — additive cache/batch fields, cost untouched, old docs still load
# --------------------------------------------------------------------------- #
def test_usage_doc_new_fields_default() -> None:
    u = UsageDoc()
    assert u.cache_read_tokens == 0
    assert u.cache_write_tokens == 0
    assert u.batch is False
    # Cost is NOT changed this wave.
    assert u.cost == 0.0


def test_usage_doc_old_dict_still_validates() -> None:
    """A stored UsageDoc predating the Round-4 fields loads unchanged (no migration)."""
    old = {
        "ts": "2026-01-01T00:00:00Z",
        "surface": "automated_scan",
        "role": "investigator",
        "model": "claude-sonnet-4-6",
        "prompt_tokens": 100,
        "completion_tokens": 50,
        "total_tokens": 150,
        "cost": 0.0123,
        "currency": "USD",
        "latency_ms": 42,
        "outcome": "ok",
        "pricing_source": "exact",
    }
    u = UsageDoc.model_validate(old)
    assert u.cache_read_tokens == 0 and u.cache_write_tokens == 0 and u.batch is False
    assert u.cost == 0.0123  # cost carried through verbatim
    # And a round-trip is stable.
    assert UsageDoc.model_validate(u.model_dump(mode="json")) == u


def test_usage_doc_new_fields_round_trip() -> None:
    u = UsageDoc(cache_read_tokens=10, cache_write_tokens=5, batch=True)
    restored = UsageDoc.model_validate(u.model_dump(mode="json"))
    assert restored == u
    assert restored.cache_read_tokens == 10
    assert restored.cache_write_tokens == 5
    assert restored.batch is True


# --------------------------------------------------------------------------- #
# New models — instantiate with defaults + round-trip
# --------------------------------------------------------------------------- #
def test_new_models_construct_with_defaults() -> None:
    models = [
        Campaign(),
        Campaign(
            id="camp-1",
            case_ids=["case-a", "case-b"],
            entities=[CampaignEntity(entity_type="ip", value="203.0.113.7")],
            mitre=["T1078"],
            status=CampaignStatus.MONITORING,
        ),
        BaselineState(),
        BaselineState(welford_m=1.0, welford_s=2.0, n=3, ewma=1.5, ewma_sq=2.25,
                      tdigest=[[1.0, 2.0], [3.0, 1.0]], n_samples=3, warm=True),
        BatchJob(provider="anthropic", model="claude-sonnet-4-6"),
        BatchJob(
            provider="openai", provider_batch_id="batch_abc", model="gpt-4o",
            state=BatchJobState.POLLING,
            custom_ids={"c1": {"retrieved": False, "result_state": None}},
        ),
        DetectionRule(name="modsec_xss", source="detection"),
        DetectionRule(
            name="vol_anomaly", source="anomaly",
            match={"field": "event.module", "op": "equals", "value": "x"},
            trigger={"mode": "threshold", "n": 5, "window_seconds": 120, "group_by": "ip"},
        ),
    ]
    for m in models:
        restored = type(m).model_validate(m.model_dump(mode="json"))
        assert restored == m


def test_campaign_defaults() -> None:
    c = Campaign()
    assert c.status == CampaignStatus.OPEN
    assert c.case_ids == [] and c.entities == [] and c.mitre == []
    assert c.first_seen is None and c.last_seen is None and c.severity_rollup is None
    assert c.created_at  # auto-stamped


def test_batch_job_default_discount() -> None:
    j = BatchJob()
    assert j.state == BatchJobState.SUBMITTED
    assert j.discount == 0.5
    assert j.custom_ids == {}
    assert j.id.startswith("batch-")


def test_baseline_state_is_small_and_serialisable() -> None:
    b = BaselineState()
    dumped = b.model_dump(mode="json")
    # KV-friendly: all scalar / list-of-list, no exotic types.
    import json

    json.dumps(dumped)  # must not raise
    assert b.version == 1 and b.warm is False and b.tdigest == []


# --------------------------------------------------------------------------- #
# Preferences — new blocks default disabled; caps.max_concurrent == 3
# --------------------------------------------------------------------------- #
def test_new_preferences_blocks_default_disabled() -> None:
    p = Preferences()
    assert isinstance(p.threshold_tuning, ThresholdTuningConfig)
    assert p.threshold_tuning.enabled is False
    assert p.threshold_tuning.min_samples == 25
    assert p.threshold_tuning.shadow_eval is True
    assert isinstance(p.batch, BatchConfig) and p.batch.enabled is False
    assert p.batch.providers == ["anthropic", "openai"]
    assert isinstance(p.baseline, BaselineConfig) and p.baseline.enabled is False
    assert p.baseline.modified_z_threshold == 3.5
    assert isinstance(p.campaign, CampaignConfig) and p.campaign.enabled is False
    assert p.caps.max_concurrent == 3
    # Full canonical round-trip: no new field breaks the serializer.
    assert Preferences.model_validate(p.model_dump(mode="json")) == p


# --------------------------------------------------------------------------- #
# BrandingConfig login_* — defaults + the '<' (no-markup) validator
# --------------------------------------------------------------------------- #
def test_branding_login_fields_default() -> None:
    b = BrandingConfig()
    assert b.login_headline == "" and b.login_body == ""
    assert b.login_chips == []
    assert b.login_layout == "split"
    assert b.login_illustration == ""


def test_branding_login_accepts_plain_text() -> None:
    b = BrandingConfig(
        login_headline="Welcome to the SOC",
        login_body="Sign in to triage alerts.",
        login_chips=["Fast", "Audited", "Vendor-neutral"],
        login_layout="centered",
        login_illustration="shield",
    )
    assert b.login_illustration == "shield"
    assert Preferences(branding=b).branding.login_headline == "Welcome to the SOC"


def test_branding_login_rejects_markup() -> None:
    with pytest.raises(Exception):
        BrandingConfig(login_headline="<b>hi</b>")
    with pytest.raises(Exception):
        BrandingConfig(login_body="hello <script>alert(1)</script>")
    with pytest.raises(Exception):
        BrandingConfig(login_chips=["ok", "<img src=x>"])


def test_branding_login_illustration_curated_only() -> None:
    with pytest.raises(Exception):
        BrandingConfig(login_illustration="https://evil.example/x.svg")
    with pytest.raises(Exception):
        BrandingConfig(login_illustration="not-a-real-key")


# --------------------------------------------------------------------------- #
# AutomationRule alias + legacy threshold_automation config round-trips verbatim
# --------------------------------------------------------------------------- #
def test_automation_rule_is_case_automation_rule_alias() -> None:
    assert AutomationRule is CaseAutomationRule


def test_legacy_threshold_automation_config_parses() -> None:
    """A stored ``threshold_automation`` config (the old AutomationRule shape) parses
    byte-compatibly through the alias — the wire key + all field names are unchanged."""
    legacy = {
        "enabled": True,
        "rules": [
            {
                "id": "auto-1",
                "enabled": True,
                "priority": 100,
                "conditions": {"verdict": "FALSE_POSITIVE", "min_risk": 10},
                "action": "tag",
                "payload": {"tag": "auto-fp"},
            }
        ],
    }
    cfg = ThresholdAutomationConfig.model_validate(legacy)
    assert cfg.enabled is True
    assert len(cfg.rules) == 1
    rule = cfg.rules[0]
    assert isinstance(rule, CaseAutomationRule)
    assert rule.id == "auto-1"
    assert rule.action == "tag"
    assert rule.payload == {"tag": "auto-fp"}
    # And it round-trips through Preferences.
    p = Preferences(threshold_automation=cfg)
    assert Preferences.model_validate(p.model_dump(mode="json")) == p


# --------------------------------------------------------------------------- #
# ⚠ #3 LOCK — advisory Round-4 Case fields never referenced in case_manager.py
# --------------------------------------------------------------------------- #
def test_case_manager_never_references_r4_advisory_fields() -> None:
    """The Round-4 advisory Case field names appear NOWHERE in case_manager.py, so
    decide()/apply() can never come to depend on campaign membership / detection
    source. If a later wave wires one in, THIS test fails loudly (#3)."""
    src = Path(case_manager_module.__file__).read_text(encoding="utf-8")
    for name in _R4_ADVISORY_CASE_FIELDS:
        assert not re.search(rf"\b{name}\b", src), (
            f"NON-NEGOTIABLE #3 violated: case_manager.py references advisory field "
            f"'{name}' — the deterministic decision must stay a pure fn of "
            f"verdict/confidence/risk_score/policy."
        )
