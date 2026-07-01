/**
 * BatchJobs page — Round-4 Wave-5 coverage.
 *
 * Mocks the co-located Batch.api module (so no network) and asserts:
 *   - jobs render with their provider / model / state / discount / retrieved counts,
 *   - the state badge reflects the lifecycle (submitted..retrieved/errored),
 *   - the aggregate stat tiles reflect the loaded jobs,
 *   - job ids / models render in a fenced InlineCode (plain text, #9 — no markup),
 *   - the empty state shows when there are no jobs,
 *   - a load error surfaces a retry affordance.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const { jobsMock } = vi.hoisted(() => ({ jobsMock: vi.fn() }));

vi.mock('@/soc/Batch.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../Batch.api')>();
  return {
    ...actual,
    batchApi: { jobs: jobsMock, job: vi.fn() },
    fetchBatchJobs: jobsMock,
  };
});

import { TooltipProvider } from '@/ui/tooltip';
import { BatchJobsInner } from '../BatchJobs';
import type { BatchJobRow } from '../../Batch.api';

const JOBS: BatchJobRow[] = [
  {
    id: 'batch-abc123',
    provider: 'anthropic',
    provider_batch_id: 'msgbatch_01xyz',
    state: 'retrieved',
    model: 'claude-opus-4-8',
    discount: 0.5,
    requests: 10,
    retrieved: 10,
    submitted_at: '2026-06-30T10:00:00Z',
    polled_at: '2026-06-30T10:30:00Z',
  },
  {
    id: 'batch-def456',
    provider: 'openai',
    provider_batch_id: null,
    state: 'polling',
    model: 'gpt-batch',
    discount: 0.5,
    requests: 4,
    retrieved: 0,
    submitted_at: '2026-06-30T11:00:00Z',
    polled_at: null,
  },
];

function renderPage() {
  return render(
    <TooltipProvider>
      <BatchJobsInner />
    </TooltipProvider>,
  );
}

describe('BatchJobs', () => {
  beforeEach(() => {
    jobsMock.mockReset();
  });

  it('renders batch jobs with provider, state, discount and retrieved counts', async () => {
    jobsMock.mockResolvedValue({ jobs: JOBS, count: JOBS.length });
    renderPage();

    await waitFor(() => expect(screen.getByText('batch-abc123')).toBeInTheDocument());
    // Provider + model (plain text / InlineCode).
    expect(screen.getByText('Anthropic')).toBeInTheDocument();
    expect(screen.getByText('claude-opus-4-8')).toBeInTheDocument();
    // Lifecycle states ("Retrieved" also names a stat tile → allow multiple).
    expect(screen.getAllByText('Retrieved').length).toBeGreaterThan(0);
    expect(screen.getByText('Polling')).toBeInTheDocument();
    // Discount pill.
    expect(screen.getAllByText(/50% off/).length).toBeGreaterThan(0);
    // Opaque provider batch id is shown (not a secret).
    expect(screen.getByText('msgbatch_01xyz')).toBeInTheDocument();
  });

  it('summarises the loaded jobs in the stat tiles', async () => {
    jobsMock.mockResolvedValue({ jobs: JOBS, count: JOBS.length });
    renderPage();

    await waitFor(() => expect(screen.getByText('Total jobs')).toBeInTheDocument());
    expect(screen.getByText('In flight')).toBeInTheDocument();
    // "Retrieved" names both a stat tile and a state badge → at least one present.
    expect(screen.getAllByText('Retrieved').length).toBeGreaterThan(0);
    // 10 of 14 requests retrieved across the two jobs.
    expect(screen.getByText(/of 14 retrieved/)).toBeInTheDocument();
  });

  it('shows the empty state when there are no jobs', async () => {
    jobsMock.mockResolvedValue({ jobs: [], count: 0 });
    renderPage();
    await waitFor(() => expect(screen.getByText('No batch jobs yet')).toBeInTheDocument());
  });

  it('surfaces a retry affordance on load failure', async () => {
    jobsMock.mockRejectedValue(new Error('boom'));
    renderPage();
    await waitFor(() =>
      expect(screen.getByText('Could not load batch jobs')).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });
});
