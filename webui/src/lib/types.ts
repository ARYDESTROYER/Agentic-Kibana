/**
 * TypeScript mirrors of the backend data contracts (subset the UI consumes).
 *
 * These mirror, but do not import from, the Python Pydantic models in
 * `backend/app/`. Keep them additive-compatible: the backend forwards arbitrary
 * JSON so unknown fields are harmless. See:
 *   - `backend/app/connectors/base.py`  (ConnectorManifest / AuthField / ConnectionTest)
 *   - `backend/app/config.py`           (Preferences / SourceInstance)
 *   - `backend/app/api/routes.py`       (endpoint shapes)
 */

// --------------------------------------------------------------------------- //
// Auth (optional; the gate is a no-op when `enabled` is false).
// --------------------------------------------------------------------------- //
export interface AuthUser {
  username: string;
}

/** GET /api/auth/me — describes whether auth is on and the session state. */
export interface AuthMe {
  enabled: boolean;
  authenticated: boolean;
  user: AuthUser | null;
}

/** POST /api/auth/login (200). 401s surface as an ApiError with `detail`. */
export interface LoginResult {
  ok: boolean;
  user: AuthUser;
}

// --------------------------------------------------------------------------- //
// Agent personas + playbooks (read-only catalog surface).
// --------------------------------------------------------------------------- //
/** One specialist persona the router can specialise the investigator into. */
export interface AgentPersona {
  id: string;
  label: string;
  specialization: string;
  focus_tools: string[];
  keywords: string[];
}

export interface PersonasResponse {
  enabled: boolean;
  personas: AgentPersona[];
}

/** The match criteria that select a playbook for a cluster. */
export interface PlaybookMatch {
  rule_ids: string[];
  entity_types: string[];
  mitre: string[];
  min_event_count: number | null;
  any_tags: string[];
}

/** One plain-text runbook/playbook (mirrors the backend loader shape). */
export interface Playbook {
  id: string;
  name: string;
  version: string;
  description: string;
  priority: number;
  match: PlaybookMatch;
  suggested_tools: string[];
  rag_queries: string[];
}

export interface PlaybooksResponse {
  enabled: boolean;
  count: number;
  playbooks: Playbook[];
}

// --------------------------------------------------------------------------- //
// Connectors (the wizard renders forms dynamically from these).
// --------------------------------------------------------------------------- //
export type AuthFieldType =
  | 'string'
  | 'password'
  | 'number'
  | 'bool'
  | 'select'
  | 'textarea'
  | 'multiselect';

/** One input the wizard renders for a connector (mirrors `AuthField`). */
export interface AuthField {
  key: string;
  label: string;
  type: AuthFieldType;
  required?: boolean;
  secret?: boolean;
  default?: unknown;
  options?: string[] | null;
  help?: string;
  placeholder?: string;
  group?: string;
}

export type ConnectorCategory =
  | 'siem'
  | 'edr_xdr'
  | 'transport'
  | 'queue'
  | 'object_store'
  | 'file'
  | string;

/** Self-description of a connector (mirrors `ConnectorManifest`). */
export interface ConnectorManifest {
  source_type: string;
  display_name: string;
  category: ConnectorCategory;
  version?: string;
  description?: string;
  ingest_modes?: string[];
  query_language?: string;
  capabilities?: string[];
  auth_fields?: AuthField[];
  config_fields?: AuthField[];
  docs_url?: string | null;
  requires_pip?: string[];
}

export interface ConnectorsResponse {
  connectors: ConnectorManifest[];
}

/** Result of a 'Test connection' click (mirrors `ConnectionTest`). */
export interface ConnectionTest {
  ok: boolean;
  message?: string;
  sample_count?: number | null;
  detail?: Record<string, unknown>;
}

// --------------------------------------------------------------------------- //
// Sources (configured connector instances; mirrors `SourceInstance`).
// --------------------------------------------------------------------------- //
export interface SourceInstance {
  id: string;
  source_type: string;
  display_name?: string;
  enabled?: boolean;
  ingest_mode?: string;
  is_primary?: boolean;
  config?: Record<string, unknown>;
  configured_secrets?: string[];
  created_at?: string;
  updated_at?: string;
}

export interface SourcesResponse {
  sources: SourceInstance[];
}

/** Payload for POST /api/sources (mirrors `SourceUpsert`). */
export interface SourceUpsert {
  id: string;
  source_type: string;
  display_name?: string;
  enabled?: boolean;
  ingest_mode?: string | null;
  is_primary?: boolean;
  config?: Record<string, unknown>;
}

// --------------------------------------------------------------------------- //
// Setup wizard.
// --------------------------------------------------------------------------- //
/** Known secret keys the backend accepts on POST /api/setup/secrets. */
export interface SecretsUpdate {
  es_api_key?: string | null;
  es_mgmt_api_key?: string | null;
  es_url?: string | null;
  es_ca_cert?: string | null;
  openai_api_key?: string | null;
  anthropic_api_key?: string | null;
  abuseipdb_api_key?: string | null;
  virustotal_api_key?: string | null;
  embedding_api_key?: string | null;
}

export type ConfiguredStatus = Record<string, boolean>;

export interface SetupStatus {
  setup_complete: boolean;
  configured: ConfiguredStatus;
  data_view_pattern?: string;
  entity_mapping?: {
    source_ip_field?: string;
    user_field?: string;
    host_field?: string;
  };
  es_connected?: boolean;
}

export interface HealthResponse {
  status: string;
  version?: string;
  es_connected?: boolean;
  store_type?: string;
  setup_complete?: boolean;
}

// --------------------------------------------------------------------------- //
// Models (per-role pickers).
// --------------------------------------------------------------------------- //
export interface ModelsResponse {
  providers: Record<string, string[]>;
  configured: ConfiguredStatus;
}

/** Per-role model selection (mirrors `ModelConfig`). */
export interface ModelConfig {
  provider: string;
  model: string;
  temperature?: number;
  max_tokens?: number;
}

export const MODEL_ROLES = [
  'router',
  'investigator',
  'formatter',
  'standup',
  'chat',
  'overview',
  'embedding',
] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

// --------------------------------------------------------------------------- //
// Preferences (the subset the UI reads/writes; mirrors `Preferences`).
// --------------------------------------------------------------------------- //
export interface RiskWeights {
  volume?: number;
  velocity?: number;
  reputation?: number;
  diversity?: number;
  asset_criticality?: number;
}

export interface CorrelationRule {
  mode?: 'every' | 'threshold' | 'never';
  n?: number;
  window_seconds?: number;
  group_by?: 'ip' | 'user' | 'host';
}

export interface CapsConfig {
  max_tool_calls?: number;
  max_tokens?: number;
  timeout_seconds?: number;
  kill_switch?: boolean;
}

export interface EnrichmentConfig {
  enabled?: boolean;
  use_abuseipdb?: boolean;
  use_virustotal?: boolean;
  use_geoip?: boolean;
  cache_ttl_seconds?: number;
}

export interface RagConfig {
  enabled?: boolean;
  top_k?: number;
  min_score?: number;
  use_runbooks?: boolean;
  use_mitre?: boolean;
  use_resolved_cases?: boolean;
  use_suppression_rules?: boolean;
}

export interface StandupConfig {
  enabled?: boolean;
  window_hours?: number;
  interval_seconds?: number;
}

export interface FpAutoCloseConfig {
  enabled?: boolean;
  min_confidence?: number;
  max_risk_score?: number;
  objection_window_minutes?: number;
}

/**
 * The complete preferences object is large; we type the fields the UI touches
 * and keep an index signature so unknown fields round-trip unharmed.
 */
export interface Preferences {
  sources?: SourceInstance[];

  data_view_pattern?: string;
  time_field?: string;
  investigate_lookback?: string;

  source_ip_field?: string;
  user_field?: string;
  host_field?: string;

  rule_field?: string;
  rule_name_field?: string;
  severity_field?: string;
  severity_threshold?: number;
  in_scope_rules?: string[];
  excluded_rules?: string[];

  poll_interval_seconds?: number;
  poll_batch_size?: number;
  cold_start_lookback_minutes?: number;
  polling_enabled?: boolean;

  router_model?: ModelConfig;
  investigator_model?: ModelConfig;
  formatter_model?: ModelConfig;
  standup_model?: ModelConfig;
  chat_model?: ModelConfig;
  overview_model?: ModelConfig;
  embedding_model?: ModelConfig;

  fp_auto_close?: FpAutoCloseConfig;
  escalation_confidence?: number;
  critical_severity?: number;

  default_correlation?: CorrelationRule;
  risk_weights?: RiskWeights;

  caps?: CapsConfig;

  background_scan_enabled?: boolean;
  auto_forward_allowlist?: string[];

  enrichment?: EnrichmentConfig;
  rag?: RagConfig;
  standup?: StandupConfig;

  setup_complete?: boolean;
  read_only_settings_mode?: boolean;

  [key: string]: unknown;
}

export interface SettingsResponse {
  prefs: Preferences;
  configured: ConfiguredStatus;
  read_only: boolean;
}

// --------------------------------------------------------------------------- //
// Cases / analytics surfaces.
// --------------------------------------------------------------------------- //
export interface Entity {
  type: 'ip' | 'user' | 'host';
  value: string;
}

export interface Evidence {
  summary: string;
  event_ids?: string[];
  query?: string;
}

/** Analyst feedback / grading attached to a closed case (mirrors backend). */
export interface CaseFeedback {
  ts?: string;
  analyst?: string;
  /** Analyst's overall assessment of the agent verdict. */
  assessment?: 'agree' | 'partial' | 'disagree' | string;
  /** 0..1 quality scores. */
  accuracy?: number;
  reasoning_quality?: number;
  action_appropriateness?: number;
  /** The real-world outcome the analyst recorded. */
  actual_outcome?: string;
  /** Estimated analyst minutes saved by the agent. */
  time_saved_minutes?: number;
  comment?: string;
}

/** A free-form analyst comment on a case (mirrors backend). */
export interface CaseComment {
  ts?: string;
  author?: string;
  body?: string;
}

export interface Case {
  case_id: string;
  cluster_signature?: string;
  created_at?: string;
  updated_at?: string;
  source_surface?: string;
  origin_surface?: string;
  rule_ids?: string[];
  entity?: Entity;
  member_event_ids?: string[];
  risk_score?: number;
  verdict?: string;
  confidence?: number;
  evidence?: Evidence[];
  mitre?: string[];
  recommended_action?: string;
  reproduce_query?: string;
  status?: string;
  decision_by?: string;
  title?: string;
  summary?: string;
  token_cost?: number;
  error?: string;
  agent_persona?: string;
  playbook_id?: string;
  /** Analyst grading entries (POST /api/cases/{id}/feedback). */
  feedback?: CaseFeedback[];
  /** Free-form analyst tags (POST /api/cases/{id}/tags). */
  tags?: string[];
  /** Analyst comments thread (POST /api/cases/{id}/comment). */
  comments?: CaseComment[];
  /** Assigned analyst (POST /api/cases/{id}/assign). */
  assignee?: string;
  [key: string]: unknown;
}

export interface CasesResponse {
  cases: Case[];
  total: number;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatTable {
  columns: string[];
  rows: Array<Array<string | number | null>>;
  truncated?: boolean;
}

export interface ChatResponse {
  answer: string;
  table?: ChatTable | null;
  query?: string | null;
  discover?: Record<string, unknown> | null;
  case_id?: string | null;
  cost?: number;
}

export interface UsageSummary {
  window_hours?: number;
  total_cost?: number;
  total_tokens?: number;
  call_count?: number;
  currency?: string;
  today_cost?: number;
  by_surface?: Array<{ key: string; cost: number; tokens: number; calls: number }>;
  by_model?: Array<{ key: string; cost: number; tokens: number; calls: number }>;
  by_role?: Array<{ key: string; cost: number; tokens: number; calls: number }>;
  cost_over_time?: Array<{ ts: number; cost: number }>;
  top_cost_drivers?: Array<{ key: string; cost: number; tokens: number; calls: number }>;
  [key: string]: unknown;
}

export interface StandupResponse {
  enabled?: boolean;
  generated_at?: string;
  window_hours?: number;
  summary?: string;
  aggregate?: Record<string, unknown>;
  [key: string]: unknown;
}

// --------------------------------------------------------------------------- //
// Branding (GET/PUT /api/branding — PUBLIC; any field may be "").
// --------------------------------------------------------------------------- //
/** Operator-configurable white-label branding. Empty strings mean "use default". */
export interface Branding {
  /** Org / customer name shown as the wordmark. */
  org_name: string;
  /** Product name (e.g. "Triage console"). */
  product_name: string;
  /** Inline data: URL for a custom logo (renders in place of the glyph). */
  logo_data_url: string;
  /** Primary accent (#rrggbb) or "". */
  accent_color: string;
  /** Secondary accent (#rrggbb) or "". */
  accent_color2: string;
  /** Default theme; "system" follows the OS preference. */
  theme: 'dark' | 'light' | 'system' | '';
}

// --------------------------------------------------------------------------- //
// Metrics + feedback analytics (GET /api/metrics, GET /api/feedback/stats).
// --------------------------------------------------------------------------- //
/** Aggregate analyst-feedback quality stats (also nested in Metrics.feedback). */
export interface FeedbackStats {
  graded_cases: number;
  feedback_count: number;
  /** 0..1 fraction of cases where the analyst agreed with the agent. */
  agreement_rate: number;
  /** 0..1 averages of the per-case quality scores. */
  avg_accuracy: number;
  avg_reasoning_quality: number;
  avg_action_appropriateness: number;
  /** Total analyst minutes saved across graded cases. */
  time_saved_minutes: number;
  /** Distribution of recorded actual outcomes (label → count). */
  outcome_distribution: Record<string, number>;
  [key: string]: unknown;
}

/** One day's case count for the cases-per-day trend. */
export interface CasesPerDay {
  date: string;
  count: number;
}

/** Verdict-class breakdown returned by /api/metrics. */
export interface VerdictBreakdown {
  TRUE_POSITIVE: number;
  FALSE_POSITIVE: number;
  NEEDS_HUMAN: number;
  /** Unverdicted cases. */
  none: number;
  [key: string]: number;
}

/** GET /api/metrics — the analytics dashboard payload. */
export interface Metrics {
  total_cases: number;
  open_cases: number;
  needs_human_cases: number;
  closed_cases: number;
  by_status: Record<string, number>;
  by_verdict: VerdictBreakdown;
  persona_usage: Record<string, number>;
  playbook_usage: Record<string, number>;
  /** Mean normalised risk score (0..100). */
  avg_risk_score: number;
  /** Mean time-to-resolution in minutes. */
  mttr_minutes: number;
  resolved_count: number;
  cases_per_day: CasesPerDay[];
  feedback: FeedbackStats;
  /** Compact cost summary (shares the UsageSummary shape; fields optional). */
  cost: Partial<UsageSummary> & Record<string, unknown>;
  window_hours?: number;
  [key: string]: unknown;
}
