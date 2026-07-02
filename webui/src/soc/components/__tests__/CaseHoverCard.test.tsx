/**
 * CaseHoverCard — keyboard-focusable trigger (Round-6 finding #22, WCAG 1.4.13).
 *
 * The preview must be reachable on FOCUS, not only on hover. Consumers pass a
 * non-focusable <span>/<div>, so the component defaults tabIndex=0 on the trigger
 * (Radix HoverCard opens on trigger focus) — without overriding a child that already
 * manages its own tab index.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { CaseHoverCard } from '../CaseHoverCard';
import type { Case } from '@/lib/types';

const CASE = { case_id: 'c1', status: 'open', title: 'A case' } as unknown as Case;

describe('CaseHoverCard trigger focusability (#22)', () => {
  it('makes a non-focusable <span> trigger keyboard-focusable', () => {
    render(
      <CaseHoverCard case={CASE}>
        <span data-testid="trg">Case c1</span>
      </CaseHoverCard>,
    );
    expect(screen.getByTestId('trg')).toHaveAttribute('tabindex', '0');
  });

  it('does not override a child that already sets its own tabIndex', () => {
    render(
      <CaseHoverCard case={CASE}>
        <button data-testid="btn" tabIndex={-1}>
          Case c1
        </button>
      </CaseHoverCard>,
    );
    expect(screen.getByTestId('btn')).toHaveAttribute('tabindex', '-1');
  });
});
