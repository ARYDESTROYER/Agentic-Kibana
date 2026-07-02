/**
 * Batch.api co-located module spec (Round 6 dead-code sweep).
 *
 * Locks in the module's public surface after the unreachable single-job fetcher
 * (`fetchBatchJob` / `batchApi.job` / `BatchJobResponse`) was removed — the app
 * only ever lists jobs (`GET /api/batch/jobs`), there is no per-job drill-in.
 * Asserts the retained list fetcher hits the right read-only endpoint and that
 * the removed by-id surface stays gone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('@/lib/api', () => ({ api: { get: getMock } }));

import { fetchBatchJobs, batchApi, BATCH_STATE_ORDER, BATCH_STATE_META } from '../Batch.api';
import type { BatchJobsResponse } from '../Batch.api';

const EMPTY: BatchJobsResponse = { jobs: [], count: 0 };

describe('Batch.api', () => {
  beforeEach(() => {
    getMock.mockReset();
    getMock.mockResolvedValue(EMPTY);
  });

  it('fetchBatchJobs GETs the read-only list endpoint', async () => {
    const res = await fetchBatchJobs();
    expect(getMock).toHaveBeenCalledWith('batch/jobs');
    expect(res).toEqual(EMPTY);
  });

  it('exposes only the list fetcher on batchApi (no dead by-id path)', () => {
    expect(batchApi.jobs).toBe(fetchBatchJobs);
    expect(Object.keys(batchApi)).toEqual(['jobs']);
    // The removed single-job drill-in must stay gone.
    expect('job' in batchApi).toBe(false);
  });

  it('keeps the lifecycle ordering + badge metadata stable', () => {
    expect(BATCH_STATE_ORDER).toEqual(['submitted', 'polling', 'retrieving', 'retrieved']);
    expect(BATCH_STATE_META.retrieved.variant).toBe('success');
    expect(BATCH_STATE_META.errored.variant).toBe('critical');
  });
});
