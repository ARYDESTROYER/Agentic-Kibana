/**
 * lib/api client-behavior regressions (Round-6 sources batch).
 *
 *   - Dashboard writes default to a TRAILING-debounce that coalesces a rapid drag/resize
 *     stream to the same id into one PUT (finding 17 / the `dashboards-route` coalescing
 *     contract), while an EXPLICIT Save (`{ immediate: true }`) fires right away —
 *     flushing any pending settle — so the primary action never eats the 500ms delay.
 *   - extractMessage turns a CODED backend error ({code,reason} with no human string) into
 *     a readable sentence instead of a raw JSON blob (finding 18).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from '../api';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/json' : null),
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('dashboard update: default trailing-debounce + immediate Save path (finding 17)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { id: 'x' }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('an EXPLICIT Save ({ immediate: true }) fires the PUT NOW (never eats the 500ms debounce)', () => {
    void api.dashboards.update('iso-1', { id: 'iso-1' } as never, { immediate: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/dashboards/iso-1');
    expect((init as RequestInit).method).toBe('PUT');
  });

  it('the DEFAULT (drag/resize stream) trailing-debounces a burst to the same id into ONE PUT', async () => {
    void api.dashboards.update('burst-1', { id: 'burst-1', v: 1 } as never);
    void api.dashboards.update('burst-1', { id: 'burst-1', v: 2 } as never);
    void api.dashboards.update('burst-1', { id: 'burst-1', v: 3 } as never);
    expect(fetchMock).toHaveBeenCalledTimes(0); // trailing only — nothing sent before the window elapses
    await vi.advanceTimersByTimeAsync(600);
    expect(fetchMock).toHaveBeenCalledTimes(1); // one coalesced trailing PUT
  });

  it('an immediate Save FLUSHES a pending settle: one immediate PUT, no stray trailing PUT', async () => {
    void api.dashboards.update('flush-1', { id: 'flush-1', v: 1 } as never); // opens a trailing window
    expect(fetchMock).toHaveBeenCalledTimes(0);
    // Save arrives mid-settle → immediate PUT that cancels + folds the pending settle.
    void api.dashboards.update('flush-1', { id: 'flush-1', v: 2 } as never, { immediate: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(600);
    expect(fetchMock).toHaveBeenCalledTimes(1); // the pending settle was cancelled — no second PUT
  });
});

describe('extractMessage humanizes coded errors (finding 18)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps a coded session_invalid detail to a readable sentence (not raw JSON)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, { detail: { code: 'session_invalid', reason: 'refresh_reuse' } }),
    );
    await expect(api.get('cases')).rejects.toThrowError(
      'Your session is no longer valid. Please sign in again.',
    );
  });

  it('prefers a human `message` field when present', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { detail: { message: 'boom', code: 'x' } }));
    await expect(api.get('cases')).rejects.toThrowError('boom');
  });

  it('falls back to a generic message for an unknown code (never a JSON blob)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { detail: { code: 'mystery' } }));
    await expect(api.get('cases')).rejects.toThrowError('Request failed (500)');
  });
});

describe('PATCH verb + typed config clients (round-6 api helpers)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, config: {} }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('api.patch issues a PATCH with a JSON body (case-collab thread/task edits 405 on PUT)', async () => {
    await api.patch('cases/c1/thread/m1', { body: 'edited' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('/api/cases/c1/thread/m1');
    expect((init as RequestInit).method).toBe('PATCH');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ body: 'edited' });
  });

  it('api.tuning.getConfig / putConfig hit the PLURAL-free /api/tuning/config route', async () => {
    await api.tuning.getConfig();
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/tuning/config');
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('GET');

    await api.tuning.putConfig({ enabled: true });
    expect(String(fetchMock.mock.calls[1][0])).toBe('/api/tuning/config');
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe('PUT');
  });

  it('api.campaign config uses the PLURAL /api/campaigns/config route (not the singular)', async () => {
    await api.campaign.getConfig();
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/campaigns/config');
  });
});
