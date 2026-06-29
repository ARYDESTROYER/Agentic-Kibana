/**
 * Wave 2 / F3 — the dependency-free QR encoder.
 *
 * Asserts that `encodeQR` produces a square module matrix of a VALID QR version
 * (size = 4*version + 17, versions 1–10 → 21..73) for a sample otpauth URI, that it
 * is deterministic, and that the <QRCode> component renders an <svg> without crashing.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { encodeQR, QRCode } from '../components/QRCode';

const SAMPLE_URI =
  'otpauth://totp/Agentic%20SOC:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Agentic%20SOC&algorithm=SHA1&digits=6&period=30';

const VALID_SIZES = new Set(Array.from({ length: 10 }, (_, i) => (i + 1) * 4 + 17));

describe('encodeQR', () => {
  it('produces a square matrix of a valid QR version for an otpauth URI', () => {
    const m = encodeQR(SAMPLE_URI);
    expect(m).not.toBeNull();
    const matrix = m as boolean[][];
    const size = matrix.length;
    // Square.
    expect(matrix.every((row) => row.length === size)).toBe(true);
    // A valid version size (21,25,...,73).
    expect(VALID_SIZES.has(size)).toBe(true);
    // Has both dark and light modules (not a blank/solid grid).
    const dark = matrix.flat().filter(Boolean).length;
    expect(dark).toBeGreaterThan(0);
    expect(dark).toBeLessThan(size * size);
  });

  it('is deterministic (same input → same size + same modules)', () => {
    const a = encodeQR(SAMPLE_URI) as boolean[][];
    const b = encodeQR(SAMPLE_URI) as boolean[][];
    expect(a.length).toBe(b.length);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('encodes a short string into version 1 (21×21)', () => {
    const m = encodeQR('HELLO') as boolean[][];
    expect(m.length).toBe(21);
  });

  it('returns null for content too large for versions 1–10', () => {
    expect(encodeQR('x'.repeat(5000))).toBeNull();
  });
});

describe('<QRCode>', () => {
  it('renders an <svg> for a valid value', () => {
    const { container } = render(<QRCode value={SAMPLE_URI} size={180} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('width')).toBe('180');
    // Background rect + at least one dark module rect.
    expect(container.querySelectorAll('rect').length).toBeGreaterThan(1);
  });

  it('calls onError and renders nothing for unencodable content', () => {
    let errored = false;
    const { container } = render(
      <QRCode value={'x'.repeat(5000)} onError={() => { errored = true; }} />,
    );
    expect(container.querySelector('svg')).toBeNull();
    expect(errored).toBe(true);
  });
});
