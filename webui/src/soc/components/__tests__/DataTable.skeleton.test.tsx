/**
 * DataTable — loading-skeleton spec (Round-6 #52 follow-up). The loading state renders
 * row-shaped `SkeletonRow`s that mirror the eventual rows: one shimmer bar per displayed
 * column (respecting alignment), plus the leading checkbox cell when selectable. Keeping
 * the loading shape aligned to the real row prevents a content-in layout shift.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';

import { DataTable, type DataTableColumn } from '../DataTable';

interface Row {
  id: string;
  a: string;
  b: string;
}

const columns: DataTableColumn<Row>[] = [
  { id: 'a', header: 'A', cell: (r) => r.a },
  { id: 'b', header: 'B', align: 'right', cell: (r) => r.b },
];

describe('DataTable — SkeletonRow loading state', () => {
  it('renders row-shaped skeletons that mirror the columns while loading', () => {
    const { container } = render(
      <DataTable<Row>
        columns={columns}
        rows={[]}
        getRowId={(r) => r.id}
        loading
        loadingRows={3}
        ariaLabel="Test table"
      />,
    );

    // One decorative (aria-hidden) skeleton row per loadingRows.
    const skeletonRows = container.querySelectorAll('tbody tr[aria-hidden="true"]');
    expect(skeletonRows).toHaveLength(3);

    // Each row mirrors the column set (2 cells, no checkbox).
    const firstRowCells = skeletonRows[0].querySelectorAll('td');
    expect(firstRowCells).toHaveLength(2);

    // The right-aligned column's shimmer bar is nudged right (ml-auto) so it lands
    // where the eventual right-aligned content will render; the left one is not.
    const rightBar = firstRowCells[1].querySelector('div.shimmer');
    expect(rightBar?.className).toContain('ml-auto');
    const leftBar = firstRowCells[0].querySelector('div.shimmer');
    expect(leftBar?.className).not.toContain('ml-auto');
  });

  it('adds a leading checkbox skeleton cell when selectable', () => {
    const { container } = render(
      <DataTable<Row>
        columns={columns}
        rows={[]}
        getRowId={(r) => r.id}
        selectable
        loading
        loadingRows={1}
        ariaLabel="Sel table"
      />,
    );
    // checkbox cell + one cell per column.
    const cells = container.querySelectorAll('tbody tr[aria-hidden="true"] td');
    expect(cells).toHaveLength(3);
  });
});
