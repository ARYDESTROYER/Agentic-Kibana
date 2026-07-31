/**
 * Fail-safe deployed-release discovery for the running Console.
 *
 * The browser is never a deployment authority. It only observes a static manifest
 * emitted with the already-deployed Web build, verifies that manifest against the
 * public backend build identity, and then offers to reload into that coherent pair.
 */
import type { BuildInfoResponse, HealthResponse } from '@/lib/types';
import {
  normalizeReleaseChannel,
  type ReleaseChannel,
  type ReleaseIdentity,
} from '@/lib/release';

export const DEPLOYED_RELEASE_MANIFEST_PATH = '/release.json';
export const DEPLOYMENT_UPDATE_POLL_MS = 60_000;
export const DEPLOYMENT_UPDATE_TIMEOUT_MS = 5_000;
export const DEPLOYMENT_ACTIVATION_QUERY = '__tlsoc_release';

export interface DeployedReleaseManifest extends ReleaseIdentity {
  schema: 1;
  product: 'agentic-soc';
  /** Must match the marker embedded in the deployed index.html. */
  entryId: string;
}

const MAX_RELEASE_VALUE_LENGTH = 160;

function boundedText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > MAX_RELEASE_VALUE_LENGTH) return null;
  return cleaned;
}

/** Strictly parse untrusted, same-origin deployment metadata. */
export function parseDeployedReleaseManifest(value: unknown): DeployedReleaseManifest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const version = boundedText(record.version);
  const commitSha = boundedText(record.commitSha);
  const buildTime = boundedText(record.buildTime);
  const entryId = boundedText(record.entryId);
  if (
    record.schema !== 1 ||
    record.product !== 'agentic-soc' ||
    !version ||
    !commitSha ||
    !buildTime ||
    !entryId ||
    !/^[0-9A-Za-z._-]+$/.test(entryId) ||
    (record.channel !== 'testing' && record.channel !== 'stable')
  ) {
    return null;
  }
  return {
    schema: 1,
    product: 'agentic-soc',
    version,
    channel: record.channel,
    commitSha,
    buildTime,
    entryId,
  };
}

export function sameDeployment(
  left: Pick<ReleaseIdentity, 'version' | 'channel' | 'commitSha' | 'buildTime'>,
  right: Pick<ReleaseIdentity, 'version' | 'channel' | 'commitSha' | 'buildTime'>,
): boolean {
  return (
    left.version === right.version &&
    left.channel === right.channel &&
    left.commitSha === right.commitSha &&
    left.buildTime === right.buildTime
  );
}

/**
 * A Web manifest is activatable only once the backend reports the same release.
 * Activation fails closed when either half lacks an exact commit stamp; local builds
 * without provenance remain usable, but they never advertise a one-click update.
 */
export function deployedReleaseMatchesBackend(
  target: DeployedReleaseManifest,
  backend: BuildInfoResponse,
): boolean {
  const backendChannel: ReleaseChannel = normalizeReleaseChannel(backend.release_channel);
  return (
    target.version === backend.version &&
    target.channel === backendChannel &&
    target.commitSha !== 'unknown' &&
    backend.commit_sha !== 'unknown' &&
    target.commitSha === backend.commit_sha &&
    target.buildTime !== 'unknown' &&
    backend.build_time !== 'unknown' &&
    target.buildTime === backend.build_time
  );
}

export function deployedReleaseIsReady(
  target: DeployedReleaseManifest,
  backend: BuildInfoResponse,
  health: HealthResponse,
): boolean {
  return (
    deployedReleaseMatchesBackend(target, backend) &&
    health.status === 'ok' &&
    health.version === target.version
  );
}

export async function fetchDeployedReleaseManifest(
  fetcher: typeof fetch = window.fetch.bind(window),
  signal?: AbortSignal,
): Promise<DeployedReleaseManifest> {
  const response = await fetcher(DEPLOYED_RELEASE_MANIFEST_PATH, {
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) throw new Error('The deployed release manifest is unavailable.');
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('application/json')) {
    throw new Error('The deployed release manifest returned an unexpected format.');
  }
  const parsed = parseDeployedReleaseManifest(await response.json());
  if (!parsed) throw new Error('The deployed release manifest is invalid.');
  return parsed;
}

export interface ActivationDependencies {
  fetcher?: typeof fetch;
  getBuildInfo: (signal?: AbortSignal) => Promise<BuildInfoResponse>;
  getHealth: (signal?: AbortSignal) => Promise<HealthResponse>;
  navigate?: (url: string) => void;
  currentUrl?: string;
  timeoutMs?: number;
}

function activationToken(target: DeployedReleaseManifest): string {
  return [target.version, target.channel, target.commitSha.slice(0, 16), target.buildTime]
    .join('-')
    .replace(/[^0-9A-Za-z._-]/g, '_')
    .slice(0, 120);
}

/**
 * Recheck both halves and the SPA entry document immediately before navigation.
 * Any failure throws before location changes, so the running Console remains usable.
 */
export async function activateDeployedRelease(
  expected: DeployedReleaseManifest,
  dependencies: ActivationDependencies,
): Promise<void> {
  const fetcher = dependencies.fetcher ?? window.fetch.bind(window);
  const controller = new AbortController();
  const timeoutMs = dependencies.timeoutMs ?? DEPLOYMENT_UPDATE_TIMEOUT_MS;
  let timeout = 0;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = window.setTimeout(() => {
      controller.abort('deadline');
      reject(new Error('The update preflight timed out. The current Console was not changed.'));
    }, timeoutMs);
  });
  try {
    const preflight = async (): Promise<string> => {
      const [latest, backend, health] = await Promise.all([
        fetchDeployedReleaseManifest(fetcher, controller.signal),
        dependencies.getBuildInfo(controller.signal),
        dependencies.getHealth(controller.signal),
      ]);
      if (!sameDeployment(latest, expected) || latest.entryId !== expected.entryId) {
        throw new Error('A different release finished deploying. Check again before updating.');
      }
      if (!deployedReleaseIsReady(latest, backend, health)) {
        throw new Error('The Console and backend release are not ready as one coherent update.');
      }

      const currentUrl = dependencies.currentUrl ?? window.location.href;
      const current = new URL(currentUrl);
      const token = activationToken(latest);
      const entry = new URL('/index.html', current.origin);
      entry.searchParams.set(DEPLOYMENT_ACTIVATION_QUERY, token);
      const entryResponse = await fetcher(entry.toString(), {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Accept: 'text/html' },
        signal: controller.signal,
      });
      const contentType = entryResponse.headers.get('content-type')?.toLowerCase() ?? '';
      if (!entryResponse.ok || !contentType.includes('text/html')) {
        throw new Error('The deployed Console entry point is not ready.');
      }
      const html = await entryResponse.text();
      const document = new DOMParser().parseFromString(html, 'text/html');
      const entryId = document.querySelector('meta[name="tlsoc-release"]')?.getAttribute('content');
      if (entryId !== latest.entryId || !document.querySelector('#root')) {
        throw new Error('The deployed Console entry point failed validation.');
      }

      current.searchParams.set(DEPLOYMENT_ACTIVATION_QUERY, token);
      return current.toString();
    };

    // The single deadline covers every network and parse step, including a fetch
    // implementation that ignores AbortSignal while serving index.html.
    const destination = await Promise.race([preflight(), deadline]);
    const navigate = dependencies.navigate ?? ((url: string) => window.location.replace(url));
    navigate(destination);
  } finally {
    window.clearTimeout(timeout);
  }
}
