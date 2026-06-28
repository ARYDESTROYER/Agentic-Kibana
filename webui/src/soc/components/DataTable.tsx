import * as React from 'react';
import {
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Inbox,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { Skeleton } from '@/ui/skeleton';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/ui/table';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/ui/select';

export type SortDir = 'asc' | 'desc';

export interface SortState {
  /** Column id currently sorted by. */
  id: string;
  dir: SortDir;
}

export interface DataTableColumn<T> {
  /** Stable id, also used as the sort key reported to onSortChange. */
  id: string;
  /** Header label. */
  header: React.ReactNode;
  /** Cell renderer for a row. UNTRUSTED values must render plain / via CodeBlock. */
  cell: (row: T, rowIndex: number) => React.ReactNode;
  /** Enable the sortable header affordance for this column. */
  sortable?: boolean;
  /** Extra classes for the <th>. */
  headerClassName?: string;
  /** Extra classes for the <td>. */
  className?: string;
  /** Horizontal alignment of the cell + header content. */
  align?: 'left' | 'center' | 'right';
  /** Fixed/min width hint (e.g. '12rem'). Applied as style.width on th/td. */
  width?: string | number;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  /** Stable id for a row (selection + react keys). */
  getRowId: (row: T, index: number) => string;

  /** Controlled sort state. */
  sort?: SortState | null;
  onSortChange?: (sort: SortState) => void;

  /** Controlled pagination (1-based page). When omitted, the footer pager hides. */
  page?: number;
  pageSize?: number;
  total?: number;
  onPageChange?: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  /** Page-size options shown in the footer select. */
  pageSizeOptions?: number[];

  /** Row selection (controlled). When `selectable`, a checkbox column is prepended. */
  selectable?: boolean;
  selected?: string[];
  onSelectedChange?: (selected: string[]) => void;

  onRowClick?: (row: T, index: number) => void;

  /** Loading shows skeleton rows; empty shows the empty slot/state. */
  loading?: boolean;
  /** Number of skeleton rows to render while loading. */
  loadingRows?: number;
  /** Empty-state content (string or node). */
  empty?: React.ReactNode;

  /** Visual density. */
  density?: 'normal' | 'compact';

  /** Extra classes on the outer wrapper. */
  className?: string;
  /** Caption / aria-label for the table (a11y). */
  ariaLabel?: string;
}

const alignClass = (align?: 'left' | 'center' | 'right') =>
  align === 'right'
    ? 'text-right'
    : align === 'center'
      ? 'text-center'
      : 'text-left';

function SortIcon({ active, dir }: { active: boolean; dir?: SortDir }) {
  if (!active)
    return (
      <ChevronsUpDown
        className="ml-1 inline-block size-3.5 text-muted-foreground/50"
        aria-hidden
      />
    );
  return dir === 'asc' ? (
    <ChevronUp className="ml-1 inline-block size-3.5 text-foreground" aria-hidden />
  ) : (
    <ChevronDown className="ml-1 inline-block size-3.5 text-foreground" aria-hidden />
  );
}

export function DataTable<T>({
  columns,
  rows,
  getRowId,
  sort,
  onSortChange,
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 25, 50, 100],
  selectable = false,
  selected,
  onSelectedChange,
  onRowClick,
  loading = false,
  loadingRows = 8,
  empty,
  density = 'normal',
  className,
  ariaLabel,
}: DataTableProps<T>) {
  const selectedSet = React.useMemo(
    () => new Set(selected ?? []),
    [selected],
  );

  const rowIds = React.useMemo(
    () => rows.map((r, i) => getRowId(r, i)),
    [rows, getRowId],
  );

  const allSelected =
    selectable && rowIds.length > 0 && rowIds.every((id) => selectedSet.has(id));
  const someSelected =
    selectable && rowIds.some((id) => selectedSet.has(id)) && !allSelected;

  const cellPad = density === 'compact' ? 'px-3 py-1.5' : 'px-3 py-2.5';

  const handleHeaderSort = (col: DataTableColumn<T>) => {
    if (!col.sortable || !onSortChange) return;
    const isActive = sort?.id === col.id;
    const nextDir: SortDir =
      isActive && sort?.dir === 'asc' ? 'desc' : 'asc';
    onSortChange({ id: col.id, dir: nextDir });
  };

  const toggleAll = () => {
    if (!onSelectedChange) return;
    if (allSelected) {
      onSelectedChange((selected ?? []).filter((id) => !rowIds.includes(id)));
    } else {
      const merged = new Set(selected ?? []);
      rowIds.forEach((id) => merged.add(id));
      onSelectedChange(Array.from(merged));
    }
  };

  const toggleRow = (id: string) => {
    if (!onSelectedChange) return;
    const next = new Set(selected ?? []);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectedChange(Array.from(next));
  };

  const colCount = columns.length + (selectable ? 1 : 0);

  // Pagination math.
  const showPager =
    page != null && pageSize != null && (onPageChange != null || total != null);
  const effTotal = total ?? rows.length;
  const pageCount =
    pageSize && pageSize > 0 ? Math.max(1, Math.ceil(effTotal / pageSize)) : 1;
  const curPage = page ?? 1;
  const canPrev = curPage > 1;
  const canNext = curPage < pageCount;

  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-card shadow-elev1',
        className,
      )}
    >
      <Table aria-label={ariaLabel}>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {selectable && (
              <TableHead className="w-10 px-3">
                <Checkbox
                  checked={
                    allSelected ? true : someSelected ? 'indeterminate' : false
                  }
                  onCheckedChange={toggleAll}
                  aria-label="Select all rows"
                  disabled={loading || rowIds.length === 0}
                />
              </TableHead>
            )}
            {columns.map((col) => {
              const isActive = sort?.id === col.id;
              return (
                <TableHead
                  key={col.id}
                  style={col.width ? { width: col.width } : undefined}
                  className={cn(
                    'whitespace-nowrap uppercase tracking-wide',
                    alignClass(col.align),
                    col.headerClassName,
                  )}
                  aria-sort={
                    col.sortable
                      ? isActive
                        ? sort?.dir === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : 'none'
                      : undefined
                  }
                >
                  {col.sortable ? (
                    <button
                      type="button"
                      onClick={() => handleHeaderSort(col)}
                      className={cn(
                        'inline-flex items-center gap-0 rounded-sm font-medium text-muted-foreground',
                        'transition-colors hover:text-foreground',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0',
                        isActive && 'text-foreground',
                      )}
                    >
                      <span>{col.header}</span>
                      <SortIcon active={isActive} dir={sort?.dir} />
                    </button>
                  ) : (
                    <span className="font-medium">{col.header}</span>
                  )}
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>

        <TableBody>
          {loading ? (
            Array.from({ length: loadingRows }).map((_, r) => (
              <TableRow key={`sk-${r}`} className="hover:bg-transparent">
                {selectable && (
                  <TableCell className={cellPad}>
                    <Skeleton className="size-4 rounded" />
                  </TableCell>
                )}
                {columns.map((col) => (
                  <TableCell key={col.id} className={cn(cellPad, alignClass(col.align))}>
                    <Skeleton className="h-4 w-full max-w-[12rem]" />
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : rows.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={colCount} className="h-40 p-0">
                <div className="flex flex-col items-center justify-center gap-2 py-10 text-center text-muted-foreground">
                  {empty ?? (
                    <>
                      <Inbox className="size-7 opacity-50" aria-hidden />
                      <span className="text-sm">No results</span>
                    </>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row, rowIndex) => {
              const id = rowIds[rowIndex];
              const isSelected = selectedSet.has(id);
              const clickable = !!onRowClick;
              return (
                <TableRow
                  key={id}
                  data-state={isSelected ? 'selected' : undefined}
                  className={cn(clickable && 'cursor-pointer')}
                  onClick={
                    clickable ? () => onRowClick?.(row, rowIndex) : undefined
                  }
                  onKeyDown={
                    clickable
                      ? (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onRowClick?.(row, rowIndex);
                          }
                        }
                      : undefined
                  }
                  tabIndex={clickable ? 0 : undefined}
                  role={clickable ? 'button' : undefined}
                >
                  {selectable && (
                    <TableCell
                      className={cellPad}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => toggleRow(id)}
                        aria-label={`Select row ${id}`}
                      />
                    </TableCell>
                  )}
                  {columns.map((col) => (
                    <TableCell
                      key={col.id}
                      style={col.width ? { width: col.width } : undefined}
                      className={cn(cellPad, alignClass(col.align), col.className)}
                    >
                      {col.cell(row, rowIndex)}
                    </TableCell>
                  ))}
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>

      {showPager && (
        <div className="flex flex-col gap-3 border-t border-border px-3 py-2.5 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <span>
              {effTotal.toLocaleString()} row{effTotal === 1 ? '' : 's'}
            </span>
            {selectable && (selected?.length ?? 0) > 0 && (
              <span className="text-foreground">
                {selected!.length} selected
              </span>
            )}
          </div>

          <div className="flex items-center gap-4">
            {onPageSizeChange && pageSize != null && (
              <div className="flex items-center gap-2">
                <span className="hidden sm:inline">Rows per page</span>
                <Select
                  value={String(pageSize)}
                  onValueChange={(v) => onPageSizeChange(Number(v))}
                >
                  <SelectTrigger className="h-7 w-[4.5rem] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {pageSizeOptions.map((opt) => (
                      <SelectItem key={opt} value={String(opt)}>
                        {opt}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <span className="whitespace-nowrap">
              Page {curPage} of {pageCount}
            </span>

            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon"
                className="size-7"
                onClick={() => onPageChange?.(1)}
                disabled={!canPrev}
                aria-label="First page"
              >
                <ChevronsLeft className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="size-7"
                onClick={() => onPageChange?.(curPage - 1)}
                disabled={!canPrev}
                aria-label="Previous page"
              >
                <ChevronLeft className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="size-7"
                onClick={() => onPageChange?.(curPage + 1)}
                disabled={!canNext}
                aria-label="Next page"
              >
                <ChevronRight className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="size-7"
                onClick={() => onPageChange?.(pageCount)}
                disabled={!canNext}
                aria-label="Last page"
              >
                <ChevronsRight className="size-4" />
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default DataTable;
