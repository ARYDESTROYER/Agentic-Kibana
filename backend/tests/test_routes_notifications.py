"""Tests for notification routes (Round 5, Coupling-E extraction).

Covers GET /notifications/providers, POST /notifications/preview,
POST /notifications/test, POST /notifications/channels/{id}/secret,
and POST /cases/{id}/notify.
"""

from __future__ import annotations

from fastapi.testclient import TestClient


class TestProviders:
    def test_get_providers_returns_catalog(self, client: TestClient):
        resp = client.get("/api/notifications/providers")
        assert resp.status_code == 200
        body = resp.json()
        assert "email_presets" in body
        assert "channel_types" in body
        assert "template_ids" in body
        assert isinstance(body["email_presets"], list)
        assert isinstance(body["channel_types"], list)
        assert isinstance(body["template_ids"], list)
        assert any("case" in tid for tid in body["template_ids"])
        assert "email" in body["channel_types"]

    def test_providers_template_ids_include_builtins(self, client: TestClient):
        resp = client.get("/api/notifications/providers")
        body = resp.json()
        ids = body["template_ids"]
        assert len(ids) >= 3
        assert "test" in ids


class TestPreview:
    def test_preview_default_trigger(self, client: TestClient):
        resp = client.post("/api/notifications/preview")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["trigger"] == "case_created"
        assert isinstance(body.get("subject"), str) and body["subject"]
        assert isinstance(body.get("html"), str) and body["html"]
        assert isinstance(body.get("text"), str)

    def test_preview_explicit_trigger(self, client: TestClient):
        resp = client.post("/api/notifications/preview?trigger=case_escalated")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["trigger"] == "case_escalated"

    def test_preview_with_body_overrides(self, client: TestClient):
        resp = client.post(
            "/api/notifications/preview?trigger=case_created",
            json={"subject": "OVERRIDE SUBJECT", "html": "<p>OVERRIDE</p>", "text": "OVERRIDE text"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert "OVERRIDE" in body["subject"]
        assert "OVERRIDE" in body["html"]
        assert "OVERRIDE" in body["text"]

    def test_preview_empty_body_uses_live_templates(self, client: TestClient):
        resp = client.post(
            "/api/notifications/preview",
            json={"subject": None, "html": None, "text": None},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["subject"]


class TestTestSend:
    def test_test_send_unknown_channel_returns_ok_false(self, client: TestClient):
        resp = client.post("/api/notifications/test", json={"channel_id": "nonexistent"})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["ok"] is False
        assert body["detail"] == "channel not found"


class TestChannelSecret:
    def test_set_channel_secret(self, client: TestClient):
        resp = client.post(
            "/api/notifications/channels/test-set-chan/secret",
            json={"field": "token", "value": "test_secret_abc"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["ok"] is True

    def test_clear_channel_secret(self, client: TestClient):
        client.post(
            "/api/notifications/channels/test-clear-chan/secret",
            json={"field": "token", "value": "test_secret_abc"},
        )
        resp = client.post(
            "/api/notifications/channels/test-clear-chan/secret",
            json={"field": "token", "value": None},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["ok"] is True

    def test_channel_secret_unknown_channel_returns_ok(self, client: TestClient):
        resp = client.post(
            "/api/notifications/channels/ghost-chan/secret",
            json={"field": "token", "value": "whatever"},
        )
        assert resp.status_code == 200, resp.text


class TestNotifyCase:
    def test_notify_unknown_case_returns_404(self, client: TestClient):
        resp = client.post("/api/cases/nobody-home/notify", json={})
        assert resp.status_code == 404
