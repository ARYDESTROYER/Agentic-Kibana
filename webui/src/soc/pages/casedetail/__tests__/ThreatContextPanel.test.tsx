/**
 * ThreatContextPanel — asset-context guard (Round-6 finding #19).
 *
 * `criticality` is a top-level asset field rendered separately from `attributes`, so an
 * asset that carries ONLY a criticality must still render the asset card (not the empty
 * state that would silently drop the classification).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { ThreatContextPanel } from '../ThreatContextPanel';
import type { Case, ThreatContextPanel as ThreatContextPanelData } from '@/lib/types';

const CASE = { case_id: 'c1', verdict: 'true_positive', risk_score: 50 } as unknown as Case;

describe('ThreatContextPanel — asset context', () => {
  it('renders a criticality-only asset instead of the empty state (#19)', () => {
    const panel = { asset_context: { criticality: 'high' } } as unknown as ThreatContextPanelData;
    render(
      <ThreatContextPanel c={CASE} panel={panel} loading={false} error={null} onRetry={vi.fn()} />,
    );
    // The Criticality row renders...
    expect(screen.getByText('Criticality')).toBeInTheDocument();
    // ...and the "No asset context" empty state is NOT shown for this card.
    expect(screen.queryByText('No asset context')).toBeNull();
  });

  it('still shows the empty state when the asset is genuinely bare', () => {
    const panel = { asset_context: {} } as unknown as ThreatContextPanelData;
    render(
      <ThreatContextPanel c={CASE} panel={panel} loading={false} error={null} onRetry={vi.fn()} />,
    );
    expect(screen.getByText('No asset context')).toBeInTheDocument();
  });
});

describe('ThreatContextPanel — MITRE technique links (#32)', () => {
  it('gives each technique link a distinct, purposeful accessible name', () => {
    const panel = {
      mitre_techniques: [
        { id: 'T1110', name: 'Brute Force' },
        { id: 'T1078', name: 'Valid Accounts' },
      ],
    } as unknown as ThreatContextPanelData;
    render(
      <ThreatContextPanel c={CASE} panel={panel} loading={false} error={null} onRetry={vi.fn()} />,
    );
    // Not several identical "MITRE" links — each names its technique id.
    expect(
      screen.getByRole('link', { name: /Open MITRE ATT&CK T1110 in a new tab/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Open MITRE ATT&CK T1078 in a new tab/i }),
    ).toBeInTheDocument();
  });
});

describe('ThreatContextPanel — error state (#33)', () => {
  it('renders the shared LoadError (coerced message + Retry) instead of a hand-rolled Alert', () => {
    const onRetry = vi.fn();
    render(
      <ThreatContextPanel
        c={CASE}
        panel={null}
        loading={false}
        error={new Error('threat feed down')}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText('Could not load threat context')).toBeInTheDocument();
    expect(screen.getByText('threat feed down')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
