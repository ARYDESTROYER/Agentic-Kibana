from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "scripts" / "read_release_state_boolean.py"
SPEC = importlib.util.spec_from_file_location("read_release_state_boolean", MODULE_PATH)
assert SPEC and SPEC.loader
release_state_boolean = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release_state_boolean)


class ReleaseStateBooleanTests(unittest.TestCase):
    def invoke(
        self,
        payload: object,
        field: str = "release_exists",
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(MODULE_PATH), "--field", field],
            input=json.dumps(payload),
            capture_output=True,
            check=False,
            text=True,
        )

    def test_valid_false_is_emitted_without_an_error_exit(self) -> None:
        result = self.invoke({"release_exists": False})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "false\n")
        self.assertEqual(result.stderr, "")

    def test_valid_true_is_emitted_without_changing_its_value(self) -> None:
        result = self.invoke({"plan_exists": True}, "plan_exists")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "true\n")

    def test_missing_null_and_wrong_types_fail_closed(self) -> None:
        invalid_payloads = (
            {},
            {"bundle_exists": None},
            {"bundle_exists": "false"},
            {"bundle_exists": 0},
            {"bundle_exists": []},
        )
        for payload in invalid_payloads:
            with self.subTest(payload=payload):
                result = self.invoke(payload, "bundle_exists")
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, "")
                self.assertIn("missing or is not a boolean", result.stderr)

    def test_non_object_state_fails_closed(self) -> None:
        result = self.invoke([])
        self.assertEqual(result.returncode, 1)
        self.assertIn("must be a JSON object", result.stderr)


if __name__ == "__main__":
    unittest.main()
