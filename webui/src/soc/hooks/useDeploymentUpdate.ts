import * as React from 'react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import {
  activateDeployedRelease,
  DEPLOYMENT_ACTIVATION_QUERY,
  DEPLOYMENT_UPDATE_POLL_MS,
  DEPLOYMENT_UPDATE_TIMEOUT_MS,
  deployedReleaseIsReady,
  fetchDeployedReleaseManifest,
  sameDeployment,
  type ActivationDependencies,
  type DeployedReleaseManifest,
} from '@/lib/deployment-update';
import { CONSOLE_RELEASE_IDENTITY } from '@/lib/release';
import type { BuildInfoResponse, HealthResponse } from '@/lib/types';

export type DeploymentCheckStatus =
  | 'checking'
  | 'current'
  | 'available'
  | 'incoherent'
  | 'unavailable';

export interface DeploymentUpdateState {
  status: DeploymentCheckStatus;
  buildInfo: BuildInfoResponse | null;
  target: DeployedReleaseManifest | null;
  activating: boolean;
  checkNow: () => Promise<void>;
  activate: () => Promise<void>;
}

export interface DeploymentUpdateOptions {
  fetcher?: typeof fetch;
  getBuildInfo?: (signal?: AbortSignal) => Promise<BuildInfoResponse>;
  getHealth?: (signal?: AbortSignal) => Promise<HealthResponse>;
  navigate?: ActivationDependencies['navigate'];
  currentUrl?: string;
  pollMs?: number;
  timeoutMs?: number;
}

function cleanActivationQuery(): void {
  if (typeof window === 'undefined') return;
  const current = new URL(window.location.href);
  if (!current.searchParams.has(DEPLOYMENT_ACTIVATION_QUERY)) return;
  current.searchParams.delete(DEPLOYMENT_ACTIVATION_QUERY);
  window.history.replaceState(window.history.state, '', current.toString());
}

/** Poll a tiny no-store manifest; never interrupt the current Console on failure. */
export function useDeploymentUpdate(
  options: DeploymentUpdateOptions = {},
): DeploymentUpdateState {
  const pollMs = options.pollMs ?? DEPLOYMENT_UPDATE_POLL_MS;
  const [status, setStatus] = React.useState<DeploymentCheckStatus>('checking');
  const [buildInfo, setBuildInfo] = React.useState<BuildInfoResponse | null>(null);
  const [target, setTarget] = React.useState<DeployedReleaseManifest | null>(null);
  const [activating, setActivating] = React.useState(false);
  const mountedRef = React.useRef(true);
  const inFlightRef = React.useRef<Promise<void> | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  const dependenciesRef = React.useRef({
    fetcher: options.fetcher ?? globalThis.fetch,
    getBuildInfo:
      options.getBuildInfo ??
      ((signal?: AbortSignal) => api.buildInfo({ signal, cache: 'no-store' })),
    getHealth:
      options.getHealth ??
      ((signal?: AbortSignal) => api.health({ signal, cache: 'no-store' })),
    navigate: options.navigate,
    currentUrl: options.currentUrl,
    timeoutMs: options.timeoutMs ?? DEPLOYMENT_UPDATE_TIMEOUT_MS,
  });
  dependenciesRef.current = {
    fetcher: options.fetcher ?? globalThis.fetch,
    getBuildInfo:
      options.getBuildInfo ??
      ((signal?: AbortSignal) => api.buildInfo({ signal, cache: 'no-store' })),
    getHealth:
      options.getHealth ??
      ((signal?: AbortSignal) => api.health({ signal, cache: 'no-store' })),
    navigate: options.navigate,
    currentUrl: options.currentUrl,
    timeoutMs: options.timeoutMs ?? DEPLOYMENT_UPDATE_TIMEOUT_MS,
  };

  const checkNow = React.useCallback((): Promise<void> => {
    const { fetcher, getBuildInfo, getHealth, timeoutMs } = dependenciesRef.current;
    if (
      typeof getBuildInfo !== 'function' ||
      typeof getHealth !== 'function' ||
      typeof fetcher !== 'function'
    ) {
      setStatus('unavailable');
      return Promise.resolve();
    }
    if (inFlightRef.current) return inFlightRef.current;
    let task: Promise<void>;
    task = (async () => {
      const controller = new AbortController();
      abortRef.current = controller;
      let timeout = 0;
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = window.setTimeout(() => {
          controller.abort('deadline');
          reject(new Error('Deployment discovery timed out.'));
        }, timeoutMs);
      });
      try {
        const backendPromise = getBuildInfo(controller.signal).then((value) => {
          // Release-badge provenance is independently useful even when manifest or
          // readiness discovery fails. Ignore only superseded/aborted requests.
          if (
            mountedRef.current &&
            abortRef.current === controller &&
            !controller.signal.aborted
          ) {
            setBuildInfo(value);
          }
          return value;
        });
        const [manifestResult, backendResult, healthResult] = await Promise.race([
          Promise.allSettled([
            fetchDeployedReleaseManifest(fetcher, controller.signal),
            backendPromise,
            getHealth(controller.signal),
          ]),
          deadline,
        ]);
        if (controller.signal.reason === 'cleanup' || !mountedRef.current) return;
        if (backendResult.status === 'fulfilled') setBuildInfo(backendResult.value);
        if (
          manifestResult.status === 'rejected' ||
          backendResult.status === 'rejected' ||
          healthResult.status === 'rejected'
        ) {
          setTarget(null);
          setStatus('unavailable');
          return;
        }
        const manifest = manifestResult.value;
        const backend = backendResult.value;
        const health = healthResult.value;
        setBuildInfo(backend);
        if (sameDeployment(manifest, CONSOLE_RELEASE_IDENTITY)) {
          setTarget(null);
          setStatus('current');
        } else if (deployedReleaseIsReady(manifest, backend, health)) {
          setTarget(manifest);
          setStatus('available');
        } else {
          setTarget(null);
          setStatus('incoherent');
        }
      } catch {
        if (controller.signal.reason === 'cleanup' || !mountedRef.current) return;
        setTarget(null);
        setStatus('unavailable');
      } finally {
        window.clearTimeout(timeout);
        if (abortRef.current === controller) abortRef.current = null;
      }
    })().finally(() => {
      if (inFlightRef.current === task) inFlightRef.current = null;
    });
    inFlightRef.current = task;
    return task;
  }, []);

  const activate = React.useCallback(async () => {
    const { fetcher, getBuildInfo, getHealth, navigate, currentUrl, timeoutMs } =
      dependenciesRef.current;
    if (
      !target ||
      typeof getBuildInfo !== 'function' ||
      typeof getHealth !== 'function' ||
      activating
    ) return;
    setActivating(true);
    try {
      await activateDeployedRelease(target, {
        fetcher,
        getBuildInfo,
        getHealth,
        navigate,
        currentUrl,
        timeoutMs,
      });
      // A native beforeunload guard may cancel navigation. Restore the action if
      // this document is still alive after that choice.
      window.setTimeout(() => {
        if (mountedRef.current) setActivating(false);
      }, 1_500);
    } catch (error) {
      if (mountedRef.current) setActivating(false);
      toast.error(error instanceof Error ? error.message : 'The update could not be prepared.');
      void checkNow();
    }
  }, [activating, checkNow, target]);

  React.useEffect(() => {
    mountedRef.current = true;
    cleanActivationQuery();
    void checkNow();
    const interval = pollMs > 0
      ? window.setInterval(() => {
          if (document.visibilityState === 'visible') void checkNow();
        }, pollMs)
      : undefined;
    const onFocus = () => void checkNow();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void checkNow();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort('cleanup');
      abortRef.current = null;
      // React Strict Mode immediately re-runs this effect after cleanup. Let that
      // second mount start a fresh request instead of inheriting the aborted one.
      inFlightRef.current = null;
      if (interval !== undefined) window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [checkNow, pollMs]);

  return { status, buildInfo, target, activating, checkNow, activate };
}
