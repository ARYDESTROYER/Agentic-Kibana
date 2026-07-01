/**
 * Advanced (all settings) — the schema-driven generic renderer (Round-5 Sett-C / G3 §4).
 *
 * The backend ships a best-effort SCHEMA reflector at `GET /api/settings/schema` that
 * describes every `Preferences` field (type + default + enum choices + element models).
 * Historically it had ZERO consumers, so any engine knob NOT hand-coded into a curated
 * section was uneditable. This renderer wires that endpoint into a generic form so the
 * LONG TAIL of settings is editable-by-default (the structural fix for the "add config +
 * endpoint, forget the form" coupling failure).
 *
 * Contract & safety:
 *   - It writes through the SAME `{prefs, update}` buffer as every curated section, so
 *     Save still sends only the CHANGED top-level keys via the deep-merge `PUT /api/settings`
 *     (a sibling block is never wiped). It never full-doc-replaces.
 *   - It edits SCALARS (bool/int/number/string/enum) generically. Nested objects and
 *     collections (list/dict, incl. element-model rule collections) are DESCRIBED read-only
 *     with a pointer to their dedicated curated section — editing structured rule shapes
 *     generically is unsafe (#3-adjacent) and the curated editors own that.
 *   - Two knobs are SPECIAL-CASED (never generically editable): `demo` (managed only via
 *     the `/api/demo/*` endpoints — a settings PUT can't flip it) and `read_only_settings_mode`
 *     (a console can't self-lock through the generic form; unlock lives in Advanced › lock).
 *   - Every rendered label/description is operator-authored (trusted); no secret VALUE is
 *     ever shown — the schema carries defaults + field names only (#10).
 */
import * as React from 'react';
import { AlertTriangle, Info, Lock, RefreshCw, Search, SlidersHorizontal } from 'lucide-react';

import { api } from '@/lib/api';
import type {
  Preferences,
  SettingsSchema,
  SettingsSchemaField,
  SettingsSchemaSection,
} from '@/lib/types';
import { humanizeToken } from '@/lib/format';

import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Switch } from '@/ui/switch';
import { Badge } from '@/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Skeleton } from '@/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';
import { SettingsGrid, SettingsCard } from '@/soc/components/SettingsGrid';

import { SectionShell, type SecProps } from './primitives';

/** Top-level keys that get a dedicated curated section — hidden from the generic long tail
 * so the same knob isn't editable in two places (the curated editor is authoritative). */
const CURATED_SECTIONS: ReadonlySet<string> = new Set([
  // The generic renderer is the LONG TAIL — anything with a rich curated home is excluded.
  // (Kept intentionally small: only the blocks whose generic editing would be redundant or
  // unsafe. `general`/scalars still show so newly-added knobs surface by default.)
  'auto_close',
  'fp_auto_close',
  'notifications',
  'branding',
  'sso',
  'mfa',
  'rbac',
  'threshold_automation',
  'case_id_format',
]);

/** Field names that are NEVER generically editable (special-cased, managed elsewhere). */
const SPECIAL_CASE_KEYS: ReadonlySet<string> = new Set(['demo', 'read_only_settings_mode']);

/**
 * Section keys that are entirely READ-ONLY here (managed by a dedicated endpoint, not the
 * settings PUT path). `demo` is a nested-model SECTION whose sub-fields (`mode`/`seed`/…)
 * are managed ONLY via `/api/demo/*` — the settings PUT preserves the live demo block, so
 * editing them here would be silently discarded. It renders one explanatory note instead.
 */
const READ_ONLY_SECTIONS: ReadonlySet<string> = new Set(['demo']);

/**
 * Default-OFF engine features (Round-4 blocks) that get the DISCLOSURE TREATMENT: a
 * prominent head-of-section enable toggle, with the rest of the block's controls disclosed
 * only once enabled. (`RESEARCH_SETTINGS_IA §3.4` — two tiers only.)
 */
const ENGINE_FEATURE_KEYS: ReadonlySet<string> = new Set([
  'threshold_tuning',
  'batch',
  'baseline',
  'campaign',
  'event_detection',
]);

/** A scalar type this generic form can edit inline. */
function isEditableScalar(f: SettingsSchemaField): boolean {
  return (
    (f.type === 'boolean' ||
      f.type === 'integer' ||
      f.type === 'number' ||
      f.type === 'string' ||
      f.type === 'enum') &&
    !SPECIAL_CASE_KEYS.has(f.name)
  );
}

/** True when a field is a nested object / collection (described, not edited here). */
function isStructured(f: SettingsSchemaField): boolean {
  return f.type === 'object' || f.type === 'array' || f.type === 'union' || Boolean(f.element);
}

/* -------------------------------------------------------- generic controls -- */

function BoolField({
  field,
  value,
  onChange,
}: {
  field: SettingsSchemaField;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  const label = humanizeToken(field.name);
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border border-border bg-surface px-4 py-3">
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {field.description ? (
          <p className="text-xs leading-relaxed text-muted-foreground">{field.description}</p>
        ) : null}
      </div>
      <Switch checked={!!value} onCheckedChange={onChange} aria-label={label} />
    </div>
  );
}

function ScalarField({
  field,
  value,
  onChange,
}: {
  field: SettingsSchemaField;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const id = React.useId();
  const label = humanizeToken(field.name);
  const numeric = field.type === 'integer' || field.type === 'number';
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {field.type === 'enum' && field.choices ? (
        <Select
          value={value == null ? undefined : String(value)}
          onValueChange={(v) => onChange(v)}
        >
          <SelectTrigger id={id} aria-label={label}>
            <SelectValue placeholder="— select —" />
          </SelectTrigger>
          <SelectContent>
            {field.choices.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          id={id}
          type={numeric ? 'number' : 'text'}
          step={field.type === 'integer' ? 1 : 'any'}
          value={value == null ? '' : String(value)}
          onChange={(e) => {
            const raw = e.target.value;
            if (numeric) {
              onChange(raw === '' ? null : Number(raw));
            } else {
              onChange(raw);
            }
          }}
        />
      )}
      {field.description ? (
        <p className="text-xs text-muted-foreground">{field.description}</p>
      ) : null}
    </div>
  );
}

/** A read-only descriptor for a structured (object/collection) field. */
function StructuredFieldNote({ field }: { field: SettingsSchemaField }) {
  const label = humanizeToken(field.name);
  const elem = field.element;
  return (
    <div className="rounded-md border border-dashed border-border bg-surface-sunken px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <Badge variant="outline" className="text-2xs uppercase tracking-wide text-muted-foreground">
          {elem ? `${elem.container} of ${elem.model}` : field.type}
        </Badge>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        {field.description
          ? field.description
          : elem
            ? `A ${elem.container} of ${humanizeToken(elem.model)} entries — edit in its dedicated section.`
            : 'A structured setting — edit in its dedicated section.'}
      </p>
    </div>
  );
}

/* --------------------------------------------------------------- section --- */

/**
 * Given a schema section, split its fields into (editable scalars, structured notes) and
 * render a card. Special-cased keys render an explanatory, non-editable note.
 */
function SchemaSectionCard({
  section,
  prefs,
  update,
}: {
  section: SettingsSchemaSection;
  prefs: Preferences;
  update: (p: Partial<Preferences>) => void;
}) {
  const prefsRec = prefs as unknown as Record<string, unknown>;

  // A whole read-only SECTION (e.g. `demo`) is managed by a dedicated endpoint — render one
  // explanatory note, never editable controls (a settings PUT can't change it).
  if (READ_ONLY_SECTIONS.has(section.key)) {
    return (
      <SettingsCard
        anchor={`schema-${section.key}`}
        title={section.title || humanizeToken(section.key)}
        icon={Lock}
        wide
      >
        <Alert variant="default">
          <Lock className="h-4 w-4" aria-hidden />
          <AlertTitle>{section.title || humanizeToken(section.key)}</AlertTitle>
          <AlertDescription>
            Demo mode is managed from Organization › Experimental &amp; Demo (and the
            <code className="mx-1 rounded bg-surface-sunken px-1 py-0.5 text-2xs">/api/demo</code>
            endpoints), not here — a settings save can never flip it.
          </AlertDescription>
        </Alert>
      </SettingsCard>
    );
  }

  // For a `group` (scalar top-level) section, each field IS a top-level pref key. For an
  // `object` (nested-model) section, the whole block is one top-level key; we edit its
  // sub-fields and PATCH the merged block back (deep-merge-safe: only that block changes).
  const isGroup = section.kind === 'group';
  const blockValue = isGroup ? undefined : (prefsRec[section.key] as Record<string, unknown> | undefined);

  // Plain closures (NOT hooks) so the read-only-section early return above can stay above
  // them without violating Rules-of-Hooks; they capture the current block value each render.
  const setTopLevel = (key: string, v: unknown) => update({ [key]: v } as Partial<Preferences>);
  const setNested = (fieldName: string, v: unknown) =>
    update({
      [section.key]: { ...(blockValue ?? {}), [fieldName]: v },
    } as Partial<Preferences>);

  // Disclosure tier: a default-OFF engine feature (object block with an `enabled` bool)
  // gets a head-of-section enable toggle; the rest of its controls disclose only once on.
  const enabledField = !isGroup ? section.fields.find((f) => f.name === 'enabled' && f.type === 'boolean') : undefined;
  const isEngineFeature = !isGroup && ENGINE_FEATURE_KEYS.has(section.key) && Boolean(enabledField);
  const featureOn = isEngineFeature ? Boolean(blockValue?.enabled) : true;

  // The `enabled` field is rendered as the head toggle, not as a body control.
  const bodyFields = isEngineFeature ? section.fields.filter((f) => f.name !== 'enabled') : section.fields;

  const editable = bodyFields.filter(isEditableScalar);
  const structured = bodyFields.filter((f) => !isEditableScalar(f) && isStructured(f));
  const special = bodyFields.filter((f) => SPECIAL_CASE_KEYS.has(f.name));

  // Nothing worth showing? (all special/structured with no editable) — still render the
  // notes so the operator sees the knob exists. Engine features always render (the toggle).
  const anything = editable.length + structured.length + special.length > 0;
  if (!anything && !isEngineFeature) return null;

  return (
    <SettingsCard
      anchor={`schema-${section.key}`}
      title={section.title || humanizeToken(section.key)}
      icon={SlidersHorizontal}
      description={
        isEngineFeature
          ? 'Off by default. Enable to reveal its controls.'
          : isGroup
            ? 'Top-level preferences that have no dedicated section yet.'
            : section.model
              ? `The ${section.model} block.`
              : undefined
      }
      actions={
        isEngineFeature ? (
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              {featureOn ? 'Enabled' : 'Disabled'}
            </span>
            <Switch
              checked={featureOn}
              onCheckedChange={(v) => setNested('enabled', v)}
              aria-label={`Enable ${section.title || humanizeToken(section.key)}`}
            />
          </div>
        ) : undefined
      }
      wide
    >
      <div className="space-y-4">
        {/* Engine-feature body is disclosed only when the feature is enabled. */}
        {isEngineFeature && !featureOn ? (
          <p className="text-xs text-muted-foreground">
            This engine feature is off. Toggle it on to configure its settings.
          </p>
        ) : null}

        {(!isEngineFeature || featureOn) && editable.length > 0 ? (
          <div className="grid gap-4 sm:grid-cols-2">
            {editable.map((f) => {
              const cur = isGroup ? prefsRec[f.name] : blockValue?.[f.name];
              const setter = isGroup
                ? (v: unknown) => setTopLevel(f.name, v)
                : (v: unknown) => setNested(f.name, v);
              return f.type === 'boolean' ? (
                <BoolField key={f.name} field={f} value={!!cur} onChange={(v) => setter(v)} />
              ) : (
                <ScalarField key={f.name} field={f} value={cur} onChange={setter} />
              );
            })}
          </div>
        ) : null}

        {special.length > 0 ? (
          <div className="space-y-2">
            {special.map((f) => (
              <Alert key={f.name} variant="default">
                <Lock className="h-4 w-4" aria-hidden />
                <AlertTitle>{humanizeToken(f.name)}</AlertTitle>
                <AlertDescription>
                  {f.name === 'demo'
                    ? 'Demo mode is managed from Organization › Experimental & Demo (and the /api/demo endpoints), not here — a settings save can never flip it.'
                    : 'The settings read-only lock is managed from Organization › Advanced › Settings lock. It cannot be self-locked through the generic editor.'}
                </AlertDescription>
              </Alert>
            ))}
          </div>
        ) : null}

        {(!isEngineFeature || featureOn) && structured.length > 0 ? (
          <div className="space-y-2">
            {structured.map((f) => (
              <StructuredFieldNote key={f.name} field={f} />
            ))}
          </div>
        ) : null}
      </div>
    </SettingsCard>
  );
}

/* ------------------------------------------------------------- the section - */

/**
 * The "Advanced (all settings)" section body. Fetches the schema once, renders a card per
 * schema section (curated blocks with their own home are hidden), and edits scalar knobs
 * through the shared `{prefs, update}` buffer. A search box filters to the matching fields.
 */
export function AdvancedSchemaSection({ prefs, update }: SecProps) {
  const [schema, setSchema] = React.useState<SettingsSchema | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [q, setQ] = React.useState('');

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getSettingsSchema();
      setSchema(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the settings schema.');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Sections to show: drop curated-home blocks; keep the synthetic `general` group + the
  // long tail. Filter fields by the query (label / name / description).
  const term = q.trim().toLowerCase();
  const sections = React.useMemo(() => {
    if (!schema) return [];
    const matchField = (f: SettingsSchemaField) =>
      !term ||
      [f.name, humanizeToken(f.name), f.description ?? '', ...(f.choices ?? [])]
        .join(' ')
        .toLowerCase()
        .includes(term);
    return schema.sections
      .filter((s) => !CURATED_SECTIONS.has(s.key))
      .map((s) => ({ ...s, fields: s.fields.filter(matchField) }))
      .filter((s) => s.fields.length > 0);
  }, [schema, term]);

  return (
    <SectionShell
      title="Advanced (all settings)"
      sub="Every preference the engine reads, rendered directly from the backend schema — including knobs without a dedicated section yet. Scalars edit inline and save through the same deep-merge as the rest of Settings; structured rule collections point to their curated editors. Managed knobs (demo mode, the settings lock) are read-only here."
    >
      <div className="space-y-4">
        <div className="relative max-w-md">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter all settings…"
            aria-label="Filter all settings"
            className="h-9 pl-8"
          />
        </div>

        {loading ? (
          <SettingsGrid>
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-40 w-full rounded-lg lg:col-span-2" />
            ))}
          </SettingsGrid>
        ) : error ? (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" aria-hidden />
            <AlertTitle>Could not load the settings schema</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-3">
              <span>{error}</span>
              <button
                type="button"
                onClick={() => void load()}
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                Retry
              </button>
            </AlertDescription>
          </Alert>
        ) : sections.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-surface-sunken px-4 py-6 text-center text-sm text-muted-foreground">
            <Info className="mx-auto mb-2 h-5 w-5" aria-hidden />
            {term ? `No settings match “${q}”.` : 'No additional settings to show.'}
          </div>
        ) : (
          <SettingsGrid>
            {sections.map((s) => (
              <SchemaSectionCard key={s.key} section={s} prefs={prefs} update={update} />
            ))}
          </SettingsGrid>
        )}
      </div>
    </SectionShell>
  );
}

export default AdvancedSchemaSection;
