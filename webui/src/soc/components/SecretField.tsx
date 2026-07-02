/**
 * SecretField — the invariant-#10 secret input. Secrets are BOOLEANS in the UI:
 * the field shows `configured ✓` / `not set` and NEVER echoes a stored value.
 * The only writable text is a NEW value the operator types to set/rotate; once
 * saved it is cleared and the boolean flips. (DESIGN_STANDARD §5.2, invariant #10.)
 *
 * The backend returns a boolean (`configured`) for each secret, never the value,
 * so there is nothing to echo. When the operator focuses the input to enter a new
 * value we mask it (type=password) with an optional show/hide toggle that only
 * ever reveals what they are CURRENTLY typing — never a persisted secret.
 *
 * Behavior:
 *  - `configured` (boolean) drives the status pill; the input is for a NEW value.
 *  - typing a non-empty value + `onCommit` is the "set/rotate" contract; the
 *    parent persists then re-fetches `configured` and clears `value`.
 *  - an optional `onClear` exposes a "Remove" affordance when configured.
 *  - `autoComplete="new-password"` (never `current-password`) so browsers/1Password
 *    don't autofill an unrelated saved credential.
 *  - built on `Field` for label/description/error a11y wiring.
 *
 * There is deliberately NO prop that accepts a plaintext existing secret.
 */
import * as React from 'react';
import { Eye, EyeOff, Check, Circle } from 'lucide-react';
import { Field } from './Field';
import { IconButton } from './IconButton';
import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';

export interface SecretFieldProps {
  /** Visible label. */
  label: React.ReactNode;
  /** Optional helper text. */
  description?: React.ReactNode;
  /** Optional error text. */
  error?: React.ReactNode;
  /** Whether a secret is currently stored server-side (boolean ONLY — never the value). */
  configured: boolean;
  /** The NEW value being typed (controlled). Cleared by the parent after a successful save. */
  value: string;
  /** Called as the operator types a new value. */
  onChange: (value: string) => void;
  /** Optional placeholder for the new-value input. */
  placeholder?: string;
  /** Optional "remove stored secret" handler; shows a Clear button when configured. */
  onClear?: () => void;
  /** Disable the input (e.g. env-managed secret). */
  disabled?: boolean;
  /** Marks the field required (visual `*` + `aria-required`). */
  required?: boolean;
  /** Optional slot on the label's right (e.g. a HelpTip) — forwarded to `Field`. */
  labelAction?: React.ReactNode;
  /** Label shown when configured. Default "configured". */
  configuredLabel?: string;
  className?: string;
}

export const SecretField = React.forwardRef<HTMLInputElement, SecretFieldProps>(
  (
    {
      label,
      description,
      error,
      configured,
      value,
      onChange,
      placeholder,
      onClear,
      disabled,
      required,
      labelAction,
      configuredLabel = 'configured',
      className,
    },
    ref,
  ) => {
    const [reveal, setReveal] = React.useState(false);

    return (
      <Field
        label={label}
        description={description}
        error={error}
        required={required}
        labelAction={labelAction}
        className={className}
      >
        {({ id, describedBy, invalid, required: ariaRequired }) => (
          <div className="space-y-1.5">
            {/* Status pill — the boolean, never the value. */}
            <div
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-2xs font-medium',
                configured
                  ? 'border-success/40 bg-success/10 text-success-text'
                  : 'border-border bg-muted/50 text-muted-foreground',
              )}
            >
              {configured ? (
                <Check className="h-3 w-3" aria-hidden="true" />
              ) : (
                <Circle className="h-3 w-3" aria-hidden="true" />
              )}
              <span>{configured ? `${configuredLabel} ✓` : 'not set'}</span>
            </div>

            {/* New-value input (masked). This is the ONLY place a secret is typed. */}
            <div className="relative">
              {/* Labeled via Field's <label htmlFor={id}> — association crosses the
                  render-prop boundary so the linter can't see it statically. */}
              {/* eslint-disable-next-line jsx-a11y/control-has-associated-label */}
              <input
                ref={ref}
                id={id}
                type={reveal ? 'text' : 'password'}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder ?? (configured ? 'Enter a new value to rotate' : 'Enter value')}
                disabled={disabled}
                autoComplete="new-password"
                aria-required={ariaRequired}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                className={cn(
                  'flex h-9 w-full rounded-md border border-input bg-background pl-3 pr-16 py-1 text-sm text-foreground transition-colors',
                  'placeholder:text-muted-foreground hover:border-border-strong',
                  'focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50',
                  focusRing,
                )}
              />
              <div className="absolute inset-y-0 right-1 flex items-center gap-0.5">
                <IconButton
                  label={reveal ? 'Hide value' : 'Show value'}
                  onClick={() => setReveal((r) => !r)}
                  disabled={disabled}
                >
                  {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </IconButton>
              </div>
            </div>

            {configured && onClear ? (
              <button
                type="button"
                onClick={onClear}
                disabled={disabled}
                className={cn(
                  'rounded-sm text-xs font-medium text-critical-text hover:underline disabled:opacity-50',
                  focusRing,
                )}
              >
                Remove stored value
              </button>
            ) : null}
          </div>
        )}
      </Field>
    );
  },
);
SecretField.displayName = 'SecretField';
