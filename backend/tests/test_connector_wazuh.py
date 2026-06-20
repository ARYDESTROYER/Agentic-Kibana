"""Wazuh connector — proves the abstraction on a non-ECS third-party schema.

Wazuh's indexer is OpenSearch but its alert schema is not ECS (data.srcip,
agent.name, rule.description, rule.level, timestamp). The connector reuses the
Elastic read path and only differs in its per-source field mapping (overlaid onto
global prefs by ElasticConnector._effective_prefs).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.config import Preferences
from app.connectors.base import StructuredQuery
from app.connectors.elastic import ElasticConnector
from app.connectors.registry import get_registry
from app.connectors.wazuh import WazuhConnector
from app.constants import SourceType
from app.es.fake import InMemoryESClient
from app.models import Cursor

_WAZUH_CFG = {
    "data_view_pattern": "wazuh-alerts-*",
    "time_field": "timestamp",
    "source_ip_field": "data.srcip",
    "user_field": "data.srcuser",
    "host_field": "agent.name",
    "rule_field": "rule.id",
    "rule_name_field": "rule.description",
    "severity_field": "rule.level",
}


def _wazuh_doc(ip: str, ts: str) -> dict:
    return {
        "timestamp": ts,
        "agent": {"name": "web01"},
        "data": {"srcip": ip, "srcuser": "root"},
        "rule": {"id": "5710", "description": "sshd: Attempt to login using a non-existent user", "level": 5},
    }


@pytest.mark.asyncio
async def test_wazuh_poll_extracts_wazuh_schema():
    es = InMemoryESClient()
    es.add_log("wazuh-alerts-4.x-2026", _wazuh_doc("3.3.3.3", "2026-06-20T10:00:00Z"), "w1")
    conn = WazuhConnector(es, config=_WAZUH_CFG, connector_id="wazuh-prod")
    # Global prefs keep ECS defaults; the connector overlays the Wazuh mapping.
    events = await conn.poll(Preferences(), Cursor(), 0)
    assert len(events) == 1
    ev = events[0]
    assert (ev.ip, ev.user, ev.host, ev.rule) == ("3.3.3.3", "root", "web01", "5710")
    assert ev.rule_name.startswith("sshd")


@pytest.mark.asyncio
async def test_wazuh_to_ocsf_maps_entities():
    conn = WazuhConnector(InMemoryESClient(), config=_WAZUH_CFG, connector_id="wazuh-prod")
    ev = conn.to_ocsf({"_id": "w1", "_source": _wazuh_doc("4.4.4.4", "2026-06-20T10:00:00Z")}, Preferences())
    assert ev.ip == "4.4.4.4" and ev.user == "root" and ev.host == "web01"
    assert ev.rule_uid == "5710"
    assert ev.metadata.source_type == "wazuh"


@pytest.mark.asyncio
async def test_wazuh_search_filters_by_ip():
    es = InMemoryESClient()
    recent = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
    es.add_log("wazuh-alerts-4.x", _wazuh_doc("5.5.5.5", recent), "a")
    es.add_log("wazuh-alerts-4.x", _wazuh_doc("6.6.6.6", recent), "b")
    conn = WazuhConnector(es, config=_WAZUH_CFG)
    res = await conn.search(Preferences(), StructuredQuery(ip="5.5.5.5", time_from="now-1d", time_to="now"))
    assert res.total == 1
    assert res.events[0].ip == "5.5.5.5"
    assert 'data.srcip : "5.5.5.5"' in res.rendering.query


def test_wazuh_manifest_and_registry():
    m = WazuhConnector.manifest()
    assert m.source_type == SourceType.WAZUH
    cfg = {f.key: f.default for f in m.config_fields}
    assert cfg["data_view_pattern"] == "wazuh-alerts-*"
    assert cfg["source_ip_field"] == "data.srcip"
    assert get_registry().is_pull(SourceType.WAZUH)


def test_effective_prefs_overlay():
    es = InMemoryESClient()
    prefs = Preferences()
    # Empty config → identical object → byte-identical legacy behaviour.
    assert ElasticConnector(es)._effective_prefs(prefs) is prefs
    # Wazuh config → overlaid mapping; global prefs untouched.
    eff = WazuhConnector(es, config=_WAZUH_CFG)._effective_prefs(prefs)
    assert eff.source_ip_field == "data.srcip"
    assert prefs.source_ip_field == "source.ip"
