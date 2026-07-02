/**
 * Round-6 #44 — NumPref (shared Settings numeric field) is now clearable.
 *
 * The old `value={value ?? 0}` controlled input (a) showed a literal "0" for an unset
 * pref and (b) snapped back to 0 the instant the field was cleared, making
 * clear-and-retype impossible. NumPref now keeps raw text WHILE editing and commits a
 * parsed, clamped value ON BLUR (empty → min).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { NumPref } from '../primitives';

describe('NumPref (Round-6 #44)', () => {
  it('renders empty (not "0") for an unset value', () => {
    render(<NumPref label="Top K" value={undefined} onChange={() => {}} />);
    expect((screen.getByLabelText('Top K') as HTMLInputElement).value).toBe('');
  });

  it('does not commit 0 the moment the field is cleared mid-edit', () => {
    const onChange = vi.fn();
    render(<NumPref label="Top K" value={5} min={1} onChange={onChange} />);
    const input = screen.getByLabelText('Top K') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '' } });
    expect(input.value).toBe('');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('commits the parsed, clamped value on blur', () => {
    const onChange = vi.fn();
    render(<NumPref label="Top K" value={5} min={1} max={10} onChange={onChange} />);
    const input = screen.getByLabelText('Top K') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '99' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(10); // clamped to max
  });

  it('falls back to min (not 0) when cleared and blurred', () => {
    const onChange = vi.fn();
    render(<NumPref label="Top K" value={5} min={2} onChange={onChange} />);
    const input = screen.getByLabelText('Top K') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(2);
  });
});
