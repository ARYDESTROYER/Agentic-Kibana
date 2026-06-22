export const PLUGIN_ID = 'tlsocAgenticTriage';
export const PLUGIN_NAME = 'TLSOC Agentic Triage';

// Base path of the in-Kibana proxy. The browser ALWAYS talks to the backend
// through this path so that the Kibana session / CSRF / TLS carry.
export const PROXY_BASE = '/api/tlsoc';

export interface Entity {
  type: 'ip' | 'user' | 'host';
  value: string;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface DiscoverSpec {
  query: string;
  language?: string;
  data_view_pattern?: string;
  time_from?: string;
  time_to?: string;
}

/**
 * Best-effort snapshot of the surface the analyst is looking at when they send a
 * chat message. Collected at send time and forwarded to the backend, which
 * fences any attacker-influenceable values (query/selection) as untrusted data.
 * Mirrors the backend `context` arg of `POST /api/tlsoc/chat`.
 */
export interface ChatContext {
  app?: string;
  url?: string;
  data_view?: string;
  query?: string;
  language?: string;
  time_range?: { from?: string; to?: string };
  case_id?: string;
  selection?: string;
  search_session?: string;
}

/** A single append-only verdict-trail entry on a Case (P1). */
export interface VerdictHistoryEntry {
  ts?: string;
  verdict?: string;
  confidence?: number;
  risk_score?: number;
  [k: string]: unknown;
}

/**
 * Deterministic "why was this triggered" explanation (Feature 3). Computed by
 * correlation in the backend and copied onto the Case. Mirrors
 * backend `models.TriggerReason`.
 */
export interface TriggerReason {
  rule_value?: string;
  mode?: string;
  n?: number;
  window_seconds?: number;
  group_by?: string;
  observed_count?: number;
  window_start?: number;
  window_end?: number;
  entity?: string;
  rule_values?: string[];
  severity_min?: number | null;
  severity_max?: number | null;
  sentence?: string;
}

export interface ChatTable {
  columns: string[];
  rows: Array<Array<string | number | null>>;
  truncated?: boolean;
}

export interface ChatResponse {
  answer: string;
  table?: ChatTable;
  query?: string;
  discover?: DiscoverSpec;
  case_id?: string;
  cost?: Record<string, unknown>;
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
  /** The first surface this case was ever created from; stable provenance (P1). */
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
  objection_window_expires_at?: string;
  title?: string;
  summary?: string;
  risk_breakdown?: Record<string, unknown>;
  token_cost?: number;
  error?: string;
  history?: unknown[];
  /** Append-only verdict trail across investigations (P1). */
  verdict_history?: VerdictHistoryEntry[];
  /** Deterministic "why was this triggered" explanation (Feature 3). */
  trigger_reason?: TriggerReason | null;
}

/** Model catalog for the per-role pickers — `GET /api/tlsoc/models`. */
export interface ModelsResponse {
  providers: Record<string, string[]>;
  configured: Record<string, boolean>;
}

/**
 * One agent-pipeline step from `GET /api/tlsoc/cases/{id}/trace` (C3-3). Projected
 * from `tlsoc-agent-audit`. `prompt_excerpt`/`tool_output_summary` carry fenced
 * UNTRUSTED log data — render them ONLY inside an `EuiCodeBlock`, never as markup.
 */
export interface TraceStep {
  ts?: string;
  actor?: string;
  action_type?: string;
  model?: string;
  query_text?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_output_summary?: string;
  result_summary?: string;
  prompt_excerpt?: string;
}

export interface TraceResponse {
  case_id: string;
  steps: TraceStep[];
  total: number;
}

/** A single match predicate in a rule-catalog entry (C3-1). */
export interface RuleMatch {
  field: string;
  op: 'equals' | 'prefix' | 'tag' | 'exists';
  value?: string | null;
}

/**
 * A config-driven detection rule (C3-1). Lives in `prefs.rule_catalog`. The
 * settings editor reads/writes these; `model_override` is a per-role model map
 * (C3-6b) keyed by role name.
 */
export interface RuleDefinition {
  name: string;
  enabled?: boolean;
  description?: string;
  match: RuleMatch;
  correlation?: Record<string, unknown> | null;
  model_override?: Record<string, { provider?: string; model?: string }>;
  priority?: number;
}

export interface SetupStatus {
  setup_complete: boolean;
  configured: Record<string, boolean>;
  data_view_pattern?: string;
  entity_mapping?: {
    source_ip_field?: string;
    user_field?: string;
    host_field?: string;
  };
  es_connected?: boolean;
}

export interface SettingsResponse {
  prefs: Record<string, any>;
  configured: Record<string, boolean>;
  read_only: boolean;
}

export interface UsageSummary {
  window_hours?: number;
  total_cost?: number;
  total_tokens?: number;
  today_cost?: number;
  call_count?: number;
  currency?: string;
  by_surface?: Array<{ key: string; cost: number; tokens: number; calls: number }>;
  by_model?: Array<{ key: string; cost: number; tokens: number; calls: number }>;
  by_role?: Array<{ key: string; cost: number; tokens: number; calls: number }>;
  cost_over_time?: Array<{ ts: string; cost: number }>;
  top_cost_drivers?: Array<Record<string, any>>;
}

export interface StandupResponse {
  enabled?: boolean;
  generated_at?: string;
  window_hours?: number;
  aggregate?: {
    total_events?: number;
    by_rule?: Array<{ key: string; count: number }>;
    by_severity?: Record<string, number> | Array<{ key: string; count: number }>;
    top_source_ips?: Array<{ key: string; count: number }>;
    top_users?: Array<{ key: string; count: number }>;
    top_hosts?: Array<{ key: string; count: number }>;
    unique_ips?: number;
    events_over_time?: Array<{ ts: string; count: number }>;
    // BUG-3: the backend returns `cases` as an OBJECT, not a number. Typing it as
    // a number caused React to try to render an object → the whole tab blanked.
    cases?: {
      opened?: number;
      by_status?: Record<string, number>;
      by_verdict?: Record<string, number>;
    };
  };
  summary?: string;
  cost?: Record<string, unknown>;
}
