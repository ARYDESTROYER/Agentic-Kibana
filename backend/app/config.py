"""Configuration: secrets (env only) and preferences (UI-editable, sane defaults).

Two strictly separated tiers, per Section 8.5 of the spec:

* ``Secrets`` are read from the environment ONLY. They are never persisted to an
  Elasticsearch index, never returned to the plugin, never logged. The wizard may
  push secret *values* to the backend at runtime (kept in process memory); the UI
  only ever sees a boolean "configured" status.
* ``Preferences`` carry working defaults so the suite runs out of the box. They are
  persisted in the ``tlsoc-agent-config`` index and are fully editable through the
  settings UI. Non-secret preferences override env-supplied defaults.

This module defines the schema and the loader for the secret tier. The preference
*store* (load/save against Elasticsearch) lives in ``app.stores.config_store``.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from .constants import CorrelationMode, EntityType, IngestMode, SourceType
from .utils import dotted_get, iso_now

Provider = Literal["anthropic", "openai", "mock"]

# Bump this when the seeded rule catalog ships new built-in rules. Seeding only
# fires when the stored catalog is EMPTY or its ``rule_catalog_seed_version`` is
# missing/older than this value — operator-edited (non-empty) catalogs are NEVER
# overwritten (see ``maybe_seed_rule_catalog`` in ``app.stores.config_store``).
RULE_CATALOG_SEED_VERSION = 1


# --------------------------------------------------------------------------- #
# Secrets — environment only.
# --------------------------------------------------------------------------- #
class Secrets(BaseSettings):
    """All secrets + connection wiring. Loaded from environment / ``.env``.

    The two ES credentials are a deliberate security split (see COMPATIBILITY.md):

    * ``es_api_key`` — a READ-ONLY API key scoped to the log indices (e.g.
      ``all-logs-*``). The agent's ``es_query`` tool uses ONLY this. It can never
      write, and it can never touch anything outside the scoped log pattern. This
      is non-negotiable #1.
    * ``es_mgmt_api_key`` — a key scoped to ``tlsoc-agent-*`` with read/write/
      create_index, used solely by the backend to own its OWN bookkeeping indices
      (cases/audit/usage/config/cursor). It can never read the log surface.

    Neither is ``kibana_system`` nor the ``elastic`` superuser.
    """

    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore", case_sensitive=False
    )

    # --- Elasticsearch connection (TLS, container-name DNS) ---
    es_url: str = "https://elasticsearch:9200"
    es_ca_cert: str | None = None          # path to ./certs/ca/ca.crt mounted into the container
    es_verify_certs: bool = True
    es_request_timeout: int = 30

    # --- Two scoped ES credentials (NEVER the superuser) ---
    es_api_key: str | None = None          # read-only, scoped to log indices
    es_mgmt_api_key: str | None = None     # read/write/create, scoped to tlsoc-agent-*

    # --- LLM provider keys ---
    openai_api_key: str | None = None
    anthropic_api_key: str | None = None

    # --- Enrichment keys ---
    abuseipdb_api_key: str | None = None
    virustotal_api_key: str | None = None

    # --- Embeddings (defaults to the OpenAI key when blank) ---
    embedding_api_key: str | None = None

    # --- Caching ---
    redis_url: str = "redis://redis:6379/0"

    # --- Server ---
    backend_host: str = "0.0.0.0"
    backend_port: int = 8088
    log_level: str = "INFO"

    # When true the backend persists to Elasticsearch; when ES is unreachable it
    # automatically falls back to an in-memory store so the spine still runs.
    es_store_enabled: bool = True

    # --- State backend selector (Epoch A: vendor-agnostic OWN-state) ---
    # Where the suite's OWN bookkeeping (cases/audit/usage/config/cursor/RAG
    # vectors) is persisted. The agent's READ-ONLY log surface ALWAYS stays on the
    # connector layer (es_api_key) regardless of this setting — this only moves the
    # suite's management state off Elasticsearch so self-hosting needs no ES.
    #
    #   "elasticsearch" (DEFAULT) — today's path: own-state in tlsoc-agent-* indices.
    #   "sqlite"                  — own-state in a local SQLite file (zero services).
    #   "postgres"                — own-state in PostgreSQL (+pgvector for RAG).
    #
    # SQL backends use ``state_db_url`` (a SQLAlchemy async URL). asyncpg/pgvector
    # are imported LAZILY, only when state_backend == "postgres", so a deployment
    # (or the test env) without those packages still imports + runs on SQLite/ES.
    state_backend: Literal["elasticsearch", "postgres", "sqlite"] = "elasticsearch"
    # e.g. "postgresql+asyncpg://user:pass@host:5432/tlsoc" or
    # "sqlite+aiosqlite:///./tlsoc.db". When None and state_backend is a SQL
    # backend, a sane default is derived (sqlite → ./tlsoc.db).
    state_db_url: str | None = None

    # Per-source connector secrets (e.g. a webhook bearer token, a Splunk API
    # token), keyed by SourceInstance id → {field: value}. Lives in the SECRET
    # tier (in memory / env), NEVER in Preferences/the config index (#10). The UI
    # only ever sees the field NAMES via SourceInstance.configured_secrets.
    connector_secrets: dict[str, dict[str, str]] = Field(default_factory=dict)

    def source_secrets(self, source_id: str) -> dict[str, str]:
        """The configured secret values for one source (empty if none)."""
        return dict(self.connector_secrets.get(source_id, {}))

    def set_source_secret(self, source_id: str, field: str, value: str | None) -> None:
        """Set/clear one per-source secret field (value=None clears/revokes it)."""
        bucket = self.connector_secrets.setdefault(source_id, {})
        if value is None or value == "":
            bucket.pop(field, None)
        else:
            bucket[field] = value
        if not bucket:
            self.connector_secrets.pop(source_id, None)

    def provider_key(self, provider: Provider) -> str | None:
        if provider == "openai":
            return self.openai_api_key
        if provider == "anthropic":
            return self.anthropic_api_key
        return "mock"  # the mock provider needs no key

    def embedding_key(self) -> str | None:
        return self.embedding_api_key or self.openai_api_key

    def configured_status(self) -> dict[str, bool]:
        """Boolean-only view for the settings UI. NEVER returns values."""
        return {
            "es_api_key": bool(self.es_api_key),
            "es_mgmt_api_key": bool(self.es_mgmt_api_key),
            "openai_api_key": bool(self.openai_api_key),
            "anthropic_api_key": bool(self.anthropic_api_key),
            "abuseipdb_api_key": bool(self.abuseipdb_api_key),
            "virustotal_api_key": bool(self.virustotal_api_key),
            "embedding_api_key": bool(self.embedding_key()),
        }


# --------------------------------------------------------------------------- #
# Preferences — UI-editable, persisted in tlsoc-agent-config.
# --------------------------------------------------------------------------- #
class ModelConfig(BaseModel):
    """Per-role model selection. Routed through the single gateway."""

    provider: Provider = "anthropic"
    model: str = "claude-sonnet-4-6"
    temperature: float = 0.1
    max_tokens: int = 1500


class CorrelationRule(BaseModel):
    """Per-rule correlation entry (Section 6.2)."""

    mode: CorrelationMode = CorrelationMode.THRESHOLD
    n: int = Field(default=5, ge=1)
    window_seconds: int = Field(default=120, ge=1)
    group_by: EntityType = EntityType.IP


class RuleMatch(BaseModel):
    """A single field predicate used to classify a raw log into a detection rule.

    ``field`` is a dotted path read with the same tolerant ``dotted_get`` the rest
    of the suite uses (handles nested objects AND flattened keys). Operators:

    * ``equals``  — ``str(value-at-field) == value``
    * ``prefix``  — ``str(value-at-field).startswith(value)``  (e.g. ModSec rule.id "941…")
    * ``tag``     — ``value`` is a member of the field's list/array (e.g. rule.tags)
    * ``exists``  — the field is present and non-empty
    """

    field: str
    op: Literal["equals", "prefix", "tag", "exists"]
    value: str | None = None

    def matches(self, src: dict[str, Any]) -> bool:
        found = dotted_get(src, self.field)
        if self.op == "exists":
            if found is None:
                return False
            if isinstance(found, (list, tuple, set, dict, str)):
                return len(found) > 0
            return True
        if self.op == "tag":
            if self.value is None:
                return False
            if isinstance(found, (list, tuple, set)):
                return self.value in {str(x) for x in found}
            return str(found) == self.value if found is not None else False
        if found is None or self.value is None:
            return False
        if self.op == "equals":
            return str(found) == self.value
        if self.op == "prefix":
            return str(found).startswith(self.value)
        return False


class RuleDefinition(BaseModel):
    """A config-driven, pre-baked-but-editable detection rule (C3-1).

    Each definition classifies a raw event (via ``match``) into a named rule, can
    carry its own ``correlation`` override and per-role ``model_override`` (C3-6b),
    and is evaluated in ascending ``priority`` (then list order) so ModSec
    sub-rules (lower priority) win over the generic ``modsec_audit_log`` rule."""

    # ``model_override`` collides with Pydantic's protected ``model_`` namespace;
    # disable the guard (this is plain data, not a Pydantic config attribute).
    model_config = {"protected_namespaces": ()}

    name: str
    enabled: bool = True
    description: str = ""
    match: RuleMatch
    correlation: CorrelationRule | None = None
    model_override: dict[str, ModelConfig] = Field(default_factory=dict)
    priority: int = 100


class RiskWeights(BaseModel):
    """Weights for the deterministic risk score (Section 6.2). Sum need not be 1;
    the scorer normalises to 0-100."""

    volume: float = 0.25
    velocity: float = 0.20
    reputation: float = 0.30
    diversity: float = 0.15
    asset_criticality: float = 0.10


class CapsConfig(BaseModel):
    """Per-case caps / kill switches (Section 6.3 #4)."""

    max_tool_calls: int = 8
    max_tokens: int = 20000
    timeout_seconds: int = 120
    kill_switch: bool = False  # global emergency stop for all investigations


class FpAutoCloseConfig(BaseModel):
    """Strict conditions under which a FALSE_POSITIVE may auto-close (Section 6.4).

    Disabled by default. A TRUE_POSITIVE can NEVER auto-close — enforced in code.
    """

    enabled: bool = False
    min_confidence: float = 0.95
    max_risk_score: float = 30.0
    objection_window_minutes: int = 60


class EnrichmentConfig(BaseModel):
    enabled: bool = True
    use_abuseipdb: bool = True
    use_virustotal: bool = True
    use_geoip: bool = True
    cache_ttl_seconds: int = 21600  # 6h — protects tight free-tier limits


class RagConfig(BaseModel):
    enabled: bool = True
    top_k: int = 4
    # Minimum cosine similarity a retrieved chunk must clear to be returned.
    # Drops weakly-related noise before it reaches a prompt.
    min_score: float = 0.2
    use_runbooks: bool = True
    use_mitre: bool = True
    use_resolved_cases: bool = True
    use_suppression_rules: bool = True
    # Hybrid retrieval (MemPalace-inspired "drawer-floor-first"): the vector search
    # is the floor; survivors that clear ``min_score`` are re-ranked by a convex
    # blend of vector similarity and a dependency-free BM25 lexical score, which
    # sharply improves recall on IOC/log/rule text that embeds as noise. ``min_score``
    # still gates on the raw vector score, so disabling hybrid is exact prior behaviour.
    hybrid: bool = True
    vector_weight: float = 0.6
    bm25_weight: float = 0.4
    hybrid_overfetch: int = 4  # candidate pool = top_k * this, before re-rank


class PersonaConfig(BaseModel):
    """Multi-agent investigator roster (Vigil-inspired). When ``enabled`` the
    cluster is routed to a specialized persona (identity/web/recon/malware/threat-
    intel) deterministically; the generalist is used otherwise. ``overrides`` pins
    a specific persona id for a given rule name (operator control). Disabling this
    reverts to the single generalist investigator — byte-for-byte the old behaviour
    aside from the (empty) persona addendum."""

    enabled: bool = True
    overrides: dict[str, str] = Field(default_factory=dict)  # rule name -> persona id


class RunbookConfig(BaseModel):
    """Plain-text runbooks (Vigil's "your playbooks are plain-text files" pillar).

    Runbooks ship as Markdown files under ``backend/app/runbooks/`` and are (a) the
    source of the RAG ``runbook`` corpus when ``rag.use_runbooks`` is on and (b)
    injected as TRUSTED operator guidance into the investigator prompt for the
    best-matching cluster when ``inject`` is on. Disabling falls back to the
    in-code seed runbooks and no direct injection."""

    enabled: bool = True
    inject: bool = True


class TraceConfig(BaseModel):
    """Agent-pipeline trace surfacing (C3-3). ``include_prompts`` lets an operator
    hide raw prompt excerpts (which carry fenced untrusted log data) from the
    case-detail trace timeline."""

    include_prompts: bool = True


class StandupConfig(BaseModel):
    enabled: bool = True
    window_hours: int = 24
    interval_seconds: int = 86400  # run cadence for the in-process scheduler


class SuppressionRule(BaseModel):
    """A field==value suppression. Matching events are dropped, not investigated."""

    field: str
    value: str
    reason: str = ""


class AssetNetwork(BaseModel):
    """An internal-asset network: every IP inside ``cidr`` carries ``criticality``
    in the deterministic risk score's asset_criticality component (Section 6.2)."""

    cidr: str
    criticality: float = Field(default=0.0, ge=0.0, le=100.0)


class SourceInstance(BaseModel):
    """One configured log source (a connector instance).

    This is what makes the suite multi-source: an operator adds N sources (an
    Elasticsearch, a Splunk, a Wazuh, a webhook, …) via the first-run wizard, each
    backed by a connector (``backend/app/connectors/``). ``config`` holds the
    connector's NON-secret settings (host, index/topic, entity field mappings,
    bind port, …); secret VALUES never live here — only the names of the secret
    fields that have been configured (``configured_secrets``). Secret values live
    in the secret tier keyed ``<id>.<field>`` and the UI only ever sees
    ``configured ✓`` (non-negotiable #10).

    An empty ``Preferences.sources`` preserves today's behaviour byte-for-byte:
    the single implicit Elasticsearch source wired from ``Secrets``.
    """

    # ``source_type`` etc. are plain data, not Pydantic config — disable the guard.
    model_config = {"protected_namespaces": ()}

    id: str
    source_type: SourceType
    display_name: str = ""
    enabled: bool = True
    ingest_mode: IngestMode = IngestMode.PULL
    # The primary log surface the agent's es_query tool + poller read from. Exactly
    # one enabled source should be primary; ``primary_source`` falls back gracefully.
    is_primary: bool = False
    config: dict[str, Any] = Field(default_factory=dict)        # non-secret connector config
    configured_secrets: list[str] = Field(default_factory=list)  # secret field names set (not values)
    created_at: str = Field(default_factory=iso_now)
    updated_at: str = Field(default_factory=iso_now)


class Preferences(BaseModel):
    """The complete UI-editable configuration. Every field has a working default."""

    # --- Configured log sources (vendor-agnostic ingest). Empty == the legacy
    # single implicit Elasticsearch source from Secrets (full back-compat). ---
    sources: list[SourceInstance] = Field(default_factory=list)

    # --- Data scope (Section 5.2) ---
    data_view_pattern: str = "all-logs-*"
    time_field: str = "@timestamp"

    # --- Manual investigate (Surface 2) ---
    # Starting lookback window for a manual entity investigation. If the configured
    # window yields zero events the investigate path auto-widens through a ladder
    # (this window -> now-7d -> now-30d -> now-1y) before giving up, so an entity
    # whose only activity is older than the default window still resolves.
    investigate_lookback: str = "now-24h"

    # --- Entity field mapping (Section 5.3) ---
    source_ip_field: str = "source.ip"
    user_field: str = "user.name"
    host_field: str = "host.name"

    # --- Rule / severity identification (upstream emits heterogeneous fields) ---
    rule_field: str = "event.module"        # per-event rule identity (always present upstream)
    rule_name_field: str = "rule.name"
    severity_field: str = "event.severity"
    severity_threshold: float = 0.0         # min numeric severity in scope
    in_scope_rules: list[str] = Field(default_factory=list)   # empty == all rules
    excluded_rules: list[str] = Field(default_factory=list)

    # --- Polling (Section 6.1) ---
    poll_interval_seconds: int = 30
    poll_batch_size: int = 500
    cold_start_lookback_minutes: int = 60
    polling_enabled: bool = True

    # --- Models per role (Section 6.4) ---
    router_model: ModelConfig = Field(
        default_factory=lambda: ModelConfig(model="claude-haiku-4-5-20251001", max_tokens=600)
    )
    investigator_model: ModelConfig = Field(
        default_factory=lambda: ModelConfig(model="claude-sonnet-4-6", max_tokens=2000)
    )
    formatter_model: ModelConfig = Field(
        default_factory=lambda: ModelConfig(model="claude-haiku-4-5-20251001", max_tokens=1200)
    )
    standup_model: ModelConfig = Field(
        default_factory=lambda: ModelConfig(model="claude-haiku-4-5-20251001", max_tokens=1200)
    )
    chat_model: ModelConfig = Field(
        default_factory=lambda: ModelConfig(model="claude-haiku-4-5-20251001", max_tokens=1500)
    )
    # Single-event AI overview (Feature 2): default to the cheap model.
    overview_model: ModelConfig = Field(
        default_factory=lambda: ModelConfig(model="claude-haiku-4-5-20251001", max_tokens=900)
    )
    embedding_model: ModelConfig = Field(
        default_factory=lambda: ModelConfig(provider="openai", model="text-embedding-3-small")
    )

    # --- Decision thresholds (Section 8.5) ---
    fp_auto_close: FpAutoCloseConfig = Field(default_factory=FpAutoCloseConfig)
    escalation_confidence: float = 0.6      # >= this on TRUE_POSITIVE = high-priority human
    critical_severity: float = 7.0

    # --- Rule catalog (C3-1): config-driven, pre-baked-but-editable detection
    # rules incl. ModSec sub-rules. Seeded on first run only (see
    # ``rule_catalog_seed_version``); an empty catalog preserves today's single
    # ``rule_field`` behaviour byte-for-byte. ---
    rule_catalog: list[RuleDefinition] = Field(default_factory=list)
    # Tracks which seed version produced the built-in rules; lets seeding be a
    # no-op once current and NEVER clobber an operator-edited (non-empty) catalog.
    rule_catalog_seed_version: int = 0
    # --- Per-rule model selection (C3-6b): keyed by rule name. Lower precedence
    # than a matching RuleDefinition.model_override, higher than model_for(). ---
    rule_model_override: dict[str, ModelConfig] = Field(default_factory=dict)

    # --- Correlation (Section 6.2) ---
    default_correlation: CorrelationRule = Field(default_factory=CorrelationRule)
    correlation_rules: dict[str, CorrelationRule] = Field(default_factory=dict)
    risk_weights: RiskWeights = Field(default_factory=RiskWeights)
    asset_criticality: dict[str, float] = Field(default_factory=dict)  # entity value -> 0..100
    # CIDR-based internal-asset criticality (an IP inside a CIDR inherits its
    # criticality; max wins; falls back to the exact-value map above).
    asset_networks: list[AssetNetwork] = Field(default_factory=list)

    # --- Cost gate / caps (Section 6.3) ---
    caps: CapsConfig = Field(default_factory=CapsConfig)
    suppression_rules: list[SuppressionRule] = Field(default_factory=list)

    # --- Automated scans (Surface 3) ---
    background_scan_enabled: bool = False
    auto_forward_allowlist: list[str] = Field(default_factory=list)  # rule values that auto-scan

    # --- Enrichment / RAG / standup (Surfaces 3-4, Section 6.5/6.6) ---
    enrichment: EnrichmentConfig = Field(default_factory=EnrichmentConfig)
    rag: RagConfig = Field(default_factory=RagConfig)
    standup: StandupConfig = Field(default_factory=StandupConfig)
    trace: TraceConfig = Field(default_factory=TraceConfig)
    # Multi-agent roster + plain-text runbooks (Vigil-inspired). Both default ON and
    # degrade to prior behaviour when disabled.
    personas: PersonaConfig = Field(default_factory=PersonaConfig)
    runbooks: RunbookConfig = Field(default_factory=RunbookConfig)

    # --- Misc ---
    setup_complete: bool = False
    read_only_settings_mode: bool = False

    def correlation_for(self, rule_value: str) -> CorrelationRule:
        """Return the correlation rule for a given rule value, or the default."""
        return self.correlation_rules.get(rule_value, self.default_correlation)

    def primary_source(self) -> "SourceInstance | None":
        """The source the poller + es_query read from.

        Prefers the enabled source explicitly flagged ``is_primary``; else the
        first enabled source; else None (→ caller uses the legacy implicit
        Elasticsearch source from Secrets, preserving today's behaviour)."""
        primary = next((s for s in self.sources if s.enabled and s.is_primary), None)
        if primary is not None:
            return primary
        return next((s for s in self.sources if s.enabled), None)

    def match_rule(self, src: dict[str, Any]) -> RuleDefinition | None:
        """Classify a raw log ``_source`` against the rule catalog (C3-1).

        Evaluates ENABLED rules in ascending ``priority`` (ties broken by their
        order in the catalog) and returns the FIRST whose ``match`` matches, so a
        lower-priority ModSec sub-rule wins over the generic ``modsec_audit_log``
        rule. Returns ``None`` when nothing matches (caller falls back to today's
        single-``rule_field`` derivation)."""
        ordered = sorted(
            (rd for rd in self.rule_catalog if rd.enabled),
            key=lambda rd: rd.priority,
        )
        for rd in ordered:
            if rd.match.matches(src):
                return rd
        return None

    def correlation_for_def(self, rd: "RuleDefinition | None") -> CorrelationRule:
        """Resolve the correlation rule for a matched RuleDefinition (C3-1).

        Precedence mirrors how ``correlate`` resolves a bucket today:
        ``rd.correlation`` (inline override) → ``correlation_rules[rd.name]`` →
        ``default_correlation``. With no matched def, falls back to the default."""
        if rd is not None and rd.correlation is not None:
            return rd.correlation
        if rd is not None:
            return self.correlation_rules.get(rd.name, self.default_correlation)
        return self.default_correlation

    def model_for(self, role: str) -> ModelConfig:
        mapping = {
            "router": self.router_model,
            "investigator": self.investigator_model,
            "formatter": self.formatter_model,
            "standup": self.standup_model,
            "chat": self.chat_model,
            "overview": self.overview_model,
            "embedding": self.embedding_model,
        }
        return mapping.get(role, self.router_model)

    def maybe_seed_rule_catalog(self) -> bool:
        """Idempotently seed the built-in rule catalog IN PLACE (C3-1).

        Seeds ONLY when the stored catalog is empty OR its
        ``rule_catalog_seed_version`` is older than ``RULE_CATALOG_SEED_VERSION``.
        A non-empty, operator-edited catalog at the current seed version is NEVER
        overwritten. Returns True if the catalog was (re)seeded."""
        if self.rule_catalog and self.rule_catalog_seed_version >= RULE_CATALOG_SEED_VERSION:
            return False
        if self.rule_catalog:
            # Catalog already has operator content — bump the version marker so we
            # don't re-evaluate every boot, but DO NOT clobber their edits.
            self.rule_catalog_seed_version = RULE_CATALOG_SEED_VERSION
            return False
        self.rule_catalog = default_rule_catalog()
        self.rule_catalog_seed_version = RULE_CATALOG_SEED_VERSION
        return True

    def model_for_rule(self, role: str, rule_value: str | None) -> ModelConfig:
        """Per-rule model selection (C3-6b).

        Precedence: (1) a matching ``RuleDefinition.model_override[role]`` for
        ``rule_value``, (2) ``rule_model_override[rule_value]``, (3) the role
        default ``model_for(role)``. Identical to ``model_for(role)`` whenever no
        per-rule override exists, so behaviour is unchanged out of the box.

        ``role`` may be a ``Role`` enum or its string value (mirrors
        ``model_for``); we key everything on its string form."""
        role_str = str(getattr(role, "value", role))
        if rule_value:
            for rd in self.rule_catalog:
                if rd.name == rule_value and role_str in rd.model_override:
                    return rd.model_override[role_str]
            override = self.rule_model_override.get(rule_value)
            if override is not None:
                return override
        return self.model_for(role_str)


# --------------------------------------------------------------------------- #
# Built-in rule catalog (C3-1) — seeded on first run only.
# --------------------------------------------------------------------------- #
# The 13 real upstream detection rules, each identified by ``event.module``.
_REAL_EVENT_MODULES: tuple[str, ...] = (
    "mail_apache_access",
    "mail_auth",
    "mail_fim",
    "ml_stats",
    "modsec_audit_log",
    "openvas_report",
    "postfix",
    "roundcube_login",
    "suricata_mail",
    "waf-nginx-access",
    "waf_auth",
    "web_apache_access",
    "web_auth",
)

# ModSecurity sub-detections, keyed by the OWASP CRS ``rule.id`` prefix. These
# get a LOWER ``priority`` than the generic ``modsec_audit_log`` rule so a ModSec
# event classifies as its specific sub-rule first, falling back to the generic.
_MODSEC_SUBRULES: tuple[tuple[str, str, str], ...] = (
    ("modsec_xss", "941", "ModSecurity OWASP CRS XSS (rule.id 941xxx)"),
    ("modsec_sqli", "942", "ModSecurity OWASP CRS SQL injection (rule.id 942xxx)"),
    ("modsec_lfi", "930", "ModSecurity OWASP CRS LFI / file inclusion (rule.id 930xxx)"),
    ("modsec_rce", "932", "ModSecurity OWASP CRS RCE (rule.id 932xxx)"),
    ("modsec_scanner", "913", "ModSecurity OWASP CRS scanner detection (rule.id 913xxx)"),
)


def default_rule_catalog() -> list[RuleDefinition]:
    """Build the pre-baked rule catalog: the 13 ``event.module`` rules plus the 5
    ModSec sub-rules. ModSec sub-rules carry a lower ``priority`` (50) than the
    generic rules (100) so they classify first; nothing here is hardcoded beyond
    seeding these real detections — operators can edit/disable/extend freely."""
    rules: list[RuleDefinition] = [
        RuleDefinition(
            name=name,
            description=f"Upstream detection '{name}' (event.module).",
            match=RuleMatch(field="event.module", op="equals", value=name),
            priority=100,
        )
        for name in _REAL_EVENT_MODULES
    ]
    rules.extend(
        RuleDefinition(
            name=name,
            description=desc,
            match=RuleMatch(field="rule.id.keyword", op="prefix", value=prefix),
            priority=50,
        )
        for name, prefix, desc in _MODSEC_SUBRULES
    )
    return rules
