import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useUpstreamReleaseUpdates } from '@/soc/hooks/useUpstreamReleaseUpdates';
import type { UpstreamReleasesResponse } from '@/lib/types';

const result: UpstreamReleasesResponse = {
  enabled: false,
  repository_url: 'https://github.com/example/repo',
  checked_at: null,
  cache: { hit: false, stale: false, max_age_seconds: 21_600 },
  channels: {
    stable: {
      channel: 'stable', branch: 'main', state: 'disabled', version: null,
      commit_sha: null, commit_url: null, source_url: null, checked_at: null,
      stale: false, error_code: null, error_message: null,
    },
    testing: {
      channel: 'testing', branch: 'Testing', state: 'disabled', version: null,
      commit_sha: null, commit_url: null, source_url: null, checked_at: null,
      stale: false, error_code: null, error_message: null,
    },
  },
};

afterEach(() => vi.useRealTimers());

describe('useUpstreamReleaseUpdates', () => {
  it('loads cached backend metadata without contacting an upstream in the browser', async () => {
    const getUpdates = vi.fn().mockResolvedValue(result);
    const { result: hook } = renderHook(() =>
      useUpstreamReleaseUpdates({ getUpdates, pollMs: 0 }),
    );
    await waitFor(() => expect(hook.current.status).toBe('ready'));
    expect(hook.current.data).toEqual(result);
    expect(getUpdates).toHaveBeenCalledOnce();
  });

  it('keeps the running Console usable when discovery fails and allows retry', async () => {
    const getUpdates = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(result);
    const { result: hook } = renderHook(() =>
      useUpstreamReleaseUpdates({ getUpdates, pollMs: 0 }),
    );
    await waitFor(() => expect(hook.current.status).toBe('unavailable'));
    await act(() => hook.current.checkNow());
    expect(hook.current.status).toBe('ready');
    expect(hook.current.data).toEqual(result);
  });

  it('coalesces concurrent manual checks', async () => {
    let resolve!: (value: UpstreamReleasesResponse) => void;
    const getUpdates = vi.fn(() => new Promise<UpstreamReleasesResponse>((done) => {
      resolve = done;
    }));
    const { result: hook } = renderHook(() =>
      useUpstreamReleaseUpdates({ getUpdates, pollMs: 0 }),
    );
    const first = hook.current.checkNow();
    const second = hook.current.checkNow();
    expect(first).toBe(second);
    expect(getUpdates).toHaveBeenCalledOnce();
    resolve(result);
    await act(() => first);
  });

  it('clears an old observation when the authenticated backend check fails', async () => {
    const getUpdates = vi
      .fn()
      .mockResolvedValueOnce(result)
      .mockRejectedValueOnce(new Error('backend unavailable'));
    const { result: hook } = renderHook(() =>
      useUpstreamReleaseUpdates({ getUpdates, pollMs: 0 }),
    );
    await waitFor(() => expect(hook.current.status).toBe('ready'));
    expect(hook.current.data).toEqual(result);

    await act(() => hook.current.checkNow());
    expect(hook.current.status).toBe('unavailable');
    expect(hook.current.data).toBeNull();
  });
});
