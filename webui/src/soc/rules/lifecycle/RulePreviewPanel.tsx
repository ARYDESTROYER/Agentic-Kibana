/**
 * RulePreviewPanel (Round-5 G6 · R5) — the single highest-value trust feature: run a
 * detection rule's predicate against 7–14 days of RECENT data and show how many events
 * WOULD have matched, as a match-count histogram.
 *
 * ⛔ THE HARD GUARANTEES (why this panel is safe):
 *  - It reads recent events through the RB `POST /api/rules/preview` endpoint, which
 *    runs on the SCOPED, READ-ONLY, HARD-CAPPED scatter-gather (#1) and evaluates the
 *    PURE predicate in-process. It NEVER calls `decide()` (#3), NEVER creates a case,
 *    NEVER escalates, and — critically — NEVER bills the LLM (#6, ZERO UsageDoc).
 *  - The optional "deterministic what-if" strip calls the PURE `previewDecision`
 *    wrapper (`POST /api/triage/preview-decision`), which re-uses the same pure
 *    `decide()` the pipeline calls and likewise bills nothing (#6).
 *  - Every log-derived value (histogram labels, sample rows) renders PLAIN text (#9).
 *
 * The histogram uses the existing recharts wrappers (`HBarChart`) — recharts is already
 * a dep, so this adds no bundle. Buckets from the server are aggregated to a readable
 * set client-side (a 14-day window at hourly buckets is too many rows to show raw).
 */
import * as React from 'react';
import { FlaskConical, RefreshCw, ShieldCheck } from 'lucide-react';

import { Button } from '@/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Card, CardContent } from '@/ui/card';
import { SegmentedControl } from '@/soc/components/SegmentedControl';
import { HBarChart, type HBarDatum } from '@/soc/components/charts';
import { LoadError } from '@/soc/components/LoadError';

import { previewRule } from '../api';
import type { RuleForm } from '../types';
import { predicatesForPreview } from './preview-adapter';
import type { RulePreviewResult } from './types';

/* -------------------------------------------------- window presets --------- */

interface WindowPreset {
  value: string;
  label: string;
  /** Look-back in days. */
  days: number;
  /** Server histogram bucket width (minutes). */
  bucketMinutes: number;
  /** Client display aggregation (minutes) — coarser than the server bucket. */
  displayMinutes: number;
}

/**
 * 7 and 14 days (RESEARCH_RULES_UX §6b — a window wide enough to capture weekday +
 * weekend). Also a fast 24h for a quick sanity check. Server buckets stay hourly;
 * the client re-aggregates to day buckets for the wide windows so the chart is legible.
 */
const WINDOW_PRESETS: WindowPreset[] = [
  { value: '24h', label: 'Last 24h', days: 1, bucketMinutes: 60, displayMinutes: 60 },
  { value: '7d', label: 'Last 7 days', days: 7, bucketMinutes: 60, displayMinutes: 1440 },
  { value: '14d', label: 'Last 14 days', days: 14, bucketMinutes: 60, displayMinutes: 1440 },
];

/** Format a bucket-start ISO string for the histogram axis (plain, locale-agnostic). */
function bucketLabel(iso: string, displayMinutes: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16);
  if (displayMinutes >= 1440) {
    // day bucket → YYYY-MM-DD
    return d.toISOString().slice(0, 10);
  }
  // hour bucket → MM-DD HH:00 (UTC, deterministic)
  return `${d.toISOString().slice(5, 10)} ${d.toISOString().slice(11, 13)}:00`;
}

/**
 * Re-aggregate the server's histogram (fixed hourly buckets) into coarser display
 * buckets. Pure: floors each bucket-start to `displayMinutes` and sums counts.
 */
function toHistogramData(
  result: RulePreviewResult | null,
  displayMinutes: number,
): HBarDatum[] {
  if (!result || !result.histogram || result.histogram.length === 0) return [];
  const widthMs = Math.max(1, displayMinutes) * 60_000;
  const sums = new Map<number, number>();
  for (const b of result.histogram) {
    const t = new Date(b.bucket).getTime();
    if (Number.isNaN(t)) continue;
    const floored = Math.floor(t / widthMs) * widthMs;
    sums.set(floored, (sums.get(floored) ?? 0) + (b.count || 0));
  }
  return Array.from(sums.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([ms, count]) => ({
      label: bucketLabel(new Date(ms).toISOString(), displayMinutes),
      value: count,
      color: 'hsl(var(--primary))',
    }));
}

/* ---------------------------------------------------------- component ------- */

export interface RulePreviewPanelProps {
  /** The rule form being previewed. Only detection-match rules have a predicate. */
  rule: RuleForm;
  /** Optional source scope (omit for all browse-capable sources). */
  sourceId?: string;
  /** Called after a successful preview so the parent can update the health chip. */
  onResult?: (result: RulePreviewResult) => void;
  /** Called when a preview errors (parent can flag health failed). */
  onError?: (err: unknown) => void;
}

/**
 * The preview panel. Renders a window picker + a "Run preview" button; on run it calls
 * the read-only `previewRule` endpoint and shows a match-count histogram + a summary.
 * Case-automation + anomaly tiers have no flat predicate to preview, so the panel
 * explains that instead of running a meaningless scan.
 */
export function RulePreviewPanel({ rule, sourceId, onResult, onError }: RulePreviewPanelProps) {
  const [windowValue, setWindowValue] = React.useState('7d');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const [result, setResult] = React.useState<RulePreviewResult | null>(null);

  const preset = WINDOW_PRESETS.find((p) => p.value === windowValue) ?? WINDOW_PRESETS[1];
  const predicates = React.useMemo(() => predicatesForPreview(rule), [rule]);
  const previewable = predicates.length > 0;

  const run = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await previewRule({
        match: predicates,
        source_id: sourceId,
        from: `now-${preset.days}d`,
        bucket_minutes: preset.bucketMinutes,
        limit: 1000,
      });
      setResult(res);
      onResult?.(res);
    } catch (e) {
      setError(e);
      onError?.(e);
    } finally {
      setLoading(false);
    }
  }, [predicates, sourceId, preset.days, preset.bucketMinutes, onResult, onError]);

  const histogram = React.useMemo(
    () => toHistogramData(result, preset.displayMinutes),
    [result, preset.displayMinutes],
  );

  if (!previewable) {
    return (
      <Alert variant="info">
        <FlaskConical className="h-4 w-4" aria-hidden />
        <AlertTitle>Preview is for detection rules with conditions</AlertTitle>
        <AlertDescription>
          This tier has no flat predicate to run against recent events. Anomaly rules fire on a
          learned baseline, and case-automation rules react after the deterministic decision — add a
          detection condition to preview a match count.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      {/* the read-only / no-cost guarantee, stated plainly */}
      <Alert variant="info">
        <ShieldCheck className="h-4 w-4" aria-hidden />
        <AlertTitle>Read-only preview — never runs the AI, never changes a case</AlertTitle>
        <AlertDescription>
          Counts how many recent events would have matched this rule, over a scoped, read-only,
          hard-capped read of your sources. It never bills the LLM, never creates a case, and never
          escalates.
        </AlertDescription>
      </Alert>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl
          size="sm"
          aria-label="Preview window"
          value={windowValue}
          onValueChange={setWindowValue}
          options={WINDOW_PRESETS.map((p) => ({ value: p.value, label: p.label }))}
        />
        <Button size="sm" onClick={run} disabled={loading}>
          <RefreshCw className={loading ? 'h-4 w-4 animate-spin motion-essential' : 'h-4 w-4'} aria-hidden />
          {loading ? 'Running…' : 'Run preview'}
        </Button>
      </div>

      {error ? (
        <LoadError error={error} title="Preview failed" fallback="Could not run the preview." onRetry={run} />
      ) : null}

      {result ? (
        <Card padding="sm">
          <CardContent className="space-y-3 pt-4">
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
              <span>
                <span className="text-2xl font-semibold tabular-nums text-foreground">
                  {result.matched.toLocaleString()}
                </span>{' '}
                <span className="text-muted-foreground">matched</span>
              </span>
              <span className="text-muted-foreground">
                of <span className="tabular-nums text-foreground">{result.scanned.toLocaleString()}</span>{' '}
                events scanned
              </span>
              <span className="text-muted-foreground">
                (<span className="tabular-nums">{(result.match_rate * 100).toFixed(1)}%</span> match rate)
              </span>
            </div>

            {result.hard_capped ? (
              <p className="text-xs text-warning-text">
                The scan hit the result cap — the real match count over this window may be higher.
              </p>
            ) : null}

            {histogram.length > 0 ? (
              <div>
                <div className="mb-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Matches over time
                </div>
                <HBarChart
                  data={histogram}
                  labelWidth={96}
                  ariaLabel={`Match-count histogram, ${result.matched} matches across ${histogram.length} buckets`}
                />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No matches in this window — the rule would not have fired.
              </p>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
RulePreviewPanel.displayName = 'RulePreviewPanel';
