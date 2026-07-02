/**
 * CommandItem — enabled rows must not be dimmed/disabled (round-6 #1).
 *
 * cmdk renders `data-disabled={false}` (a PRESENT attribute) on every ENABLED row, so
 * the Radix-flavored PRESENCE selectors `data-[disabled]:opacity-50` /
 * `data-[disabled]:pointer-events-none` (from the shared `menuItem` recipe) would match
 * ALL rows and grey out + kill pointer events on the whole palette. CommandItem must use
 * VALUE-specific `data-[disabled=true]:` utilities instead.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Command, CommandList, CommandItem } from '../command';

describe('CommandItem — no presence-based data-[disabled] dimming', () => {
  it('uses value-specific data-[disabled=true]:, not presence-based data-[disabled]:', () => {
    const { getByText } = render(
      <Command>
        <CommandList>
          <CommandItem>Jump to Cases</CommandItem>
        </CommandList>
      </Command>,
    );
    const item = getByText('Jump to Cases').closest('[cmdk-item]') as HTMLElement;
    expect(item).not.toBeNull();
    const cls = item.className;
    // The presence utilities (which cmdk's data-disabled="false" would wrongly trigger) are gone.
    expect(cls).not.toContain('data-[disabled]:opacity-50');
    expect(cls).not.toContain('data-[disabled]:pointer-events-none');
    // The value-specific utilities remain (only a REAL disabled row matches).
    expect(cls).toContain('data-[disabled=true]:opacity-50');
    expect(cls).toContain('data-[disabled=true]:pointer-events-none');
  });
});
