/**
 * Cases (case-ID nomenclature) settings section (Round-5 Sett-A decomposition).
 *
 * Lifted verbatim from the former `Settings.tsx` `CaseIdSection`. A template editor +
 * placeholder helper + a LIVE PREVIEW (debounced POST /api/settings/case-id/preview).
 * `Case.case_id` stays the immutable internal id; this only governs the optional
 * `case_number` display id. The preview error text is from the backend validator
 * (controlled) but still rendered as plain text.
 */
import * as React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

import { api } from '@/lib/api';

import { Button } from '@/ui/button';
import { Badge } from '@/ui/badge';
import { Alert, AlertDescription } from '@/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';
import { Field } from '@/soc/components/Field';

import { SectionTitle, NumPref, SwitchPref, TextPref, type SecProps } from './primitives';

const RESET_PERIOD_OPTIONS: Array<{ value: string; text: string }> = [
  { value: 'none', text: 'Never reset (one continuous sequence)' },
  { value: 'calendar_year', text: 'Each calendar year' },
  { value: 'fiscal_year', text: 'Each fiscal year (April start)' },
  { value: 'fiscal_quarter', text: 'Each fiscal quarter' },
];

const CASE_ID_PLACEHOLDERS: Array<{ token: string; desc: string }> = [
  { token: '{prefix}', desc: 'The configured prefix' },
  { token: '{seq}', desc: 'The next sequence number' },
  { token: '{seq:06d}', desc: 'Zero-padded sequence (width 6)' },
  { token: '{year}', desc: '4-digit year' },
  { token: '{yy}', desc: '2-digit year' },
  { token: '{mm}', desc: '2-digit month' },
  { token: '{dd}', desc: '2-digit day' },
  { token: '{source}', desc: 'Originating source (slug)' },
  { token: '{verdict}', desc: 'LLM verdict (lower-case)' },
];

export function CaseIdSection({ prefs, update }: SecProps) {
  const cfg = prefs.case_id_format || {
    enabled: false,
    template: 'CASE-{seq:06d}',
    prefix: 'CASE',
    reset_period: 'none' as const,
    seq_start: 1,
  };
  const set = (patch: Partial<typeof cfg>) =>
    update({ case_id_format: { ...cfg, ...patch } });

  const [preview, setPreview] = React.useState<{
    samples: string[];
    valid: boolean;
    error?: string;
  } | null>(null);
  const [previewing, setPreviewing] = React.useState(false);

  // Debounced live preview whenever the template / prefix / seq_start change.
  React.useEffect(() => {
    let cancelled = false;
    setPreviewing(true);
    const t = setTimeout(() => {
      void api
        .caseIdPreview({
          template: cfg.template || '',
          prefix: cfg.prefix || 'CASE',
          seq_start: typeof cfg.seq_start === 'number' ? cfg.seq_start : 1,
        })
        .then((res) => {
          if (!cancelled) setPreview(res);
        })
        .catch(() => {
          if (!cancelled) setPreview({ samples: [], valid: false, error: 'preview failed' });
        })
        .finally(() => {
          if (!cancelled) setPreviewing(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [cfg.template, cfg.prefix, cfg.seq_start]);

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Case-ID format"
        sub="Customise the human-facing case number. The internal case id is unchanged; this only governs the displayed identifier on new cases."
      />

      <SwitchPref
        label="Use a custom case-number format"
        help="When off, the UI shows the internal case id. When on, new cases get a rendered display number."
        checked={Boolean(cfg.enabled)}
        onChange={(v) => set({ enabled: v })}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <TextPref
          label="Template"
          value={cfg.template}
          placeholder="CASE-{seq:06d}"
          help="Use the placeholders below. Unknown placeholders are rejected."
          onChange={(v) => set({ template: v })}
        />
        <TextPref
          label="Prefix"
          value={cfg.prefix}
          placeholder="CASE"
          onChange={(v) => set({ prefix: v })}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Reset period" description="Rolls a fresh sequence at each boundary.">
          {({ id, labelledBy, describedBy }) => (
            <Select
              value={cfg.reset_period || 'none'}
              onValueChange={(v) => set({ reset_period: v as typeof cfg.reset_period })}
            >
              <SelectTrigger id={id} aria-labelledby={labelledBy} aria-describedby={describedBy}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RESET_PERIOD_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.text}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Field>
        <NumPref
          label="Sequence start"
          value={cfg.seq_start}
          min={0}
          onChange={(v) => set({ seq_start: v })}
        />
      </div>

      {/* placeholder helper */}
      <fieldset className="space-y-2 border-t border-border/70 pt-4">
        <legend className="text-sm font-medium text-foreground">Placeholders</legend>
        <p className="text-xs text-muted-foreground">
          Append a supported token to the template.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {CASE_ID_PLACEHOLDERS.map((p) => (
            <Button
              key={p.token}
              type="button"
              variant="outline"
              size="sm"
              title={p.desc}
              className="h-7 font-mono text-xs font-normal text-muted-foreground hover:text-primary"
              onClick={() => set({ template: `${cfg.template || ''}${p.token}` })}
            >
              {p.token}
            </Button>
          ))}
        </div>
      </fieldset>

      {/* live preview */}
      <section className="border-y border-border/70 py-4" aria-labelledby="case-id-preview-title">
        <div className="flex items-center justify-between">
          <h3 id="case-id-preview-title" className="text-sm font-semibold text-foreground">
            Live preview
          </h3>
          {previewing ? (
            <span role="status" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden />
              Updating
            </span>
          ) : null}
        </div>
        {preview && !preview.valid ? (
          <Alert variant="destructive" className="mt-2 py-2">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="text-xs">
              {/* error text is from the backend validator — controlled, but render plain */}
              {preview.error || 'Invalid template.'}
            </AlertDescription>
          </Alert>
        ) : (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {(preview?.samples || []).map((s, i) => (
              <Badge key={`${s}-${i}`} variant="outline" className="font-mono">
                {s}
              </Badge>
            ))}
            {!preview?.samples?.length && !previewing ? (
              <span className="text-xs text-muted-foreground">No preview.</span>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}
