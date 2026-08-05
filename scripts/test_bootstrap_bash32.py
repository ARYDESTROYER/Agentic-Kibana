#!/usr/bin/env python3
"""Exercise the bootstrap Compose invocation with the host's legacy Bash.

macOS still ships Bash 3.2.  Under ``set -u`` that shell rejects an expansion of
an empty array even though modern Bash accepts it.  This dependency-free harness
extracts the shipping helper itself, invokes both supported argument paths through
a fake Compose wrapper, and verifies the exact argv without touching Docker.
"""

from __future__ import annotations

import os
import subprocess
import tempfile
import textwrap
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BOOTSTRAP = ROOT / "scripts" / "bootstrap-updater.sh"


def _shipping_start_helper() -> str:
    lines = BOOTSTRAP.read_text(encoding="utf-8").splitlines()
    try:
        start = lines.index("  start_updater() {")
    except ValueError as exc:
        raise AssertionError("shipping start_updater helper is missing") from exc
    try:
        end = lines.index("  }", start + 1)
    except ValueError as exc:
        raise AssertionError("shipping start_updater helper is unterminated") from exc
    return textwrap.dedent("\n".join(lines[start : end + 1]))


def main() -> int:
    release_version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    release_sha = "1111111111111111111111111111111111111111"
    bash_version = subprocess.run(
        ["/bin/bash", "-c", 'printf "%s.%s\\n" "${BASH_VERSINFO[0]}" "${BASH_VERSINFO[1]}"'],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    helper = _shipping_start_helper()

    with tempfile.TemporaryDirectory(prefix="agentic-soc-bash32-") as directory:
        root = Path(directory)
        wrapper = root / "compose-wrapper"
        calls = root / "calls"
        wrapper.write_text(
            "#!/usr/bin/env bash\n"
            "set -Eeuo pipefail\n"
            'printf "%s|%s|%s|%s\\n" "${TLSOC_VERSION}" '
            '"${TLSOC_RELEASE_CHANNEL}" "${TLSOC_BUILD_SHA}" "$*" '
            '>> "$AGENTIC_SOC_BOOTSTRAP_TEST_LOG"\n',
            encoding="utf-8",
        )
        wrapper.chmod(0o700)
        driver = (
            "set -Eeuo pipefail\n"
            f'version="{release_version}"\n'
            f'release_sha="{release_sha}"\n'
            f'compose_wrapper="{wrapper}"\n'
            f"{helper}\n"
            "start_updater\n"
            "start_updater --force-recreate\n"
        )
        environment = dict(os.environ)
        environment["AGENTIC_SOC_BOOTSTRAP_TEST_LOG"] = str(calls)
        subprocess.run(
            ["/bin/bash", "-c", driver],
            check=True,
            env=environment,
        )
        observed = calls.read_text(encoding="utf-8").splitlines()

    expected = [
        f"{release_version}|stable|{release_sha}|"
        "up --detach --build agentic-soc-updater",
        f"{release_version}|stable|{release_sha}|"
        "up --detach --build --force-recreate agentic-soc-updater",
    ]
    if observed != expected:
        raise AssertionError(f"unexpected Compose argv: {observed!r}")
    print(f"bootstrap Compose argv passed under /bin/bash {bash_version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
