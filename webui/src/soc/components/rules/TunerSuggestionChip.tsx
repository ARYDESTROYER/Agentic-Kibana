/**
 * TunerSuggestionChip — an inline, advisory "the tuner recommends N" affordance next
 * to an operator-editable threshold (G6 R4, RESEARCH_RULES_UX §5d).
 *
 * The deterministic nightly tuner (`engine/threshold_tuner.py`) computes a bounded +1
 * suggestion per rule (a correlation `n` or a feed `severity_floor`). We surface that
 * suggestion RIGHT next to the field the operator owns, with a one-click "apply
 * suggestion" that just sets the field value locally — it does NOT write config, does
 * NOT call `decide()`, and does NOT bill an LLM. The operator still owns the value; the
 * chip is advisory only.
 *
 * The suggestion value is a bounded number the backend produced; it renders as a plain
 * tabular-nums text node (#9). When there is no suggestion (or it equals the current
 * value) the chip renders nothing.
 */
import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';

export interface TunerSuggestionChipProps {
  /** The current field value (to hide the chip when it already matches). */
  current: number;
  /** The tuner's suggested value, or null/undefined when there is no suggestion. */
  suggested: number | null | undefined;
  /** Apply the suggestion (sets the field locally — never writes config). */
  onApply: (value: number) => void;
  /** Optional formatter for the displayed suggestion (default `String`). */
  format?: (v: number) => string;
  /** Disable the apply action (e.g. read-only user). */
  disabled?: boolean;
  className?: string;
}

/**
 * A small pill: "Tuner suggests {n} · apply". Advisory; clicking `apply` sets the
 * value locally so the operator can then Save (or edit further). Renders null when
 * there's nothing useful to suggest.
 */
export function TunerSuggestionChip({
  current,
  suggested,
  onApply,
  format = (v) => String(v),
  disabled,
  className,
}: TunerSuggestionChipProps) {
  if (suggested == null || !Number.isFinite(suggested) || suggested === current) {
    return null;
  }
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-info/20 bg-info/10 px-2 py-0.5 text-2xs text-info-text',
        className,
      )}
    >
      <Sparkles className="h-3 w-3" aria-hidden="true" />
      <span>
        Tuner suggests{' '}
        <span className="font-semibold tabular-nums">{format(suggested)}</span>
      </span>
      <button
        type="button"
        onClick={() => onApply(suggested)}
        disabled={disabled}
        aria-label={`Apply tuner suggestion ${format(suggested)}`}
        className={cn(
          'rounded-sm font-medium text-info-text underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-50',
          focusRing,
        )}
      >
        apply
      </button>
    </span>
  );
}

TunerSuggestionChip.displayName = 'TunerSuggestionChip';
