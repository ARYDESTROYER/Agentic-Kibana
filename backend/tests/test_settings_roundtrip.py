"""Wave 7 / F12: settings plumbing — round-trip, partial deep-merge, read-only mode,
secret-leak guard, and the settings schema/subtree introspection endpoints.

Every nested Preferences block added across Waves 1-6 (rbac, mfa, sso, notifications,
case_id_format, cross_source_correlation, threat_context, threshold_automation, plus
the pre-existing ones) must PUT and re-GET unchanged, and a partial PUT of one nested
key must NOT wipe its sibling subtrees.
"""

from __future__ import annotations

from app.config import Preferences


# All the top-level NESTED-MODEL blocks that must round-trip through GET/PUT.
_NESTED_BLOCKS = [
    "rbac", "mfa", "sso", "notifications", "case_id_format",
    "cross_source_correlation", "threat_context", "threshold_automation",
    "auto_close", "enrichment", "rag", "standup", "trace", "personas",
    "runbooks", "playbooks", "branding", "caps", "risk_weights",
    "default_correlation",
]


def _get_prefs(client) -> dict:
    r = client.get("/api/settings")
    assert r.status_code == 200
    body = r.json()
    assert "prefs" in body and "configured" in body
    return body["prefs"]


def _put(client, patch: dict):
    r = client.put("/api/settings", json=patch)
    assert r.status_code == 200, r.text
    return r.json()["prefs"]


def test_every_nested_block_round_trips_unchanged(client):
    """PUT the full current value of each nested block back and re-GET it unchanged."""
    prefs = _get_prefs(client)
    for block in _NESTED_BLOCKS:
        assert block in prefs, f"nested block {block} missing from GET /settings"
        out = _put(client, {block: prefs[block]})
        assert out[block] == prefs[block], f"{block} did not round-trip"


def test_full_prefs_round_trip(client):
    """The entire prefs dump PUTs back and re-GETs byte-identical (full deep-merge)."""
    prefs = _get_prefs(client)
    out = _put(client, prefs)
    again = _get_prefs(client)
    # Pydantic-canonicalised: re-validate both sides for a stable comparison.
    assert Preferences.model_validate(out) == Preferences.model_validate(again)
    assert Preferences.model_validate(again) == Preferences.model_validate(prefs)


def test_partial_put_preserves_sibling_subtrees(client):
    """A partial PUT of ONE nested key must not wipe sibling subtrees."""
    before = _get_prefs(client)
    # Flip a single deep field inside one block; everything else must survive.
    patch = {"rag": {"top_k": before["rag"]["top_k"] + 3}}
    after = _put(client, patch)
    # The targeted field changed...
    assert after["rag"]["top_k"] == before["rag"]["top_k"] + 3
    # ...sibling fields inside the SAME block survived (deep, not shallow, merge).
    assert after["rag"]["min_score"] == before["rag"]["min_score"]
    assert after["rag"]["use_runbooks"] == before["rag"]["use_runbooks"]
    # ...and sibling BLOCKS are completely untouched.
    for block in _NESTED_BLOCKS:
        if block == "rag":
            continue
        assert after[block] == before[block], f"sibling block {block} was clobbered"


def test_partial_put_preserves_deeply_nested_siblings(client):
    """A partial PUT into a doubly-nested key preserves its deep siblings."""
    before = _get_prefs(client)
    # notifications.triggers.on_escalated lives two levels deep; only touch it.
    patch = {"notifications": {"triggers": {"on_escalated": False}}}
    after = _put(client, patch)
    assert after["notifications"]["triggers"]["on_escalated"] is False
    # The other triggers + the notifications top-level siblings survive.
    assert (
        after["notifications"]["triggers"]["on_true_positive"]
        == before["notifications"]["triggers"]["on_true_positive"]
    )
    assert after["notifications"]["enabled"] == before["notifications"]["enabled"]
    assert after["notifications"]["channels"] == before["notifications"]["channels"]


def test_read_only_mode_rejects_writes_except_the_unlock(client):
    """When read_only_settings_mode is on, writes 403 except setting it back to False."""
    _put(client, {"read_only_settings_mode": True})
    # Any other write is rejected.
    r = client.put("/api/settings", json={"rag": {"top_k": 9}})
    assert r.status_code == 403
    # Even a no-op write of an unrelated subtree is rejected while locked.
    r = client.put("/api/settings", json={"branding": {"org_name": "X"}})
    assert r.status_code == 403
    # The unlock (read_only_settings_mode=False) is allowed.
    out = _put(client, {"read_only_settings_mode": False})
    assert out["read_only_settings_mode"] is False
    # ...and now writes work again.
    _put(client, {"rag": {"top_k": 9}})


def test_secrets_never_appear_in_settings_dump(client):
    """The settings dump exposes only the non-secret tier + configured booleans."""
    body = client.get("/api/settings").json()
    blob = repr(body).lower()
    # Configured status is booleans only — never a secret VALUE.
    for v in body["configured"].values():
        assert isinstance(v, bool)
    # No secret field NAMES from the Secrets tier leak into the prefs subtree.
    prefs_blob = repr(body["prefs"]).lower()
    for forbidden in (
        "es_api_key", "es_mgmt_api_key", "anthropic_api_key", "openai_api_key",
        "connector_secrets", "sso_client_secrets", "notification_secrets",
        "auth_jwt_secret", "auth_admin_password",
    ):
        assert forbidden not in prefs_blob, f"secret-ish key {forbidden} leaked into prefs"
    # And nothing that looks like an obvious secret value marker.
    assert "bearer " not in blob


# --------------------------------------------------------------------------- #
# Schema + single-subtree endpoints
# --------------------------------------------------------------------------- #
def test_settings_schema_endpoint(client):
    r = client.get("/api/settings/schema")
    assert r.status_code == 200
    body = r.json()
    assert "sections" in body and isinstance(body["sections"], list)
    by_key = {s["key"]: s for s in body["sections"]}
    # The synthetic general group + the known object sections are present.
    assert "general" in by_key
    assert by_key["general"]["kind"] == "group"
    for block in _NESTED_BLOCKS:
        assert block in by_key, f"schema missing section {block}"
        assert by_key[block]["kind"] == "object"
        assert by_key[block]["model"]
        assert isinstance(by_key[block]["fields"], list) and by_key[block]["fields"]
    # Field descriptors carry a type + a JSON-safe default.
    rag = by_key["rag"]
    enabled = next(f for f in rag["fields"] if f["name"] == "enabled")
    assert enabled["type"] == "boolean"
    assert enabled["default"] is True
    # An enum field surfaces choices.
    general_fields = {f["name"]: f for f in by_key["general"]["fields"]}
    assert general_fields["entity_strategy"]["type"] == "enum"
    assert general_fields["entity_strategy"]["choices"]


def test_settings_schema_carries_no_secrets(client):
    blob = repr(client.get("/api/settings/schema").json()).lower()
    for forbidden in ("es_api_key", "anthropic_api_key", "connector_secrets",
                      "auth_jwt_secret", "notification_secrets"):
        assert forbidden not in blob


def test_settings_section_endpoint(client):
    prefs = _get_prefs(client)
    for block in ("rag", "notifications", "branding", "rbac"):
        r = client.get(f"/api/settings/{block}")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["section"] == block
        assert body["value"] == prefs[block]
    # A scalar top-level key also resolves.
    r = client.get("/api/settings/data_view_pattern")
    assert r.status_code == 200
    assert r.json()["value"] == prefs["data_view_pattern"]


def test_settings_section_unknown_is_404(client):
    r = client.get("/api/settings/not_a_real_section")
    assert r.status_code == 404


def test_settings_schema_does_not_shadow_section_route(client):
    """The fixed /settings/schema route resolves to the schema, not the {section} catch-all."""
    body = client.get("/api/settings/schema").json()
    assert "sections" in body
