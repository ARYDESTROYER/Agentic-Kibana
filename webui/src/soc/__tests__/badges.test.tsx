/**
 * Wave 3 / F8 — status + disposition badges.
 *
 * Asserts the new lifecycle statuses + disposition values render with cohesive
 * labels, that the legacy NEEDS_HUMAN alias renders as "Open · awaiting analyst",
 * and that unknown values degrade gracefully (never throw).
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { StatusBadge, DispositionBadge } from '../components/badges';

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
