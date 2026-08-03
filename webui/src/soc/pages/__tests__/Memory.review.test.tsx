import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getMemoryMock, updateMemoryMock } = vi.hoisted(() => ({
  getMemoryMock: vi.fn(),
  updateMemoryMock: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getMemory: getMemoryMock,
      updateMemory: updateMemoryMock,
    },
  };
});

vi.mock('@/soc/components/Can', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/soc/components/Can')>();
  return { ...actual, useCan: () => true };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import Memory from '../Memory';

const pending = {
  id: 'memory-agent-1',
  text: 'Treat scanner-a as a known scanner.',
  source: 'agent',
  author: 'investigator',
  active: true,
  review_status: 'pending',
  created_at: '2026-08-02T12:00:00Z',
};

describe('Memory review boundary', () => {
  beforeEach(() => {
    getMemoryMock.mockReset();
    updateMemoryMock.mockReset();
    getMemoryMock.mockResolvedValue({ entries: [pending], count: 1 });
  });

  it('labels an agent suggestion as pending and keeps it out of the effective active count', async () => {
    render(<Memory embedded />);

    expect(await screen.findByText('Pending review')).toBeInTheDocument();
    expect(screen.getByText('1 not injected')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Memory pending review' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
  });

  it('requires an explicit manager update before presenting the fact as approved', async () => {
    updateMemoryMock.mockResolvedValue({
      ...pending,
      review_status: 'approved',
      approved_by: 'reviewer',
    });
    render(<Memory embedded />);
    await screen.findByText('Pending review');

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() =>
      expect(updateMemoryMock).toHaveBeenCalledWith('memory-agent-1', {
        review_status: 'approved',
      }),
    );
    await waitFor(() => expect(screen.queryByText('Pending review')).not.toBeInTheDocument());
  });
});
