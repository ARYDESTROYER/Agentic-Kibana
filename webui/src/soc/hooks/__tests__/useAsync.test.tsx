/**
 * useAsync — load/error/data state-machine coverage.
 *
 * Pins the contract Coupling-B relies on:
 *   1. success → data set, loading false, error null;
 *   2. failure → error set (the caught value verbatim), data stays null;
 *   3. reload() re-runs fn and clears a prior error on success;
 *   4. a stale in-flight result is discarded when a newer request supersedes it (race-safe).
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

import { useAsync } from '../useAsync';

describe('useAsync', () => {
  it('resolves to data with loading false and no error', async () => {
    const { result } = renderHook(() => useAsync(() => Promise.resolve(42), []));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBe(42);
    expect(result.current.error).toBeNull();
  });

  it('captures a rejection as error and leaves data null', async () => {
    const boom = new Error('nope');
    const { result } = renderHook(() => useAsync(() => Promise.reject(boom), []));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe(boom);
    expect(result.current.data).toBeNull();
  });

  it('reload() re-runs fn and clears a prior error on success', async () => {
    let attempt = 0;
    const fn = vi.fn(() =>
      attempt++ === 0 ? Promise.reject(new Error('first')) : Promise.resolve('ok'),
    );
    const { result } = renderHook(() => useAsync(fn, []));
    await waitFor(() => expect(result.current.error).toBeTruthy());

    await act(async () => {
      await result.current.reload();
    });
    expect(result.current.error).toBeNull();
    expect(result.current.data).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('discards a stale in-flight result (race-safe)', async () => {
    // First call resolves LATE with a stale value; reload resolves fast with the winner.
    let resolveSlow: (v: string) => void = () => {};
    let call = 0;
    const fn = vi.fn(() => {
      call += 1;
      if (call === 1) {
        return new Promise<string>((res) => {
          resolveSlow = res;
        });
      }
      return Promise.resolve('fresh');
    });
    const { result } = renderHook(() => useAsync(fn, []));

    await act(async () => {
      await result.current.reload(); // second request wins
    });
    expect(result.current.data).toBe('fresh');

    // Now the stale first request settles — it must NOT overwrite the fresh value.
    await act(async () => {
      resolveSlow('stale');
      await Promise.resolve();
    });
    expect(result.current.data).toBe('fresh');
  });
});
