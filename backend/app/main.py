"""FastAPI application entrypoint.

Run with: ``uvicorn app.main:app --host 0.0.0.0 --port 8088``
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI

from .api.deps import require_auth
from .api.routes import router
from .api.routes_cases_collab import router as cases_collab_router
from .api.routes_enrichment import router as enrichment_router
from .api.routes_inapp import router as inapp_router
from .api.routes_metrics import router as metrics_router
from .api.routes_models import router as models_router
from .api.routes_roles import router as roles_router
from .api.routes_standup import router as standup_router
from .api.routes_triage import router as triage_router
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

# Round-3 Wave-2 feature routers (each a standalone APIRouter(prefix="/api")). Mounted
# with the SAME require_auth dependency so every new route inherits the auth gate (GETs
# are protected; each non-GET declares its own require_permission). Additive — none of
# these touch the deterministic case_manager.decide() (#3) or the LLM ledger (#6).
for _feature_router in (
    metrics_router,       # F5 — richer posture / MITRE coverage metrics
    standup_router,       # F11 — forward-looking shift handoff + action items
    enrichment_router,    # F7 — multi-provider enrichment lookup
    models_router,        # F9 — LLM model catalog / pricing / budget
    inapp_router,         # F8 — in-app notification inbox + delivery prefs
    cases_collab_router,  # F4 — per-case threaded collaboration + tasks
    triage_router,        # F12 — triage chips + ReAct timeline
    roles_router,         # F6 — RBAC custom-role CRUD + permission UX
):
    app.include_router(_feature_router, dependencies=[Depends(require_auth)])


@app.get("/")
async def root() -> dict[str, str]:
    return {"service": "tlsoc-agentic-triage", "health": "/api/health", "docs": "/docs"}
