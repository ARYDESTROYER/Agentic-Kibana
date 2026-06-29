/**
 * QRCode regression tests (BUG-2a) — the MFA QR must be SCANNABLE.
 *
 * The historical bug: the second format-info copy was placed inverted vs
 * ISO/IEC 18004 §8.9 — it wrote bits 0..7 down the vertical bottom-left and bits
 * 8..14 across only 7 horizontal columns, leaving column `size-8` of row 8 a
 * permanent null module AND making the two 15-bit format copies disagree, so
 * conformant readers rejected the symbol (manual secret entry still worked).
 *
 * These tests pin the fix: a fully-populated (no-null) square matrix, the correct
 * version dimensions, both format-info copies equal each other AND equal the
 * expected FORMAT_INFO for the chosen mask + EC level M, and an SVG quiet zone
 * (margin) of >= 4 modules.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import {
  QRCode,
  encodeMatrix,
  encodeQR,
  FORMAT_INFO_M,
} from '../QRCode';

const OTPAUTH =
  'otpauth://totp/AgenticSOC:admin?secret=JBSWY3DPEHPK3PXP&issuer=AgenticSOC&algorithm=SHA1&digits=6&period=30';

/**
 * Read the first (top-left) 15-bit format copy from the matrix, matching the
 * placement convention in placeFormatInfo: bits 0..7 along row 8 (skipping the
 * timing column at col 6), bits 8..14 up column 8 (skipping the timing row at 6).
 */
function readFormatCopy1(m: Array<Array<0 | 1 | null>>): number {
  let v = 0;
  for (let i = 0; i < 15; i++) {
    let cell: 0 | 1 | null;
    if (i < 6) cell = m[8][i];
    else if (i === 6) cell = m[8][7];
    else if (i === 7) cell = m[8][8];
    else if (i === 8) cell = m[7][8];
    else cell = m[14 - i][8];
    v |= (cell ? 1 : 0) << i;
  }
  return v;
}

/**
 * Read the second (split) 15-bit format copy: bits 0..7 along the HORIZONTAL
 * top-right strip (row 8, cols size-1..size-8), bits 8..14 up the VERTICAL
 * bottom-left strip (col 8, rows size-7..size-1).
 */
function readFormatCopy2(m: Array<Array<0 | 1 | null>>): number {
  const size = m.length;
  let v = 0;
  for (let i = 0; i < 15; i++) {
    const cell = i < 8 ? m[8][size - 1 - i] : m[size - 15 + i][8];
    v |= (cell ? 1 : 0) << i;
  }
  return v;
}

describe('QRCode encodeMatrix (otpauth enrollment URI)', () => {
  const res = encodeMatrix(OTPAUTH);

  it('encodes the URI (does not overflow versions 1–10)', () => {
    expect(res).not.toBeNull();
  });

  it('produces a square matrix with the expected version dimensions', () => {
    if (!res) throw new Error('expected a matrix');
    const size = res.version * 4 + 17;
    expect(res.matrix.length).toBe(size);
    for (const row of res.matrix) expect(row.length).toBe(size);
    // This payload is ~110 bytes → version 7 (45×45) at ECC-M.
    expect(res.version).toBe(7);
    expect(res.matrix.length).toBe(45);
  });

  it('has ZERO null/undefined modules anywhere (no permanent null cell)', () => {
    if (!res) throw new Error('expected a matrix');
    for (let r = 0; r < res.matrix.length; r++) {
      for (let c = 0; c < res.matrix.length; c++) {
        const cell = res.matrix[r][c];
        expect(cell === 0 || cell === 1).toBe(true);
      }
    }
  });

  it('places both 15-bit format copies equal to each other AND to FORMAT_INFO_M[mask]', () => {
    if (!res) throw new Error('expected a matrix');
    const expected = FORMAT_INFO_M[res.mask];
    const copy1 = readFormatCopy1(res.matrix);
    const copy2 = readFormatCopy2(res.matrix);
    expect(copy1).toBe(expected);
    expect(copy2).toBe(expected);
    expect(copy1).toBe(copy2);
  });

  it('keeps the fixed dark module at m[size-8][8]', () => {
    if (!res) throw new Error('expected a matrix');
    const size = res.matrix.length;
    expect(res.matrix[size - 8][8]).toBe(1);
  });
});

describe('QRCode encodeQR (boolean coercion)', () => {
  it('returns an all-boolean square matrix', () => {
    const m = encodeQR(OTPAUTH);
    expect(m).not.toBeNull();
    if (!m) return;
    for (const row of m) for (const cell of row) expect(typeof cell).toBe('boolean');
  });
});

describe('QRCode SVG render (quiet zone)', () => {
  it('renders an SVG whose viewBox embeds a quiet zone (margin) of >= 4 modules', () => {
    const { container } = render(<QRCode value={OTPAUTH} size={180} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    const res = encodeMatrix(OTPAUTH);
    if (!res || !svg) throw new Error('expected matrix + svg');
    const count = res.matrix.length;
    const viewBox = svg.getAttribute('viewBox') ?? '';
    const parts = viewBox.split(/\s+/).map(Number);
    // viewBox = "0 0 total total" where total = count + 2*margin.
    const total = parts[2];
    expect(total).toBe(parts[3]);
    const margin = (total - count) / 2;
    expect(Number.isInteger(margin)).toBe(true);
    expect(margin).toBeGreaterThanOrEqual(4);
    // Render size is comfortably scannable.
    expect(Number(svg.getAttribute('width'))).toBeGreaterThanOrEqual(160);
  });
});
