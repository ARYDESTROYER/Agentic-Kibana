import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DeployedReleaseManifest } from '@/lib/deployment-update';
import type { BuildInfoResponse, HealthResponse } from '@/lib/types';
import { useDeploymentUpdate } from '@/soc/hooks/useDeploymentUpdate';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const target: DeployedReleaseManifest = {
  schema: 1,
  product: 'agentic-soc',
  version: '0.1.2',
  channel: 'testing',
  commitSha: 'abc123',
  buildTime: '2026-07-31T08:00:00Z',
  entryId: '0.1.2-testing-abc123-2026-07-31T08_00_00Z',
};
const backend: BuildInfoResponse = {
  service: 'tlsoc-agentic-triage',
  version: '0.1.2',
  release_channel: 'testing',
  commit_sha: 'abc123',
  build_time: '2026-07-31T08:00:00Z',
  state_backend: 'postgres',
  ocsf_version: '1.4.0',
};
const health: HealthResponse = { status: 'ok', version: '0.1.2' };

function manifestFetch(value: unknown = target): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('useDeploymentUpdate', () => {
  it('offers only a coherent deployed pair and rechecks on focus', async () => {
    const fetcher = manifestFetch();
    const getBuildInfo = vi.fn(async () => backend);
    const getHealth = vi.fn(async () => health);
    const { result } = renderHook(() =>
      useDeploymentUpdate({ fetcher, getBuildInfo, getHealth, pollMs: 0 }),
    );

    await waitFor(() => expect(result.current.status).toBe('available'));
    expect(result.current.target).toEqual(target);

    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(getBuildInfo).toHaveBeenCalledTimes(2);
  });

  it('fails quietly and leaves no activation target when discovery is unavailable', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() =>
      useDeploymentUpdate({
        fetcher,
        getBuildInfo: async () => backend,
        getHealth: async () => health,
        pollMs: 0,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current.target).toBeNull();
  });

  it('keeps successful backend provenance for the release badge when discovery fails', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('manifest unavailable'));
    const { result } = renderHook(() =>
      useDeploymentUpdate({
        fetcher,
        getBuildInfo: async () => backend,
        getHealth: async () => health,
        pollMs: 0,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current.buildInfo).toEqual(backend);
  });

  it('reports a partial deployment as incoherent without offering an update', async () => {
    const { result } = renderHook(() =>
      useDeploymentUpdate({
        fetcher: manifestFetch(),
        getBuildInfo: async () => ({ ...backend, commit_sha: 'other' }),
        getHealth: async () => health,
        pollMs: 0,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe('incoherent'));
    expect(result.current.target).toBeNull();
  });

  it('recovers the initial check across a Strict Mode effect replay', async () => {
    const first = new Promise<Response>((_resolve, reject) => {
      window.setTimeout(() => reject(new DOMException('Aborted', 'AbortError')), 0);
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(first)
      .mockResolvedValue(
        new Response(JSON.stringify(target), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    const { result } = renderHook(
      () =>
        useDeploymentUpdate({
          fetcher,
          getBuildInfo: async () => backend,
          getHealth: async () => health,
          pollMs: 0,
        }),
      { wrapper: StrictMode },
    );

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.status).toBe('available'));
  });

  it('fails quietly when a backend discovery call never settles', async () => {
    const never = new Promise<BuildInfoResponse>(() => undefined);
    const { result } = renderHook(() =>
      useDeploymentUpdate({
        fetcher: manifestFetch(),
        getBuildInfo: async () => never,
        getHealth: async () => health,
        pollMs: 0,
        timeoutMs: 5,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current.target).toBeNull();
  });
});
