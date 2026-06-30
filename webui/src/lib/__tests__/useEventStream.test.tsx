/**
 * useEventStream — Wave-4 live-wiring coverage.
 *
 * Pins the load-bearing GRACEFUL-FALLBACK contract (the whole point of the hook being
 * purely additive):
 *   1. DISABLED (enabled:false) → completely inert: no probe, no EventSource, live false.
 *   2. ENABLED but realtime OFF (the probe 204s) → falls back to polling: NO EventSource
 *      is opened and `live` stays false (the caller keeps polling).
 *   3. ENABLED + realtime ON (probe 200) → opens an EventSource, `live` becomes true,
 *      and a frame is decoded + handed to `onEvent`.
 *   4. An EventSource error drops `live` back to false (so the caller resumes polling).
 *
 * EventSource + fetch are mocked (jsdom has neither a real SSE transport nor a server),
 * so this exercises the hook's own state machine with no network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

import { useEventStream } from '../useEventStream';

/* ----------------------------------------------------------- EventSource mock */

/** A minimal controllable EventSource stand-in matching the bits the hook uses. */
class MockEventSource {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 2;
  static instances: MockEventSource[] = [];

  url: string;
  withCredentials: boolean;
  readyState = MockEventSource.CONNECTING;
  onopen: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;
  listeners = new Map<string, Array<(ev: unknown) => void>>();
  closed = false;

  constructor(url: string, init?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = Boolean(init?.withCredentials);
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: (ev: unknown) => void) {
    const list = this.listeners.get(type) || [];
    list.push(cb);
    this.listeners.set(type, list);
  }

  close() {
    this.closed = true;
    this.readyState = MockEventSource.CLOSED;
  }

  /* test helpers ---------------------------------------------------------- */
  emitOpen() {
    this.readyState = MockEventSource.OPEN;
    this.onopen?.({});
  }

  emit(type: string, data: string, id = '1') {
    const ev = { type, data, lastEventId: id } as unknown;
    for (const cb of this.listeners.get(type) || []) cb(ev);
  }

  emitError(open = false) {
    this.readyState = open ? MockEventSource.OPEN : MockEventSource.CLOSED;
    this.onerror?.({});
  }
}

/** Resolve a fetch probe with a given status (no body is ever read by the hook). */
function probeResponse(status: number) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => 'text/event-stream' },
  } as unknown as Response;
}

describe('useEventStream (Wave-4 live wiring / graceful fallback)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    MockEventSource.instances = [];
    // jsdom lacks EventSource + AbortController quirks; inject our mock.
    (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
    fetchMock = vi.fn();
    (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is completely inert when disabled (no probe, no EventSource, live false)', () => {
    const onEvent = vi.fn();
    const { result } = renderHook(() =>
      useEventStream(['notifications'], { enabled: false, onEvent }),
    );
    expect(result.current.live).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it('is inert when enabled but given no topics', () => {
    const { result } = renderHook(() => useEventStream([], { enabled: true }));
    expect(result.current.live).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it('falls back to polling when realtime is disabled (probe 204 → no EventSource, live false)', async () => {
    fetchMock.mockResolvedValue(probeResponse(204));
    const { result } = renderHook(() =>
      useEventStream(['notifications', 'inbox'], { enabled: true }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // The probe URL carries the (sorted) topics.
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/events?topics=');
    // 204 → graceful fallback: no stream opened, live never becomes true.
    expect(MockEventSource.instances).toHaveLength(0);
    expect(result.current.live).toBe(false);
  });

  it('opens an EventSource and goes live when realtime is enabled (probe 200), delivering frames', async () => {
    fetchMock.mockResolvedValue(probeResponse(200));
    const onEvent = vi.fn();
    const { result } = renderHook(() =>
      useEventStream(['notifications'], { enabled: true, onEvent }),
    );

    // The probe resolves → the hook opens a (mock) EventSource.
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    const es = MockEventSource.instances[0];
    expect(es.withCredentials).toBe(true); // cookie auth flows even under CORS

    act(() => es.emitOpen());
    await waitFor(() => expect(result.current.live).toBe(true));

    // A decoded `inapp` frame is handed to the caller verbatim (JSON-parsed).
    act(() => es.emit('inapp', JSON.stringify({ kind: 'mention', case_id: 'c-1' }), '7'));
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'inapp',
        data: { kind: 'mention', case_id: 'c-1' },
        lastEventId: '7',
      }),
    );
  });

  it('drops live back to false on an EventSource error (caller resumes polling)', async () => {
    fetchMock.mockResolvedValue(probeResponse(200));
    const { result } = renderHook(() =>
      useEventStream(['cases:case-1'], { enabled: true }),
    );

    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    const es = MockEventSource.instances[0];
    act(() => es.emitOpen());
    await waitFor(() => expect(result.current.live).toBe(true));

    // A transport error (stream was open then dropped) → live false again.
    act(() => es.emitError(true));
    await waitFor(() => expect(result.current.live).toBe(false));
    // The errored source is closed (no leaked socket).
    expect(es.closed).toBe(true);
  });

  it('tears down (closes the stream + clears live) on unmount', async () => {
    fetchMock.mockResolvedValue(probeResponse(200));
    const { result, unmount } = renderHook(() =>
      useEventStream(['notifications'], { enabled: true }),
    );
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    const es = MockEventSource.instances[0];
    act(() => es.emitOpen());
    await waitFor(() => expect(result.current.live).toBe(true));

    unmount();
    expect(es.closed).toBe(true);
  });
});
