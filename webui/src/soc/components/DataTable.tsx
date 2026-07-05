/**
 * DataTable — the ONE table primitive for the console.
 *
 * a11y contract (Round-5 W0-E / DESIGN_STANDARD §6.2/§6.3):
 *  - Sortable headers are `<button>` inside `<th scope="col">`; `aria-sort` is set
 *    ONLY on the active column (omitted otherwise — never `"none"`), and the change
 *    is ALSO spoken through the shared live region (VoiceOver/TalkBack ignore
 *    `aria-sort`).
 *  - Clickable rows get `scroll-mt-[var(--header-h)]` so a focused row is never
 *    hidden behind the sticky header (WCAG 2.4.11 Focus Not Obscured).
 *  - `rowAccent` draws an OPT-IN left-edge severity band (non-color-only reading of
 *    row risk, §6.1) as an inset box-shadow (no layout shift, no extra column).
 *  - 2.5.7 Dragging: this table has NO drag interaction. Column reorder ships via the
 *    keyboard-accessible `<ColumnsMenu>` (checklist + move controls), NOT drag — so
 *    the no-single-pointer-drag requirement is met by construction. If a future
 *    variant adds drag-to-reorder, it MUST keep a non-drag "move up/down" alternative.
 */
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
import { useAnnouncer } from './announcer';
import { semanticColor } from './palette';
import { ProvenanceTag, type Provenance } from './ProvenanceTag';

export type SortDir = 'asc' | 'desc';

/**
 * Per-table column customization state (Wave 7). `order` is the ordered list of
 * column ids the user arranged; `hidden` are the column ids they hid; `widths` is
 * an optional column id → px width map. An empty/absent state renders the table's
 * built-in default columns unchanged.
 */
export interface ColumnState {
  order?: string[];
  hidden?: string[];
  widths?: Record<string, number>;
}

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
  /**
   * When true (Wave 7 column customization), this column can never be hidden via
   * the "Columns" menu (e.g. the primary id column). Defaults false.
   */
  lockVisible?: boolean;
  /**
   * A short, plain-text label for the "Columns" menu checklist (used when `header`
   * is a non-string node). Falls back to a string `header`, else the column id.
   */
  menuLabel?: string;
  /**
   * Provenance of this column's values (Round-7 #9b) — WHO produced them: the raw
   * `source` (SIEM-asserted), the `ai` agent (LLM), or deterministic `code`. When set,
   * a small `<ProvenanceTag variant="icon">` renders beside the header so the whole
   * column is attributed at a glance. Use for columns whose provenance is CONSTANT
   * (risk/verdict/confidence); per-row-varying provenance (severity) tags the cell
   * instead. Absent → no tag (back-compatible).
   */
  provenance?: Provenance;
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

  /**
   * Pin the header row while the body scrolls (Round-7 #8). OFF by default
   * (back-compatible). Passes through to the `<TableHeader sticky>` primitive, which
   * parks the header under the app bar (`top-[var(--header-h)]`) with an OPAQUE
   * background so scrolled rows never bleed through it.
   */
  sticky?: boolean;

  // ---- Column customization (Wave 7; optional + back-compatible) --------- //
  /**
   * Controlled per-table column state (show/hide/reorder). When provided, the table
   * applies `hidden` (drops those columns) and `order` (reorders them). Columns with
   * `lockVisible` can never be hidden. Omitting this keeps the table's built-in
   * default column order/visibility, unchanged. The user-facing control lives in the
   * sibling `<ColumnsMenu>` (mounted in the page toolbar) which the page wires to
   * PrefsContext + feeds back here.
   */
  columnState?: ColumnState;

  /**
   * Left-edge severity band (Round-5 W0-E / §6.1 non-color signaling). OFF by
   * default (back-compatible). When provided, each dense row gets a 3px colored bar
   * on its leading edge derived from a per-row SEVERITY label/score, so the risk of
   * a row is legible at a glance at high row counts WITHOUT relying on a tiny colored
   * word in a cell. Return a severity label ('critical'/'high'/'medium'/'low'/'info')
   * or a 0-100 score (resolved via the ONE palette authority), or null/undefined for
   * no band on that row. The band is decorative (`aria-hidden`); the cell content
   * still carries the accessible value.
   */
  rowAccent?: (row: T, index: number) => string | number | null | undefined;
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
        className="ml-1.5 inline-block size-3 text-muted-foreground/40 transition-colors"
        aria-hidden
      />
    );
  return dir === 'asc' ? (
    <ChevronUp className="ml-1.5 inline-block size-3 text-foreground" aria-hidden />
  ) : (
    <ChevronDown className="ml-1.5 inline-block size-3 text-foreground" aria-hidden />
  );
}

/**
 * SkeletonRow — a placeholder row shaped like a real data row so the loading state
 * occupies the eventual row height + column layout (no content-in shift). It mirrors a
 * rendered row exactly: the leading checkbox cell when `selectable`, the SAME density
 * padding, one shimmer bar per displayed column, and the column's alignment (a block
 * Skeleton is nudged via `ml-auto`/`mx-auto` so a right/center column's bar lands where
 * its content will). Decorative → `aria-hidden`.
 */
function SkeletonRow<T>({
  columns,
  selectable,
  cellPad,
}: {
  columns: DataTableColumn<T>[];
  selectable: boolean;
  cellPad: string;
}) {
  return (
    <TableRow className="hover:bg-transparent" aria-hidden>
      {selectable && (
        <TableCell className={cellPad}>
          <Skeleton className="size-4 rounded" />
        </TableCell>
      )}
      {columns.map((col) => (
        <TableCell key={col.id} className={cn(cellPad, alignClass(col.align))}>
          <Skeleton
            className={cn(
              'h-4 w-full max-w-[12rem]',
              col.align === 'right' && 'ml-auto',
              col.align === 'center' && 'mx-auto',
            )}
          />
        </TableCell>
      ))}
    </TableRow>
  );
}

/**
 * Resolve the DISPLAYED columns from the full column set + the user's column state:
 * hidden ids dropped, then ordered by `order` (any column missing from `order`
 * keeps its original relative position AFTER the ordered ones). Locked columns are
 * never dropped even if `hidden` lists them.
 */
function resolveColumns<T>(
  columns: DataTableColumn<T>[],
  state?: ColumnState,
): DataTableColumn<T>[] {
  if (!state) return columns;
  const hidden = new Set(state.hidden ?? []);
  const order = state.order ?? [];
  const visible = columns.filter((c) => c.lockVisible || !hidden.has(c.id));
  if (!order.length) return visible;
  const byId = new Map(visible.map((c) => [c.id, c] as const));
  const out: DataTableColumn<T>[] = [];
  for (const id of order) {
    const c = byId.get(id);
    if (c) {
      out.push(c);
      byId.delete(id);
    }
  }
  // Any visible columns not named in `order` keep their original order, appended.
  for (const c of visible) if (byId.has(c.id)) out.push(c);
  return out;
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
  sticky = false,
  columnState,
  rowAccent,
}: DataTableProps<T>) {
  // Shared app-level live announcer (§6.3 / E3) — no-op when no provider is mounted.
  const announce = useAnnouncer();

  // Resolve the displayed columns from the user's stored column state (Wave 7).
  const displayColumns = React.useMemo(
    () => resolveColumns(columns, columnState),
    [columns, columnState],
  );

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

  // OpenSearch-style comfortable rows: roomy horizontal padding, breathable
  // vertical rhythm in normal density, tighter (but still legible) when compact.
  const cellPad = density === 'compact' ? 'px-4 py-2' : 'px-4 py-3';

  // A short plain-text name for a column, for the live announcement (§6.3). Prefer
  // an explicit `menuLabel`, then a string `header`, else the column id.
  const columnName = (col: DataTableColumn<T>): string =>
    col.menuLabel ?? (typeof col.header === 'string' ? col.header : col.id);

  const handleHeaderSort = (col: DataTableColumn<T>) => {
    if (!col.sortable || !onSortChange) return;
    const isActive = sort?.id === col.id;
    const nextDir: SortDir =
      isActive && sort?.dir === 'asc' ? 'desc' : 'asc';
    onSortChange({ id: col.id, dir: nextDir });
    // aria-sort is silently ignored by VoiceOver / TalkBack, so speak the change
    // through the shared live region too (§6.3).
    announce(
      `Sorted by ${columnName(col)}, ${nextDir === 'asc' ? 'ascending' : 'descending'}`,
    );
  };

  const toggleAll = () => {
    if (!onSelectedChange) return;
    if (allSelected) {
      onSelectedChange((selected ?? []).filter((id) => !rowIds.includes(id)));
      announce('All rows deselected');
    } else {
      const merged = new Set(selected ?? []);
      rowIds.forEach((id) => merged.add(id));
      onSelectedChange(Array.from(merged));
      announce(`${rowIds.length} row${rowIds.length === 1 ? '' : 's'} selected`);
    }
  };

  const toggleRow = (id: string) => {
    if (!onSelectedChange) return;
    const next = new Set(selected ?? []);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectedChange(Array.from(next));
  };

  const colCount = displayColumns.length + (selectable ? 1 : 0);

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
        // Clean OpenSearch card: hairline border, soft elevation, clipped so the
        // header row + rounded corners stay crisp. Borders over heavy shadow.
        'overflow-hidden rounded-lg border border-border bg-card shadow-elev1',
        className,
      )}
    >
      <Table aria-label={ariaLabel}>
        <TableHeader sticky={sticky}>
          <TableRow className="hover:bg-transparent">
            {selectable && (
              <TableHead className="w-10 px-4">
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
            {displayColumns.map((col) => {
              const isActive = sort?.id === col.id;
              return (
                <TableHead
                  key={col.id}
                  scope="col"
                  style={col.width ? { width: col.width } : undefined}
                  className={cn(
                    // Header typography (uppercase/tracking/weight/colour) comes
                    // from the TableHead primitive; just keep labels on one line.
                    'whitespace-nowrap',
                    alignClass(col.align),
                    col.headerClassName,
                  )}
                  // §6.3: reflect the sort ONLY on the actively-sorted sortable
                  // column; OMIT aria-sort otherwise (never emit "none", which some
                  // SRs announce as a spurious "not sorted" on every column).
                  aria-sort={
                    col.sortable && isActive
                      ? sort?.dir === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : undefined
                  }
                >
                  {col.sortable ? (
                    <button
                      type="button"
                      onClick={() => handleHeaderSort(col)}
                      className={cn(
                        'group -mx-1 inline-flex items-center rounded-sm px-1 py-0.5 ' +
                          'font-semibold uppercase tracking-wide text-muted-foreground',
                        'transition-colors hover:text-foreground',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0',
                        isActive && 'text-foreground',
                      )}
                    >
                      <span>{col.header}</span>
                      {col.provenance && (
                        <ProvenanceTag
                          kind={col.provenance}
                          variant="icon"
                          className="ml-1"
                        />
                      )}
                      <SortIcon active={isActive} dir={sort?.dir} />
                    </button>
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      <span>{col.header}</span>
                      {col.provenance && (
                        <ProvenanceTag kind={col.provenance} variant="icon" />
                      )}
                    </span>
                  )}
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>

        <TableBody>
          {loading ? (
            Array.from({ length: loadingRows }).map((_, r) => (
              <SkeletonRow
                key={`sk-${r}`}
                columns={displayColumns}
                selectable={selectable}
                cellPad={cellPad}
              />
            ))
          ) : rows.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={colCount} className="h-48 p-0">
                <div className="flex flex-col items-center justify-center gap-3 py-14 text-center text-muted-foreground">
                  {empty ?? (
                    <>
                      <Inbox className="size-8 opacity-40" aria-hidden />
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
              // Left-edge severity band (§6.1) — opt-in via `rowAccent`. Drawn as an
              // inset box-shadow so it needs no extra column and never shifts layout.
              // Decorative: the cell content carries the accessible severity value.
              const accent = rowAccent?.(row, rowIndex);
              const accentColor =
                accent !== null && accent !== undefined && accent !== ''
                  ? semanticColor(String(accent))
                  : undefined;
              return (
                <TableRow
                  key={id}
                  data-state={isSelected ? 'selected' : undefined}
                  className={cn(
                    // §2.4.11 Focus Not Obscured: when a keyboard user tabs onto a
                    // clickable row, keep it clear of the sticky header/save-bar.
                    clickable &&
                      'cursor-pointer scroll-mt-[var(--header-h)] focus-visible:outline-none focus-visible:ring-2 ' +
                        'focus-visible:ring-inset focus-visible:ring-ring',
                  )}
                  style={
                    accentColor
                      ? { boxShadow: `inset 3px 0 0 0 ${accentColor}` }
                      : undefined
                  }
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
                  {displayColumns.map((col) => (
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
        <div className="flex flex-col gap-3 border-t border-border bg-surface/40 px-4 py-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <span className="tabular-nums">
              {effTotal.toLocaleString()} row{effTotal === 1 ? '' : 's'}
            </span>
            {selectable && (selected?.length ?? 0) > 0 && (
              <span className="font-medium tabular-nums text-foreground">
                {selected!.length} selected
              </span>
            )}
          </div>

          <div className="flex items-center gap-5">
            {onPageSizeChange && pageSize != null && (
              <div className="flex items-center gap-2">
                <span className="hidden sm:inline">Rows per page</span>
                <Select
                  value={String(pageSize)}
                  onValueChange={(v) => onPageSizeChange(Number(v))}
                >
                  <SelectTrigger className="h-7 w-[4.5rem] text-xs" aria-label="Rows per page">
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

            <span className="whitespace-nowrap tabular-nums">
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
