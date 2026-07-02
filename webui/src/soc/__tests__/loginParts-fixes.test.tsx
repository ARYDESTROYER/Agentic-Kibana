/**
 * Round-6 auth-login fixes for the presentational login building blocks
 * (components/auth/loginParts.tsx) — no API surface, so these mount the pieces
 * directly.
 *
 * Covers:
 *  - PasswordStrengthMeter: a non-empty score-0 password fills ≥1 (red) segment,
 *    distinct from the empty/untyped all-`bg-border` state (finding 13); the label
 *    uses the AA-tuned `-text` token, not the solid fill (finding 2).
 *  - OtpInput: typing a digit into a GAP cell packs it to the front AND moves focus
 *    to the next EMPTY cell (joined.length), never overshooting to clicked-index+1
 *    (finding 12).
 */
import * as React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { PasswordStrengthMeter, OtpInput } from '../components/auth/loginParts';

describe('PasswordStrengthMeter — non-empty weak password', () => {
  it('fills at least one red segment for a score-0 "Too weak" password', () => {
    const { container } = render(<PasswordStrengthMeter password="a" />);
    // score 0 → label "Too weak"; the meter must show ONE filled critical bar (the
    // rest stay bg-border), so it is not visually identical to the untyped state.
    expect(screen.getByText('Too weak')).toBeInTheDocument();
    expect(container.querySelectorAll('.bg-critical')).toHaveLength(1);
    expect(container.querySelectorAll('.bg-border')).toHaveLength(3);
  });

  it('labels weak/strong with the AA-tuned `-text` token (not the solid fill)', () => {
    render(<PasswordStrengthMeter password="a" />);
    expect(screen.getByText('Too weak')).toHaveClass('text-critical-text');
    expect(screen.getByText('Too weak')).not.toHaveClass('text-critical');

    render(<PasswordStrengthMeter password="C0rrectHorseBattery!" />);
    expect(screen.getByText('Strong')).toHaveClass('text-success-text');
    expect(screen.getByText('Strong')).not.toHaveClass('text-success');
  });
});

/** Controlled wrapper mirroring how Login drives the OTP field (value + onChange). */
const OtpHarness: React.FC = () => {
  const [value, setValue] = React.useState('');
  return <OtpInput value={value} onChange={setValue} />;
};

describe('OtpInput — gap-cell entry', () => {
  it('packs a digit typed into a gap cell to the front and focuses the next empty cell', () => {
    render(<OtpHarness />);
    const cells = screen.getAllByRole('textbox') as HTMLInputElement[];
    expect(cells).toHaveLength(6);

    // Type "5" into cell index 3 (a gap — nothing typed yet).
    fireEvent.change(cells[3], { target: { value: '5' } });

    // The digit re-packs to the FIRST cell (front-packed value), and focus lands on
    // the next empty cell (index 1 = joined.length), NOT the clicked index + 1 (=4).
    expect(cells[0].value).toBe('5');
    expect(cells[3].value).toBe('');
    expect(document.activeElement).toBe(cells[1]);
  });

  it('advances focus by one on contiguous typing', () => {
    render(<OtpHarness />);
    const cells = screen.getAllByRole('textbox') as HTMLInputElement[];
    fireEvent.change(cells[0], { target: { value: '1' } });
    expect(cells[0].value).toBe('1');
    expect(document.activeElement).toBe(cells[1]);
  });
});
