/**
 * avatar — encoding size-guard + initials code-point handling (Round-6 fixes).
 *
 *   1. encodeAvatarUnderLimit prefers WebP, falls back to JPEG (not a huge PNG),
 *      and NEVER returns a payload over the backend cap — fixing the opaque
 *      "avatar too large" rejection when a browser declines canvas WebP;
 *   2. initialsFrom indexes by code POINT so emoji / astral glyphs are not split
 *      into a lone surrogate that renders as a broken box.
 */
import { describe, it, expect } from 'vitest';

import { encodeAvatarUnderLimit, initialsFrom, AVATAR_MAX_LEN } from '../avatar';

/** A canvas stub whose toDataURL returns a caller-supplied string per requested type. */
function fakeCanvas(byType: Record<string, string>): Pick<HTMLCanvasElement, 'toDataURL'> {
  return {
    toDataURL: (type?: string) => byType[type ?? 'image/png'] ?? byType['image/png'] ?? '',
  } as Pick<HTMLCanvasElement, 'toDataURL'>;
}

/** Build a `data:image/<type>;base64,...` URL of a given total length. */
function dataUrl(type: 'png' | 'webp' | 'jpeg', length: number): string {
  const head = `data:image/${type};base64,`;
  return head + 'A'.repeat(Math.max(0, length - head.length));
}

describe('encodeAvatarUnderLimit', () => {
  it('returns the WebP encoding when the browser supports it (common path)', () => {
    const webp = dataUrl('webp', 5_000);
    const out = encodeAvatarUnderLimit(fakeCanvas({ 'image/webp': webp }));
    expect(out).toBe(webp);
  });

  it('falls back to JPEG (never a huge PNG) when the canvas declines WebP', () => {
    // Safari-style: toDataURL('image/webp') hands back a PNG instead.
    const png = dataUrl('png', 200_000);
    const jpeg = dataUrl('jpeg', 20_000);
    const out = encodeAvatarUnderLimit(
      fakeCanvas({ 'image/webp': png, 'image/jpeg': jpeg, 'image/png': png }),
    );
    expect(out).toBe(jpeg);
    expect(out!.length).toBeLessThan(AVATAR_MAX_LEN);
  });

  it('never returns a payload over the backend cap', () => {
    // Every format is oversized -> nothing fits -> null (caller shrinks/rejects).
    const png = dataUrl('png', 300_000);
    const out = encodeAvatarUnderLimit(
      fakeCanvas({ 'image/webp': png, 'image/jpeg': dataUrl('jpeg', 90_000), 'image/png': png }),
    );
    expect(out).toBeNull();
  });

  it('drops down the quality ladder until one WebP fits under the limit', () => {
    // First WebP over the safe limit, a lower-quality WebP under it.
    const big = dataUrl('webp', 100_000);
    const small = dataUrl('webp', 40_000);
    let call = 0;
    const canvas = {
      toDataURL: (type?: string, q?: number) => {
        if (type === 'image/webp') {
          call += 1;
          return q === 0.85 ? big : small;
        }
        return dataUrl('png', 100_000);
      },
    } as Pick<HTMLCanvasElement, 'toDataURL'>;
    const out = encodeAvatarUnderLimit(canvas);
    expect(out).toBe(small);
    expect(call).toBeGreaterThan(1);
  });

  it('ignores an unexpected/unaccepted mime the browser might emit', () => {
    const gif = 'data:image/gif;base64,AAAA';
    const jpeg = dataUrl('jpeg', 10_000);
    const out = encodeAvatarUnderLimit(fakeCanvas({ 'image/webp': gif, 'image/jpeg': jpeg }));
    expect(out).toBe(jpeg);
  });
});

describe('initialsFrom', () => {
  it('takes first + last initials from a two-word name', () => {
    expect(initialsFrom('Ada Lovelace')).toBe('AL');
    expect(initialsFrom('grace brewster hopper')).toBe('GH');
  });

  it('takes the first two letters of a single token', () => {
    expect(initialsFrom('root')).toBe('RO');
  });

  it('falls back to the second arg, then to "?"', () => {
    expect(initialsFrom('', 'analyst')).toBe('AN');
    expect(initialsFrom(null, null)).toBe('?');
    expect(initialsFrom('   ')).toBe('?');
  });

  it('keeps an astral-plane glyph whole (no lone surrogate) in a single token', () => {
    const out = initialsFrom('𝕏avier'); // U+1D54F is a surrogate pair in UTF-16
    // First code point is the whole 𝕏 (2 UTF-16 units), plus the next code point.
    expect(Array.from(out)).toEqual(['𝕏', 'A']);
    expect(out).not.toContain('�');
  });

  it('keeps astral first/last initials whole for a multi-word name', () => {
    const out = initialsFrom('🚀 Rocket'); // emoji is astral
    expect(Array.from(out)).toEqual(['🚀', 'R']);
    // Not a split high surrogate.
    expect(out.codePointAt(0)).toBe(0x1f680);
  });
});
