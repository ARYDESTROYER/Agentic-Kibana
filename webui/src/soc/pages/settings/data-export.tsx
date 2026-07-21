/**
 * Portable data export — an RBAC-gated, deliberately secret-free analysis bundle.
 *
 * The backend is the authority for scope selection, redaction, limits and the
 * `data_export:export` grant. This UI never attempts to gather state itself: it asks
 * the server for one canonical JSON envelope and downloads that exact payload.
 */
import * as React from 'react';
import { Download, Loader2, LockKeyhole, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errorMessage';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { Label } from '@/ui/label';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';
import { Can } from '@/soc/components/Can';
import { SectionTitle } from './primitives';

type ExportScope = 'cases' | 'audit' | 'usage' | 'configuration' | 'automation' | 'knowledge';

interface PortableExport {
  format: 'agentic-soc-portable-export' | string;
  format_version: number;
  selection: { scopes: string[] };
  limits: { items_per_scope: number; max_bytes?: number };
  excluded: string[];
  manifest: Record<string, { count: number; total?: number; truncated?: boolean }>;
  data: Record<string, unknown>;
}

const SCOPES: Array<{ id: ExportScope; title: string; description: string }> = [
  { id: 'cases', title: 'Cases', description: 'Case records, assessments, scores, evidence summaries and lifecycle.' },
  { id: 'audit', title: 'Audit', description: 'Append-only operator and agent action history.' },
  { id: 'usage', title: 'Usage & cost', description: 'Model calls, tokens and recorded cost metadata.' },
  { id: 'configuration', title: 'Configuration', description: 'Non-secret effective settings and source manifests.' },
  { id: 'automation', title: 'Automation', description: 'Proposals, tuning state, campaigns, batch jobs and rule-version history.' },
  { id: 'knowledge', title: 'Knowledge', description: 'Safe document metadata, operator memory and custom-model registrations.' },
];

const LIMITS = [100, 500, 1000, 2500, 5000];

/** Download one JSON value without retaining an object URL after the click. */
function downloadJson(value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'agentic-soc-export.json';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Capture the browser implementation before scheduling cleanup. This is also
  // resilient to a test/page teardown replacing the global URL constructor before
  // the zero-delay callback runs.
  const revokeObjectUrl = URL.revokeObjectURL;
  window.setTimeout(() => revokeObjectUrl(url), 0);
}

export function DataExportSection() {
  const [selected, setSelected] = React.useState<ExportScope[]>(SCOPES.map((scope) => scope.id));
  const [limit, setLimit] = React.useState(1000);
  const [exporting, setExporting] = React.useState(false);

  const allSelected = selected.length === SCOPES.length;
  const toggleAll = (checked: boolean) =>
    setSelected(checked ? SCOPES.map((scope) => scope.id) : []);
  const toggleScope = (scope: ExportScope, checked: boolean) =>
    setSelected((current) =>
      checked
        ? Array.from(new Set([...current, scope]))
        : current.filter((item) => item !== scope),
    );

  const runExport = async () => {
    if (!selected.length || exporting) return;
    setExporting(true);
    try {
      const payload = await api.post<PortableExport>('admin/export', {
        scopes: allSelected ? ['all'] : selected,
        limit_per_scope: limit,
      });
      downloadJson(payload);
      const records = Object.values(payload.manifest || {}).reduce(
        (sum, entry) => sum + (Number.isFinite(entry.count) ? entry.count : 0),
        0,
      );
      toast.success(`Portable export ready · ${records.toLocaleString()} records.`);
    } catch (error) {
      toast.error(errorMessage(error, 'Could not create the portable export.'));
    } finally {
      setExporting(false);
    }
  };

  return (
    <Can resource="data_export" action="export">
      <div className="space-y-6">
        <SectionTitle
          title="Portable analysis bundle"
          sub="Choose the application data to package as one versioned JSON file for offline analysis or support."
        />

        <Alert>
          <ShieldCheck className="h-4 w-4" aria-hidden />
          <AlertTitle>Safe by construction</AlertTitle>
          <AlertDescription>
            Credentials, API tokens, private keys, sessions, user accounts, environment secrets and
            upstream raw logs are never included. Sensitive-looking values are redacted again before
            the server returns the bundle.
          </AlertDescription>
        </Alert>

        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold text-foreground">Data to include</legend>
          <label className="flex cursor-pointer items-start gap-3 border-b border-border py-3">
            <Checkbox
              checked={allSelected ? true : selected.length ? 'indeterminate' : false}
              onCheckedChange={(value) => toggleAll(value === true)}
              aria-label="Select all export scopes"
            />
            <span>
              <span className="block text-sm font-medium text-foreground">All safe application data</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                The complete portable view across every scope below.
              </span>
            </span>
          </label>

          <div className="grid gap-x-6 sm:grid-cols-2 xl:grid-cols-3">
            {SCOPES.map((scope) => (
              <label
                key={scope.id}
                className="flex cursor-pointer items-start gap-3 border-b border-border/70 py-3"
              >
                <Checkbox
                  checked={selected.includes(scope.id)}
                  onCheckedChange={(value) => toggleScope(scope.id, value === true)}
                  aria-label={`Include ${scope.title}`}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-foreground">{scope.title}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                    {scope.description}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="flex flex-wrap items-end justify-between gap-4 border-t border-border pt-5">
          <div className="space-y-1.5">
            <Label htmlFor="export-record-limit">Maximum records per scope</Label>
            <Select value={String(limit)} onValueChange={(value) => setLimit(Number(value))}>
              <SelectTrigger id="export-record-limit" className="w-44" aria-label="Maximum records per export scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LIMITS.map((value) => (
                  <SelectItem key={value} value={String(value)}>
                    {value.toLocaleString()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">The manifest marks scopes that were truncated.</p>
          </div>

          <Button onClick={() => void runExport()} disabled={!selected.length || exporting}>
            {exporting ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Download className="h-4 w-4" aria-hidden />
            )}
            {exporting ? 'Preparing export…' : 'Export selected data'}
          </Button>
        </div>

        <div className="flex items-start gap-2 text-xs text-muted-foreground">
          <LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            Requires the <code className="font-mono text-foreground">data_export:export</code>{' '}
            permission. Every export request is recorded in the audit trail.
          </span>
        </div>
      </div>
    </Can>
  );
}

export default DataExportSection;
