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
import type { Navigate } from '@/soc/router';

import { Button } from '@/ui/button';
import { Badge } from '@/ui/badge';
import { Label } from '@/ui/label';
import { Input } from '@/ui/input';
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
  type TuningConfig,
  type TuningCadence,
  type TuningRecommendationsResponse,
  type TuningRecommendation,
  type TuningLedgerRow,
} from './Tuning.api';

const CADENCES: TuningCadence[] = ['hourly', 'nightly', 'weekly', 'manual'];

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
                onClick={() => onNavigate?.('approvals')}
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
    [applyRule, busyRule, onNavigate],
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
        header: 'State',
        cell: (r) =>
          r.active ? (
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
        cell: (r) =>
          r.active ? (
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

      {/* Config panel */}
      <SettingsGrid>
        <SettingsCard
          anchor="tuning-policy"
          icon={SlidersHorizontal}
          title="Tuning policy"
          description="Controls when the nightly tuner runs and how conservative it is. Default off — leaving it off keeps behaviour unchanged."
          wide
        >
          <fieldset disabled={!canManage} className="space-y-5">
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

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="tuning-min-samples" className="text-sm">
                  Minimum samples
                </Label>
                <Input
                  id="tuning-min-samples"
                  type="number"
                  min={1}
                  value={draft.min_samples}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      min_samples: Math.max(1, Number(e.target.value) || 1),
                    }))
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Observations required before a rule is eligible for a change.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="tuning-fp-target" className="text-sm">
                  Target false-positive rate
                </Label>
                <Input
                  id="tuning-fp-target"
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={draft.fp_rate_target}
                  onChange={(e) => {
                    const raw = Number(e.target.value);
                    const clamped = Number.isNaN(raw) ? 0 : Math.min(1, Math.max(0, raw));
                    setDraft((d) => ({ ...d, fp_rate_target: clamped }));
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  A rule above this rate (0–1) becomes a tuning candidate.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="tuning-cadence" className="text-sm">
                  Cadence
                </Label>
                <Select
                  value={draft.cadence}
                  onValueChange={(v) =>
                    setDraft((d) => ({ ...d, cadence: v as TuningCadence }))
                  }
                >
                  <SelectTrigger id="tuning-cadence">
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
                <p className="text-xs text-muted-foreground">How often the tuner runs.</p>
              </div>

              <div className="flex items-start justify-between gap-4">
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
