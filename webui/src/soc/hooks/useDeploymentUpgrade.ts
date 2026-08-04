import * as React from 'react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api';
import { CONSOLE_RELEASE_IDENTITY, type ReleaseIdentity } from '@/lib/release';
import type {
  SystemUpdateJob,
  SystemUpdatePreflightResponse,
  SystemUpdateReceipt,
  SystemUpdateStage,
  SystemUpdateStatusResponse,
} from '@/lib/types';

export const SYSTEM_UPDATE_IDLE_POLL_MS = 60_000;
export const SYSTEM_UPDATE_ACTIVE_POLL_MS = 2_000;

export type SystemUpdateConnection = 'connected' | 'reconnecting' | 'unavailable';

export interface DeploymentUpgradeState {
  checking: boolean;
  preparing: boolean;
  starting: boolean;
  status: SystemUpdateStatusResponse | null;
  job: SystemUpdateJob | null;
  preflight: SystemUpdatePreflightResponse | null;
  receipt: SystemUpdateReceipt | null;
  error: string | null;
  connection: SystemUpdateConnection;
  progressOpen: boolean;
  needsBrowserActivation: boolean;
  checkNow: () => Promise<void>;
  prepare: () => Promise<void>;
  dismissPreflight: () => void;
  start: () => Promise<void>;
  cancel: () => Promise<void>;
  rollback: () => Promise<void>;
  setProgressOpen: (open: boolean) => void;
}

export interface DeploymentUpgradeDependencies {
  status: (signal?: AbortSignal) => Promise<SystemUpdateStatusResponse>;
  preflight: (releaseId: string, idempotencyKey: string) => Promise<SystemUpdatePreflightResponse>;
  start: (
    releaseId: string,
    preflightToken: string,
    idempotencyKey: string,
  ) => Promise<SystemUpdateJob>;
  job: (jobId: string, signal?: AbortSignal) => Promise<SystemUpdateJob>;
  cancel: (jobId: string, idempotencyKey: string) => Promise<SystemUpdateJob>;
  rollback: (jobId: string, idempotencyKey: string) => Promise<SystemUpdateJob>;
  receipt: (jobId: string) => Promise<SystemUpdateReceipt>;
}

export interface DeploymentUpgradeOptions {
  enabled: boolean;
  dependencies?: Partial<DeploymentUpgradeDependencies>;
  idlePollMs?: number;
  activePollMs?: number;
  consoleIdentity?: ReleaseIdentity;
}

const terminalStatuses = new Set<SystemUpdateJob['status']>([
  'succeeded',
  'failed',
  'rolled_back',
  'cancelled',
]);

export function systemUpdateStageLabel(stage: SystemUpdateStage): string {
  const labels: Record<SystemUpdateStage, string> = {
    validating: 'Validating',
    verifying_artifacts: 'Verifying release',
    pulling_images: 'Preparing components',
    quiescing: 'Pausing workers',
    backing_up: 'Backing up',
    updating_backend: 'Updating backend',
    verifying_backend: 'Checking backend',
    updating_webui: 'Updating Console',
    verifying_webui: 'Checking Console',
    observing: 'Observing health',
    rolling_back: 'Rolling back',
    restoring_release: 'Restoring release',
    completed: 'Completed',
  };
  return labels[stage];
}

function operationKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `console-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isExpectedReconnect(error: unknown, job: SystemUpdateJob | null): boolean {
  if (!job || terminalStatuses.has(job.status)) return false;
  return error instanceof ApiError ? error.status === 0 || error.status >= 500 : true;
}

function releaseIsAlreadyRunning(
  current: SystemUpdateStatusResponse['current'] | undefined,
  consoleIdentity: ReleaseIdentity,
): boolean {
  if (!current) return false;
  const serverCommit = current.commit_sha.trim();
  const consoleCommit = consoleIdentity.commitSha.trim();
  return (
    current.channel === 'stable' &&
    consoleIdentity.channel === 'stable' &&
    current.version === consoleIdentity.version &&
    serverCommit !== '' &&
    consoleCommit !== '' &&
    serverCommit.toLowerCase() !== 'unknown' &&
    consoleCommit.toLowerCase() !== 'unknown' &&
    serverCommit === consoleCommit
  );
}

/**
 * Durable supervised-update state. Only opaque server-issued identifiers cross the
 * browser boundary; release URLs, image digests, host paths, and commands never do.
 */
export function useDeploymentUpgrade({
  enabled,
  dependencies,
  idlePollMs = SYSTEM_UPDATE_IDLE_POLL_MS,
  activePollMs = SYSTEM_UPDATE_ACTIVE_POLL_MS,
  consoleIdentity = CONSOLE_RELEASE_IDENTITY,
}: DeploymentUpgradeOptions): DeploymentUpgradeState {
  const depsRef = React.useRef<DeploymentUpgradeDependencies>({
    status: (signal) => api.systemUpdates.status({ signal, cache: 'no-store' }),
    preflight: (releaseId, idempotencyKey) =>
      api.systemUpdates.preflight(releaseId, idempotencyKey),
    start: (releaseId, preflightToken, idempotencyKey) =>
      api.systemUpdates.start(releaseId, preflightToken, idempotencyKey),
    job: (jobId, signal) => api.systemUpdates.job(jobId, { signal, cache: 'no-store' }),
    cancel: (jobId, idempotencyKey) => api.systemUpdates.cancel(jobId, idempotencyKey),
    rollback: (jobId, idempotencyKey) => api.systemUpdates.rollback(jobId, idempotencyKey),
    receipt: (jobId) => api.systemUpdates.receipt(jobId),
    ...dependencies,
  });
  depsRef.current = {
    status: (signal) => api.systemUpdates.status({ signal, cache: 'no-store' }),
    preflight: (releaseId, idempotencyKey) =>
      api.systemUpdates.preflight(releaseId, idempotencyKey),
    start: (releaseId, preflightToken, idempotencyKey) =>
      api.systemUpdates.start(releaseId, preflightToken, idempotencyKey),
    job: (jobId, signal) => api.systemUpdates.job(jobId, { signal, cache: 'no-store' }),
    cancel: (jobId, idempotencyKey) => api.systemUpdates.cancel(jobId, idempotencyKey),
    rollback: (jobId, idempotencyKey) => api.systemUpdates.rollback(jobId, idempotencyKey),
    receipt: (jobId) => api.systemUpdates.receipt(jobId),
    ...dependencies,
  };

  const [checking, setChecking] = React.useState(enabled);
  const [preparing, setPreparing] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const [status, setStatus] = React.useState<SystemUpdateStatusResponse | null>(null);
  const [job, setJob] = React.useState<SystemUpdateJob | null>(null);
  const [preflight, setPreflight] = React.useState<SystemUpdatePreflightResponse | null>(null);
  const [receipt, setReceipt] = React.useState<SystemUpdateReceipt | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [connection, setConnection] = React.useState<SystemUpdateConnection>('connected');
  const [progressOpen, setProgressOpen] = React.useState(false);
  const preflightOperationKeyRef = React.useRef<string | null>(null);
  const preflightReleaseIdRef = React.useRef<string | null>(null);
  const startOperationKeyRef = React.useRef<string | null>(null);
  const cancelOperationRef = React.useRef<{ jobId: string; key: string } | null>(null);
  const rollbackOperationRef = React.useRef<{ jobId: string; key: string } | null>(null);
  const mountedRef = React.useRef(true);
  const jobRef = React.useRef<SystemUpdateJob | null>(job);
  jobRef.current = job;
  const jobId = job?.job_id ?? null;
  const jobTerminal = job ? terminalStatuses.has(job.status) : true;
  const inlineReceipt = job?.rollback_receipt ?? job?.receipt ?? null;
  const receiptJobId =
    job && terminalStatuses.has(job.status) && !inlineReceipt ? job.job_id : null;
  const statusAbortRef = React.useRef<AbortController | null>(null);

  const checkNow = React.useCallback(async () => {
    if (!enabled) return;
    const controller = new AbortController();
    statusAbortRef.current?.abort('superseded');
    statusAbortRef.current = controller;
    setChecking(true);
    try {
      const next = await depsRef.current.status(controller.signal);
      if (!mountedRef.current || controller.signal.aborted) return;
      setStatus(next);
      setError(null);
      setConnection('connected');
      const durable = next.active_job ?? next.last_job ?? null;
      if (durable) setJob(durable);
      if (next.active_job) setProgressOpen(true);
    } catch (cause) {
      if (!mountedRef.current || controller.signal.aborted) return;
      if (isExpectedReconnect(cause, jobRef.current)) {
        setConnection('reconnecting');
      } else {
        setConnection('unavailable');
        setError(messageOf(cause, 'Update service is unavailable.'));
      }
    } finally {
      if (mountedRef.current && !controller.signal.aborted) setChecking(false);
      if (statusAbortRef.current === controller) statusAbortRef.current = null;
    }
  }, [enabled]);

  const prepare = React.useCallback(async () => {
    const release = status?.release_discovery.observed_release;
    if (!enabled || !release || preparing || starting) return;
    const key =
      preflightReleaseIdRef.current === release.release_id && preflightOperationKeyRef.current
        ? preflightOperationKeyRef.current
        : operationKey();
    preflightOperationKeyRef.current = key;
    preflightReleaseIdRef.current = release.release_id;
    startOperationKeyRef.current = null;
    setPreparing(true);
    setPreflight(null);
    setError(null);
    try {
      const next = await depsRef.current.preflight(release.release_id, key);
      if (!mountedRef.current) return;
      startOperationKeyRef.current = operationKey();
      setPreflight(next);
    } catch (cause) {
      if (!mountedRef.current) return;
      const message = messageOf(cause, 'Update preflight could not be completed.');
      setError(message);
      toast.error(message);
    } finally {
      if (mountedRef.current) setPreparing(false);
    }
  }, [enabled, preparing, starting, status?.release_discovery.observed_release]);

  const dismissPreflight = React.useCallback(() => {
    setPreflight(null);
    preflightOperationKeyRef.current = null;
    preflightReleaseIdRef.current = null;
    startOperationKeyRef.current = null;
  }, []);

  const start = React.useCallback(async () => {
    const key = startOperationKeyRef.current;
    if (!enabled || !preflight || !key || starting || preflight.blockers.length > 0) return;
    setStarting(true);
    setError(null);
    try {
      const next = await depsRef.current.start(
        preflight.release.release_id,
        preflight.preflight_token,
        key,
      );
      if (!mountedRef.current) return;
      setJob(next);
      setPreflight(null);
      setProgressOpen(true);
      setConnection('connected');
      preflightOperationKeyRef.current = null;
      preflightReleaseIdRef.current = null;
      startOperationKeyRef.current = null;
    } catch (cause) {
      if (!mountedRef.current) return;
      const message = messageOf(cause, 'The update could not be started.');
      setError(message);
      toast.error(message);
    } finally {
      if (mountedRef.current) setStarting(false);
    }
  }, [enabled, preflight, starting]);

  const cancel = React.useCallback(async () => {
    if (!job || terminalStatuses.has(job.status)) return;
    const operation =
      cancelOperationRef.current?.jobId === job.job_id
        ? cancelOperationRef.current
        : { jobId: job.job_id, key: operationKey() };
    cancelOperationRef.current = operation;
    try {
      const next = await depsRef.current.cancel(job.job_id, operation.key);
      if (mountedRef.current) setJob(next);
    } catch (cause) {
      const message = messageOf(cause, 'The update cannot be cancelled at this stage.');
      if (mountedRef.current) setError(message);
      toast.error(message);
    }
  }, [job]);

  const rollback = React.useCallback(async () => {
    if (!job || job.status !== 'succeeded') return;
    const operation =
      rollbackOperationRef.current?.jobId === job.job_id
        ? rollbackOperationRef.current
        : { jobId: job.job_id, key: operationKey() };
    rollbackOperationRef.current = operation;
    try {
      const next = await depsRef.current.rollback(job.job_id, operation.key);
      if (mountedRef.current) {
        setJob(next);
        setProgressOpen(true);
      }
    } catch (cause) {
      const message = messageOf(cause, 'Rollback could not be started.');
      if (mountedRef.current) setError(message);
      toast.error(message);
    }
  }, [job]);

  React.useEffect(() => {
    mountedRef.current = true;
    if (!enabled) {
      statusAbortRef.current?.abort('disabled');
      setChecking(false);
      setStatus(null);
      setJob(null);
      setPreflight(null);
      setReceipt(null);
      setError(null);
      setConnection('connected');
      preflightOperationKeyRef.current = null;
      preflightReleaseIdRef.current = null;
      startOperationKeyRef.current = null;
      cancelOperationRef.current = null;
      rollbackOperationRef.current = null;
      return undefined;
    }
    void checkNow();
    const interval = idlePollMs > 0
      ? window.setInterval(() => {
          if (document.visibilityState === 'visible') void checkNow();
        }, idlePollMs)
      : undefined;
    const onFocus = () => void checkNow();
    window.addEventListener('focus', onFocus);
    return () => {
      mountedRef.current = false;
      statusAbortRef.current?.abort('cleanup');
      statusAbortRef.current = null;
      if (interval !== undefined) window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [checkNow, enabled, idlePollMs]);

  React.useEffect(() => {
    if (!enabled || !jobId || jobTerminal || activePollMs <= 0) return undefined;
    let alive = true;
    let controller: AbortController | null = null;
    const poll = async () => {
      controller?.abort('superseded');
      controller = new AbortController();
      try {
        const next = await depsRef.current.job(jobId, controller.signal);
        if (!alive || controller.signal.aborted) return;
        setJob(next);
        setConnection('connected');
        setError(null);
        if (terminalStatuses.has(next.status)) {
          void checkNow();
          if (next.status === 'succeeded') toast.success('The verified Agentic SOC release was installed.');
          if (next.status === 'rolled_back') toast.warning('The update was rolled back. The previous release is still running.');
        }
      } catch (cause) {
        if (!alive || controller.signal.aborted) return;
        if (isExpectedReconnect(cause, jobRef.current)) setConnection('reconnecting');
        else {
          setConnection('unavailable');
          setError(messageOf(cause, 'Could not read update progress.'));
        }
      }
    };
    void poll();
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void poll();
    }, activePollMs);
    return () => {
      alive = false;
      controller?.abort('cleanup');
      window.clearInterval(interval);
    };
  }, [activePollMs, checkNow, enabled, jobId, jobTerminal]);

  React.useEffect(() => {
    if (inlineReceipt) {
      setReceipt(inlineReceipt);
      return;
    }
    if (!receiptJobId) return;
    let alive = true;
    void depsRef.current.receipt(receiptJobId)
      .then((next) => {
        if (alive) setReceipt(next);
      })
      .catch(() => {
        // A receipt is useful evidence but its temporary absence must not erase the
        // durable terminal job state or manufacture a failed update.
      });
    return () => {
      alive = false;
    };
  }, [inlineReceipt, receiptJobId]);

  const needsBrowserActivation = Boolean(
    job?.status === 'succeeded' &&
      status?.current &&
      !releaseIsAlreadyRunning(status.current, consoleIdentity),
  );

  return {
    checking,
    preparing,
    starting,
    status,
    job,
    preflight,
    receipt,
    error,
    connection,
    progressOpen,
    needsBrowserActivation,
    checkNow,
    prepare,
    dismissPreflight,
    start,
    cancel,
    rollback,
    setProgressOpen,
  };
}
