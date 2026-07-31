import * as React from 'react';

import { api } from '@/lib/api';
import type { UpstreamReleasesResponse } from '@/lib/types';

// This is a same-origin cache heartbeat, not a GitHub polling policy. The backend
// remains authoritative for the saved 15-minute-to-7-day public check interval and
// coalesces callers. A 15-minute heartbeat means every selectable UI interval can
// take effect while a Console tab stays open without increasing upstream API use.
export const UPSTREAM_RELEASE_POLL_MS = 15 * 60 * 1_000;

export type UpstreamReleaseCheckStatus = 'checking' | 'ready' | 'unavailable';

export interface UpstreamReleaseUpdateState {
  status: UpstreamReleaseCheckStatus;
  data: UpstreamReleasesResponse | null;
  checkNow: () => Promise<void>;
}

export interface UpstreamReleaseUpdateOptions {
  getUpdates?: (signal?: AbortSignal) => Promise<UpstreamReleasesResponse>;
  pollMs?: number;
}

/**
 * Observe the backend's cached repository metadata. Calling this hook never contacts
 * GitHub directly and never pulls or activates an artifact; the backend owns strict
 * source validation, timeout, and cache policy.
 */
export function useUpstreamReleaseUpdates(
  options: UpstreamReleaseUpdateOptions = {},
): UpstreamReleaseUpdateState {
  const [status, setStatus] = React.useState<UpstreamReleaseCheckStatus>('checking');
  const [data, setData] = React.useState<UpstreamReleasesResponse | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  const inFlightRef = React.useRef<Promise<void> | null>(null);
  const mountedRef = React.useRef(true);
  const pollMs = options.pollMs ?? UPSTREAM_RELEASE_POLL_MS;
  const getterRef = React.useRef(
    options.getUpdates ??
      ((signal?: AbortSignal) => api.upstreamReleases({ signal, cache: 'no-store' })),
  );
  getterRef.current =
    options.getUpdates ??
    ((signal?: AbortSignal) => api.upstreamReleases({ signal, cache: 'no-store' }));

  const checkNow = React.useCallback((): Promise<void> => {
    if (inFlightRef.current) return inFlightRef.current;
    let task: Promise<void>;
    task = (async () => {
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const response = await getterRef.current(controller.signal);
        if (!mountedRef.current || controller.signal.aborted) return;
        setData(response);
        setStatus('ready');
      } catch {
        if (!mountedRef.current || controller.signal.aborted) return;
        // Do not keep advertising a prior observation after the authenticated
        // backend endpoint itself becomes unavailable. The backend may explicitly
        // return typed last-known-good data with `stale: true`; an untyped network
        // failure has no equivalent provenance and therefore clears the shell data.
        setData(null);
        setStatus('unavailable');
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    })().finally(() => {
      if (inFlightRef.current === task) inFlightRef.current = null;
    });
    inFlightRef.current = task;
    return task;
  }, []);

  React.useEffect(() => {
    mountedRef.current = true;
    void checkNow();
    const interval = pollMs > 0
      ? window.setInterval(() => {
          if (document.visibilityState === 'visible') void checkNow();
        }, pollMs)
      : undefined;
    const onFocus = () => void checkNow();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void checkNow();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
      inFlightRef.current = null;
      if (interval !== undefined) window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [checkNow, pollMs]);

  return { status, data, checkNow };
}
