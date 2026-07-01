/**
 * NumberField — clamp spec (W0-B1). The clamp math is the load-bearing behavior:
 *   - below min → min; above max → max; empty/NaN → default (or min);
 *   - blur commits the clamped value via onChange;
 *   - the pure `clampNumber` helper snaps to step + honors bounds.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TooltipProvider } from '@/ui/tooltip';

import { NumberField, clampNumber } from '../NumberField';

function renderField(props: Partial<React.ComponentProps<typeof NumberField>> = {}) {
  const onChange = vi.fn();
  render(
    <TooltipProvider>
      <NumberField label="Window" value={5} min={1} max={10} onChange={onChange} {...props} />
    </TooltipProvider>,
  );
  return { onChange };
}

describe('clampNumber', () => {
  it('clamps to [min, max]', () => {
    expect(clampNumber(-3, { min: 0, max: 10 })).toBe(0);
    expect(clampNumber(99, { min: 0, max: 10 })).toBe(10);
    expect(clampNumber(5, { min: 0, max: 10 })).toBe(5);
  });
  it('snaps to step granularity around min', () => {
    expect(clampNumber(7, { min: 0, max: 100, step: 5 })).toBe(5);
    expect(clampNumber(8, { min: 0, max: 100, step: 5 })).toBe(10);
  });
});

describe('NumberField', () => {
  it('clamps an over-max entry on blur', () => {
    const { onChange } = renderField();
    const input = screen.getByLabelText('Window');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '999' } });
    fireEvent.blur(input, { target: { value: '999' } });
    expect(onChange).toHaveBeenCalledWith(10);
  });

  it('clamps an under-min entry on blur', () => {
    const { onChange } = renderField();
    const input = screen.getByLabelText('Window');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '-4' } });
    fireEvent.blur(input, { target: { value: '-4' } });
    expect(onChange).toHaveBeenCalledWith(1);
  });

  it('empty entry falls back to default value on blur', () => {
    const { onChange } = renderField({ defaultValue: 3, value: 8 });
    const input = screen.getByLabelText('Window');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input, { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith(3);
  });

  it('increments via the stepper button within bounds', () => {
    const { onChange } = renderField({ value: 5, step: 2 });
    fireEvent.click(screen.getByLabelText('Increase'));
    expect(onChange).toHaveBeenCalledWith(7);
  });
});
