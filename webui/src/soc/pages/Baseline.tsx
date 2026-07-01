/**
 * Baseline — anomaly-baseline warm-up + coverage overview AND the baseline config
 * editor (Round 4 surface + Round 5 R6 config-editor wiring).
 *
 * The top of the page is a read-only view of the per-entity streaming baselines that
 * "improve over time" (online EWMA/EWMV + 168 hour-of-week buckets + t-digest): warm-up
 * progress (n / target) and robust percentiles. Below it, a config editor exposes
 * `Preferences.baseline` (a `BaselineConfig`) through the typed GET/PUT config endpoint
 * (W0-F F5) so an operator can tune the detector.
 *
 * #3: the baseline is a pure advisory PRODUCER — it ranks/emits candidate signals for
 * the EVENT-detection funnel; it NEVER closes or escalates a case. The config editor is
 * a CONFIG WRITER only: deep-merge PUT, never `decide()`, never bills an LLM (#3/#6).
 * #9: every value renders as plain text via the overview component / labelled fields.
 */
import * as React from 'react';
import { Activity, Info, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errorMessage';
import type { BaselineConfig } from '@/lib/types';
import { humanizeToken } from '@/lib/format';

import { Button } from '@/ui/button';
import { Skeleton } from '@/ui/skeleton';
import { Switch } from '@/ui/switch';
import { Label } from '@/ui/label';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Separator } from '@/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';

import { PageHeader } from '@/soc/components/PageHeader';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { ProtectedRoute, Can, useCan } from '@/soc/components/Can';
import { BaselineStatsOverview } from '@/soc/components/BaselineGauge';
import { Field } from '@/soc/components/Field';
import { NumberField } from '@/soc/components/NumberField';
import { LabeledSlider } from '@/soc/components/LabeledSlider';
import {
  SettingsGrid,
  SettingsCard,
  StickySaveBar,
} from '@/soc/components/SettingsGrid';
import { useConfigEditor } from '@/soc/components/rules';
import { fetchBaselineStats, type BaselineStats } from '@/soc/Baseline.api';

/** Backend defaults (mirror `config.BaselineConfig`). */
const DEFAULT_BASELINE_CONFIG: Required<BaselineConfig> = {
  enabled: false,
  half_life_days: 14,
  warmup_multiplier: 3,
  modified_z_threshold: 3.5,
  tdigest_compression: 100,
  seasonality: 'hour_of_week',
};

const SEASONALITIES: BaselineConfig['seasonality'][] = [
  'none',
  'hour_of_day',
  'hour_of_week',
  'day_of_week',
];

export default function Baseline() {
  return (
    <ProtectedRoute resource="settings" action="read">
      <BaselineInner />
    </ProtectedRoute>
  );
}

export function BaselineInner() {
  const canManage = useCan('settings', 'manage');
  const [stats, setStats] = React.useState<BaselineStats | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);

  const cfg = useConfigEditor<BaselineConfig>(api.baseline, DEFAULT_BASELINE_CONFIG);
  const draft = { ...DEFAULT_BASELINE_CONFIG, ...cfg.draft };

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStats(await fetchBaselineStats());
    } catch (e) {
      setError(e);
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const save = React.useCallback(async () => {
    try {
      await cfg.save();
      toast.success('Baseline policy saved.');
    } catch (e) {
      toast.error(errorMessage(e, 'Could not save the baseline policy.'));
    }
  }, [cfg]);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Activity}
        title="Anomaly baseline"
        description="Per-entity streaming baselines that improve over time — warm-up progress and robust percentiles. Advisory only: the baseline ranks candidates for detection; it never closes or escalates a case."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void load();
              void cfg.reload();
            }}
            disabled={loading}
          >
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden />
            Refresh
          </Button>
        }
      />

      {/* ── Warm-up overview (read-only) ─────────────────────────────────── */}
      {loading && !stats ? (
        <div className="space-y-3" aria-busy="true">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : error ? (
        <LoadError
          error={error}
          title="Baseline unavailable"
          fallback="Could not load baseline stats."
          onRetry={() => void load()}
        />
      ) : stats ? (
        <BaselineStatsOverview stats={stats} />
      ) : (
        <EmptyState
          icon={Activity}
          title="No baseline yet"
          description="The baseline warms up as EVENT-feed detection runs."
        />
      )}

      <Separator />

      {/* ── Config editor (R6) ───────────────────────────────────────────── */}
      {cfg.error ? (
        <LoadError
          error={cfg.error}
          title="Could not load baseline policy"
          fallback="Could not load the baseline policy."
          onRetry={() => void cfg.reload()}
        />
      ) : (
        <SettingsGrid>
          <SettingsCard
            anchor="baseline-policy"
            icon={Activity}
            title="Baseline policy"
            description="Tune the anomaly detector's warm-up and sensitivity. Default off — an off detector emits no candidates and changes nothing."
            wide
          >
            <fieldset disabled={!canManage} className="space-y-6">
              <Alert>
                <Info className="h-4 w-4" aria-hidden />
                <AlertTitle>The baseline is advisory</AlertTitle>
                <AlertDescription>
                  A deviation only surfaces a candidate for the detection funnel; it
                  never closes, escalates, or decides a case.
                </AlertDescription>
              </Alert>

              <div className="flex items-center justify-between gap-4">
                <div className="space-y-0.5">
                  <Label htmlFor="baseline-enabled" className="text-sm font-medium">
                    Enable anomaly baseline
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    When on, per-signature sketches warm up and flag deviations as
                    detection candidates.
                  </p>
                </div>
                <Switch
                  id="baseline-enabled"
                  checked={draft.enabled}
                  onCheckedChange={(v) => cfg.update({ enabled: v })}
                />
              </div>

              <div className="grid gap-5 sm:grid-cols-2">
                <NumberField
                  label="Half-life (days)"
                  description="EWMA decay half-life. Longer remembers more history."
                  value={draft.half_life_days}
                  min={0.5}
                  max={365}
                  step={0.5}
                  unit="days"
                  defaultValue={DEFAULT_BASELINE_CONFIG.half_life_days}
                  disabled={!canManage}
                  onChange={(v) => cfg.update({ half_life_days: v })}
                />
                <NumberField
                  label="Warm-up multiplier"
                  description="Times the seasonal period a bucket must observe before it is WARM (guards a cold series)."
                  value={draft.warmup_multiplier}
                  min={1}
                  max={20}
                  step={1}
                  defaultValue={DEFAULT_BASELINE_CONFIG.warmup_multiplier}
                  disabled={!canManage}
                  onChange={(v) => cfg.update({ warmup_multiplier: v })}
                />
                <LabeledSlider
                  label="Modified-z threshold"
                  description="The robust deviation bar; a signature above it is anomalous. 3.5 is the conventional default."
                  value={draft.modified_z_threshold}
                  min={0}
                  max={10}
                  step={0.1}
                  disabled={!canManage}
                  formatValue={(v) => v.toFixed(1)}
                  onChange={(v) => cfg.update({ modified_z_threshold: v })}
                />
                <NumberField
                  label="t-digest compression"
                  description="Bounds the quantile-sketch size (higher is more precise, more memory)."
                  value={draft.tdigest_compression}
                  min={20}
                  max={1000}
                  step={10}
                  defaultValue={DEFAULT_BASELINE_CONFIG.tdigest_compression}
                  disabled={!canManage}
                  onChange={(v) => cfg.update({ tdigest_compression: v })}
                />
                <Field
                  label="Seasonality"
                  description="How observations are bucketed for seasonality."
                >
                  {({ id, describedBy }) => (
                    <Select
                      value={draft.seasonality ?? 'hour_of_week'}
                      disabled={!canManage}
                      onValueChange={(v) =>
                        cfg.update({ seasonality: v as BaselineConfig['seasonality'] })
                      }
                    >
                      <SelectTrigger id={id} aria-describedby={describedBy}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SEASONALITIES.map((s) => (
                          <SelectItem key={s} value={s as string}>
                            {humanizeToken(s as string)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </Field>
              </div>

              {!canManage ? (
                <p className="text-xs text-muted-foreground">
                  You have read-only access. Ask a SOC administrator to change the
                  baseline policy.
                </p>
              ) : null}
            </fieldset>
          </SettingsCard>
        </SettingsGrid>
      )}

      <Can resource="settings" action="manage">
        <StickySaveBar
          visible={cfg.dirty}
          busy={cfg.saving}
          message="Unsaved baseline-policy changes."
          onSave={() => void save()}
          onDiscard={cfg.discard}
        />
      </Can>
    </div>
  );
}
