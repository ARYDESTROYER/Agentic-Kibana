import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DataTable, type DataTableColumn } from '../DataTable';

type Row = { id: string; name: string };

const rows: Row[] = [{ id: 'one', name: 'Alpha' }];
const columns: DataTableColumn<Row>[] = [
  { id: 'name', header: 'Name', cell: (row) => row.name },
];

describe('DataTable row actions', () => {
  it('keeps selection controls separate from the named keyboard row action', () => {
    const onOpen = vi.fn();
    const onSelectedChange = vi.fn();
    const { container } = render(
      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        selectable
        selected={[]}
        onSelectedChange={onSelectedChange}
        onRowClick={onOpen}
        getRowActionLabel={(row) => `Open ${row.name}`}
      />,
    );

    const row = screen.getByText('Alpha').closest('tr');
    expect(row).not.toHaveAttribute('role', 'button');
    expect(row).not.toHaveAttribute('tabindex');

    const checkbox = screen.getByRole('checkbox', { name: 'Select row one' });
    fireEvent.keyDown(checkbox, { key: ' ' });
    fireEvent.click(checkbox);
    expect(onSelectedChange).toHaveBeenCalledWith(['one']);
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Open Alpha' }));
    expect(onOpen).toHaveBeenCalledWith(rows[0], 0);

    expect(container.querySelector('tr[role="button"]')).toBeNull();
  });

  it('retains pointer row opening without hijacking inline controls', () => {
    const onOpen = vi.fn();
    render(
      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        onRowClick={onOpen}
      />,
    );

    fireEvent.click(screen.getByText('Alpha'));
    expect(onOpen).toHaveBeenCalledWith(rows[0], 0);
  });

  it('does not duplicate an equivalent named action already rendered in a cell', () => {
    const onOpen = vi.fn();
    render(
      <DataTable
        columns={[
          ...columns,
          {
            id: 'actions',
            header: 'Actions',
            cell: () => <button type="button">Open Alpha</button>,
          },
        ]}
        rows={rows}
        getRowId={(row) => row.id}
        onRowClick={onOpen}
        showRowAction={false}
      />,
    );

    expect(screen.getAllByRole('button', { name: 'Open Alpha' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Open row one' })).toBeNull();
  });
});
