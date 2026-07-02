/**
 * Round-6 settings fixes for the shared SettingsGrid primitives:
 *  - #37 StickySaveBar: a PERSISTENT polite live region so "unsaved changes" is
 *        announced to screen readers when the bar appears (not swallowed because the
 *        region was inserted at the same instant as its text).
 *  - #38 SettingsTOC: an orientation-aware active indicator (left rail vs bottom
 *        underline) so the horizontal tab-strip usage doesn't show a stray left bar.
 *  - #39 StickySaveBar: the save/discard icons no longer carry the DEAD `h-3.5 w-3.5`
 *        (the Button's `[&_svg]:size-4` outranks it on specificity).
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { StickySaveBar, SettingsTOC } from '../SettingsGrid';

const noop = () => {};

describe('StickySaveBar — persistent live region (Round-6 #37)', () => {
  it('mounts a persistent polite status region even when hidden, then announces on show', () => {
    const { rerender, container } = render(
      <StickySaveBar visible={false} onSave={noop} onDiscard={noop} message="3 unsaved changes." />,
    );
    const status = container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status).toHaveAttribute('aria-live', 'polite');
    // Empty text while hidden — the region PRE-EXISTS so a later text change is announced.
    expect(status?.textContent).toBe('');
    // The visible bar itself is not rendered while hidden.
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();

    rerender(
      <StickySaveBar visible onSave={noop} onDiscard={noop} message="3 unsaved changes." />,
    );
    // The SAME persistent region now carries the message (a mutation, which SRs announce)…
    expect(container.querySelector('[role="status"]')?.textContent).toBe('3 unsaved changes.');
    // …and the visible bar appears.
    expect(screen.getByRole('region', { name: 'Unsaved changes' })).toBeInTheDocument();
  });
});

describe('StickySaveBar — no dead icon sizes (Round-6 #39)', () => {
  it('does not set h-3.5 / w-3.5 on the save/discard icons', () => {
    const { container } = render(<StickySaveBar visible onSave={noop} onDiscard={noop} />);
    const svgs = container.querySelectorAll('button svg');
    expect(svgs.length).toBeGreaterThan(0);
    svgs.forEach((svg) => {
      const cls = svg.getAttribute('class') || '';
      expect(cls).not.toContain('h-3.5');
      expect(cls).not.toContain('w-3.5');
    });
  });
});

describe('SettingsTOC — orientation-aware active indicator (Round-6 #38)', () => {
  const items = [
    { anchor: 'a', label: 'Alpha' },
    { anchor: 'b', label: 'Beta' },
  ];

  it('uses a LEFT rail (border-l-2) for the vertical default', () => {
    render(<SettingsTOC items={items} active="a" />);
    const active = screen.getByRole('button', { name: 'Alpha' });
    expect(active.className).toContain('border-l-2');
    expect(active.className).not.toContain('border-b-2');
  });

  it('uses a BOTTOM underline (border-b-2) when horizontal', () => {
    render(<SettingsTOC items={items} active="a" orientation="horizontal" />);
    const active = screen.getByRole('button', { name: 'Alpha' });
    expect(active.className).toContain('border-b-2');
    expect(active.className).not.toContain('border-l-2');
  });
});
