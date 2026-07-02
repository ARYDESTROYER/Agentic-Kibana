/**
 * LabeledSlider — a Radix Slider bound to a numeric readout + optional tick
 * markers, for risk-weight / threshold / tuning knobs (G6, DESIGN_STANDARD §5.2).
 * Fixes "Slider has no readout": the current value is always shown (tabular-nums)
 * and, when `editable`, a small linked number input lets the operator type an
 * exact value that clamps back into range.
 *
 * Contract:
 *  - controlled `value: number` + `onChange(next)`; both slider drag and the
 *    linked input drive the same `onChange`.
 *  - `min`/`max`/`step` drive the slider granularity AND the input clamp.
 *  - `ticks` renders labelled marks under the track (e.g. Low/Med/High); the
 *    labels are plain text, `aria-hidden` (the slider itself carries the value).
 *  - `formatValue` formats the readout (e.g. `(v) => v + '%'`).
 *  - a11y: the Radix slider thumb is the accessible control; we set
 *    `aria-label`/`aria-valuetext` so AT announces a meaningful value, and the
 *    label is wired via `Field`.
 */
import * as React from 'react';
import { Field } from './Field';
import { Slider } from '@/ui/slider';
import { clampNumber } from './NumberField';
import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';

export interface SliderTick {
  value: number;
  label: string;
}

export interface LabeledSliderProps {
  /** Visible label. */
  label: React.ReactNode;
  /** Optional helper text. */
  description?: React.ReactNode;
  /** Optional error text. */
  error?: React.ReactNode;
  /** Current value (controlled). */
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Labelled tick marks under the track. */
  ticks?: SliderTick[];
  /** Format the readout + `aria-valuetext` (default `String`). */
  formatValue?: (v: number) => string;
  /** Show a linked numeric input beside the readout. Default true. */
  editable?: boolean;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  /** Optional slot on the label's right (e.g. a HelpTip / tuner suggestion). */
  labelAction?: React.ReactNode;
}

export const LabeledSlider = React.forwardRef<HTMLDivElement, LabeledSliderProps>(
  (
    {
      label,
      description,
      error,
      value,
      onChange,
      min = 0,
      max = 100,
      step = 1,
      ticks,
      formatValue = (v) => String(v),
      editable = true,
      required,
      disabled,
      className,
      labelAction,
    },
    ref,
  ) => {
    const [text, setText] = React.useState<string>(String(value));
    React.useEffect(() => setText(String(value)), [value]);

    const commitText = (raw: string) => {
      const n = raw.trim() === '' ? value : Number(raw);
      const next = clampNumber(Number.isNaN(n) ? value : n, { min, max, step });
      setText(String(next));
      if (next !== value) onChange(next);
    };

    const readout = (
      <span className="inline-flex items-center gap-2">
        <span className="text-sm font-semibold tabular-nums text-foreground">{formatValue(value)}</span>
        {editable ? (
          <input
            type="text"
            inputMode="decimal"
            value={text}
            disabled={disabled}
            aria-label={`${typeof label === 'string' ? label : 'value'} exact value`}
            onChange={(e) => setText(e.target.value)}
            onBlur={(e) => commitText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitText((e.target as HTMLInputElement).value);
            }}
            className={cn(
              'h-7 w-16 rounded-md border border-input bg-background px-2 text-right text-xs tabular-nums text-foreground',
              'focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50',
              focusRing,
            )}
          />
        ) : null}
      </span>
    );

    return (
      <Field
        ref={ref}
        label={label}
        description={description}
        error={error}
        required={required}
        className={className}
        labelAction={
          <div className="flex items-center gap-2">
            {readout}
            {labelAction}
          </div>
        }
      >
        {({ labelledBy, describedBy, invalid }) => (
          <div className="pt-1">
            <Slider
              value={[value]}
              min={min}
              max={max}
              step={step}
              disabled={disabled}
              // The Slider primitive forwards these to the role="slider" Thumb.
              // `aria-labelledby` points at Field's visible <label>, so the thumb is
              // named even when `label` is a ReactNode (aria-label is string-only).
              aria-labelledby={labelledBy}
              aria-label={typeof label === 'string' ? label : undefined}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              aria-valuetext={formatValue(value)}
              onValueChange={(vals) => {
                const next = vals[0];
                if (next != null && next !== value) onChange(next);
              }}
            />
            {ticks && ticks.length ? (
              <div className="mt-1.5 flex justify-between" aria-hidden="true">
                {ticks.map((t) => (
                  <span
                    key={t.value}
                    className={cn(
                      'text-2xs tabular-nums',
                      value === t.value ? 'font-medium text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    {t.label}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        )}
      </Field>
    );
  },
);
LabeledSlider.displayName = 'LabeledSlider';
