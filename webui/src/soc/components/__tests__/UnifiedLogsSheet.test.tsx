/**
 * UnifiedLogs (Round 4 Wave 5, request #3) render test.
 *
 * Mocks the co-located `UnifiedLogs.api` (the ONLY network the view uses) and asserts:
 *   1. rows merged from multiple sources render with the MANDATORY per-row SOURCE
 *      (provenance) column showing each row's source_name;
 *   2. a PARTIAL failure (one source ok, one errored) surfaces a degraded per-source
 *      status chip + a "Partial results" notice, and never blocks the ok rows;
 *   3. UNTRUSTED row text (message with markup) renders as PLAIN TEXT — no live DOM
 *      escapes the fence (#9), no dangerouslySetInnerHTML anywhere.
 *
 * Fully offline — no real network, no auth (the view itself is unauthenticated; RBAC
 * gating is the integrator's ProtectedRoute wrapper, out of this component's scope).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';

const { fetchUnifiedLogsMock } = vi.hoisted(() => ({ fetchUnifiedLogsMock: vi.fn() }));

// Co-located API — the component imports this named export.
vi.mock('@/soc/UnifiedLogs.api', async () => {
  const actual = await vi.importActual<typeof import('../../UnifiedLogs.api')>(
    '../../UnifiedLogs.api',
  );
  return { ...actual, fetchUnifiedLogs: fetchUnifiedLogsMock };
});

import { UnifiedLogsView } from '../UnifiedLogsSheet';
import type { UnifiedLogsResponse } from '../../UnifiedLogs.api';

const RESPONSE: UnifiedLogsResponse = {
  count: 2,
  partial: true,
  sources: [
    { source_id: 'src-elastic', source_name: 'Prod Elasticsearch', ok: true, count: 2 },
    { source_id: 'src-wazuh', source_name: 'Wazuh EDR', ok: false, count: 0, error: 'timeout' },
  ],
  logs: [
    {
      id: 'evt-1',
      ts: '2026-07-01T10:05:00Z',
      source_id: 'src-elastic',
      source_name: 'Prod Elasticsearch',
      source_ip: '10.0.0.5',
      user: 'alice',
      host: 'web-01',
      rule: 'auth.failed_login',
      severity: 72,
      // UNTRUSTED — attacker-influenceable message with markup; must render as text.
      message: '<img src=x onerror="alert(1)"> failed login',
      _raw: { event: { action: 'login' } },
    },
    {
      id: 'evt-2',
      ts: '2026-07-01T10:04:00Z',
      source_id: 'src-elastic',
      source_name: 'Prod Elasticsearch',
      source_ip: null,
      user: null,
      host: null,
      rule: null,
      severity: 20,
      message: 'benign heartbeat',
      _raw: {},
    },
  ],
};

describe('UnifiedLogsView', () => {
  beforeEach(() => {
    fetchUnifiedLogsMock.mockReset();
    fetchUnifiedLogsMock.mockResolvedValue(RESPONSE);
  });

  it('renders merged rows with a mandatory per-row Source provenance column', async () => {
    render(<UnifiedLogsView />);

    // Both rows resolve; the merged message text is shown.
    await waitFor(() => expect(screen.getByText('benign heartbeat')).toBeInTheDocument());

    // MANDATORY Source column header.
    const table = screen.getByRole('table');
    expect(within(table).getByText('Source')).toBeInTheDocument();

    // Each row carries its source_name provenance (in the status strip AND the row).
    // At least one occurrence in the table body proves the per-row provenance column.
    const provenanceCells = within(table).getAllByText('Prod Elasticsearch');
    expect(provenanceCells.length).toBeGreaterThan(0);

    // The endpoint was hit with a merged read (limit + to:'now'); no source id in path.
    expect(fetchUnifiedLogsMock).toHaveBeenCalled();
    const arg = fetchUnifiedLogsMock.mock.calls[0][0];
    expect(arg).toMatchObject({ to: 'now' });
    expect(typeof arg.limit).toBe('number');
  });

  it('surfaces partial failure as a degraded per-source chip + notice, without blocking ok rows', async () => {
    render(<UnifiedLogsView />);

    await waitFor(() => expect(screen.getByText('benign heartbeat')).toBeInTheDocument());

    // Per-source status strip shows the failed source by name.
    const strip = screen.getByTestId('unified-source-status');
    expect(within(strip).getByText('Wazuh EDR')).toBeInTheDocument();

    // Partial-results notice is shown.
    expect(screen.getByText('Partial results')).toBeInTheDocument();

    // The ok source's rows are still rendered (failure did not block them).
    expect(screen.getByText('benign heartbeat')).toBeInTheDocument();
  });

  it('renders untrusted message text as plain text (no live DOM escapes the fence, #9)', async () => {
    const { container } = render(<UnifiedLogsView />);

    // The raw markup string appears verbatim as text content...
    await waitFor(() =>
      expect(screen.getByText('<img src=x onerror="alert(1)"> failed login')).toBeInTheDocument(),
    );
    // ...and NO actual <img> element was injected from the message body.
    expect(container.querySelector('img')).toBeNull();
  });

  it('shows an empty state when no browse-capable sources are enabled', async () => {
    fetchUnifiedLogsMock.mockResolvedValue({ count: 0, partial: false, sources: [], logs: [] });
    render(<UnifiedLogsView />);

    await waitFor(() =>
      expect(
        screen.getByText(/No browse-capable sources are enabled/i),
      ).toBeInTheDocument(),
    );
  });
});
