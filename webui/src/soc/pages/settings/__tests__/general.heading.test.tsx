/**
 * Round-6 finding 19 — the General section body heading must match its rail label.
 *
 * `SETTINGS_SECTIONS_META` labels the section "Data scope", but the body used to render
 * the longer heading "General & data scope", so the nav item and the body title
 * disagreed. This spec pins the fix: the SectionShell heading is exactly "Data scope"
 * (the longer phrasing stays in the sub-line), mirroring the detection.tsx alignment.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { TooltipProvider } from '@/ui/tooltip';
import type { Preferences } from '@/lib/types';

import { GeneralSection } from '../general';
import { SECTION_META_BY_ID } from '../settings-sections-meta';

describe('GeneralSection heading matches the rail label', () => {
  it('renders the "Data scope" heading (not "General & data scope")', () => {
    render(
      <TooltipProvider>
        <GeneralSection prefs={{} as Preferences} update={vi.fn()} onNavigate={vi.fn()} />
      </TooltipProvider>,
    );
    // The section title (an h2 rendered by SectionShell) is exactly the rail label.
    expect(screen.getByRole('heading', { name: /^data scope$/i })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /general & data scope/i })).toBeNull();
  });

  it('the rendered heading equals the section meta title (single source of truth)', () => {
    render(
      <TooltipProvider>
        <GeneralSection prefs={{} as Preferences} update={vi.fn()} onNavigate={vi.fn()} />
      </TooltipProvider>,
    );
    const railLabel = SECTION_META_BY_ID.general.title;
    expect(railLabel).toBe('Data scope');
    expect(screen.getByRole('heading', { name: railLabel })).toBeTruthy();
  });
});
