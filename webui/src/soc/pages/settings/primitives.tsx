/**
 * Settings shared form bits — the small building blocks every settings section
 * renderer composes (Round-5 Sett-A decomposition).
 *
 * These were previously private functions inside the 2673-line `Settings.tsx`
 * god-file; they are lifted here VERBATIM (same markup, same classes, same
 * behaviour) so every extracted `<section>.tsx` can share them without a circular
 * import back into the page. Sett-B may later migrate these onto the W0 `Field` /
 * `NumberField` primitives; for now this is a pure, behaviour-preserving move.
 *
 * Security: every value rendered here is operator-entered (trusted). No secrets are
 * displayed; secret rows render a `configured` boolean only.
 */
import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import { Check } from 'lucide-react';

import type { ModelConfig, ModelsResponse, Preferences } from '@/lib/types';
import { humanizeToken } from '@/lib/format';

import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Switch } from '@/ui/switch';
import { Badge } from '@/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';

import {
  SettingsTOC,
  type SettingsTOCItem,
} from '@/soc/components/SettingsGrid';

/** The `{ prefs, update }` contract every top-level settings section renderer takes. */
export type SecProps = {
  prefs: Preferences;
  update: (p: Partial<Preferences>) => void;
};

/** A navigation callback passed to sections that deep-link to other pages. */
export type NavigateFn = (page: unknown, opts?: unknown) => void;

export function errMsg(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

export function SectionTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="space-y-1 border-b border-border pb-4">
      <h2 className="text-lg font-semibold tracking-tight text-foreground">{title}</h2>
      {sub ? <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

/** A subsection heading used to group related controls inside one Settings section. */
export function SubHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}

/**
 * Track which anchored `SettingsCard` is currently in view, so the in-section TOC can
 * highlight it. Pure scroll-spy via IntersectionObserver; no-ops in non-DOM envs.
 */
export function useActiveAnchor(anchors: string[]): string {
  const [active, setActive] = React.useState<string>(anchors[0] ?? '');
  React.useEffect(() => {
    setActive((cur) => (anchors.includes(cur) ? cur : anchors[0] ?? ''));
    if (typeof document === 'undefined' || typeof IntersectionObserver === 'undefined') return;
    const visible = new Map<string, number>();
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.set(e.target.id, e.intersectionRatio);
          else visible.delete(e.target.id);
        }
        let best = '';
        let bestRatio = -1;
        for (const [id, ratio] of visible) {
          if (ratio > bestRatio) {
            best = id;
            bestRatio = ratio;
          }
        }
        if (best) setActive(best);
      },
      { rootMargin: '-96px 0px -55% 0px', threshold: [0, 0.25, 0.5, 1] },
    );
    const els = anchors
      .map((a) => document.getElementById(a))
      .filter((el): el is HTMLElement => Boolean(el));
    els.forEach((el) => obs.observe(el));
    return () => obs.disconnect();
    // anchors is a stable literal per section; join for a stable dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchors.join('|')]);
  return active;
}

/**
 * The shared wrapper for a multi-card Settings section: a section title and, for
 * long sections (≥ 2 TOC items), a sticky in-section anchor TOC that scroll-spies the
 * cards. The TOC sits as a thin sticky bar above the cards and uses the full width.
 */
export function SectionShell({
  title,
  sub,
  toc,
  children,
}: {
  title: string;
  sub?: string;
  toc?: SettingsTOCItem[];
  children: React.ReactNode;
}) {
  const anchors = React.useMemo(() => (toc ?? []).map((t) => t.anchor), [toc]);
  const active = useActiveAnchor(anchors);
  const showToc = (toc?.length ?? 0) >= 2;
  return (
    <div className="space-y-6">
      <SectionTitle title={title} sub={sub} />
      {showToc ? (
        <div className="sticky top-2 z-10 -mx-1 overflow-x-auto rounded-lg border border-border bg-card/90 px-1.5 py-1.5 backdrop-blur supports-[backdrop-filter]:bg-card/75">
          <SettingsTOC items={toc!} active={active} className="min-w-max flex-row gap-1" />
        </div>
      ) : null}
      {children}
    </div>
  );
}

export function TextPref({
  label,
  value,
  help,
  placeholder,
  onChange,
}: {
  label: string;
  value?: string;
  help?: string;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  const id = React.useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value ?? ''}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {help ? <p className="text-xs text-muted-foreground">{help}</p> : null}
    </div>
  );
}

export function NumPref({
  label,
  value,
  help,
  step,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string;
  value?: number;
  help?: string;
  step?: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  const id = React.useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        value={value ?? 0}
        step={step}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {help ? <p className="text-xs text-muted-foreground">{help}</p> : null}
    </div>
  );
}

export function SwitchPref({
  label,
  help,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  help?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border border-border bg-surface px-4 py-3 transition-colors hover:border-border/80">
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {help ? <p className="text-xs leading-relaxed text-muted-foreground">{help}</p> : null}
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-label={label}
      />
    </div>
  );
}

export function ModelPicker({
  role,
  models,
  value,
  onChange,
}: {
  role: string;
  models: ModelsResponse | null;
  value?: ModelConfig;
  onChange: (next: ModelConfig) => void;
}) {
  const options = React.useMemo(() => {
    const out: Array<{ value: string; label: string; provider: string }> = [];
    for (const [provider, list] of Object.entries(models?.providers || {})) {
      for (const m of list) out.push({ value: m, label: `${m} · ${provider}`, provider });
    }
    return out;
  }, [models]);

  const current = value?.model || '';
  // If the current model isn't in the option list, surface it as a standalone item
  // so the Select shows the real value rather than the placeholder.
  const hasCurrent = !current || options.some((o) => o.value === current);

  return (
    <div className="space-y-1.5">
      <Label>{humanizeToken(role)} model</Label>
      <Select
        value={current || undefined}
        onValueChange={(v) => {
          const sel = options.find((o) => o.value === v);
          onChange({
            provider: sel?.provider || value?.provider || 'anthropic',
            model: v,
            temperature: value?.temperature,
            max_tokens: value?.max_tokens,
          });
        }}
      >
        <SelectTrigger aria-label={`${humanizeToken(role)} model`}>
          <SelectValue placeholder="— select a model —" />
        </SelectTrigger>
        <SelectContent>
          {!hasCurrent ? (
            <SelectItem value={current}>{current}</SelectItem>
          ) : null}
          {options.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              No models available — add an LLM key.
            </div>
          ) : (
            options.map((o) => (
              <SelectItem key={`${o.provider}:${o.value}`} value={o.value}>
                {o.label}
              </SelectItem>
            ))
          )}
        </SelectContent>
      </Select>
    </div>
  );
}

export function SecretInput({
  label,
  secretKey,
  configured,
  value,
  help,
  onChange,
}: {
  label: string;
  secretKey: string;
  configured?: boolean;
  value: string;
  help?: string;
  onChange: (v: string) => void;
}) {
  const id = React.useId();
  void secretKey;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Label htmlFor={id}>{label}</Label>
        {configured ? (
          <Badge variant="success" className="gap-1">
            <Check className="h-3 w-3" aria-hidden />
            Configured
          </Badge>
        ) : (
          <Badge variant="outline" className="text-muted-foreground">
            Not set
          </Badge>
        )}
      </div>
      <Input
        id={id}
        type="password"
        autoComplete="new-password"
        placeholder={configured ? '•••••••• (enter a new value to replace)' : 'Enter a value'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {help ? <p className="text-xs text-muted-foreground">{help}</p> : null}
    </div>
  );
}

export function PostureTile({
  label,
  on,
  onText,
  offText,
}: {
  label: string;
  on: boolean;
  onText: string;
  offText: string;
}) {
  return (
    <div className="rounded-md border border-border bg-surface px-4 py-3">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="mt-1.5 flex items-center gap-2">
        <span
          className={cnDot(on)}
          aria-hidden
        />
        <span className="text-sm font-semibold text-foreground">{on ? onText : offText}</span>
      </div>
    </div>
  );
}

function cnDot(on: boolean): string {
  return on
    ? 'inline-block h-2 w-2 rounded-full bg-success'
    : 'inline-block h-2 w-2 rounded-full bg-muted-foreground/40';
}

export type { LucideIcon };
