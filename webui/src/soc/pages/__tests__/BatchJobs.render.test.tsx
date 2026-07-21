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
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const { jobsMock, getConfigMock, putConfigMock } = vi.hoisted(() => ({
  jobsMock: vi.fn(),
  getConfigMock: vi.fn(),
  putConfigMock: vi.fn(),
}));

vi.mock('@/soc/Batch.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../Batch.api')>();
  return {
    ...actual,
    batchApi: { jobs: jobsMock, job: vi.fn() },
    fetchBatchJobs: jobsMock,
  };
});

// The page now also loads the batch config via api.batch.getConfig (R6 editor).
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { ...actual.api, batch: { getConfig: getConfigMock, putConfig: putConfigMock } },
  };
});

// The R6 config editor uses useCan → AuthProvider; grant everything for the render test.
vi.mock('@/soc/auth', () => ({
  useAuth: () => ({ username: 'tester', authEnabled: false, hasPermission: () => true }),
}));

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
    getConfigMock.mockReset();
    getConfigMock.mockResolvedValue({
      config: { enabled: false, severity_floor: 3, providers: ['anthropic', 'openai'], flex: false },
    });
  });

  it('renders batch jobs with provider, state, discount and retrieved counts', async () => {
    jobsMock.mockResolvedValue({ jobs: JOBS, count: JOBS.length });
    renderPage();

    await waitFor(() => expect(screen.getByText('batch-abc123')).toBeInTheDocument());
    // Provider + model (plain text / InlineCode).
    expect(screen.getByText('Anthropic')).toBeInTheDocument();
    expect(screen.getByText('claude-opus-4-8')).toBeInTheDocument();
    // Lifecycle state badge (the retrieved job).
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

    // The "Requests retrieved" tile derives `of 14 total` from the async-loaded rows
    // (totals.requests = 10 + 4). The four StatCards render EAGERLY (even during the
    // loading skeleton, with totals = 0), so `Total jobs` is present before the
    // jobsMock promise resolves — asserting it via getByText after a waitFor on a
    // DIFFERENT node would race the row-load under CPU contention. Anchor the wait on
    // the value that only appears once the rows land: `of 14 total`. findByText
    // polls until the loaded-state re-render commits (default 1000ms is tight under a
    // fully parallel suite → give it explicit headroom without weakening the assert).
    expect(await screen.findByText(/of 14 total/, {}, { timeout: 5000 })).toBeInTheDocument();
    // Now that the loaded state has committed, the sibling tiles are all present.
    expect(screen.getByText('Total jobs')).toBeInTheDocument();
    expect(screen.getByText('In flight')).toBeInTheDocument();
    // The tiles are labelled by granularity (jobs vs requests) — no "retrieved" collision.
    expect(screen.getByText('Jobs done')).toBeInTheDocument();
    expect(screen.getByText('Requests retrieved')).toBeInTheDocument();
    // "Retrieved" now names only the lifecycle state badge (not a tile).
    expect(screen.getAllByText('Retrieved').length).toBeGreaterThan(0);
  });

  it('Refresh reloads the jobs table without discarding unsaved policy edits', async () => {
    jobsMock.mockResolvedValue({ jobs: JOBS, count: JOBS.length });
    renderPage();

    // The config form renders only after the policy load resolves (loading skeleton
    // until then).
    const toggle = await screen.findByRole('switch', { name: /enable batch routing/i });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    // Edit the policy — the draft is now dirty.
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(getConfigMock).toHaveBeenCalledTimes(1);

    // Refresh the read-only table.
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));

    // The jobs table reloaded, but the config was NOT re-fetched (no clobber) and the
    // unsaved edit survives.
    await waitFor(() => expect(jobsMock).toHaveBeenCalledTimes(2));
    expect(getConfigMock).toHaveBeenCalledTimes(1);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('shows live Flex preference separately from the opt-in async Batch queue', async () => {
    jobsMock.mockResolvedValue({ jobs: [], count: 0 });
    renderPage();

    expect(
      await screen.findByRole('switch', { name: /prefer discounted alert inference/i }),
    ).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: /standard fallback/i })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('switch', { name: /enable batch routing/i })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(screen.getByText(/separate async Batch queue is off/i)).toBeInTheDocument();
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
