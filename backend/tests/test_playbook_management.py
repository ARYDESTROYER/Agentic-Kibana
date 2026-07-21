"""Operator Markdown playbook management: files, API, RBAC, and audit.

The management surface is deliberately narrower than arbitrary file editing: ids
are slugs, writes remain inside the configured directory, replacements are atomic,
and packaged reference playbooks stay read-only.  The tests never invoke the case
decision engine; playbook text remains recommendation-only investigation context.
"""

from __future__ import annotations

import inspect
from pathlib import Path

import pytest

from app.playbooks.registry import (
    DEFAULT_BUNDLED_PLAYBOOK_FILES,
    PlaybookConflictError,
    PlaybookManagementError,
    PlaybookProtectedError,
    PlaybookRegistry,
)
from app.api.routes import playbook_selection


def _document(playbook_id: str, *, version: int = 1, body: str = "Confirm the signal.") -> str:
    return (
        "---\n"
        f"id: {playbook_id}\n"
        f"name: {playbook_id.replace('_', ' ').title()}\n"
        f"version: {version}\n"
        "description: Operator-authored response procedure.\n"
        "priority: 25\n"
        "match:\n"
        "  rule_ids: [operator_rule]\n"
        "suggested_tools: [es_query]\n"
        "---\n"
        "## Procedure\n"
        f"{body}\n"
    )


def test_registry_creates_reads_and_atomically_updates_operator_file(tmp_path: Path) -> None:
    registry = PlaybookRegistry(tmp_path)
    registry.load()

    created, summary = registry.create_operator("containment_check", _document("containment_check"))
    assert created.id == "containment_check"
    assert summary["ids"] == ["containment_check"]
    assert (tmp_path / "containment_check.md").is_file()
    assert registry.metadata(created) == {
        "source_type": "operator",
        "protected": False,
        "editable": True,
        "file_name": "containment_check.md",
    }

    opened, content = registry.read_document("containment_check")
    assert opened.id == "containment_check"
    assert "Confirm the signal." in content

    updated, summary = registry.update_operator(
        "containment_check",
        _document("containment_check", version=2, body="Validate, contain, and document."),
    )
    assert updated.version == 2
    assert summary["loaded"] == 1
    assert "Validate, contain, and document." in (tmp_path / "containment_check.md").read_text()


def test_registry_rejects_traversal_mismatch_conflict_and_bad_markdown(tmp_path: Path) -> None:
    registry = PlaybookRegistry(tmp_path)
    registry.load()

    with pytest.raises(PlaybookManagementError, match="lowercase slug"):
        registry.create_operator("../escape", _document("escape"))
    with pytest.raises(PlaybookManagementError, match="must match"):
        registry.create_operator("expected_id", _document("different_id"))
    with pytest.raises(PlaybookManagementError, match="front matter"):
        registry.create_operator("missing_manifest", "# procedure only")
    with pytest.raises(PlaybookManagementError, match="reserved"):
        registry.create_operator("readme", _document("readme"))

    registry.create_operator("unique", _document("unique"))
    with pytest.raises(PlaybookConflictError, match="already exists"):
        registry.create_operator("unique", _document("unique", version=2))

    assert not (tmp_path.parent / "escape.md").exists()
    assert [p.id for p in registry.all()] == ["unique"]


def test_reload_summary_redacts_server_paths(tmp_path: Path) -> None:
    registry = PlaybookRegistry(tmp_path)
    (tmp_path / "broken.md").write_text("---\nname: missing id\n---\nBody.\n", encoding="utf-8")
    summary = registry.reload()

    assert summary["skipped"] == [
        {"file": "broken.md", "reason": "invalid_or_unparseable"}
    ]
    assert str(tmp_path) not in str(summary)


def test_playbook_selection_route_requires_case_read_permission() -> None:
    dependency = inspect.signature(playbook_selection).parameters["_"].default.dependency
    closure_values = {cell.cell_contents for cell in (dependency.__closure__ or ())}
    assert {"cases", "read"}.issubset(closure_values)


def test_registry_protects_packaged_file_but_allows_plain_read(tmp_path: Path) -> None:
    filename = next(iter(DEFAULT_BUNDLED_PLAYBOOK_FILES))
    playbook_id = filename.removesuffix(".md")
    (tmp_path / filename).write_text(_document(playbook_id), encoding="utf-8")
    registry = PlaybookRegistry(tmp_path, protected_filenames={filename})
    registry.load()
    bundled = registry.get(playbook_id)
    assert bundled is not None
    assert registry.metadata(bundled)["source_type"] == "bundled"
    assert registry.metadata(bundled)["editable"] is False
    assert registry.read_document(playbook_id)[0].id == playbook_id
    with pytest.raises(PlaybookProtectedError, match="bundled and read-only"):
        registry.update_operator(playbook_id, _document(playbook_id, version=2))


def _point_client_at(client, directory: Path) -> None:
    state = client.app.state.tlsoc
    state.prefs.playbooks.dir = str(directory)
    state.reload_playbooks()


def test_playbook_management_api_create_open_update_and_audit(client, tmp_path: Path) -> None:
    _point_client_at(client, tmp_path)
    original = _document("api_response")

    created = client.post("/api/playbooks", json={"id": "api_response", "content": original})
    assert created.status_code == 200, created.text
    item = created.json()["playbook"]
    assert item["source_type"] == "operator"
    assert item["editable"] is True
    assert "source_path" not in item

    listing = client.get("/api/playbooks")
    assert listing.status_code == 200
    assert listing.json()["count"] == 1
    assert listing.json()["playbooks"][0]["file_name"] == "api_response.md"

    opened = client.get("/api/playbooks/api_response")
    assert opened.status_code == 200
    assert opened.json()["content"].startswith("---\nid: api_response")
    assert opened.json()["body"].startswith("## Procedure")

    updated = client.put(
        "/api/playbooks/api_response",
        json={"content": _document("api_response", version=2, body="Collect and contain.")},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["playbook"]["version"] == 2
    assert client.get("/api/playbooks/api_response").json()["content"].find("Collect and contain.") > 0

    audit_docs = [
        doc
        for bucket in client.app.state.tlsoc.es.docs.values()
        for doc in bucket.values()
        if doc.get("action_type") == "playbook"
    ]
    assert [doc["result_summary"].split()[0] for doc in audit_docs] == ["created", "updated"]
    assert all(doc["surface"] == "playbooks" for doc in audit_docs)


def test_playbook_management_api_returns_bounded_errors(client, tmp_path: Path) -> None:
    _point_client_at(client, tmp_path)
    assert client.post(
        "/api/playbooks", json={"id": "../escape", "content": _document("escape")}
    ).status_code == 400
    assert client.post(
        "/api/playbooks", json={"id": "mismatch", "content": _document("different")}
    ).status_code == 400
    assert client.get("/api/playbooks/missing").status_code == 404
    assert client.put(
        "/api/playbooks/missing", json={"content": _document("missing")}
    ).status_code == 404


def test_packaged_playbook_api_is_viewable_but_protected(client) -> None:
    # The default AppState points at backend/playbooks and marks the three shipped
    # procedures as bundled.  Viewing is allowed; replacing is not.
    item = client.get("/api/playbooks/brute_force_login")
    assert item.status_code == 200
    assert item.json()["source_type"] == "bundled"
    assert item.json()["protected"] is True
    changed = client.put(
        "/api/playbooks/brute_force_login",
        json={"content": _document("brute_force_login", version=99)},
    )
    assert changed.status_code == 403
