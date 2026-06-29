/**
 * SourceEditor (new UI) — pick a connector, fill its DYNAMIC manifest-driven
 * form, configure advanced triage behaviour (N index patterns + roles, entity
 * strategy, message field), test the saved connection, and save. The reusable
 * unit behind the Sources manager's add/edit flow.
 *
 * Field rendering is driven entirely by the backend manifest's `auth_fields` +
 * `config_fields` so any connector can be configured with zero per-connector UI.
 * Secrets (password fields) are write-only — never echoed; shown as `configured`.
 *
 * Security: all values typed here are operator input; nothing rendered from the
 * backend is interpolated as markup. The test-result message is shown as plain
 * text.
 */
import * as React from 'react';
import {
  ArrowLeft,
  Plus,
  Trash2,
  Beaker,
  Save,
  CheckCircle2,
  AlertTriangle,
  FileUp,
  Loader2,
  BookOpen,
  Sparkles,
  SlidersHorizontal,
} from 'lucide-react';
import type {
  AuthField,
  ConnectorManifest,
  EntityStrategy,
  FieldMappingsExtra,
  IndexPattern,
  SourceConfigExtras,
  SourceInstance,
} from '@/lib/types';
import { api, ApiError } from '@/lib/api';
import { saveSource, slugify } from '@/lib/connectors';
import { cn } from '@/lib/cn';

import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Textarea } from '@/ui/textarea';
import { Label } from '@/ui/label';
import { Switch } from '@/ui/switch';
import { Separator } from '@/ui/separator';
import { Alert, AlertTitle, AlertDescription } from '@/ui/alert';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/ui/select';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/ui/tooltip';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/ui/accordion';

import { ConnectorPicker } from '@/soc/components/ConnectorPicker';
import { EmptyState } from '@/soc/components/EmptyState';
import { HelpTip, ConnectorFieldHelp } from '@/soc/components/HelpTip';

/** Best-effort human message from an unknown thrown value. */
function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message || 'Something went wrong.';
  return 'Something went wrong.';
}

// --------------------------------------------------------------------------- //
// The form value shape the lib/connectors saveSource() consumes.
// --------------------------------------------------------------------------- //
interface ConnectorFormValue {
  config: Record<string, unknown>;
  secrets: Record<string, string>;
}

/** Roles a pattern can carry (matches the backend's canonical IndexPattern.role). */
const ROLE_OPTIONS: Array<{ value: IndexPattern['role']; text: string }> = [
  { value: 'events', text: 'Events — correlate, then triage' },
  { value: 'alerts', text: 'Alerts — investigate every match' },
];

/** Entity-strategy choices (matches the backend's canonical EntityStrategy). */
const ENTITY_OPTIONS: Array<{ value: EntityStrategy; text: string }> = [
  { value: 'auto', text: 'Auto (IP → host → user → rule)' },
  { value: 'ip', text: 'Source IP' },
  { value: 'host', text: 'Host' },
  { value: 'user', text: 'User' },
  { value: 'rule', text: 'Rule' },
];

const CERT_ACCEPT = '.pem,.crt,.cer,.txt';

/* ----------------------------------------------------------- field helpers - */

function allFields(manifest: ConnectorManifest): AuthField[] {
  return [...(manifest.auth_fields || []), ...(manifest.config_fields || [])];
}

/** Group fields by their `group`, preserving first-seen group order. */
function groupFields(fields: AuthField[]): Array<[string, AuthField[]]> {
  const order: string[] = [];
  const map = new Map<string, AuthField[]>();
  for (const f of fields) {
    const g = f.group || 'Settings';
    if (!map.has(g)) {
      map.set(g, []);
      order.push(g);
    }
    map.get(g)!.push(f);
  }
  return order.map((g) => [g, map.get(g)!]);
}

/** Whether a required field is currently unsatisfied (for validation). */
function missingRequired(
  manifest: ConnectorManifest,
  value: ConnectorFormValue,
  configuredSecrets: string[] = [],
): AuthField[] {
  return allFields(manifest).filter((f) => {
    if (!f.required) return false;
    if (f.secret) {
      return !value.secrets[f.key] && !configuredSecrets.includes(f.key);
    }
    const v = value.config[f.key];
    return v === undefined || v === null || v === '';
  });
}

/** True when a textarea field carries a certificate / PEM blob. */
function isCertField(f: AuthField): boolean {
  const fmt = (f as { format?: string }).format;
  if (fmt === 'pem' || fmt === 'certificate' || fmt === 'cert') return true;
  const k = (f.key || '').toLowerCase();
  return k.includes('ca_cert') || k.includes('cert') || k.endsWith('_pem') || k.includes('pem');
}

function splitPatterns(s: unknown): string[] {
  if (typeof s !== 'string') return [];
  return s
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Derive editable index-pattern rows from a source config (migrates legacy single). */
function deriveIndexPatterns(cfg: Record<string, unknown>): IndexPattern[] {
  const existing = cfg.index_patterns;
  if (Array.isArray(existing) && existing.length) {
    return existing
      .filter((p): p is IndexPattern => !!p && typeof (p as IndexPattern).pattern === 'string')
      .map((p) => ({
        pattern: String(p.pattern),
        role: p.role === 'alerts' ? 'alerts' : 'events',
        // Per-pattern Auto-Correlate (F6); absent → TRUE (back-compat).
        auto_correlate: p.auto_correlate !== false,
      }));
  }
  const fromSingle = splitPatterns(cfg.data_view_pattern).map(
    (pattern): IndexPattern => ({ pattern, role: 'events', auto_correlate: true }),
  );
  return fromSingle.length ? fromSingle : [{ pattern: '', role: 'events', auto_correlate: true }];
}

/* ------------------------------------------------------------- cert picker - */

const CertFilePicker: React.FC<{ id: string; onText: (text: string) => void }> = ({
  id,
  onText,
}) => {
  const [err, setErr] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const onPick = (files: FileList | null) => {
    setErr(null);
    const file = files && files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => onText(String(reader.result || '').trim());
    reader.onerror = () => setErr('Could not read the certificate file.');
    reader.readAsText(file);
  };

  return (
    <div className="space-y-1">
      <input
        ref={inputRef}
        id={`${id}-file`}
        type="file"
        accept={CERT_ACCEPT}
        className="hidden"
        onChange={(e) => onPick(e.target.files)}
        aria-label="Upload a certificate or PEM file"
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => inputRef.current?.click()}
      >
        <FileUp className="h-4 w-4" aria-hidden /> Select a .pem / .crt file…
      </Button>
      <p className="text-xs text-muted-foreground">
        …or paste the certificate above. The file is read locally and only its text
        content is captured.
      </p>
      {err ? <p className="text-xs text-critical">{err}</p> : null}
    </div>
  );
};

/* ----------------------------------------------------------- dynamic field - */

const RequiredMark = () => <span className="text-critical"> *</span>;

const FieldRow: React.FC<{
  field: AuthField;
  manifest: ConnectorManifest;
  value: ConnectorFormValue;
  configuredSecrets: string[];
  showValidation: boolean;
  setConfig: (key: string, v: unknown) => void;
  setSecret: (key: string, v: string) => void;
}> = ({ field: f, manifest, value, configuredSecrets, showValidation, setConfig, setSecret }) => {
  const id = `cf-${manifest.source_type}-${f.key}`;
  const invalid =
    showValidation &&
    !!f.required &&
    (f.secret
      ? !value.secrets[f.key] && !configuredSecrets.includes(f.key)
      : value.config[f.key] === undefined ||
        value.config[f.key] === null ||
        value.config[f.key] === '');

  const help = f.help ? <p className="text-xs text-muted-foreground">{f.help}</p> : null;

  // bool → switch (inline)
  if (f.type === 'bool') {
    const checked =
      value.config[f.key] === undefined ? Boolean(f.default) : Boolean(value.config[f.key]);
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <Switch
            id={id}
            checked={checked}
            onCheckedChange={(c) => setConfig(f.key, c)}
            aria-label={f.label}
          />
          <Label htmlFor={id} className="cursor-pointer">
            {f.label}
            {f.required ? <RequiredMark /> : null}
          </Label>
          <ConnectorFieldHelp field={f} />
        </div>
        {help}
      </div>
    );
  }

  let control: React.ReactNode;
  switch (f.type) {
    case 'password':
      control = (
        <Input
          id={id}
          type="password"
          autoComplete="off"
          placeholder={
            configuredSecrets.includes(f.key) ? 'configured — type to replace' : f.placeholder || ''
          }
          value={value.secrets[f.key] || ''}
          onChange={(e) => setSecret(f.key, e.target.value)}
          aria-invalid={invalid}
          className={cn(invalid && 'border-critical')}
        />
      );
      break;
    case 'number':
      control = (
        <Input
          id={id}
          type="number"
          placeholder={f.placeholder || ''}
          value={
            value.config[f.key] === undefined || value.config[f.key] === null
              ? f.default !== undefined && f.default !== null
                ? String(f.default)
                : ''
              : String(value.config[f.key])
          }
          onChange={(e) =>
            setConfig(f.key, e.target.value === '' ? '' : Number(e.target.value))
          }
          aria-invalid={invalid}
          className={cn(invalid && 'border-critical')}
        />
      );
      break;
    case 'textarea': {
      const textarea = (
        <Textarea
          id={id}
          placeholder={f.placeholder || ''}
          value={String(value.config[f.key] ?? f.default ?? '')}
          onChange={(e) => setConfig(f.key, e.target.value)}
          aria-invalid={invalid}
          className={cn('min-h-[7rem] font-mono text-xs', invalid && 'border-critical')}
        />
      );
      control = isCertField(f) ? (
        <div className="space-y-2">
          {textarea}
          <CertFilePicker id={id} onText={(text) => setConfig(f.key, text)} />
        </div>
      ) : (
        textarea
      );
      break;
    }
    case 'select': {
      const current = String(value.config[f.key] ?? f.default ?? '');
      control = (
        <Select
          value={current || undefined}
          onValueChange={(v) => setConfig(f.key, v)}
        >
          <SelectTrigger id={id} aria-invalid={invalid} className={cn(invalid && 'border-critical')}>
            <SelectValue placeholder="— select —" />
          </SelectTrigger>
          <SelectContent>
            {(f.options || []).map((o) => (
              <SelectItem key={o} value={o}>
                {o}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
      break;
    }
    case 'multiselect': {
      // Render as a comma-joined text input fallback (the new UI keeps it simple;
      // values round-trip as an array). Each token is trimmed.
      const selected = Array.isArray(value.config[f.key])
        ? (value.config[f.key] as string[])
        : Array.isArray(f.default)
          ? (f.default as string[])
          : [];
      control = (
        <Input
          id={id}
          placeholder={f.placeholder || 'comma-separated values'}
          value={selected.join(', ')}
          onChange={(e) =>
            setConfig(
              f.key,
              e.target.value
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            )
          }
          aria-invalid={invalid}
          className={cn(invalid && 'border-critical')}
        />
      );
      break;
    }
    default:
      control = (
        <Input
          id={id}
          placeholder={f.placeholder || ''}
          value={String(value.config[f.key] ?? f.default ?? '')}
          onChange={(e) => setConfig(f.key, e.target.value)}
          aria-invalid={invalid}
          className={cn(invalid && 'border-critical')}
        />
      );
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="flex items-center gap-1.5">
        <span>
          {f.label}
          {f.required ? <RequiredMark /> : null}
        </span>
        <ConnectorFieldHelp field={f} />
        {f.secret && configuredSecrets.includes(f.key) ? (
          <span className="inline-flex items-center gap-1 text-xs text-success">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> configured
          </span>
        ) : null}
      </Label>
      {control}
      {f.secret ? (
        <p className="text-xs text-muted-foreground">
          {f.help ? `${f.help} ` : ''}Stored in the secret store; only ever shown as configured.
        </p>
      ) : (
        help
      )}
      {invalid ? <p className="text-xs text-critical">{f.label} is required.</p> : null}
    </div>
  );
};

/* --------------------------------------------------------- patterns editor - */

const IndexPatternsEditor: React.FC<{
  rows: IndexPattern[];
  onChange: (rows: IndexPattern[]) => void;
}> = ({ rows, onChange }) => {
  const setRow = (i: number, patch: Partial<IndexPattern>) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addRow = () => onChange([...rows, { pattern: '', role: 'events', auto_correlate: true }]);
  const removeRow = (i: number) =>
    onChange(
      rows.length > 1
        ? rows.filter((_, idx) => idx !== i)
        : [{ pattern: '', role: 'events', auto_correlate: true }],
    );

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        The index / data-view patterns this source reads. <strong>Alerts</strong> patterns:
        every matching event is investigated. <strong>Events</strong> patterns: correlated,
        then triaged. Add as many as you need.
      </p>
      {rows.map((row, i) => (
        <div
          key={i}
          className="space-y-2 rounded-md border border-border bg-surface/50 p-3"
        >
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1 space-y-1.5">
              {i === 0 ? <Label htmlFor={`ip-${i}`}>Index / data-view pattern</Label> : null}
              <Input
                id={`ip-${i}`}
                placeholder="e.g. all-logs-* or wazuh-alerts-*"
                value={row.pattern}
                onChange={(e) => setRow(i, { pattern: e.target.value })}
                aria-label={`Index pattern ${i + 1}`}
              />
            </div>
            <div className="space-y-1.5 sm:w-[16rem]">
              {i === 0 ? <Label>Role</Label> : null}
              <Select
                value={row.role}
                onValueChange={(v) => setRow(i, { role: v as IndexPattern['role'] })}
              >
                <SelectTrigger aria-label={`Role for pattern ${i + 1}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.text}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="text-critical"
              aria-label={`Remove pattern ${i + 1}`}
              onClick={() => removeRow(i)}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
            </Button>
          </div>
          {/* Per-pattern (sub-source) Auto-Correlate toggle (F6). */}
          <div className="flex items-center gap-2 pt-0.5">
            <Switch
              id={`ip-ac-${i}`}
              checked={row.auto_correlate !== false}
              onCheckedChange={(c) => setRow(i, { auto_correlate: c })}
              aria-label={`Auto-Correlate for pattern ${i + 1}`}
            />
            <Label htmlFor={`ip-ac-${i}`} className="cursor-pointer text-xs">
              Auto-Correlate
            </Label>
            <HelpTip
              label="About per-pattern Auto-Correlate"
              text="When on (default), clusters that touch this pattern are auto-forwarded to AI investigation. Turn it off to keep this pattern's clusters in manual triage only — they still correlate into clusters, they just aren't sent to the agent automatically."
            />
          </div>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={addRow}>
        <Plus className="h-4 w-4" aria-hidden /> Add pattern
      </Button>
    </div>
  );
};

/* ------------------------------------------------------------ setup help --- */

/** Renders a connector's `setup_help` guide as plain text (trusted; never markup). */
const SetupHelpGuide: React.FC<{ help: string; connectorName: string }> = ({
  help,
  connectorName,
}) => (
  <Accordion type="single" collapsible className="rounded-md border border-border bg-surface/60 px-4">
    <AccordionItem value="setup-help" className="border-b-0">
      <AccordionTrigger className="py-3">
        <span className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-primary" aria-hidden />
          How to add {connectorName}
        </span>
      </AccordionTrigger>
      <AccordionContent>
        {/* `setup_help` is author-controlled (trusted) but rendered as plain,
            pre-wrapped text — never as live markup. */}
        <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
          {help}
        </p>
      </AccordionContent>
    </AccordionItem>
  </Accordion>
);

/* ----------------------------------------------------- field-mapping editor */

/** The canonical mapping keys + per-field help (F9). */
const FIELD_MAPPING_DEFS: Array<{
  key: keyof FieldMappingsExtra;
  label: string;
  placeholder: string;
  help: string;
}> = [
  {
    key: 'source_ip_field',
    label: 'Source IP field',
    placeholder: 'e.g. source.ip',
    help: 'The source-native field holding the source IP. Used as the primary correlation entity by default.',
  },
  {
    key: 'user_field',
    label: 'User field',
    placeholder: 'e.g. user.name',
    help: 'The field holding the acting user / account name.',
  },
  {
    key: 'host_field',
    label: 'Host field',
    placeholder: 'e.g. host.name',
    help: 'The field holding the hostname / asset the event concerns.',
  },
  {
    key: 'message_field',
    label: 'Message field',
    placeholder: 'e.g. message',
    help: 'The field shown as the human-readable message column when browsing logs and in chat.',
  },
  {
    key: 'severity_field',
    label: 'Severity field',
    placeholder: 'e.g. event.severity',
    help: 'The field holding the source severity. Drives the in-scope severity threshold.',
  },
  {
    key: 'rule_field',
    label: 'Rule field',
    placeholder: 'e.g. rule.id',
    help: 'The field holding the detection rule id / name that fired.',
  },
];

/* ---------------------------------------------------------- test callout --- */

interface TestResult {
  ok: boolean;
  message: string;
  sample?: number | null;
  mode?: string | null;
  cluster_monitor?: boolean | null;
}

const TestResultCallout: React.FC<{ result: TestResult }> = ({ result }) => {
  const readOnly = result.ok && result.mode === 'read_only';
  const title = !result.ok
    ? 'Connection failed'
    : readOnly
      ? 'Read-only key verified'
      : result.mode === 'full'
        ? 'Connection verified (full access)'
        : 'Connection succeeded';

  return (
    <Alert variant={result.ok ? 'default' : 'destructive'}>
      {result.ok ? (
        <CheckCircle2 className="h-4 w-4 text-success" aria-hidden />
      ) : (
        <AlertTriangle className="h-4 w-4" aria-hidden />
      )}
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        {/* backend message is authoritative → rendered as plain text */}
        <p>
          {result.message}
          {typeof result.sample === 'number'
            ? ` — sampled ${result.sample} event${result.sample === 1 ? '' : 's'}.`
            : ''}
        </p>
        {readOnly ? (
          <p className="mt-2">
            The agent can read logs from this source. A <code>cluster:monitor</code> privilege
            is <strong>not</strong> required — a correctly-scoped read-only key is exactly what
            we want.
          </p>
        ) : null}
      </AlertDescription>
    </Alert>
  );
};

/* ----------------------------------------------------------- section head -- */

const SectionTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
    {children}
  </div>
);

/* --------------------------------------------------------------- editor ---- */

export interface SourceEditorProps {
  connectors: ConnectorManifest[];
  /** An existing source to edit (config pre-filled); omit to add a new one. */
  existing?: SourceInstance;
  /** Default to primary on first save (e.g. the wizard's first source). */
  defaultPrimary?: boolean;
  onSaved: () => void;
  onCancel?: () => void;
}

export const SourceEditor: React.FC<SourceEditorProps> = ({
  connectors,
  existing,
  defaultPrimary,
  onSaved,
  onCancel,
}) => {
  const editing = Boolean(existing);
  const [manifest, setManifest] = React.useState<ConnectorManifest | null>(
    existing ? connectors.find((c) => c.source_type === existing.source_type) || null : null,
  );
  const [value, setValue] = React.useState<ConnectorFormValue>({
    config: (existing?.config as Record<string, unknown>) || {},
    secrets: {},
  });
  const [displayName, setDisplayName] = React.useState(existing?.display_name || '');
  const [enabled, setEnabled] = React.useState(existing?.enabled ?? true);
  const [isPrimary, setIsPrimary] = React.useState(existing?.is_primary ?? defaultPrimary ?? false);
  const [showValidation, setShowValidation] = React.useState(false);

  const [patterns, setPatterns] = React.useState<IndexPattern[]>(() =>
    deriveIndexPatterns((existing?.config as Record<string, unknown>) || {}),
  );
  const [entityStrategy, setEntityStrategy] = React.useState<string>(
    ((existing?.config as Partial<SourceConfigExtras>)?.entity_strategy as string) || 'auto',
  );
  const [messageField, setMessageField] = React.useState<string>(
    ((existing?.config as Partial<SourceConfigExtras>)?.message_field as string) || '',
  );
  // Per-source Auto-Correlate (F6) — defaults TRUE so today's behaviour is identical.
  const [autoCorrelate, setAutoCorrelate] = React.useState<boolean>(
    (existing?.config as Partial<SourceConfigExtras>)?.auto_correlate !== false,
  );
  // Per-source field-mapping overrides (F9).
  const [fieldMappings, setFieldMappings] = React.useState<FieldMappingsExtra>(
    () =>
      ((existing?.config as Partial<SourceConfigExtras>)?.field_mappings_extra as FieldMappingsExtra) ||
      {},
  );
  // "Paste a sample record" → analyze-sample (F9). The sample is never persisted.
  const [sampleText, setSampleText] = React.useState('');
  const [analyzing, setAnalyzing] = React.useState(false);
  const [analyzeError, setAnalyzeError] = React.useState<string | null>(null);
  const [analyzedFields, setAnalyzedFields] = React.useState<string[]>([]);

  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState<TestResult | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);

  React.useEffect(() => {
    if (manifest && !displayName && !editing) setDisplayName(manifest.display_name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest]);

  const configuredSecrets = existing?.configured_secrets || [];

  const manifestHasMessageField = React.useMemo(
    () => allFields(manifest || ({} as ConnectorManifest)).some((f) => f.key === 'message_field'),
    [manifest],
  );

  const groups = React.useMemo(
    () => (manifest ? groupFields(allFields(manifest)) : []),
    [manifest],
  );

  const setConfig = (key: string, v: unknown) =>
    setValue((prev) => ({ ...prev, config: { ...prev.config, [key]: v } }));
  const setSecret = (key: string, v: string) =>
    setValue((prev) => ({ ...prev, secrets: { ...prev.secrets, [key]: v } }));

  const pickConnector = (m: ConnectorManifest) => {
    setManifest(m);
    setValue({ config: {}, secrets: {} });
    setPatterns(deriveIndexPatterns({}));
    setEntityStrategy('auto');
    setMessageField('');
    setAutoCorrelate(true);
    setFieldMappings({});
    setSampleText('');
    setAnalyzedFields([]);
    setAnalyzeError(null);
    setTestResult(null);
    setError(null);
  };

  const setMapping = (key: keyof FieldMappingsExtra, v: string) =>
    setFieldMappings((prev) => ({ ...prev, [key]: v }));

  const runAnalyzeSample = async () => {
    if (!existing?.id) {
      setAnalyzeError('Save the source first, then paste a sample to get suggestions.');
      return;
    }
    const raw = sampleText.trim();
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      setAnalyzeError('That is not valid JSON. Paste a single record as a JSON object.');
      return;
    }
    setAnalyzing(true);
    setAnalyzeError(null);
    try {
      const res = await api.sources.analyzeSample(existing.id, parsed);
      setAnalyzedFields(Array.isArray(res.fields) ? res.fields : []);
      const sugg = res.suggested_mappings || {};
      setFieldMappings((prev) => {
        const next: FieldMappingsExtra = { ...prev };
        for (const def of FIELD_MAPPING_DEFS) {
          const v = sugg[def.key];
          // Only pre-fill fields the operator hasn't already set.
          if (typeof v === 'string' && v && !next[def.key]) next[def.key] = v;
        }
        return next;
      });
    } catch (e) {
      setAnalyzeError(e instanceof Error ? e.message : 'Could not analyze the sample.');
    } finally {
      setAnalyzing(false);
    }
  };

  const onTest = async () => {
    if (!manifest) return;
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const res = await api.testConnector(manifest.source_type);
      setTestResult({
        ok: res.ok,
        message: res.message || (res.ok ? 'OK' : 'Failed'),
        sample: res.sample_count,
        mode: res.mode ?? null,
        cluster_monitor: res.cluster_monitor ?? null,
      });
    } catch (e) {
      setError(e);
    } finally {
      setTesting(false);
    }
  };

  /** Fold the advanced-config editors back into the form's `config` before save. */
  const buildConfig = (): Record<string, unknown> => {
    const cleanPatterns: IndexPattern[] = patterns
      .map((p) => ({
        pattern: p.pattern.trim(),
        role: p.role === 'alerts' ? 'alerts' : ('events' as IndexPattern['role']),
        auto_correlate: p.auto_correlate !== false,
      }))
      .filter((p) => p.pattern);
    const eventsPatterns = cleanPatterns.filter((p) => p.role === 'events').map((p) => p.pattern);
    const firstPattern = (eventsPatterns[0] || cleanPatterns[0]?.pattern || '').trim();

    const cfg: Record<string, unknown> = { ...value.config };

    if (cleanPatterns.length) {
      cfg.index_patterns = cleanPatterns;
      cfg.data_view_pattern = (eventsPatterns.length ? eventsPatterns : [firstPattern]).join(',');
    } else {
      delete cfg.index_patterns;
    }

    const es = (entityStrategy || 'auto').trim();
    if (es && es !== 'auto') cfg.entity_strategy = es;
    else delete cfg.entity_strategy;

    const mf = messageField.trim();
    if (mf) cfg.message_field = mf;
    else if (!manifestHasMessageField) delete cfg.message_field;

    // Per-source Auto-Correlate (F6). Store only when OFF (default TRUE) so the
    // out-of-the-box config doc is byte-identical to today's.
    if (autoCorrelate) delete cfg.auto_correlate;
    else cfg.auto_correlate = false;

    // Per-source field-mapping overrides (F9): keep only non-empty entries.
    const fm: Record<string, string> = {};
    for (const def of FIELD_MAPPING_DEFS) {
      const v = (fieldMappings[def.key] || '').trim();
      if (v) fm[def.key] = v;
    }
    if (Object.keys(fm).length) cfg.field_mappings_extra = fm;
    else delete cfg.field_mappings_extra;

    return cfg;
  };

  const onSave = async () => {
    if (!manifest) return;
    const mergedValue: ConnectorFormValue = { ...value, config: buildConfig() };
    const missing = missingRequired(manifest, mergedValue, configuredSecrets);
    if (missing.length) {
      setShowValidation(true);
      setError(new Error(`Please complete required fields: ${missing.map((m) => m.label).join(', ')}`));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const id =
        existing?.id ||
        slugify(displayName || manifest.source_type) + '-' + Date.now().toString(36).slice(-4);
      await saveSource(manifest, mergedValue, {
        id,
        displayName: displayName || manifest.display_name,
        enabled,
        isPrimary,
        ingestMode: existing?.ingest_mode ?? null,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e : new Error(String(e)));
    } finally {
      setSaving(false);
    }
  };

  if (!connectors.length) {
    return (
      <EmptyState
        icon={Loader2}
        compact
        title="Loading connectors…"
        description="Fetching the connector catalog."
      />
    );
  }

  // --- connector picker step (add flow, before a connector is chosen) --- //
  if (!manifest) {
    return (
      <div className="space-y-5">
        <p className="text-sm leading-relaxed text-muted-foreground">
          Choose the system you want the agent to read security events from.
        </p>
        <ConnectorPicker connectors={connectors} onSelect={pickConnector} />
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* header */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <span className="font-semibold text-foreground">{manifest.display_name}</span>{' '}
          <span className="text-xs text-muted-foreground">({manifest.source_type})</span>
        </div>
        {!editing ? (
          <Button variant="ghost" size="sm" onClick={() => setManifest(null)}>
            <ArrowLeft className="h-4 w-4" aria-hidden /> Choose a different connector
          </Button>
        ) : null}
      </div>

      {/* connector-level "how to add this source" guide (F9) */}
      {manifest.setup_help ? (
        <SetupHelpGuide help={manifest.setup_help} connectorName={manifest.display_name} />
      ) : null}

      {/* identity */}
      <div className="space-y-1.5">
        <Label htmlFor="se-display">Display name</Label>
        <Input
          id="se-display"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder={manifest.display_name}
        />
        <p className="text-xs text-muted-foreground">A friendly name shown across the console.</p>
      </div>

      <div className="flex flex-wrap gap-x-8 gap-y-3 rounded-md border border-border bg-surface px-4 py-3">
        <div className="flex items-center gap-2.5">
          <Switch id="se-enabled" checked={enabled} onCheckedChange={setEnabled} />
          <Label htmlFor="se-enabled" className="cursor-pointer">
            Enabled
          </Label>
        </div>
        <div className="flex items-center gap-2.5">
          <Switch id="se-primary" checked={isPrimary} onCheckedChange={setIsPrimary} />
          <Label htmlFor="se-primary" className="cursor-pointer">
            Primary (the agent reads from this)
          </Label>
        </div>
        <div className="flex items-center gap-2.5">
          <Switch
            id="se-autocorrelate"
            checked={autoCorrelate}
            onCheckedChange={setAutoCorrelate}
          />
          <Label htmlFor="se-autocorrelate" className="cursor-pointer">
            Auto-Correlate
          </Label>
          <HelpTip
            label="About Auto-Correlate"
            text="When on (default), this source's correlated clusters are automatically forwarded to AI investigation. Turn it off to keep this source in manual triage only — events still correlate into clusters, but the agent won't investigate them automatically. You can also toggle this per index pattern below."
          />
        </div>
      </div>

      <Separator />

      {/* dynamic connector fields, grouped */}
      <div className="space-y-6">
        {groups.map(([group, fields]) => (
          <div key={group} className="space-y-3">
            <SectionTitle>{group}</SectionTitle>
            {fields.map((f) => (
              <FieldRow
                key={f.key}
                field={f}
                manifest={manifest}
                value={value}
                configuredSecrets={configuredSecrets}
                showValidation={showValidation}
                setConfig={setConfig}
                setSecret={setSecret}
              />
            ))}
          </div>
        ))}
      </div>

      <Separator />

      {/* advanced triage config */}
      <div className="space-y-3">
        <SectionTitle>Index patterns</SectionTitle>
        <IndexPatternsEditor rows={patterns} onChange={setPatterns} />
      </div>

      <div className="space-y-3">
        <SectionTitle>Correlation</SectionTitle>
        <div className="space-y-1.5">
          <Label htmlFor="se-entity">Entity strategy</Label>
          <Select value={entityStrategy} onValueChange={setEntityStrategy}>
            <SelectTrigger id="se-entity" className="sm:w-[22rem]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ENTITY_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.text}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            How a cluster's primary entity is chosen for correlation. Use this for sources that
            don't send a source IP (e.g. an audit log) so their events still form cases — pin
            Host, User or Rule.
          </p>
        </div>
      </div>

      {!manifestHasMessageField ? (
        <div className="space-y-3">
          <SectionTitle>Display</SectionTitle>
          <div className="space-y-1.5">
            <Label htmlFor="se-msg">Message field</Label>
            <Input
              id="se-msg"
              placeholder="e.g. message"
              value={messageField}
              onChange={(e) => setMessageField(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              The field shown as the human-readable message column when browsing this source's
              logs and in chat (e.g. message, rule.description, event.original). Leave blank to
              auto-detect.
            </p>
          </div>
        </div>
      ) : null}

      {/* advanced — per-source field mapping (F9) */}
      <Accordion type="single" collapsible className="rounded-md border border-border">
        <AccordionItem value="field-mapping" className="border-b-0 px-4">
          <AccordionTrigger className="py-3">
            <span className="flex items-center gap-2">
              <SlidersHorizontal className="h-4 w-4 text-muted-foreground" aria-hidden />
              Advanced — field mapping
            </span>
          </AccordionTrigger>
          <AccordionContent className="space-y-4">
            <p className="text-xs leading-relaxed text-muted-foreground">
              Override how this source&apos;s native fields map onto the canonical entity /
              message / severity / rule columns. Leave a field blank to fall back to the global
              mapping in Settings.
            </p>

            {/* paste a sample record → suggested mappings */}
            <div className="space-y-2 rounded-md border border-border bg-surface/50 p-3">
              <div className="flex items-center gap-1.5">
                <Label htmlFor="se-sample" className="text-xs">
                  Paste a sample record (optional)
                </Label>
                <HelpTip
                  label="About sample analysis"
                  text="Paste a single raw JSON record from this source. We analyze it on the server to suggest field mappings and never persist the sample. Available after the source is saved."
                />
              </div>
              <Textarea
                id="se-sample"
                placeholder='{"source": {"ip": "1.2.3.4"}, "user": {"name": "alice"}, "message": "…"}'
                value={sampleText}
                onChange={(e) => setSampleText(e.target.value)}
                className="min-h-[6rem] font-mono text-xs"
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void runAnalyzeSample()}
                  disabled={analyzing || !sampleText.trim()}
                >
                  {analyzing ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <Sparkles className="h-4 w-4" aria-hidden />
                  )}
                  Suggest mappings
                </Button>
                {!existing?.id ? (
                  <span className="text-xs text-muted-foreground">
                    Save the source first to enable sample analysis.
                  </span>
                ) : null}
              </div>
              {analyzeError ? <p className="text-xs text-critical">{analyzeError}</p> : null}
              {analyzedFields.length ? (
                <p className="text-xs text-muted-foreground">
                  {/* field paths are UNTRUSTED — rendered as plain text. */}
                  Detected {analyzedFields.length} field
                  {analyzedFields.length === 1 ? '' : 's'}; suggestions pre-filled below where
                  empty.
                </p>
              ) : null}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              {FIELD_MAPPING_DEFS.map((def) => {
                const fid = `se-fm-${def.key}`;
                return (
                  <div key={def.key} className="space-y-1.5">
                    <Label htmlFor={fid} className="flex items-center gap-1.5">
                      {def.label}
                      <HelpTip label={`About ${def.label}`} text={def.help} />
                    </Label>
                    <Input
                      id={fid}
                      placeholder={def.placeholder}
                      value={fieldMappings[def.key] || ''}
                      onChange={(e) => setMapping(def.key, e.target.value)}
                    />
                  </div>
                );
              })}
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>

      {testResult ? <TestResultCallout result={testResult} /> : null}

      {error ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" aria-hidden />
          <AlertTitle>Could not save / test</AlertTitle>
          <AlertDescription>{errorMessage(error)}</AlertDescription>
        </Alert>
      ) : null}

      {/* actions */}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" onClick={onTest} disabled={testing}>
              {testing ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Beaker className="h-4 w-4" aria-hidden />
              )}
              Test saved connection
            </Button>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            Tests the connector's currently SAVED configuration on the server. Values you have
            just typed here are only tested after you Save.
          </TooltipContent>
        </Tooltip>
        <Button onClick={onSave} disabled={saving}>
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Save className="h-4 w-4" aria-hidden />
          )}
          {editing ? 'Save changes' : 'Add source'}
        </Button>
      </div>
    </div>
  );
};

export default SourceEditor;
