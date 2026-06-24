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
  AuthMe,
  Branding,
  Case,
  CaseActionInput,
  CaseRationale,
  CasesResponse,
  ChatResponse,
  ChatTurn,
  ConnectionTest,
  ConnectorManifest,
  ConnectorsResponse,
  FeedbackStats,
  HealthResponse,
  LoginResult,
  MemoryEntry,
  MemoryResponse,
  Metrics,
  ModelsResponse,
  PersonasResponse,
  PlaybooksResponse,
  Preferences,
  Proposal,
  ProposalsResponse,
  RagDocument,
  RagDocumentsResponse,
  RagImportResult,
  RagSearchResponse,
  RagStats,
  SecretsUpdate,
  SettingsResponse,
  SetupStatus,
  SourceInstance,
  SourceLogsQuery,
  SourceLogsResponse,
  SourcesResponse,
  SourceUpsert,
  StandupResponse,
  UsageSummary,
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
  opts: { body?: unknown; query?: Record<string, unknown> } = {},
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
    // A 401 from a non-auth endpoint means the session lapsed (or auth was just
    // turned on); bounce to the login screen. The auth endpoints handle their own
    // 401s inline (expected on a bad password), so they are excluded.
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
  putSettings: (patch: Partial<Preferences>) =>
    request<{ ok: boolean; prefs: Preferences }>('PUT', 'settings', { body: patch }),

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

  // ---- Branding (PUBLIC; white-label) ---------------------------------- //
  getBranding: () => request<Branding>('GET', 'branding'),
  putBranding: (branding: Branding) => request<Branding>('PUT', 'branding', { body: branding }),

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
};

export type Api = typeof api;
