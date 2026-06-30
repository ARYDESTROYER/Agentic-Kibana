/**
 * BudgetCard — the LLM cost-budget ceiling editor + live burn-down (Round 3 / F9).
 *
 * Reads GET /api/budget (the ceiling config) + GET /api/budget/status (the live rolling
 * daily/monthly spend vs the ceilings + band), edits the config (PUT /api/budget when
 * the user has `models:manage`), and visualises each window's spend-vs-cap with a
 * band-coloured bar plus a Stage-1 burn-down/sparkline of the trajectory toward the cap.
 *
 * #3: a budget governs ONLY whether an LLM call RUNS (enforced in the gateway, which
 * fails to NEEDS_HUMAN) — it never alters case_manager.decide(). #9: all values here are
 * numeric / controlled labels, rendered as plain text.
 */
import * as React from 'react';
import { Gauge, Loader2, Save, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { fmtMoney } from '@/lib/format';
import { Button } from '@/ui/button';
import { Badge } from '@/ui/badge';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Switch } from '@/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';
import { BurnDownChart, AreaSpark } from '@/soc/components/charts-soc';
import {
  modelsApi,
  type BudgetConfig,
  type BudgetStatus,
  type BudgetWindowStatus,
} from '@/soc/pages/Models.api';

function errMsg(e: unknown, fallback: string): string {
  return e instanceof ApiError && e.message ? e.message : fallback;
}

const BAND_META: Record<string, { label: string; cls: string; bar: string }> = {
  ok: { label: 'OK', cls: 'text-success', bar: 'bg-success' },
  warn: { label: 'Warning', cls: 'text-warning', bar: 'bg-warning' },
  over: { label: 'Over', cls: 'text-critical', bar: 'bg-critical' },
};

/** Build a small monotone burn-down series from a window snapshot: the spend so far
 * plus the cap as the ceiling, projected across the window for a trajectory view. */
export function windowSeries(w: BudgetWindowStatus): { x: string; open: number; closed: number }[] {
  const cap = w.cap ?? 0;
  const spent = w.spent ?? 0;
  // 5 evenly-spaced points: open = remaining headroom, closed = cumulative spend.
  const steps = 5;
  const out: { x: string; open: number; closed: number }[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const f = i / steps;
    const cum = spent * f;
    out.push({
      x: `${Math.round(f * 100)}%`,
      open: cap > 0 ? Math.max(0, cap - cum) : 0,
      closed: cum,
    });
  }
  return out;
}

function WindowRow({ label, w }: { label: string; w: BudgetWindowStatus }) {
  const band = BAND_META[w.band] ?? BAND_META.ok;
  const pct = w.fraction != null ? Math.min(100, Math.max(0, w.fraction * 100)) : null;
  return (
    <div className="space-y-2 rounded-md border border-border bg-surface p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <Badge
          variant={w.band === 'over' ? 'critical' : w.band === 'warn' ? 'warning' : 'success'}
        >
          {band.label}
        </Badge>
      </div>
      <div className="flex items-baseline justify-between text-sm tabular-nums">
        <span className="text-foreground">{fmtMoney(w.spent)}</span>
        <span className="text-xs text-muted-foreground">
          {w.cap != null ? `of ${fmtMoney(w.cap)}` : 'no ceiling'}
        </span>
      </div>
      {/* Band-coloured progress (custom bar so the colour tracks the band). */}
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={`${label} ${pct != null ? Math.round(pct) + '% of ceiling' : 'no ceiling'}`}>
        <div
          className={cn('h-full rounded-full transition-all', band.bar)}
          style={{ width: pct != null ? `${pct}%` : '0%' }}
        />
      </div>
      {w.cap != null && w.cap > 0 ? (
        <BurnDownChart
          data={windowSeries(w)}
          height={120}
          format={(v) => fmtMoney(v)}
          openLabel="Headroom"
          closedLabel="Spent"
          ariaLabel={`${label} burn-down`}
        />
      ) : (
        <AreaSpark
          data={windowSeries(w).map((p) => p.closed)}
          height={40}
          colorToken="primary"
          ariaLabel={`${label} spend trajectory`}
        />
      )}
    </div>
  );
}

export interface BudgetCardProps {
  canManage?: boolean;
}

export function BudgetCard({ canManage = true }: BudgetCardProps) {
  const [config, setConfig] = React.useState<BudgetConfig | null>(null);
  const [status, setStatus] = React.useState<BudgetStatus | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const [b, s] = await Promise.all([
        modelsApi.getBudget(),
        modelsApi.budgetStatus().catch(() => null),
      ]);
      setConfig(b.budget);
      if (s) setStatus(s);
      setDirty(false);
    } catch (e) {
      toast.error(errMsg(e, 'Could not load the budget.'));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const patch = (p: Partial<BudgetConfig>) => {
    setConfig((c) => (c ? { ...c, ...p } : c));
    setDirty(true);
  };

  const save = async () => {
    if (!config) return;
    setBusy(true);
    try {
      const res = await modelsApi.putBudget(config);
      setConfig(res.budget);
      setDirty(false);
      toast.success('Budget saved.');
      // Refresh the live status against the new ceilings.
      const s = await modelsApi.budgetStatus().catch(() => null);
      if (s) setStatus(s);
    } catch (e) {
      toast.error(errMsg(e, 'Could not save the budget.'));
    } finally {
      setBusy(false);
    }
  };

  if (loading && !config) {
    return (
      <div className="rounded-lg border border-border bg-card p-5 text-sm text-muted-foreground">
        Loading budget…
      </div>
    );
  }
  if (!config) return null;

  const numOrEmpty = (v: number | null) => (v == null ? '' : String(v));
  const parseCap = (s: string): number | null => {
    const t = s.trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  return (
    <div className="space-y-5 rounded-lg border border-border bg-card p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Gauge className="h-4 w-4 text-primary" aria-hidden />
          <h2 className="text-sm font-semibold text-foreground">Cost budget</h2>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Enforce ceiling</span>
          <Switch
            checked={config.enabled}
            disabled={!canManage || busy}
            onCheckedChange={(v) => patch({ enabled: v })}
            aria-label="Enforce cost budget"
          />
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        When enabled, the gateway compares rolling spend against these ceilings before each
        LLM call. A block fails the investigation to <strong>needs human</strong> — it never
        changes a case decision.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="budget-daily">Daily ceiling (USD)</Label>
          <Input
            id="budget-daily"
            type="number"
            min={0}
            step="0.5"
            placeholder="no limit"
            value={numOrEmpty(config.daily_usd)}
            disabled={!canManage || busy}
            onChange={(e) => patch({ daily_usd: parseCap(e.target.value) })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="budget-monthly">Monthly ceiling (USD)</Label>
          <Input
            id="budget-monthly"
            type="number"
            min={0}
            step="1"
            placeholder="no limit"
            value={numOrEmpty(config.monthly_usd)}
            disabled={!canManage || busy}
            onChange={(e) => patch({ monthly_usd: parseCap(e.target.value) })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="budget-warn">Soft-warn at</Label>
          <Select
            value={String(config.soft_warn_pct)}
            onValueChange={(v) => patch({ soft_warn_pct: Number(v) })}
          >
            <SelectTrigger id="budget-warn" disabled={!canManage || busy}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[0.5, 0.6, 0.7, 0.8, 0.9].map((p) => (
                <SelectItem key={p} value={String(p)}>
                  {Math.round(p * 100)}% of ceiling
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="budget-exceed">On exceed</Label>
          <Select
            value={config.on_exceed}
            onValueChange={(v) => patch({ on_exceed: v as 'warn' | 'block' })}
          >
            <SelectTrigger id="budget-exceed" disabled={!canManage || busy}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="warn">Warn only</SelectItem>
              <SelectItem value="block">Block further spend</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {config.on_exceed === 'block' && config.enabled ? (
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            Block mode will stop LLM spend when a ceiling is crossed; affected investigations
            route to needs-human.
          </span>
        </div>
      ) : null}

      {canManage ? (
        <div className="flex justify-end">
          <Button onClick={() => void save()} disabled={busy || !dirty}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Save className="h-4 w-4" aria-hidden />}
            Save budget
          </Button>
        </div>
      ) : null}

      {/* --- Live burn-down --- */}
      {status ? (
        <div className="space-y-3 border-t border-border pt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Live spend
          </h3>
          {!status.enabled ? (
            <p className="text-sm text-muted-foreground">
              The budget is currently off — spend is tracked but never blocked.
            </p>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <WindowRow label="Today" w={status.daily} />
            <WindowRow label="This month (30d)" w={status.monthly} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default BudgetCard;
