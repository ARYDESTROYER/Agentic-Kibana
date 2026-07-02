/**
 * EffectiveConfigPreview — a live, human-readable "effective config" summary for a
 * rule / threshold editor (G6 R4, RESEARCH_RULES_UX §5d, DESIGN_STANDARD §8).
 *
 * It restates the current draft values as a plain-English sentence that updates on
 * every keystroke, so an operator can read what a threshold change WILL do before
 * saving. It is presentation only: it NEVER calls `decide()`, never bills an LLM, and
 * carries no trust — every interpolated value renders as a plain React text node (#9).
 *
 * The `belowFloorNote` line is the NON-DESTRUCTIVE guarantee copy required by #4: a
 * `severity_floor` blocks auto-forward but NEVER drops the candidate — a prettier
 * control must not imply data loss. Consumers that show a severity floor MUST render
 * this note (default on).
 */
import * as React from 'react';
import { Eye } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface EffectiveConfigLine {
  /** A short label for the knob (plain text). */
  label: string;
  /** The current effective value, already formatted (plain text / node). */
  value: React.ReactNode;
}

export interface EffectiveConfigPreviewProps {
  /** The human summary sentence (plain text / node). */
  summary: React.ReactNode;
  /** Optional label→value pairs shown as a compact grid under the summary. */
  lines?: EffectiveConfigLine[];
  /**
   * Show the #4 non-destructive note ("below floor: candidate only — never
   * dropped"). Default true — always show it when a severity floor is in play.
   */
  belowFloorNote?: boolean;
  /** Override the note text (kept for future reuse). */
  noteText?: React.ReactNode;
  className?: string;
}

const DEFAULT_NOTE =
  'Below the floor: candidate only — never dropped. A severity floor blocks auto-forward, but the candidate is still recorded for review (#4).';

/**
 * A calm, muted preview panel. Not a form control — read-only presentation of the
 * live draft. Rendered inside a rule/threshold editor card.
 */
export function EffectiveConfigPreview({
  summary,
  lines,
  belowFloorNote = true,
  noteText,
  className,
}: EffectiveConfigPreviewProps) {
  return (
    <div
      className={cn(
        'rounded-md border border-border bg-surface-sunken px-3 py-2.5 text-sm',
        className,
      )}
      // Passive presentation — NOT a live region. Wrapping the whole panel in
      // role="status"/aria-live re-announced the full summary + value grid + note on
      // every slider/number-field keystroke (unusable verbosity). The summary is a
      // restatement of controls that carry their own labels/values, so it is readable
      // on navigation without being re-read on each edit.
    >
      <div className="flex items-start gap-2">
        <Eye className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 space-y-1.5">
          <p className="font-medium leading-snug text-foreground">{summary}</p>
          {lines && lines.length ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
              {lines.map((l, i) => (
                <React.Fragment key={`${l.label}-${i}`}>
                  <dt className="text-muted-foreground">{l.label}</dt>
                  <dd className="tabular-nums text-foreground">{l.value}</dd>
                </React.Fragment>
              ))}
            </dl>
          ) : null}
          {belowFloorNote ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {noteText ?? DEFAULT_NOTE}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

EffectiveConfigPreview.displayName = 'EffectiveConfigPreview';
