import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { axe, toHaveNoViolations } from 'jest-axe';

import { PageSkeleton } from '../PageSkeleton';

expect.extend(toHaveNoViolations);

describe('PageSkeleton — route-level fallback', () => {
  it('announces the destination and always renders visible progress chrome', () => {
    render(<PageSkeleton label="Documentation" />);

    expect(screen.getByRole('status', { name: 'Loading Documentation' })).toBeInTheDocument();
    expect(screen.getByText('Loading Documentation…')).toBeVisible();
    expect(screen.getByRole('progressbar', { name: 'Loading Documentation' })).toBeVisible();
    expect(screen.getByTestId('route-loading-fallback')).toHaveAttribute('aria-busy', 'true');
  });

  it('uses motion-safe animation with a calm reduced-motion fill', () => {
    render(<PageSkeleton label="Cases" />);
    const indicator = screen.getByTestId('loading-bar-indicator');
    expect(indicator.className).toContain('motion-safe:animate-bar-indeterminate');
    expect(indicator.className).toContain('motion-reduce:w-full');
    expect(indicator.className).not.toMatch(/(^|\s)animate-bar-indeterminate(\s|$)/);
  });

  it('has no detectable accessibility violations', async () => {
    const { container } = render(<PageSkeleton label="Docs" />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
