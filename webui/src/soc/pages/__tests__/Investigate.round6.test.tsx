/**
 * Investigate page — Round-6 sweep regressions.
 *
 * Covers the three behavior fixes on the ad-hoc investigation form:
 *   - the entity-type switch is now the shared SegmentedControl (Radix Tabs →
 *     role=tab/tablist with roving arrow focus), NOT a hand-rolled radiogroup,
 *   - the empty-submit validation error is announced (role="alert") and wired to
 *     the input via aria-describedby,
 *   - replaying a recent run clears any stale empty-submit error state.
 *
 * `@/lib/api` and the heavy CaseDetail sheet are mocked (no network).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { getSettingsMock, investigateMock } = vi.hoisted(() => ({
  getSettingsMock: vi.fn(),
  investigateMock: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { ...actual.api, getSettings: getSettingsMock, investigate: investigateMock },
  };
});

// CaseDetail is a heavy sheet unrelated to these behaviors — stub it out.
vi.mock('@/soc/pages/CaseDetail', () => ({ CaseDetail: () => null }));

import { TooltipProvider } from '@/ui/tooltip';
import Investigate from '../Investigate';

const RECENT_KEY = 'tlsoc.investigate.recent';

const RECENT = [
  {
    id: 'r1',
    entity: { type: 'ip', value: '10.0.0.5' },
    lookback: 'now-24h',
    case: {
      case_id: 'case-1',
      title: 'Recent run',
      verdict: 'benign',
      risk_score: 12,
      status: 'closed',
    },
  },
];

function renderPage() {
  return render(
    <TooltipProvider>
      <Investigate onNavigate={vi.fn()} />
    </TooltipProvider>,
  );
}

describe('Investigate — Round-6 sweep', () => {
  beforeEach(() => {
    getSettingsMock.mockReset();
    investigateMock.mockReset();
    getSettingsMock.mockResolvedValue({ prefs: {} });
    sessionStorage.clear();
  });
  afterEach(() => sessionStorage.clear());

  it('renders the entity-type switch as an accessible SegmentedControl (radiogroup)', () => {
    renderPage();
    // SegmentedControl is a single-select value picker built on Radix RadioGroup, so
    // it exposes role="radiogroup" + role="radio" (not the dangling role="tab" of the
    // old Tabs build, which pointed aria-controls at a tabpanel that never existed).
    expect(screen.getByRole('radiogroup')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'IP' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'User' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Host' })).toBeInTheDocument();
  });

  it('announces the empty-submit error (role=alert) and links it via aria-describedby', () => {
    renderPage();
    const input = screen.getByRole('textbox', { name: /IP to investigate/i });
    fireEvent.keyDown(input, { key: 'Enter' });

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/enter a ip value to investigate/i);
    expect(alert).toHaveAttribute('id', 'investigate-entity-error');
    expect(input).toHaveAttribute('aria-describedby', 'investigate-entity-error');
  });

  it('clears a stale empty-submit error when a recent run is replayed', async () => {
    sessionStorage.setItem(RECENT_KEY, JSON.stringify(RECENT));
    renderPage();

    const input = screen.getByRole('textbox', {
      name: /IP to investigate/i,
    }) as HTMLInputElement;

    // Trigger the empty-submit error.
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('alert')).toBeInTheDocument();

    // Replay the recent run — the field is repopulated with a valid value.
    fireEvent.click(screen.getByRole('button', { name: /replay .*10\.0\.0\.5/i }));

    await waitFor(() => expect(input.value).toBe('10.0.0.5'));
    // The stale validation error must be gone once the field is valid again.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(input).not.toHaveAttribute('aria-describedby');
  });
});
