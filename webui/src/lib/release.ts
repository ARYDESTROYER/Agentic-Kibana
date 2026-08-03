/**
 * Browser-side release identity contract.
 *
 * `__TLSOC_RELEASE_IDENTITY__` is injected by Vite at BUILD time. The browser never
 * reads Git or guesses a channel from SemVer. Backend build-info is then reconciled
 * with that immutable Console identity; disagreement can only downgrade the visible
 * channel to Testing, never upgrade an integration artifact to Stable.
 */

export type ReleaseChannel = 'testing' | 'stable';

export interface ReleaseIdentity {
  version: string;
  channel: ReleaseChannel;
  commitSha: string;
  buildTime: string;
}

export interface RuntimeBuildInfo {
  version: string;
  release_channel: string;
  commit_sha: string;
  build_time: string;
}

export interface ReleasePresentation {
  version: string;
  channel: ReleaseChannel;
  channelLabel: 'Testing' | 'Stable';
  contextLabel: 'Pre-release integration build' | 'Stable main build';
  console: ReleaseIdentity;
  backend: ReleaseIdentity | null;
  mismatch: boolean;
  /** False when either visible build identity lacks a commit or build-time stamp. */
  provenanceComplete: boolean;
}

function text(value: unknown, fallback = 'unknown'): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

/** Only an explicit `stable` stamp is Stable. `main`, SemVer, and unknowns are not. */
export function normalizeReleaseChannel(value: unknown): ReleaseChannel {
  return typeof value === 'string' && value.trim().toLowerCase() === 'stable'
    ? 'stable'
    : 'testing';
}

function normalizeIdentity(value: {
  version?: unknown;
  channel?: unknown;
  commitSha?: unknown;
  buildTime?: unknown;
}): ReleaseIdentity {
  return {
    version: text(value.version, '0.0.0'),
    channel: normalizeReleaseChannel(value.channel),
    commitSha: text(value.commitSha),
    buildTime: text(value.buildTime),
  };
}

function identityHasProvenance(identity: ReleaseIdentity): boolean {
  return (
    identity.commitSha.trim().toLowerCase() !== 'unknown' &&
    identity.buildTime.trim().toLowerCase() !== 'unknown'
  );
}

export const CONSOLE_RELEASE_IDENTITY: Readonly<ReleaseIdentity> = Object.freeze(
  normalizeIdentity(__TLSOC_RELEASE_IDENTITY__),
);

export function resolveReleasePresentation(
  consoleIdentity: ReleaseIdentity,
  backendInfo?: RuntimeBuildInfo | null,
): ReleasePresentation {
  const consoleBuild = normalizeIdentity(consoleIdentity);
  const backendBuild = backendInfo
    ? normalizeIdentity({
        version: backendInfo.version,
        channel: backendInfo.release_channel,
        commitSha: backendInfo.commit_sha,
        buildTime: backendInfo.build_time,
      })
    : null;

  const knownShaMismatch = Boolean(
    backendBuild &&
      consoleBuild.commitSha !== 'unknown' &&
      backendBuild.commitSha !== 'unknown' &&
      consoleBuild.commitSha !== backendBuild.commitSha,
  );
  const mismatch = Boolean(
    backendBuild &&
      (consoleBuild.version !== backendBuild.version ||
        consoleBuild.channel !== backendBuild.channel ||
        knownShaMismatch),
  );
  const provenanceComplete = Boolean(
    identityHasProvenance(consoleBuild) &&
      (!backendBuild || identityHasProvenance(backendBuild)),
  );

  // A runtime pair is Stable only when BOTH halves say Stable and their known
  // provenance is complete and agrees. Before build-info resolves, a fully stamped
  // immutable Console identity may still be shown as Stable; an incomplete stamp or
  // later mismatch always downgrades it to Testing.
  const channel: ReleaseChannel =
    consoleBuild.channel === 'stable' &&
    provenanceComplete &&
    (!backendBuild ||
      (backendBuild.channel === 'stable' &&
        backendBuild.version === consoleBuild.version &&
        !knownShaMismatch))
      ? 'stable'
      : 'testing';

  return {
    version: consoleBuild.version,
    channel,
    channelLabel: channel === 'stable' ? 'Stable' : 'Testing',
    contextLabel:
      channel === 'stable' ? 'Stable main build' : 'Pre-release integration build',
    console: consoleBuild,
    backend: backendBuild,
    mismatch,
    provenanceComplete,
  };
}
