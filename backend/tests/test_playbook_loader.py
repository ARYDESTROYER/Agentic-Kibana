"""Offline tests for the Markdown playbook LOADER (parse + directory load).

No network, no ES, no LLM — pure parsing of in-memory / tmp-dir Markdown text.
"""

from __future__ import annotations

from app.playbooks import Playbook, load_playbooks, parse_playbook
from app.playbooks.manifest import PlaybookManifest


def _valid_text(id_: str = "mail_bruteforce") -> str:
    return (
        "---\n"
        f"id: {id_}\n"
        "name: Mail credential brute force\n"
        "version: 2\n"
        "description: A burst of failed mail authentications.\n"
        "priority: 50\n"
        "match:\n"
        "  rule_ids: [mail_auth, waf_auth]\n"
        "  entity_types: [ip, user]\n"
        "  min_event_count: 3\n"
        "suggested_tools: [es_query, enrich]\n"
        "rag_queries:\n"
        "  - mail brute force playbook\n"
        "escalate_if: a single attempt succeeded\n"
        "suggested_verdict_bias: lean TRUE_POSITIVE on success\n"
        "---\n"
        "## Procedure\n"
        "1. Confirm the failure burst.\n"
    )


def test_valid_frontmatter_parses() -> None:
    pb = parse_playbook(_valid_text(), fallback_id="x")
    assert pb is not None
    assert pb.id == "mail_bruteforce"
    assert pb.name == "Mail credential brute force"
    assert pb.version == 2
    assert pb.manifest.priority == 50
    assert pb.manifest.match.rule_ids == ["mail_auth", "waf_auth"]
    assert pb.manifest.match.entity_types == ["ip", "user"]
    assert pb.manifest.match.min_event_count == 3
    assert pb.manifest.suggested_tools == ["es_query", "enrich"]
    assert pb.manifest.rag_queries == ["mail brute force playbook"]
    assert pb.manifest.escalate_if == "a single attempt succeeded"
    assert pb.manifest.suggested_verdict_bias == "lean TRUE_POSITIVE on success"
    assert pb.body.startswith("## Procedure")


def test_unknown_keys_ignored_and_loaded() -> None:
    text = (
        "---\n"
        "id: with_extras\n"
        "name: Has extras\n"
        "wat: this key is unknown\n"
        "another_unknown: 42\n"
        "match:\n"
        "  rule_ids: [postfix]\n"
        "---\n"
        "Body.\n"
    )
    pb = parse_playbook(text, fallback_id="x")
    assert pb is not None
    assert pb.id == "with_extras"
    assert pb.manifest.match.rule_ids == ["postfix"]
    # The unknown keys did not leak onto the manifest.
    assert not hasattr(pb.manifest, "wat")


def test_missing_id_is_skipped() -> None:
    text = "---\nname: No id here\n---\nBody.\n"
    assert parse_playbook(text, fallback_id="x") is None


def test_bad_id_slug_is_skipped() -> None:
    # Uppercase + spaces violate the slug rule.
    text = "---\nid: Not A Slug!\nname: bad\n---\nBody.\n"
    assert parse_playbook(text, fallback_id="x") is None


def test_not_a_dict_frontmatter_is_skipped() -> None:
    # No front-matter fences at all → parser returns an empty meta dict → no id.
    assert parse_playbook("Just a plain body, no front matter.\n", fallback_id="x") is None


def test_empty_text_does_not_raise() -> None:
    assert parse_playbook("", fallback_id="x") is None


def test_load_playbooks_skips_broken_keeps_good(tmp_path) -> None:
    (tmp_path / "good.md").write_text(_valid_text("good_one"), encoding="utf-8")
    # Broken: missing id.
    (tmp_path / "broken.md").write_text("---\nname: broken\n---\nBody.\n", encoding="utf-8")

    pbs = load_playbooks(tmp_path)
    assert [pb.id for pb in pbs] == ["good_one"]
    assert all(isinstance(pb, Playbook) for pb in pbs)
    assert pbs[0].source_path.endswith("good.md")


def test_load_playbooks_missing_dir_returns_empty(tmp_path) -> None:
    assert load_playbooks(tmp_path / "does_not_exist") == []


def test_construct_playbook_directly() -> None:
    # Tests/orchestrator may build Playbook objects without files.
    pb = Playbook(manifest=PlaybookManifest(id="direct", name="Direct"), body="b")
    assert pb.id == "direct" and pb.version == 1 and pb.name == "Direct"
