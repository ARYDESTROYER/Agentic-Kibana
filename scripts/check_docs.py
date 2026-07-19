#!/usr/bin/env python3
"""Validate the public documentation information architecture and link hygiene."""

from __future__ import annotations

import re
import sys
from collections import Counter
from pathlib import Path
from urllib.parse import unquote


ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"

EXCLUDED_FILES = {
    "AGNOSTIC_ARCHITECTURE.md",
    "ENVIRONMENT.md",
    "HANDOFF.md",
    "INGESTION.md",
    "ROADMAP_RESEARCH.md",
    "RUNBOOK.md",
    "TROUBLESHOOTING.md",
    "USAGE.md",
    "VIGIL_STUDY.md",
}

OBSOLETE_PUBLIC_TERMS = {
    "3.0.0-alpha.1": "use the 0.1 release nomenclature",
    "BLEEDING EDGE": "use Testing",
    "Bleeding Edge": "use Testing",
    "ALPHA PREVIEW": "use the Testing channel badge",
}

# The nomenclature policy pages name retired labels only to tell readers not to
# use them. Everywhere else, their presence is treated as active-copy drift.
OBSOLETE_TERM_ALLOWLIST = {
    Path("concepts/terminology.md"),
    Path("releases/channels.md"),
}

INTERNAL_ONLY_REFERENCES = {
    "Journal.md": "the development journal is not part of the public manual",
    "docs/HANDOFF.md": "the engineering handoff is not part of the public manual",
    "docs/research/": "research notes are not part of the public manual",
}

MARKDOWN_LINK = re.compile(r"(?<!!)\[[^\]]*\]\(([^)]+)\)")
NAV_TARGET = re.compile(r"^\s*-\s+(?:[^:]+:\s+)?([^\s]+\.md)\s*$")
FENCE = re.compile(r"^\s*(```|~~~)")


def public_pages() -> set[Path]:
    return {
        path.relative_to(DOCS)
        for path in DOCS.rglob("*.md")
        if path.relative_to(DOCS).parts[0] != "research"
        and path.relative_to(DOCS).as_posix() not in EXCLUDED_FILES
    }


def prose_without_fences(source: str) -> str:
    result: list[str] = []
    inside = False
    marker = ""
    for line in source.splitlines():
        match = FENCE.match(line)
        if match:
            token = match.group(1)
            if not inside:
                inside = True
                marker = token
            elif token == marker:
                inside = False
                marker = ""
            continue
        if not inside:
            result.append(line)
    return "\n".join(result)


def nav_pages() -> list[Path]:
    targets: list[Path] = []
    in_nav = False
    for line in (ROOT / "mkdocs.yml").read_text(encoding="utf-8").splitlines():
        if line == "nav:":
            in_nav = True
            continue
        if not in_nav:
            continue
        match = NAV_TARGET.match(line)
        if match:
            targets.append(Path(match.group(1)))
    return targets


def resolved_link(page: Path, raw_target: str) -> Path | None:
    target = raw_target.strip().strip("<>").split(maxsplit=1)[0]
    if not target or target.startswith(("#", "/", "http://", "https://", "mailto:")):
        return None
    path_text = unquote(target.split("#", 1)[0].split("?", 1)[0])
    if not path_text:
        return None
    return (DOCS / page.parent / path_text).resolve()


def main() -> int:
    failures: list[str] = []
    pages = public_pages()
    navigation = nav_pages()
    nav_counts = Counter(navigation)

    for page in sorted(pages - set(navigation)):
        failures.append(f"public page is missing from nav: docs/{page.as_posix()}")
    for page in sorted(set(navigation) - pages):
        failures.append(f"nav target does not exist or is excluded: docs/{page.as_posix()}")
    for page, count in sorted(nav_counts.items()):
        if count != 1:
            failures.append(f"nav target appears {count} times: docs/{page.as_posix()}")

    for page in sorted(pages):
        absolute = DOCS / page
        source = absolute.read_text(encoding="utf-8")
        prose = prose_without_fences(source)

        if not source.startswith("---\n"):
            failures.append(f"docs/{page.as_posix()}: missing YAML front matter")
        if len(re.findall(r"(?m)^# [^#].+$", prose)) != 1:
            failures.append(f"docs/{page.as_posix()}: expected exactly one H1")

        if page not in OBSOLETE_TERM_ALLOWLIST:
            for term, replacement in OBSOLETE_PUBLIC_TERMS.items():
                if term in prose:
                    failures.append(
                        f"docs/{page.as_posix()}: obsolete term {term!r}; {replacement}"
                    )
        for reference, reason in INTERNAL_ONLY_REFERENCES.items():
            if reference in prose:
                failures.append(f"docs/{page.as_posix()}: contains {reference!r}; {reason}")

        for match in MARKDOWN_LINK.finditer(prose):
            raw_target = match.group(1)
            resolved = resolved_link(page, raw_target)
            if resolved is None:
                continue
            if not resolved.exists():
                failures.append(
                    f"docs/{page.as_posix()}: broken relative link {raw_target!r}"
                )

    if failures:
        print("Documentation consistency check failed:", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        return 1

    print(f"Documentation consistency check passed: {len(pages)} public pages")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
