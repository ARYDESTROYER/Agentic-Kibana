/**
 * Round-6 #27 — `hslTripletToHex` converts the `H S% L%` CSS triplet our severity
 * colour tokens store into `#rrggbb`, so an UNSET design-token swatch can show the
 * theme's real current colour instead of a misleading black.
 */
import { describe, it, expect } from 'vitest';

import { hslTripletToHex } from '../BrandingEditor';

describe('hslTripletToHex (Round-6 #27)', () => {
  it('converts the primary hues', () => {
    expect(hslTripletToHex('0 100% 50%')).toBe('#ff0000');
    expect(hslTripletToHex('120 100% 50%')).toBe('#00ff00');
    expect(hslTripletToHex('240 100% 50%')).toBe('#0000ff');
  });

  it('handles achromatic greys', () => {
    expect(hslTripletToHex('0 0% 0%')).toBe('#000000');
    expect(hslTripletToHex('0 0% 100%')).toBe('#ffffff');
    expect(hslTripletToHex('0 0% 50%')).toBe('#808080');
  });

  it('returns a valid non-black hex for a realistic crimson severity token', () => {
    const hex = hslTripletToHex('347 77% 50%');
    expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    expect(hex).not.toBe('#000000');
  });

  it('returns null on a malformed triplet (a hex, missing %, or garbage)', () => {
    expect(hslTripletToHex('#ff0000')).toBeNull();
    expect(hslTripletToHex('0 50 50')).toBeNull();
    expect(hslTripletToHex('not a triplet')).toBeNull();
  });
});
