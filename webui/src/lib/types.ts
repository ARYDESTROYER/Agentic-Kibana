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
/** The six SOC operator roles (Wave 1 RBAC). Mirrors backend `UserRole`. */
export type UserRole =
  | 'super_admin'
  | 'soc_manager'
  | 'analyst_tier2'
  | 'analyst_tier1'
  | 'responder'
  | 'auditor';

export interface AuthUser {
  username: string;
  role?: UserRole | string;
  must_change_password?: boolean;
  /** Wave 2 (MFA): whether this account has a second factor enrolled. */
  mfa_enabled?: boolean;
  // ---- Round-2 Wave 2: self-service profile fields (all additive, defaulted). //
  // Every value here is operator/user-entered → render as PLAIN text (#9). The
  // backend `User.public()` projection NEVER includes password_hash/mfa_secret.
  /** Friendly name shown instead of the username (or ""). */
  display_name?: string;
  /** A short handle / nickname (or ""). */
  alias?: string;
  /** A bounded `data:image/(png|webp|jpeg)` URL for the user avatar (or ""). */
  avatar?: string;
  /** A secondary contact email (or ""). */
  alt_email?: string;
  /** IANA timezone id the user prefers (e.g. "Europe/London"), or "". */
  timezone?: string;
  /** BCP-47 locale tag (e.g. "en-US"), or "". */
  locale?: string;
}

/** GET /api/auth/me — describes whether auth is on and the session state. */
export interface AuthMe {
  authenticated: boolean;
  auth_enabled: boolean;
  user: AuthUser | null;
}

// --------------------------------------------------------------------------- //
// Account / profile self-service (Round-2 Wave 2) — GET/PUT /api/account/me.
// --------------------------------------------------------------------------- //
/**
 * GET /api/account/me — the signed-in user's own profile.
 *
 * `username` + `role` are read-only identity; the rest are self-editable. Every
 * value is user-entered → render as PLAIN text (#9). Secrets are NEVER present
 * (the backend `public()` projection excludes password_hash/mfa_secret/etc).
 *
 * `env_managed:true` means the principal is the env single-admin (not a stored
 * KV user): the profile is a read-only stub and PUT is rejected server-side.
 */
export interface AccountProfile {
  username: string;
  role?: UserRole | string;
  /** True for the env-provisioned single admin (no editable stored profile). */
  env_managed?: boolean;
  /** Whether this account has a TOTP second factor enrolled. */
  mfa_enabled?: boolean;
  display_name?: string;
  alias?: string;
  /** A bounded `data:image/...` avatar URL, or "". */
  avatar?: string;
  alt_email?: string;
  timezone?: string;
  locale?: string;
  created_at?: string;
  last_login_at?: string | null;
  [key: string]: unknown;
}

/**
 * Body for PUT /api/account/me — all fields optional (partial update). Omitted
 * fields are left untouched; an empty string clears a value.
 */
export interface AccountProfileBody {
  display_name?: string;
  alias?: string;
  alt_email?: string;
  timezone?: string;
  locale?: string;
}

// --------------------------------------------------------------------------- //
// Sessions & access policy (Round-2 Wave 3) — /api/sessions, /api/admin/sessions,
// /api/auth/refresh, /api/auth/reauth, /api/account/activity, prefs.session_policy.
//
// Every session field is request-derived (User-Agent / IP / geo) and therefore
// UNTRUSTED → render `ua_*`, `ip`, `ip_city`, `ip_country`, `location` as PLAIN
// text (#9). The backend NEVER returns the JWT, the refresh token, or any hash —
// only non-secret session metadata (#10).
// --------------------------------------------------------------------------- //
/**
 * One registered session (GET /api/sessions own; GET /api/admin/sessions all).
 *
 * `current:true` marks the session the caller is using right now ("This device").
 * All UA/IP/geo values are request-derived → render PLAIN, never as markup/links.
 */
export interface Session {
  /** Opaque 128-bit session id (the `sid` JWT claim). */
  sid: string;
  /** The owning account (admin console shows it; own listing omits/echoes it). */
  username?: string;
  /** True for the session the request was made from ("This device"). */
  current?: boolean;
  /** Whether the session has been revoked (admin listings may include these). */
  revoked?: boolean;
  /** ISO timestamps for the session lifecycle (all optional / best-effort). */
  created_at?: string;
  last_active_at?: string | null;
  last_authn_at?: string | null;
  absolute_expiry_at?: string | null;
  idle_expiry_at?: string | null;
  revoked_at?: string | null;
  /** Who revoked it (admin/self/system) + why — plain text. */
  revoked_by?: string | null;
  revoke_reason?: string | null;
  /** Request-derived network + geo (UNTRUSTED — render PLAIN). */
  ip?: string | null;
  ip_city?: string | null;
  ip_country?: string | null;
  /** Pre-composed "City, Country" label when the backend supplies one. */
  location?: string | null;
  /** Parsed User-Agent fields + the raw header (UNTRUSTED — render PLAIN). */
  ua_raw?: string | null;
  ua_browser?: string | null;
  ua_os?: string | null;
  /** The client kind (e.g. "web"/"api"/"cli") + the MFA method used at sign-in. */
  client_type?: string | null;
  mfa_method?: string | null;
  [key: string]: unknown;
}

/** GET /api/sessions and GET /api/admin/sessions — the session listing. */
export interface SessionsResponse {
  sessions: Session[];
  count?: number;
  [key: string]: unknown;
}

/**
 * Preferences.session_policy — the token/session lifecycle policy (admin-editable
 * under Settings > Security). All durations are in SECONDS. Defaulted + additive:
 * an absent block uses the backend's generous defaults (so existing sessions never
 * expire mid-run). Booleans gate the optional new-device / terminate notifications.
 */
export interface SessionPolicy {
  /** Short-lived access-token lifetime (seconds). */
  access_ttl?: number;
  /** Idle window — a session is revoked after this long without activity (seconds). */
  idle_timeout?: number;
  /** Hard cap on a session's total lifetime regardless of activity (seconds). */
  absolute_lifetime?: number;
  /** Refresh-token lifetime (seconds). */
  refresh_ttl?: number;
  /** Step-up "sudo" window — sensitive actions re-prompt after this long (seconds). */
  sudo_reauth_window?: number;
  /** Email the user when a session is created from a new device/location. */
  notify_on_new_device?: boolean;
  /** Email the user when one of their sessions is terminated. */
  notify_on_terminate?: boolean;
  [key: string]: unknown;
}

/**
 * One recent audit event for the signed-in user (GET /api/account/activity).
 * Every value is system/operator-derived → render PLAIN. The shape is loose (the
 * backend forwards audit docs verbatim); the well-known fields are documented.
 */
export interface ActivityEvent {
  /** Audit doc id (react key). */
  id?: string;
  /** When it happened (ISO). */
  ts?: string;
  /** The action type (e.g. "AUTH_EVENT" / "USER_MGMT" / "SESSION") — plain text. */
  action?: string;
  /** A short human-readable summary of the event (UNTRUSTED — plain text). */
  detail?: string;
  /** The actor (usually the user themselves) — plain text. */
  actor?: string;
  /** Request-derived network context for the event (UNTRUSTED — plain text). */
  ip?: string | null;
  ua_browser?: string | null;
  ua_os?: string | null;
  location?: string | null;
  [key: string]: unknown;
}

/** GET /api/account/activity — the user's recent audit trail. */
export interface ActivityResponse {
  events: ActivityEvent[];
  count?: number;
  [key: string]: unknown;
}

/**
 * POST /api/auth/refresh / POST /api/auth/reauth — the step-up / rotation result.
 * The new session cookie is set HttpOnly server-side; the body carries only
 * non-secret confirmation (no token is returned to JS).
 */
export interface ReauthResult {
  ok: boolean;
  /** Echoed user (post-reauth identity), when present. */
  user?: AuthUser;
  [key: string]: unknown;
}

/**
 * POST /api/auth/login (200). Two shapes (Wave 2):
 *   - normal:   { token, user }
 *   - MFA step: { requires_mfa:true, pending_token } (NO session yet — phase 2 at
 *               /api/auth/mfa/verify). 401s surface as an ApiError with `detail`.
 */
export interface LoginResult {
  token?: string;
  user?: AuthUser;
  /** Present (true) when the account needs a second factor before a session. */
  requires_mfa?: boolean;
  /** A short-lived half-auth token to exchange at /api/auth/mfa/verify. */
  pending_token?: string;
}

// --------------------------------------------------------------------------- //
// MFA (TOTP) — Wave 2 / F3.
// --------------------------------------------------------------------------- //
/** POST /api/auth/mfa/setup — the enrollment payload (shown ONCE). */
export interface MfaSetupResult {
  /** The Base32 TOTP secret (also encoded in `otpauth_uri`) — for manual entry. */
  secret: string;
  /** The `otpauth://totp/...` URI to render as a QR for authenticator apps. */
  otpauth_uri: string;
  /** 10 single-use recovery codes — show + let the operator save them now. */
  recovery_codes: string[];
}

// --------------------------------------------------------------------------- //
// SSO (OIDC) — Wave 2 / F4.
// --------------------------------------------------------------------------- //
/** One enabled SSO provider for the login screen (GET /api/auth/sso/providers). */
export interface SsoProviderPublic {
  id: string;
  type: 'google' | 'microsoft' | 'generic' | string;
  display_name: string;
}

export interface SsoProvidersResponse {
  providers: SsoProviderPublic[];
}

/** GET /api/auth/sso/authorize — the IdP redirect URL. */
export interface SsoAuthorizeResult {
  auth_url: string;
}

/** A configured SSO provider (the admin editor; mirrors backend `SSOProvider`). */
export interface SsoProviderConfig {
  id: string;
  type: 'google' | 'microsoft' | 'generic';
  display_name?: string;
  enabled?: boolean;
  client_id?: string;
  tenant?: string | null;
  discovery_url?: string | null;
  scopes?: string;
  allowed_domains?: string[];
  allowed_tenants?: string[];
  group_claim?: string | null;
  group_role_map?: Record<string, string>;
  auto_create_users?: boolean;
  default_role?: string;
}

/** Preferences.sso block (admin editor). */
export interface SsoConfig {
  enabled?: boolean;
  providers?: SsoProviderConfig[];
}

/** Preferences.mfa block (admin tuning; per-user enrollment is self-service). */
export interface MfaConfig {
  issuer?: string;
  digits?: number;
  period?: number;
  enforce_for_roles?: string[];
}

/** A managed multi-user account (GET/POST/PUT /api/users). Never carries a hash. */
export interface User {
  username: string;
  role: UserRole | string;
  active: boolean;
  must_change_password: boolean;
  created_at: string;
  last_login_at: string | null;
}

export interface UsersResponse {
  users: User[];
}

/** GET /api/roles — the role → resource → [actions] permission matrix for the UI. */
export interface RolesResponse {
  roles: string[];
  default_role: string;
  rbac_enabled: boolean;
  matrix: Record<string, Record<string, string[]>>;
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
  /**
   * Contextual help (F9). All operator/author-controlled (trusted) but rendered as
   * plain text / inside a code block, never as markup. `help_link` is a "learn more"
   * URL; `help_code` is an example snippet shown in `help_code_language`.
   */
  help_link?: string;
  help_code?: string;
  help_code_language?: string;
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
  /**
   * A concise "how to add this source" guide (F9), authored per connector. Markdown-
   * ish plain text (trusted) — rendered as plain text, never as live markup.
   */
  setup_help?: string;
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
/**
 * One index/data-view pattern a source reads, classified by the kind of records
 * it holds. The backend uses `role` to decide whether a pattern carries raw
 * `events` or pre-triaged `alerts`. `role` is open-ended (the backend validates),
 * but the two canonical values are enumerated for editor help.
 */
export interface IndexPattern {
  pattern: string;
  /**
   * The kind of records this feed carries. `alerts` = pre-triaged detections, every
   * one auto-investigated; `events` = raw logs, correlated then allowlist-gated;
   * `ignore` (Wave 6) = the feed is dropped (skipped at ingest entirely).
   */
  role: 'events' | 'alerts' | 'ignore' | string;
  /**
   * Per-pattern (sub-source) Auto-Correlate toggle (F6, legacy). Defaults TRUE so
   * today's behaviour is byte-identical. Historically drove BOTH correlation and
   * auto-forward; Wave 6 splits it into `correlate` + `auto_investigate` but keeps
   * this key in sync so the current backend preserves identical behaviour.
   */
  auto_correlate?: boolean;

  // --- Wave 6 per-feed customization (all optional; back-compat preserved) --- //
  /**
   * Whether this feed's events are correlated into clusters. Defaults TRUE; the
   * Wave-6 split of the overloaded `auto_correlate`.
   */
  correlate?: boolean;
  /**
   * Stable feed id. Absent on legacy/bare-string entries → the backend derives
   * `slug(pattern)`. Lets two feeds share a base pattern but keep distinct cursors.
   */
  id?: string;
  /** Operator-facing label for the feed (cosmetic; falls back to the pattern). */
  label?: string;
  /** Whether the feed is polled at all. Defaults TRUE. */
  enabled?: boolean;
  /**
   * A connector-native filter (e.g. an ES query_string) applied to this feed only.
   * Operator-authored + TRUSTED — never interpolated into an LLM prompt.
   */
  query?: string | null;
  /**
   * Per-feed field-mapping override. Merged over the source-level mapping
   * (`{...source.field_mappings_extra, ...feed.field_mapping}`).
   */
  field_mapping?: FieldMappingsExtra;
  /** Per-feed message-field override; falls back to the source-level message field. */
  message_field?: string | null;
  /**
   * OCSF severity_id floor (1-6). Events below it still register as a candidate +
   * live-tail (#4 — never dropped) but do NOT auto-forward. `null`/absent = no floor.
   */
  severity_floor?: number | null;
  /**
   * Split out of the overloaded `auto_correlate`: whether clusters from this feed
   * are auto-forwarded to AI investigation. `null`/absent → the role-derived default
   * (`true` for alerts, `auto_correlate` for events).
   */
  auto_investigate?: boolean | null;
  /** Per-feed poll interval override (seconds). `null`/absent = inherit the source. */
  poll_interval_seconds?: number | null;
}

/**
 * Per-source field-mapping overrides (F9). Each is the source-native field whose
 * value maps onto the canonical entity / message / severity / rule column. Blank
 * falls back to the global `Preferences` mapping.
 */
export interface FieldMappingsExtra {
  source_ip_field?: string;
  user_field?: string;
  host_field?: string;
  message_field?: string;
  severity_field?: string;
  rule_field?: string;
}

/**
 * How a source derives the primary entity for a cluster. `auto` lets the backend
 * pick from the mapped fields; the rest pin a specific dimension. Open-ended (the
 * backend accepts arbitrary strings) but the canonical values are enumerated.
 */
export type EntityStrategy = 'auto' | 'ip' | 'host' | 'user' | 'rule';

/**
 * The additive, optional `config` fields a source may carry (mirrors the backend
 * `SourceInstance.config` additions). `SourceInstance.config` stays a loose
 * `Record<string, unknown>` so unknown keys round-trip unharmed; this type
 * documents the well-known additions and can be intersected onto a config value
 * (e.g. `cfg as SourceConfigExtras`) when a surface reads them.
 */
export interface SourceConfigExtras {
  /**
   * Per-source feeds: index/data-view patterns + their role (events / alerts /
   * ignore) and per-feed Wave-6 customization. Kept under the legacy wire key
   * `index_patterns` so old configs round-trip unchanged.
   */
  index_patterns?: IndexPattern[];
  /** How this source picks the cluster's primary entity. */
  entity_strategy?: EntityStrategy | string;
  /** The field whose value is shown as the human-readable message column. */
  message_field?: string;
  /**
   * Per-source Auto-Correlate toggle (F6). Defaults TRUE. When false, this source's
   * clusters are NOT auto-forwarded to AI investigation (manual triage only) — they
   * still correlate into clusters.
   */
  auto_correlate?: boolean;
  /** Per-source field-mapping overrides (F9); falls back to global Preferences. */
  field_mappings_extra?: FieldMappingsExtra;
  [key: string]: unknown;
}

export interface SourceInstance {
  id: string;
  source_type: string;
  display_name?: string;
  enabled?: boolean;
  ingest_mode?: string;
  is_primary?: boolean;
  /**
   * Loose connector config. Unknown keys round-trip unharmed; the well-known
   * additive keys are documented by `SourceConfigExtras` (`index_patterns`,
   * `entity_strategy`, `message_field`).
   */
  config?: Record<string, unknown> & Partial<SourceConfigExtras>;
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
  // Wave-1 OOBE + auth fields (additive).
  needs_user?: boolean;
  auth_enabled?: boolean;
  rbac_enabled?: boolean;
  user_count?: number;
  seeded_default?: boolean;
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
  /** Inject imported threat-intel corpus (source="threat_context") as TRUSTED fenced context (F11). */
  use_threat_context?: boolean;
}

export interface StandupConfig {
  enabled?: boolean;
  window_hours?: number;
  interval_seconds?: number;
}

/**
 * Cross-source correlation (F6) — a GLOBAL, opt-in second pass that groups open
 * cases/clusters sharing an entity within a window across >= `min_sources` distinct
 * sources, surfaced as RELATED (never force-merged). Defaults disabled so the
 * 1:1 cluster→case signature is byte-identical out of the box.
 */
export interface CrossSourceCorrelationConfig {
  enabled?: boolean;
  time_window_seconds?: number;
  min_sources?: number;
  entity_keys?: string[];
}

export interface FpAutoCloseConfig {
  enabled?: boolean;
  min_confidence?: number;
  max_risk_score?: number;
  objection_window_minutes?: number;
}

// --------------------------------------------------------------------------- //
// Threshold automation (F10) — Preferences.threshold_automation.
//
// Rules match a case AFTER the deterministic CaseManager.decide()/apply() has run
// and saved. A matched rule can only TAG, attach a non-binding RECOMMENDATION,
// send a NOTIFICATION, QUEUE a playbook re-investigation (which itself re-runs
// decide() with new context), or create a HITL Proposal for an approval-required
// action. Automation NEVER sets status/disposition and NEVER auto-closes —
// NEEDS_HUMAN / escalated cases are always held for a human (code-enforced).
// --------------------------------------------------------------------------- //
/** The action a matched automation rule performs (all #3-safe). */
export type AutomationActionType =
  | 'tag'
  | 'recommend'
  | 'notify'
  | 'run_playbook'
  | 'request_approval'
  | string;

/**
 * The match criteria for an automation rule. All conditions are ANDed; an absent
 * condition is "any". `verdict`/`status`/`entity_type` are case-insensitive token
 * matches; `source_id`/`rule_name` are exact/contains matches (backend decides);
 * `min_risk`/`min_severity` are floors (0..100 / 0..n).
 */
export interface AutomationConditions {
  verdict?: string;
  min_risk?: number;
  min_severity?: number;
  status?: string;
  source_id?: string;
  rule_name?: string;
  entity_type?: string;
}

/** One operator-authored threshold-automation rule. */
export interface AutomationRule {
  id: string;
  enabled?: boolean;
  /** Lower runs first (priority order). Defaults to 100. */
  priority?: number;
  conditions?: AutomationConditions;
  action: AutomationActionType;
  /**
   * Action-specific payload (operator-authored, TRUSTED). Well-known keys:
   *   - tag:              { tags: string[] }
   *   - recommend:        { text: string }
   *   - notify:           { channel_id?: string }
   *   - run_playbook:     { playbook_id: string }
   *   - request_approval: { kind: string, ... }
   */
  payload?: Record<string, unknown>;
}

/** Preferences.threshold_automation — disabled by default (byte-identical OOTB). */
export interface ThresholdAutomationConfig {
  enabled?: boolean;
  rules?: AutomationRule[];
}

/** Preferences.threat_context — the threat-context panel + reusable-knowledge loop (F11). */
export interface ThreatContextConfig {
  enabled?: boolean;
  mitre_enabled?: boolean;
  reuse_resolved_cases?: boolean;
  /** A reputation score at/above this is treated as malicious (0..100). */
  ioc_malicious_threshold?: number;
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
  /** Global, opt-in cross-source correlation (F6; default disabled). */
  cross_source_correlation?: CrossSourceCorrelationConfig;
  risk_weights?: RiskWeights;

  caps?: CapsConfig;

  background_scan_enabled?: boolean;
  auto_forward_allowlist?: string[];

  enrichment?: EnrichmentConfig;
  rag?: RagConfig;
  standup?: StandupConfig;

  /** Security (Wave 2): MFA tuning + SSO/OIDC providers. */
  mfa?: MfaConfig;
  sso?: SsoConfig;

  /** Token/session lifecycle policy (Round-2 Wave 3; admin-editable). */
  session_policy?: SessionPolicy;

  /** Customisable human-facing case-ID nomenclature (F7). */
  case_id_format?: CaseIdFormatConfig;

  /** Outbound alerting / notifications (F5 / Wave 4; default disabled). */
  notifications?: NotificationConfig;

  /** Threshold automation (F10; default disabled). #3-safe, never auto-closes. */
  threshold_automation?: ThresholdAutomationConfig;
  /** Threat-context panel + reusable-knowledge loop (F11). */
  threat_context?: ThreatContextConfig;

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
// Notifications / alerting (F5 / Wave 4) — Preferences.notifications + endpoints.
// --------------------------------------------------------------------------- //
/** The kinds of delivery channel (mirrors backend `NotificationChannelConfig.type`). */
export type NotificationChannelType =
  | 'email'
  | 'resend'
  | 'ses'
  | 'slack'
  | 'teams'
  | 'webhook'
  | 'pagerduty'
  | 'telegram';

/** SMTP message security for an email channel. */
export type EmailSecurity = 'starttls' | 'ssl' | 'none';

/**
 * One configured notification channel. Channel-specific NON-secret fields live in
 * `config` (email: provider/host/port/security/username/from_addr/recipients/region;
 * slack/teams/webhook: url; telegram: chat_id; pagerduty: source_name). The SECRET
 * (SMTP password / API key / sensitive URL / token / routing key) is NEVER carried
 * here — only the configured field NAMES in `configured_secrets` (the UI shows ✓).
 */
export interface NotificationChannel {
  id: string;
  type: NotificationChannelType | string;
  enabled: boolean;
  name?: string;
  config?: Record<string, unknown>;
  /** The secret field names configured for this channel (names only, never values). */
  configured_secrets?: string[];
}

/** When notifications fire + the severity/risk floors (mirrors backend). */
export interface NotificationTriggers {
  on_case_created?: boolean;
  on_escalated?: boolean;
  on_true_positive?: boolean;
  on_needs_human?: boolean;
  on_closed?: boolean;
  /** 0..100 risk floor. */
  min_severity?: number;
  min_risk?: number;
}

/** Optional digest batching. */
export interface NotificationDigest {
  enabled?: boolean;
  interval_minutes?: number;
}

/**
 * The triggers a notification template can target (mirrors the backend renderer's
 * template set; the live PREVIEW endpoint accepts one of these keys via ?trigger=).
 */
export const NOTIFICATION_TEMPLATE_TRIGGERS = [
  'case.new',
  'case.escalation',
  'case.resolved',
  'digest.daily',
  'test',
] as const;
export type NotificationTemplateTrigger =
  (typeof NOTIFICATION_TEMPLATE_TRIGGERS)[number];

/**
 * A per-trigger template OVERRIDE. Any omitted field falls back to the built-in
 * default for that trigger. All three parts are operator-authored TRUSTED strings;
 * the SERVER-SIDE renderer (POST /api/notifications/preview) is authoritative for
 * escaping every interpolated case/log var (#9) — the UI never escapes locally.
 */
export interface NotificationTemplate {
  subject?: string;
  html?: string;
  text?: string;
}

/** Per-trigger overrides (mirrors backend `NotificationTemplates`). */
export type NotificationTemplates = Partial<
  Record<NotificationTemplateTrigger, NotificationTemplate>
>;

/** Preferences.notifications — the full alerting config (default disabled). */
export interface NotificationConfig {
  enabled?: boolean;
  channels?: NotificationChannel[];
  triggers?: NotificationTriggers;
  dedup_window_seconds?: number;
  rate_limit_per_hour?: number;
  digest?: NotificationDigest;
  default_recipients?: string[];
  base_url?: string;
  /** Operator-authored per-trigger template overrides (Wave 7). */
  templates?: NotificationTemplates;
}

/**
 * POST /api/notifications/preview?trigger= — the SERVER-rendered subject + HTML +
 * text for a sample case, with escaping already applied authoritatively. `variables`
 * (when returned) is the whitelisted variable reference list for the editor.
 */
export interface NotificationPreview {
  trigger: string;
  subject: string;
  html: string;
  text: string;
  /** The variable names available to this trigger's template (for the reference list). */
  variables?: string[];
  /** Whether an operator override is in effect (vs the built-in default). */
  is_override?: boolean;
}

/** One email provider preset (GET /api/notifications/providers). */
export interface EmailPreset {
  id: string;
  host: string;
  port: number;
  security: EmailSecurity | string;
  username_hint?: string;
  fixed_username?: string | null;
}

/** GET /api/notifications/providers — presets + the available channel types. */
export interface NotificationProviders {
  email_presets: EmailPreset[];
  channel_types: string[];
}

/** POST /api/notifications/test — a sample send to one channel. */
export interface NotificationTestResult {
  ok: boolean;
  detail?: string;
}

/** One per-channel send record (POST /api/cases/{id}/notify). */
export interface NotificationSendRecord {
  channel_id: string;
  type: string;
  ok: boolean;
  detail?: string;
  trigger?: string;
  ts?: string;
}

/** POST /api/cases/{id}/notify — the manual-notify result. */
export interface NotifyCaseResult {
  ok: boolean;
  sent: NotificationSendRecord[];
}

// --------------------------------------------------------------------------- //
// Demo mode (Round-2 Wave 5) — /api/demo/{status,enable,reset,disable}.
//
// First-class, REVERSIBLE tenant state (off | seeded | live). When the mode is not
// 'off' the backend serves cases/metrics/cost/etc. from a SEPARATE, throwaway
// in-memory store seeded with synthetic data, run through a deterministic $0 MOCK
// LLM and a SANDBOXED auto-close policy COPY — the real durable cursor, real stores
// and live policy are NEVER touched. Disabling stops the tick task and hard-deletes
// all demo data by `run_id`, returning the real state intact. Every demo case is
// tagged `['demo', …]` with a `case_id` starting `demo-`. All synthetic text is
// data (plain-rendered). All endpoints are admin-gated (settings:manage).
// --------------------------------------------------------------------------- //
/** The demo tenant mode. 'seeded' = static synthetic history; 'live' = also ticks. */
export type DemoMode = 'off' | 'seeded' | 'live';

/**
 * The operator-tunable demo knobs (mirrors backend `Preferences.demo`). Shown when
 * arming demo mode; defaulted so an absent block uses the backend defaults.
 */
export interface DemoConfig {
  /** Off / seeded (static synthetic history) / live (also simulates new incidents). */
  mode?: DemoMode;
  /** Deterministic seed — the same seed reproduces the same synthetic events. */
  seed?: number;
  /** How many days of trailing "old" synthetic history to pre-generate. */
  history_days?: number;
  /** Live-sim tick cadence in seconds (live mode only). */
  tick_seconds?: number;
  /** Jitter fraction applied to the tick interval (0..1). */
  tick_jitter?: number;
  /** Per-tick probability of igniting a queued attack storyline (0..1). */
  incident_rate?: number;
}

/**
 * GET /api/demo/status — the live demo tenant state. `mode!=='off'` means demo data
 * is active and the READ endpoints are serving from the isolated demo store (real
 * cases are hidden). `run_id` is the opaque id every demo row is tagged with (the
 * disable path hard-deletes by it). Counts are best-effort for the banner/badges.
 */
export interface DemoStatus {
  mode: DemoMode;
  /** True when `mode !== 'off'` (convenience; the UI may derive it itself). */
  active?: boolean;
  /** The current run's opaque id (present while active); demo rows are tagged with it. */
  run_id?: string | null;
  /** The seed the current/last run used. */
  seed?: number;
  history_days?: number;
  tick_seconds?: number;
  tick_jitter?: number;
  incident_rate?: number;
  /** When the current run was seeded (ISO). */
  started_at?: string | null;
  /** Best-effort count of synthetic cases in the demo store. */
  case_count?: number;
  /** Whether the live-sim tick task is running (live mode). */
  ticking?: boolean;
  [key: string]: unknown;
}

// --------------------------------------------------------------------------- //
// Pervasive customization (Round-2 Wave 7) — /api/prefs/*, /api/views/*,
// /api/terminology. Two-store model: ORG defaults on Preferences.customization
// (admin-only PUT) + PERSONAL prefs in the per-user UserPrefsStore (the 'default'
// bucket when auth is off). The cascade resolver merges ORG ← USER.
//
// EVERY terminology label / saved-view name / filter value here is user/operator-
// INFLUENCEABLE config → render as PLAIN text (#9), never markup, never an LLM
// prompt input.
// --------------------------------------------------------------------------- //
/** The user's colour-mode preference. 'system' follows the OS. */
export type ThemeMode = 'light' | 'dark' | 'system';

/**
 * A named, reusable list configuration (filters + sort + optional columns) for a
 * UI surface (e.g. 'cases'). `shared:true` marks an org-shared view (a user may
 * clone one into their personal set). All free-text is plain data (#9).
 */
export interface SavedView {
  id: string;
  name: string;
  /** The UI surface this view targets (e.g. 'cases'). */
  scope: string;
  /** Who created it ("" for a system/org view). */
  owner?: string;
  /** An org-shared view (surfaced to every user). */
  shared?: boolean;
  /** Free-form filter bag the frontend interprets. */
  filters?: Record<string, unknown>;
  /** Sort token, e.g. '-updated_at' (descending) / 'title'. */
  sort?: string;
  /** Pinned visible/ordered column ids, or null/undefined → surface default. */
  columns?: string[] | null;
  created_at?: string;
  updated_at?: string;
}

/** Per-table column layout: ordered ids, hidden ids, and a px-width map. */
export interface ColumnState {
  /** Ordered column ids (visible-or-not). */
  order?: string[];
  /** Column ids the user hid. */
  hidden?: string[];
  /** column id → pixel width. */
  widths?: Record<string, number>;
}

/** Terminology label-override map (e.g. `{ case: 'incident' }`). Plain data (#9). */
export type Terminology = Record<string, string>;

/** The caller's raw PERSONAL prefs bucket (GET /api/prefs/user). */
export interface UserPrefs {
  saved_views?: SavedView[];
  tables?: Record<string, ColumnState>;
  theme_mode?: ThemeMode;
  last_list_state?: Record<string, Record<string, unknown>>;
  pinned_view_ids?: string[];
  misc?: Record<string, unknown>;
  updated_at?: string;
}

/** The ORG customization defaults (GET/PUT /api/prefs/org; PUT admin-only). */
export interface OrgCustomization {
  terminology?: Terminology;
  default_saved_views?: SavedView[];
  default_theme?: ThemeMode;
  default_pinned_view_ids?: string[];
  [key: string]: unknown;
}

/**
 * The MERGED customization cascade (GET /api/prefs/effective) hydrated once by the
 * PrefsContext on mount. `org` echoes the org defaults so the UI can offer
 * "reset to org default" affordances. All plain data (#9).
 */
export interface EffectivePrefs {
  terminology: Terminology;
  theme_mode: ThemeMode;
  saved_views: SavedView[];
  pinned_view_ids: string[];
  tables: Record<string, ColumnState>;
  last_list_state: Record<string, Record<string, unknown>>;
  misc: Record<string, unknown>;
  org: {
    terminology: Terminology;
    default_theme: ThemeMode;
    default_saved_views: SavedView[];
    default_pinned_view_ids: string[];
  };
  [key: string]: unknown;
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

/**
 * Lifecycle status axis (F8). Keeps the original three values
 * (open/needs_human/closed) and adds the richer states. `needs_human` is a
 * retained, deprecated alias rendered "Open · awaiting analyst" in the UI. Unknown
 * values still render safely (the StatusBadge degrades gracefully).
 */
export type CaseStatus =
  | 'new'
  | 'open'
  | 'needs_human'
  | 'investigating'
  | 'escalated'
  | 'on_hold'
  | 'resolved'
  | 'closed'
  | string;

/** Investigative OUTCOME axis (F8), orthogonal to {@link CaseStatus}. */
export type Disposition =
  | 'true_positive'
  | 'false_positive'
  | 'benign'
  | 'suspicious'
  | 'duplicate'
  | 'undetermined'
  | string;

/** One append-only lifecycle transition on a case (status timeline). */
export interface StatusHistoryEntry {
  from_status?: string;
  to_status?: string;
  by?: string;
  at?: string;
  reason?: string;
}

export interface Case {
  case_id: string;
  /** Human-facing DISPLAY id (template-driven, F7). "" → fall back to case_id. */
  case_number?: string;
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
  status?: CaseStatus;
  /** Investigative outcome (F8). null/undefined → "Undetermined" in the UI. */
  disposition?: Disposition | null;
  /** Free-text reason for the current lifecycle state (why on hold / how resolved). */
  status_reason?: string;
  /** Escalation priority level (0 == not escalated). */
  escalation_level?: number;
  /** Append-only lifecycle transition trail (from→to, by, when, reason). */
  status_history?: StatusHistoryEntry[];
  decision_by?: string;
  title?: string;
  summary?: string;
  token_cost?: number;
  error?: string;
  agent_persona?: string;
  playbook_id?: string;
  /** The source instance this case originated from (additive; mirrors backend). */
  source_id?: string | null;
  /** Human-readable display name of the originating source (additive). */
  source_name?: string | null;
  /** The kind of the case's primary entity (e.g. "ip"/"user"/"host"/"rule"). */
  entity_type?: string | null;
  /** Analyst grading entries (POST /api/cases/{id}/feedback). */
  feedback?: CaseFeedback[];
  /** Free-form analyst tags (POST /api/cases/{id}/tags). */
  tags?: string[];
  /** Analyst comments thread (POST /api/cases/{id}/comment). */
  comments?: CaseComment[];
  /** Assigned analyst (POST /api/cases/{id}/assign). */
  assignee?: string;
  /** Outbound notification send records (F5; additive, optional). */
  notifications_sent?: NotificationSendRecord[];
  /**
   * Cross-source linkage (F6). `related_case_ids` are cases grouped with this one by
   * a shared entity within the cross-source window (RELATED, never merged);
   * `cross_source_cluster_id` is the stable id of that cross-source group;
   * `source_breakdown` maps source_id → contributing event/case count. All additive.
   */
  related_case_ids?: string[];
  cross_source_cluster_id?: string;
  source_breakdown?: Record<string, number>;
  /**
   * Threshold-automation audit trail (F10; additive). Each entry records a SAFE
   * action automation applied (tag/recommend/notify/queued playbook) or a Proposal
   * it drafted for approval — NEVER a status change. Values are operator/agent text
   * → render as plain text.
   */
  automation_actions?: AutomationActionRecord[];
  /** Knowledge sources the investigation drew on (F11; additive, UNTRUSTED text). */
  knowledge_used?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

/** One recorded threshold-automation action on a case (F10; audit). */
export interface AutomationActionRecord {
  /** The kind of action automation took. */
  action?: AutomationActionType;
  /** The rule id that matched. */
  rule_id?: string;
  /** When it ran (ISO). */
  at?: string;
  /** A human-readable note about what happened (UNTRUSTED-safe plain text). */
  detail?: string;
  /** For request_approval: the created Proposal id. */
  proposal_id?: string;
  [key: string]: unknown;
}

export interface CasesResponse {
  cases: Case[];
  total: number;
}

// --------------------------------------------------------------------------- //
// Global search (W7c) — GET /api/search?q= — powers the Cmd-K palette + top bar.
//
// Every title/label/entity value here is operator- or LOG-derived data →
// render as PLAIN text (#9), never as markup. No secrets are ever returned.
// --------------------------------------------------------------------------- //
/** One case hit from GET /api/search. */
export interface SearchCaseHit {
  type: 'case';
  id: string;
  case_number?: string;
  title?: string;
  status?: string;
  verdict?: string;
  entity?: string;
  source_name?: string;
}

/** One source hit from GET /api/search. */
export interface SearchSourceHit {
  type: 'source';
  id: string;
  label?: string;
  source_type?: string;
}

/**
 * One static nav target (a page or a Settings section) from GET /api/search.
 * `id` is a routable PageId; `type` distinguishes a top-level page from a
 * Settings sub-section (the palette routes both via the same navigate()).
 */
export interface SearchNavHit {
  type: 'page' | 'settings' | string;
  id: string;
  label: string;
}

/** GET /api/search — typed, bounded (cap 50) results for the command palette. */
export interface SearchResult {
  query: string;
  cases: SearchCaseHit[];
  sources: SearchSourceHit[];
  nav: SearchNavHit[];
}

// --------------------------------------------------------------------------- //
// Bulk case actions (W7c) — POST /api/cases/bulk.
//
// The SAME human-initiated lifecycle action as POST /api/cases/{id}/action,
// applied to N selected cases; each case is applied + AUDITED individually and is
// #3-safe (never an LLM auto-close, never decide()). RBAC-gated server-side
// (cases:close for close/resolve, cases:write otherwise). Partial-failure tolerant.
// --------------------------------------------------------------------------- //
/** One per-id outcome in a bulk action result. */
export interface BulkResultItem {
  id: string;
  ok: boolean;
  /** Present only when `ok` is false — the per-id failure reason (plain text). */
  error?: string;
}

/** POST /api/cases/bulk — the per-id outcome list. */
export interface BulkResult {
  results: BulkResultItem[];
}

// --------------------------------------------------------------------------- //
// Audit-log viewer (W7c) — GET /api/audit — read-only over the append-only audit
// (#2). Gated by audit:view server-side. EVERY field is system/operator/LOG-derived
// → render as PLAIN text (#9); `prompt_excerpt`/`tool_output_summary` carry fenced
// UNTRUSTED log data and render only inside a code block. No mutate path exists.
// --------------------------------------------------------------------------- //
/** One append-only audit record (mirrors backend `AuditDoc`). */
export interface AuditRecord {
  ts?: string;
  case_id?: string | null;
  surface?: string;
  actor?: string;
  action_type?: string;
  model?: string | null;
  prompt_excerpt?: string | null;
  query_text?: string | null;
  tool_name?: string | null;
  tool_input?: unknown;
  tool_output_summary?: string | null;
  result_summary?: string | null;
  [key: string]: unknown;
}

/** GET /api/audit — bounded, NEWEST-first list + total. */
export interface AuditResponse {
  records: AuditRecord[];
  total: number;
}

/** Query params for GET /api/audit (all optional; filters are ANDed). */
export interface AuditQuery {
  actor?: string;
  /** The audit `action_type` value (the wire param name is `action`). */
  action?: string;
  surface?: string;
  case_id?: string;
  /** ISO lower/upper time bounds (wire param names `from`/`to`). */
  from?: string;
  to?: string;
  limit?: number;
}

/**
 * GET /api/scans/notifications — how many automated-scan cases are new since the
 * caller's last-seen timestamp. Drives the "N new" pill on the Scans surface.
 */
export interface ScanNotifications {
  new_count: number;
  since?: string | null;
  now?: string | null;
}

/**
 * Navigation options threaded through `Navigate` (Shell.tsx) so deep-links/
 * drill-throughs can pre-seed a destination page's filters/tab. All fields
 * optional and additive.
 */
export type NavOpts = { caseId?: string; status?: string; window?: number; tab?: string };

/**
 * Payload for POST /api/cases/{id}/action — a unified analyst action on a case
 * (the case-detail flyout drives this). `action` is open-ended (the backend
 * validates), but the common verbs are enumerated for editor help. The extra
 * fields are additive and only meaningful for some verbs (e.g. `resolution` on a
 * close, `assignee`/`priority` on an escalate).
 */
export interface CaseActionInput {
  action:
    | 'close'
    | 'reopen'
    | 'escalate'
    | 'deescalate'
    | 'confirm_fp'
    | 'acknowledge'
    | 'hold'
    | 'resume'
    | 'resolve'
    | 'set_disposition'
    | 'set_status'
    | string;
  note?: string;
  /** Why (status_reason + status-timeline reason). */
  reason?: string;
  /** close / confirm_fp: why the case was resolved that way. */
  resolution?: string;
  /** escalate: the analyst/team to escalate to. */
  assignee?: string;
  /** escalate: low | medium | high | critical. */
  priority?: string;
  /** Optional follow-up tags to attach as part of the action. */
  tags?: string[];
  /** set_disposition: the investigative outcome to record. */
  disposition?: Disposition;
  /** set_status: the lifecycle status to move to. */
  status?: CaseStatus;
  /** escalate: priority level. */
  level?: number;
}

/** Response from POST /api/settings/case-id/preview (F7 live preview). */
export interface CaseIdPreview {
  samples: string[];
  valid: boolean;
  error?: string;
}

/** Preferences.case_id_format — customisable case-ID nomenclature (F7). */
export interface CaseIdFormatConfig {
  enabled: boolean;
  template: string;
  prefix: string;
  reset_period: 'none' | 'calendar_year' | 'fiscal_year' | 'fiscal_quarter';
  seq_start: number;
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
  /**
   * Optional provenance the chat engine may attach (additive; render only when
   * present). All values are UNTRUSTED — render as plain text / `EuiCodeBlock`.
   */
  tools?: RationaleTool[];
  knowledge?: RationaleKnowledge[];
  reasoning?: string;
  /** Inline citations the answer references (UNTRUSTED — plain text). */
  citations?: Array<{ n: number; source: string; snippet?: string; ref?: string }>;
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
  /** Inline data: URL for a custom browser-tab favicon, or "". */
  favicon_data_url: string;
  /** Primary accent (#rrggbb) or "". */
  accent_color: string;
  /** Secondary accent (#rrggbb) or "". */
  accent_color2: string;
  /** Default theme; "system" follows the OS preference. */
  theme: 'dark' | 'light' | 'system' | '';
  /** Welcome line shown beneath the login wordmark, or "". */
  login_subtitle: string;
  /** Footer / classification banner line, or "". */
  footer_text: string;
  /** "Docs & help" / support link target (http/https), or "". */
  support_url: string;
  /** Default colour mode for brand-new sessions (no stored user pref). */
  dark_mode_default: boolean;
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
  /** Disposition (investigative outcome) breakdown (F8). */
  by_disposition?: Record<string, number>;
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
// Approval queue — agent-drafted proposals (GET/POST /api/proposals/*).
// --------------------------------------------------------------------------- //
/** The kinds of recommendation the agent can draft for human approval. */
export type ProposalKind = 'suppression' | 'memory' | string;

/** The lifecycle state of a drafted proposal. */
export type ProposalStatus = 'pending' | 'approved' | 'rejected' | string;

/**
 * One agent-drafted recommendation awaiting human approval.
 *
 * Nothing here is applied automatically: a `suppression` rule only goes live, and
 * a `memory` fact is only saved, once a human approves it. `payload` is
 * kind-specific and SOURCE-INFLUENCED (it derives from log events), so every value
 * inside it — and `rationale` — is UNTRUSTED and must render as plain text /
 * `EuiCode`, never as markup.
 *
 * - `kind === 'suppression'` → `payload` carries `{ field, value, reason? }` (the
 *   candidate `field == value` rule).
 * - `kind === 'memory'` → `payload` carries `{ text, category? }` (the candidate
 *   durable fact).
 */
export interface Proposal {
  id: string;
  kind: ProposalKind;
  status: ProposalStatus;
  /** Kind-specific, source-influenced payload — render its values as plain text. */
  payload: Record<string, unknown>;
  /** Why the agent drafted this (UNTRUSTED — render as plain text). */
  rationale: string;
  /** The agent's confidence in the recommendation (0..1). */
  confidence: number;
  /** The case(s) that motivated this proposal. */
  source_case_ids: string[];
  created_by: string;
  created_at: string;
  decided_by?: string | null;
  decided_at?: string | null;
  expires_at?: string | null;
  [key: string]: unknown;
}

/** GET /api/proposals — the approval queue listing. */
export interface ProposalsResponse {
  proposals: Proposal[];
  count: number;
}

/** Well-known fields on a `suppression` proposal's `payload` (all UNTRUSTED). */
export interface SuppressionPayload {
  field?: string;
  value?: unknown;
  reason?: string;
  [key: string]: unknown;
}

/** Well-known fields on a `memory` proposal's `payload` (all UNTRUSTED). */
export interface MemoryPayload {
  text?: string;
  category?: string;
  [key: string]: unknown;
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

// --------------------------------------------------------------------------- //
// Threat-context panel (F11) — GET /api/cases/{id}/threat-context.
//
// Assembled per-case, parallel-fetched + fail-open per section: a missing /
// errored section degrades to an empty list, never errors the whole panel. EVERY
// field is intel/log-derived and UNTRUSTED — render as plain text / CodeBlock,
// never as markup, and never as live links beyond a known MITRE technique URL.
// --------------------------------------------------------------------------- //
/** One IOC's reputation lookup (AbuseIPDB / VirusTotal / GeoIP-derived). */
export interface IocReputation {
  /** The indicator value (UNTRUSTED — plain text). */
  indicator: string;
  /** The kind of indicator (ip / domain / hash / url / …). */
  type?: string;
  /** 0..100 reputation/abuse score, when available. */
  reputation_score?: number;
  /** Whether the score crosses the configured malicious threshold. */
  is_malicious?: boolean;
  /** Country / source label (UNTRUSTED — plain text). */
  country?: string;
  /** The enrichment source that produced this (e.g. "abuseipdb"). */
  source?: string;
  [key: string]: unknown;
}

/** One MITRE ATT&CK technique resolved from the bundled corpus. */
export interface MitreTechnique {
  /** The technique id, e.g. "T1110" or "T1110.001". */
  id: string;
  /** The technique name (from the curated corpus — TRUSTED). */
  name?: string;
  /** Tactic phase labels (e.g. "credential-access"). */
  tactics?: string[];
  /** Applicable platforms. */
  platforms?: string[];
  /** Canonical MITRE ATT&CK URL for the technique. */
  url?: string;
  /** Short description (from the corpus — TRUSTED). */
  description?: string;
  [key: string]: unknown;
}

/** A related case surfaced by the threat-context assembly (Wave 5 / F6 linkage). */
export interface ThreatContextRelatedCase {
  case_id: string;
  case_number?: string;
  /** UNTRUSTED — plain text. */
  title?: string;
  verdict?: string;
  status?: string;
  disposition?: Disposition | null;
  risk_score?: number;
  created_at?: string;
  /** Why it relates (shared entity / cross-source / resolved-case match). */
  reason?: string;
  [key: string]: unknown;
}

/** Asset / entity context for the case's primary entity. */
export interface ThreatContextAsset {
  /** The entity value (UNTRUSTED — plain text). */
  entity?: string;
  entity_type?: string;
  /** Operator-recorded criticality, when known. */
  criticality?: string;
  /** Free-form KV context (UNTRUSTED values — plain text). */
  attributes?: Record<string, unknown>;
  [key: string]: unknown;
}

/** GET /api/cases/{id}/threat-context — the assembled panel (all sections fail-open). */
export interface ThreatContextPanel {
  case_id?: string;
  /** A short threat summary banner (UNTRUSTED — plain text). */
  summary?: string;
  ioc_reputation?: IocReputation[];
  mitre_techniques?: MitreTechnique[];
  related_cases?: ThreatContextRelatedCase[];
  asset_context?: ThreatContextAsset | null;
  evidence?: Evidence[];
  generated_at?: string;
  /** Present + true when the feature is disabled in Preferences. */
  disabled?: boolean;
  [key: string]: unknown;
}
