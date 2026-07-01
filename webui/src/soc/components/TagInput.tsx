/**
 * TagInput — chip entry for tags / rule allowlists / IOC lists (DESIGN_STANDARD
 * §5.2). Type a value + Enter (or comma) to add a chip; Backspace on an empty
 * field removes the last chip; each chip has a ≥24px remove target (IconButton).
 *
 * Contract:
 *  - controlled `value: string[]` + `onChange(next)`.
 *  - de-dupes (case-insensitive by default) and trims; empties are ignored.
 *  - `validate(tag)` may reject a tag (return an error string) — shown inline and
 *    the tag is NOT added.
 *  - `max` caps the number of chips; the input is disabled at the cap.
 *  - a11y: the field is a `Field`-labelled input; chips are a `role="list"`; each
 *    remove button is labelled "Remove {tag}". Values render as plain text (#9).
 */
import * as React from 'react';
import { X } from 'lucide-react';
import { Field } from './Field';
import { IconButton } from './IconButton';
import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';

export interface TagInputProps {
  /** Visible label. */
  label: React.ReactNode;
  /** Optional helper text. */
  description?: React.ReactNode;
  /** Controlled tag list. */
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  /** Case-insensitive de-dupe. Default true. */
  dedupe?: boolean;
  /** Max chips. */
  max?: number;
  /** Reject a candidate tag; return an error message to block it. */
  validate?: (tag: string) => string | null | undefined;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  /** Keys (besides Enter) that commit the current text. Default [',']. */
  delimiters?: string[];
}

export const TagInput = React.forwardRef<HTMLInputElement, TagInputProps>(
  (
    {
      label,
      description,
      value,
      onChange,
      placeholder,
      dedupe = true,
      max,
      validate,
      required,
      disabled,
      className,
      delimiters = [','],
    },
    ref,
  ) => {
    const [text, setText] = React.useState('');
    const [error, setError] = React.useState<string | null>(null);

    const atMax = max != null && value.length >= max;

    const add = (raw: string) => {
      const tag = raw.trim();
      if (!tag) return;
      if (atMax) return;
      if (dedupe && value.some((v) => v.toLowerCase() === tag.toLowerCase())) {
        setText('');
        return;
      }
      const err = validate?.(tag);
      if (err) {
        setError(err);
        return;
      }
      setError(null);
      onChange([...value, tag]);
      setText('');
    };

    const removeAt = (i: number) => onChange(value.filter((_, idx) => idx !== i));

    return (
      <Field label={label} description={description} error={error ?? undefined} required={required} className={className}>
        {({ id, describedBy, invalid }) => (
          <div
            className={cn(
              'flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-md border bg-background px-2 py-1.5 transition-colors',
              error ? 'border-critical' : 'border-input focus-within:border-ring hover:border-border',
              disabled && 'cursor-not-allowed opacity-50',
            )}
          >
            <ul role="list" className="contents">
              {value.map((tag, i) => (
                <li
                  key={`${tag}-${i}`}
                  className="inline-flex items-center gap-1 rounded-r-sm bg-muted px-1.5 py-0.5 text-xs text-foreground"
                >
                  <span>{tag}</span>
                  <IconButton
                    label={`Remove ${tag}`}
                    size="sm"
                    tooltip={false}
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => removeAt(i)}
                    className="h-4 w-4 [&_svg]:size-3"
                  >
                    <X />
                  </IconButton>
                </li>
              ))}
            </ul>
            <input
              ref={ref}
              id={id}
              type="text"
              value={text}
              disabled={disabled || atMax}
              placeholder={atMax ? undefined : placeholder}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              onChange={(e) => {
                setError(null);
                setText(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || delimiters.includes(e.key)) {
                  e.preventDefault();
                  add(text);
                } else if (e.key === 'Backspace' && text === '' && value.length) {
                  removeAt(value.length - 1);
                }
              }}
              onBlur={() => add(text)}
              className={cn('h-6 min-w-[6rem] flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground', focusRing)}
            />
          </div>
        )}
      </Field>
    );
  },
);
TagInput.displayName = 'TagInput';
