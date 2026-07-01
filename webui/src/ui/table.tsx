import * as React from 'react';
import { cn } from '@/lib/cn';

/**
 * `density` on TableHead/TableCell (DESIGN_STANDARD §5.2 / §7): `normal` is the
 * pre-Round-5 look (`h-11 px-4` head / `px-4 py-3` cell); `compact` tightens the
 * vertical rhythm while keeping ≥16px horizontal padding (below that columns
 * visually merge). Default is `normal`, so existing tables are byte-identical.
 *
 * `Table` gains a no-double-wrap escape hatch: it normally wraps the `<table>` in
 * an `overflow-auto` div; pass `unwrapped` (or `containerClassName={undefined}` +
 * `unwrapped`) when the table already lives inside a scroll container so you don't
 * create a second, clipping scroll context (map §3.9). `containerClassName` lets
 * callers style the wrapper without a second nested div.
 *
 * `TableHeader` gains `sticky` — pins the header row to the top of its scroll
 * container (`sticky top-0 z-10` + the surface bg so rows don't bleed through).
 */
type Density = 'normal' | 'compact';

export interface TableProps extends React.HTMLAttributes<HTMLTableElement> {
  /** Skip the built-in `overflow-auto` wrapper (already inside a scroll area). */
  unwrapped?: boolean;
  /** Class applied to the built-in wrapper div (ignored when `unwrapped`). */
  containerClassName?: string;
}

const Table = React.forwardRef<HTMLTableElement, TableProps>(
  ({ className, unwrapped, containerClassName, ...props }, ref) => {
    const table = (
      <table ref={ref} className={cn('w-full caption-bottom text-sm', className)} {...props} />
    );
    if (unwrapped) return table;
    return <div className={cn('relative w-full overflow-auto', containerClassName)}>{table}</div>;
  },
);
Table.displayName = 'Table';

export interface TableHeaderProps extends React.HTMLAttributes<HTMLTableSectionElement> {
  /** Pin the header to the top of the scroll container. */
  sticky?: boolean;
}

const TableHeader = React.forwardRef<HTMLTableSectionElement, TableHeaderProps>(
  ({ className, sticky, ...props }, ref) => (
    <thead
      ref={ref}
      className={cn(
        'bg-surface/50 [&_tr]:border-b [&_tr]:border-border',
        sticky && 'sticky top-0 z-10 bg-surface backdrop-blur supports-[backdrop-filter]:bg-surface/85',
        className,
      )}
      {...props}
    />
  ),
);
TableHeader.displayName = 'TableHeader';

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody
    ref={ref}
    className={cn('[&_tr:last-child]:border-0', className)}
    {...props}
  />
));
TableBody.displayName = 'TableBody';

const TableFooter = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tfoot
    ref={ref}
    className={cn(
      'border-t border-border bg-surface/60 font-medium text-foreground [&>tr]:last:border-b-0',
      className,
    )}
    {...props}
  />
));
TableFooter.displayName = 'TableFooter';

const TableRow = React.forwardRef<
  HTMLTableRowElement,
  React.HTMLAttributes<HTMLTableRowElement>
>(({ className, ...props }, ref) => (
  <tr
    ref={ref}
    className={cn(
      'border-b border-border/70 transition-colors last:border-0 hover:bg-muted/40 ' +
        'data-[state=selected]:bg-accent/60',
      className,
    )}
    {...props}
  />
));
TableRow.displayName = 'TableRow';

export interface TableHeadProps extends React.ThHTMLAttributes<HTMLTableCellElement> {
  density?: Density;
}

const TableHead = React.forwardRef<HTMLTableCellElement, TableHeadProps>(
  ({ className, density = 'normal', ...props }, ref) => (
    <th
      ref={ref}
      className={cn(
        'px-4 text-left align-middle text-[11px] font-semibold uppercase tracking-wide ' +
          'text-muted-foreground [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]',
        density === 'compact' ? 'h-9' : 'h-11',
        className,
      )}
      {...props}
    />
  ),
);
TableHead.displayName = 'TableHead';

export interface TableCellProps extends React.TdHTMLAttributes<HTMLTableCellElement> {
  density?: Density;
}

const TableCell = React.forwardRef<HTMLTableCellElement, TableCellProps>(
  ({ className, density = 'normal', ...props }, ref) => (
    <td
      ref={ref}
      className={cn(
        'px-4 align-middle text-foreground [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]',
        density === 'compact' ? 'py-2' : 'py-3',
        className,
      )}
      {...props}
    />
  ),
);
TableCell.displayName = 'TableCell';

const TableCaption = React.forwardRef<
  HTMLTableCaptionElement,
  React.HTMLAttributes<HTMLTableCaptionElement>
>(({ className, ...props }, ref) => (
  <caption
    ref={ref}
    className={cn('mt-4 text-sm text-muted-foreground', className)}
    {...props}
  />
));
TableCaption.displayName = 'TableCaption';

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
};
