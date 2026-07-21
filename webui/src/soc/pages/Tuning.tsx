/**
 * Auto-tuning — the adaptive-threshold auto-TUNING admin surface (Round 4, restyled to
 * the "Auto-tuning" command-center mockup).
 *
 * Surfaces the deterministic, no-LLM tuner (`backend/app/engine/threshold_tuner.py`):
 *   - a HEALTH SUMMARY (rules monitored / healthy / needs review / human proposals),
 *   - a RULES table (per-rule Wilson-LB FP rate + samples + the tuner's proposed bounded
 *     change + shadow result + last-tuned + health state) with a selectable row that
 *     opens a read-only rule-detail panel,
 *   - PROPOSED CHANGES (safe, auto-appliable recommendations) with per-row Apply,
 *   - PENDING HUMAN PROPOSALS (suppression / shadow-blocked → routed to Approvals),
 *   - a global AUDIT HISTORY ledger with per-rule Rollback,
 *   - and the tuning-policy config panel.
 *
 * RBAC: the whole page is gated behind <ProtectedRoute resource="automation"
 * action="read">. Mutations (Apply / Rollback / Save config) are wrapped in <Can
 * resource="automation" action="manage">; the server is authoritative.
 *
 * ⛔ HONEST FRAMING (#3): copy makes it explicit that tuning ONLY changes WHICH
 * candidates get investigated (a correlation rule's `n`, a feed's `severity_floor`) — it
 * NEVER closes/escalates a case or feeds the deterministic `decide()`. A suppression
 * DROP is NEVER auto-applied; it is routed to the Approvals / Proposals queue.
 *
 * REAL DATA ONLY: every metric/column below is bound to the backend
 * `GET /api/tuning/recommendations` contract — nothing is fabricated. Knob changes are
 * INTEGER before→after (never decimal). Shadow result is a boolean-derived chip (the
 * backend returns only a boolean, never an estimated %).
 *
 * SECURITY (#9): every rule_id / feed key / rationale / error is operator-/log-derived
 * PLAIN data, rendered as plain text / <InlineCode> — never HTML, never into a prompt.
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
  ShieldCheck,
  AlertTriangle,
  Radar,
  CheckCircle2,
  X,
  Info,
} from 'lucide-react';
import { toast } from 'sonner';

import {
  humanizeToken,
  fmtPercent,
  fmtNumber,
  humanizeAge,
  DASH,
} from '@/lib/format';
import { errorMessage } from '@/lib/errorMessage';
import { useNavigateOptional, type Navigate } from '@/soc/router';

import { Button } from '@/ui/button';
import { Badge } from '@/ui/badge';
import { Label } from '@/ui/label';
import { Switch } from '@/ui/switch';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';

import { PageHeader } from '@/soc/components/PageHeader';
import { PageContainer } from '@/soc/components/PageContainer';
import { KpiTile, type KpiAccent } from '@/soc/components/KpiTile';
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
  tuneDelta,
  observedFpRate,
  isLedgerRowActive,
  type TuningConfig,
  type TuningCadence,
  type TuningRecommendationsResponse,
  type TuningRecommendation,
  type TuningLedgerRow,
  type RuleNoise,
} from './Tuning.api';

const CADENCES: TuningCadence[] = ['hourly', 'nightly', 'weekly', 'manual'];

const CADENCE_LABEL: Record<TuningCadence, string> = {
  hourly: 'every hour',
  nightly: 'every night',
  weekly: 'every week',
  manual: 'only when run manually',
};

/** Format an ISO instant as an explicit UTC wall-clock (the ledger stores UTC). */
function fmtUtc(iso?: string | null): string {
  if (!iso) return DASH;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return DASH;
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
  );
}

/** A before→after arrow of two PLAIN-text knob values (UNTRUSTED-safe, #9). */
function ChangeArrow({ before, after }: { before: unknown; after: unknown }) {
  return (
    <span className="inline-flex items-center gap-1.5 tabular-nums">
      <InlineCode>{tuneValue(before)}</InlineCode>
      <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <InlineCode>{tuneValue(after)}</InlineCode>
    </span>
  );
}

/** The boolean-derived shadow-eval chip (never a fabricated %). */
function ShadowChip({ blocked }: { blocked: boolean }) {
  return blocked ? (
    <Badge variant="warning">Blocked — needs review</Badge>
  ) : (
    <Badge variant="success">Within bounds</Badge>
  );
}

export interface TuningProps {
  onNavigate?: Navigate;
}

export default function Tuning({ onNavigate }: TuningProps) {
  return (
    <ProtectedRoute resource="automation" action="read">
      <PageContainer variant="wide">
        <TuningInner onNavigate={onNavigate} />
      </PageContainer>
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
  // True once a load has SUCCESSFULLY populated the policy. The config editor + save bar
  // only render after this, so a load FAILURE never leaves an editable DEFAULT policy
  // form (a Save there would clobber the real, never-loaded policy wholesale).
  const [loadedOnce, setLoadedOnce] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  // Busy key is the ROW id (recommendation `${rule_id}:${kind}` / ledger `id`), NOT the
  // bare rule_id — otherwise applying/rolling back one row disables every sibling row that
  // shares the same rule_id (a rule can have both a correlation_n and severity_floor rec).
  const [busyRow, setBusyRow] = React.useState<string | null>(null);

  // The Rules-table row the operator is inspecting (opens the read-only detail panel).
  const [selectedRuleId, setSelectedRuleId] = React.useState<string | null>(null);
  // The last successful rollback → the transient green "rolled back" confirmation.
  const [lastRollback, setLastRollback] = React.useState<{
    ruleId: string;
    recordId: string;
  } | null>(null);
  // Client-side pagination for the Rules table.
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(10);

  // Config panel: `saved` is the persisted policy; `draft` is the editing copy.
  const [saved, setSaved] = React.useState<TuningConfig>(DEFAULT_TUNING_CONFIG);
  const [draft, setDraft] = React.useState<TuningConfig>(DEFAULT_TUNING_CONFIG);
  const [savingCfg, setSavingCfg] = React.useState(false);

  const dirty = React.useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(saved),
    [draft, saved],
  );

  // Latest draft/saved snapshots so a BACKGROUND reload (Refresh, after Apply/Rollback)
  // can preserve unsaved policy edits instead of silently discarding them.
  const draftRef = React.useRef(draft);
  const savedRef = React.useRef(saved);
  React.useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  React.useEffect(() => {
    savedRef.current = saved;
  }, [saved]);

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
      // Only overwrite the editing draft when it has NO unsaved edits — a reload must
      // not wipe in-progress policy changes the operator hasn't saved (#16).
      const wasDirty = JSON.stringify(draftRef.current) !== JSON.stringify(savedRef.current);
      if (!wasDirty) setDraft(c);
      setLoadedOnce(true);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

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
      setBusyRow(`${rec.rule_id}:${rec.kind}`);
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
        setBusyRow(null);
      }
    },
    [load],
  );

  const rollbackRule = React.useCallback(
    // `rowId` scopes the busy/spinner to THIS ledger row; the backend rollback still
    // takes only the rule_id (it reverses the newest active record, #13).
    async (ruleId: string, rowId: string) => {
      setBusyRow(rowId);
      try {
        const res = await tuningApi.rollback(ruleId);
        // Honest transient confirmation — the REAL rule_id + record_id the backend reversed.
        setLastRollback({ ruleId: res.rule_id ?? ruleId, recordId: res.record_id ?? '' });
        toast.success(`Rolled back ${ruleId}.`);
        await load();
      } catch (e) {
        toast.error(errorMessage(e, 'Could not roll back this change.'));
      } finally {
        setBusyRow(null);
      }
    },
    [load],
  );

  // Stable identities so the downstream useMemos below don't re-run every render.
  const recommendations = React.useMemo(() => data?.recommendations ?? [], [data]);
  const ruleNoise = React.useMemo(() => data?.rule_noise ?? [], [data]);
  const ledger = React.useMemo(() => data?.applied ?? [], [data]);

  // Partition recommendations: SAFE (auto-appliable here) vs HITL (suppression DROP or a
  // shadow-blocked raise — both need a human decision → routed to Approvals, never
  // auto-applied, #3).
  const isHitl = React.useCallback(
    (r: TuningRecommendation) => r.kind === 'suppression' || r.shadow_blocked,
    [],
  );
  const safeRecs = React.useMemo(
    () => recommendations.filter((r) => !isHitl(r)),
    [recommendations, isHitl],
  );
  const proposals = React.useMemo(
    () => recommendations.filter((r) => isHitl(r)),
    [recommendations, isHitl],
  );

  // Join maps for the Rules table (by rule_id).
  const recByRule = React.useMemo(() => {
    const m = new Map<string, TuningRecommendation>();
    for (const r of recommendations) if (!m.has(r.rule_id)) m.set(r.rule_id, r);
    return m;
  }, [recommendations]);

  const lastTunedByRule = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const r of ledger) {
      const when = r.applied_at ?? '';
      if (!when) continue;
      if (!m.has(r.rule_id) || when > (m.get(r.rule_id) ?? '')) m.set(r.rule_id, when);
    }
    return m;
  }, [ledger]);

  // BUG #13: the backend rollback reverses the MOST-RECENT active record for a rule_id
  // (it takes `active[0]`), and the FE only sends the rule_id — never a record id. So
  // clicking Rollback on an OLDER active row of a rule with several un-rolled-back
  // changes reverses the NEWER one. Restrict the Rollback affordance to the single
  // newest active row per rule_id (newest by `applied_at`) so the button matches what
  // the backend actually reverses.
  const newestActiveRowByRule = React.useMemo(() => {
    const newest = new Map<string, string>(); // rule_id -> row id
    const at = new Map<string, string>(); // rule_id -> applied_at of the current newest
    for (const r of ledger) {
      if (!isLedgerRowActive(r)) continue;
      const when = r.applied_at ?? '';
      if (!newest.has(r.rule_id) || when > (at.get(r.rule_id) ?? '')) {
        newest.set(r.rule_id, r.id);
        at.set(r.rule_id, when);
      }
    }
    return newest;
  }, [ledger]);

  // KPI health summary — every value bound to real backend data.
  const rulesMonitored = ruleNoise.length;
  const healthy = ruleNoise.filter((r) => !r.over_target).length;
  const needsReview = ruleNoise.filter((r) => r.over_target).length;
  const humanProposals = proposals.length;

  const selectedRule = selectedRuleId
    ? ruleNoise.find((r) => r.rule_id === selectedRuleId) ?? null
    : null;

  // --- Rules table columns (bound to rule_noise[]) --------------------------- //
  const ruleColumns = React.useMemo<DataTableColumn<RuleNoise>[]>(
    () => [
      {
        id: 'rule_id',
        header: 'Rule ID',
        lockVisible: true,
        width: '15rem',
        headerClassName: 'min-w-[15rem]',
        className: 'min-w-[15rem] max-w-[18rem]',
        cell: (r) => (
          <InlineCode className="inline-block max-w-full whitespace-normal break-words leading-relaxed">
            {r.rule_id}
          </InlineCode>
        ),
      },
      {
        id: 'samples',
        header: 'Samples',
        align: 'right',
        width: '7rem',
        className: 'min-w-[7rem]',
        cell: (r) => <span className="tabular-nums">{fmtNumber(r.total)}</span>,
      },
      {
        id: 'observed',
        header: 'Observed FP rate',
        align: 'right',
        width: '9rem',
        className: 'min-w-[9rem]',
        cell: (r) => (
          <span className="tabular-nums">{fmtPercent(observedFpRate(r.total, r.fp))}</span>
        ),
      },
      {
        id: 'wilson',
        header: 'Wilson lower bound (95%)',
        align: 'right',
        width: '12rem',
        className: 'min-w-[12rem]',
        cell: (r) => (
          <span className="font-medium tabular-nums">{fmtPercent(r.fp_rate)}</span>
        ),
      },
      {
        id: 'knob',
        header: 'Current threshold / knob',
        width: '13rem',
        className: 'min-w-[13rem]',
        cell: (r) => {
          const rec = recByRule.get(r.rule_id);
          if (!rec) return <span className="text-muted-foreground">{DASH}</span>;
          return (
            <div className="flex flex-col gap-0.5">
              <span className="text-sm">{KIND_LABELS[rec.kind] ?? humanizeToken(rec.kind)}</span>
              <span className="text-xs text-muted-foreground tabular-nums">
                now {tuneValue(rec.before)}
              </span>
            </div>
          );
        },
      },
      {
        id: 'change',
        header: 'Proposed change (Δ)',
        width: '12rem',
        className: 'min-w-[12rem]',
        cell: (r) => {
          const rec = recByRule.get(r.rule_id);
          if (!rec) return <span className="text-muted-foreground">{DASH}</span>;
          const delta = tuneDelta(rec.before, rec.after);
          return (
            <div className="flex items-center gap-2">
              <ChangeArrow before={rec.before} after={rec.after} />
              {delta ? (
                <span className="text-xs font-medium tabular-nums text-muted-foreground">
                  {delta}
                </span>
              ) : null}
            </div>
          );
        },
      },
      {
        id: 'shadow',
        header: 'Shadow result',
        width: '11rem',
        className: 'min-w-[11rem]',
        cell: (r) => {
          const rec = recByRule.get(r.rule_id);
          if (!rec) return <span className="text-muted-foreground">{DASH}</span>;
          return <ShadowChip blocked={rec.shadow_blocked} />;
        },
      },
      {
        id: 'last_tuned',
        header: 'Last tuned (UTC)',
        align: 'right',
        width: '12rem',
        className: 'min-w-[12rem]',
        cell: (r) => (
          <span className="text-xs text-muted-foreground tabular-nums">
            {fmtUtc(lastTunedByRule.get(r.rule_id))}
          </span>
        ),
      },
      {
        id: 'state',
        header: 'State',
        width: '10rem',
        className: 'min-w-[10rem]',
        cell: (r) =>
          r.over_target ? (
            <Badge variant="high">
              <AlertTriangle className="h-3 w-3" aria-hidden />
              Needs review
            </Badge>
          ) : (
            <Badge variant="success">
              <ShieldCheck className="h-3 w-3" aria-hidden />
              Healthy
            </Badge>
          ),
      },
    ],
    [recByRule, lastTunedByRule],
  );

  // --- Proposed-changes columns (SAFE recommendations, per-row Apply) -------- //
  const safeRecColumns = React.useMemo<DataTableColumn<TuningRecommendation>[]>(
    () => [
      {
        id: 'rule_id',
        header: 'Rule',
        lockVisible: true,
        width: '18rem',
        headerClassName: 'min-w-[18rem]',
        className: 'min-w-[18rem] max-w-[22rem]',
        cell: (r) => (
          <div className="flex flex-col gap-0.5">
            <InlineCode className="inline-block max-w-full whitespace-normal break-words leading-relaxed">
              {r.rule_id}
            </InlineCode>
            <span className="text-xs text-muted-foreground">
              {KIND_LABELS[r.kind] ?? humanizeToken(r.kind)}
            </span>
          </div>
        ),
      },
      {
        id: 'change',
        header: 'Proposed change (Δ)',
        cell: (r) => {
          const delta = tuneDelta(r.before, r.after);
          return (
            <div className="flex items-center gap-2">
              <ChangeArrow before={r.before} after={r.after} />
              {delta ? (
                <span className="text-xs font-medium tabular-nums text-muted-foreground">
                  {delta}
                </span>
              ) : null}
            </div>
          );
        },
      },
      {
        id: 'noise',
        header: 'FP rate / samples',
        align: 'right',
        cell: (r) => (
          <div className="flex flex-col items-end tabular-nums">
            <span className="font-medium">{fmtPercent(r.fp_rate)}</span>
            <span className="text-xs text-muted-foreground">{fmtNumber(r.samples)} samples</span>
          </div>
        ),
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
          const rowBusy = busyRow === `${r.rule_id}:${r.kind}`;
          return (
            <Can resource="automation" action="manage">
              <Button
                size="sm"
                variant="outline"
                disabled={rowBusy}
                onClick={() => applyRule(r)}
              >
                {rowBusy ? (
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
    [applyRule, busyRow],
  );

  // --- Audit-history (ledger) columns ---------------------------------------- //
  const ledgerColumns = React.useMemo<DataTableColumn<TuningLedgerRow>[]>(
    () => [
      {
        id: 'rule_id',
        header: 'Rule',
        lockVisible: true,
        width: '15rem',
        headerClassName: 'min-w-[15rem]',
        className: 'min-w-[15rem] max-w-[18rem]',
        cell: (r) => (
          <InlineCode className="inline-block max-w-full whitespace-normal break-words leading-relaxed">
            {r.rule_id}
          </InlineCode>
        ),
      },
      {
        id: 'target',
        header: 'Knob',
        cell: (r) => (
          <span className="text-xs text-muted-foreground">
            {KIND_LABELS[r.target] ?? humanizeToken(r.target)}
          </span>
        ),
      },
      {
        id: 'change',
        header: 'From → To',
        cell: (r) => <ChangeArrow before={r.before} after={r.after} />,
      },
      {
        id: 'delta',
        header: 'Δ',
        align: 'right',
        cell: (r) => {
          const delta = tuneDelta(r.before, r.after);
          return (
            <span className="text-xs font-medium tabular-nums text-muted-foreground">
              {delta ?? DASH}
            </span>
          );
        },
      },
      {
        id: 'reason',
        header: 'Reason',
        cell: (r) =>
          r.rationale ? (
            <span className="text-xs text-muted-foreground">{r.rationale}</span>
          ) : (
            <span className="text-muted-foreground">{DASH}</span>
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
        id: 'state',
        // BUG #12: derive the REAL per-row state from the ledger record
        // (`rolled_back`/`rolled_back_at`) — the backend never emits an `active` field.
        header: 'Result',
        cell: (r) =>
          isLedgerRowActive(r) ? (
            <Badge variant="info">Active</Badge>
          ) : (
            <Badge variant="secondary">Rolled back</Badge>
          ),
      },
      {
        id: 'actions',
        header: '',
        align: 'right',
        // Only the NEWEST ACTIVE (not-yet-rolled-back) row per rule offers a rollback —
        // the backend reverses the most-recent active record for the rule_id (#12/#13).
        cell: (r) =>
          isLedgerRowActive(r) && newestActiveRowByRule.get(r.rule_id) === r.id ? (
            <Can resource="automation" action="manage">
              <Button
                size="sm"
                variant="ghost"
                disabled={busyRow === r.id}
                onClick={() => rollbackRule(r.rule_id, r.id)}
              >
                {busyRow === r.id ? (
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
    [busyRow, rollbackRule, newestActiveRowByRule],
  );

  const kpis: Array<{
    label: string;
    value: number;
    sub: string;
    icon: typeof Radar;
    accent: KpiAccent;
  }> = [
    {
      label: 'Rules monitored',
      value: rulesMonitored,
      sub: 'With closed-case feedback',
      icon: Radar,
      accent: 'primary',
    },
    {
      label: 'Healthy',
      value: healthy,
      sub: 'Within the FP-rate target',
      icon: ShieldCheck,
      accent: 'success',
    },
    {
      label: 'Needs review',
      value: needsReview,
      sub: 'Above the FP-rate target',
      icon: AlertTriangle,
      accent: 'high',
    },
    {
      label: 'Human proposals',
      value: humanProposals,
      sub: 'Routed to Approvals',
      icon: ShieldAlert,
      accent: 'high',
    },
  ];

  // Page-clamped slice of the rules table.
  const pageCount = Math.max(1, Math.ceil(ruleNoise.length / pageSize));
  const curPage = Math.min(page, pageCount);
  const pageRows = ruleNoise.slice((curPage - 1) * pageSize, curPage * pageSize);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={SlidersHorizontal}
        eyebrow="Automation"
        title="Auto-tuning"
        description="Safe, human-reviewed adjustments to detection rules."
        actions={
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw
              className={loading ? 'mr-1.5 h-4 w-4 animate-spin' : 'mr-1.5 h-4 w-4'}
              aria-hidden
            />
            Refresh
          </Button>
        }
      />

      {/* HONEST FRAMING (#3) — tuning never closes a case. */}
      <Alert>
        <Info className="h-4 w-4" aria-hidden />
        <AlertTitle>
          Tuning only changes what gets investigated — never how a case is decided.
        </AlertTitle>
        <AlertDescription>
          The tuner adjusts detection volume (a correlation rule&apos;s threshold, a feed&apos;s
          severity floor) so noisy rules surface fewer false positives. It never closes,
          escalates, or changes the verdict of a case — that decision stays deterministic. A
          suppression (drop) proposal is never auto-applied; it is routed to the Approvals
          queue for a human to review.
        </AlertDescription>
      </Alert>

      {error ? (
        <LoadError
          error={error}
          title="Could not load tuning data"
          fallback="Could not load tuning data."
          onRetry={() => void load()}
        />
      ) : (
        <>
          {/* Health summary */}
          <section aria-label="Health summary" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {kpis.map((k) => (
              <KpiTile
                key={k.label}
                label={k.label}
                value={loading ? DASH : fmtNumber(k.value)}
                sub={k.sub}
                icon={k.icon}
                accent={k.accent}
              />
            ))}
          </section>

          <div className="grid items-start gap-4 2xl:grid-cols-[minmax(0,1fr)_22rem]">
            {/* Left: rules + detail */}
            <div className="min-w-0 space-y-4">
              {/* Proposed changes (SAFE recommendations, per-row Apply) */}
              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold tracking-tight text-foreground">
                    Proposed changes
                  </h2>
                  <HelpTip
                    label="How proposed changes are computed"
                    text={
                      'Each proposed change is a pure dry-run: the tuner accumulates a Wilson lower-bound false-positive rate over the trailing window of closed cases and proposes a bounded integer change to a correlation threshold or a feed severity floor. Nothing is written until you Apply. Shadow-eval re-checks a change against recent data and blocks it if it would have hidden a true positive.'
                    }
                  />
                  {data ? (
                    <span className="text-xs text-muted-foreground">
                      over {fmtNumber(data.window_cases)} closed cases
                    </span>
                  ) : null}
                </div>
                <DataTable
                  columns={safeRecColumns}
                  rows={safeRecs}
                  getRowId={(r) => `${r.rule_id}:${r.kind}`}
                  loading={loading}
                  ariaLabel="Proposed tuning changes"
                  empty={
                    <EmptyState
                      icon={SlidersHorizontal}
                      title="No proposed changes"
                      description="No rule currently clears the noise bar for a bounded auto-appliable change. Rules with enough closed-case samples appear here when their false-positive rate exceeds the target."
                      compact
                    />
                  }
                />
              </section>

              {/* Rules health table */}
              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold tracking-tight text-foreground">Rules</h2>
                  <span className="text-xs text-muted-foreground">
                    Select a rule to inspect its noise picture and history.
                  </span>
                </div>
                <DataTable
                  columns={ruleColumns}
                  rows={pageRows}
                  getRowId={(r) => r.rule_id}
                  loading={loading}
                  ariaLabel="Monitored rules"
                  selected={selectedRuleId ? [selectedRuleId] : []}
                  onRowClick={(r) =>
                    setSelectedRuleId((cur) => (cur === r.rule_id ? null : r.rule_id))
                  }
                  page={curPage}
                  pageSize={pageSize}
                  total={ruleNoise.length}
                  onPageChange={setPage}
                  onPageSizeChange={(n) => {
                    setPageSize(n);
                    setPage(1);
                  }}
                  empty={
                    <EmptyState
                      icon={Radar}
                      title="No rules monitored yet"
                      description="Rules appear here once they have accumulated closed-case feedback. A cold tenant with too few closed cases simply shows nothing until the tuner has data."
                      compact
                    />
                  }
                />
              </section>

              {/* Rule detail panel (read-only inspection of the selected rule) */}
              {selectedRule ? (
                <RuleDetailPanel
                  rule={selectedRule}
                  rec={recByRule.get(selectedRule.rule_id)}
                  history={ledger.filter((l) => l.rule_id === selectedRule.rule_id)}
                  onClose={() => setSelectedRuleId(null)}
                />
              ) : null}
            </div>

            {/* Right: pending proposals + rollback confirmation */}
            <div className="space-y-4">
              <PendingProposals proposals={proposals} onOpenApprovals={() => navigate('approvals')} />

              {lastRollback ? (
                <section
                  className="rounded-lg border border-success/30 bg-success/5 p-4"
                  aria-label="Rollback confirmation"
                >
                  <div className="flex items-start gap-3">
                    <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden />
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="text-sm font-semibold text-success-text">Rollback successful</p>
                      <p className="text-xs text-muted-foreground">
                        Reversed the latest change for <InlineCode>{lastRollback.ruleId}</InlineCode>
                        {lastRollback.recordId ? (
                          <>
                            {' '}
                            (record <InlineCode>{lastRollback.recordId}</InlineCode>)
                          </>
                        ) : null}
                        . The knob is back to its prior value.
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label="Dismiss rollback confirmation"
                      onClick={() => setLastRollback(null)}
                    >
                      <X className="h-4 w-4" aria-hidden />
                    </Button>
                  </div>
                </section>
              ) : null}
            </div>
          </div>

          {/* Audit history (global ledger + per-rule rollback) */}
          {ledger.length ? (
            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold tracking-tight text-foreground">
                  Audit history
                </h2>
                <span className="text-xs text-muted-foreground">
                  Every applied change is append-only; rollback reverses the newest active
                  change for a rule.
                </span>
              </div>
              <DataTable
                columns={ledgerColumns}
                rows={ledger}
                getRowId={(r) => r.id}
                ariaLabel="Applied tuning changes"
              />
            </section>
          ) : null}

          {/* The editable config renders ONLY after a successful load, so a load FAILURE
              never leaves a DEFAULT policy form whose Save would clobber the real,
              never-loaded policy (#14). */}
          {loadedOnce ? (
            <>
              <SettingsGrid>
                <SettingsCard
                  anchor="tuning-policy"
                  icon={SlidersHorizontal}
                  title="Tuning policy"
                  description="Controls when the tuner runs and how conservative it is. On by default — it only proposes safe, bounded, shadow-checked changes and never closes a case (#3)."
                  wide="full"
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

                    <div className="grid gap-4 sm:grid-cols-2">
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

                      <Field label="Cadence" description="How often the tuner runs.">
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
                            Re-check a change against recent data; block it if it would hide a true
                            positive.
                          </p>
                        </div>
                        <Switch
                          id="tuning-shadow"
                          checked={draft.shadow_eval}
                          onCheckedChange={(v) => setDraft((d) => ({ ...d, shadow_eval: v }))}
                        />
                      </div>
                    </div>

                    {/* Live "effective config" preview. Advisory presentation only — never
                        calls decide(), never bills an LLM. */}
                    <EffectiveConfigPreview
                      summary={
                        draft.enabled
                          ? `Auto-tune noisy rules ${CADENCE_LABEL[draft.cadence]}: any rule above a ${Math.round(draft.fp_rate_target * 100)}% false-positive rate (≥ ${fmtNumber(draft.min_samples)} samples) gets a bounded +${fmtNumber(draft.max_n_step)} threshold nudge${draft.shadow_eval ? ', shadow-checked first' : ''}.`
                          : 'Auto-tuning is off — proposed changes above are dry-run only until you enable it or Apply one manually.'
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
                        You have read-only access to tuning. Ask a SOC administrator to change the
                        policy.
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
            </>
          ) : null}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Rule detail panel — read-only drill-down on the selected rule.            */
/* ------------------------------------------------------------------------- */

function RuleDetailPanel({
  rule,
  rec,
  history,
  onClose,
}: {
  rule: RuleNoise;
  rec?: TuningRecommendation;
  history: TuningLedgerRow[];
  onClose: () => void;
}) {
  const stats: Array<{ label: string; value: React.ReactNode }> = [
    { label: 'Samples', value: fmtNumber(rule.total) },
    { label: 'Observed FP rate', value: fmtPercent(observedFpRate(rule.total, rule.fp)) },
    { label: 'Wilson LB (95%)', value: fmtPercent(rule.fp_rate) },
    {
      label: 'State',
      value: rule.over_target ? (
        <Badge variant="high">
          <AlertTriangle className="h-3 w-3" aria-hidden />
          Needs review
        </Badge>
      ) : (
        <Badge variant="success">
          <ShieldCheck className="h-3 w-3" aria-hidden />
          Healthy
        </Badge>
      ),
    },
  ];

  return (
    <section
      className="space-y-4 rounded-lg border border-border bg-card p-4"
      aria-label={`Detail for rule ${rule.rule_id}`}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Rule detail
          </p>
          <InlineCode>{rule.rule_id}</InlineCode>
        </div>
        <Button size="sm" variant="ghost" aria-label="Close rule detail" onClick={onClose}>
          <X className="h-4 w-4" aria-hidden />
        </Button>
      </header>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="rounded-md border border-border bg-surface-sunken px-3 py-2">
            <dt className="text-xs text-muted-foreground">{s.label}</dt>
            <dd className="mt-1 text-sm font-medium tabular-nums text-foreground">{s.value}</dd>
          </div>
        ))}
      </dl>

      {rec ? (
        <div className="space-y-2 rounded-md border border-border bg-surface-sunken px-3 py-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{KIND_LABELS[rec.kind] ?? humanizeToken(rec.kind)}</span>
            <ChangeArrow before={rec.before} after={rec.after} />
          </div>
          <p className="text-xs text-muted-foreground">
            {REASON_LABELS[rec.reason] ?? humanizeToken(rec.reason)}
          </p>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          No proposed change for this rule right now — it is within the noise bar.
        </p>
      )}

      {history.length ? (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Audit history
          </h3>
          <ul className="space-y-1.5">
            {history.map((h) => (
              <li
                key={h.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border px-3 py-2 text-xs"
              >
                <span className="text-muted-foreground tabular-nums">{fmtUtc(h.applied_at ?? null)}</span>
                <ChangeArrow before={h.before} after={h.after} />
                {isLedgerRowActive(h) ? (
                  <Badge variant="info">Active</Badge>
                ) : (
                  <Badge variant="secondary">Rolled back</Badge>
                )}
                {h.rationale ? (
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{h.rationale}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------------- */
/* Pending human proposals — HITL (suppression / shadow-blocked) → Approvals.*/
/* ------------------------------------------------------------------------- */

function PendingProposals({
  proposals,
  onOpenApprovals,
}: {
  proposals: TuningRecommendation[];
  onOpenApprovals: () => void;
}) {
  if (!proposals.length) {
    return (
      <section
        className="rounded-lg border border-border bg-card p-4"
        aria-label="Pending human proposals"
      >
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-muted-foreground" aria-hidden />
          <h2 className="text-sm font-semibold tracking-tight text-foreground">
            Pending human proposals
          </h2>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          No proposals awaiting a human decision. Suppression and shadow-blocked changes route
          here for review.
        </p>
      </section>
    );
  }

  return (
    <section
      className="space-y-3 rounded-lg border border-warning/30 bg-warning/5 p-4"
      aria-label="Pending human proposals"
    >
      <div className="flex items-center gap-2">
        <ShieldAlert className="h-4 w-4 text-warning-text" aria-hidden />
        <h2 className="text-sm font-semibold tracking-tight text-warning-text">
          Pending human proposals
        </h2>
      </div>
      <p className="text-xs text-muted-foreground">
        Suppression and shadow-blocked changes route here for a human decision — they are never
        auto-applied.
      </p>

      <ul className="space-y-2">
        {proposals.map((p) => (
          <li
            key={`${p.rule_id}:${p.kind}`}
            className="space-y-2 rounded-md border border-border bg-card px-3 py-2.5"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <InlineCode>{p.rule_id}</InlineCode>
              <Badge variant="warning">Needs approval</Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              {REASON_LABELS[p.reason] ?? humanizeToken(p.reason)}
            </p>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>{KIND_LABELS[p.kind] ?? humanizeToken(p.kind)}</span>
              <ChangeArrow before={p.before} after={p.after} />
              <span className="tabular-nums">
                {fmtPercent(p.fp_rate)} · {fmtNumber(p.samples)} samples
              </span>
            </div>
          </li>
        ))}
      </ul>

      {/* Navigation only — routes to the Approvals queue where the actual approve/reject
          happens (that surface is itself RBAC-gated). Not manage-gated here so a
          read-only analyst can still open the queue to view it. */}
      <Button size="sm" variant="outline" className="w-full" onClick={onOpenApprovals}>
        Open Approvals
        <ArrowRight className="ml-1 h-3.5 w-3.5" aria-hidden />
      </Button>
    </section>
  );
}
