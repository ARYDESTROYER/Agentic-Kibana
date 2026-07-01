/**
 * useAsync — the ONE load/error/data state machine for a data-fetching surface.
 *
 * Round-5 W0-B B5: promotes the ~29 hand-rolled `{ loading, error, data } + useEffect +
 * cancelled-flag` blocks scattered across the pages into a single hook. The Coupling-B
 * wave migrates pages onto it.
 *
 * Contract:
 *   - `fn` is the async producer; it is re-invoked whenever `deps` change AND on an
 *     explicit `reload()`.
 *   - Returns `{ data, loading, error, reload }`:
 *       · `data`    — the last successful result (kept across a reload so the UI can show
 *                     stale-while-revalidating; `null` until the first success).
 *       · `loading` — true while a fetch is in flight.
 *       · `error`   — the caught value from the latest failed fetch (`null` on success).
 *       · `reload`  — imperatively re-run `fn` (returns the settling promise).
 *   - RACE-SAFE: a stale in-flight result (superseded by a newer deps change or reload)
 *     is discarded — only the most recent request writes state. Unmount is treated the
 *     same way, so no state is set after teardown.
 *
 * `fn` is intentionally NOT in the effect's dep array (callers rarely memoize it); pass a
 * stable `deps` array that captures the real inputs, exactly like a manual `useEffect`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DependencyList } from 'react';

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: unknown;
  /** Re-run `fn`; resolves when the (latest) request settles. */
  reload: () => Promise<void>;
}

export function useAsync<T>(fn: () => Promise<T>, deps: DependencyList = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<unknown>(null);

  // Latest `fn` without forcing it into the dep array (callers rarely memoize it).
  const fnRef = useRef(fn);
  fnRef.current = fn;

  // Monotonic request token; only the newest request is allowed to write state.
  const seqRef = useRef(0);
  const mountedRef = useRef(true);

  const run = useCallback(async () => {
    const seq = (seqRef.current += 1);
    setLoading(true);
    setError(null);
    try {
      const result = await fnRef.current();
      if (mountedRef.current && seq === seqRef.current) {
        setData(result);
        setError(null);
      }
    } catch (e) {
      if (mountedRef.current && seq === seqRef.current) {
        setError(e);
      }
    } finally {
      if (mountedRef.current && seq === seqRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void run();
    return () => {
      // Mark unmounted so a late-settling request never writes state, but bump the seq
      // too so a remount (StrictMode double-invoke) also invalidates the prior run.
      mountedRef.current = false;
      seqRef.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const reload = useCallback(async () => {
    mountedRef.current = true;
    await run();
  }, [run]);

  return { data, loading, error, reload };
}
