/**
 * SheetHeader — reserves right padding (`pr-14`) so a long title never slides
 * underneath the built-in close (X) pinned at `right-4` (round-6 ui-theme #50),
 * removing the per-consumer `pr-8`/`truncate` workarounds.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../sheet';

describe('SheetHeader — reserves room for the close button', () => {
  it('applies pr-14 so titles do not underlap the X', () => {
    const { getByText } = render(
      <Sheet defaultOpen>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>A very long sheet title that would otherwise reach the edge</SheetTitle>
          </SheetHeader>
        </SheetContent>
      </Sheet>,
    );
    const header = getByText(/A very long sheet title/).parentElement!;
    const tokens = header.className.split(/\s+/).filter(Boolean);
    expect(tokens).toContain('pr-14');
  });
});
