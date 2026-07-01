/**
 * Typed fetch client for the standalone Agentic SOC web UI.
 *
 * Every call hits the FastAPI backend at `/api/...`. In dev, Vite proxies `/api`
 * to the backend (see vite.config.ts); in production the SPA is served from the
 * same origin as the backend (or behind a reverse proxy that forwards `/api`).
 *
 * Centralised error handling: any non-2xx response is turned into an `ApiError`
 * carrying the HTTP status and the backend's `detail` message, so every screen
 * can show a meaningful error state.
 */
import type {
  AccountProfile,
  AccountProfileBody,
  ActivityResponse,
  AuditQuery,
  AuditResponse,
  AuthMe,
  AutoClosePolicy,
  BaselineConfig,
  BatchConfig,
  Branding,
  BulkResult,
  CampaignConfig,
  Case,
  CaseActionInput,
  CaseIdPreview,
  CaseRationale,
  CasesResponse,
  CaseStatus,
  ChatResponse,
  ChatTurn,
  ColumnState,
  ConnectionTest,
  ConnectorManifest,
  ConnectorsResponse,
  DashboardLayout,
  DemoConfig,
  DemoStatus,
  EffectivePrefs,
  FeedbackStats,
  HealthResponse,
  LoginResult,
  MfaSetupResult,
  SsoAuthorizeResult,
  SsoProvidersResponse,
  MemoryEntry,
  MemoryResponse,
  Metrics,
  ModelsResponse,
  NotificationPreview,
  NotificationProviders,
  NotificationTemplate,
  NotificationTestResult,
  NotifyCaseResult,
  OrgCustomization,
  PersonasResponse,
  PlaybooksResponse,
  Preferences,
  RuleDefinition,
  SavedView,
  Proposal,
  ProposalsResponse,
  RagDocument,
  RagDocumentsResponse,
  RagImportResult,
  RagSearchResponse,
  RagStats,
  ReauthResult,
  RolesResponse,
  SessionsResponse,
  ScanNotifications,
  SearchResult,
  SecretsUpdate,
  SettingsResponse,
  SettingsSchema,
  SetupStatus,
  SourceInstance,
  SourceLogsQuery,
  SourceLogsResponse,
  SourcesResponse,
  SourceUpsert,
  StandupResponse,
  Terminology,
  ThreatContextPanel,
  UsageSummary,
  User,
  UserPrefs,
  UsersResponse,
} from './types';

/** Payload for POST /api/cases/{id}/feedback (analyst grading). */
export interface CaseFeedbackInput {
  analyst?: string;
  assessment: 'agree' | 'partial' | 'disagree';
  accuracy?: number;
  reasoning_quality?: number;
  action_appropriateness?: number;
  actual_outcome?: string;
  time_saved_minutes?: number;
  comment?: string;
}

/** Payload for POST /api/cases/{id}/comment. */
export interface CaseCommentInput {
  author?: string;
  body: string;
}

/** Result of GET /api/cases/{id}/export. */
export interface CaseExport {
  filename: string;
  content_type: string;
  content: string;
}

/**
 * Result of POST /api/sources/{id}/analyze-sample (F9). The backend sanitizes a
 * pasted sample record and returns suggested field mappings + the discovered field
 * paths. The sample is NEVER persisted. All values are UNTRUSTED (source-derived) —
 * render the suggested field paths as plain text.
 */
export interface AnalyzeSampleResult {
  suggested_mappings: Partial<{
    source_ip_field: string;
    user_field: string;
    host_field: string;
    message_field: string;
    severity_field: string;
    rule_field: string;
  }> &
    Record<string, string>;
  fields: string[];
}

/** Payload for POST /api/rag/import (index a document into the RAG corpus). */
export interface RagImportInput {
  title: string;
  text: string;
  source?: string;
  tags?: string[];
}

/** Payload for POST /api/memory (add a durable operator memory). */
export interface MemoryInput {
  text: string;
  category?: string;
  tags?: string[];
}

/** Patch for PUT /api/memory/{id} (all fields optional / partial update). */
export interface MemoryPatch {
  text?: string;
  category?: string;
  tags?: string[];
  active?: boolean;
}

// --------------------------------------------------------------------------- //
// Round-5 W0-F F2 scaffolds — payload/result contracts for the new stub
// namespaces (`api.rules`, `api.dashboards`, `api.triage`, and the per-feature
// `getConfig/putConfig` clients). These mirror the backend contracts that later
// waves flesh out (Rules G6, Custom-Dash G7, F4 preview-decision, F5 typed config
// endpoints). All are additive; the nginx `/api` proxy forwards arbitrary JSON.
// --------------------------------------------------------------------------- //

/**
 * Input for POST /api/triage/preview-decision (F4). A thin, read-only what-if over
 * the pure deterministic `decide()` — it NEVER bills an LLM (#6), never writes a
 * case, and never re-implements the decision. `verdict` uses the backend `Verdict`
 * enum values (uppercase); `policy` is optional (defaults to the live auto-close
 * policy server-side).
 */
export interface PreviewDecisionInput {
  verdict: 'FALSE_POSITIVE' | 'TRUE_POSITIVE' | 'NEEDS_HUMAN' | string;
  /** Verdict confidence (0..1). */
  confidence: number;
  /** Cluster risk score (0..100). */
  risk_score: number;
  /** Optional candidate policy to preview; omitted → the live `prefs.auto_close`. */
  policy?: AutoClosePolicy;
}

/**
 * Result of POST /api/triage/preview-decision (F4). Mirrors the backend `Decision`
 * dataclass fields the endpoint projects. `decision` is the resulting lifecycle
 * status; `rationale` is the deterministic explanation string (both plain data, #9).
 */
export interface PreviewDecisionResult {
  /** The resulting deterministic lifecycle status (a {@link CaseStatus} value). */
  decision: CaseStatus;
  /** Human-readable, deterministic rationale for the decision. */
  rationale: string;
  /** Whether the case would be flagged for priority human attention. */
  escalate?: boolean;
  /** Who made the decision (agent auto-close vs. system fail-safe). */
  decision_by?: string;
  /** When the reopen (objection) window expires, for an agent auto-close. */
  objection_window_expires_at?: string | null;
  [key: string]: unknown;
}

/**
 * Response of GET /api/rules — the detection-rule catalog (mirrors
 * `Preferences.rule_catalog`, a `RuleDefinition[]`). Rules ride `PUT /api/settings`
 * today; this GET is a thin read scaffold the Rules G6 wave fleshes out.
 */
export interface RulesResponse {
  rules: RuleDefinition[];
  count?: number;
}

/**
 * Response of GET /api/dashboards (G7). The caller's saved custom dashboards
 * (persisted per-user under `UserPrefs.dashboards`). Every dashboard/widget name is
 * UNTRUSTED → render as plain text / SVG `<text>` (#9).
 */
export interface DashboardsResponse {
  dashboards: DashboardLayout[];
  count?: number;
}

/** Error thrown for any non-2xx backend response. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const API_BASE = '/api';

/**
 * Optional global 401 handler. When auth is enabled the app registers a callback
 * here; any non-auth API call that returns 401 invokes it so the app can bounce
 * the user back to the login screen. When auth is disabled no callback is
 * registered, so this is inert and the no-auth experience is unchanged.
 */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

/**
 * Optional step-up re-auth gate (Round-2 Wave 3). When auth is enabled the app
 * registers a callback here; any API call that returns 401 with the backend body
 * `{code:'reauth_required'}` invokes it, opening a re-auth modal. The callback
 * resolves `true` once the user has re-authenticated (so the original request is
 * retried ONCE) or `false` if they cancelled (the original 401 surfaces). When no
 * callback is registered (auth off, or before the provider mounts) the gate is
 * inert and the 401 surfaces unchanged — the no-auth path is untouched.
 */
let reauthGate: (() => Promise<boolean>) | null = null;
export function setReauthHandler(handler: (() => Promise<boolean>) | null): void {
  reauthGate = handler;
}

/** Extract a backend error `code` (e.g. "reauth_required") from a parsed body. */
function bodyCode(body: unknown): string | null {
  if (body && typeof body === 'object') {
    const detail = (body as { detail?: unknown }).detail;
    if (detail && typeof detail === 'object' && 'code' in detail) {
      const c = (detail as { code?: unknown }).code;
      if (typeof c === 'string') return c;
    }
    if ('code' in body) {
      const c = (body as { code?: unknown }).code;
      if (typeof c === 'string') return c;
    }
  }
  return null;
}

function buildQuery(query?: Record<string, unknown>): string {
  if (!query) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

async function parseBody(res: Response): Promise<unknown> {
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    try {
      return await res.json();
    } catch {
      return undefined;
    }
  }
  try {
    return await res.text();
  } catch {
    return undefined;
  }
}

function extractMessage(status: number, body: unknown): string {
  if (body && typeof body === 'object' && 'detail' in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === 'string') return detail;
    if (detail) return JSON.stringify(detail);
  }
  if (typeof body === 'string' && body.trim()) return body;
  return `Request failed (${status})`;
}

async function request<T>(
  method: string,
  path: string,
  opts: { body?: unknown; query?: Record<string, unknown>; _retried?: boolean } = {},
): Promise<T> {
  const clean = path.replace(/^\/+/, '');
  const url = `${API_BASE}/${clean}${buildQuery(opts.query)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      // Send the auth cookie (HttpOnly) on every call so the optional login flow
      // works; harmless (and required for same-origin) when auth is disabled.
      credentials: 'include',
      headers:
        opts.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch (e) {
    // Network-level failure (backend down, CORS, etc.)
    throw new ApiError(0, `Cannot reach backend: ${(e as Error).message}`);
  }
  const body = await parseBody(res);
  if (!res.ok) {
    // A 401 with `code:'reauth_required'` is a STEP-UP gate (the session is valid
    // but the action needs fresh credentials). Open the re-auth modal; if the user
    // re-authenticates, retry the original request exactly ONCE. Never recurse on a
    // retry, and never treat the /auth/reauth call itself as a gate trigger.
    if (
      res.status === 401 &&
      reauthGate &&
      !opts._retried &&
      bodyCode(body) === 'reauth_required' &&
      clean !== 'auth/reauth'
    ) {
      const ok = await reauthGate();
      if (ok) {
        return request<T>(method, path, { ...opts, _retried: true });
      }
      // User cancelled — surface the original 401.
      throw new ApiError(res.status, extractMessage(res.status, body), body);
    }
    // A plain 401 from a non-auth endpoint means the session lapsed (or auth was
    // just turned on); bounce to the login screen. The auth endpoints handle their
    // own 401s inline (expected on a bad password), so they are excluded.
    if (res.status === 401 && onUnauthorized && !clean.startsWith('auth/')) {
      onUnauthorized();
    }
    throw new ApiError(res.status, extractMessage(res.status, body), body);
  }
  return body as T;
}

/** Generic verbs, for ad-hoc/endpoints not yet wrapped in a typed method. */
export const api = {
  get: <T = unknown>(path: string, query?: Record<string, unknown>) =>
    request<T>('GET', path, { query }),
  post: <T = unknown>(path: string, body?: unknown) => request<T>('POST', path, { body }),
  put: <T = unknown>(path: string, body?: unknown) => request<T>('PUT', path, { body }),
  del: <T = unknown>(path: string) => request<T>('DELETE', path),

  // ---- Auth (optional; OFF-safe) ---------------------------------------- //
  auth: {
    me: () => request<AuthMe>('GET', 'auth/me'),
    login: (username: string, password: string) =>
      request<LoginResult>('POST', 'auth/login', { body: { username, password } }),
    logout: () => request<{ ok: boolean }>('POST', 'auth/logout'),
    changePassword: (currentPassword: string, newPassword: string) =>
      request<{ ok: boolean }>('POST', 'auth/change-password', {
        body: { current_password: currentPassword, new_password: newPassword },
      }),

    // ---- MFA (TOTP) — Wave 2 / F3 ------------------------------------------ //
    mfa: {
      // Begin enrollment (self): returns secret + otpauth URI + recovery codes ONCE.
      setup: () => request<MfaSetupResult>('POST', 'auth/mfa/setup'),
      // Confirm enrollment: verify a TOTP code against the pending secret + enable.
      confirm: (code: string) =>
        request<{ ok: boolean }>('POST', 'auth/mfa/confirm', { body: { code } }),
      // Login phase 2 (PUBLIC; gated by the pending_token). Accepts a TOTP OR a
      // single-use recovery code. Returns { token, user } like a normal login.
      verify: (pendingToken: string, code: string) =>
        request<LoginResult>('POST', 'auth/mfa/verify', {
          body: { pending_token: pendingToken, code },
        }),
      // Disable MFA (self): requires a current TOTP or a recovery code.
      disable: (code: string) =>
        request<{ ok: boolean }>('POST', 'auth/mfa/disable', { body: { code } }),
    },

    // ---- SSO (OIDC) — Wave 2 / F4 ------------------------------------------ //
    sso: {
      // PUBLIC: the enabled providers for the login screen.
      providers: () => request<SsoProvidersResponse>('GET', 'auth/sso/providers'),
      // PUBLIC: the IdP authorization URL to redirect the browser to.
      authorize: (provider: string) =>
        request<SsoAuthorizeResult>('GET', 'auth/sso/authorize', { query: { provider } }),
      // Admin: set/clear a provider's OIDC client secret (write-only).
      setSecret: (providerId: string, clientSecret: string | null) =>
        request<{ ok: boolean; configured: boolean }>(
          'POST',
          `auth/sso/providers/${encodeURIComponent(providerId)}/secret`,
          { body: { client_secret: clientSecret } },
        ),
    },

    // ---- Sessions: refresh + step-up re-auth (Round-2 Wave 3) ------------- //
    // Rotate the access/refresh tokens (new HttpOnly cookie set server-side; no
    // token is returned to JS). Used to recover from an idle/expired session.
    refresh: () => request<ReauthResult>('POST', 'auth/refresh'),
    // Step-up ("sudo") re-auth — re-prove the password (and/or an MFA code) to
    // stamp `last_authn`, satisfying a `reauth_required` gate before a sensitive
    // action. The current session is NOT replaced; only freshness is bumped.
    reauth: (password: string, code?: string) =>
      request<ReauthResult>('POST', 'auth/reauth', {
        body: { password, ...(code ? { code } : {}) },
      }),
  },

  // ---- Sessions (the signed-in user's OWN sessions) --------------------- //
  // List the caller's active sessions (the current one flagged `current:true`),
  // revoke a single session, or sign out every OTHER session. All gated by
  // current_user server-side; no secret/token is ever returned (#10).
  sessions: {
    list: () => request<SessionsResponse>('GET', 'sessions'),
    revoke: (sid: string) =>
      request<{ ok: boolean; sid: string }>(
        'POST',
        `sessions/${encodeURIComponent(sid)}/revoke`,
      ),
    revokeOthers: () =>
      request<{ ok: boolean; revoked: number }>('POST', 'sessions/revoke-others'),
  },

  // ---- Account activity (the user's recent audit trail) ----------------- //
  // GET /api/account/activity — recent audit events for the signed-in user. Every
  // value is system/operator-derived; render PLAIN.
  account_activity: () => request<ActivityResponse>('GET', 'account/activity'),

  // ---- Admin session console (all users' sessions) ---------------------- //
  // users:manage server-side. List ALL sessions (optionally filtered by user),
  // force-terminate one (optionally notifying the owner), or revoke EVERY session
  // for a user (bumps their token_version so already-issued tokens stop working).
  admin: {
    sessions: {
      list: (username?: string) =>
        request<SessionsResponse>('GET', 'admin/sessions', {
          query: username ? { username } : undefined,
        }),
      revoke: (sid: string, notify = false) =>
        request<{ ok: boolean; sid: string }>(
          'POST',
          `admin/sessions/${encodeURIComponent(sid)}/revoke`,
          { body: { notify } },
        ),
    },
    users: {
      revokeAll: (username: string, notify = false) =>
        request<{ ok: boolean; revoked: number }>(
          'POST',
          `admin/users/${encodeURIComponent(username)}/revoke-all`,
          { body: { notify } },
        ),
    },
  },

  // ---- Account / profile self-service (Round-2 Wave 2) ------------------ //
  // The signed-in user's OWN profile. Gated server-side by current_user (NOT
  // users:manage). Secrets are never returned; the avatar string is a tiny
  // data: URL the browser has already cropped/resized to 256x256 WebP.
  account: {
    get: () => request<AccountProfile>('GET', 'account/me'),
    put: (patch: AccountProfileBody) =>
      request<AccountProfile>('PUT', 'account/me', { body: patch }),
    // Thin set/clear of just the avatar. `value` null/"" clears it. The backend
    // validates the data: URL (png/webp/jpeg, magic-byte sniff, bounded length).
    avatar: (value: string | null) =>
      request<AccountProfile>('PUT', 'me/avatar', { body: { avatar: value } }),
  },

  // ---- OOBE first-run setup (PUBLIC status) ---------------------------- //
  // The legacy public `POST /api/setup/init-admin` route was REMOVED in the Round-4
  // audit (the live OOBE flow is `/api/setup/account`); the dead client stub was
  // deleted here too (bug #10 — it POSTed a route that no longer exists).
  setup: {
    status: () => request<SetupStatus>('GET', 'setup/status'),
  },

  // ---- RBAC: roles matrix + multi-user administration ------------------- //
  roles: {
    get: () => request<RolesResponse>('GET', 'roles'),
  },
  users: {
    list: () => request<UsersResponse>('GET', 'users'),
    create: (username: string, password: string, role: string) =>
      request<{ ok: boolean; user: User }>('POST', 'users', {
        body: { username, password, role },
      }),
    update: (
      username: string,
      patch: { role?: string; active?: boolean; password?: string },
    ) =>
      request<{ ok: boolean; user: User }>('PUT', `users/${encodeURIComponent(username)}`, {
        body: patch,
      }),
    remove: (username: string) =>
      request<{ ok: boolean }>('DELETE', `users/${encodeURIComponent(username)}`),
  },

  // ---- Notifications / alerting (F5 / Wave 4) --------------------------- //
  // Config rides PUT /api/settings (notifications subtree). These cover the
  // provider catalog, per-channel secret (write-only), a test send, and a manual
  // per-case notify. Secrets are never returned (only configured booleans).
  notifications: {
    // settings:read — email presets + the available channel types.
    providers: () => request<NotificationProviders>('GET', 'notifications/providers'),
    // settings:manage — send a sample to one channel (detail never leaks a secret).
    test: (channelId: string) =>
      request<NotificationTestResult>('POST', 'notifications/test', {
        body: { channel_id: channelId },
      }),
    // settings:manage — set/clear one channel's secret field (write-only). `value`
    // null/"" clears it. Returns { ok, configured, configured_secrets }.
    channelSecret: (channelId: string, value: string | null, field = 'secret') =>
      request<{ ok: boolean; configured: boolean; configured_secrets: string[] }>(
        'POST',
        `notifications/channels/${encodeURIComponent(channelId)}/secret`,
        { body: { field, value } },
      ),
    // settings:manage — SERVER-side render a template against a sample case for the
    // trigger. The server is authoritative for #9 escaping; the optional `template`
    // body lets the editor preview an UNSAVED draft override before persisting it.
    // Returns { trigger, subject, html, text, variables?, is_override? }.
    preview: (trigger: string, template?: NotificationTemplate) =>
      request<NotificationPreview>(
        'POST',
        `notifications/preview?trigger=${encodeURIComponent(trigger)}`,
        { body: template ? { template } : {} },
      ),
  },
  cases: {
    // cases:write — manually send a case notification to one channel (or all
    // enabled when channelId is omitted). Fire-and-forget; never alters the case.
    notify: (caseId: string, channelId?: string) =>
      request<NotifyCaseResult>('POST', `cases/${encodeURIComponent(caseId)}/notify`, {
        body: channelId ? { channel_id: channelId } : {},
      }),
    // playbooks:run — CONTEXT-ONLY re-investigation with `playbookId` forced as the
    // injected (recommend-only) operator procedure. The deterministic close/escalate
    // decision is unchanged — decide() re-runs with the new context. Returns the
    // updated Case (verdict/rationale may change; status is never set by the run).
    runPlaybook: (caseId: string, playbookId: string) =>
      request<Case>('POST', `cases/${encodeURIComponent(caseId)}/run-playbook`, {
        body: { playbook_id: playbookId },
      }),
    // cases:read — the assembled threat-context panel (IOC reputation, MITRE
    // techniques, related cases, asset context, evidence). Fail-open per section.
    threatContext: (caseId: string) =>
      request<ThreatContextPanel>(
        'GET',
        `cases/${encodeURIComponent(caseId)}/threat-context`,
      ),
    // BULK case action (W7c) — apply ONE human lifecycle action (the SAME logic as
    // POST /api/cases/{id}/action) to N selected cases. #3-safe: never an LLM
    // auto-close, never decide(); each case audited individually. RBAC-gated server-
    // side (cases:close for close/resolve, cases:write otherwise). Returns per-id
    // outcomes ({results:[{id, ok, error?}]}) — a partial failure fails only that id.
    bulk: (ids: string[], input: CaseActionInput) =>
      request<BulkResult>('POST', 'cases/bulk', { body: { ...input, ids } }),
  },

  // ---- Global search (W7c) — Cmd-K palette + top-bar jump ---------------- //
  // Read-only across cases + sources + nav targets, bounded (cap 50). Every
  // returned label/title is operator-/log-derived → render as PLAIN text (#9).
  search: (q: string, limit?: number) =>
    request<SearchResult>('GET', 'search', { query: { q, limit } }),

  // ---- Audit-log viewer (W7c) — read-only over the append-only audit (#2) - //
  // Gated by audit:view server-side (admin/auditor/soc_manager). Filters are
  // ANDed; the `action`/`from`/`to` params map to the audit `action_type`/ts
  // bounds. Every field is rendered PLAIN (#9). No write/update/delete path exists.
  audit: {
    list: (params?: AuditQuery) =>
      request<AuditResponse>('GET', 'audit', {
        query: params as Record<string, unknown> | undefined,
      }),
  },

  // ---- Threat-intel knowledge import (F11) ----------------------------- //
  // rag:manage — ingest a threat-intel document into the RAG corpus as
  // source="threat_context"; it is retrieved + injected as a TRUSTED fenced block.
  threatContext: {
    import: (input: { title: string; content: string; tags?: string[] }) =>
      request<RagImportResult>('POST', 'threat-context/import', { body: input }),
  },

  // ---- Personas + playbooks (read-only catalog) ------------------------- //
  getPersonas: () => request<PersonasResponse>('GET', 'personas'),
  getPlaybooks: () => request<PlaybooksResponse>('GET', 'playbooks'),

  // ---- Health + setup --------------------------------------------------- //
  health: () => request<HealthResponse>('GET', 'health'),
  setupStatus: () => request<SetupStatus>('GET', 'setup/status'),
  updateSecrets: (secrets: SecretsUpdate) =>
    request<{ ok: boolean; configured: Record<string, boolean> }>('POST', 'setup/secrets', {
      body: secrets,
    }),
  completeSetup: () =>
    request<{ ok: boolean; setup_complete: boolean }>('POST', 'setup/complete'),

  // ---- Settings --------------------------------------------------------- //
  getSettings: () => request<SettingsResponse>('GET', 'settings'),
  // The best-effort settings SCHEMA reflector (Round-5 Sett-C): a descriptive
  // description of the Preferences model (types + defaults + element models), used by
  // the generic "Advanced (all settings)" renderer. No values beyond defaults, no secrets.
  getSettingsSchema: () => request<SettingsSchema>('GET', 'settings/schema'),
  putSettings: (patch: Partial<Preferences>) =>
    request<{ ok: boolean; prefs: Preferences }>('PUT', 'settings', { body: patch }),
  // Live-preview a CANDIDATE case-id template without persisting / consuming the
  // sequence (F7). Returns { samples, valid, error }.
  caseIdPreview: (body: { template: string; prefix?: string; seq_start?: number }) =>
    request<CaseIdPreview>('POST', 'settings/case-id/preview', { body }),

  // ---- Models ----------------------------------------------------------- //
  getModels: () => request<ModelsResponse>('GET', 'models'),

  // ---- Connectors + sources -------------------------------------------- //
  listConnectors: () => request<ConnectorsResponse>('GET', 'connectors'),
  getConnector: (sourceType: string) =>
    request<ConnectorManifest>('GET', `connectors/${encodeURIComponent(sourceType)}`),
  testConnector: (sourceType?: string) =>
    request<ConnectionTest>('POST', 'connectors/test', {
      body: { source_type: sourceType ?? null },
    }),
  listSources: () => request<SourcesResponse>('GET', 'sources'),
  upsertSource: (source: SourceUpsert) =>
    request<{ ok: boolean; sources: SourceInstance[] }>('POST', 'sources', { body: source }),
  deleteSource: (sourceId: string) =>
    request<{ ok: boolean; sources: SourceInstance[] }>(
      'DELETE',
      `sources/${encodeURIComponent(sourceId)}`,
    ),
  // Browse a window of normalised events from one source. `buildQuery` drops any
  // undefined / null / empty params, so blank query/from/to are not sent.
  sourceLogs: (sourceId: string, params?: SourceLogsQuery) =>
    request<SourceLogsResponse>('GET', `sources/${encodeURIComponent(sourceId)}/logs`, {
      query: params as Record<string, unknown> | undefined,
    }),
  // Source-scoped helpers (F9). `analyzeSample` posts a pasted sample record and
  // gets back suggested field mappings + discovered field paths. The sample is
  // sanitized server-side and NEVER persisted to the source config.
  sources: {
    analyzeSample: (sourceId: string, sample: unknown) =>
      request<AnalyzeSampleResult>(
        'POST',
        `sources/${encodeURIComponent(sourceId)}/analyze-sample`,
        { body: { sample } },
      ),
  },

  // ---- Branding (PUBLIC; white-label) ---------------------------------- //
  getBranding: () => request<Branding>('GET', 'branding'),
  putBranding: (branding: Branding) => request<Branding>('PUT', 'branding', { body: branding }),

  // ---- Pervasive customization (Round-2 Wave 7) ------------------------ //
  // Two-store model: ORG defaults on Preferences.customization (admin-only PUT) +
  // PERSONAL prefs in the per-user UserPrefsStore (the 'default' bucket when auth
  // is off). The cascade resolver merges ORG ← USER. The PrefsContext hydrates once
  // from `prefs.effective` on mount. Every terminology/view value is plain data (#9).
  prefs: {
    // The merged ORG←USER cascade for the caller (hydrated once by PrefsContext).
    effective: () => request<EffectivePrefs>('GET', 'prefs/effective'),
    // The caller's raw PERSONAL bucket / a partial patch of it (theme/pins/…). NOT
    // admin-gated — each user edits only their own bucket.
    getUser: () => request<UserPrefs>('GET', 'prefs/user'),
    putUser: (patch: Partial<UserPrefs>) =>
      request<UserPrefs>('PUT', 'prefs/user', { body: patch }),
    // The ORG defaults — readable by any signed-in user (the cascade needs them),
    // writable ADMIN-ONLY (server-gated; may 403).
    getOrg: () => request<OrgCustomization>('GET', 'prefs/org'),
    putOrg: (org: OrgCustomization) =>
      request<OrgCustomization>('PUT', 'prefs/org', { body: org }),
    // Persist ONE table's column state (show/hide/reorder/width). An all-empty body
    // clears the override (reverts to the table's built-in default columns).
    tables: {
      put: (tableId: string, state: ColumnState) =>
        request<{ table_id: string; state: ColumnState }>(
          'PUT',
          `prefs/user/tables/${encodeURIComponent(tableId)}`,
          { body: state },
        ),
    },
  },

  // ---- Saved views (personal + org-shared) ----------------------------- //
  // `list` returns the caller's PERSONAL views UNION the ORG-shared ones (the
  // latter carry `shared:true`). create/update/remove act on PERSONAL views only;
  // `clone` copies any view (org or personal) into the caller's personal set.
  views: {
    list: () => request<{ views: SavedView[]; count: number }>('GET', 'views'),
    create: (view: {
      name: string;
      scope?: string;
      shared?: boolean;
      filters?: Record<string, unknown>;
      sort?: string;
      columns?: string[] | null;
    }) => request<SavedView>('POST', 'views', { body: view }),
    update: (id: string, patch: Partial<Omit<SavedView, 'id'>>) =>
      request<SavedView>('PUT', `views/${encodeURIComponent(id)}`, { body: patch }),
    remove: (id: string) =>
      request<{ ok: boolean; id: string }>('DELETE', `views/${encodeURIComponent(id)}`),
    clone: (id: string) =>
      request<SavedView>('POST', `views/${encodeURIComponent(id)}/clone`),
  },

  // ---- Terminology (ORG label overrides) ------------------------------- //
  // Readable by any signed-in user (the UI `t(key)` helper needs it); PUT is
  // ADMIN-ONLY (server-gated; may 403). All labels are plain data (#9).
  terminology: {
    get: () => request<{ terminology: Terminology }>('GET', 'terminology'),
    put: (terminology: Terminology) =>
      request<{ terminology: Terminology }>('PUT', 'terminology', { body: { terminology } }),
  },

  // ---- Metrics + feedback analytics ------------------------------------ //
  getMetrics: (windowHours = 24) =>
    request<Metrics>('GET', 'metrics', { query: { window_hours: windowHours } }),
  getFeedbackStats: () => request<FeedbackStats>('GET', 'feedback/stats'),

  // ---- Analytics surfaces ---------------------------------------------- //
  listCases: (query?: Record<string, unknown>) =>
    request<CasesResponse>('GET', 'cases', { query }),
  getCase: (caseId: string) =>
    request<Case>('GET', `cases/${encodeURIComponent(caseId)}`),

  // ---- Case actions (feedback / collaboration / export) ---------------- //
  caseFeedback: (caseId: string, body: CaseFeedbackInput) =>
    request<Case>('POST', `cases/${encodeURIComponent(caseId)}/feedback`, { body }),
  caseComment: (caseId: string, body: CaseCommentInput) =>
    request<Case>('POST', `cases/${encodeURIComponent(caseId)}/comment`, { body }),
  caseTags: (caseId: string, tags: string[], analyst?: string) =>
    request<Case>('POST', `cases/${encodeURIComponent(caseId)}/tags`, {
      body: { tags, analyst },
    }),
  caseAssign: (caseId: string, assignee: string, analyst?: string) =>
    request<Case>('POST', `cases/${encodeURIComponent(caseId)}/assign`, {
      body: { assignee, analyst },
    }),
  exportCase: (caseId: string, format: 'json' | 'md' = 'json') =>
    request<CaseExport>('GET', `cases/${encodeURIComponent(caseId)}/export`, {
      query: { format },
    }),
  // Unified analyst action on a case (close / reopen / escalate / confirm_fp /
  // acknowledge / …). Carries optional resolution/assignee/priority/tags. Returns
  // the updated Case. The proxy forwards arbitrary JSON, so this is additive.
  caseActionExec: (caseId: string, input: CaseActionInput) =>
    request<Case>('POST', `cases/${encodeURIComponent(caseId)}/action`, { body: input }),
  // Re-run the agent investigation for a case (optionally pinning the model).
  reinvestigateCase: (caseId: string, input?: { model?: string }) =>
    request<Case>('POST', `cases/${encodeURIComponent(caseId)}/reinvestigate`, {
      body: input ?? {},
    }),
  // `model` / `case_id` / `source_id` are only sent when set, so the no-model /
  // no-case / no-source chat behaviour is byte-for-byte unchanged. Existing 1-4
  // arg callers are unaffected; `sourceId` scopes the chat to one source.
  chat: (
    message: string,
    history?: ChatTurn[],
    caseId?: string,
    model?: string,
    sourceId?: string,
  ) =>
    request<ChatResponse>('POST', 'chat', {
      body: {
        message,
        history: history ?? [],
        ...(caseId ? { case_id: caseId } : {}),
        ...(model ? { model } : {}),
        ...(sourceId ? { source_id: sourceId } : {}),
      },
    }),
  investigate: (body: Record<string, unknown>) =>
    request<Case>('POST', 'investigate', { body }),
  scans: (limit = 50) => request<CasesResponse>('GET', 'scans', { query: { limit } }),
  // How many automated-scan cases are new since `since` (an ISO timestamp the
  // caller persists in localStorage). `since` is only sent when set.
  scanNotifications: (since?: string) =>
    request<ScanNotifications>('GET', 'scans/notifications', {
      query: since ? { since } : undefined,
    }),
  standup: (windowHours?: number) =>
    request<StandupResponse>('GET', 'standup', { query: { window_hours: windowHours } }),
  usageSummary: (windowHours = 24) =>
    request<UsageSummary>('GET', 'usage/summary', { query: { window_hours: windowHours } }),
  pollNow: () => request<Record<string, unknown>>('POST', 'poll'),

  // ---- Knowledge / RAG corpus management ------------------------------- //
  ragStats: () => request<RagStats>('GET', 'rag/stats'),
  ragDocuments: () => request<RagDocumentsResponse>('GET', 'rag/documents'),
  ragDocument: (id: string) =>
    request<RagDocument>('GET', `rag/documents/${encodeURIComponent(id)}`),
  ragImport: (input: RagImportInput) =>
    request<RagImportResult>('POST', 'rag/import', { body: input }),
  ragDeleteDocument: (id: string, force = false) =>
    request<{ document_id: string; deleted: number | boolean }>(
      'DELETE',
      `rag/documents/${encodeURIComponent(id)}`,
      { query: force ? { force: true } : undefined },
    ),
  ragSearch: (q: string, topK?: number) =>
    request<RagSearchResponse>('GET', 'rag/search', { query: { q, top_k: topK } }),

  // ---- Operator memory (durable agent facts) --------------------------- //
  getMemory: (activeOnly?: boolean) =>
    request<MemoryResponse>('GET', 'memory', {
      query: typeof activeOnly === 'boolean' ? { active_only: activeOnly } : undefined,
    }),
  addMemory: (input: MemoryInput) => request<MemoryEntry>('POST', 'memory', { body: input }),
  updateMemory: (id: string, patch: MemoryPatch) =>
    request<MemoryEntry>('PUT', `memory/${encodeURIComponent(id)}`, { body: patch }),
  deleteMemory: (id: string) =>
    request<{ ok: boolean; id: string }>('DELETE', `memory/${encodeURIComponent(id)}`),

  // ---- Case decision rationale (consumed by the Cases surface) --------- //
  caseRationale: (id: string) =>
    request<CaseRationale>('GET', `cases/${encodeURIComponent(id)}/rationale`),

  // ---- Demo mode (Round-2 Wave 5; admin-gated) ------------------------- //
  // First-class, REVERSIBLE tenant state. `enable` seeds the isolated in-memory
  // demo store (and starts the live-sim tick when mode==='live'); `reset` re-seeds
  // from the same seed; `disable` stops the tick + hard-deletes all demo data by
  // run_id and flips back to 'off' (the real state returns intact). Synthetic data
  // is $0 (deterministic mock LLM). All four are settings:manage server-side.
  demo: {
    status: () => request<DemoStatus>('GET', 'demo/status'),
    enable: (config?: DemoConfig) =>
      request<DemoStatus>('POST', 'demo/enable', { body: config ?? {} }),
    reset: () => request<DemoStatus>('POST', 'demo/reset'),
    disable: () => request<DemoStatus>('POST', 'demo/disable'),
  },

  // ---- Approval queue (agent-drafted proposals) ------------------------ //
  // List proposals; `status` is only sent when set (omitting it returns the
  // backend default). The status filter scopes the queue (e.g. 'pending').
  listProposals: (status?: string) =>
    request<ProposalsResponse>('GET', 'proposals', {
      query: status ? { status } : undefined,
    }),
  // Approve a proposal — the ONLY action that makes a rule live / saves a memory.
  // Admin-gated server-side (may 403/404/409/400); the panel surfaces the error.
  approveProposal: (id: string) =>
    request<Proposal>('POST', `proposals/${encodeURIComponent(id)}/approve`),
  // Reject (discard) a drafted proposal. Returns ok / the updated proposal.
  rejectProposal: (id: string) =>
    request<Proposal>('POST', `proposals/${encodeURIComponent(id)}/reject`),

  // ---- Round-5 W0-F F2 scaffolds (Rules G6 / Custom-Dash G7 / preview) --- //
  // These are typed CLIENT scaffolds the feature waves flesh out. Each hits an
  // additive backend route (the nginx `/api` proxy forwards arbitrary JSON, so no
  // proxy change is needed). Kept in their OWN namespaces so later waves append to
  // them without touching the rest of this module.

  // ---- Detection-rule catalog (G6) ------------------------------------- //
  // The rule catalog rides `Preferences.rule_catalog` (a `RuleDefinition[]`) via
  // `PUT /api/settings` today; these are the dedicated read/write scaffolds the
  // Rules wave builds on. Rule `name`/`match.field`/`match.value` are operator-
  // authored + LOG-adjacent → render as plain text (#9); `model_override` never
  // echoes a key (#10). Editors are config-writers — they NEVER touch `decide()`.
  rules: {
    list: () => request<RulesResponse>('GET', 'rules'),
    save: (rules: RuleDefinition[]) =>
      request<RulesResponse>('PUT', 'rules', { body: { rules } }),
  },

  // ---- Custom dashboards (G7) ------------------------------------------ //
  // Per-user saved dashboards (persisted under `UserPrefs.dashboards`; the
  // `DashboardStore` is zero-migration KV). Every dashboard/widget name is
  // UNTRUSTED → plain text / SVG `<text>` (#9); the widget TYPE is server-
  // allowlisted on write. Layout is presentation-only (advisory, never feeds #3).
  dashboards: {
    list: () => request<DashboardsResponse>('GET', 'dashboards'),
    create: (dashboard: DashboardLayout) =>
      request<DashboardLayout>('POST', 'dashboards', { body: dashboard }),
    update: (id: string, dashboard: DashboardLayout) =>
      request<DashboardLayout>('PUT', `dashboards/${encodeURIComponent(id)}`, {
        body: dashboard,
      }),
    remove: (id: string) =>
      request<{ ok: boolean; id: string }>(
        'DELETE',
        `dashboards/${encodeURIComponent(id)}`,
      ),
    // Copy a role-default (or any) dashboard into the caller's personal set for
    // customization (clone-to-customize on first edit).
    clone: (id: string) =>
      request<DashboardLayout>('POST', `dashboards/${encodeURIComponent(id)}/clone`),
  },

  // ---- Deterministic decision preview (F4) ----------------------------- //
  // A read-only what-if over the pure `decide()`. It NEVER bills an LLM (#6),
  // never writes a case, and never re-implements the decision — it just shows what
  // the deterministic policy WOULD do for a given (verdict, confidence, risk).
  triage: {
    previewDecision: (input: PreviewDecisionInput) =>
      request<PreviewDecisionResult>('POST', 'triage/preview-decision', { body: input }),
  },

  // ---- Per-feature typed config clients (F5) --------------------------- //
  // Mirror `routes_tuning`'s `GET/PUT /tuning/config` for the other Round-4 engine
  // blocks. GET returns `{config}`; PUT deep-merges the changed keys server-side
  // (audited, RBAC-gated, #2) and returns `{ok, config}`. All blocks default OFF;
  // every one is ADVISORY and NEVER feeds the deterministic decision (#3).
  baseline: {
    getConfig: () => request<{ config: BaselineConfig }>('GET', 'baseline/config'),
    putConfig: (config: Partial<BaselineConfig>) =>
      request<{ ok: boolean; config: BaselineConfig }>('PUT', 'baseline/config', {
        body: config,
      }),
  },
  campaign: {
    getConfig: () => request<{ config: CampaignConfig }>('GET', 'campaign/config'),
    putConfig: (config: Partial<CampaignConfig>) =>
      request<{ ok: boolean; config: CampaignConfig }>('PUT', 'campaign/config', {
        body: config,
      }),
  },
  batch: {
    getConfig: () => request<{ config: BatchConfig }>('GET', 'batch/config'),
    putConfig: (config: Partial<BatchConfig>) =>
      request<{ ok: boolean; config: BatchConfig }>('PUT', 'batch/config', {
        body: config,
      }),
  },
};

export type Api = typeof api;
