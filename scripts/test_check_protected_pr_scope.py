from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from scripts import check_protected_pr_scope as scope


BASE_SHA = "a" * 40
HEAD_SHA = "b" * 40


def _pull_event(
    base_ref: str = "Testing",
    *,
    base_sha: str = BASE_SHA,
    head_sha: str = HEAD_SHA,
) -> dict[str, object]:
    return {
        "pull_request": {
            "base": {"ref": base_ref, "sha": base_sha},
            "head": {"ref": "feature", "sha": head_sha},
        }
    }


def _push_event(
    branch: str = "Testing",
    *,
    before_sha: str = BASE_SHA,
    after_sha: str = HEAD_SHA,
) -> dict[str, object]:
    return {
        "ref": f"refs/heads/{branch}",
        "before": before_sha,
        "after": after_sha,
    }


class ProtectedChangeScopeTests(unittest.TestCase):
    def _event_file(self, directory: str, event: object) -> Path:
        path = Path(directory) / "event.json"
        path.write_text(json.dumps(event), encoding="utf-8")
        return path

    def _check_pull(
        self, directory: str, event: object, *, actions: bool = False
    ) -> str:
        pull_request = event.get("pull_request") if isinstance(event, dict) else None
        base = pull_request.get("base") if isinstance(pull_request, dict) else None
        head = pull_request.get("head") if isinstance(pull_request, dict) else None
        base_ref = base.get("ref") if isinstance(base, dict) else "Testing"
        head_ref = head.get("ref") if isinstance(head, dict) else "feature"
        environment = {
            "GITHUB_BASE_REF": str(base_ref),
            "GITHUB_HEAD_REF": str(head_ref),
        }
        if actions:
            environment["GITHUB_ACTIONS"] = "true"
        return scope.check_scope(
            event_name="pull_request",
            event_path=self._event_file(directory, event),
            repository=Path(directory),
            environment=environment,
        )

    def _check_push(
        self, directory: str, event: object, *, actions: bool = False
    ) -> str:
        ref = event.get("ref") if isinstance(event, dict) else "refs/heads/Testing"
        after = event.get("after") if isinstance(event, dict) else HEAD_SHA
        environment = {"GITHUB_REF": str(ref), "GITHUB_SHA": str(after)}
        if actions:
            environment["GITHUB_ACTIONS"] = "true"
        return scope.check_scope(
            event_name="push",
            event_path=self._event_file(directory, event),
            repository=Path(directory),
            environment=environment,
        )

    def _git(self, repository: Path, *arguments: str) -> str:
        completed = subprocess.run(
            ["git", *arguments],
            cwd=repository,
            check=True,
            capture_output=True,
            text=True,
        )
        return completed.stdout.strip()

    def _initialize_repository(self, repository: Path) -> str:
        self._git(repository, "init", "--initial-branch=Testing")
        self._git(repository, "config", "user.name", "Scope Test")
        self._git(repository, "config", "user.email", "scope@example.invalid")
        (repository / "Journal.md").write_text("# Journal\n", encoding="utf-8")
        (repository / "README.md").write_text("# Fixture\n", encoding="utf-8")
        self._git(repository, "add", "Journal.md", "README.md")
        self._git(repository, "commit", "-m", "base")
        return self._git(repository, "rev-parse", "HEAD")

    def test_non_change_event_is_not_applicable(self) -> None:
        result = scope.check_scope(
            event_name="schedule",
            event_path=None,
            repository=Path("."),
            environment={},
        )
        self.assertIn("not a protected change", result)

    def test_unprotected_push_is_not_applicable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            result = self._check_push(directory, _push_event("feature"))
        self.assertIn("does not target", result)

    def test_missing_event_name_fails_closed(self) -> None:
        with self.assertRaisesRegex(scope.ScopeCheckError, "GITHUB_EVENT_NAME"):
            scope.check_scope(
                event_name="",
                event_path=None,
                repository=Path("."),
                environment={},
            )

    def test_malformed_pull_request_payload_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(scope.ScopeCheckError, "missing pull_request"):
                self._check_pull(directory, {})

    def test_noncanonical_pull_request_sha_fails_closed(self) -> None:
        event = _pull_event()
        event["pull_request"]["head"]["sha"] = "not-a-sha"  # type: ignore[index]
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(scope.ScopeCheckError, "canonical 40-char SHA"):
                self._check_pull(directory, event)

    def test_zero_protected_push_sha_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(scope.ScopeCheckError, "existing commit"):
                self._check_push(
                    directory,
                    _push_event(before_sha="0" * 40),
                )

    def test_environment_and_payload_ref_mismatch_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = self._event_file(directory, _pull_event("main"))
            with self.assertRaisesRegex(scope.ScopeCheckError, "GITHUB_BASE_REF"):
                scope.check_scope(
                    event_name="pull_request",
                    event_path=path,
                    repository=Path(directory),
                    environment={"GITHUB_BASE_REF": "Testing"},
                )

    def test_actions_environment_identity_is_required(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = self._event_file(directory, _pull_event())
            with self.assertRaisesRegex(scope.ScopeCheckError, "require GITHUB_BASE_REF"):
                scope.check_scope(
                    event_name="pull_request",
                    event_path=path,
                    repository=Path(directory),
                    environment={"GITHUB_ACTIONS": "true"},
                )

    @mock.patch.object(scope, "_changed_paths", return_value=("Journal.md",))
    def test_journal_only_protected_pull_request_is_rejected(
        self, _changed_paths: mock.Mock
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(scope.ScopeCheckError, "Journal-only"):
                self._check_pull(directory, _pull_event())

    @mock.patch.object(scope, "_changed_paths", return_value=("Journal.md",))
    def test_journal_only_protected_push_is_rejected(
        self, _changed_paths: mock.Mock
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(scope.ScopeCheckError, "Journal-only"):
                self._check_push(directory, _push_event())

    @mock.patch.object(
        scope,
        "_changed_paths",
        return_value=("Journal.md", "backend/app/main.py"),
    )
    def test_journal_plus_another_change_is_allowed(
        self, _changed_paths: mock.Mock
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            result = self._check_pull(directory, _pull_event())
        self.assertIn("not Journal-only", result)

    @mock.patch.object(scope, "_changed_paths", return_value=("docs/USAGE.md",))
    def test_non_journal_change_is_allowed(self, _changed_paths: mock.Mock) -> None:
        with tempfile.TemporaryDirectory() as directory:
            result = self._check_pull(directory, _pull_event("main"))
        self.assertIn("not Journal-only", result)

    @mock.patch.object(scope, "_changed_paths", return_value=())
    def test_empty_changed_path_result_fails_closed(
        self, _changed_paths: mock.Mock
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(scope.ScopeCheckError, "no changed paths"):
                self._check_pull(directory, _pull_event())

    def test_git_change_detection_uses_validated_three_dot_identity(self) -> None:
        completed = [
            subprocess.CompletedProcess([], 0, stdout=b"", stderr=b""),
            subprocess.CompletedProcess([], 0, stdout=b"blob\n", stderr=b""),
            subprocess.CompletedProcess([], 0, stdout=b"", stderr=b""),
            subprocess.CompletedProcess([], 0, stdout=b"blob\n", stderr=b""),
            subprocess.CompletedProcess(
                [], 0, stdout=b"Journal.md\0backend/app/main.py\0", stderr=b""
            ),
        ]
        with mock.patch.object(subprocess, "run", side_effect=completed) as run:
            paths = scope._changed_paths(
                Path("."),
                BASE_SHA,
                HEAD_SHA,
                use_merge_base=True,
            )
        self.assertEqual(paths, ("Journal.md", "backend/app/main.py"))
        self.assertEqual(
            run.call_args_list[-1].args[0],
            [
                "git",
                "diff",
                "--name-only",
                "--no-renames",
                "--diff-filter=ACDMRTUXB",
                "-z",
                f"{BASE_SHA}...{HEAD_SHA}",
                "--",
            ],
        )

    def test_missing_git_object_fails_closed(self) -> None:
        failure = subprocess.CalledProcessError(128, ["git"], stderr=b"missing object")
        with mock.patch.object(subprocess, "run", side_effect=failure):
            with self.assertRaisesRegex(scope.ScopeCheckError, "missing object"):
                scope._changed_paths(
                    Path("."),
                    BASE_SHA,
                    HEAD_SHA,
                    use_merge_base=True,
                )

    def test_real_git_journal_only_pull_request_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory)
            base_sha = self._initialize_repository(repository)
            self._git(repository, "switch", "--create", "feature")
            (repository / "Journal.md").write_text(
                "# Journal\n\nEvidence only.\n",
                encoding="utf-8",
            )
            self._git(repository, "add", "Journal.md")
            self._git(repository, "commit", "-m", "journal only")
            head_sha = self._git(repository, "rev-parse", "HEAD")
            with self.assertRaisesRegex(scope.ScopeCheckError, "Journal-only"):
                self._check_pull(
                    directory,
                    _pull_event(base_sha=base_sha, head_sha=head_sha),
                )

    def test_real_git_journal_plus_code_pull_request_is_allowed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory)
            base_sha = self._initialize_repository(repository)
            self._git(repository, "switch", "--create", "feature")
            (repository / "Journal.md").write_text("# Journal\n\nDone.\n", encoding="utf-8")
            (repository / "feature.py").write_text("VALUE = 1\n", encoding="utf-8")
            self._git(repository, "add", "Journal.md", "feature.py")
            self._git(repository, "commit", "-m", "feature with journal")
            head_sha = self._git(repository, "rev-parse", "HEAD")
            result = self._check_pull(
                directory,
                _pull_event(base_sha=base_sha, head_sha=head_sha),
                actions=True,
            )
        self.assertIn("not Journal-only", result)

    def test_real_git_journal_rename_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory)
            base_sha = self._initialize_repository(repository)
            self._git(repository, "switch", "--create", "feature")
            self._git(repository, "mv", "Journal.md", "Journal-old.md")
            self._git(repository, "commit", "-m", "rename journal")
            head_sha = self._git(repository, "rev-parse", "HEAD")
            with self.assertRaisesRegex(scope.ScopeCheckError, "Journal.md"):
                self._check_pull(
                    directory,
                    _pull_event(base_sha=base_sha, head_sha=head_sha),
                )

    def test_real_git_journal_deletion_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory)
            base_sha = self._initialize_repository(repository)
            self._git(repository, "switch", "--create", "feature")
            self._git(repository, "rm", "Journal.md")
            self._git(repository, "commit", "-m", "delete journal")
            head_sha = self._git(repository, "rev-parse", "HEAD")
            with self.assertRaisesRegex(scope.ScopeCheckError, "Journal.md"):
                self._check_pull(
                    directory,
                    _pull_event(base_sha=base_sha, head_sha=head_sha),
                )

    def test_real_git_missing_merge_base_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory)
            base_sha = self._initialize_repository(repository)
            self._git(repository, "switch", "--orphan", "feature")
            (repository / "Journal.md").write_text("# New root\n", encoding="utf-8")
            (repository / "feature.py").write_text("VALUE = 1\n", encoding="utf-8")
            self._git(repository, "add", "Journal.md", "feature.py")
            self._git(repository, "commit", "-m", "unrelated history")
            head_sha = self._git(repository, "rev-parse", "HEAD")
            with self.assertRaisesRegex(scope.ScopeCheckError, "no merge base"):
                self._check_pull(
                    directory,
                    _pull_event(base_sha=base_sha, head_sha=head_sha),
                )

    def test_real_git_journal_only_protected_push_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory)
            before_sha = self._initialize_repository(repository)
            (repository / "Journal.md").write_text(
                "# Journal\n\nDirect evidence only.\n",
                encoding="utf-8",
            )
            self._git(repository, "add", "Journal.md")
            self._git(repository, "commit", "-m", "direct journal only")
            after_sha = self._git(repository, "rev-parse", "HEAD")
            with self.assertRaisesRegex(scope.ScopeCheckError, "Journal-only"):
                self._check_push(
                    directory,
                    _push_event(before_sha=before_sha, after_sha=after_sha),
                    actions=True,
                )

    def test_real_git_journal_plus_code_protected_push_is_allowed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory)
            before_sha = self._initialize_repository(repository)
            (repository / "Journal.md").write_text(
                "# Journal\n\nSubstantive change.\n",
                encoding="utf-8",
            )
            (repository / "feature.py").write_text("VALUE = 1\n", encoding="utf-8")
            self._git(repository, "add", "Journal.md", "feature.py")
            self._git(repository, "commit", "-m", "direct substantive change")
            after_sha = self._git(repository, "rev-parse", "HEAD")
            result = self._check_push(
                directory,
                _push_event(before_sha=before_sha, after_sha=after_sha),
                actions=True,
            )
        self.assertIn("not Journal-only", result)

    def test_real_git_journal_rename_on_protected_push_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory)
            before_sha = self._initialize_repository(repository)
            self._git(repository, "mv", "Journal.md", "Journal-old.md")
            self._git(repository, "commit", "-m", "direct journal rename")
            after_sha = self._git(repository, "rev-parse", "HEAD")
            with self.assertRaisesRegex(scope.ScopeCheckError, "Journal.md"):
                self._check_push(
                    directory,
                    _push_event(before_sha=before_sha, after_sha=after_sha),
                )

    def test_real_git_journal_deletion_on_protected_push_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory)
            before_sha = self._initialize_repository(repository)
            self._git(repository, "rm", "Journal.md")
            self._git(repository, "commit", "-m", "direct journal deletion")
            after_sha = self._git(repository, "rev-parse", "HEAD")
            with self.assertRaisesRegex(scope.ScopeCheckError, "Journal.md"):
                self._check_push(
                    directory,
                    _push_event(before_sha=before_sha, after_sha=after_sha),
                )

    def test_real_git_non_ancestor_protected_push_is_still_classified(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory)
            before_sha = self._initialize_repository(repository)
            self._git(repository, "switch", "--orphan", "replacement")
            (repository / "Journal.md").write_text(
                "# Journal\n\nReplacement evidence only.\n",
                encoding="utf-8",
            )
            (repository / "README.md").write_text("# Fixture\n", encoding="utf-8")
            self._git(repository, "add", "Journal.md", "README.md")
            self._git(repository, "commit", "-m", "replacement root")
            after_sha = self._git(repository, "rev-parse", "HEAD")
            with self.assertRaisesRegex(scope.ScopeCheckError, "Journal-only"):
                self._check_push(
                    directory,
                    _push_event(before_sha=before_sha, after_sha=after_sha),
                )

    def test_actions_push_ref_or_sha_mismatch_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            event = _push_event()
            path = self._event_file(directory, event)
            for environment in (
                {
                    "GITHUB_ACTIONS": "true",
                    "GITHUB_REF": "refs/heads/main",
                    "GITHUB_SHA": HEAD_SHA,
                },
                {
                    "GITHUB_ACTIONS": "true",
                    "GITHUB_REF": "refs/heads/Testing",
                    "GITHUB_SHA": "c" * 40,
                },
            ):
                with self.subTest(environment=environment):
                    with self.assertRaisesRegex(scope.ScopeCheckError, "disagrees"):
                        scope.check_scope(
                            event_name="push",
                            event_path=path,
                            repository=Path(directory),
                            environment=environment,
                        )


if __name__ == "__main__":
    unittest.main()
