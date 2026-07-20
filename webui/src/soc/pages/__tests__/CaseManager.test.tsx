/** Case Manager queue/workspace integration tests (prototype → live Console). */
import * as React from 'react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import type { Case } from '@/lib/types';
import CaseManager from '../CaseManager';

expect.extend(toHaveNoViolations);

const mocks = vi.hoisted(() => ({
  listCases: vi.fn(),
  reinvestigateCase: vi.fn(),
  navigate: vi.fn(),
  routeOpts: undefined as { caseId?: string } | undefined,
  toastLoading: vi.fn(() => 'case-manager-bulk'),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    api: {
      ...actual.api,
      listCases: mocks.listCases,
      reinvestigateCase: mocks.reinvestigateCase,
    },
  };
});

vi.mock('sonner', () => ({
  toast: {
    loading: mocks.toastLoading,
    success: mocks.toastSuccess,
    warning: mocks.toastWarning,
  },
}));

vi.mock('@/soc/router', () => ({
  useRoute: () => ({ page: 'case_manager', opts: mocks.routeOpts, navigate: mocks.navigate }),
}));

vi.mock('@/soc/components/Can', () => ({
  ProtectedRoute: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Can: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../CaseDetail', () => ({
  CaseDetail: ({
    caseId,
    presentation,
    onClose,
    onCaseChange,
  }: {
    caseId: string;
    presentation: string;
    onClose: () => void;
    onCaseChange?: (c: Case) => void;
  }) => (
    <section data-testid="embedded-case-detail" data-case-id={caseId} data-presentation={presentation}>
      <span>Overview</span><span>Timeline</span><span>Investigation</span>
      <span>Threat context</span><span>Collaboration</span><span>Chat</span>
      <button type="button" onClick={onClose}>Mock back</button>
      <button
        type="button"
        onClick={() => onCaseChange?.({ ...OPEN_CRITICAL, status: 'resolved' })}
      >
        Mock resolve
      </button>
    </section>
  ),
}));

const OPEN_CRITICAL: Case = {
  case_id: 'case-open-critical',
  case_number: 'CASE-2026-0092',
  title: 'Suspicious S3 bucket exfiltration',
  status: 'investigating',
  severity_band: 'critical',
  risk_score: 92,
  updated_at: '2026-07-20T10:20:00Z',
  entity: { type: 'ip', value: '198.51.100.45' },
};

const OPEN_HIGH: Case = {
  case_id: 'case-open-high',
  case_number: 'CASE-2026-0091',
  title: 'Multiple failed logins',
  status: 'needs_human',
  verdict: 'NEEDS_HUMAN',
  severity_band: 'high',
  risk_score: 68,
  updated_at: '2026-07-20T10:10:00Z',
  entity: { type: 'user', value: 'admin_svc' },
};

const RESOLVED_LOW: Case = {
  case_id: 'case-resolved-low',
  case_number: 'CASE-2026-0088',
  title: 'Benign health check',
  status: 'resolved',
  severity_band: 'low',
  risk_score: 12,
  updated_at: '2026-07-20T09:00:00Z',
  source_name: 'Wazuh Manager',
};

const CASES = [OPEN_HIGH, RESOLVED_LOW, OPEN_CRITICAL];

describe('CaseManager', () => {
  beforeEach(() => {
    mocks.navigate.mockReset();
    mocks.routeOpts = undefined;
    mocks.listCases.mockReset().mockResolvedValue({ cases: CASES, total: CASES.length });
    mocks.reinvestigateCase.mockReset().mockImplementation(async (caseId: string) => {
      const item = CASES.find((candidate) => candidate.case_id === caseId);
      if (!item) throw new Error('Case not found');
      return { ...item, updated_at: '2026-07-20T10:30:00Z' };
    });
    mocks.toastLoading.mockClear();
    mocks.toastSuccess.mockClear();
    mocks.toastWarning.mockClear();
  });

  it('opens on the newest active case and embeds the complete shared workspace', async () => {
    render(<CaseManager />);

    expect(await screen.findByRole('heading', { name: 'Active Cases' })).toBeInTheDocument();
    expect(screen.getByText('2 shown · 2 active / 3 loaded')).toBeInTheDocument();
    expect(screen.queryByText('Benign health check')).not.toBeInTheDocument();

    const manager = screen.getByTestId('case-manager');
    expect(manager).toHaveClass(
      'h-[calc(100dvh-7rem)]',
      'min-h-0',
      'xl:min-h-[600px]',
    );
    expect(manager.className.split(/\s+/)).not.toContain('min-h-[600px]');

    const splitFrame = manager.firstElementChild as HTMLElement;
    expect(splitFrame).toHaveClass(
      'xl:grid-cols-[minmax(320px,1fr)_minmax(0,2fr)]',
      'border',
      'border-border',
    );
    expect(splitFrame.className).not.toMatch(/rounded|shadow/);

    const detail = await screen.findByTestId('embedded-case-detail');
    expect(detail).toHaveAttribute('data-case-id', OPEN_CRITICAL.case_id);
    expect(detail).toHaveAttribute('data-presentation', 'embedded');
    for (const label of ['Overview', 'Timeline', 'Investigation', 'Threat context', 'Collaboration', 'Chat']) {
      expect(within(detail).getByText(label)).toBeInTheDocument();
    }
  });

  it('switches Active/All, filters the real queue, and selects a different case', async () => {
    render(<CaseManager />);
    await screen.findByText('Suspicious S3 bucket exfiltration');

    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getByRole('heading', { name: 'All Cases' })).toBeInTheDocument();
    expect(screen.getByText('3 shown · 3 loaded')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: 'Search case queue' }), {
      target: { value: 'health check' },
    });
    expect(screen.getByText('Benign health check')).toBeInTheDocument();
    expect(screen.queryByText('Multiple failed logins')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Benign health check'));
    expect(screen.getByTestId('embedded-case-detail')).toHaveAttribute(
      'data-case-id',
      RESOLVED_LOW.case_id,
    );
    expect(mocks.navigate).toHaveBeenLastCalledWith('case_manager', {
      caseId: RESOLVED_LOW.case_id,
    });
  });

  it('keeps the queue synchronized after an authoritative detail mutation', async () => {
    render(<CaseManager initialCaseId={OPEN_CRITICAL.case_id} />);
    await screen.findByTestId('embedded-case-detail');

    fireEvent.click(screen.getByRole('button', { name: 'Mock resolve' }));

    await waitFor(() => {
      expect(screen.queryByText('Suspicious S3 bucket exfiltration')).not.toBeInTheDocument();
      expect(screen.getByText('1 shown · 1 active / 3 loaded')).toBeInTheDocument();
    });
  });

  it('selects cases without opening them and keeps hidden selections across filtering', async () => {
    render(<CaseManager />);
    await screen.findByText('Suspicious S3 bucket exfiltration');

    const highCheckbox = screen.getByRole('checkbox', { name: 'Select CASE-2026-0091' });
    const selectVisible = screen.getByRole('checkbox', { name: 'Select all visible cases' });
    expect(selectVisible).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(highCheckbox);
    expect(highCheckbox).toHaveAttribute('aria-checked', 'true');
    expect(selectVisible).toHaveAttribute('aria-checked', 'mixed');
    expect(screen.getByTestId('embedded-case-detail')).toHaveAttribute(
      'data-case-id',
      OPEN_CRITICAL.case_id,
    );
    expect(mocks.navigate).not.toHaveBeenCalled();

    // Clicking an indeterminate select-all selects every currently visible case.
    fireEvent.click(selectVisible);
    expect(selectVisible).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('2 selected')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: 'Search case queue' }), {
      target: { value: 'failed logins' },
    });
    expect(screen.getByText('Multiple failed logins')).toBeInTheDocument();
    expect(screen.queryByText('Suspicious S3 bucket exfiltration')).not.toBeInTheDocument();
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    expect(selectVisible).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Clear case selection' }));
    expect(selectVisible).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByRole('button', { name: 'Reinvestigate' })).not.toBeInTheDocument();
  });

  it('confirms the token-spending action, updates successes, and leaves failures selected', async () => {
    mocks.reinvestigateCase.mockImplementation(async (caseId: string) => {
      if (caseId === OPEN_HIGH.case_id) throw new Error('Stored evidence is unavailable');
      return { ...OPEN_CRITICAL, status: 'resolved', updated_at: '2026-07-20T10:40:00Z' };
    });
    render(<CaseManager />);
    await screen.findByText('Suspicious S3 bucket exfiltration');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all visible cases' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reinvestigate' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Reinvestigate 2 cases?')).toBeInTheDocument();
    expect(
      within(dialog).getByText(/spends LLM tokens per case/i),
    ).toBeInTheDocument();
    expect(mocks.reinvestigateCase).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Reinvestigate' }));
    await waitFor(() => expect(mocks.reinvestigateCase).toHaveBeenCalledTimes(2));

    expect(
      await screen.findByText(
        '1 reinvestigated, 1 failed. CASE-2026-0091: Stored evidence is unavailable',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('Suspicious S3 bucket exfiltration')).not.toBeInTheDocument();
    expect(screen.getByText('1 shown · 1 active / 3 loaded')).toBeInTheDocument();
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select CASE-2026-0091' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(mocks.listCases).toHaveBeenCalledTimes(1);
    expect(mocks.toastWarning).toHaveBeenCalledWith('1 reinvestigated, 1 failed', {
      id: 'case-manager-bulk',
    });
  });

  it('bounds reinvestigation to three concurrent requests and reports progress', async () => {
    const batchCases: Case[] = Array.from({ length: 5 }, (_, index) => ({
      ...OPEN_HIGH,
      case_id: `case-batch-${index + 1}`,
      case_number: `CASE-BATCH-${index + 1}`,
      title: `Batch case ${index + 1}`,
      updated_at: `2026-07-20T10:0${index}:00Z`,
    }));
    mocks.listCases.mockResolvedValue({ cases: batchCases, total: batchCases.length });

    const pending = new Map<string, (value: Case) => void>();
    mocks.reinvestigateCase.mockImplementation(
      (caseId: string) =>
        new Promise<Case>((resolve) => {
          pending.set(caseId, resolve);
        }),
    );

    render(<CaseManager />);
    await screen.findByText('Batch case 1');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all visible cases' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reinvestigate' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reinvestigate' }));

    await waitFor(() => expect(mocks.reinvestigateCase).toHaveBeenCalledTimes(3));
    expect(screen.getByRole('checkbox', { name: 'Select all visible cases' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clear case selection' })).toBeDisabled();

    // Chunk two cannot begin until the first bounded group has fully settled.
    const firstBatchIds = Array.from(pending.keys());
    await act(async () => {
      for (const id of firstBatchIds) {
        const item = batchCases.find((candidate) => candidate.case_id === id)!;
        pending.get(id)?.({ ...item, updated_at: '2026-07-20T10:50:00Z' });
      }
    });
    await waitFor(() => expect(mocks.reinvestigateCase).toHaveBeenCalledTimes(5));

    const secondBatchIds = Array.from(pending.keys()).filter((id) => !firstBatchIds.includes(id));
    await act(async () => {
      for (const id of secondBatchIds) {
        const item = batchCases.find((candidate) => candidate.case_id === id)!;
        pending.get(id)?.({ ...item, updated_at: '2026-07-20T10:50:00Z' });
      }
    });

    expect(await screen.findByText('5 cases reinvestigated.')).toBeInTheDocument();
    expect(screen.getByText('5 visible')).toBeInTheDocument();
    expect(mocks.toastSuccess).toHaveBeenCalledWith('5 cases reinvestigated.', {
      id: 'case-manager-bulk',
    });
  });

  it('returns to the queue on narrow-layout back/dismiss without reopening a case', async () => {
    render(<CaseManager initialCaseId={OPEN_HIGH.case_id} />);
    await screen.findByTestId('embedded-case-detail');

    fireEvent.click(screen.getAllByRole('button', { name: 'Back to case queue' })[0]);

    expect(screen.queryByTestId('embedded-case-detail')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Active Cases' })).toBeInTheDocument();
    expect(mocks.navigate).toHaveBeenLastCalledWith('case_manager');
  });

  it('shows a retryable queue failure while retaining a deep-linked detail target', async () => {
    mocks.listCases.mockRejectedValueOnce(new Error('offline'));
    render(<CaseManager initialCaseId={OPEN_CRITICAL.case_id} />);

    expect(await screen.findByText('Could not load cases')).toBeInTheDocument();
    expect(screen.getByText('offline')).toBeInTheDocument();
    expect(screen.getByTestId('embedded-case-detail')).toHaveAttribute(
      'data-case-id',
      OPEN_CRITICAL.case_id,
    );
  });

  it('has no detectable accessibility violations in the split workspace', async () => {
    const view = render(<CaseManager />);
    await screen.findByTestId('embedded-case-detail');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select CASE-2026-0091' }));

    expect(await axe(view.container)).toHaveNoViolations();
  });
});
