/**
 * ConditionBuilder (Round-5 G6 · R3) — the single `{field, op, value}` predicate
 * editor used by a detection rule.
 *
 * This IS the backend `RuleMatch` shape (`{field, op, value}`), rendered as a
 * shadcn `Select`/`Input` row. `RuleDefinition.match` is a SINGLE predicate on the
 * wire, so the normal editor deliberately renders exactly one row. Nested AND/OR and
 * multi-predicate authoring remain unavailable until the backend can persist and
 * execute them; the UI must not collect input that Save will discard.
 *
 * Invariants:
 *  - #9: `field`/`value` are operator-authored + LOG-adjacent → rendered as PLAIN
 *    text inputs, never interpolated into markup.
 *  - when `op === 'exists'` the value input is HIDDEN (the op needs no value).
 *  - every control is `Label`-associated for a11y.
 *
 * The array-shaped prop remains for compatibility with the existing `RuleForm`, but
 * only its first row is authoritative and every edit emits exactly one row.
 */
import * as React from 'react';

import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';
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
  disabled,
}: {
  row: PredicateRow;
  index: number;
  listId: string;
  onChange: (next: PredicateRow) => void;
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
    </div>
  );
}

export function ConditionBuilder({ value, onChange, disabled, idPrefix = 'cond' }: ConditionBuilderProps) {
  const listId = React.useId().replace(/[:]/g, '') + `-${idPrefix}`;
  const row = value[0] ?? newPredicateRow();

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

      <ConditionRow
        row={row}
        index={0}
        listId={listId}
        onChange={(next) => onChange([next])}
        disabled={disabled}
      />
    </div>
  );
}
ConditionBuilder.displayName = 'ConditionBuilder';
