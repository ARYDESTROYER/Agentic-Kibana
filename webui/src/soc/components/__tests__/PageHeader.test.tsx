/**
 * PageHeader — Round-7 W0.9 header-compaction spec (#6).
 *
 * The header collapses the old marketing hero into a single compact ~52-68px band.
 * `dense` and `hero` share that rhythm; `hero` differs ONLY by a rounded border + a
 * whisper `bg-hero-glow` accent wash (its title is `text-xl`, its description clamps to
 * one line vs the dense two). `actions` (right) + `meta` (beside title) are the only
 * control slots — there is no second band.
 *
 * We lock: (1) a real hero≠dense visual discriminator (border + glow wash present on
 * hero, absent on dense); (2) exactly one <h1> per instance + no axe violations (heading
 * order / a11y); (3) the description carries a `line-clamp-*` utility in both variants.
 *
 * Offline: pure render, no network, no #3 / runtime behaviour touched. All header text
 * renders plain (UNTRUSTED-safe, #9).
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

import { PageHeader } from '../PageHeader';

expect.extend(toHaveNoViolations);

describe('PageHeader — W0.9 compaction', () => {
  it('exposes a hero≠dense visual discriminator (rounded border + bg-hero-glow wash)', () => {
    const { unmount } = render(
      <PageHeader variant="hero" title="Hero title" data-testid="hdr" />,
    );
    const hero = screen.getByTestId('hdr');
    // hero adds the rounded card border ...
    expect(hero.className).toMatch(/\bborder\b/);
    expect(hero.className).toMatch(/rounded-lg/);
    // ... and the decorative accent wash element.
    expect(hero.querySelector('.bg-hero-glow')).not.toBeNull();
    unmount();

    render(<PageHeader variant="dense" title="Dense title" data-testid="hdr" />);
    const dense = screen.getByTestId('hdr');
    expect(dense.className).not.toMatch(/rounded-lg/);
    expect(dense.querySelector('.bg-hero-glow')).toBeNull();
  });

  it('hero title is text-xl (compacted from the old text-2xl marketing hero)', () => {
    render(<PageHeader variant="hero" title="Command Center" />);
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.className).toMatch(/\btext-xl\b/);
    expect(h1.className).not.toMatch(/text-2xl/);
  });

  it('renders exactly one <h1> per instance (dense and hero)', () => {
    const { unmount } = render(<PageHeader variant="dense" title="Only heading" />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    unmount();

    render(
      <PageHeader
        variant="hero"
        title="Only heading"
        description="One line only"
        meta={<span>chip</span>}
        actions={<button type="button">Refresh</button>}
      />,
    );
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('has no axe violations (heading order / a11y) in either variant', async () => {
    const dense = render(
      <PageHeader
        variant="dense"
        breadcrumb={[{ label: 'Home', href: '/' }, { label: 'Cases' }]}
        title="Cases"
        description="Triaged, audited, human-reviewable."
        actions={<button type="button">New case</button>}
      />,
    );
    expect(await axe(dense.container)).toHaveNoViolations();
    dense.unmount();

    const hero = render(
      <PageHeader
        variant="hero"
        title="Security Command Center"
        description="Live posture across every connected source."
        actions={<button type="button">Refresh</button>}
      />,
    );
    expect(await axe(hero.container)).toHaveNoViolations();
  });

  it('description carries a line-clamp-* utility — 1 line for hero, 2 for dense', () => {
    const { unmount } = render(
      <PageHeader variant="hero" title="Hero" description="A single-line hero summary." />,
    );
    const heroDesc = screen.getByText('A single-line hero summary.');
    expect(heroDesc.className).toMatch(/line-clamp-1/);
    unmount();

    render(
      <PageHeader variant="dense" title="Dense" description="A two-line dense summary." />,
    );
    const denseDesc = screen.getByText('A two-line dense summary.');
    expect(denseDesc.className).toMatch(/line-clamp-2/);
  });

  it('renders title/description/meta as plain text (UNTRUSTED-safe, #9)', () => {
    render(
      <PageHeader
        variant="hero"
        title="<img src=x onerror=alert(1)>"
        description="<script>evil()</script>"
      />,
    );
    // The literal string is present as text, never parsed into elements.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      '<img src=x onerror=alert(1)>',
    );
    expect(screen.getByText('<script>evil()</script>')).toBeInTheDocument();
  });
});
