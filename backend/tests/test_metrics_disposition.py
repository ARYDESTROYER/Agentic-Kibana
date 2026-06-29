"""Metrics: by_disposition rollup (F8) + case-id preview endpoint (F7)."""

from __future__ import annotations

from app.constants import Disposition, EntityType, SourceSurface
from app.engine.metrics import compute_metrics
from app.models import Case, Entity


def _case(cid: str, disp: Disposition | None) -> Case:
    return Case(
        case_id=cid, cluster_signature=f"sig-{cid}",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="1.2.3.4"),
        disposition=disp,
    )


def test_by_disposition_rollup():
    cases = [
        _case("a", Disposition.TRUE_POSITIVE),
        _case("b", Disposition.FALSE_POSITIVE),
        _case("c", Disposition.FALSE_POSITIVE),
        _case("d", None),  # → "undetermined"
    ]
    m = compute_metrics(cases)
    assert "by_disposition" in m
    assert m["by_disposition"]["true_positive"] == 1
    assert m["by_disposition"]["false_positive"] == 2
    assert m["by_disposition"]["undetermined"] == 1
    # by_status still present (additive).
    assert "by_status" in m


def test_metrics_endpoint_includes_by_disposition(client):
    r = client.get("/api/metrics")
    assert r.status_code == 200, r.text
    assert "by_disposition" in r.json()


def test_case_id_preview_endpoint(client):
    r = client.post("/api/settings/case-id/preview",
                    json={"template": "CASE-{seq:06d}", "prefix": "CASE", "seq_start": 1})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["valid"] is True
    assert body["samples"][0] == "CASE-000001"
    assert len(body["samples"]) == 5


def test_case_id_preview_rejects_bad_template(client):
    r = client.post("/api/settings/case-id/preview",
                    json={"template": "CASE-{evil}", "prefix": "CASE"})
    assert r.status_code == 200  # endpoint returns valid:false, not an HTTP error
    assert r.json()["valid"] is False
