from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from scripts import check_ci_contract as policy


PINNED_CHECKOUT = (
    "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803"
)


def _job() -> dict[str, object]:
    return {
        "runs-on": "ubuntu-latest",
        "timeout-minutes": 5,
        "steps": [{"uses": PINNED_CHECKOUT}],
    }


def _ci_workflow() -> dict[str, object]:
    return {
        "on": {"pull_request": {}, "push": {}},
        "permissions": {"contents": "read"},
        "jobs": {
            "quality": _job(),
            "ci": {
                "name": "CI passed",
                "runs-on": "ubuntu-latest",
                "timeout-minutes": 5,
                "if": "${{ always() }}",
                "needs": ["quality"],
                "steps": [
                    {
                        "run": (
                            'result="${{ needs.quality.result }}"\n'
                            '[[ "$result" == "success" ]]'
                        )
                    }
                ],
            },
        },
    }


class WorkflowPolicyTests(unittest.TestCase):
    def test_known_good_ci_contract_passes(self) -> None:
        workflow = _ci_workflow()
        policy._assert_common(Path("ci.yml"), workflow)
        policy._assert_ci(Path("ci.yml"), workflow)

    def test_duplicate_yaml_key_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "duplicate.yml"
            path.write_text("name: first\nname: second\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "duplicate key"):
                policy._load(path)

    def test_yaml_extension_cannot_bypass_the_workflow_allowlist(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in policy.EXPECTED_WORKFLOWS:
                (root / name).touch()
            (root / "escape.yaml").touch()
            with mock.patch.object(policy, "WORKFLOW_DIR", root):
                with self.assertRaisesRegex(ValueError, "unknown=\\['escape.yaml'\\]"):
                    policy._workflow_paths()

    def test_required_workflow_cannot_be_removed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "ci.yml").touch()
            (root / "docs.yml").touch()
            with mock.patch.object(policy, "WORKFLOW_DIR", root):
                with self.assertRaisesRegex(ValueError, "missing=\\['release.yml'\\]"):
                    policy._workflow_paths()

    def test_mutable_action_reference_is_rejected(self) -> None:
        workflow = _ci_workflow()
        workflow["jobs"]["quality"]["steps"] = [  # type: ignore[index]
            {"uses": "actions/checkout@v6"}
        ]
        with self.assertRaisesRegex(ValueError, "40-char SHA"):
            policy._assert_common(Path("ci.yml"), workflow)

    def test_mutable_service_image_is_rejected(self) -> None:
        workflow = _ci_workflow()
        workflow["jobs"]["quality"]["services"] = {  # type: ignore[index]
            "postgres": {"image": "pgvector/pgvector:pg16"}
        }
        with self.assertRaisesRegex(ValueError, "must use an image digest"):
            policy._assert_ci(Path("ci.yml"), workflow)

    def test_digest_pinned_service_image_passes(self) -> None:
        workflow = _ci_workflow()
        workflow["jobs"]["quality"]["services"] = {  # type: ignore[index]
            "postgres": {"image": "pgvector/pgvector@sha256:" + "a" * 64}
        }
        policy._assert_ci(Path("ci.yml"), workflow)

    def test_continue_on_error_is_rejected(self) -> None:
        workflow = _ci_workflow()
        workflow["jobs"]["quality"]["continue-on-error"] = True  # type: ignore[index]
        with self.assertRaisesRegex(ValueError, "continue-on-error"):
            policy._assert_common(Path("ci.yml"), workflow)

    def test_missing_timeout_is_rejected(self) -> None:
        workflow = _ci_workflow()
        del workflow["jobs"]["quality"]["timeout-minutes"]  # type: ignore[index]
        with self.assertRaisesRegex(ValueError, "no timeout-minutes"):
            policy._assert_common(Path("ci.yml"), workflow)

    def test_pull_request_target_is_rejected(self) -> None:
        workflow = _ci_workflow()
        workflow["on"] = {"pull_request_target": {}, "push": {}}
        with self.assertRaisesRegex(ValueError, "unsafe or malformed"):
            policy._assert_ci(Path("ci.yml"), workflow)

    def test_new_job_must_enter_aggregate(self) -> None:
        workflow = _ci_workflow()
        workflow["jobs"]["untracked"] = _job()  # type: ignore[index]
        with self.assertRaisesRegex(ValueError, "dependency drift"):
            policy._assert_ci(Path("ci.yml"), workflow)

    def test_aggregate_must_explicitly_require_success(self) -> None:
        workflow = _ci_workflow()
        workflow["jobs"]["ci"]["steps"] = [  # type: ignore[index]
            {"run": 'echo "${{ needs.quality.result }}"'}
        ]
        with self.assertRaisesRegex(ValueError, "explicit success"):
            policy._assert_ci(Path("ci.yml"), workflow)

    def test_repository_publishers_require_exact_tag_ci(self) -> None:
        docs_path = policy.WORKFLOW_DIR / "docs.yml"
        release_path = policy.WORKFLOW_DIR / "release.yml"
        policy._assert_docs(docs_path, policy._load(docs_path))
        policy._assert_release(release_path, policy._load(release_path))

    def test_docs_publisher_cannot_drop_exact_tag_ci_gate(self) -> None:
        docs_path = policy.WORKFLOW_DIR / "docs.yml"
        workflow = policy._load(docs_path)
        publish = workflow["jobs"]["publish"]
        publish["steps"] = [
            step
            for step in publish["steps"]
            if step.get("name")
            != "Require the exact tag CI run and fail-closed aggregate"
        ]
        with self.assertRaisesRegex(ValueError, "exact tag CI"):
            policy._assert_docs(docs_path, workflow)

    def test_docs_publisher_requires_actions_read_permission(self) -> None:
        docs_path = policy.WORKFLOW_DIR / "docs.yml"
        workflow = policy._load(docs_path)
        workflow["jobs"]["publish"]["permissions"] = {"contents": "write"}
        with self.assertRaisesRegex(ValueError, "publisher permissions drifted"):
            policy._assert_docs(docs_path, workflow)

    def test_external_dockerfile_base_requires_digest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "Dockerfile"
            path.write_text("FROM python:3.11-alpine\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "reviewed digest"):
                policy._assert_dockerfile_bases(path)

    def test_pinned_base_and_internal_stage_pass(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "Dockerfile"
            path.write_text(
                "FROM python:3.11-alpine@sha256:" + "a" * 64 + " AS base\n"
                "FROM base AS final\n",
                encoding="utf-8",
            )
            policy._assert_dockerfile_bases(path)


if __name__ == "__main__":
    unittest.main()
