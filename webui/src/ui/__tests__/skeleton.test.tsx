/**
 * SkeletonCard — body-line widths stay visible for large `lines` counts, and the
 * unused SkeletonRow dead export is gone (round-6 ui-theme #51 / #52).
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import * as SkeletonModule from '../skeleton';
import { Skeleton, SkeletonCard } from '../skeleton';

describe('Skeleton — static loading geometry', () => {
  it('reserves layout without adding a second loading animation', () => {
    const { container } = render(<Skeleton className="h-8 w-24" />);
    const block = container.firstElementChild;

    expect(block).toHaveAttribute('aria-hidden', 'true');
    expect(block).toHaveClass('bg-muted/75');
    expect(block).not.toHaveClass('shimmer');
    expect(block).not.toHaveClass('animate-pulse');
  });
});

describe('SkeletonCard — body-line widths are floored', () => {
  it('never renders a sub-visible / negative width for large `lines`', () => {
    const { container } = render(<SkeletonCard lines={9} />);
    // Only the body lines carry an inline `width` style (header + icon do not).
    const lines = Array.from(container.querySelectorAll<HTMLElement>('[style]'));
    expect(lines.length).toBe(9);
    for (const el of lines) {
      const w = parseFloat(el.style.width);
      expect(w).toBeGreaterThanOrEqual(28);
      expect(w).toBeLessThanOrEqual(92);
    }
  });
});

describe('skeleton module — dead SkeletonRow removed', () => {
  it('no longer exports SkeletonRow', () => {
    expect('SkeletonRow' in SkeletonModule).toBe(false);
    expect('Skeleton' in SkeletonModule).toBe(true);
    expect('SkeletonCard' in SkeletonModule).toBe(true);
  });
});
