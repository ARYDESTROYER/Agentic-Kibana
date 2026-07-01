/**
 * Tuning — the adaptive-threshold auto-TUNING admin surface (Round 4 / Wave 4).
 *
 * Surfaces the deterministic, no-LLM nightly tuner
 * (`backend/app/engine/threshold_tuner.py`): a per-rule NOISE table (Wilson-LB FP
 * rate + sample counts), the tuner's PROPOSED bounded change per rule, per-rule
 * Apply / Rollback (RBAC `automation:manage`), and a config panel (enable +
 * min_samples + fp_rate_target + cadence).
 *
 * RBAC: the whole page is gated behind <ProtectedRoute resource="automation"
 * action="read">. Mutations (Apply / Rollback / Save config) are wrapped in <Can
 * resource="automation" action="manage">; the server is authoritative.
 *
 * ⛔ HONEST FRAMING (#3): a banner + copy make it explicit that tuning ONLY changes
 * WHICH candidates get investigated (a correlation rule's `n`, a feed's
 * `severity_floor`) — it NEVER closes/escalates a case or feeds the deterministic
 * `decide()`. A suppression DROP is NEVER auto-applied; it is routed to the Approvals /
 * Proposals queue (linked here).
 *
 * SECURITY (#9): every rule_id / feed key / error is operator-/log-derived PLAIN data,
 * rendered as plain text / <InlineCode> — never HTML, never into a prompt.
 */
import * as React from 'react';
import {
  SlidersHorizontal,
  RefreshCw,
  Loader2,
  Play,
  Undo2,
  ArrowRight,
  ShieldAlert,
  Info,
} from 'lucide-react';
import { toast } from 'sonner';

import { humanizeToken, fmtPercent, fmtNumber, humanizeAge } from '@/lib/format';
import { errorMessage } from '@/lib/errorMessage';
import { useNavigateOptional, type Navigate } from '@/soc/router';

import { Button } from '@/ui/button';
import { Badge } from '@/ui/badge';
import { Label } from '@/ui/label';
import { Switch } from '@/ui/switch';
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
import { DataTable, type DataTableColumn } from '@/soc/components/DataTable';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { InlineCode } from '@/soc/components/CodeBlock';
import { HelpTip } from '@/soc/components/HelpTip';
import { ProtectedRoute, Can, useCan } from '@/soc/components/Can';
import { Field } from '@/soc/components/Field';
import { NumberField } from '@/soc/components/NumberField';
import { LabeledSlider } from '@/soc/components/LabeledSlider';
import { EffectiveConfigPreview } from '@/soc/components/rules/EffectiveConfigPreview';
import {
  SettingsGrid,
  SettingsCard,
  StickySaveBar,
} from '@/soc/components/SettingsGrid';

import {
  tuningApi,
  DEFAULT_TUNING_CONFIG,
  KIND_LABELS,
  REASON_LABELS,
  tuneValue,
  isLedgerRowActive,
  type TuningConfig,
  type TuningCadence,
  type TuningRecommendationsResponse,
  type TuningRecommendation,
  type TuningLedgerRow,
} from './Tuning.api';

const CADENCES: TuningCadence[] = ['hourly', 'nightly', 'weekly', 'manual'];

const CADENCE_LABEL: Record<TuningCadence, string> = {
  hourly: 'every hour',
  nightly: 'every night',
  weekly: 'every week',
  manual: 'only when run manually',
};

export interface TuningProps {
  onNavigate?: Navigate;
}

export default function Tuning({ onNavigate }: TuningProps) {
  return (
    <ProtectedRoute resource="automation" action="read">
      <TuningInner onNavigate={onNavigate} />
    </ProtectedRoute>
  );
}

export function TuningInner({ onNavigate }: TuningProps) {
  // Coupling-A: prop wins (host/test); else resolve navigate from the router context.
  // Call the hook UNCONDITIONALLY (rules-of-hooks), then let an explicit prop win.
  const contextNavigate = useNavigateOptional();
  const navigate = onNavigate ?? contextNavigate;
  const canManage = useCan('automation', 'manage');

  const [data, setData] = React.useState<TuningRecommendationsResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);
  const [busyRule, setBusyRule] = React.useState<string | null>(null);

  // Config panel: `saved` is the persisted policy; `draft` is the editing copy.
  const [saved, setSaved] = React.useState<TuningConfig>(DEFAULT_TUNING_CONFIG);
  const [draft, setDraft] = React.useState<TuningConfig>(DEFAULT_TUNING_CONFIG);
  const [savingCfg, setSavingCfg] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [recs, cfg] = await Promise.all([
        tuningApi.recommendations(),
        tuningApi.getConfig(),
      ]);
      setData(recs);
      const c = { ...DEFAULT_TUNING_CONFIG, ...(cfg.config ?? {}) };
      setSaved(c);
      setDraft(c);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const dirty = React.useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(saved),
    [draft, saved],
  );

  const saveConfig = React.useCallback(async () => {
    setSavingCfg(true);
    try {
      const res = await tuningApi.putConfig(draft);
      const c = { ...DEFAULT_TUNING_CONFIG, ...(res.config ?? draft) };
      setSaved(c);
      setDraft(c);
      toast.success('Tuning policy saved.');
    } catch (e) {
      toast.error(errorMessage(e, 'Could not save the tuning policy.'));
    } finally {
      setSavingCfg(false);
    }
  }, [draft]);

  const applyRule = React.useCallback(
    async (rec: TuningRecommendation) => {
      setBusyRule(rec.rule_id);
      try {
        const res = await tuningApi.apply(rec.rule_id);
        const applied = res.applied?.length ?? 0;
        const queued = res.queued_proposals?.length ?? 0;
        if (applied) {
          toast.success(`Applied change for ${rec.rule_id}.`);
        } else if (queued) {
          toast.info(
            `Routed to the Approvals queue for review (${queued} proposal${queued === 1 ? '' : 's'}).`,
          );
        } else if (res.shadow_blocked?.length) {
          toast.warning('Shadow-eval blocked this change (it would hide a true positive).');
        } else {
          toast.info('No change was applied.');
        }
        await load();
      } catch (e) {
        toast.error(errorMessage(e, 'Could not apply this recommendation.'));
      } finally {
        setBusyRule(null);
      }
    },
    [load],
  );

  const rollbackRule = React.useCallback(
    async (ruleId: string) => {
      setBusyRule(ruleId);
      try {
        await tuningApi.rollback(ruleId);
        toast.success(`Rolled back ${ruleId}.`);
        await load();
      } catch (e) {
        toast.error(errorMessage(e, 'Could not roll back this change.'));
      } finally {
        setBusyRule(null);
      }
    },
    [load],
  );

  // --- recommendation columns ------------------------------------------------ //
  const recColumns = React.useMemo<DataTableColumn<TuningRecommendation>[]>(
    () => [
      {
        id: 'rule_id',
        header: 'Rule',
        lockVisible: true,
        cell: (r) => (
          <div className="flex flex-col gap-1">
            <InlineCode>{r.rule_id}</InlineCode>
            <span className="text-xs text-muted-foreground">
              {KIND_LABELS[r.kind] ?? humanizeToken(r.kind)}
            </span>
          </div>
        ),
      },
      {
        id: 'noise',
        header: 'FP rate / samples',
        align: 'right',
        cell: (r) => (
          <div className="flex flex-col items-end tabular-nums">
            <span className="font-medium">{fmtPercent(r.fp_rate)}</span>
            <span className="text-xs text-muted-foreground">
              {fmtNumber(r.samples)} samples
            </span>
          </div>
        ),
      },
      {
        id: 'change',
        header: 'Proposed change',
        cell: (r) => (
          <div className="flex items-center gap-1.5 text-sm tabular-nums">
            <InlineCode>{tuneValue(r.before)}</InlineCode>
            <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            <InlineCode>{tuneValue(r.after)}</InlineCode>
          </div>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        cell: (r) => {
          if (r.kind === 'suppression') {
            return (
              <Badge variant="warning" className="gap-1">
                <ShieldAlert className="h-3 w-3" aria-hidden />
                Needs approval
              </Badge>
            );
          }
          if (r.shadow_blocked) {
            return <Badge variant="warning">Shadow-blocked</Badge>;
          }
          if (r.auto_apply) {
            return <Badge variant="success">Safe to apply</Badge>;
          }
          return <Badge variant="secondary">Review</Badge>;
        },
      },
      {
        id: 'reason',
        header: 'Why',
        cell: (r) => (
          <span className="text-xs text-muted-foreground">
            {REASON_LABELS[r.reason] ?? humanizeToken(r.reason)}
          </span>
        ),
      },
      {
        id: 'actions',
        header: '',
        align: 'right',
        cell: (r) => {
          if (r.kind === 'suppression') {
            return (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => navigate('approvals')}
              >
                Open Approvals
                <ArrowRight className="ml-1 h-3.5 w-3.5" aria-hidden />
              </Button>
            );
          }
          return (
            <Can resource="automation" action="manage">
              <Button
                size="sm"
                variant="outline"
                disabled={busyRule === r.rule_id}
                onClick={() => applyRule(r)}
              >
                {busyRule === r.rule_id ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <Play className="mr-1 h-3.5 w-3.5" aria-hidden />
                )}
                Apply
              </Button>
            </Can>
          );
        },
      },
    ],
    [applyRule, busyRule, navigate],
  );

  // --- ledger columns -------------------------------------------------------- //
  const ledgerColumns = React.useMemo<DataTableColumn<TuningLedgerRow>[]>(
    () => [
      {
        id: 'rule_id',
        header: 'Rule',
        lockVisible: true,
        cell: (r) => <InlineCode>{r.rule_id}</InlineCode>,
      },
      {
        id: 'target',
        header: 'Target',
        cell: (r) => (
          <span className="text-xs text-muted-foreground">
            {humanizeToken(r.target)}
          </span>
        ),
      },
      {
        id: 'change',
        header: 'Change',
        cell: (r) => (
          <div className="flex items-center gap-1.5 text-sm tabular-nums">
            <InlineCode>{tuneValue(r.before)}</InlineCode>
            <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            <InlineCode>{tuneValue(r.after)}</InlineCode>
          </div>
        ),
      },
      {
        id: 'state',
        // BUG #12: derive the REAL per-row state from the ledger record
        // (`rolled_back`/`rolled_back_at`) — the backend never emits an `active` field,
        // so the old `r.active` read was undefined for every row.
        header: 'State',
        cell: (r) =>
          isLedgerRowActive(r) ? (
            <Badge variant="info">Active</Badge>
          ) : (
            <Badge variant="secondary">Rolled back</Badge>
          ),
      },
      {
        id: 'when',
        header: 'Applied',
        align: 'right',
        cell: (r) => (
          <span className="text-xs text-muted-foreground">
            {humanizeAge(r.applied_at ?? null)}
          </span>
        ),
      },
      {
        id: 'actions',
        header: '',
        align: 'right',
        // Only an ACTIVE (not-yet-rolled-back) change offers a rollback (#12).
        cell: (r) =>
          isLedgerRowActive(r) ? (
            <Can resource="automation" action="manage">
              <Button
                size="sm"
                variant="ghost"
                disabled={busyRule === r.rule_id}
                onClick={() => rollbackRule(r.rule_id)}
              >
                {busyRule === r.rule_id ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <Undo2 className="mr-1 h-3.5 w-3.5" aria-hidden />
                )}
                Rollback
              </Button>
            </Can>
          ) : null,
      },
    ],
    [busyRule, rollbackRule],
  );

  const recommendations = data?.recommendations ?? [];
  const ledger = data?.applied ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        icon={SlidersHorizontal}
        eyebrow="Automation"
        title="Adaptive tuning"
        description="Deterministic, no-LLM threshold tuning over closed-case feedback."
        actions={
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={loading ? 'mr-1.5 h-4 w-4 animate-spin' : 'mr-1.5 h-4 w-4'} aria-hidden />
            Refresh
          </Button>
        }
      />

      {/* HONEST FRAMING (#3) — tuning never closes a case. */}
      <Alert>
        <Info className="h-4 w-4" aria-hidden />
        <AlertTitle>Tuning only changes what gets investigated — never how a case is decided.</AlertTitle>
        <AlertDescription>
          The tuner adjusts detection volume (a correlation rule&apos;s threshold, a feed&apos;s
          severity floor) so noisy rules surface fewer false positives. It never closes,
          escalates, or changes the verdict of a case — that decision stays deterministic.
          A suppression (drop) proposal is never auto-applied; it is routed to the
          Approvals queue for a human to review.
        </AlertDescription>
      </Alert>

      {error ? (
        <LoadError
          error={error}
          title="Could not load tuning data"
          fallback="Could not load tuning data."
          onRetry={() => void load()}
        />
      ) : null}

      {/* Recommendations */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold tracking-tight text-foreground">
            Recommendations (dry-run)
          </h2>
          <HelpTip
            label="How recommendations are computed"
            text={
              'Each recommendation is a pure dry-run: the tuner accumulates a Wilson lower-bound false-positive rate over the trailing window of closed cases and proposes a bounded change to a correlation threshold or a feed severity floor. Nothing is written until you Apply. Shadow-eval re-checks a change against recent data and blocks it if it would have hidden a true positive.'
            }
          />
          {data ? (
            <span className="text-xs text-muted-foreground">
              over {fmtNumber(data.window_cases)} closed cases
            </span>
          ) : null}
        </div>
        <DataTable
          columns={recColumns}
          rows={recommendations}
          getRowId={(r) => `${r.rule_id}:${r.kind}`}
          loading={loading}
          ariaLabel="Tuning recommendations"
          empty={
            <EmptyState
              icon={SlidersHorizontal}
              title="No recommendations"
              description="No rule currently clears the noise bar for a proposed change. Rules with enough closed-case samples appear here when their false-positive rate exceeds the target."
              compact
            />
          }
        />
      </section>

      {/* Applied ledger */}
      {ledger.length ? (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold tracking-tight text-foreground">
            Applied changes
          </h2>
          <DataTable
            columns={ledgerColumns}
            rows={ledger}
            getRowId={(r) => r.id}
            ariaLabel="Applied tuning changes"
          />
        </section>
      ) : null}

      <Separator />

      {/* Config panel — NumberField/LabeledSlider threshold UX (R4). */}
      <SettingsGrid>
        <SettingsCard
          anchor="tuning-policy"
          icon={SlidersHorizontal}
          title="Tuning policy"
          description="Controls when the nightly tuner runs and how conservative it is. Default off — leaving it off keeps behaviour unchanged."
          wide
        >
          <fieldset disabled={!canManage} className="space-y-6">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label htmlFor="tuning-enabled" className="text-sm font-medium">
                  Enable auto-tuning
                </Label>
                <p className="text-xs text-muted-foreground">
                  When on, the tuner runs on its cadence and applies safe, bounded changes.
                  Suppression drops always route to Approvals.
                </p>
              </div>
              <Switch
                id="tuning-enabled"
                checked={draft.enabled}
                onCheckedChange={(v) => setDraft((d) => ({ ...d, enabled: v }))}
              />
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <NumberField
                label="Minimum samples"
                description="Observations required before a rule is eligible for a change."
                value={draft.min_samples}
                min={1}
                max={100000}
                step={1}
                defaultValue={DEFAULT_TUNING_CONFIG.min_samples}
                disabled={!canManage}
                onChange={(v) => setDraft((d) => ({ ...d, min_samples: v }))}
              />

              <LabeledSlider
                label="Target false-positive rate"
                description="A rule whose Wilson-LB FP rate exceeds this becomes a tuning candidate."
                value={Math.round(draft.fp_rate_target * 100)}
                min={0}
                max={100}
                step={1}
                disabled={!canManage}
                formatValue={(v) => `${v}%`}
                onChange={(v) => setDraft((d) => ({ ...d, fp_rate_target: v / 100 }))}
              />

              {/* R4: the 3 previously-missing tuner knobs. */}
              <NumberField
                label="Max correlation-n step"
                description="Caps how far a correlation threshold (n) may move per cadence. 1 keeps every change to a single, bounded +1."
                value={draft.max_n_step}
                min={0}
                max={10}
                step={1}
                defaultValue={DEFAULT_TUNING_CONFIG.max_n_step}
                disabled={!canManage}
                onChange={(v) => setDraft((d) => ({ ...d, max_n_step: v }))}
              />

              <NumberField
                label="Wilson z-score"
                description="Confidence z for the Wilson lower-bound on the observed FP rate. Higher is more conservative (1.96 ≈ 95%)."
                value={draft.wilson_z}
                min={0}
                max={5}
                step={0.01}
                defaultValue={DEFAULT_TUNING_CONFIG.wilson_z}
                disabled={!canManage}
                onChange={(v) => setDraft((d) => ({ ...d, wilson_z: v }))}
              />

              <LabeledSlider
                label="EWMA smoothing (alpha)"
                description="Smoothing factor for the running FP-rate estimate. Lower reacts slower; higher reacts faster."
                value={draft.ewma_alpha}
                min={0.01}
                max={1}
                step={0.01}
                disabled={!canManage}
                formatValue={(v) => v.toFixed(2)}
                onChange={(v) => setDraft((d) => ({ ...d, ewma_alpha: v }))}
              />

              <Field
                label="Cadence"
                description="How often the tuner runs."
              >
                {({ id, describedBy }) => (
                  <Select
                    value={draft.cadence}
                    disabled={!canManage}
                    onValueChange={(v) =>
                      setDraft((d) => ({ ...d, cadence: v as TuningCadence }))
                    }
                  >
                    <SelectTrigger id={id} aria-describedby={describedBy}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CADENCES.map((c) => (
                        <SelectItem key={c} value={c}>
                          {humanizeToken(c)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>

              <div className="flex items-start justify-between gap-4 sm:col-span-2">
                <div className="space-y-0.5">
                  <Label htmlFor="tuning-shadow" className="text-sm">
                    Shadow-evaluate first
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Re-check a change against recent data; block it if it would hide a true positive.
                  </p>
                </div>
                <Switch
                  id="tuning-shadow"
                  checked={draft.shadow_eval}
                  onCheckedChange={(v) => setDraft((d) => ({ ...d, shadow_eval: v }))}
                />
              </div>
            </div>

            {/* Live "effective config" preview (R4). Advisory presentation only —
                never calls decide(), never bills an LLM. */}
            <EffectiveConfigPreview
              summary={
                draft.enabled
                  ? `Auto-tune noisy rules ${CADENCE_LABEL[draft.cadence]}: any rule above a ${Math.round(draft.fp_rate_target * 100)}% false-positive rate (≥ ${fmtNumber(draft.min_samples)} samples) gets a bounded +${fmtNumber(draft.max_n_step)} threshold nudge${draft.shadow_eval ? ', shadow-checked first' : ''}.`
                  : 'Auto-tuning is off — recommendations below are dry-run only until you enable it or Apply one manually.'
              }
              lines={[
                { label: 'FP-rate target', value: `${Math.round(draft.fp_rate_target * 100)}%` },
                { label: 'Min samples', value: fmtNumber(draft.min_samples) },
                { label: 'Max n step', value: `+${fmtNumber(draft.max_n_step)}` },
                { label: 'Wilson z', value: draft.wilson_z.toFixed(2) },
                { label: 'EWMA alpha', value: draft.ewma_alpha.toFixed(2) },
              ]}
              belowFloorNote
              noteText="A suppression (drop) proposal is never auto-applied — it routes to Approvals. A severity-floor change blocks auto-forward but never drops the candidate (#4)."
            />

            {!canManage ? (
              <p className="text-xs text-muted-foreground">
                You have read-only access to tuning. Ask a SOC administrator to change the policy.
              </p>
            ) : null}
          </fieldset>
        </SettingsCard>
      </SettingsGrid>

      <Can resource="automation" action="manage">
        <StickySaveBar
          visible={dirty}
          busy={savingCfg}
          message="Unsaved tuning-policy changes."
          onSave={() => void saveConfig()}
          onDiscard={() => setDraft(saved)}
        />
      </Can>
    </div>
  );
}
