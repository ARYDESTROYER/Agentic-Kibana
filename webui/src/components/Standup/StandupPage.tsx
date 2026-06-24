/**
 * Standup — the daily digest.
 *
 * Fetches `GET /api/standup` (which now ALWAYS returns HTTP 200) and renders the
 * model-generated summary in a hero card, followed by defensively-parsed
 * aggregate KPIs, an events-over-time sparkline, and ranked top-N bar lists
 * (rules / source IPs / users / hosts / severity).
 *
 * The endpoint has three shapes, all handled gracefully here:
 *   - disabled  → `enabled:false`            (friendly empty state, not an error)
 *   - happy     → `enabled:true, degraded:false`
 *   - degraded  → `degraded:true, error:"…"` (warning callout + whatever data exists)
 *
 * The `aggregate` shape varies between deployments and may be `{}`, so every
 * access is guarded. The `summary` is model-generated prose, so it is rendered
 * strictly as plain text (`white-space: pre-wrap`) — never as HTML.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EuiBadge,
  EuiButton,
  EuiButtonGroup,
  EuiCallOut,
  EuiCopy,
  EuiFlexGroup,
  EuiFlexItem,
  EuiPanel,
  EuiSpacer,
  EuiText,
  EuiToolTip,
} from '@elastic/eui';
import type { StandupResponse } from '../../lib/types';
import { api } from '../../lib/api';
import { fmtMoney, fmtNumber, humanizeAge, humanizeToken } from '../../lib/format';
import { COLORS, chartColor, tint, verdictHex } from '../../lib/theme';
import { BarList, DonutWithLegend, Sparkline } from '../common/charts';
import type { Segment } from '../common/charts';
import {
  Card,
  EmptyState,
  ErrorCallout,
  IconChip,
  PageHeader,
  Skeleton,
  StatTile,
} from '../common/ui';

/* ------------------------------------------------------- defensive readers -- */

/**
 * Widened local view of the standup response. `types.ts` declares only the
 * stable subset; the hardened backend adds `degraded` / `error` / `cost` /
 * `cases`, which we read here without editing the shared type.
 */
type Standup = StandupResponse & {
  degraded?: boolean;
  error?: string;
  cost?: unknown;
  cases?: unknown;
};

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && !Number.isNaN(v) ? v : undefined;
}

/**
 * Coerce a bucket-list-ish value into ranked chart segments. Handles the
 * canonical `[{key, count}]` shape but also tolerates `{value}`/`{doc_count}`.
 */
function toSegments(v: unknown, palette = false): Segment[] {
  if (!Array.isArray(v)) return [];
  const out: Segment[] = [];
  v.forEach((raw, i) => {
    const b = asRecord(raw);
    const key = b.key ?? b.label ?? b.name;
    const value = asNumber(b.count) ?? asNumber(b.value) ?? asNumber(b.doc_count) ?? asNumber(b.cost);
    if (key === undefined || key === null || value === undefined) return;
    out.push({
      label: String(key),
      value,
      color: palette ? chartColor(i) : undefined,
    });
  });
  return out;
}

/**
 * Coerce an events-over-time bucket list into a plain numeric series for the
 * sparkline. Accepts `[{count}]` / `[{value}]` / `[{doc_count}]` or a raw
 * `number[]`.
 */
function toSeries(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((raw) => {
      if (typeof raw === 'number') return Number.isNaN(raw) ? 0 : raw;
      const b = asRecord(raw);
      return asNumber(b.count) ?? asNumber(b.value) ?? asNumber(b.doc_count) ?? 0;
    })
    .filter((n): n is number => typeof n === 'number');
}

const WINDOWS = [
  { id: '24', label: '24h', hours: 24 },
  { id: '168', label: '7d', hours: 168 },
] as const;

/** Pick the closest preset window id for a configured `window_hours` (qu40). */
function seedWindowId(hours?: number): string {
  if (typeof hours !== 'number' || !Number.isFinite(hours)) return '24';
  // Snap to whichever preset is nearest the configured value.
  let best: { id: string; hours: number } = WINDOWS[0];
  for (const w of WINDOWS) {
    if (Math.abs(w.hours - hours) < Math.abs(best.hours - hours)) best = w;
  }
  return best.id;
}

/** Read a `{key,count}`-ish bucket list into a `{key: count}` map (lowercased). */
function bucketMap(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!Array.isArray(v)) return out;
  v.forEach((raw) => {
    const b = asRecord(raw);
    const key = b.key;
    const count = asNumber(b.count) ?? asNumber(b.value) ?? asNumber(b.doc_count);
    if (key === undefined || key === null || count === undefined) return;
    out[String(key).toLowerCase()] = count;
  });
  return out;
}

export const StandupPage: React.FC = () => {
  const [windowId, setWindowId] = useState<string>('24');
  const [windowSeeded, setWindowSeeded] = useState(false);
  const [data, setData] = useState<Standup | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const requestedHours = useMemo(
    () => WINDOWS.find((w) => w.id === windowId)?.hours ?? 24,
    [windowId],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData((await api.standup(requestedHours)) as Standup);
    } catch (e) {
      // The backend now always returns 200; this only fires for transport-level
      // failures (backend unreachable). Surface it as a real error.
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [requestedHours]);

  // Seed the window from prefs.standup.window_hours once, before the first load
  // settles on a window (qu40). Best-effort — a failure leaves the 24h default.
  useEffect(() => {
    let cancelled = false;
    void api
      .getSettings()
      .then((s) => {
        if (cancelled) return;
        const hrs = s?.prefs?.standup?.window_hours;
        if (typeof hrs === 'number') setWindowId(seedWindowId(hrs));
      })
      .catch(() => {
        /* prefs are advisory here; keep the default window. */
      })
      .finally(() => {
        if (!cancelled) setWindowSeeded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Defer the first fetch until the window has been seeded so we don't load
  // 24h then immediately reload the configured window.
  useEffect(() => {
    if (windowSeeded) void load();
  }, [load, windowSeeded]);

  const agg = useMemo(() => asRecord(data?.aggregate), [data]);

  const totalEvents = asNumber(agg.total_events);
  const uniqueIps = asNumber(agg.unique_ips);
  // `cases` may sit at the top level OR inside `aggregate` depending on the
  // backend shape — try both.
  const cases = useMemo(
    () => ({ ...asRecord(agg.cases), ...asRecord(data?.cases) }),
    [agg, data],
  );
  const casesOpened = asNumber(cases.opened);
  // The backend never emits `cases.closed`; derive it from the `by_status`
  // breakdown (status:"closed") instead (qu18). Falls back to undefined.
  const statusMap = useMemo(() => bucketMap(cases.by_status), [cases]);
  const casesClosed = useMemo(() => {
    if (typeof cases.closed === 'number') return cases.closed as number;
    const keys = Object.keys(statusMap);
    if (!keys.length) return undefined;
    return statusMap.closed ?? 0;
  }, [cases, statusMap]);

  // Case outcomes (verdict mix) for the donut (qu19), from cases.by_verdict.
  const outcomes = useMemo<Segment[]>(() => {
    const m = bucketMap(cases.by_verdict);
    return Object.entries(m)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => ({ label: humanizeToken(k), value: v, color: verdictHex(k) }))
      .sort((a, b) => b.value - a.value);
  }, [cases]);
  const outcomesTotal = useMemo(
    () => outcomes.reduce((s, o) => s + o.value, 0),
    [outcomes],
  );

  const byRule = useMemo(() => toSegments(agg.by_rule, true), [agg]);
  const topIps = useMemo(() => toSegments(agg.top_source_ips), [agg]);
  const topUsers = useMemo(() => toSegments(agg.top_users), [agg]);
  const topHosts = useMemo(() => toSegments(agg.top_hosts), [agg]);
  const bySeverity = useMemo(() => toSegments(agg.by_severity, true), [agg]);
  const series = useMemo(() => toSeries(agg.events_over_time), [agg]);

  const window = asNumber(data?.window_hours) ?? requestedHours;
  const windowLabel = window >= 168 ? `${Math.round(window / 24)}d` : `${window}h`;

  const disabled = data?.enabled === false;
  const degraded = data?.degraded === true;
  const degradedNote =
    (typeof data?.error === 'string' && data.error.trim()) || 'Running on limited data.';

  const cost = asNumber(data?.cost);

  const hasAggregate =
    totalEvents !== undefined ||
    byRule.length > 0 ||
    topIps.length > 0 ||
    topUsers.length > 0 ||
    topHosts.length > 0 ||
    bySeverity.length > 0;

  const summaryText = data?.summary?.trim() ?? '';
  const hasSummary = summaryText.length > 0;

  // A standup with a `generated_at` is a cached artifact; the button re-fetches
  // it rather than forcing a fresh generation, so it reads "Refresh" (qu40).
  const isCached = typeof data?.generated_at === 'string' && data.generated_at.length > 0;
  const refreshLabel = isCached ? 'Refresh' : 'Regenerate';

  /**
   * A Markdown rendering of the digest for the "Copy digest" action — the prose
   * summary plus the headline aggregate facts and top-N breakdowns. All values
   * are log-derived but copied as plain Markdown text (never executed).
   */
  const digestMarkdown = useMemo(() => {
    const lines: string[] = [];
    lines.push(`# Standup — last ${windowLabel}`);
    if (data?.generated_at) lines.push(`_Generated ${humanizeAge(data.generated_at)}_`);
    lines.push('');
    if (summaryText) {
      lines.push(summaryText);
      lines.push('');
    }
    const facts: string[] = [];
    if (totalEvents !== undefined) facts.push(`- Events: ${fmtNumber(totalEvents)}`);
    if (uniqueIps !== undefined) facts.push(`- Unique source IPs: ${fmtNumber(uniqueIps)}`);
    if (casesOpened !== undefined) facts.push(`- Cases opened: ${fmtNumber(casesOpened)}`);
    if (casesClosed !== undefined) facts.push(`- Cases closed: ${fmtNumber(casesClosed)}`);
    if (cost !== undefined && cost > 0) facts.push(`- LLM cost: ${fmtMoney(cost)}`);
    if (facts.length) {
      lines.push('## Headline');
      lines.push(...facts);
      lines.push('');
    }
    const section = (title: string, segs: Segment[]) => {
      if (!segs.length) return;
      lines.push(`## ${title}`);
      segs.slice(0, 8).forEach((s) => lines.push(`- ${s.label}: ${fmtNumber(s.value)}`));
      lines.push('');
    };
    section('Case outcomes', outcomes);
    section('Top rules', byRule);
    section('Top source IPs', topIps);
    section('Top users', topUsers);
    section('Top hosts', topHosts);
    return lines.join('\n').trim();
  }, [
    windowLabel,
    data,
    summaryText,
    totalEvents,
    uniqueIps,
    casesOpened,
    casesClosed,
    cost,
    outcomes,
    byRule,
    topIps,
    topUsers,
    topHosts,
  ]);

  return (
    <div className="socPageEnter">
      <PageHeader
        icon="visText"
        eyebrow="Daily digest"
        title="Standup"
        description="The daily aggregate digest, summarised from log activity."
        actions={
          <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false} wrap>
            <EuiFlexItem grow={false}>
              <EuiButtonGroup
                legend="Digest window"
                buttonSize="s"
                isDisabled={loading}
                options={WINDOWS.map((w) => ({ id: w.id, label: w.label }))}
                idSelected={windowId}
                onChange={(id) => setWindowId(id)}
              />
            </EuiFlexItem>
            {hasSummary ? (
              <EuiFlexItem grow={false}>
                <EuiCopy textToCopy={summaryText}>
                  {(copy) => (
                    <EuiButton size="s" iconType="copyClipboard" onClick={copy}>
                      Copy summary
                    </EuiButton>
                  )}
                </EuiCopy>
              </EuiFlexItem>
            ) : null}
            {digestMarkdown ? (
              <EuiFlexItem grow={false}>
                <EuiCopy textToCopy={digestMarkdown}>
                  {(copy) => (
                    <EuiToolTip content="Copy the full digest as Markdown">
                      <EuiButton size="s" iconType="copy" onClick={copy}>
                        Copy digest
                      </EuiButton>
                    </EuiToolTip>
                  )}
                </EuiCopy>
              </EuiFlexItem>
            ) : null}
            <EuiFlexItem grow={false}>
              <EuiButton
                size="s"
                fill
                iconType="refresh"
                onClick={() => void load()}
                isLoading={loading}
              >
                {refreshLabel}
              </EuiButton>
            </EuiFlexItem>
          </EuiFlexGroup>
        }
      />

      {/* Transport-level failure (backend unreachable) — the only real error path. */}
      {error ? (
        <>
          <ErrorCallout error={error} title="Could not reach the standup service" />
          <EuiSpacer size="m" />
        </>
      ) : null}

      {loading ? (
        <>
          <EuiPanel hasBorder paddingSize="l" className="socCard">
            <Skeleton height={20} width="40%" />
            <EuiSpacer size="m" />
            <Skeleton rows={4} height={14} />
          </EuiPanel>
          <EuiSpacer size="l" />
          <EuiFlexGroup gutterSize="m" wrap responsive={false}>
            {[0, 1, 2, 3].map((i) => (
              <EuiFlexItem key={i} style={{ minWidth: 200 }}>
                <Skeleton height={84} radius={8} />
              </EuiFlexItem>
            ))}
          </EuiFlexGroup>
        </>
      ) : disabled ? (
        <EmptyState
          iconType="visText"
          title="Standup is turned off"
          body={
            <>
              The daily digest is disabled. Enable it under{' '}
              <strong>Settings → Standup</strong> to start generating a summary of
              recent log activity.
            </>
          }
        />
      ) : (
        <>
          {/* Degraded note — non-alarming, still renders whatever data exists. */}
          {degraded ? (
            <>
              <EuiCallOut
                color="warning"
                iconType="warning"
                size="s"
                title="Generated from limited data"
              >
                <p style={{ margin: 0 }}>{degradedNote}</p>
              </EuiCallOut>
              <EuiSpacer size="m" />
            </>
          ) : null}

          {/* Hero summary card — always shown. */}
          <EuiPanel
            hasBorder
            paddingSize="l"
            className="socCard"
            style={{ borderLeft: `4px solid ${COLORS.accent}` }}
          >
            <EuiFlexGroup gutterSize="m" alignItems="flexStart" responsive={false}>
              <EuiFlexItem grow={false}>
                <IconChip icon="documentEdit" accent={COLORS.accent} large />
              </EuiFlexItem>
              <EuiFlexItem>
                <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false} wrap>
                  <EuiFlexItem grow={false}>
                    <EuiBadge
                      color={tint(COLORS.accent, 0.16)}
                      style={{ color: COLORS.accent }}
                      iconType="clock"
                    >
                      {windowLabel} window
                    </EuiBadge>
                  </EuiFlexItem>
                  {data?.generated_at ? (
                    <EuiFlexItem grow={false}>
                      <EuiText size="xs" color="subdued">
                        <span>generated {humanizeAge(data.generated_at)}</span>
                      </EuiText>
                    </EuiFlexItem>
                  ) : null}
                  {cost !== undefined && cost > 0 ? (
                    <EuiFlexItem grow={false}>
                      <EuiBadge color="hollow" iconType="currency">
                        {fmtMoney(cost)}
                      </EuiBadge>
                    </EuiFlexItem>
                  ) : null}
                </EuiFlexGroup>
                <EuiSpacer size="s" />
                {hasSummary ? (
                  <EuiText size="m">
                    {/* Model-generated prose — rendered strictly as plain text. */}
                    <p style={{ whiteSpace: 'pre-wrap', lineHeight: 1.65, margin: 0 }}>
                      {summaryText}
                    </p>
                  </EuiText>
                ) : (
                  <EuiText size="s" color="subdued">
                    <p style={{ margin: 0 }}>
                      No summary is available for this window yet. Try regenerating, or
                      widen the window.
                    </p>
                  </EuiText>
                )}
              </EuiFlexItem>
            </EuiFlexGroup>
          </EuiPanel>

          {/* Case outcomes — verdict mix of the cases opened in this window (qu19). */}
          {outcomes.length ? (
            <>
              <EuiSpacer size="l" />
              <Card title="Case outcomes" icon="visPie" accent={COLORS.accent}>
                <EuiText size="xs" color="subdued">
                  <span>Verdict mix of the {fmtNumber(outcomesTotal)} cases opened this window</span>
                </EuiText>
                <EuiSpacer size="s" />
                <DonutWithLegend
                  segments={outcomes}
                  centerValue={fmtNumber(outcomesTotal)}
                  centerLabel="cases"
                  title="Case outcomes by verdict"
                  format={fmtNumber}
                />
              </Card>
            </>
          ) : null}

          {hasAggregate ? (
            <>
              <EuiSpacer size="l" />

              {/* Headline KPI tiles. */}
              <EuiFlexGroup gutterSize="m" wrap>
                <EuiFlexItem style={{ minWidth: 200 }}>
                  <StatTile
                    label="Events"
                    value={totalEvents !== undefined ? fmtNumber(totalEvents) : '—'}
                    icon="visBarVerticalStacked"
                    accent={COLORS.primary}
                    sub={`last ${windowLabel}`}
                  />
                </EuiFlexItem>
                <EuiFlexItem style={{ minWidth: 200 }}>
                  <StatTile
                    label="Unique source IPs"
                    value={uniqueIps !== undefined ? fmtNumber(uniqueIps) : '—'}
                    icon="globe"
                    accent={COLORS.accent}
                  />
                </EuiFlexItem>
                <EuiFlexItem style={{ minWidth: 200 }}>
                  <StatTile
                    label="Cases opened"
                    value={casesOpened !== undefined ? fmtNumber(casesOpened) : '—'}
                    icon="folderOpen"
                    accent={COLORS.warning}
                  />
                </EuiFlexItem>
                <EuiFlexItem style={{ minWidth: 200 }}>
                  <StatTile
                    label="Cases closed"
                    value={casesClosed !== undefined ? fmtNumber(casesClosed) : '—'}
                    icon="check"
                    accent={COLORS.success}
                  />
                </EuiFlexItem>
              </EuiFlexGroup>

              {/* Activity trend — only when we have a usable series. */}
              {series.length > 1 ? (
                <>
                  <EuiSpacer size="l" />
                  <Card title="Event activity" icon="visLine" accent={COLORS.primary}>
                    <EuiText size="xs" color="subdued">
                      <span>Events over the {windowLabel} window</span>
                    </EuiText>
                    <EuiSpacer size="s" />
                    <Sparkline
                      values={series}
                      color={COLORS.primary}
                      height={64}
                      title={`Event activity over the ${windowLabel} window`}
                    />
                  </Card>
                </>
              ) : null}

              <EuiSpacer size="l" />

              {/* Ranked top-N breakdowns. */}
              <div className="socGrid">
                {byRule.length ? (
                  <Card title="Top rules" icon="tag" accent={COLORS.warning}>
                    <BarList items={byRule.slice(0, 8)} format={fmtNumber} title="Top rules by event count" />
                  </Card>
                ) : null}
                {topIps.length ? (
                  <Card title="Top source IPs" icon="globe" accent={COLORS.primary}>
                    <BarList items={topIps.slice(0, 8)} format={fmtNumber} title="Top source IPs by event count" />
                  </Card>
                ) : null}
                {topUsers.length ? (
                  <Card title="Top users" icon="user" accent={COLORS.accent}>
                    <BarList items={topUsers.slice(0, 8)} format={fmtNumber} title="Top users by event count" />
                  </Card>
                ) : null}
                {topHosts.length ? (
                  <Card title="Top hosts" icon="storage" accent={COLORS.success}>
                    <BarList items={topHosts.slice(0, 8)} format={fmtNumber} title="Top hosts by event count" />
                  </Card>
                ) : null}
                {bySeverity.length ? (
                  <Card title="By severity" icon="alert" accent={COLORS.danger}>
                    <BarList
                      items={bySeverity.map((s) => ({ ...s, label: humanizeToken(s.label) }))}
                      format={fmtNumber}
                      title="Events by severity"
                    />
                  </Card>
                ) : null}
              </div>
            </>
          ) : (
            <>
              <EuiSpacer size="l" />
              <EmptyState
                iconType="visText"
                title="No activity in this window"
                body={
                  degraded
                    ? 'The standup ran on limited data and could not break down any aggregate activity.'
                    : 'The standup ran but found no aggregated log activity to break down for this window.'
                }
              />
            </>
          )}
        </>
      )}
    </div>
  );
};
