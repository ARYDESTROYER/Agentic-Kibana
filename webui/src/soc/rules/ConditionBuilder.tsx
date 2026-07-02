/**
 * ConditionBuilder (Round-5 G6 · R3) — the FLAT `{field, op, value}` AND-row builder.
 *
 * This IS the backend `RuleMatch` shape (`{field, op, value}`), rendered as a
 * repeatable list of rows over shadcn `Select`/`Input`. Rows are ANDed (an implicit,
 * LABELLED "AND"). Nested AND/OR groups are DEFERRED to the gated Phase-3 wave
 * (RESEARCH_RULES_UX §4b) — this builder deliberately stays dep-free.
 *
 * Invariants:
 *  - #9: `field`/`value` are operator-authored + LOG-adjacent → rendered as PLAIN
 *    text inputs, never interpolated into markup.
 *  - when `op === 'exists'` the value input is HIDDEN (the op needs no value).
 *  - every control is `Field`/`Label`-associated for a11y; the remove button is a
 *    ≥24px `IconButton`; add/remove is a non-drag operation (WCAG 2.5.7 n/a here).
 *
 * NOTE ON WIRE CAPACITY: `RuleDefinition.match` is a SINGLE predicate on the wire.
 * The builder supports MULTIPLE rows as a UI-forward affordance, but the adapter maps
 * only the FIRST row to the wire `match` and the shell surfaces a visible note when
 * more than one row is present (never silently ANDs a shape the backend can't run).
 */
import * as React from 'react';
import { Plus, X } from 'lucide-react';

import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';
import { IconButton } from '@/soc/components/IconButton';

import type { PredicateRow } from './types';
import { PREDICATE_FIELD_SUGGESTIONS, PREDICATE_OPS, newPredicateRow, opHasValue } from './constants';

export interface ConditionBuilderProps {
  /** The flat predicate rows (controlled). */
  value: PredicateRow[];
  onChange: (next: PredicateRow[]) => void;
  disabled?: boolean;
  /** A stable id prefix for the datalist / control ids. */
  idPrefix?: string;
}

/** A single editable predicate row. */
function ConditionRow({
  row,
  index,
  listId,
  onChange,
  onRemove,
  canRemove,
  disabled,
}: {
  row: PredicateRow;
  index: number;
  listId: string;
  onChange: (next: PredicateRow) => void;
  onRemove: () => void;
  canRemove: boolean;
  disabled?: boolean;
}) {
  const showValue = opHasValue(row.op);
  const fieldId = `${listId}-field-${index}`;
  const opId = `${listId}-op-${index}`;
  const valueId = `${listId}-value-${index}`;

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-md border border-border bg-surface p-2">
      {/* field (combobox: a datalist-backed input, so custom dotted paths are allowed) */}
      <div className="min-w-[10rem] flex-1 space-y-1">
        <Label htmlFor={fieldId} className="text-xs">
          Field
        </Label>
        <Input
          id={fieldId}
          list={listId}
          value={row.field}
          disabled={disabled}
          placeholder="e.g. rule.id"
          aria-label={`Condition ${index + 1} field`}
          onChange={(e) => onChange({ ...row, field: e.target.value })}
          className="h-8"
        />
      </div>

      {/* op */}
      <div className="w-32 space-y-1">
        <Label htmlFor={opId} className="text-xs">
          Operator
        </Label>
        <Select
          value={row.op}
          disabled={disabled}
          onValueChange={(v) => onChange({ ...row, op: v as PredicateRow['op'] })}
        >
          <SelectTrigger id={opId} className="h-8" aria-label={`Condition ${index + 1} operator`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PREDICATE_OPS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* value (hidden for the `exists` op) */}
      {showValue ? (
        <div className="min-w-[10rem] flex-1 space-y-1">
          <Label htmlFor={valueId} className="text-xs">
            Value
          </Label>
          <Input
            id={valueId}
            value={row.value ?? ''}
            disabled={disabled}
            placeholder="value"
            aria-label={`Condition ${index + 1} value`}
            onChange={(e) => onChange({ ...row, value: e.target.value })}
            className="h-8"
          />
        </div>
      ) : (
        <div className="flex-1 pb-1.5 text-xs text-muted-foreground">no value needed</div>
      )}

      <IconButton
        label={`Remove condition ${index + 1}`}
        size="sm"
        variant="ghost"
        tooltip={false}
        disabled={disabled || !canRemove}
        onClick={onRemove}
        className="mb-0.5 text-critical-text hover:text-critical-text"
      >
        <X />
      </IconButton>
    </div>
  );
}

export function ConditionBuilder({ value, onChange, disabled, idPrefix = 'cond' }: ConditionBuilderProps) {
  const listId = React.useId().replace(/[:]/g, '') + `-${idPrefix}`;
  const rows = value.length ? value : [newPredicateRow()];

  const setRow = (i: number, next: PredicateRow) => {
    const copy = [...rows];
    copy[i] = next;
    onChange(copy);
  };
  const addRow = () => onChange([...rows, newPredicateRow()]);
  const removeRow = (i: number) => {
    const next = rows.filter((_, idx) => idx !== i);
    onChange(next.length ? next : [newPredicateRow()]);
  };

  return (
    <div className="space-y-2">
      {/* shared datalist of suggested OCSF/native dotted paths (still free-typeable) */}
      <datalist id={listId}>
        {PREDICATE_FIELD_SUGGESTIONS.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </datalist>

      {rows.map((row, i) => (
        <React.Fragment key={i}>
          {i > 0 ? (
            <div className="pl-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground" aria-hidden>
              and
            </div>
          ) : null}
          <ConditionRow
            row={row}
            index={i}
            listId={listId}
            onChange={(next) => setRow(i, next)}
            onRemove={() => removeRow(i)}
            canRemove={rows.length > 1}
            disabled={disabled}
          />
        </React.Fragment>
      ))}

      <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={addRow}>
        <Plus className="h-3.5 w-3.5" aria-hidden />
        Add condition
      </Button>
    </div>
  );
}
ConditionBuilder.displayName = 'ConditionBuilder';
