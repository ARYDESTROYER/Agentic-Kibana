/**
 * DataTable loading contract: a first load is centered inside the table geometry;
 * a later refresh keeps usable rows mounted and uses the slim non-blocking bar.
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

describe('DataTable — standardized loading state', () => {
  it('centers the shared loader inside one full-width body row on first load', () => {
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

    const tableCard = container.firstElementChild;
    expect(tableCard).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status', { name: 'Loading Test table' })).toBeVisible();
    expect(screen.queryByRole('progressbar', { name: 'Loading Test table' })).not.toBeInTheDocument();

    const loadingCell = screen.getByTestId('data-table-initial-loading').closest('td');
    expect(loadingCell).toHaveAttribute('colspan', '2');
    expect(screen.getByTestId('data-table-initial-loading')).toHaveClass(
      'items-center',
      'justify-center',
    );
    expect(container.querySelector('[data-loading-shape="rows"]')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
  });

  it('spans the selection column too when the initial table is selectable', () => {
    render(
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
    expect(screen.getByTestId('data-table-initial-loading').closest('td')).toHaveAttribute(
      'colspan',
      '3',
    );
  });

  it('keeps existing rows visible and shows only the non-blocking refresh bar', () => {
    render(
      <DataTable<Row>
        columns={columns}
        rows={[{ id: '1', a: 'Alpha', b: 'Bravo' }]}
        getRowId={(r) => r.id}
        loading
        ariaLabel="Refresh table"
      />,
    );

    expect(screen.getByText('Alpha')).toBeVisible();
    expect(screen.getByText('Bravo')).toBeVisible();
    expect(screen.queryByTestId('data-table-initial-loading')).not.toBeInTheDocument();
    expect(
      screen.getByRole('progressbar', { name: 'Loading Refresh table' }),
    ).toBeVisible();
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
