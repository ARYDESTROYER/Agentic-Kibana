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
  Case,
  CasesResponse,
  ChatResponse,
  ChatTurn,
  ConnectionTest,
  ConnectorManifest,
  ConnectorsResponse,
  HealthResponse,
  ModelsResponse,
  Preferences,
  SecretsUpdate,
  SettingsResponse,
  SetupStatus,
  SourceInstance,
  SourcesResponse,
  SourceUpsert,
  StandupResponse,
  UsageSummary,
} from './types';

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

  // ---- Analytics surfaces ---------------------------------------------- //
  listCases: (query?: Record<string, unknown>) =>
    request<CasesResponse>('GET', 'cases', { query }),
  getCase: (caseId: string) =>
    request<Case>('GET', `cases/${encodeURIComponent(caseId)}`),
  chat: (message: string, history?: ChatTurn[], caseId?: string) =>
    request<ChatResponse>('POST', 'chat', {
      body: { message, history: history ?? [], case_id: caseId ?? null },
    }),
  investigate: (body: Record<string, unknown>) =>
    request<Case>('POST', 'investigate', { body }),
  scans: (limit = 50) => request<CasesResponse>('GET', 'scans', { query: { limit } }),
  standup: (windowHours?: number) =>
    request<StandupResponse>('GET', 'standup', { query: { window_hours: windowHours } }),
  usageSummary: (windowHours = 24) =>
    request<UsageSummary>('GET', 'usage/summary', { query: { window_hours: windowHours } }),
  pollNow: () => request<Record<string, unknown>>('POST', 'poll'),
};

export type Api = typeof api;
