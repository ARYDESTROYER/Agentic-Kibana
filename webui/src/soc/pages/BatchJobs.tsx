/**
 * BatchJobs — the async BATCH-inference job viewer (Round 4 / Wave 4).
 *
 * A READ-ONLY table of the durable async LLM batch-job registry: which low-urgency
 * investigations were routed through a provider's discounted async batch API (~50%
 * off) and how far each has progressed (submit -> poll -> retrieve -> retrieved).
 *
 * RBAC: gated behind <ProtectedRoute resource="models" action="read"> (the same grant
 * the backend routes enforce). There are NO mutating controls here — submit/poll/
 * retrieve is driven out-of-band by the batch service.
 *
 * #9: every value (job id / provider / model / state) is attacker-influenceable and is
 * rendered as PLAIN text / in a fenced CodeBlock — never HTML, never re-fed into a
 * prompt. No secret is ever shown (a job carries no credential; `provider_batch_id` is
 * the provider's opaque handle). #6: this viewer never records a ledger row — the batch
 * service writes exactly one UsageDoc per result at the discounted rate. #3: a batch
 * job is advisory plumbing and never touches `decide()`.
 */
import * as React from 'react';
import { Layers, RefreshCw, Loader2, Percent, Info } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errorMessage';
import type { BatchConfig } from '@/lib/types';
import { fmtNumber, humanizeAge, humanizeToken, DASH } from '@/lib/format';
import { Button } from '@/ui/button';
import { Badge } from '@/ui/badge';
import { Switch } from '@/ui/switch';
import { Label } from '@/ui/label';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Separator } from '@/ui/separator';
import { PageHeader } from '@/soc/components/PageHeader';
import { PageContainer } from '@/soc/components/PageContainer';
import { StatCard } from '@/soc/components/StatCard';
import { Skeleton } from '@/ui/skeleton';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { InlineCode } from '@/soc/components/CodeBlock';
import { DataTable, type DataTableColumn } from '@/soc/components/DataTable';
import { ProtectedRoute, Can, useCan } from '@/soc/components/Can';
import { LabeledSlider } from '@/soc/components/LabeledSlider';
import { TagInput } from '@/soc/components/TagInput';
import { EffectiveConfigPreview } from '@/soc/components/rules/EffectiveConfigPreview';
import { useConfigEditor } from '@/soc/components/rules';
import {
  SettingsGrid,
  SettingsCard,
  StickySaveBar,
} from '@/soc/components/SettingsGrid';
import {
  batchApi,
  BATCH_STATE_META,
  BATCH_STATE_ORDER,
  type BatchJobRow,
} from '@/soc/Batch.api';

/** Backend defaults (mirror `config.BatchConfig`). */
const DEFAULT_BATCH_CONFIG: Required<BatchConfig> = {
  enabled: false,
  severity_floor: 3,
  providers: ['anthropic', 'openai'],
  flex: false,
};

/** OCSF severity_id 1–6 tick labels for the severity-floor slider. */
const SEVERITY_TICKS = [
  { value: 1, label: 'Info' },
  { value: 2, label: 'Low' },
  { value: 3, label: 'Med' },
  { value: 4, label: 'High' },
  { value: 5, label: 'Crit' },
  { value: 6, label: 'Fatal' },
];
const SEVERITY_NAME: Record<number, string> = {
  1: 'Informational',
  2: 'Low',
  3: 'Medium',
  4: 'High',
  5: 'Critical',
  6: 'Fatal',
};

/** A controlled, colour-coded state badge (plain-text label, #9). */
function StateBadge({ state }: { state: string }) {
  const meta = BATCH_STATE_META[state] ?? { label: humanizeToken(state), variant: 'secondary' as const };
  return <Badge variant={meta.variant}>{meta.label}</Badge>;
}

/** A compact discount pill (e.g. "50% off"). */
function DiscountPill({ discount }: { discount: number }) {
  const pct = Number.isFinite(discount) ? Math.round((1 - discount) * 100) : 0;
  if (pct <= 0) {
    return <span className="text-xs text-muted-foreground">{DASH}</span>;
  }
  return (
    <Badge variant="info" className="gap-1">
      <Percent className="h-3 w-3" aria-hidden />
      {pct}% off
    </Badge>
  );
}

export default function BatchJobs() {
  return (
    <ProtectedRoute resource="models" action="read">
      <BatchJobsInner />
    </ProtectedRoute>
  );
}

export function BatchJobsInner() {
  const canManage = useCan('models', 'manage');
  const [rows, setRows] = React.useState<BatchJobRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);

  const cfg = useConfigEditor<BatchConfig>(api.batch, DEFAULT_BATCH_CONFIG);
  const draft = { ...DEFAULT_BATCH_CONFIG, ...cfg.draft };

  const saveConfig = React.useCallback(async () => {
    try {
      await cfg.save();
      toast.success('Batch policy saved.');
    } catch (e) {
      toast.error(errorMessage(e, 'Could not save the batch policy.'));
    }
  }, [cfg]);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await batchApi.jobs();
      setRows(res?.jobs ?? []);
    } catch (e) {
      setError(e);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  // ---- Aggregate stats over the loaded jobs (all client-side, read-only). ---- //
  const totals = React.useMemo(() => {
    const total = rows.length;
    const active = rows.filter((r) => BATCH_STATE_ORDER.includes(r.state) && r.state !== 'retrieved').length;
    const done = rows.filter((r) => r.state === 'retrieved').length;
    const requests = rows.reduce((a, r) => a + (r.requests || 0), 0);
    const retrieved = rows.reduce((a, r) => a + (r.retrieved || 0), 0);
    return { total, active, done, requests, retrieved };
  }, [rows]);

  const columns = React.useMemo<DataTableColumn<BatchJobRow>[]>(
    () => [
      {
        id: 'id',
        header: 'Job',
        lockVisible: true,
        cell: (r) => <InlineCode>{r.id}</InlineCode>,
      },
      {
        id: 'provider',
        header: 'Provider',
        cell: (r) => (
          <span className="text-sm text-foreground">{humanizeToken(r.provider) || DASH}</span>
        ),
      },
      {
        id: 'model',
        header: 'Model',
        cell: (r) =>
          r.model ? <InlineCode>{r.model}</InlineCode> : <span className="text-muted-foreground">{DASH}</span>,
      },
      {
        id: 'state',
        header: 'State',
        cell: (r) => <StateBadge state={r.state} />,
      },
      {
        id: 'requests',
        header: 'Requests',
        align: 'right',
        cell: (r) => (
          <span className="tabular-nums text-sm">
            <span className="font-semibold text-foreground">{fmtNumber(r.retrieved)}</span>
            <span className="text-muted-foreground"> / {fmtNumber(r.requests)}</span>
          </span>
        ),
      },
      {
        id: 'discount',
        header: 'Discount',
        align: 'right',
        cell: (r) => <DiscountPill discount={r.discount} />,
      },
      {
        id: 'batch_id',
        header: 'Provider batch id',
        cell: (r) =>
          r.provider_batch_id ? (
            <InlineCode>{r.provider_batch_id}</InlineCode>
          ) : (
            <span className="text-muted-foreground">{DASH}</span>
          ),
      },
      {
        id: 'submitted_at',
        header: 'Submitted',
        align: 'right',
        cell: (r) => (
          <span className="whitespace-nowrap text-xs text-muted-foreground">
            {humanizeAge(r.submitted_at)}
          </span>
        ),
      },
      {
        id: 'polled_at',
        header: 'Last poll',
        align: 'right',
        cell: (r) => (
          <span className="whitespace-nowrap text-xs text-muted-foreground">
            {humanizeAge(r.polled_at)}
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <PageContainer variant="wide" className="flex flex-col gap-6">
      <PageHeader
        icon={Layers}
        eyebrow="Models"
        title="Batch jobs"
        description="Async LLM batch-inference jobs routed through a provider's discounted batch API. Read-only — submit, poll, and retrieve run out-of-band."
        actions={
          <Button
            variant="outline"
            size="sm"
            // Refresh only re-loads the read-only jobs table; it must NOT reload the
            // config (that would silently clobber unsaved policy edits — the editor
            // has its own load-on-mount + LoadError retry).
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="h-4 w-4" aria-hidden />
            )}
            Refresh
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Total jobs" value={fmtNumber(totals.total)} accent="primary" icon={Layers} />
        <StatCard label="In flight" value={fmtNumber(totals.active)} accent="info" />
        {/* `done` counts JOBS whose state is `retrieved`; `retrieved` sums individual
            REQUESTS retrieved. Label each by its granularity so "retrieved" is not
            overloaded across the two adjacent tiles. */}
        <StatCard label="Jobs done" value={fmtNumber(totals.done)} accent="success" />
        <StatCard
          label="Requests retrieved"
          value={fmtNumber(totals.retrieved)}
          sub={`of ${fmtNumber(totals.requests)} total`}
          accent="primary"
        />
      </div>

      {error ? (
        <LoadError
          error={error}
          title="Could not load batch jobs"
          fallback="Could not load batch jobs."
          onRetry={() => void load()}
        />
      ) : (
        <DataTable
          ariaLabel="Batch jobs"
          columns={columns}
          rows={rows}
          getRowId={(r) => r.id}
          loading={loading}
          loadingRows={6}
          empty={
            <EmptyState
              compact
              icon={Layers}
              title="No batch jobs yet"
              description="Low-urgency investigations routed through a provider's async batch API will appear here."
            />
          }
        />
      )}

      <Separator />

      {/* ── Config editor (R6) ───────────────────────────────────────────── */}
      {cfg.error ? (
        <LoadError
          error={cfg.error}
          title="Could not load batch policy"
          fallback="Could not load the batch policy."
          onRetry={() => void cfg.reload()}
        />
      ) : (
        <SettingsGrid>
          <SettingsCard
            anchor="batch-policy"
            icon={Layers}
            title="Batch policy"
            description="Route low-urgency investigations through a provider's discounted async batch API. Default off — an off policy keeps every call synchronous."
            wide
          >
            {cfg.loading ? (
              // Don't flash the default-valued form while the persisted policy loads.
              <div className="space-y-4" aria-busy="true">
                <Skeleton className="h-14 w-full" />
                <Skeleton className="h-40 w-full" />
              </div>
            ) : (
            <fieldset disabled={!canManage} className="space-y-6">
              <Alert>
                <Info className="h-4 w-4" aria-hidden />
                <AlertTitle>Batch routing is cost plumbing</AlertTitle>
                <AlertDescription>
                  It changes only WHERE a low-urgency investigation runs (a slower,
                  cheaper async queue), never the verdict or the deterministic decision.
                  Exactly one usage-ledger row is still written per resolved call.
                </AlertDescription>
              </Alert>

              <div className="flex items-center justify-between gap-4">
                <div className="space-y-0.5">
                  <Label htmlFor="batch-enabled" className="text-sm font-medium">
                    Enable batch routing
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    When on, candidates at or below the severity floor go to the async
                    batch API (~50% off) instead of a live call.
                  </p>
                </div>
                <Switch
                  id="batch-enabled"
                  checked={draft.enabled}
                  onCheckedChange={(v) => cfg.update({ enabled: v })}
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <LabeledSlider
                  label="Severity floor"
                  description="A candidate at or below this OCSF severity is batch-eligible; above it stays synchronous."
                  value={draft.severity_floor}
                  min={1}
                  max={6}
                  step={1}
                  ticks={SEVERITY_TICKS}
                  editable={false}
                  disabled={!canManage}
                  formatValue={(v) => SEVERITY_NAME[v] ?? String(v)}
                  onChange={(v) => cfg.update({ severity_floor: v })}
                />
                <div className="flex items-start justify-between gap-4 pt-1">
                  <div className="space-y-0.5">
                    <Label htmlFor="batch-flex" className="text-sm">
                      Flexible tier
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Opt into a provider&apos;s best-effort / flexible tier for a
                      further discount at the cost of latency.
                    </p>
                  </div>
                  <Switch
                    id="batch-flex"
                    checked={draft.flex}
                    disabled={!canManage}
                    onCheckedChange={(v) => cfg.update({ flex: v })}
                  />
                </div>
              </div>

              <TagInput
                label="Batch providers"
                description="Providers whose batch APIs may be used (e.g. anthropic, openai)."
                value={draft.providers ?? []}
                disabled={!canManage}
                placeholder="add a provider…"
                onChange={(next) => cfg.update({ providers: next })}
              />

              <EffectiveConfigPreview
                summary={
                  draft.enabled
                    ? `Batch-route candidates at or below ${SEVERITY_NAME[draft.severity_floor] ?? draft.severity_floor} severity via ${(draft.providers ?? []).length ? (draft.providers ?? []).join(', ') : 'no providers'}${draft.flex ? ' (flexible tier)' : ''}. Higher-severity candidates stay synchronous.`
                    : 'Batch routing is off — every investigation runs synchronously.'
                }
                lines={[
                  { label: 'Severity floor', value: SEVERITY_NAME[draft.severity_floor] ?? String(draft.severity_floor) },
                  { label: 'Providers', value: (draft.providers ?? []).join(', ') || DASH },
                  { label: 'Flexible tier', value: draft.flex ? 'on' : 'off' },
                ]}
                belowFloorNote
                noteText="One usage-ledger row is still written per resolved call (#6). Batch routing changes only where a call runs, never the decision."
              />

              {!canManage ? (
                <p className="text-xs text-muted-foreground">
                  You have read-only access. Ask a SOC administrator to change the batch
                  policy.
                </p>
              ) : null}
            </fieldset>
            )}
          </SettingsCard>
        </SettingsGrid>
      )}

      <Can resource="models" action="manage">
        <StickySaveBar
          visible={cfg.dirty}
          busy={cfg.saving}
          message="Unsaved batch-policy changes."
          onSave={() => void saveConfig()}
          onDiscard={cfg.discard}
        />
      </Can>
    </PageContainer>
  );
}
