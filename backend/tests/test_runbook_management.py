"""Operator-managed runbooks: catalog, revisions, RAG projection, and policy safety.

These tests stay at the public catalog/API boundary. Runbooks are durable Markdown
knowledge, not executable playbooks, and none of this suite invokes the deterministic
case decision engine.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from app.engine.runbook_service import RunbookService
from app.engine.runbooks import (
    MAX_RUNBOOK_BODY_CHARS,
    MAX_RETRIEVAL_DESCRIPTOR_CHARS,
    RunbookNotFoundError,
    RunbookProtectedError,
    RunbookRevisionConflictError,
    RunbookValidationError,
    load_runbooks,
    parse_runbook_document,
)


def _document(
    runbook_id: str,
    *,
    title: str = "Suspicious PowerShell execution",
    body: str = "Collect process lineage and recover the script body.",
) -> str:
    return (
        "---\n"
        f"id: {runbook_id}\n"
        f"title: {title}\n"
        "summary: Triage encoded or policy-bypassing PowerShell.\n"
        "persona: malware\n"
        "applies_to_rules: [powershell, sysmon]\n"
        "applies_to_techniques: [T1059.001]\n"
        "applies_to_entities: [host, user]\n"
        "keywords: [powershell, encodedcommand, scriptblock]\n"
        "---\n"
        "SIGNAL\n"
        f"{body}\n\n"
        "EVIDENCE REQUIRED\n"
        "Process lineage, command line, script content, host identity, and user context.\n\n"
        "INVESTIGATION STEPS\n"
        "1. Recover the complete process tree and originating user session.\n"
        "2. Decode the command and pivot on its indicators across the host.\n\n"
        "TRUE POSITIVE SIGNALS\n"
        "Encoded execution with suspicious lineage or malicious follow-on activity "
        "supports a true positive.\n\n"
        "FALSE POSITIVE SIGNALS\n"
        "An approved administrative script with expected lineage and no harmful behavior "
        "supports a false positive.\n\n"
        "NEEDS HUMAN WHEN\n"
        "The script body, process lineage, or authorization context cannot be recovered.\n\n"
        "RECOMMENDED NEXT ACTION\n"
        "Escalate confirmed malicious execution for host containment and credential review.\n\n"
        "LIMITATIONS\n"
        "Truncated command telemetry can hide the behavior needed for a confident verdict.\n"
    )


def _mount_runbook_router(client) -> None:
    """The shared fixture mounts the historical base/moved routers explicitly.

    Production auto-discovers every feature router. Mount this new feature router in
    the focused test app only when the fixture has not learned about it yet.
    """

    paths = {getattr(route, "path", "") for route in client.app.routes}
    if "/api/runbooks/{runbook_id}" in paths:
        return
    from app.api.routes_runbooks import router

    client.app.include_router(router)


def _item(payload: dict[str, Any]) -> dict[str, Any]:
    value = payload.get("runbook", payload)
    assert isinstance(value, dict)
    return value


def _replace_body(content: str, body: str) -> str:
    _empty, manifest, _old_body = content.split("---\n", 2)
    return f"---\n{manifest}---\n{body}"


def test_runbook_corpus_projection_contains_full_body_and_stable_provenance() -> None:
    body = "Inspect the unique nebula-canary command line and its process ancestry."
    runbook = parse_runbook_document(
        _document("powershell_triage", body=body),
        enforce_authoring_standard=True,
    )

    chunks = runbook.as_corpus_items(revision=4, source_type="operator")

    assert chunks
    assert len(chunks) == 1
    assert any(body in chunk["text"] for chunk in chunks)
    assert all(chunk["source"] == "runbook" for chunk in chunks)
    assert all(chunk["metadata"]["document_id"] == "runbook:powershell_triage" for chunk in chunks)
    assert all(chunk["metadata"]["revision"] == 4 for chunk in chunks)
    assert all(chunk["metadata"]["trust_class"] == "operator_runbook" for chunk in chunks)


@pytest.mark.asyncio
async def test_runbook_embeds_descriptor_but_stores_complete_guidance() -> None:
    from app.config import Preferences, Secrets
    from app.es.fake import InMemoryESClient
    from app.llm.gateway import LLMGateway
    from app.llm.providers import MockProvider
    from app.stores.usage import UsageStore
    from app.tools.rag import RagService

    class EmbeddingSpy(MockProvider):
        def __init__(self) -> None:
            super().__init__()
            self.embedding_inputs: list[str] = []

        async def embed(self, texts: list[str], model: str):
            self.embedding_inputs.extend(texts)
            return await super().embed(texts, model)

    body = "Inspect the unique nebula-vector marker and its parent process."
    runbook = parse_runbook_document(
        _document("embedding_contract", body=body),
        enforce_authoring_standard=True,
    )
    item = runbook.as_corpus_items(revision=1, source_type="operator")[0]
    assert body not in item["embedding_text"]
    assert body in item["text"]

    spy = EmbeddingSpy()
    gateway = LLMGateway(
        Secrets(_env_file=None),
        UsageStore(InMemoryESClient()),
        provider_overrides={"openai": spy, "mock": spy},
    )
    rag = RagService(gateway, Preferences())
    await rag._embed_and_add([item])

    assert spy.embedding_inputs == [item["embedding_text"]]
    stored = await rag._store.list_chunks("runbook:embedding_contract")
    assert len(stored) == 1
    assert body in stored[0].text


@pytest.mark.asyncio
async def test_catalog_merges_protected_bundled_and_revisioned_operator_runbooks(
    app_state,
) -> None:
    service: RunbookService = app_state.runbooks
    created = await service.create(
        "powershell_triage",
        _document("powershell_triage"),
        actor="soc_manager",
    )

    assert created.source_type == "operator"
    assert created.editable is True
    assert created.protected is False
    assert created.revision == 1
    assert created.created_by == "soc_manager"
    assert any(item.source_type == "bundled" and item.protected for item in await service.list())

    updated = await service.update(
        "powershell_triage",
        _document("powershell_triage", body="Collect lineage, decode, and pivot."),
        actor="second_operator",
        expected_revision=1,
    )
    assert updated.revision == 2
    assert updated.created_by == "soc_manager"
    assert updated.updated_by == "second_operator"

    with pytest.raises(RunbookRevisionConflictError):
        await service.update(
            "powershell_triage",
            _document("powershell_triage", body="Stale overwrite."),
            actor="stale_operator",
            expected_revision=1,
        )

    with pytest.raises(RunbookProtectedError):
        await service.update(
            "brute_force",
            _document("brute_force", title="Do not replace bundled content"),
            actor="soc_manager",
            expected_revision=1,
        )

    await service.delete("powershell_triage", expected_revision=2)
    with pytest.raises(RunbookNotFoundError):
        await service.get("powershell_triage")


def test_runbook_api_create_update_delete_and_targeted_full_body_projection(client) -> None:
    _mount_runbook_router(client)
    first_body = "Inspect the unique nebula-canary command and parent process."

    created = client.post(
        "/api/runbooks",
        json={
            "id": "powershell_triage",
            "content": _document("powershell_triage", body=first_body),
        },
    )
    assert created.status_code == 201, created.text
    created_payload = created.json()
    item = _item(created_payload)
    assert item["source_type"] == "operator"
    assert item["protected"] is False
    assert item["editable"] is True
    assert item["revision"] == 1
    assert item["index_status"] == "ready"
    assert created_payload["index"]["failed"] == 0

    listing = client.get("/api/runbooks")
    assert listing.status_code == 200, listing.text
    envelope = listing.json()
    assert envelope["enabled"] is True
    assert envelope["retrieval_enabled"] is True
    listed = next(rb for rb in envelope["runbooks"] if rb["id"] == "powershell_triage")
    assert "content" not in listed
    assert listed["revision"] == 1

    opened = client.get("/api/runbooks/powershell_triage")
    assert opened.status_code == 200, opened.text
    assert opened.json()["content"].startswith("---\nid: powershell_triage")
    assert first_body in opened.json()["body"]

    indexed = client.get("/api/rag/documents/runbook:powershell_triage")
    assert indexed.status_code == 200, indexed.text
    assert any(first_body in chunk["text"] for chunk in indexed.json()["chunks"])

    second_body = "Decode the unique aurora-revision token and pivot across the host."
    updated = client.put(
        "/api/runbooks/powershell_triage",
        json={"content": _document("powershell_triage", body=second_body), "expected_revision": 1},
    )
    assert updated.status_code == 200, updated.text
    assert _item(updated.json())["revision"] == 2
    assert updated.json()["index"]["failed"] == 0

    stale = client.put(
        "/api/runbooks/powershell_triage",
        json={
            "content": _document("powershell_triage", body="Stale edit."),
            "expected_revision": 1,
        },
    )
    assert stale.status_code == 409
    stale_delete = client.delete("/api/runbooks/powershell_triage?expected_revision=1")
    assert stale_delete.status_code == 409

    reindexed = client.get("/api/rag/documents/runbook:powershell_triage")
    assert reindexed.status_code == 200
    texts = [chunk["text"] for chunk in reindexed.json()["chunks"]]
    assert any(second_body in text for text in texts)
    assert all(first_body not in text for text in texts)

    deleted = client.delete("/api/runbooks/powershell_triage?expected_revision=2")
    assert deleted.status_code == 200, deleted.text
    assert deleted.json()["id"] == "powershell_triage"
    assert deleted.json()["index"]["failed"] == 0
    assert client.get("/api/runbooks/powershell_triage").status_code == 404
    assert client.get("/api/rag/documents/runbook:powershell_triage").status_code == 404


def test_runbook_api_protects_bundled_content_and_validates_operator_markdown(client) -> None:
    _mount_runbook_router(client)

    bundled = client.get("/api/runbooks/brute_force")
    assert bundled.status_code == 200
    assert bundled.json()["source_type"] == "bundled"
    assert bundled.json()["protected"] is True
    assert bundled.json()["editable"] is False

    changed = client.put(
        "/api/runbooks/brute_force",
        json={"content": _document("brute_force", title="Replacement"), "expected_revision": 1},
    )
    assert changed.status_code == 403
    removed = client.delete("/api/runbooks/brute_force?expected_revision=1")
    assert removed.status_code == 403

    mismatch = client.post(
        "/api/runbooks",
        json={"id": "expected_id", "content": _document("different_id")},
    )
    assert mismatch.status_code == 422
    mismatch_detail = mismatch.json()["detail"]
    assert mismatch_detail["code"] == "runbook_validation_failed"
    assert any(
        issue["code"] == "manifest.id.mismatch"
        for issue in mismatch_detail["issues"]
    )
    traversal = client.post(
        "/api/runbooks",
        json={
            "id": "../escape",
            "content": _document("different_id").replace(
                "summary: Triage encoded or policy-bypassing PowerShell.\n",
                "summary:\n",
            ),
        },
    )
    assert traversal.status_code == 422
    traversal_detail = traversal.json()["detail"]
    codes = {issue["code"] for issue in traversal_detail["issues"]}
    assert {"manifest.id.invalid", "manifest.id.mismatch", "manifest.summary.required"} <= codes


@pytest.mark.parametrize(
    ("insertion", "code"),
    [
        ("# Extra heading", "body.format.heading"),
        ("Pseudo heading\n---", "body.format.setext_heading"),
        ("Column one | Column two\n---|---", "body.format.table"),
        ("Column one | Column two", "body.format.table"),
        ("This is **bold text**.", "body.format.bold"),
        ("This is *italic text*.", "body.format.italic"),
        ("This is _italic text_.", "body.format.italic"),
        ("This is <u>underlined</u>.", "body.format.underline"),
        ("This is ~~obsolete text~~.", "body.format.strikethrough"),
        ("```text\nquery\n```", "body.format.fenced_code"),
        ("Inspect `event.code` now.", "body.format.inline_code"),
        ("    indented code", "body.format.indented_code"),
        ("Use <strong>trusted text</strong>.", "body.format.html"),
        ("Read [the reference](https://example.com).", "body.format.link"),
        ("> Quoted instruction", "body.format.blockquote"),
        ("- [ ] Deferred check", "body.format.task_list"),
        ("- Unordered check", "body.format.unordered_list"),
        ("***", "body.format.horizontal_rule"),
    ],
)
def test_operator_authoring_rejects_presentation_markdown(
    insertion: str,
    code: str,
) -> None:
    content = _document("strict_format").replace(
        "SIGNAL\n",
        f"SIGNAL\n{insertion}\n",
        1,
    )

    with pytest.raises(RunbookValidationError) as caught:
        parse_runbook_document(
            content,
            expected_id="strict_format",
            enforce_authoring_standard=True,
        )

    assert code in {issue.code for issue in caught.value.issues}


def test_operator_authoring_rejects_formatting_in_retrieval_metadata() -> None:
    content = _document("formatted_metadata")
    content = content.replace(
        "title: Suspicious PowerShell execution",
        "title: **Suspicious PowerShell execution**",
    )
    content = content.replace(
        "summary: Triage encoded or policy-bypassing PowerShell.",
        "summary: _Triage encoded or policy-bypassing PowerShell._",
    )
    content = content.replace("persona: malware", "persona: <u>malware</u>")
    content = content.replace(
        "applies_to_rules: [powershell, sysmon]",
        "applies_to_rules: [powershell, `sysmon`]",
    )
    content = content.replace(
        "applies_to_techniques: [T1059.001]",
        "applies_to_techniques: [T1059.001|T1110]",
    )
    content = content.replace(
        "applies_to_entities: [host, user]",
        "applies_to_entities: [host, [user](https://example.com)]",
    )
    content = content.replace(
        "keywords: [powershell, encodedcommand, scriptblock]",
        "keywords: [powershell, ~~encodedcommand~~, # scriptblock]",
    )

    with pytest.raises(RunbookValidationError) as caught:
        parse_runbook_document(
            content,
            expected_id="formatted_metadata",
            enforce_authoring_standard=True,
        )

    codes = {issue.code for issue in caught.value.issues}
    assert {
        "manifest.title.format.bold",
        "manifest.summary.format.italic",
        "manifest.persona.format.underline",
        "manifest.persona.format.html",
        "manifest.applies_to_rules.format.code",
        "manifest.applies_to_techniques.format.table",
        "manifest.applies_to_entities.format.link",
        "manifest.keywords.format.strikethrough",
        "manifest.keywords.format.heading",
    } <= codes
    formatted = [issue for issue in caught.value.issues if ".format." in issue.code]
    assert all(issue.problem and issue.reason and issue.fix for issue in formatted)


def test_operator_authoring_allows_plain_urls_and_ordinary_underscores() -> None:
    content = _document("plain_identifiers")
    content = content.replace(
        "title: Suspicious PowerShell execution",
        "title: event_id investigation",
    )
    content = content.replace(
        "summary: Triage encoded or policy-bypassing PowerShell.",
        "summary: Review https://example.com/path_name for source guidance.",
    )
    content = content.replace("persona: malware", "persona: identity_access")
    content = content.replace(
        "applies_to_rules: [powershell, sysmon]",
        "applies_to_rules: [power_shell, sysmon_v1]",
    )
    content = content.replace(
        "applies_to_entities: [host, user]",
        "applies_to_entities: [host_name, user_id]",
    )
    content = content.replace(
        "keywords: [powershell, encodedcommand, scriptblock]",
        "keywords: [event_id, https://example.com/path_name]",
    )
    content = content.replace(
        "Collect process lineage and recover the script body.",
        "Inspect event_id at https://example.com/path_name before assigning TRUE_POSITIVE.",
    )

    parsed = parse_runbook_document(
        content,
        expected_id="plain_identifiers",
        enforce_authoring_standard=True,
    )

    assert "event_id" in parsed.body
    assert parsed.persona == "identity_access"
    assert "https://example.com/path_name" in parsed.summary


def test_operator_authoring_enforces_exact_unicode_body_ceiling() -> None:
    content = _document("bounded_body")
    _meta, base_body = content.split("---\n", 2)[1:]
    base_body = base_body.strip()
    assert len(base_body) < MAX_RUNBOOK_BODY_CHARS
    exact_body = base_body.replace(
        "Collect process lineage and recover the script body.",
        "Collect process lineage and recover the script body."
        + ("x" * (MAX_RUNBOOK_BODY_CHARS - len(base_body))),
        1,
    )
    exact = _replace_body(content, exact_body)
    parsed = parse_runbook_document(
        exact,
        expected_id="bounded_body",
        enforce_authoring_standard=True,
    )
    assert len(parsed.body) == MAX_RUNBOOK_BODY_CHARS

    with pytest.raises(RunbookValidationError) as caught:
        parse_runbook_document(
            _replace_body(content, exact_body + "é"),
            expected_id="bounded_body",
            enforce_authoring_standard=True,
        )
    assert caught.value.body_characters == MAX_RUNBOOK_BODY_CHARS + 1
    assert "body.too_long" in {issue.code for issue in caught.value.issues}


def test_operator_authoring_requires_complete_fixed_structure() -> None:
    content = _document("broken_structure")
    content = content.replace("summary: Triage encoded or policy-bypassing PowerShell.\n", "")
    content = content.replace("applies_to_rules: [powershell, sysmon]\n", "applies_to_rules: []\n")
    content = content.replace("EVIDENCE REQUIRED\n", "UNSUPPORTED SECTION\n")
    content = content.replace(
        "1. Recover the complete process tree and originating user session.\n"
        "2. Decode the command and pivot on its indicators across the host.",
        "2. [Describe the first step]\n4. Inspect the host.",
    )

    with pytest.raises(RunbookValidationError) as caught:
        parse_runbook_document(
            content,
            expected_id="broken_structure",
            enforce_authoring_standard=True,
        )

    codes = {issue.code for issue in caught.value.issues}
    assert {
        "manifest.summary.required",
        "manifest.applies_to_rules.required",
        "body.structure.label_unknown",
        "body.structure.section_missing",
        "body.placeholder",
        "body.steps.sequence",
        "body.steps.incomplete",
    } <= codes


def test_operator_authoring_bounds_combined_retrieval_metadata() -> None:
    content = _document("oversized_descriptor")
    values = [f"signal_{index:02d}_" + ("x" * 48) for index in range(12)]
    content = content.replace(
        "applies_to_rules: [powershell, sysmon]",
        f"applies_to_rules: [{', '.join(values)}]",
    )
    content = content.replace(
        "applies_to_entities: [host, user]",
        f"applies_to_entities: [{', '.join(value.replace('signal', 'entity') for value in values)}]",
    )
    content = content.replace(
        "keywords: [powershell, encodedcommand, scriptblock]",
        f"keywords: [{', '.join(value.replace('signal', 'keyword') for value in values)}]",
    )

    with pytest.raises(RunbookValidationError) as caught:
        parse_runbook_document(
            content,
            expected_id="oversized_descriptor",
            enforce_authoring_standard=True,
        )

    issue = next(
        item
        for item in caught.value.issues
        if item.code == "manifest.descriptor.too_long"
    )
    assert str(MAX_RETRIEVAL_DESCRIPTOR_CHARS) in issue.problem
    assert "every retrieved guidance chunk" in issue.reason
    assert issue.fix


def test_operator_authoring_rejects_manifest_placeholders_duplicates_and_unknowns() -> None:
    content = _document("manifest_quality")
    content = content.replace(
        "title: Suspicious PowerShell execution",
        "title: TODO replace title",
    )
    content = content.replace(
        "keywords: [powershell, encodedcommand, scriptblock]",
        "keywords: [PowerShell, powershell, placeholder]",
    )
    content = content.replace(
        "persona: malware\n",
        "persona: malware\nowner_team: detection\n",
    )

    with pytest.raises(RunbookValidationError) as caught:
        parse_runbook_document(
            content,
            expected_id="manifest_quality",
            enforce_authoring_standard=True,
        )

    codes = {issue.code for issue in caught.value.issues}
    assert {
        "manifest.title.placeholder",
        "manifest.keywords.placeholder",
        "manifest.keywords.duplicate",
        "manifest.field.unsupported",
    } <= codes


def test_operator_authoring_rejects_optional_metadata_placeholders() -> None:
    content = _document("optional_placeholder").replace(
        "persona: malware",
        "persona: PLACEHOLDER",
    )

    with pytest.raises(RunbookValidationError) as caught:
        parse_runbook_document(
            content,
            expected_id="optional_placeholder",
            enforce_authoring_standard=True,
        )

    issue = next(
        item
        for item in caught.value.issues
        if item.code == "manifest.persona.placeholder"
    )
    assert issue.problem and issue.reason and issue.fix


def test_runbook_api_returns_all_actionable_validation_issues(client) -> None:
    _mount_runbook_router(client)
    content = _document("bad_submission")
    content = content.replace("summary: Triage encoded or policy-bypassing PowerShell.\n", "")
    content = content.replace("EVIDENCE REQUIRED\n", "")
    content = content.replace("SIGNAL\n", "SIGNAL\n**Decorative text**\n", 1)

    response = client.post(
        "/api/runbooks",
        json={"id": "bad_submission", "content": content},
    )

    assert response.status_code == 422, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "runbook_validation_failed"
    assert detail["limits"]["body_max_characters"] == MAX_RUNBOOK_BODY_CHARS
    assert (
        detail["limits"]["retrieval_descriptor_max_characters"]
        == MAX_RETRIEVAL_DESCRIPTOR_CHARS
    )
    assert detail["body_characters"] > 0
    codes = {issue["code"] for issue in detail["issues"]}
    assert {
        "manifest.summary.required",
        "body.structure.section_missing",
        "body.format.bold",
    } <= codes
    assert all(
        {"code", "field", "problem", "reason", "fix"} == set(issue)
        for issue in detail["issues"]
    )
    assert client.get("/api/runbooks/bad_submission").status_code == 404


def test_runbook_api_publishes_backend_owned_authoring_standard(client) -> None:
    _mount_runbook_router(client)
    response = client.get("/api/runbooks")

    assert response.status_code == 200
    standard = response.json()["authoring_standard"]
    assert standard["body_max_characters"] == MAX_RUNBOOK_BODY_CHARS
    assert (
        standard["retrieval_descriptor_max_characters"]
        == MAX_RETRIEVAL_DESCRIPTOR_CHARS
    )
    assert standard["document_max_bytes"] == 128 * 1024
    assert standard["section_min_characters"] == 12
    assert standard["reserved_ids"] == ["index", "readme", "reindex"]
    assert standard["metadata_limits"] == {
        "title_max_characters": 120,
        "summary_max_characters": 280,
        "persona_max_characters": 48,
        "list_max_items": 12,
        "list_item_max_characters": 64,
    }
    assert standard["required_body_labels"] == [
        "SIGNAL",
        "EVIDENCE REQUIRED",
        "INVESTIGATION STEPS",
        "TRUE POSITIVE SIGNALS",
        "FALSE POSITIVE SIGNALS",
        "NEEDS HUMAN WHEN",
        "RECOMMENDED NEXT ACTION",
    ]


def test_bundled_runbooks_conform_to_strict_authoring_standard() -> None:
    bundled = load_runbooks()
    assert len(bundled) == 7
    for runbook in bundled:
        parsed = parse_runbook_document(
            Path(runbook.source_path).read_text(encoding="utf-8"),
            expected_id=runbook.id,
            enforce_authoring_standard=True,
        )
        assert len(parsed.body) <= MAX_RUNBOOK_BODY_CHARS


def test_downloadable_example_runbooks_conform_to_strict_authoring_standard() -> None:
    examples = Path(__file__).parents[2] / "webui" / "public" / "examples" / "runbooks"
    paths = sorted(examples.glob("*.md"))

    assert [path.name for path in paths] == [
        "dns-beaconing.md",
        "encoded-powershell.md",
        "impossible-travel-signin.md",
    ]
    for path in paths:
        parsed = parse_runbook_document(
            path.read_text(encoding="utf-8"),
            enforce_authoring_standard=True,
        )
        assert len(parsed.body) <= MAX_RUNBOOK_BODY_CHARS


def test_strict_body_count_normalizes_bom_and_windows_newlines() -> None:
    content = "\ufeff" + _document("windows_newlines").replace("\n", "\r\n")

    parsed = parse_runbook_document(
        content,
        expected_id="windows_newlines",
        enforce_authoring_standard=True,
    )

    assert "\r" not in parsed.body
    assert parsed.body.startswith("SIGNAL\n")


@pytest.mark.asyncio
async def test_legacy_operator_runbooks_remain_readable_until_edited(app_state) -> None:
    legacy = (
        "---\n"
        "id: legacy_markdown\n"
        "title: Legacy Markdown\n"
        "summary: Stored before the strict authoring standard.\n"
        "applies_to_rules: [legacy]\n"
        "applies_to_entities: [host]\n"
        "keywords: [legacy]\n"
        "---\n"
        "## Steps\n"
        "- Inspect the old record without dropping it.\n"
    )
    await app_state.runbooks.store.create("legacy_markdown", legacy, actor="operator")

    opened = await app_state.runbooks.get("legacy_markdown")
    assert opened.runbook.id == "legacy_markdown"
    assert any(
        "Inspect the old record" in item["text"]
        for item in await app_state.runbooks.corpus_items({"legacy_markdown"})
    )
    with pytest.raises(RunbookValidationError):
        await app_state.runbooks.update(
            "legacy_markdown",
            legacy,
            actor="operator",
            expected_revision=1,
        )

    migrated = await app_state.runbooks.update(
        "legacy_markdown",
        _document("legacy_markdown", title="Legacy Markdown"),
        actor="operator",
        expected_revision=1,
    )
    assert migrated.revision == 2


@pytest.mark.asyncio
async def test_legacy_operator_metadata_keeps_previous_read_ceiling(app_state) -> None:
    legacy_rules = ", ".join(f"legacy_rule_{index:02d}" for index in range(13))
    legacy = (
        "---\n"
        "id: legacy_wide_metadata\n"
        f"title: {'L' * 121}\n"
        "summary: Stored before the stricter retrieval descriptor budget.\n"
        f"applies_to_rules: [{legacy_rules}]\n"
        "applies_to_entities: [host]\n"
        "keywords: [legacy]\n"
        "---\n"
        "## Steps\n"
        "- Inspect the retained legacy record.\n"
    )
    await app_state.runbooks.store.create(
        "legacy_wide_metadata",
        legacy,
        actor="operator",
    )

    opened = await app_state.runbooks.get("legacy_wide_metadata")
    assert len(opened.runbook.title) == 121
    assert len(opened.runbook.applies_to_rules) == 13

    with pytest.raises(RunbookValidationError) as caught:
        await app_state.runbooks.update(
            "legacy_wide_metadata",
            legacy,
            actor="operator",
            expected_revision=1,
        )
    codes = {issue.code for issue in caught.value.issues}
    assert "manifest.title.too_long" in codes
    assert "manifest.applies_to_rules.too_many" in codes


def test_catalog_reindex_preserves_unrelated_knowledge(client) -> None:
    _mount_runbook_router(client)
    imported = client.post(
        "/api/rag/import",
        json={
            "title": "Operator network note",
            "text": (
                "A separately imported corpus document that must survive "
                "runbook reconciliation."
            ),
            "tags": ["qa"],
        },
    )
    assert imported.status_code == 200, imported.text
    document_id = imported.json()["document_id"]

    created = client.post(
        "/api/runbooks",
        json={
            "id": "network_triage",
            "content": _document("network_triage", body="Inspect network pivots."),
        },
    )
    assert created.status_code == 201, created.text

    reindex = client.post("/api/runbooks/reindex")
    assert reindex.status_code == 200, reindex.text
    result = reindex.json()
    assert result["failed"] == 0
    assert result["indexed"] >= 1
    assert client.get(f"/api/rag/documents/{document_id}").status_code == 200
    assert client.get("/api/rag/documents/runbook:network_triage").status_code == 200


def test_runbook_mutations_are_append_only_audited(client) -> None:
    _mount_runbook_router(client)
    created = client.post(
        "/api/runbooks",
        json={"id": "audit_triage", "content": _document("audit_triage")},
    )
    assert created.status_code == 201, created.text
    revision = _item(created.json())["revision"]
    assert client.post("/api/runbooks/audit_triage/reindex").status_code == 200
    deleted = client.delete(f"/api/runbooks/audit_triage?expected_revision={revision}")
    assert deleted.status_code == 200

    audit_docs = [
        doc
        for bucket in client.app.state.tlsoc.es.docs.values()
        for doc in bucket.values()
        if doc.get("action_type") == "runbook"
    ]
    summaries = " ".join(str(doc.get("result_summary") or "") for doc in audit_docs)
    assert "created" in summaries
    assert "reindexed" in summaries
    assert "deleted" in summaries
    assert all(doc.get("surface") == "runbooks" for doc in audit_docs)
