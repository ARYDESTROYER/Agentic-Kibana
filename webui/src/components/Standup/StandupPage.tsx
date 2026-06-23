/**
 * Standup — the daily digest. Fetches GET /api/standup and renders the generated
 * summary in a hero card, followed by defensively-parsed aggregate stats and
 * top-N bar lists (rules / source IPs / users / hosts). The aggregate shape may
 * vary between deployments, so every access is guarded.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EuiBadge,
  EuiButton,
  EuiCallOut,
  EuiCopy,
  EuiFlexGroup,
  EuiFlexItem,
  EuiPanel,
  EuiSpacer,
  EuiText,
} from '@elastic/eui';
import type { StandupResponse } from '../../lib/types';
import { api } from '../../lib/api';
import { fmtNumber, humanizeAge, humanizeToken } from '../../lib/format';
import { COLORS, chartColor, tint } from '../../lib/theme';
import { BarList } from '../common/charts';
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

export const StandupPage: React.FC = () => {
  const [data, setData] = useState<StandupResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.standup(24));
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const agg = useMemo(() => asRecord(data?.aggregate), [data]);

  const totalEvents = asNumber(agg.total_events);
  const uniqueIps = asNumber(agg.unique_ips);
  const cases = asRecord(agg.cases);
  const casesOpened = asNumber(cases.opened);

  const byRule = useMemo(() => toSegments(agg.by_rule, true), [agg]);
  const topIps = useMemo(() => toSegments(agg.top_source_ips), [agg]);
  const topUsers = useMemo(() => toSegments(agg.top_users), [agg]);
  const topHosts = useMemo(() => toSegments(agg.top_hosts), [agg]);
  const bySeverity = useMemo(() => toSegments(agg.by_severity, true), [agg]);

  const window = asNumber(data?.window_hours) ?? 24;
  const hasAggregate =
    totalEvents !== undefined ||
    byRule.length > 0 ||
    topIps.length > 0 ||
    topUsers.length > 0 ||
    topHosts.length > 0;

  const summaryText = data?.summary?.trim() ?? '';
  const hasSummary = summaryText.length > 0;

  // NOTE: the local `window` (window-hours) above shadows the global `window`,
  // so reach the browser print via globalThis to keep this type-safe.
  const printSummary = useCallback(() => {
    if (typeof globalThis !== 'undefined' && typeof globalThis.print === 'function') {
      globalThis.print();
    }
  }, []);

  return (
    <div className="socPageEnter">
      <PageHeader
        icon="visText"
        eyebrow="Daily digest"
        title="Standup"
        description="The daily aggregate digest, summarised from log activity."
        actions={
          <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false} wrap>
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
            {hasSummary ? (
              <EuiFlexItem grow={false}>
                <EuiButton size="s" iconType="documents" onClick={printSummary}>
                  Print
                </EuiButton>
              </EuiFlexItem>
            ) : null}
            <EuiFlexItem grow={false}>
              <EuiButton size="s" iconType="refresh" onClick={() => void load()} isLoading={loading}>
                Regenerate
              </EuiButton>
            </EuiFlexItem>
          </EuiFlexGroup>
        }
      />

      {error ? (
        <>
          <ErrorCallout error={error} title="Could not generate the standup" />
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
      ) : data?.enabled === false ? (
        <EuiCallOut color="primary" iconType="iInCircle" title="Standup is disabled">
          <p>Enable the daily digest in Settings → Standup to start generating it.</p>
        </EuiCallOut>
      ) : (
        <>
          {/* Hero summary */}
          <EuiPanel hasBorder paddingSize="l" className="socCard">
            <EuiFlexGroup gutterSize="m" alignItems="flexStart" responsive={false}>
              <EuiFlexItem grow={false}>
                <IconChip icon="documentEdit" accent={COLORS.accent} large />
              </EuiFlexItem>
              <EuiFlexItem>
                <EuiFlexGroup gutterSize="xs" alignItems="center" responsive={false} wrap>
                  <EuiFlexItem grow={false}>
                    <EuiText size="xs" color="subdued">
                      <span>{window}h window</span>
                    </EuiText>
                  </EuiFlexItem>
                  <EuiFlexItem grow={false}>
                    <EuiBadge
                      color={tint(COLORS.accent, 0.16)}
                      style={{ color: COLORS.accent }}
                      iconType="clock"
                    >
                      generated {humanizeAge(data?.generated_at)}
                    </EuiBadge>
                  </EuiFlexItem>
                </EuiFlexGroup>
                <EuiSpacer size="s" />
                {data?.summary ? (
                  <EuiText size="m">
                    <p style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6, margin: 0 }}>
                      {data.summary}
                    </p>
                  </EuiText>
                ) : (
                  <EuiText size="s" color="subdued">
                    <p>No summary available for this window yet.</p>
                  </EuiText>
                )}
              </EuiFlexItem>
            </EuiFlexGroup>
          </EuiPanel>

          {hasAggregate ? (
            <>
              <EuiSpacer size="l" />

              {/* Headline stat tiles */}
              <EuiFlexGroup gutterSize="m" wrap>
                <EuiFlexItem style={{ minWidth: 200 }}>
                  <StatTile
                    label="Events"
                    value={totalEvents !== undefined ? fmtNumber(totalEvents) : '—'}
                    icon="visBarVerticalStacked"
                    accent={COLORS.primary}
                    sub={`last ${window}h`}
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
                    label="Rule types"
                    value={byRule.length ? fmtNumber(byRule.length) : '—'}
                    icon="tag"
                    accent={COLORS.warning}
                  />
                </EuiFlexItem>
                <EuiFlexItem style={{ minWidth: 200 }}>
                  <StatTile
                    label="Cases opened"
                    value={casesOpened !== undefined ? fmtNumber(casesOpened) : '—'}
                    icon="folderOpen"
                    accent={COLORS.success}
                  />
                </EuiFlexItem>
              </EuiFlexGroup>

              <EuiSpacer size="l" />

              {/* Top-N breakdowns */}
              <div className="socGrid">
                {byRule.length ? (
                  <Card title="Top rules" icon="tag" accent={COLORS.warning}>
                    <BarList items={byRule.slice(0, 8)} format={fmtNumber} />
                  </Card>
                ) : null}
                {topIps.length ? (
                  <Card title="Top source IPs" icon="globe" accent={COLORS.primary}>
                    <BarList items={topIps.slice(0, 8)} format={fmtNumber} />
                  </Card>
                ) : null}
                {topUsers.length ? (
                  <Card title="Top users" icon="user" accent={COLORS.accent}>
                    <BarList items={topUsers.slice(0, 8)} format={fmtNumber} />
                  </Card>
                ) : null}
                {topHosts.length ? (
                  <Card title="Top hosts" icon="storage" accent={COLORS.success}>
                    <BarList items={topHosts.slice(0, 8)} format={fmtNumber} />
                  </Card>
                ) : null}
                {bySeverity.length ? (
                  <Card title="By severity" icon="alert" accent={COLORS.danger}>
                    <BarList
                      items={bySeverity.map((s) => ({ ...s, label: humanizeToken(s.label) }))}
                      format={fmtNumber}
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
                body="The standup ran but found no aggregated log activity to break down."
              />
            </>
          )}
        </>
      )}
    </div>
  );
};
