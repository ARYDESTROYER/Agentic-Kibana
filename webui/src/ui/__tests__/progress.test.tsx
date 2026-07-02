/**
 * Progress — the visible fill, Radix data-state, and derived aria stay consistent
 * for out-of-range values (round-6 ui-theme #48). We clamp the value BEFORE handing
 * it to Radix, so an out-of-range value no longer console.errors + flips the bar to
 * data-state="indeterminate" (dropping aria-valuenow) while the fill shows 100%.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { Progress } from '../progress';

describe('Progress — clamps the value before forwarding to Radix', () => {
  it('stays determinate (no console.error) for values above 100', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { getByRole } = render(<Progress value={150} />);
    const bar = getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '100');
    expect(bar.getAttribute('data-state')).not.toBe('indeterminate');
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('clamps negatives to 0', () => {
    const { getByRole } = render(<Progress value={-20} />);
    expect(getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  });

  it('passes a normal value through unchanged', () => {
    const { getByRole } = render(<Progress value={42} />);
    expect(getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42');
  });
});
