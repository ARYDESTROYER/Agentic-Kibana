/**
 * Intelligence — explicit leaf labels and direct Persona discovery.
 *
 * Every Intelligence job has one direct destination and one derived label. Agent
 * personas no longer hide behind a second Playbooks/Catalog tab, while the legacy
 * `catalog` alias resolves to Response playbooks.
 *
 * The sub-pages are stubbed so the host renders without their network surface.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../Knowledge', () => ({ default: () => <div>knowledge body</div> }));
vi.mock('../Runbooks', () => ({ default: () => <div>runbooks body</div> }));
vi.mock('../Memory', () => ({ default: () => <div>memory body</div> }));
vi.mock('../Catalog', () => ({
  default: ({ defaultTab }: { defaultTab?: string }) => (
    <div>catalog body · {defaultTab}</div>
  ),
}));

import { TooltipProvider } from '@/ui/tooltip';
import Intelligence from '../Intelligence';
import { navLabel } from '@/soc/nav';

describe('Intelligence host — direct leaf labels', () => {
  it('maps the legacy Catalog alias to Response playbooks', () => {
    render(
      <TooltipProvider>
        <Intelligence tab="catalog" />
      </TooltipProvider>,
    );
    expect(navLabel('playbooks')).toBe('Response playbooks');
    expect(screen.getByRole('heading', { name: 'Response playbooks' })).toBeInTheDocument();
    expect(screen.getByText('catalog body · playbooks')).toBeInTheDocument();
  });

  it('renders the dedicated Runbooks Intelligence child at its registry label', () => {
    render(
      <TooltipProvider>
        <Intelligence tab="runbooks" />
      </TooltipProvider>,
    );
    expect(navLabel('runbooks')).toBe('Reference runbooks');
    expect(screen.getByRole('heading', { name: 'Reference runbooks' })).toBeInTheDocument();
    expect(screen.getByText('runbooks body')).toBeInTheDocument();
  });

  it('renders Agent personas as its own Intelligence destination', () => {
    render(
      <TooltipProvider>
        <Intelligence tab="personas" />
      </TooltipProvider>,
    );
    expect(navLabel('personas')).toBe('Agent personas');
    expect(screen.getByRole('heading', { name: 'Agent personas' })).toBeInTheDocument();
    expect(screen.getByText('catalog body · personas')).toBeInTheDocument();
  });
});
