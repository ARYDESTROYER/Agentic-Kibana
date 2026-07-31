/**
 * Campaigns page + CampaignChip tests (Round 4 / Wave 4 — WB).
 *
 * Mocks the co-located Campaigns.api module (no network) + the auth context
 * (grant-all) and asserts:
 *   - campaigns render with name, case count, entities + MITRE as PLAIN text (#9),
 *   - clicking a row opens the detail sheet with the member cases,
 *   - "Open" from a member case deep-links via onNavigate,
 *   - "Recorrelate" calls campaignsApi.recorrelate,
 *   - the exported <CampaignChip> renders a "part of campaign" label as plain text.
 *
 * The api module is fully mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

const { listMock, getMock, forCaseMock, recorrelateMock, apiGetMock, apiPutMock } = vi.hoisted(
  () => ({
    listMock: vi.fn(),
    getMock: vi.fn(),
    forCaseMock: vi.fn(),
    recorrelateMock: vi.fn(),
    apiGetMock: vi.fn(),
    apiPutMock: vi.fn(),
  }),
);

vi.mock('@/soc/pages/Campaigns.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../Campaigns.api')>();
  return {
    ...actual,
    campaignsApi: {
      list: listMock,
      get: getMock,
      forCase: forCaseMock,
      recorrelate: recorrelateMock,
    },
  };
});

// The page loads/saves its config through the shared `api.campaign` client
// (getConfig/putConfig → GET/PUT campaigns/config).
vi.mock('@/lib/api', () => ({
  api: { campaign: { getConfig: apiGetMock, putConfig: apiPutMock }, post: vi.fn() },
}));

vi.mock('@/soc/auth', () => ({
  useAuth: () => ({
    username: 'tester',
    hasPermission: () => true,
    authEnabled: false,
  }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { TooltipProvider } from '@/ui/tooltip';
import Campaigns, { CampaignChip } from '../Campaigns';
import type { Campaign } from '../Campaigns.api';

const CAMPAIGN: Campaign = {
  id: 'camp-abc123',
  name: 'Lateral movement — 10.0.0.5',
  status: 'open',
  case_ids: ['case-1', 'case-2', 'case-3'],
  case_count: 3,
  entities: [
    { entity_type: 'ip', value: '10.0.0.5' },
    { entity_type: 'user', value: 'svc-backup' },
  ],
  mitre: ['T1021', 'T1078'],
  severity_rollup: 'high',
  first_seen: '2026-06-29T08:00:00Z',
  last_seen: '2026-06-30T18:00:00Z',
  created_at: '2026-06-29T08:00:00Z',
};

function renderCampaigns(onNavigate = vi.fn()) {
  const utils = render(
    <TooltipProvider>
      <Campaigns onNavigate={onNavigate} />
    </TooltipProvider>,
  );
  return { ...utils, onNavigate };
}

describe('Campaigns page', () => {
  beforeEach(() => {
    listMock.mockReset();
    recorrelateMock.mockReset();
    apiGetMock.mockReset();
    apiPutMock.mockReset();
    listMock.mockResolvedValue({ campaigns: [CAMPAIGN], total: 1, enabled: true });
    recorrelateMock.mockResolvedValue({ ok: true, count: 1, campaigns: [CAMPAIGN] });
    // The campaign config load (useConfigEditor → api.campaign.getConfig()).
    apiGetMock.mockResolvedValue({ config: { enabled: true, cadence: 'daily' } });
    apiPutMock.mockResolvedValue({ ok: true, config: { enabled: true, cadence: 'daily' } });
  });

  it('uses one shared page loader while the first campaign snapshot loads', async () => {
    listMock.mockReturnValue(new Promise(() => {}));
    apiGetMock.mockReturnValue(new Promise(() => {}));
    renderCampaigns();

    expect(
      await screen.findByRole('status', { name: 'Loading campaigns' }),
    ).toBeInTheDocument();
    expect(screen.getAllByTestId('console-loading-glyph')).toHaveLength(1);
    expect(screen.queryByRole('status', { name: 'Loading campaign policy' })).toBeNull();
    expect(screen.queryByText('Campaign clustering is off.')).toBeNull();
  });

  it('uses the shared blocking state while the saved campaign policy loads', async () => {
    let resolveConfig: (value: { config: { enabled: boolean; cadence: string } }) => void = () => {};
    apiGetMock.mockReturnValue(
      new Promise<{ config: { enabled: boolean; cadence: string } }>((resolve) => {
        resolveConfig = resolve;
      }),
    );
    renderCampaigns();

    expect(
      await screen.findByRole('status', { name: 'Loading campaign policy' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('switch', { name: /enable campaign clustering/i }),
    ).toBeNull();

    resolveConfig({ config: { enabled: true, cadence: 'daily' } });
    expect(
      await screen.findByRole('switch', { name: /enable campaign clustering/i }),
    ).toBeInTheDocument();
  });

  it('renders campaigns with name, case count and shared entities as plain text', async () => {
    renderCampaigns();
    await waitFor(() => expect(listMock).toHaveBeenCalled());

    expect(await screen.findByText('Campaigns')).toBeInTheDocument();
    expect(screen.getByText('Lateral movement — 10.0.0.5')).toBeInTheDocument();
    // Entity value renders as plain text (InlineCode).
    expect(screen.getAllByText('10.0.0.5').length).toBeGreaterThan(0);
    // MITRE ids render as plain text badges.
    expect(screen.getByText('T1021')).toBeInTheDocument();
  });

  it('opens the detail sheet with member cases on row click', async () => {
    renderCampaigns();
    const row = await screen.findByText('Lateral movement — 10.0.0.5');
    fireEvent.click(row);

    // Member case ids appear in the detail sheet.
    await waitFor(() => expect(screen.getByText('case-1')).toBeInTheDocument());
    expect(screen.getByText('case-2')).toBeInTheDocument();
  });

  it('deep-links to a member case via onNavigate', async () => {
    const { onNavigate } = renderCampaigns();
    const row = await screen.findByText('Lateral movement — 10.0.0.5');
    fireEvent.click(row);
    await screen.findByText('case-1');

    const openButtons = screen.getAllByRole('button', { name: /^open$/i });
    fireEvent.click(openButtons[0]);
    expect(onNavigate).toHaveBeenCalledWith('cases', { caseId: 'case-1' });
  });

  it('Refresh reloads the campaign list without discarding unsaved policy edits', async () => {
    renderCampaigns();

    // The config form renders after the policy load resolves (loading skeleton first).
    const toggle = await screen.findByRole('switch', { name: /enable campaign clustering/i });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(apiGetMock).toHaveBeenCalledTimes(1);

    // Edit the policy — the draft is now dirty.
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));

    // The list reloaded, but the config was NOT re-fetched (no clobber) and the
    // unsaved edit survives.
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
    expect(apiGetMock).toHaveBeenCalledTimes(1);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('recorrelates via campaignsApi.recorrelate', async () => {
    renderCampaigns();
    await screen.findByText('Lateral movement — 10.0.0.5');

    const btn = screen.getByRole('button', { name: /recorrelate/i });
    fireEvent.click(btn);
    await waitFor(() => expect(recorrelateMock).toHaveBeenCalled());
  });
});

describe('CampaignChip', () => {
  it('renders a "part of campaign" label as plain text and fires onOpen', () => {
    const onOpen = vi.fn();
    render(
      <CampaignChip
        campaign={{ id: 'camp-x', name: 'Phishing wave', case_count: 5 }}
        onOpen={onOpen}
      />,
    );
    const label = screen.getByText(/part of campaign: phishing wave/i);
    expect(label).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: /part of campaign phishing wave/i });
    fireEvent.click(btn);
    expect(onOpen).toHaveBeenCalled();
  });

  it('falls back to the campaign id when unnamed', () => {
    render(<CampaignChip campaign={{ id: 'camp-y', name: '', case_count: 0 }} />);
    expect(within(screen.getByText(/part of campaign:/i)).queryByText(/camp-y/)).toBeTruthy();
  });
});
