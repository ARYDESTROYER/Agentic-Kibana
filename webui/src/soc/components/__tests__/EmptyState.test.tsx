import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

import { Button } from '@/ui/button';
import {
  EmptyState,
  type EmptyStateSemantic,
} from '@/soc/components/EmptyState';

expect.extend(toHaveNoViolations);

const SEMANTICS: Array<{
  state: EmptyStateSemantic;
  role: 'group' | 'status' | 'alert';
  iconClass: string;
  markerClass: string;
}> = [
  {
    state: 'first-use',
    role: 'group',
    iconClass: 'lucide-list-plus',
    markerClass: 'text-muted-foreground',
  },
  {
    state: 'no-data',
    role: 'group',
    iconClass: 'lucide-inbox',
    markerClass: 'text-muted-foreground',
  },
  {
    state: 'no-results',
    role: 'status',
    iconClass: 'lucide-search-x',
    markerClass: 'text-muted-foreground',
  },
  {
    state: 'success',
    role: 'status',
    iconClass: 'lucide-circle-check',
    markerClass: 'text-success',
  },
  {
    state: 'unavailable',
    role: 'status',
    iconClass: 'lucide-circle-off',
    markerClass: 'text-warning',
  },
  {
    state: 'error',
    role: 'alert',
    iconClass: 'lucide-triangle-alert',
    markerClass: 'text-critical',
  },
];

describe('EmptyState semantic model', () => {
  it.each(SEMANTICS)(
    'exposes $state with its accessible role, name, description, and default marker',
    ({ state, role, iconClass, markerClass }) => {
      const title = `${state} title`;
      const description = `${state} explanation and next action`;
      render(<EmptyState state={state} title={title} description={description} />);

      const panel = screen.getByRole(role, { name: title });
      expect(panel).toHaveAttribute('data-empty-state', state);
      expect(panel).toHaveAccessibleDescription(description);
      expect(panel.querySelector('svg')).toHaveClass(iconClass);
      expect(panel.querySelector('svg')?.parentElement).toHaveClass(markerClass);

      if (role === 'status' || role === 'alert') {
        expect(panel).toHaveAttribute('aria-atomic', 'true');
      } else {
        expect(panel).not.toHaveAttribute('aria-atomic');
      }
    },
  );

  it('keeps legacy default calls quiet while exposing the no-data diagnostic state', () => {
    const { container } = render(<EmptyState title="Nothing to review" />);

    expect(container.firstElementChild).toHaveAttribute('data-empty-state', 'no-data');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(container.querySelector('svg')).toHaveClass('lucide-inbox');
  });

  it('preserves variant="error" as a forceful compatibility alias', () => {
    render(
      <EmptyState
        state="success"
        variant="error"
        title="Could not load evidence"
        description="Retry the request."
      />,
    );

    const panel = screen.getByRole('alert', { name: 'Could not load evidence' });
    expect(panel).toHaveAttribute('data-empty-state', 'error');
    expect(panel.querySelector('svg')?.parentElement).toHaveClass('text-critical');
  });

  it('keeps the recovery action inside the named state without changing its behavior', () => {
    render(
      <EmptyState
        state="no-results"
        title="No runbooks match"
        description="Clear the filters to return to the full library."
        action={<Button>Clear filters</Button>}
      />,
    );

    const panel = screen.getByRole('status', { name: 'No runbooks match' });
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeVisible();
    expect(panel).toContainElement(screen.getByRole('button', { name: 'Clear filters' }));
  });

  it('has no automated accessibility violations across the semantic set', async () => {
    const { container } = render(
      <div>
        {SEMANTICS.map(({ state }) => (
          <EmptyState
            key={state}
            state={state}
            title={`${state} title`}
            description={`${state} explanation and next action`}
          />
        ))}
      </div>,
    );

    expect(await axe(container)).toHaveNoViolations();
  });
});
