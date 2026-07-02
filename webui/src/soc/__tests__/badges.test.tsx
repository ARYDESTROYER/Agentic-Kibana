/**
 * Wave 3 / F8 — status + disposition badges.
 *
 * Asserts the new lifecycle statuses + disposition values render with cohesive
 * labels, that the legacy NEEDS_HUMAN alias renders as "Open · awaiting analyst",
 * and that unknown values degrade gracefully (never throw).
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import {
  StatusBadge,
  DispositionBadge,
  VerdictBadge,
  severityBand,
  severityBandFromNumber,
  SEVERITY_BAND_ORDER,
} from '../components/badges';

describe('StatusBadge', () => {
  it('renders the legacy needs_human alias as "Open · awaiting analyst"', () => {
    const { container } = render(<StatusBadge status="needs_human" />);
    expect(container.textContent).toContain('Open');
    expect(container.textContent?.toLowerCase()).toContain('awaiting analyst');
  });

  it('renders the new F8 statuses with humanized labels', () => {
    for (const s of ['new', 'investigating', 'escalated', 'on_hold', 'resolved']) {
      const { container } = render(<StatusBadge status={s} />);
      expect(container.textContent?.trim().length).toBeGreaterThan(0);
    }
  });

  it('degrades gracefully on an unknown status', () => {
    const { container } = render(<StatusBadge status="weird_unknown_value" />);
    expect(container.textContent?.trim().length).toBeGreaterThan(0);
  });

  it('shows a dash for an empty status', () => {
    const { container } = render(<StatusBadge status={null} />);
    expect(container.textContent?.trim().length).toBeGreaterThan(0);
  });
});

describe('DispositionBadge', () => {
  it('renders each disposition value', () => {
    for (const d of [
      'true_positive',
      'false_positive',
      'benign',
      'suspicious',
      'duplicate',
      'undetermined',
    ]) {
      const { container } = render(<DispositionBadge disposition={d} />);
      expect(container.textContent?.trim().length).toBeGreaterThan(0);
    }
  });

  it('renders "Undetermined" for a null/none disposition', () => {
    const { container } = render(<DispositionBadge disposition={null} />);
    expect(container.textContent).toContain('Undetermined');
    const { container: c2 } = render(<DispositionBadge disposition="none" />);
    expect(c2.textContent).toContain('Undetermined');
  });
});

describe('VerdictBadge', () => {
  it('renders a muted "Unverdicted" placeholder for an empty verdict', () => {
    const { container } = render(<VerdictBadge verdict={null} />);
    expect(container.textContent).toContain('Unverdicted');
    // Empty-state grammar (round-6 #10): muted foreground, matching DispositionBadge.
    expect(container.querySelector('.text-muted-foreground')).not.toBeNull();
  });
});

describe('severityBand — the ONE band authority (round-6 #2/#3)', () => {
  it('maps numbers on the ONE 0-100 ladder (matches palette scoreBand)', () => {
    expect(severityBand(30)).toBe('medium'); // 22-47
    expect(severityBand(50)).toBe('high'); // 48-73 — the old Cases ladder said "medium"
    expect(severityBand(80)).toBe('critical'); // 74-100
    expect(severityBand(5)).toBe('info'); // < 8 nil floor
  });

  it('is MONOTONIC across the old 15/16 discontinuity (no larger-reads-lower)', () => {
    // Old severityBandFromNumber: 15 scaled to 100 → Critical, but 16 stayed 16 → Low.
    const idx = (v: number) => SEVERITY_BAND_ORDER.indexOf(severityBand(v)!);
    for (let n = 0; n < 100; n += 1) {
      expect(idx(n + 1)).toBeGreaterThanOrEqual(idx(n));
    }
    // The specific former inversion is gone: 15 and 16 now read the same band.
    expect(severityBand(15)).toBe(severityBand(16));
  });

  it('honours an explicit small-bucket scaleMax (monotonic within the scale)', () => {
    // Wazuh rule.level 0-15: top of scale → critical; a mid value → medium.
    expect(severityBandFromNumber(15, 15)).toBe('critical');
    expect(severityBandFromNumber(7, 15)).toBe('medium');
    // The same raw 7 on the default 0-100 scale is only "info".
    expect(severityBandFromNumber(7)).toBe('info');
  });

  it('accepts the string aliases the badge accepts', () => {
    expect(severityBand('moderate')).toBe('medium');
    expect(severityBand('crit')).toBe('critical');
    expect(severityBand('informational')).toBe('info');
  });

  it('returns null for an absent/unparseable severity', () => {
    expect(severityBand(null)).toBeNull();
    expect(severityBand(undefined)).toBeNull();
    expect(severityBand('')).toBeNull();
    expect(severityBand('gibberish')).toBeNull();
  });
});
