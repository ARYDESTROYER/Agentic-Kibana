/**
 * TableHeader — a sticky header gets an OPAQUE background so scrolled rows don't
 * bleed through, while the non-sticky default keeps its translucent wash
 * (round-6 ui-theme #55). The bug was an unconditional `bg-surface/50` whose
 * translucent rule won the cascade over the sticky `bg-surface`.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Table, TableHeader, TableRow, TableHead } from '../table';

function classTokens(el: Element): string[] {
  return el.className.split(/\s+/).filter(Boolean);
}

describe('TableHeader — sticky background opacity', () => {
  it('sticky header is opaque (no translucent bg-surface/50)', () => {
    const { container } = render(
      <Table>
        <TableHeader sticky>
          <TableRow>
            <TableHead>Col</TableHead>
          </TableRow>
        </TableHeader>
      </Table>,
    );
    const thead = container.querySelector('thead')!;
    const tokens = classTokens(thead);
    expect(tokens).toContain('bg-surface');
    expect(tokens).toContain('sticky');
    expect(tokens).not.toContain('bg-surface/50');
  });

  it('non-sticky header keeps the translucent wash', () => {
    const { container } = render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Col</TableHead>
          </TableRow>
        </TableHeader>
      </Table>,
    );
    const thead = container.querySelector('thead')!;
    const tokens = classTokens(thead);
    expect(tokens).toContain('bg-surface/50');
    expect(tokens).not.toContain('sticky');
  });
});
