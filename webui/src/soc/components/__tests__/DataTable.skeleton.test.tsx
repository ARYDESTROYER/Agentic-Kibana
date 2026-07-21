/**
 * DataTable — loading-skeleton spec (Round-6 #52 follow-up). The loading state renders
 * row-shaped `SkeletonRow`s that mirror the eventual rows: one shimmer bar per displayed
 * column (respecting alignment), plus the leading checkbox cell when selectable. Keeping
 * the loading shape aligned to the real row prevents a content-in layout shift.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

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

    // The card has a clear indeterminate activity cue in addition to the row
    // shimmer, while exposing its busy state to assistive technology.
    const tableCard = container.firstElementChild;
    expect(tableCard).toHaveAttribute('aria-busy', 'true');
    expect(
      screen.getByRole('progressbar', { name: 'Loading Test table' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('loading-bar-indicator')).toHaveClass(
      'motion-safe:animate-bar-indeterminate',
      'motion-reduce:w-full',
    );

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

  it('lets pager controls wrap within a narrow table card instead of being clipped', () => {
    render(
      <DataTable<Row>
        columns={columns}
        rows={[{ id: '1', a: 'Alpha', b: 'Bravo' }]}
        getRowId={(r) => r.id}
        page={1}
        pageSize={10}
        total={25}
        onPageChange={() => {}}
        onPageSizeChange={() => {}}
        ariaLabel="Paged table"
      />,
    );

    const pageLabel = screen.getByText('Page 1 of 3');
    expect(pageLabel.parentElement).toHaveClass('flex-wrap', 'w-full');
    expect(screen.getByRole('button', { name: 'Next page' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Last page' })).toBeInTheDocument();
  });

  it('excludes read-only rows from row and select-all mutations with an exposed reason', () => {
    const onSelectedChange = vi.fn();
    render(
      <DataTable<Row>
        columns={columns}
        rows={[
          { id: 'live', a: 'Live', b: 'row' },
          { id: 'demo', a: 'Demo', b: 'row' },
        ]}
        getRowId={(r) => r.id}
        selectable
        selected={[]}
        onSelectedChange={onSelectedChange}
        isRowSelectable={(row) => row.id !== 'demo'}
        getRowSelectionDisabledReason={(row) =>
          row.id === 'demo' ? 'Managed by Demo Mode' : undefined
        }
        ariaLabel="Mixed table"
      />,
    );

    expect(screen.getByLabelText('Managed by Demo Mode: demo')).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Select all available rows'));
    expect(onSelectedChange).toHaveBeenCalledWith(['live']);
  });
});
