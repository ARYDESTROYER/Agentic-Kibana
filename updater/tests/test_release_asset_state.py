from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "scripts" / "release_asset_state.py"
SPEC = importlib.util.spec_from_file_location("release_asset_state", MODULE_PATH)
assert SPEC and SPEC.loader
release_asset_state = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release_asset_state)

SHA = "a" * 40
TAG = "v0.1.2"


def asset(asset_id: int, name: str, *, state: str = "uploaded", size: int = 64):
    return {"id": asset_id, "name": name, "state": state, "size": size}


def release(*assets, draft: bool = True, sha: str = SHA, release_id: int = 11):
    return {
        "id": release_id,
        "tag_name": TAG,
        # GitHub documents target_commitish as unused when the tag already
        # exists; the hidden release marker is the durable SHA binding.
        "target_commitish": "main",
        "body": f"<!-- agentic-soc-release-commit:{sha} -->\n\nRelease notes.",
        "draft": draft,
        "prerelease": False,
        "published_at": None if draft else "2026-08-03T00:00:00Z",
        "assets": list(assets),
    }


class ReleaseAssetStateTests(unittest.TestCase):
    def classify(self, inventory):
        return release_asset_state.classify_release_inventory(
            inventory, tag=TAG, commit_sha=SHA
        )

    def test_absent_release_is_clean_initial_state(self) -> None:
        other = release()
        other["tag_name"] = "v0.1.1"
        result = self.classify([[other]])
        self.assertEqual(result["release_state"], "absent")
        self.assertFalse(result["release_exists"])

    def test_draft_without_assets_is_restartable(self) -> None:
        result = self.classify([[release()]])
        self.assertEqual(result["release_state"], "draft")
        self.assertFalse(result["plan_exists"])
        self.assertEqual(result["delete_asset_ids"], [])

    def test_draft_plan_only_is_restartable(self) -> None:
        result = self.classify([[release(asset(21, "upgrade-plan.json"))]])
        self.assertTrue(result["plan_exists"])
        self.assertFalse(result["bundle_exists"])
        self.assertEqual(result["plan_asset_id"], 21)

    def test_complete_draft_is_publishable(self) -> None:
        result = self.classify(
            [[
                release(
                    asset(21, "upgrade-plan.json"),
                    asset(22, "upgrade-plan.sigstore.json"),
                )
            ]]
        )
        self.assertTrue(result["plan_exists"])
        self.assertTrue(result["bundle_exists"])
        self.assertEqual(result["delete_asset_ids"], [])

    def test_interrupted_starter_upload_is_cleaned_only_in_draft(self) -> None:
        result = self.classify(
            [[
                release(
                    asset(21, "upgrade-plan.json"),
                    asset(
                        22,
                        "upgrade-plan.sigstore.json",
                        state="starter",
                        size=0,
                    ),
                )
            ]]
        )
        self.assertTrue(result["plan_exists"])
        self.assertFalse(result["bundle_exists"])
        self.assertEqual(result["delete_asset_ids"], [22])

    def test_orphan_bundle_is_removed_only_from_exact_draft(self) -> None:
        result = self.classify([[release(asset(22, "upgrade-plan.sigstore.json"))]])
        self.assertFalse(result["bundle_exists"])
        self.assertEqual(result["delete_asset_ids"], [22])

    def test_complete_published_release_is_reusable(self) -> None:
        result = self.classify(
            [[
                release(
                    asset(21, "upgrade-plan.json"),
                    asset(22, "upgrade-plan.sigstore.json"),
                    draft=False,
                )
            ]]
        )
        self.assertEqual(result["release_state"], "published")
        self.assertTrue(result["bundle_exists"])

    def test_previously_published_draft_is_never_repaired(self) -> None:
        prior = release()
        prior["published_at"] = "2026-08-03T00:00:00Z"
        with self.assertRaisesRegex(
            release_asset_state.ReleaseInventoryError, "previously published"
        ):
            self.classify([[prior]])

    def test_partial_published_release_fails_closed(self) -> None:
        with self.assertRaisesRegex(
            release_asset_state.ReleaseInventoryError,
            "published release is missing",
        ):
            self.classify([[release(asset(21, "upgrade-plan.json"), draft=False)]])

    def test_published_starter_asset_fails_closed(self) -> None:
        with self.assertRaisesRegex(
            release_asset_state.ReleaseInventoryError,
            "published release contains incomplete",
        ):
            self.classify(
                [[
                    release(
                        asset(21, "upgrade-plan.json"),
                        asset(
                            22,
                            "upgrade-plan.sigstore.json",
                            state="starter",
                            size=0,
                        ),
                        draft=False,
                    )
                ]]
            )

    def test_wrong_release_commit_marker_fails_closed(self) -> None:
        with self.assertRaisesRegex(
            release_asset_state.ReleaseInventoryError, "commit marker"
        ):
            self.classify([[release(sha="b" * 40)]])

    def test_target_commitish_is_not_mistaken_for_existing_tag_identity(self) -> None:
        result = self.classify([[release()]])
        self.assertEqual(result["release_state"], "draft")

    def test_duplicate_exact_tag_fails_closed(self) -> None:
        with self.assertRaisesRegex(
            release_asset_state.ReleaseInventoryError, "multiple releases"
        ):
            self.classify([[release(release_id=11), release(release_id=12)]])

    def test_unexpected_or_duplicate_asset_fails_closed(self) -> None:
        with self.assertRaisesRegex(
            release_asset_state.ReleaseInventoryError, "unexpected release asset"
        ):
            self.classify([[release(asset(23, "other.zip"))]])
        with self.assertRaisesRegex(
            release_asset_state.ReleaseInventoryError, "duplicate asset"
        ):
            self.classify(
                [[
                    release(
                        asset(21, "upgrade-plan.json"),
                        asset(22, "upgrade-plan.json"),
                    )
                ]]
            )


if __name__ == "__main__":
    unittest.main()
