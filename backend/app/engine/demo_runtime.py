"""Demo Mode runtime (Wave 5) — the isolated demo store stack + the live simulator.

Two pieces, both completely SEPARATE from the real state:

* :class:`DemoStack` — a throwaway store stack built on a FRESH ``InMemoryESClient``:
  its own CaseStore / AuditLogger / UsageStore + a $0 deterministic mock gateway +
  an InvestigationPipeline + IngestService bound to it. NOTHING here can reach the
  real ES/SQL stores. The whole thing is garbage-collected when demo is disabled.

* :class:`DemoSimulator` — an asyncio task (mirrors the receiver tasks) that, while
  demo is in ``live`` mode, emits a diurnal-scaled benign Poisson batch each
  jittered tick and low-probability ignites a queued MITRE storyline through the
  demo ingest path (which runs the REAL pipeline against the MOCK LLM + a SANDBOXED
  AutoClosePolicy copy — proving the deterministic #3 gate without touching the real
  policy). Every write lands in the demo store; the real durable cursor is never
  advanced.
"""

from __future__ import annotations

import asyncio
import logging
import random
from typing import Callable

from ..audit.audit_log import AuditLogger
from ..cache import Cache
from ..config import AutoClosePolicy, Preferences, Secrets
from ..constants import SourceSurface
from ..es.fake import InMemoryESClient
from ..llm.gateway import LLMGateway
from ..llm.providers import DemoMockProvider
from ..stores.cases import CaseStore
from ..stores.usage import UsageStore
from ..utils import now_utc, to_millis
from .ingest import IngestService
from . import demo_generator as gen

logger = logging.getLogger("tlsoc.engine.demo")

DEMO_TAG = "demo"


class _DemoCaseStore(CaseStore):
    """A CaseStore over the throwaway demo ES that TAGS every saved case ``demo`` and
    asserts isolation (a write-guard, #4). Cases produced by the demo pipeline get the
    ``demo`` tag here, so the read endpoints' SAMPLE badge + the disable-by-run_id
    purge both work, and no demo row can be mistaken for a real one."""

    def __init__(self, es: InMemoryESClient, run_id: str) -> None:
        super().__init__(es)
        self._run_id = run_id

    async def save(self, case) -> None:  # noqa: ANN001
        tags = list(getattr(case, "tags", []) or [])
        if DEMO_TAG not in tags:
            tags.append(DEMO_TAG)
        run_tag = f"run:{self._run_id[:12]}" if self._run_id else ""
        if run_tag and run_tag not in tags:
            tags.append(run_tag)
        case.tags = tags
        await super().save(case)


def sandbox_policy(base: AutoClosePolicy) -> AutoClosePolicy:
    """A SANDBOXED copy of the auto-close policy for the demo pipeline.

    decide()/apply() are NEVER edited (#3); passing a *different policy instance* to
    the pure decide() is the supported way to isolate demo behaviour. The demo copy
    keeps FALSE_POSITIVE auto-close ENABLED (so the benign baseline auto-closes and
    showcases the deterministic gate) and NEEDS_HUMAN never auto-closes (code-enforced
    regardless). The real ``prefs.auto_close`` is untouched."""
    return base.model_copy(deep=True)


class DemoStack:
    """The isolated demo store stack (built once per enable; GC'd on disable)."""

    def __init__(self, secrets: Secrets, get_prefs: Callable[[], Preferences],
                 *, run_id: str = "") -> None:
        # A FRESH in-memory ES client — physically separate from the real store.
        self.es = InMemoryESClient()
        self.run_id = run_id
        self.cases = _DemoCaseStore(self.es, run_id)
        self.audit = AuditLogger(self.es)
        self.usage_store = UsageStore(self.es)
        # The deterministic, $0 mock provider keyed by storyline.
        self._provider = DemoMockProvider()
        overrides = {"anthropic": self._provider, "openai": self._provider, "mock": self._provider}
        # demo=True → every usage row is pricing_source='zero' with a synthetic $.
        self.gateway = LLMGateway(secrets, self.usage_store, overrides, demo=True)
        self._get_prefs = get_prefs
        # An offline cache (no Redis) for the demo enrich tool.
        self._cache = Cache(None)
        # Lazily built so we avoid importing the (heavy) pipeline at module import.
        self.pipeline = self._build_pipeline(secrets)
        self.ingest_service = IngestService(self.cases, self.audit, self.pipeline, self._demo_prefs)
        # A chat engine bound to the DEMO gateway/audit/cases (NOT the real ones), so a
        # /chat turn while demo is engaged spends $0 (demo gateway → pricing_source
        # 'zero'), writes ONLY demo audit rows (purged on disable), and an in-case chat
        # reads the DEMO case store (so it finds the demo case). This mirrors the
        # demo-switchable active-store @properties on AppState — chat is no exception.
        self.chat_engine = self._build_chat_engine()
        # A standup service over the demo ES (case stats reflect the demo store).
        from ..agents.standup import StandupService

        self.standup_service = StandupService(self.es, self.gateway, self.audit)
        from ..agents.overview import OverviewService

        self.overview_service = OverviewService(self.gateway, secrets, self._cache, self.audit)

    def _build_pipeline(self, secrets: Secrets):
        from ..agents.pipeline import InvestigationPipeline
        from ..connectors.demo import DemoPullConnector

        prefs = self._get_prefs()
        seed = int(getattr(getattr(prefs, "demo", None), "seed", 1337) or 1337)
        source = DemoPullConnector(seed=seed)
        from ..tools.rag import RagService

        rag = RagService(self.gateway, prefs, store=None, cases=self.cases)
        return InvestigationPipeline(
            self.es, secrets, self._cache, self.gateway, rag, self.cases, self.audit,
            source=source,
        )

    def _build_chat_engine(self):
        """A ChatEngine wired to the DEMO gateway/audit/cases + a demo log source +
        a demo RAG (over the demo case store), so chat during demo is $0 and isolated
        — never the real gateway/audit/cases. No operator MEMORY is injected in demo
        (memory=None) so a real operator's durable facts never bleed into the demo."""
        from ..agents.chat import ChatEngine
        from ..connectors.demo import DemoPullConnector
        from ..tools.rag import RagService

        prefs = self._get_prefs()
        seed = int(getattr(getattr(prefs, "demo", None), "seed", 1337) or 1337)
        source = DemoPullConnector(seed=seed)
        rag = RagService(self.gateway, prefs, store=None, cases=self.cases)
        return ChatEngine(
            self.es, self.gateway, self.audit, self.cases, rag,
            source=source, memory=None,
        )

    def _demo_prefs(self) -> Preferences:
        """Prefs the demo pipeline runs under: the live prefs but with a SANDBOXED
        auto-close policy (so decide() runs against the demo copy, not the real
        policy), EVERY-mode correlation (so each synthetic storyline event forms a
        cluster) and background scan ON (so alerts-role clusters auto-investigate).
        Read live so settings tweaks still apply during the demo. The REAL prefs are
        untouched (this is a copy)."""
        from ..config import CorrelationRule
        from ..constants import CorrelationMode

        prefs = self._get_prefs()
        every = CorrelationRule(mode=CorrelationMode.EVERY, n=1)
        return prefs.model_copy(update={
            "auto_close": sandbox_policy(prefs.auto_close),
            "default_correlation": every,
            "background_scan_enabled": True,
        })

    async def purge(self) -> None:
        """Hard-delete ALL demo data (cases/audit/usage/events) by dropping the demo
        ES client's in-memory docs. Idempotent; never raises."""
        try:
            self.es.docs.clear()
            self.es.alias_to_index.clear()
        except Exception:  # noqa: BLE001
            pass

    async def aclose(self) -> None:
        try:
            await self.gateway.aclose()
        except Exception:  # noqa: BLE001
            pass


class DemoSimulator:
    """The live demo ticker (only runs in ``mode == 'live'``).

    Mirrors a push-receiver task: a guarded loop that sleeps a jittered tick, emits a
    diurnal-scaled benign batch, and low-prob ignites a storyline → demo ingest. The
    RNG is seeded from ``demo.seed`` so a run is reproducible; the loop never raises
    (a bad tick is logged + skipped) and is cleanly cancellable on disable."""

    def __init__(
        self,
        stack: DemoStack,
        get_prefs: Callable[[], Preferences],
        *,
        seed: int,
        benign_per_tick: int = 4,
    ) -> None:
        self._stack = stack
        self._get_prefs = get_prefs
        self._rng = random.Random(seed ^ 0x71C)
        self._benign_per_tick = benign_per_tick
        self._task: asyncio.Task | None = None
        self._running = False
        from ..connectors.demo import DemoPullConnector

        self._source = DemoPullConnector(seed=seed)
        # A queue of storylines to ignite, cycled deterministically.
        self._story_queue = list(gen.STORYLINES)
        self._story_idx = 0

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._running = True
            self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._task = None

    async def tick_once(self) -> dict[str, int]:
        """One simulation tick (also callable directly from tests for determinism)."""
        prefs = self._get_prefs()
        demo = getattr(prefs, "demo", None)
        if demo is None or not demo.active:
            return {"benign": 0, "story": 0}
        now = to_millis(now_utc())
        weight = gen.diurnal_weight(now)
        n = max(1, round(self._benign_per_tick * weight))
        benign = self._source.benign_batch_raw(self._rng, now - now % gen._MS_PER_HOUR, n, prefs)
        ingested_story = 0
        events = list(benign)
        if self._rng.random() < float(demo.incident_rate) and self._story_queue:
            story = self._story_queue[self._story_idx % len(self._story_queue)]
            self._story_idx += 1
            events += self._source.storyline_raw(story, self._rng, now, prefs)
            ingested_story = 1
        await self._stack.ingest_service.ingest(
            events, self._stack._demo_prefs(),  # noqa: SLF001 — same module owner
            source_surface=SourceSurface.AUTOMATED_SCAN, source_id=gen.DEMO_SOURCE_ID,
        )
        return {"benign": len(benign), "story": ingested_story}

    async def _run(self) -> None:
        logger.info("Demo simulator started")
        while self._running:
            prefs = self._get_prefs()
            demo = getattr(prefs, "demo", None)
            base = float(getattr(demo, "tick_seconds", 10.0) or 10.0) if demo else 10.0
            jitter = float(getattr(demo, "tick_jitter", 0.3) or 0.0) if demo else 0.0
            delay = max(0.5, base * (1.0 + self._rng.uniform(-jitter, jitter)))
            try:
                if demo is not None and demo.mode == "live":
                    await self.tick_once()
            except Exception as exc:  # noqa: BLE001 — a bad tick must not kill the loop
                logger.warning("demo tick failed (loop continues): %s", exc)
            await asyncio.sleep(delay)
