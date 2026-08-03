/** Resumable, RBAC-gated, secret-free application-state export. */
import * as React from 'react';
import { Download, Loader2, LockKeyhole, ShieldCheck, Square } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errorMessage';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { Label } from '@/ui/label';
import { Progress } from '@/ui/progress';
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

interface SegmentExport {
  format: 'agentic-soc-portable-export-segment' | string;
  format_version: 2 | number;
  selection: { scope: ExportScope };
  consistency: { mode: string; exact: boolean; detail: string };
  segment: {
    number: number;
    count: number;
    cumulative_count: number;
    snapshot_total: number | null;
    remaining: number | null;
    complete: boolean;
    status: 'partial' | 'complete' | 'incomplete' | 'unverified' | string;
    next_cursor: string | null;
  };
  records: unknown[];
}

interface ExportProgress {
  scope: ExportScope;
  scopeNumber: number;
  records: number;
  total: number | null;
  files: number;
}

const SCOPES: Array<{ id: ExportScope; title: string; description: string }> = [
  { id: 'cases', title: 'Cases', description: 'Case records, assessments, scores, evidence summaries and lifecycle.' },
  { id: 'audit', title: 'Audit', description: 'Append-only operator and agent action history.' },
  { id: 'usage', title: 'Usage & cost', description: 'Model calls, tokens and recorded cost metadata.' },
  { id: 'configuration', title: 'Configuration', description: 'Non-secret effective settings and source manifests.' },
  { id: 'automation', title: 'Automation', description: 'Proposals, tuning state, campaigns, batch jobs and rule-version history.' },
  { id: 'knowledge', title: 'Knowledge', description: 'Safe document metadata, operator memory and custom-model registrations.' },
];

// This is a per-file response/memory bound, never a lifetime ceiling.
const SEGMENT_SIZES = [500, 1000, 2500, 5000];

function downloadJson(value: unknown, filename: string): void {
  // Preserve the server's compact segment bound. Pretty-printing can materially
  // inflate a response that was deliberately kept below 25 MiB.
  const blob = new Blob([JSON.stringify(value)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  const revokeObjectUrl = URL.revokeObjectURL;
  window.setTimeout(() => revokeObjectUrl(url), 0);
}

function segmentFilename(scope: ExportScope, part: number): string {
  return `agentic-soc-${scope}-part-${String(part).padStart(5, '0')}.json`;
}

export function DataExportSection() {
  const [selected, setSelected] = React.useState<ExportScope[]>(SCOPES.map((scope) => scope.id));
  const [segmentSize, setSegmentSize] = React.useState(1000);
  const [exporting, setExporting] = React.useState(false);
  const [progress, setProgress] = React.useState<ExportProgress | null>(null);
  const controllerRef = React.useRef<AbortController | null>(null);
  const activeCursorRef = React.useRef<{ scope: ExportScope; cursor: string } | null>(null);

  React.useEffect(() => () => {
    controllerRef.current?.abort();
    const active = activeCursorRef.current;
    if (active) {
      void api.post('admin/export/segment/cancel', active).catch(() => undefined);
    }
  }, []);

  const allSelected = selected.length === SCOPES.length;
  const toggleAll = (checked: boolean) =>
    setSelected(checked ? SCOPES.map((scope) => scope.id) : []);
  const toggleScope = (scope: ExportScope, checked: boolean) =>
    setSelected((current) =>
      checked
        ? Array.from(new Set([...current, scope]))
        : current.filter((item) => item !== scope),
    );

  const cancelExport = () => {
    controllerRef.current?.abort();
    const active = activeCursorRef.current;
    if (active) {
      // Best effort: the server also expires abandoned PITs after ten minutes.
      void api.post('admin/export/segment/cancel', active).catch(() => undefined);
    }
  };

  const runExport = async () => {
    if (!selected.length || exporting) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    activeCursorRef.current = null;
    setExporting(true);
    setProgress(null);
    let totalFiles = 0;
    let totalRecords = 0;
    try {
      for (const [scopeIndex, scope] of selected.entries()) {
        let cursor: string | null = null;
        const cursors = new Set<string>();
        let scopeRecords = 0;
        let scopeFiles = 0;
        do {
          if (controller.signal.aborted) throw new Error('Export cancelled');
          const payload: SegmentExport = await api.postAbortable<SegmentExport>(
            'admin/export/segment',
            { scope, cursor, page_size: segmentSize },
            controller.signal,
          );
          if (payload.format !== 'agentic-soc-portable-export-segment' || payload.format_version !== 2) {
            throw new Error(`The server returned an unsupported ${scope} export format.`);
          }
          if (payload.segment.status === 'incomplete' || payload.segment.status === 'unverified') {
            throw new Error(
              `${scope} stopped without proof of completion (${payload.segment.status}). No complete-export claim was made.`,
            );
          }
          downloadJson(payload, segmentFilename(scope, payload.segment.number));
          scopeFiles += 1;
          totalFiles += 1;
          scopeRecords = payload.segment.cumulative_count;
          totalRecords += payload.segment.count;
          setProgress({
            scope,
            scopeNumber: scopeIndex + 1,
            records: scopeRecords,
            total: payload.segment.snapshot_total,
            files: scopeFiles,
          });
          if (payload.segment.complete) {
            cursor = null;
            activeCursorRef.current = null;
            break;
          }
          const next: string | null = payload.segment.next_cursor;
          if (!next || payload.segment.count <= 0 || cursors.has(next)) {
            throw new Error(`${scope} export made no forward progress; stopped before claiming completion.`);
          }
          cursors.add(next);
          cursor = next;
          activeCursorRef.current = { scope, cursor: next };
        } while (cursor);
      }
      toast.success(
        `Selected-scope export complete · ${totalRecords.toLocaleString()} records in ${totalFiles.toLocaleString()} grouped files.`,
      );
    } catch (error) {
      if (controller.signal.aborted) {
        toast.info('Export cancelled. Downloaded segments remain valid; the export is not complete.');
      } else {
        const active = activeCursorRef.current;
        if (active) {
          await api.post('admin/export/segment/cancel', active).catch(() => undefined);
        }
        toast.error(errorMessage(error, 'Could not complete the selected-scope export.'));
      }
    } finally {
      controllerRef.current = null;
      activeCursorRef.current = null;
      setExporting(false);
    }
  };

  const progressPercent = progress?.total
    ? Math.min(100, Math.round((progress.records / progress.total) * 100))
    : undefined;

  return (
    <Can resource="data_export" action="export">
      <div className="space-y-6">
        <SectionTitle
          title="Portable full-history export"
          sub="Download all records in the selected supported safe scopes as numbered JSON segments for offline analysis or support."
        />

        <Alert>
          <ShieldCheck className="h-4 w-4" aria-hidden />
          <AlertTitle>Safe and resumable by construction</AlertTitle>
          <AlertDescription>
            Credentials, tokens, sessions, users, environment secrets and upstream raw logs are never
            included. This is not a full application backup. The server uses bounded files and continues past 5,000 records; exact
            point-in-time consistency is declared per segment when the state backend supports it.
          </AlertDescription>
        </Alert>

        <fieldset className="space-y-3" disabled={exporting}>
          <legend className="text-sm font-semibold text-foreground">Data to include</legend>
          <label className="flex cursor-pointer items-start gap-3 border-b border-border py-3">
            <Checkbox
              checked={allSelected ? true : selected.length ? 'indeterminate' : false}
              onCheckedChange={(value) => toggleAll(value === true)}
              aria-label="Select all export scopes"
            />
            <span>
              <span className="block text-sm font-medium text-foreground">All supported export scopes</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">Continues until every selected safe scope is confirmed complete; unavailable data stops the export.</span>
            </span>
          </label>
          <div className="grid gap-x-6 sm:grid-cols-2 xl:grid-cols-3">
            {SCOPES.map((scope) => (
              <label key={scope.id} className="flex cursor-pointer items-start gap-3 border-b border-border/70 py-3">
                <Checkbox
                  checked={selected.includes(scope.id)}
                  onCheckedChange={(value) => toggleScope(scope.id, value === true)}
                  aria-label={`Include ${scope.title}`}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-foreground">{scope.title}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{scope.description}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="flex flex-wrap items-end justify-between gap-4 border-t border-border pt-5">
          <div className="space-y-1.5">
            <Label htmlFor="export-segment-size">Records per file</Label>
            <Select value={String(segmentSize)} onValueChange={(value) => setSegmentSize(Number(value))} disabled={exporting}>
              <SelectTrigger id="export-segment-size" className="w-44" aria-label="Records per export file">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SEGMENT_SIZES.map((value) => <SelectItem key={value} value={String(value)}>{value.toLocaleString()}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">A response safety bound, not a lifetime limit. Your browser may ask to allow multiple downloads.</p>
          </div>
          <div className="flex gap-2">
            {exporting ? (
              <Button variant="outline" onClick={cancelExport}><Square className="h-3.5 w-3.5" aria-hidden />Cancel</Button>
            ) : null}
            <Button onClick={() => void runExport()} disabled={!selected.length || exporting}>
              {exporting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />}
              {exporting ? 'Exporting full history…' : 'Export selected data'}
            </Button>
          </div>
        </div>

        {progress ? (
          <div className="space-y-2 border-y border-border py-4" aria-live="polite">
            <div className="flex flex-wrap justify-between gap-2 text-sm">
              <span className="font-medium text-foreground">{progress.scope} · scope {progress.scopeNumber} of {selected.length}</span>
              <span className="text-muted-foreground">
                {progress.records.toLocaleString()}{progress.total !== null ? ` / ${progress.total.toLocaleString()}` : ''} records · {progress.files} files
              </span>
            </div>
            <Progress value={progressPercent} className="h-1.5" />
          </div>
        ) : null}

        <div className="flex items-start gap-2 text-xs text-muted-foreground">
          <LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            Requires <code className="font-mono text-foreground">data_export:export</code> and a fresh sign-in. Every delivered segment is recorded in the audit trail.
          </span>
        </div>
      </div>
    </Can>
  );
}

export default DataExportSection;
