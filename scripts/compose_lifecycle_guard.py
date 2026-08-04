#!/usr/bin/env python3
"""Serialize supported host Compose mutations against supervised updates."""

from __future__ import annotations

import fcntl
import os
from pathlib import Path
import sys


READ_ONLY_COMMANDS = {
    "config",
    "events",
    "help",
    "images",
    "ls",
    "logs",
    "port",
    "ps",
    "top",
    "version",
}
GLOBAL_OPTIONS_WITH_VALUE = {
    "--ansi",
    "--env-file",
    "--file",
    "--parallel",
    "--profile",
    "--progress",
    "--project-directory",
    "--project-name",
    "-f",
    "-p",
}


def is_mutating(requested: list[str]) -> bool:
    """Classify unknown Compose commands as mutating (fail closed)."""

    index = 0
    while index < len(requested):
        argument = requested[index]
        if argument in GLOBAL_OPTIONS_WITH_VALUE:
            index += 2
            continue
        if argument.startswith("-"):
            index += 1
            continue
        return argument not in READ_ONLY_COMMANDS
    return False


def main(argv: list[str]) -> int:
    if len(argv) < 4 or argv[2] != "--":
        print(
            "Agentic SOC: invalid lifecycle-guard invocation.",
            file=sys.stderr,
        )
        return 2
    runtime_dir = Path(argv[1])
    try:
        requested_count = int(argv[3])
    except ValueError:
        return 2
    command = argv[4:]
    if (
        requested_count < 0
        or requested_count > len(command)
        or not command
    ):
        return 2
    requested = command[-requested_count:] if requested_count else []
    if not is_mutating(requested):
        os.execvp(command[0], command)

    runtime_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock_path = runtime_dir / "lifecycle.lock"
    marker_path = runtime_dir / "update-active.json"
    descriptor = os.open(lock_path, os.O_RDONLY | os.O_CREAT, 0o644)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(
                "Agentic SOC: a supervised update or another lifecycle command is active; retry after it finishes.",
                file=sys.stderr,
            )
            return 4
        if marker_path.exists():
            print(
                "Agentic SOC: a supervised update is active; mutating Compose commands are temporarily blocked.",
                file=sys.stderr,
            )
            return 4
        # Keep the advisory lock across exec so the updater cannot publish its
        # active marker until this exact Docker Compose process has exited.
        os.set_inheritable(descriptor, True)
        os.execvp(command[0], command)
    finally:
        os.close(descriptor)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
