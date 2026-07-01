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
import { Layers, RefreshCw, Loader2, Percent } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { fmtNumber, humanizeAge, humanizeToken, DASH } from '@/lib/format';
import { Button } from '@/ui/button';
import { Badge } from '@/ui/badge';
import { PageHeader } from '@/soc/components/PageHeader';
import { StatCard } from '@/soc/components/StatCard';
import { EmptyState } from '@/soc/components/EmptyState';
import { InlineCode } from '@/soc/components/CodeBlock';
import { DataTable, type DataTableColumn } from '@/soc/components/DataTable';
import { ProtectedRoute } from '@/soc/components/Can';
import {
  batchApi,
  BATCH_STATE_META,
  BATCH_STATE_ORDER,
  type BatchJobRow,
} from '@/soc/Batch.api';

function errMsg(e: unknown, fallback: string): string {
  return e instanceof ApiError && e.message ? e.message : fallback;
}

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
  const [rows, setRows] = React.useState<BatchJobRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await batchApi.jobs();
      setRows(res?.jobs ?? []);
    } catch (e) {
      setError(errMsg(e, 'Could not load batch jobs.'));
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
    <div className="flex flex-col gap-6">
      <PageHeader
        icon={Layers}
        eyebrow="Models"
        title="Batch jobs"
        description="Async LLM batch-inference jobs routed through a provider's discounted batch API. Read-only — submit, poll, and retrieve run out-of-band."
        actions={
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
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
        <StatCard label="Retrieved" value={fmtNumber(totals.done)} accent="success" />
        <StatCard
          label="Requests"
          value={fmtNumber(totals.retrieved)}
          sub={`of ${fmtNumber(totals.requests)} retrieved`}
          accent="medium"
        />
      </div>

      {error ? (
        <EmptyState
          variant="error"
          title="Could not load batch jobs"
          description={error}
          action={
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw className="h-4 w-4" aria-hidden />
              Retry
            </Button>
          }
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
    </div>
  );
}
