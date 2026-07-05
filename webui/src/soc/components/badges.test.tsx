/**
 * badges.tsx — Round-7 W0.4 (#11 "Auto-closed by AI").
 *
 * There is no `auto_closed` STATUS in the backend. A case is "auto-closed by the
 * AI" when it reached a terminal lifecycle state (closed/resolved) AND the recorded
 * close decision came from the `agent` actor (`decision_by === 'agent'`). These
 * tests lock the ONE predicate + the self-hiding badge. The deterministic close
 * authority (#3) is untouched — the badge only reads who the recorded decider was.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { isAutoClosedByAI, AutoClosedBadge } from './badges';

describe('isAutoClosedByAI', () => {
  it('is true for the agent actor on a terminal status (closed/resolved)', () => {
    expect(isAutoClosedByAI('closed', 'agent')).toBe(true);
    expect(isAutoClosedByAI('resolved', 'agent')).toBe(true);
  });

  it('is false for a human/system decider even on a terminal status', () => {
    expect(isAutoClosedByAI('closed', 'analyst')).toBe(false);
    expect(isAutoClosedByAI('resolved', 'system')).toBe(false);
    expect(isAutoClosedByAI('closed', 'Admin')).toBe(false);
  });

  it('is false for a non-terminal (still-open) status even when the agent decided', () => {
    expect(isAutoClosedByAI('open', 'agent')).toBe(false);
    expect(isAutoClosedByAI('investigating', 'agent')).toBe(false);
    expect(isAutoClosedByAI('escalated', 'agent')).toBe(false);
    expect(isAutoClosedByAI('needs_human', 'agent')).toBe(false);
  });

  it('is false when either input is missing', () => {
    expect(isAutoClosedByAI(null, 'agent')).toBe(false);
    expect(isAutoClosedByAI('closed', null)).toBe(false);
    expect(isAutoClosedByAI(undefined, undefined)).toBe(false);
    expect(isAutoClosedByAI('', '')).toBe(false);
  });

  it('is case/whitespace tolerant on both inputs', () => {
    expect(isAutoClosedByAI(' CLOSED ', ' Agent ')).toBe(true);
    expect(isAutoClosedByAI('Resolved', 'AGENT')).toBe(true);
  });
});

describe('AutoClosedBadge', () => {
  it('renders the label with the Bot glyph and the info variant', () => {
    const { container } = render(<AutoClosedBadge status="closed" decisionBy="agent" />);
    expect(screen.getByText(/Auto-closed by AI/)).toBeInTheDocument();

    // Non-color signaling (§6.1): the Bot glyph accompanies the label.
    const icon = container.querySelector('svg');
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute('class') ?? '').toContain('lucide-bot');

    // The badge uses the `info` variant (neutral blue-grey wash).
    const badge = container.firstElementChild as HTMLElement;
    expect(badge.className).toContain('text-info-text');
  });

  it('self-hides (renders nothing) when the case was not auto-closed by the AI', () => {
    const { container: human } = render(
      <AutoClosedBadge status="closed" decisionBy="analyst" />,
    );
    expect(human.firstChild).toBeNull();

    const { container: open } = render(
      <AutoClosedBadge status="investigating" decisionBy="agent" />,
    );
    expect(open.firstChild).toBeNull();
  });

  it('appends the objection window only when opted in AND the window is still open', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    render(
      <AutoClosedBadge
        status="closed"
        decisionBy="agent"
        objectionWindowExpiresAt={future}
        showObjection
      />,
    );
    expect(screen.getByText(/reopen before/)).toBeInTheDocument();
  });

  it('omits the objection note when the window has already expired', () => {
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    render(
      <AutoClosedBadge
        status="closed"
        decisionBy="agent"
        objectionWindowExpiresAt={past}
        showObjection
      />,
    );
    expect(screen.queryByText(/reopen before/)).toBeNull();
  });

  it('omits the objection note when not opted in even with an open window', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    render(
      <AutoClosedBadge status="closed" decisionBy="agent" objectionWindowExpiresAt={future} />,
    );
    expect(screen.queryByText(/reopen before/)).toBeNull();
  });
});
