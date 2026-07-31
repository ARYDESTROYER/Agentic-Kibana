import { describe, expect, it, vi } from 'vitest';

import {
  activateDeployedRelease,
  deployedReleaseIsReady,
  deployedReleaseMatchesBackend,
  fetchDeployedReleaseManifest,
  parseDeployedReleaseManifest,
  sameDeployment,
  type DeployedReleaseManifest,
} from '@/lib/deployment-update';
import type { BuildInfoResponse, HealthResponse } from '@/lib/types';

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

const health: HealthResponse = {
  status: 'ok',
  version: '0.1.2',
  es_connected: true,
  store_type: 'postgres',
  setup_complete: true,
};

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('deployed release manifest', () => {
  it('accepts the exact bounded Agentic SOC schema', () => {
    expect(parseDeployedReleaseManifest(target)).toEqual(target);
  });

  it.each([
    null,
    {},
    { ...target, schema: 2 },
    { ...target, product: 'another-app' },
    { ...target, channel: 'main' },
    { ...target, version: '' },
    { ...target, buildTime: 'x'.repeat(161) },
  ])('rejects malformed or foreign metadata %#', (value) => {
    expect(parseDeployedReleaseManifest(value)).toBeNull();
  });

  it('compares the complete deployed build rather than SemVer alone', () => {
    expect(sameDeployment(target, target)).toBe(true);
    expect(sameDeployment(target, { ...target, commitSha: 'different' })).toBe(false);
    expect(sameDeployment(target, { ...target, buildTime: 'later' })).toBe(false);
  });

  it('requires an exact, provenance-stamped backend match and ready release', () => {
    expect(deployedReleaseMatchesBackend(target, backend)).toBe(true);
    expect(deployedReleaseMatchesBackend(target, { ...backend, commit_sha: 'other' })).toBe(false);
    expect(deployedReleaseMatchesBackend({ ...target, commitSha: 'unknown' }, backend)).toBe(false);
    expect(deployedReleaseMatchesBackend(target, { ...backend, commit_sha: 'unknown' })).toBe(false);
    expect(deployedReleaseMatchesBackend({ ...target, buildTime: 'unknown' }, backend)).toBe(false);
    expect(deployedReleaseMatchesBackend(target, { ...backend, build_time: 'unknown' })).toBe(false);
    expect(
      deployedReleaseMatchesBackend(target, {
        ...backend,
        build_time: '2026-07-31T08:00:01Z',
      }),
    ).toBe(false);
    expect(deployedReleaseIsReady(target, backend, health)).toBe(true);
    expect(deployedReleaseIsReady(target, backend, { ...health, status: 'degraded' })).toBe(false);
    expect(deployedReleaseIsReady(target, backend, { ...health, version: '0.1.1' })).toBe(false);
  });

  it('uses same-origin no-store discovery and fails closed on a SPA fallback', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(target));
    await expect(fetchDeployedReleaseManifest(fetcher)).resolves.toEqual(target);
    expect(fetcher).toHaveBeenCalledWith(
      '/release.json',
      expect.objectContaining({ cache: 'no-store', credentials: 'same-origin' }),
    );

    fetcher.mockResolvedValueOnce(
      new Response('<div id="root"></div>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    );
    await expect(fetchDeployedReleaseManifest(fetcher)).rejects.toThrow(/unexpected format/i);
  });
});

describe('deployed release activation', () => {
  it('rechecks manifest, backend, readiness, and entry HTML before preserving the route', async () => {
    const navigate = vi.fn();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(target))
      .mockResolvedValueOnce(
        new Response(
          `<!doctype html><html><head><meta name="tlsoc-release" content="${target.entryId}"></head><body><div id="root"></div></body></html>`,
          {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
          },
        ),
      );

    await activateDeployedRelease(target, {
      fetcher,
      getBuildInfo: async () => backend,
      getHealth: async () => health,
      navigate,
      currentUrl: 'https://soc.example.test/#/cases?s=active',
    });

    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/index.html?__tlsoc_release='),
      expect.objectContaining({ cache: 'no-store', credentials: 'same-origin' }),
    );
    expect(navigate).toHaveBeenCalledOnce();
    const next = new URL(navigate.mock.calls[0][0]);
    expect(next.hash).toBe('#/cases?s=active');
    expect(next.searchParams.get('__tlsoc_release')).toContain('0.1.2');
  });

  it('keeps the current Console mounted when the offered target changes', async () => {
    const navigate = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      ...target,
      buildTime: '2026-07-31T08:01:00Z',
    }));

    await expect(
      activateDeployedRelease(target, {
        fetcher,
        getBuildInfo: async () => backend,
        getHealth: async () => health,
        navigate,
        currentUrl: 'https://soc.example.test/#/overview',
      }),
    ).rejects.toThrow(/different release finished deploying/i);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('treats a changed entry marker as a different offered target', async () => {
    const navigate = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      ...target,
      entryId: 'different-static-entry',
    }));

    await expect(
      activateDeployedRelease(target, {
        fetcher,
        getBuildInfo: async () => backend,
        getHealth: async () => health,
        navigate,
        currentUrl: 'https://soc.example.test/#/overview',
      }),
    ).rejects.toThrow(/different release finished deploying/i);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not navigate when backend readiness fails', async () => {
    const navigate = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(target));
    await expect(
      activateDeployedRelease(target, {
        fetcher,
        getBuildInfo: async () => backend,
        getHealth: async () => ({ ...health, status: 'degraded' }),
        navigate,
        currentUrl: 'https://soc.example.test/#/overview',
      }),
    ).rejects.toThrow(/not ready as one coherent update/i);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not navigate when index.html belongs to a different Web build', async () => {
    const navigate = vi.fn();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(target))
      .mockResolvedValueOnce(
        new Response(
          '<!doctype html><html><head><meta name="tlsoc-release" content="other"></head><body><div id="root"></div></body></html>',
          { status: 200, headers: { 'Content-Type': 'text/html' } },
        ),
      );

    await expect(
      activateDeployedRelease(target, {
        fetcher,
        getBuildInfo: async () => backend,
        getHealth: async () => health,
        navigate,
        currentUrl: 'https://soc.example.test/#/overview',
      }),
    ).rejects.toThrow(/entry point failed validation/i);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('times out a hung backend preflight without navigating', async () => {
    const navigate = vi.fn();
    const never = new Promise<BuildInfoResponse>(() => undefined);
    await expect(
      activateDeployedRelease(target, {
        fetcher: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(target)),
        getBuildInfo: async () => never,
        getHealth: async () => health,
        navigate,
        currentUrl: 'https://soc.example.test/#/overview',
        timeoutMs: 5,
      }),
    ).rejects.toThrow(/preflight timed out/i);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('times out a non-cooperative entry-document fetch without navigating', async () => {
    const navigate = vi.fn();
    const never = new Promise<Response>(() => undefined);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(target))
      .mockImplementationOnce(async () => never);

    await expect(
      activateDeployedRelease(target, {
        fetcher,
        getBuildInfo: async () => backend,
        getHealth: async () => health,
        navigate,
        currentUrl: 'https://soc.example.test/#/overview',
        timeoutMs: 5,
      }),
    ).rejects.toThrow(/preflight timed out/i);
    expect(navigate).not.toHaveBeenCalled();
  });
});
