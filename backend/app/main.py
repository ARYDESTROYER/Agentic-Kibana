"""FastAPI application entrypoint.

Run with: ``uvicorn app.main:app --host 0.0.0.0 --port 8088``
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI

from .api.deps import require_auth
from .api.routes import router
from .config import Secrets
from .logging_setup import configure_logging
from .middleware import CSRFMiddleware, RateLimitMiddleware, SecurityHeadersMiddleware
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

# --- Security middleware (Wave 2; env-toggleable, independent of auth). Added in
# this order so security headers are OUTERMOST (cover every response incl. 401/403).
_sec = Secrets()
if _sec.csrf_enabled:
    app.add_middleware(CSRFMiddleware, enabled=True)
if _sec.rate_limit_enabled:
    app.add_middleware(
        RateLimitMiddleware,
        capacity=_sec.rate_limit_capacity,
        refill_per_second=_sec.rate_limit_refill_per_second,
        enabled=True,
    )
if _sec.security_headers_enabled:
    app.add_middleware(SecurityHeadersMiddleware)

# Auth gate on the WHOLE /api router (deny-by-default; a strict no-op when auth is
# disabled). Every /api route inherits it → a new route is protected automatically.
app.include_router(router, dependencies=[Depends(require_auth)])


@app.get("/")
async def root() -> dict[str, str]:
    return {"service": "tlsoc-agentic-triage", "health": "/api/health", "docs": "/docs"}
