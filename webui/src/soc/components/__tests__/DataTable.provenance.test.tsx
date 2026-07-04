/**
 * DataTable — column-header provenance (Round-7 #9b) spec.
 *
 * A `DataTableColumn.provenance` must render a `<ProvenanceTag variant="icon">` beside
 * the header in BOTH branches (the sortable `<button>` and the plain `<span>`), else a
 * declared column provenance would be a silent no-op. Columns WITHOUT `provenance` must
 * render no tag (back-compatible).
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';

import { DataTable, type DataTableColumn } from '../DataTable';

interface Row {
  id: string;
  risk: number;
  verdict: string;
  name: string;
}

const rows: Row[] = [{ id: 'r1', risk: 80, verdict: 'true_positive', name: 'alpha' }];

describe('DataTable — column-header provenance', () => {
  it('renders the provenance icon in a SORTABLE column header', () => {
    const columns: DataTableColumn<Row>[] = [
      { id: 'risk', header: 'Risk', sortable: true, provenance: 'code', cell: (r) => r.risk },
      { id: 'name', header: 'Name', cell: (r) => r.name },
    ];
    const { container } = render(
      <DataTable<Row>
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        sort={{ id: 'risk', dir: 'desc' }}
        onSortChange={() => {}}
        ariaLabel="t"
      />,
    );
    const th = container.querySelectorAll('thead th');
    // The Risk header (a <button>) carries the provenance tag; Name does not.
    const riskHead = th[0];
    expect(riskHead.querySelector('button [data-provenance="code"]')).toBeTruthy();
    expect(riskHead.querySelector('svg')).toBeTruthy();
    const nameHead = th[1];
    expect(nameHead.querySelector('[data-provenance]')).toBeNull();
  });

  it('renders the provenance icon in a PLAIN (non-sortable) column header', () => {
    const columns: DataTableColumn<Row>[] = [
      { id: 'verdict', header: 'Verdict', provenance: 'ai', cell: (r) => r.verdict },
    ];
    const { container } = render(
      <DataTable<Row>
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        ariaLabel="t"
      />,
    );
    const verdictHead = container.querySelector('thead th');
    // Non-sortable branch: no <button>, but the tag is still beside the header.
    expect(verdictHead?.querySelector('button')).toBeNull();
    expect(verdictHead?.querySelector('[data-provenance="ai"]')).toBeTruthy();
    expect(verdictHead?.querySelector('svg')).toBeTruthy();
  });

  it('renders NO provenance tag when the column omits provenance (back-compatible)', () => {
    const columns: DataTableColumn<Row>[] = [
      { id: 'name', header: 'Name', sortable: true, cell: (r) => r.name },
    ];
    const { container } = render(
      <DataTable<Row>
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        sort={{ id: 'name', dir: 'asc' }}
        onSortChange={() => {}}
        ariaLabel="t"
      />,
    );
    expect(container.querySelector('thead [data-provenance]')).toBeNull();
  });
});
