"""Logging configuration."""

from __future__ import annotations

import logging


def configure_logging(level: str = "INFO") -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)-7s %(name)s :: %(message)s",
    )
    # Quieten noisy third-party loggers.
    for noisy in ("elastic_transport.transport", "httpx", "httpcore"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
