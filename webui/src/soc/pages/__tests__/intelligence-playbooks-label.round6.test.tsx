/**
 * Intelligence — Playbooks label alignment (Round-6 #32).
 *
 * A `#/playbooks` deep-link renders `<Intelligence tab="catalog" />`. Previously the
 * host's catalog tab read "Playbooks & Agents" while the nav child + the breadcrumb leaf
 * read "Playbooks" — three disagreeing labels for one destination. This pins that the
 * tab label now matches the single derived breadcrumb label (`navLabel('playbooks')`),
 * and the stale "& Agents" tab label is gone.
 *
 * The three sub-pages are stubbed so the host renders without their network surface.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../Knowledge', () => ({ default: () => <div>knowledge body</div> }));
vi.mock('../Memory', () => ({ default: () => <div>memory body</div> }));
vi.mock('../Catalog', () => ({ default: () => <div>catalog body</div> }));

import { TooltipProvider } from '@/ui/tooltip';
import Intelligence from '../Intelligence';
import { navLabel } from '@/soc/nav';

describe('Intelligence host — Playbooks label alignment (#32)', () => {
  it('the Catalog tab label equals the derived breadcrumb leaf ("Playbooks")', () => {
    render(
      <TooltipProvider>
        <Intelligence tab="catalog" />
      </TooltipProvider>,
    );
    // The single source-of-truth breadcrumb label for the deep-link leaf.
    expect(navLabel('playbooks')).toBe('Playbooks');
    // The rendered tab now agrees with it (was "Playbooks & Agents").
    expect(screen.getByRole('tab', { name: 'Playbooks' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Playbooks & Agents/i })).toBeNull();
  });
});
