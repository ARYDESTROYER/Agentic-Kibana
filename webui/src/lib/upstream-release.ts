/**
 * Browser presentation helpers for read-only upstream release discovery.
 *
 * The repository is never an activation authority. These helpers only decide whether
 * a successfully observed branch is worth surfacing beside the build badge. The
 * separate same-origin deployment contract remains the only path to an Update action.
 */
import type {
  UpstreamReleaseCandidate,
  UpstreamReleasesResponse,
} from './types';
import type { ReleaseIdentity } from './release';

export type UpstreamNoticeKind = 'version' | 'revision';

export interface UpstreamReleaseNotice {
  kind: UpstreamNoticeKind;
  candidate: UpstreamReleaseCandidate;
}

function semanticVersion(value: string | null | undefined): [number, number, number] | null {
  if (!value) return null;
  // The top bar makes an update claim only for the simple release form used by
  // Agentic SOC. Pre-release/build suffixes remain inspectable in Settings, but
  // need full SemVer precedence handling before they can be ordered confidently.
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (!match) return null;
  const parsed = match.slice(1, 4).map(Number);
  if (parsed.some((part) => !Number.isSafeInteger(part))) return null;
  return parsed as [number, number, number];
}

function compareVersions(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function commitIdentity(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? '';
  // Git abbreviations shorter than seven characters are too collision-prone for
  // a release comparison. GitHub observations are full SHAs; local release stamps
  // may use a normal bounded abbreviation.
  return /^[0-9a-f]{7,64}$/.test(normalized) ? normalized : null;
}

function sameCommit(left: string, right: string): boolean {
  return left === right || left.startsWith(right) || right.startsWith(left);
}

/** Return a truthful source notice for the running channel, or null when uncertain. */
export function upstreamReleaseNotice(
  response: UpstreamReleasesResponse | null,
  current: Pick<ReleaseIdentity, 'version' | 'channel' | 'commitSha'>,
): UpstreamReleaseNotice | null {
  if (!response?.enabled) return null;
  const candidate = response.channels[current.channel];
  // A last-known-good observation stays available in Settings with its failure
  // context, but must not make a fresh availability claim in the global shell.
  if (candidate.state !== 'available' || candidate.stale || !candidate.version) return null;

  const candidateVersion = semanticVersion(candidate.version);
  const currentVersion = semanticVersion(current.version);
  if (candidateVersion && currentVersion) {
    const order = compareVersions(candidateVersion, currentVersion);
    if (order > 0) return { kind: 'version', candidate };
    if (order < 0) return null;
  } else if (candidate.version !== current.version) {
    // An unknown version format is inspectable in Settings, but never promoted into
    // the top bar as a confident update claim.
    return null;
  }

  const sourceSha = commitIdentity(candidate.commit_sha);
  const currentSha = commitIdentity(current.commitSha);
  if (
    sourceSha &&
    currentSha &&
    !sameCommit(sourceSha, currentSha)
  ) {
    return { kind: 'revision', candidate };
  }
  return null;
}
