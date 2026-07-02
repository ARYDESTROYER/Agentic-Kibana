/**
 * Page-archetype layout tests (Round-6 shell-chrome batch) — the aside/context rails
 * must be FULL-WIDTH when the layout stacks on small screens, and only take their fixed
 * width at the two-column breakpoint. jsdom doesn't run CSS layout, so we assert on the
 * emitted responsive width classes (which ARE the responsive contract Tailwind compiles).
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';

import { WorklistLayout, InvestigationLayout } from '../layouts';

describe('WorklistLayout — responsive aside rail', () => {
  it('is full-width when stacked and only `lg:w-64` at the row breakpoint', () => {
    const { container } = render(
      <WorklistLayout header={{ title: 'Queue' }} aside={<div>filters</div>}>
        <div>list</div>
      </WorklistLayout>,
    );
    const aside = container.querySelector('aside');
    expect(aside).not.toBeNull();
    const cls = aside?.getAttribute('class') ?? '';
    expect(cls).toContain('w-full');
    expect(cls).toContain('lg:w-64');
    // The fixed width must be breakpoint-guarded (never an unconditional `w-64`).
    expect(cls).not.toMatch(/(^|\s)w-64(\s|$)/);
  });
});

describe('InvestigationLayout — responsive context rail', () => {
  it('is full-width when stacked and only `xl:w-80` at the row breakpoint', () => {
    const { container } = render(
      <InvestigationLayout header={{ title: 'Case' }} context={<div>threat</div>}>
        <div>body</div>
      </InvestigationLayout>,
    );
    const aside = container.querySelector('aside');
    expect(aside).not.toBeNull();
    const cls = aside?.getAttribute('class') ?? '';
    expect(cls).toContain('w-full');
    expect(cls).toContain('xl:w-80');
    expect(cls).not.toMatch(/(^|\s)w-80(\s|$)/);
  });
});
