/**
 * Build-time release identity for Agentic SOC.
 *
 * This module is evaluated by Vite/Vitest in Node. Nothing here is imported by the
 * browser bundle, and it never asks Git what branch is checked out. Promotion is an
 * explicit build input: only TLSOC_RELEASE_CHANNEL=stable produces a Stable bundle;
 * every missing, branch-like, or unknown value fails safe to Testing.
 */
import packageJson from './package.json';

export type BuildReleaseChannel = 'testing' | 'stable';

export interface BuildReleaseIdentity {
  version: string;
  channel: BuildReleaseChannel;
  commitSha: string;
  buildTime: string;
}

/**
 * Public, deterministic identifier shared by release.json and the emitted SPA entry.
 * It is not a signature; its purpose is to prove those two static artifacts came from
 * the same Web build during the final activation preflight.
 */
export function releaseEntryId(identity: BuildReleaseIdentity): string {
  return [identity.version, identity.channel, identity.commitSha, identity.buildTime]
    .join('-')
    .replace(/[^0-9A-Za-z._-]/g, '_')
    .slice(0, 160);
}

function clean(value: string | undefined): string {
  return (value || '').trim();
}

export function normalizeBuildReleaseChannel(value: string | undefined): BuildReleaseChannel {
  return clean(value).toLowerCase() === 'stable' ? 'stable' : 'testing';
}

function packageVersion(): string {
  if (typeof packageJson.version !== 'string' || !packageJson.version.trim()) {
    throw new Error('webui/package.json must contain the canonical product version');
  }
  return packageJson.version.trim();
}

export function resolveBuildReleaseIdentity(
  environment: NodeJS.ProcessEnv = process.env,
): BuildReleaseIdentity {
  const canonicalVersion = packageVersion();
  const configuredVersion = clean(environment.TLSOC_VERSION);

  // Docker's safe ARG fallback is "unknown". Any real but different version is a
  // packaging error: never let an image label and the visible Console badge disagree.
  if (
    configuredVersion &&
    configuredVersion.toLowerCase() !== 'unknown' &&
    configuredVersion !== canonicalVersion
  ) {
    throw new Error(
      `TLSOC_VERSION=${configuredVersion} does not match webui/package.json ${canonicalVersion}`,
    );
  }

  return {
    version: canonicalVersion,
    channel: normalizeBuildReleaseChannel(environment.TLSOC_RELEASE_CHANNEL),
    commitSha: clean(environment.TLSOC_BUILD_SHA) || 'unknown',
    buildTime: clean(environment.TLSOC_BUILD_DATE) || 'unknown',
  };
}
