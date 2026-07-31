/**
 * ColumnsMenu — show/hide/reorder a DataTable's columns (Wave 7).
 *
 * A thin dropdown the page mounts in its toolbar. It reads the full column set
 * (id + a plain-text label + whether the column is locked-visible) and the current
 * `ColumnState`, and emits a NEW state on every toggle / move / reset. The page
 * persists that state via PrefsContext (`updateTableColumns`) and feeds it back to
 * the `<DataTable columnState=… />` so the table re-renders.
 *
 * Locked columns are always shown (their checkbox is disabled). All labels are
 * plain text (#9).
 */
import * as React from 'react';
import { Columns3, RotateCcw, ChevronUp, ChevronDown } from 'lucide-react';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { IconButton } from './IconButton';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/ui/dropdown-menu';
import type { ColumnState } from './DataTable';

/** The minimal column descriptor the menu needs (a slice of DataTableColumn). */
export interface ColumnMenuItem {
  id: string;
  /** Plain-text label shown in the checklist. */
  label: string;
  /** A locked column can never be hidden (checkbox disabled, always checked). */
  lockVisible?: boolean;
}

export interface ColumnsMenuProps {
  /** All columns (in their built-in default order). */
  columns: ColumnMenuItem[];
  /** The current per-table column state (order + hidden). */
  state: ColumnState;
  /** Emit a NEW state on every change (the page persists + re-applies it). */
  onChange: (state: ColumnState) => void;
  label?: string;
}

/** The effective ordered list of column ids from a state + the default order. */
function orderedIds(columns: ColumnMenuItem[], state: ColumnState): string[] {
  const order = state.order ?? [];
  const known = new Set(columns.map((c) => c.id));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of order) {
    if (known.has(id) && !seen.has(id)) {
      out.push(id);
      seen.add(id);
    }
  }
  for (const c of columns) if (!seen.has(c.id)) out.push(c.id);
  return out;
}

export const ColumnsMenu: React.FC<ColumnsMenuProps> = ({
  columns,
  state,
  onChange,
  label = 'Columns',
}) => {
  const byId = React.useMemo(() => new Map(columns.map((c) => [c.id, c])), [columns]);
  const ids = React.useMemo(() => orderedIds(columns, state), [columns, state]);
  const hidden = React.useMemo(() => new Set(state.hidden ?? []), [state.hidden]);
  const hiddenCount = columns.filter((c) => !c.lockVisible && hidden.has(c.id)).length;

  const toggle = (id: string) => {
    const col = byId.get(id);
    if (col?.lockVisible) return;
    const next = new Set(hidden);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange({ ...state, order: ids, hidden: Array.from(next) });
  };

  const move = (id: string, dir: -1 | 1) => {
    const idx = ids.indexOf(id);
    const target = idx + dir;
    if (idx < 0 || target < 0 || target >= ids.length) return;
    const next = ids.slice();
    [next[idx], next[target]] = [next[target], next[idx]];
    onChange({ ...state, order: next, hidden: Array.from(hidden) });
  };

  const reset = () => onChange({ order: [], hidden: [], widths: {} });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" aria-label="Customize columns">
          <Columns3 className="mr-1.5 size-4" aria-hidden />
          {label}
          {hiddenCount > 0 ? (
            <span className="ml-1.5 rounded bg-muted px-1.5 text-[11px] tabular-nums text-muted-foreground">
              {hiddenCount} hidden
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="flex items-center justify-between">
          <span>Columns</span>
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center gap-1 rounded px-1 text-[11px] font-normal text-muted-foreground hover:text-foreground"
            aria-label="Reset columns to default"
          >
            <RotateCcw className="size-3" aria-hidden />
            Reset
          </button>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <div className="max-h-[20rem] overflow-y-auto py-1">
          {ids.map((id, i) => {
            const col = byId.get(id);
            if (!col) return null;
            const isHidden = hidden.has(id) && !col.lockVisible;
            return (
              <div
                key={id}
                className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
              >
                <Checkbox
                  checked={!isHidden}
                  disabled={col.lockVisible}
                  onCheckedChange={() => toggle(id)}
                  aria-label={`Toggle column ${col.label}`}
                />
                <span className="flex-1 truncate">{col.label}</span>
                <div className="flex items-center">
                  <IconButton
                    label={`Move ${col.label} up`}
                    tooltip={false}
                    size="sm"
                    className="rounded [&_svg]:size-3.5 disabled:opacity-30"
                    disabled={i === 0}
                    onClick={() => move(id, -1)}
                  >
                    <ChevronUp className="size-3.5" aria-hidden />
                  </IconButton>
                  <IconButton
                    label={`Move ${col.label} down`}
                    tooltip={false}
                    size="sm"
                    className="rounded [&_svg]:size-3.5 disabled:opacity-30"
                    disabled={i === ids.length - 1}
                    onClick={() => move(id, 1)}
                  >
                    <ChevronDown className="size-3.5" aria-hidden />
                  </IconButton>
                </div>
              </div>
            );
          })}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default ColumnsMenu;
