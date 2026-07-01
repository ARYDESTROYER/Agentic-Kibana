/**
 * DiffView (Round-5 G6 · R5) — a red/green inline field diff between two rule-config
 * snapshots, computed by the dep-free `diffConfigs` (NO diff library).
 *
 * Each row is one changed field: `added` (green, new value), `removed` (red, struck
 * prior value), `changed` (prior struck red → new green). Every path + value renders
 * PLAIN text (#9) — configs are operator-authored, log-adjacent data. When the two
 * snapshots are identical the view says so rather than showing an empty box.
 */
import * as React from 'react';

import { cn } from '@/lib/cn';
import { diffConfigs } from './diff';
import type { FieldDiff } from './types';

export interface DiffViewProps {
  /** The PRIOR config (the version being compared FROM). */
  before: Record<string, unknown> | null | undefined;
  /** The CURRENT config (the version being compared TO). */
  after: Record<string, unknown> | null | undefined;
  className?: string;
}

/** A single value token, colored by add/remove and struck when removed. */
function ValueToken({ text, tone }: { text: string; tone: 'add' | 'remove' }) {
  return (
    <code
      className={cn(
        'break-all rounded px-1 py-0.5 font-mono text-2xs',
        tone === 'add'
          ? 'bg-success/10 text-success-text'
          : 'bg-critical/10 text-critical-text line-through',
      )}
    >
      {text === '' ? '∅' : text}
    </code>
  );
}

function DiffRow({ row }: { row: FieldDiff }) {
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1">
      <span
        className={cn(
          'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-2xs font-bold',
          row.kind === 'added' && 'bg-success/15 text-success-text',
          row.kind === 'removed' && 'bg-critical/15 text-critical-text',
          row.kind === 'changed' && 'bg-warning/15 text-warning-text',
        )}
        aria-hidden
      >
        {row.kind === 'added' ? '+' : row.kind === 'removed' ? '−' : '~'}
      </span>
      <span className="font-mono text-xs font-medium text-foreground">{row.path}</span>
      {row.kind === 'changed' ? (
        <>
          <ValueToken text={row.before ?? ''} tone="remove" />
          <span className="text-muted-foreground" aria-hidden>
            →
          </span>
          <ValueToken text={row.after ?? ''} tone="add" />
        </>
      ) : row.kind === 'added' ? (
        <ValueToken text={row.after ?? ''} tone="add" />
      ) : (
        <ValueToken text={row.before ?? ''} tone="remove" />
      )}
      {/* screen-reader description of the change, non-visual */}
      <span className="sr-only">
        {row.kind === 'added'
          ? `added ${row.path} = ${row.after ?? ''}`
          : row.kind === 'removed'
            ? `removed ${row.path} (was ${row.before ?? ''})`
            : `changed ${row.path} from ${row.before ?? ''} to ${row.after ?? ''}`}
      </span>
    </li>
  );
}

export function DiffView({ before, after, className }: DiffViewProps) {
  const rows = React.useMemo(() => diffConfigs(before, after), [before, after]);

  if (rows.length === 0) {
    return (
      <p className={cn('text-xs text-muted-foreground', className)}>
        No field changes between these versions.
      </p>
    );
  }
  return (
    <ul className={cn('divide-y divide-border/60 text-sm', className)} data-testid="rule-diff">
      {rows.map((row) => (
        <DiffRow key={row.path} row={row} />
      ))}
    </ul>
  );
}
DiffView.displayName = 'DiffView';
