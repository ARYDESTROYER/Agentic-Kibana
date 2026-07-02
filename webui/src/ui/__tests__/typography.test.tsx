/**
 * typography — the heading/overline steps match DESIGN_STANDARD §2.4
 * (round-6 ui-theme #56 / #57): H4 = text-lg (16/24, was 14px text-base) and the
 * Eyebrow overline = text-xs (12px, was 11px text-2xs).
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Heading, Eyebrow } from '../typography';

function tokens(el: Element): string[] {
  return el.className.split(/\s+/).filter(Boolean);
}

describe('typography — scale steps match §2.4', () => {
  it('Heading level 4 renders at text-lg (16/24), not text-base', () => {
    const { getByText } = render(<Heading level={4}>Sub heading</Heading>);
    const h = getByText('Sub heading');
    expect(h.tagName).toBe('H4');
    expect(tokens(h)).toContain('text-lg');
    expect(tokens(h)).not.toContain('text-base');
  });

  it('Eyebrow overline renders at text-xs (12px), not text-2xs', () => {
    const { getByText } = render(<Eyebrow>Section</Eyebrow>);
    const e = getByText('Section');
    expect(tokens(e)).toContain('text-xs');
    expect(tokens(e)).not.toContain('text-2xs');
  });
});
