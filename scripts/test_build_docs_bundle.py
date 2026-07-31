#!/usr/bin/env python3
"""Focused standard-library tests for the installed documentation artifact."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import build_docs_bundle as bundle
import run_docs_bundle as runner


class DocumentationBundleTests(unittest.TestCase):
    def test_wrapper_resolves_npm_output_from_webui_working_directory(self) -> None:
        webui = bundle.ROOT / "webui"
        arguments = runner.normalize_arguments(
            ["--output", "public/docs", "--check-only"],
            webui,
        )
        self.assertEqual(
            arguments,
            ["--output", str(webui / "public" / "docs"), "--check-only"],
        )

    def test_documentation_version_uses_major_minor(self) -> None:
        self.assertEqual(bundle.documentation_version("0.1.1"), "0.1")
        self.assertEqual(bundle.documentation_version("12.34.56-rc.2+build.7"), "12.34")

    def test_unknown_channel_fails_safe_to_testing(self) -> None:
        self.assertEqual(bundle.release_channel({}), "Testing")
        self.assertEqual(
            bundle.release_channel({"TLSOC_RELEASE_CHANNEL": "preview"}),
            "Testing",
        )
        self.assertEqual(
            bundle.release_channel({"TLSOC_RELEASE_CHANNEL": "stable"}),
            "Stable",
        )

    def test_manifest_and_aliases_identify_installed_version(self) -> None:
        with tempfile.TemporaryDirectory() as raw_temp:
            output = Path(raw_temp)
            version_root = output / "0.1"
            (version_root / "search").mkdir(parents=True)
            (version_root / "index.html").write_text(
                '<meta name="generator" content="mkdocs-test">',
                encoding="utf-8",
            )
            (version_root / "search" / "search_index.json").write_text(
                "{}",
                encoding="utf-8",
            )

            bundle.write_bundle_metadata(
                output,
                version="0.1.1",
                docs_version="0.1",
                channel="Testing",
            )
            bundle.validate_bundle(
                output,
                version="0.1.1",
                docs_version="0.1",
                channel="Testing",
            )

            manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["canonicalPath"], "/docs/0.1/")
            self.assertEqual(
                manifest["installedAliases"],
                ["/docs/", "/docs/installed/"],
            )
            self.assertIn("/docs/0.1/", (output / "index.html").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
