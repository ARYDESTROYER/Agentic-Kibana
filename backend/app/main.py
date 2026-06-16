"""FastAPI application entrypoint.

Run with: ``uvicorn app.main:app --host 0.0.0.0 --port 8088``
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from .api.routes import router
from .config import Secrets
from .logging_setup import configure_logging
from .state import AppState

logger = logging.getLogger("tlsoc.main")


@asynccontextmanager
async def lifespan(app: FastAPI):
    secrets = Secrets()
    configure_logging(secrets.log_level)
    logger.info("Starting TLSOC Agentic Triage backend")
    state = AppState.create(secrets=secrets)
    app.state.tlsoc = state
    await state.startup()
    try:
        yield
    finally:
        logger.info("Shutting down TLSOC Agentic Triage backend")
        await state.shutdown()


app = FastAPI(
    title="TLSOC Agentic Triage Suite — Backend",
    version="1.0.0",
    description="Agentic SOC triage backend (FastAPI + LangGraph). Read-only consumer of the "
                "ELK log surface; owns its cases/audit/usage indices.",
    lifespan=lifespan,
)
app.include_router(router)


@app.get("/")
async def root() -> dict[str, str]:
    return {"service": "tlsoc-agentic-triage", "health": "/api/health", "docs": "/docs"}
