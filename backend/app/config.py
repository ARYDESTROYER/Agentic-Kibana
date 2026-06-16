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

from typing import Literal

from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from .constants import CorrelationMode, EntityType

Provider = Literal["anthropic", "openai", "mock"]


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
    use_runbooks: bool = True
    use_mitre: bool = True
    use_resolved_cases: bool = True
    use_suppression_rules: bool = True


class StandupConfig(BaseModel):
    enabled: bool = True
    window_hours: int = 24
    interval_seconds: int = 86400  # run cadence for the in-process scheduler


class SuppressionRule(BaseModel):
    """A field==value suppression. Matching events are dropped, not investigated."""

    field: str
    value: str
    reason: str = ""


class Preferences(BaseModel):
    """The complete UI-editable configuration. Every field has a working default."""

    # --- Data scope (Section 5.2) ---
    data_view_pattern: str = "all-logs-*"
    time_field: str = "@timestamp"

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
    embedding_model: ModelConfig = Field(
        default_factory=lambda: ModelConfig(provider="openai", model="text-embedding-3-small")
    )

    # --- Decision thresholds (Section 8.5) ---
    fp_auto_close: FpAutoCloseConfig = Field(default_factory=FpAutoCloseConfig)
    escalation_confidence: float = 0.6      # >= this on TRUE_POSITIVE = high-priority human
    critical_severity: float = 7.0

    # --- Correlation (Section 6.2) ---
    default_correlation: CorrelationRule = Field(default_factory=CorrelationRule)
    correlation_rules: dict[str, CorrelationRule] = Field(default_factory=dict)
    risk_weights: RiskWeights = Field(default_factory=RiskWeights)
    asset_criticality: dict[str, float] = Field(default_factory=dict)  # entity value -> 0..100

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

    # --- Misc ---
    setup_complete: bool = False
    read_only_settings_mode: bool = False

    def correlation_for(self, rule_value: str) -> CorrelationRule:
        """Return the correlation rule for a given rule value, or the default."""
        return self.correlation_rules.get(rule_value, self.default_correlation)

    def model_for(self, role: str) -> ModelConfig:
        mapping = {
            "router": self.router_model,
            "investigator": self.investigator_model,
            "formatter": self.formatter_model,
            "standup": self.standup_model,
            "chat": self.chat_model,
            "embedding": self.embedding_model,
        }
        return mapping.get(role, self.router_model)
