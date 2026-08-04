import { describe, expect, it } from 'vitest';

import packageJson from '../../../package.json';
import {
  normalizeBuildReleaseChannel,
  resolveBuildReleaseIdentity,
} from '../../../release.config';
import {
  normalizeReleaseChannel,
  resolveReleasePresentation,
  type ReleaseIdentity,
} from '../release';

const canonicalVersion = packageJson.version;

const consoleBuild = (partial: Partial<ReleaseIdentity> = {}): ReleaseIdentity => ({
  version: canonicalVersion,
  channel: 'testing',
  commitSha: 'abc123',
  buildTime: '2026-07-20T10:00:00Z',
  ...partial,
});

describe('build release identity', () => {
  it('requires an explicit stable value; branch-like and unknown values are Testing', () => {
    expect(normalizeBuildReleaseChannel('stable')).toBe('stable');
    expect(normalizeBuildReleaseChannel('Stable')).toBe('stable');
    expect(normalizeBuildReleaseChannel('main')).toBe('testing');
    expect(normalizeBuildReleaseChannel('preview')).toBe('testing');
    expect(normalizeBuildReleaseChannel(undefined)).toBe('testing');
  });

  it('uses the canonical package version and stamps supplied provenance', () => {
    expect(
      resolveBuildReleaseIdentity({
        TLSOC_VERSION: canonicalVersion,
        TLSOC_RELEASE_CHANNEL: 'stable',
        TLSOC_BUILD_SHA: 'abc123',
        TLSOC_BUILD_DATE: '2026-07-20T10:00:00Z',
      }),
    ).toEqual({
      version: canonicalVersion,
      channel: 'stable',
      commitSha: 'abc123',
      buildTime: '2026-07-20T10:00:00Z',
    });
  });

  it('fails the build when a real configured version drifts from package.json', () => {
    expect(() => resolveBuildReleaseIdentity({ TLSOC_VERSION: '9.9.9' })).toThrow(
      /does not match webui\/package\.json/,
    );
  });
});

describe('runtime release presentation', () => {
  it('normalizes only explicit stable as Stable', () => {
    expect(normalizeReleaseChannel('stable')).toBe('stable');
    expect(normalizeReleaseChannel('main')).toBe('testing');
    expect(normalizeReleaseChannel(undefined)).toBe('testing');
  });

  it('shows Stable when Console and backend stable provenance agree', () => {
    const result = resolveReleasePresentation(consoleBuild({ channel: 'stable' }), {
      version: canonicalVersion,
      release_channel: 'stable',
      commit_sha: 'abc123',
      build_time: '2026-07-20T10:00:00Z',
    });
    expect(result.channelLabel).toBe('Stable');
    expect(result.contextLabel).toBe('Stable main build');
    expect(result.mismatch).toBe(false);
    expect(result.provenanceComplete).toBe(true);
  });

  it('downgrades a Stable Console when backend channel or commit differs', () => {
    const result = resolveReleasePresentation(consoleBuild({ channel: 'stable' }), {
      version: canonicalVersion,
      release_channel: 'testing',
      commit_sha: 'different',
      build_time: '2026-07-20T10:00:00Z',
    });
    expect(result.channelLabel).toBe('Testing');
    expect(result.contextLabel).toBe('Pre-release integration build');
    expect(result.mismatch).toBe(true);
  });

  it('never presents an unstamped build as Stable', () => {
    const result = resolveReleasePresentation(
      consoleBuild({ channel: 'stable', commitSha: 'unknown', buildTime: 'unknown' }),
      {
        version: canonicalVersion,
        release_channel: 'stable',
        commit_sha: 'unknown',
        build_time: 'unknown',
      },
    );
    expect(result.channelLabel).toBe('Testing');
    expect(result.provenanceComplete).toBe(false);
    expect(result.mismatch).toBe(false);
  });
});
