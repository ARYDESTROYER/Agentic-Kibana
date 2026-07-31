import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { axe, toHaveNoViolations } from 'jest-axe';

import { PageSkeleton } from '../PageSkeleton';

expect.extend(toHaveNoViolations);

describe('PageSkeleton — route-level fallback', () => {
  it('announces the destination and centers the shared loading state', () => {
    render(<PageSkeleton label="Documentation" />);

    expect(screen.getByRole('status', { name: 'Loading Documentation' })).toBeInTheDocument();
    expect(screen.getByText('Loading Documentation')).toBeVisible();
    expect(screen.getByTestId('console-loading-glyph')).toBeVisible();
    expect(screen.getByTestId('route-loading-fallback')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('route-loading-fallback')).toHaveClass(
      'items-center',
      'justify-center',
    );
  });

  it('uses the shared indeterminate progress ring with a calm static base state', () => {
    render(<PageSkeleton label="Cases" />);
    const ring = screen.getByTestId('console-loading-glyph').querySelector('svg');
    expect(ring).toHaveClass('console-progress-ring');
    expect(ring).toHaveAttribute('data-loading-motion', 'indeterminate-ring');
    expect(ring?.querySelectorAll('.console-progress-ring__arc')).toHaveLength(1);
    expect(screen.getByTestId('route-loading-fallback')).toHaveAttribute(
      'data-loading-layout',
      'page',
    );
  });

  it('has no detectable accessibility violations', async () => {
    const { container } = render(<PageSkeleton label="Docs" />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
