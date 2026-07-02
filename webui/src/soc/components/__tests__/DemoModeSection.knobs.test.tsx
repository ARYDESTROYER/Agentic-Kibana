/**
 * Round-6 #31 / #32 — the Demo Mode config knobs adopt the shared NumberField /
 * LabeledSlider primitives (steppers + clamp-on-blur + raw-text-while-editing) instead
 * of a hand-rolled raw `<input type=number>` that snapped to 0 on clear and never clamped.
 *
 * `useDemo()` returns a safe OFF default without a provider, so the enable form (with the
 * knobs) renders standalone.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { DemoModeSection } from '../DemoModeSection';
import { TooltipProvider } from '@/ui/tooltip';

const renderDemo = () =>
  render(
    <TooltipProvider>
      <DemoModeSection />
    </TooltipProvider>,
  );

describe('DemoModeSection knobs (Round-6 #31/#32)', () => {
  it('renders NumberField steppers and clamps an over-range History value on blur', () => {
    renderDemo();
    // NumberField exposes +/- IconButtons — proof the raw number input was replaced.
    expect(screen.getAllByRole('button', { name: 'Increase' }).length).toBeGreaterThan(0);

    const history = screen.getByLabelText('History') as HTMLInputElement;
    fireEvent.focus(history);
    fireEvent.change(history, { target: { value: '999' } });
    fireEvent.blur(history);
    expect(history.value).toBe('90'); // clamped to max (was forwarded verbatim before)
  });

  it('does not collapse the History field to 0 when cleared mid-edit', () => {
    renderDemo();
    const history = screen.getByLabelText('History') as HTMLInputElement;
    fireEvent.focus(history);
    fireEvent.change(history, { target: { value: '' } });
    expect(history.value).toBe(''); // stays empty (old raw input snapped to 0)
  });
});
