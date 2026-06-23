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
  /**
   * The access tier the probe verified: `read_only` (a correctly-scoped read-only
   * key) or `full` (cluster-monitor present). Absent for connectors that don't
   * distinguish.
   */
  mode?: 'read_only' | 'full' | string | null;
  /** Whether the tested key carries the `cluster:monitor` privilege. */
  cluster_monitor?: boolean | null;
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

/**
 * One normalised log row returned by GET /api/sources/{id}/logs.
 *
 * Every field is source-controlled and therefore UNTRUSTED: render `message` and
 * the entity columns as plain text, and `_raw` only inside a fenced code block —
 * never as markup.
 */
export interface SourceLogRow {
  id: string;
  ts: string;
  source_ip: string | null;
  user: string | null;
  host: string | null;
  rule: string | null;
  severity: number;
  message: string;
  _raw: Record<string, unknown>;
}

/**
 * GET /api/sources/{id}/logs — a window of recent events from a source.
 *
 * `mode:"buffer"` = a push source's in-memory live tail (the server ignores
 * from/to/query); `mode:"search"` = a scoped read against a pull source.
 */
export interface SourceLogsResponse {
  source_id: string;
  mode: 'buffer' | 'search' | string;
  count: number;
  total?: number;
  query?: string | null;
  logs: SourceLogRow[];
}

/** Query params for GET /api/sources/{id}/logs (all optional). */
export interface SourceLogsQuery {
  limit?: number;
  query?: string;
  from?: string;
  to?: string;
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

/**
 * Payload for POST /api/cases/{id}/action — a unified analyst action on a case
 * (the case-detail flyout drives this). `action` is open-ended (the backend
 * validates), but the common verbs are enumerated for editor help. The extra
 * fields are additive and only meaningful for some verbs (e.g. `resolution` on a
 * close, `assignee`/`priority` on an escalate).
 */
export interface CaseActionInput {
  action: 'close' | 'reopen' | 'escalate' | 'confirm_fp' | 'acknowledge' | string;
  note?: string;
  /** close / confirm_fp: why the case was resolved that way. */
  resolution?: string;
  /** escalate: the analyst/team to escalate to. */
  assignee?: string;
  /** escalate: low | medium | high | critical. */
  priority?: string;
  /** Optional follow-up tags to attach as part of the action. */
  tags?: string[];
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

/**
 * A memory mutation the chat engine performed on this turn (additive). The agent
 * may "remember"/"forget" facts conversationally; the UI surfaces what changed.
 */
export interface ChatMemoryAction {
  /** The operation the chat engine applied to operator memory. */
  op: 'add' | 'update' | 'delete' | string;
  /** The memory text added/updated (when applicable). */
  text?: string;
  /** Affected memory entry ids (when applicable). */
  ids?: string[];
}

/** A memory the chat engine suggests the operator save (additive; non-binding). */
export interface ChatMemorySuggestion {
  text: string;
  reason?: string;
}

export interface ChatResponse {
  answer: string;
  table?: ChatTable | null;
  query?: string | null;
  discover?: Record<string, unknown> | null;
  case_id?: string | null;
  cost?: number;
  /** A memory mutation the agent performed on this turn (additive). */
  memory_action?: ChatMemoryAction | null;
  /** A memory the agent suggests the operator save (additive). */
  memory_suggestion?: ChatMemorySuggestion | null;
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

// --------------------------------------------------------------------------- //
// Knowledge / RAG corpus management (GET/POST/DELETE /api/rag/*).
// --------------------------------------------------------------------------- //
/** One retrieved chunk (a search hit or a document's constituent chunk). */
export interface RagChunk {
  /** The chunk text (UNTRUSTED — render fenced, never as markup). */
  text: string;
  /** The source corpus the chunk came from (e.g. "runbook", "case", "import"). */
  source: string;
  /** Relevance score (present on search hits; absent for raw document chunks). */
  score?: number;
  /** This chunk's index within its parent document (present on document chunks). */
  chunk_index?: number;
  /** Arbitrary per-chunk metadata the backend attached. */
  metadata?: Record<string, unknown>;
}

/** A document indexed into the RAG corpus (GET /api/rag/documents). */
export interface RagDocument {
  document_id: string;
  title: string;
  source: string;
  chunk_count: number;
  embedding_model?: string;
  dim?: number;
  added_at?: string;
  tags?: string[];
  /** Populated only by GET /api/rag/documents/{id} (the drill-in view). */
  chunks?: RagChunk[];
  [key: string]: unknown;
}

/** GET /api/rag/documents — the corpus listing. */
export interface RagDocumentsResponse {
  documents: RagDocument[];
  count: number;
}

/** GET /api/rag/stats — corpus health header. */
export interface RagStats {
  total_chunks: number;
  by_source: Record<string, number>;
  embedding_model?: string;
  dim?: number;
  document_count: number;
  [key: string]: unknown;
}

/** POST /api/rag/import (201/200) — the indexed document summary. */
export interface RagImportResult {
  document_id: string;
  title: string;
  source: string;
  chunk_count: number;
  [key: string]: unknown;
}

/** GET /api/rag/search — what RAG would retrieve for a query. */
export interface RagSearchResponse {
  query: string;
  count: number;
  chunks: RagChunk[];
}

// --------------------------------------------------------------------------- //
// Operator memory (durable facts the agents always know) — /api/memory/*.
// --------------------------------------------------------------------------- //
/** One durable memory entry (mirrors the backend `MemoryEntry`). */
export interface MemoryEntry {
  id: string;
  /** The fact text (UNTRUSTED when agent-authored — render as plain text). */
  text: string;
  category?: string;
  tags?: string[];
  /** Who authored the memory — a human operator, or an agent (conversationally). */
  source: 'human' | 'agent' | string;
  author?: string;
  created_at?: string;
  updated_at?: string;
  /** Inactive entries are retained but not injected into prompts. */
  active: boolean;
  [key: string]: unknown;
}

/** GET /api/memory — the memory listing. */
export interface MemoryResponse {
  entries: MemoryEntry[];
  count: number;
}

// --------------------------------------------------------------------------- //
// Case decision rationale (GET /api/cases/{id}/rationale).
// --------------------------------------------------------------------------- //
/** A knowledge snippet the investigator drew on (RAG/runbook/playbook). */
export interface RationaleKnowledge {
  source: string;
  snippet: string;
}

/** A tool invocation the investigator ran during this case. */
export interface RationaleTool {
  tool: string;
  query?: string;
  summary?: string;
}

/** The playbook selected for the case + why. */
export interface RationalePlaybook {
  id: string;
  reason?: string;
}

/** Cached enrichment used in the decision (null when none applied). */
export interface RationaleEnrichment {
  reputation_score?: number;
  is_malicious?: boolean;
  country?: string;
  [key: string]: unknown;
}

/**
 * GET /api/cases/{id}/rationale — the explainable decision trace consumed by the
 * Cases surface (the case-detail engineer wires this; defined here as the shared
 * contract).
 */
export interface CaseRationale {
  case_id: string;
  verdict?: string;
  confidence?: number;
  status?: string;
  decision_by?: string;
  persona?: string;
  playbook?: RationalePlaybook | null;
  /** Operator memories the investigation drew on. */
  memory_used?: string[];
  knowledge?: RationaleKnowledge[];
  enrichment?: RationaleEnrichment | null;
  tools?: RationaleTool[];
  reasoning?: string;
  decision_rationale?: string;
  mitre?: string[];
  evidence?: Evidence[];
  [key: string]: unknown;
}
