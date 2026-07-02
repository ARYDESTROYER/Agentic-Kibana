/**
 * Button variants — the destructive variant pairs its severity-axis fill with the
 * MATCHING on-fill text token (round-6 ui-theme).
 *
 * `bg-critical` must be paired with `text-critical-foreground` (its own axis token),
 * not the cross-axis `text-primary-foreground` it borrowed before — mirroring the
 * badge primitive's destructive variant so the two can't drift on a future re-tune.
 */
import { describe, it, expect } from 'vitest';
import { buttonVariants } from '../button';

describe('buttonVariants destructive', () => {
  it('pairs bg-critical with text-critical-foreground (same axis)', () => {
    const cls = buttonVariants({ variant: 'destructive' });
    expect(cls).toContain('bg-critical');
    expect(cls).toContain('text-critical-foreground');
  });

  it('no longer borrows the cross-axis text-primary-foreground', () => {
    const cls = buttonVariants({ variant: 'destructive' });
    expect(cls).not.toContain('text-primary-foreground');
  });

  it('leaves the default variant on the primary axis (bg-primary + text-primary-foreground)', () => {
    const cls = buttonVariants({ variant: 'default' });
    expect(cls).toContain('bg-primary');
    expect(cls).toContain('text-primary-foreground');
  });
});
