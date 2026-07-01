/**
 * Baseline — anomaly-baseline warm-up + coverage overview (Round 4 / Wave 4).
 *
 * A read-only view of the per-entity streaming baselines that "improve over time"
 * (online EWMA/EWMV + 168 hour-of-week buckets + t-digest): warm-up progress
 * (n / target) and robust percentiles. It is a thin fetching wrapper around the
 * presentational <BaselineStatsOverview> from BaselineGauge.
 *
 * #3: the baseline is a pure advisory PRODUCER — it ranks/emits candidate signals
 * for the EVENT-detection funnel; it NEVER closes or escalates a case. #9: every
 * value renders as plain text via the overview component.
 */
import * as React from 'react';
import { Activity, RefreshCw, Loader2 } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { Button } from '@/ui/button';
import { PageHeader } from '@/soc/components/PageHeader';
import { EmptyState } from '@/soc/components/EmptyState';
import { ProtectedRoute } from '@/soc/components/Can';
import { BaselineStatsOverview } from '@/soc/components/BaselineGauge';
import { fetchBaselineStats, type BaselineStats } from '@/soc/Baseline.api';

function errMsg(e: unknown, fallback: string): string {
  return e instanceof ApiError && e.message ? e.message : fallback;
}

export default function Baseline() {
  return (
    <ProtectedRoute resource="settings" action="read">
      <BaselineInner />
    </ProtectedRoute>
  );
}

export function BaselineInner() {
  const [stats, setStats] = React.useState<BaselineStats | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStats(await fetchBaselineStats());
    } catch (e) {
      setError(errMsg(e, 'Could not load baseline stats.'));
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Activity}
        title="Anomaly baseline"
        description="Per-entity streaming baselines that improve over time — warm-up progress and robust percentiles. Advisory only: the baseline ranks candidates for detection; it never closes or escalates a case."
        actions={
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden />
            Refresh
          </Button>
        }
      />
      {loading && !stats ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading baseline…
        </div>
      ) : error ? (
        <EmptyState icon={Activity} title="Baseline unavailable" description={error} />
      ) : stats ? (
        <BaselineStatsOverview stats={stats} />
      ) : (
        <EmptyState
          icon={Activity}
          title="No baseline yet"
          description="The baseline warms up as EVENT-feed detection runs."
        />
      )}
    </div>
  );
}
