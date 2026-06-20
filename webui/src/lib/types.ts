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
  by_surface?: Array<{ key: string; cost: number; tokens: number; calls: number }>;
  by_model?: Array<{ key: string; cost: number; tokens: number; calls: number }>;
  by_role?: Array<{ key: string; cost: number; tokens: number; calls: number }>;
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
