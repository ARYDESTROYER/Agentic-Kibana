/**
 * TabbedPage host-width authority (Round-6 §40).
 *
 * BUG: a TabbedPage host (Home = Dashboard|Standup, Workspace = Chat|Investigate,
 * Intelligence = Knowledge|Memory|Playbooks) used to render its segmented tab STRIP
 * at the full AppShell gutter (1×) while its embedded sub-pages wrapped their OWN
 * `PageContainer(wide)` — capped + centered. On ultrawide the strip visibly failed to
 * line up with the content it controls.
 *
 * FIX: TabbedPage now wraps the WHOLE host (strip + bodies) in ONE `PageContainer`
 * (default `wide`), so the strip and its sub-page content share exactly ONE centered
 * gutter. Sub-pages that also declare their own `PageContainer(wide)` nest harmlessly
 * (same cap → width-identical). jsdom runs no CSS layout, so we assert on the emitted
 * Tailwind width contract (same approach as PageContainer.test.tsx).
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';

import { TabbedPage } from '../TabbedPage';

const TABS = [
  { value: 'a', label: 'A', content: <div>body-a</div> },
  { value: 'b', label: 'B', content: <div>body-b</div> },
];

/** Pull the class list of the single root box TabbedPage renders. */
function classesOf(node: HTMLElement | null): string {
  return node?.getAttribute('class') ?? '';
}

describe('TabbedPage host width authority (Round-6 §40)', () => {
  it('wraps the whole host in a `wide` PageContainer by default so the strip aligns with its body', () => {
    const { container } = render(<TabbedPage tabs={TABS} />);
    const root = container.firstElementChild as HTMLElement;
    const cls = classesOf(root);
    // The strip + bodies now sit inside the SAME wide, centered container as the
    // sub-pages' own PageContainer(wide) — so they line up.
    expect(cls).toContain('max-w-[1760px]');
    expect(cls).toContain('2xl:max-w-[1920px]');
    expect(cls).toContain('mx-auto');
    // Vertical rhythm between the (optional) header + the Tabs is preserved.
    expect(cls).toContain('space-y-6');
  });

  it('honors an explicit `container` variant (e.g. a focused/prose host)', () => {
    const { container } = render(<TabbedPage tabs={TABS} container="fixed" />);
    const cls = classesOf(container.firstElementChild as HTMLElement);
    expect(cls).toContain('max-w-[1200px]');
    expect(cls).not.toContain('max-w-[1760px]');
  });

  it('does NOT re-declare the page gutter (owned once by the AppShell content wrapper)', () => {
    const { container } = render(<TabbedPage tabs={TABS} />);
    const cls = classesOf(container.firstElementChild as HTMLElement);
    for (const gutter of ['px-4', 'sm:px-6', 'lg:px-8', '2xl:px-12']) {
      expect(cls).not.toContain(gutter);
    }
  });

  it('still renders the active tab body', () => {
    const { getByText } = render(<TabbedPage tabs={TABS} value="b" />);
    expect(getByText('body-b')).toBeTruthy();
  });
});
