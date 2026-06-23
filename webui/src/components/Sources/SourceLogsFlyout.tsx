/**
 * SourceLogsFlyout — a per-source "Browse logs" panel.
 *
 * Opened from a source card, it shows a window of normalised events the agent
 * would read from that source via `GET /api/sources/{id}/logs`:
 *   - a controls row: a free-text search, an EuiSuperDatePicker time range, an
 *     explicit "Live tail" switch (polls every 10s), and a manual refresh,
 *   - a table of rows (timestamp / source.ip / module-rule / severity / message)
 *     with per-row expansion into the raw event JSON.
 *
 * Two server modes: `mode:"search"` (a pull source, time-range + search apply) and
 * `mode:"buffer"` (a push source's in-memory live tail; the server ignores
 * from/to/query). Every value is source-controlled and therefore UNTRUSTED — it is
 * rendered as plain text, and `_raw` only inside a fenced <EuiCodeBlock>. Never
 * interpolated as markup / dangerouslySetInnerHTML.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  EuiBadge,
  EuiBasicTable,
  EuiButton,
  EuiButtonIcon,
  EuiCodeBlock,
  EuiFieldSearch,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFlyout,
  EuiFlyoutBody,
  EuiFlyoutHeader,
  EuiSpacer,
  EuiSuperDatePicker,
  EuiSwitch,
  EuiText,
  EuiTitle,
} from '@elastic/eui';
import type {
  EuiBasicTableColumn,
  OnTimeChangeProps,
} from '@elastic/eui';
import type { SourceInstance, SourceLogRow } from '../../lib/types';
import { api } from '../../lib/api';
import { COLORS } from '../../lib/theme';
import { DASH, formatTimestamp, humanizeToken } from '../../lib/format';
import { EmptyState, ErrorCallout, IconChip, Skeleton } from '../common/ui';

/** Auto-refresh cadence for the "Live tail" switch (ms). */
const LIVE_TAIL_INTERVAL_MS = 10_000;
/** Max rows we ask the backend for in one window (backend caps at 200). */
const ROW_LIMIT = 100;

/** A small severity pill — colour by magnitude (≥7 danger, ≥4 warning, else subdued). */
const SeverityBadge: React.FC<{ severity: number }> = ({ severity }) => {
  const n = typeof severity === 'number' && !Number.isNaN(severity) ? severity : 0;
  // Map the (typically 0–10) severity onto the shared risk colour scale.
  const color = n >= 7 ? COLORS.danger : n >= 4 ? COLORS.warning : COLORS.subdued;
  return (
    <EuiBadge color={color} title={`Severity ${n}`}>
      {n}
    </EuiBadge>
  );
};

const ELLIPSIS: React.CSSProperties = {
  display: 'block',
  maxWidth: 520,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export const SourceLogsFlyout: React.FC<{
  source: SourceInstance;
  onClose: () => void;
}> = ({ source, onClose }) => {
  const titleId = `sourceLogs-${source.id}`;

  // Controls.
  const [query, setQuery] = useState('');
  const [start, setStart] = useState('now-15m');
  const [end, setEnd] = useState('now');
  const [liveTail, setLiveTail] = useState(false);

  // Data.
  const [rows, setRows] = useState<SourceLogRow[]>([]);
  const [mode, setMode] = useState<string>('');
  const [count, setCount] = useState(0);
  // `loading` is the visible first-load skeleton; background live-tail refreshes
  // don't flip it so the table doesn't flicker every 10s.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [expanded, setExpanded] = useState<Record<string, React.ReactNode>>({});

  // Stable refs so the polling interval always calls the latest load() inputs
  // without re-arming the timer on every keystroke.
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const loadRef = useRef<(showSkeleton: boolean) => void>(() => {});

  const load = useCallback(
    async (showSkeleton: boolean) => {
      if (showSkeleton) setLoading(true);
      setError(null);
      try {
        const res = await api.sourceLogs(source.id, {
          limit: ROW_LIMIT,
          query: query.trim() || undefined,
          from: start || undefined,
          to: end || undefined,
        });
        setRows(res.logs || []);
        setMode(res.mode || '');
        setCount(typeof res.count === 'number' ? res.count : (res.logs || []).length);
        // Drop expansions that no longer have a matching row.
        setExpanded((prev) => {
          const ids = new Set((res.logs || []).map((r) => r.id));
          const next: Record<string, React.ReactNode> = {};
          for (const k of Object.keys(prev)) if (ids.has(k)) next[k] = prev[k];
          return next;
        });
      } catch (e) {
        setError(e);
      } finally {
        if (showSkeleton) setLoading(false);
      }
    },
    [source.id, query, start, end],
  );

  // Keep the ref pointed at the freshest load() for the interval to call.
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  // Initial load + reload whenever the query/time range changes.
  useEffect(() => {
    void load(true);
  }, [load]);

  // Live-tail polling: arm a 10s interval when the switch is on; always clear on
  // toggle-off and on unmount.
  useEffect(() => {
    if (!liveTail) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }
    intervalRef.current = setInterval(() => {
      void loadRef.current(false);
    }, LIVE_TAIL_INTERVAL_MS);
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [liveTail]);

  const onTimeChange = useCallback(({ start: s, end: e }: OnTimeChangeProps) => {
    setStart(s);
    setEnd(e);
    // state change triggers the load() effect; no explicit reload needed.
  }, []);

  const toggleExpand = useCallback((row: SourceLogRow) => {
    setExpanded((prev) => {
      const next = { ...prev };
      if (next[row.id]) {
        delete next[row.id];
      } else {
        next[row.id] = (
          <EuiCodeBlock
            language="json"
            whiteSpace="pre-wrap"
            paddingSize="s"
            fontSize="s"
            isCopyable
          >
            {JSON.stringify(row._raw ?? {}, null, 2)}
          </EuiCodeBlock>
        );
      }
      return next;
    });
  }, []);

  const isBuffer = mode === 'buffer';

  const columns: Array<EuiBasicTableColumn<SourceLogRow>> = useMemo(
    () => [
      {
        field: 'ts',
        name: 'Timestamp',
        width: '170px',
        render: (_: unknown, r: SourceLogRow) => (
          <span className="socMono" style={{ fontSize: 12 }}>
            {formatTimestamp(r.ts)}
          </span>
        ),
      },
      {
        field: 'source_ip',
        name: 'source.ip',
        width: '150px',
        render: (_: unknown, r: SourceLogRow) =>
          r.source_ip ? (
            <span className="socMono" style={{ fontSize: 12 }}>
              {r.source_ip}
            </span>
          ) : (
            <span style={{ color: COLORS.subdued }}>{DASH}</span>
          ),
      },
      {
        field: 'rule',
        name: 'Module / rule',
        width: '180px',
        render: (_: unknown, r: SourceLogRow) =>
          r.rule ? (
            <span>{r.rule}</span>
          ) : (
            <span style={{ color: COLORS.subdued }}>{DASH}</span>
          ),
      },
      {
        field: 'severity',
        name: 'Severity',
        width: '90px',
        render: (_: unknown, r: SourceLogRow) => <SeverityBadge severity={r.severity} />,
      },
      {
        field: 'message',
        name: 'Message',
        render: (_: unknown, r: SourceLogRow) => (
          <span style={ELLIPSIS} title={r.message || undefined}>
            {r.message || DASH}
          </span>
        ),
      },
      {
        name: 'Raw',
        width: '56px',
        align: 'right' as const,
        isExpander: true,
        render: (r: SourceLogRow) => {
          const open = !!expanded[r.id];
          return (
            <EuiButtonIcon
              iconType={open ? 'arrowUp' : 'arrowDown'}
              aria-label={open ? `Hide raw event for ${r.id}` : `Show raw event for ${r.id}`}
              onClick={() => toggleExpand(r)}
              color="text"
            />
          );
        },
      },
    ],
    [expanded, toggleExpand],
  );

  return (
    <EuiFlyout onClose={onClose} size="l" aria-labelledby={titleId} ownFocus>
      <EuiFlyoutHeader hasBorder>
        <EuiFlexGroup gutterSize="m" alignItems="center" responsive={false}>
          <EuiFlexItem grow={false}>
            <IconChip icon="discoverApp" accent={COLORS.primary} />
          </EuiFlexItem>
          <EuiFlexItem>
            <EuiTitle size="m">
              <h2 id={titleId}>{source.display_name || source.source_type} · Logs</h2>
            </EuiTitle>
            <EuiText size="xs" color="subdued">
              <span>
                {humanizeToken(source.source_type)} · {humanizeToken(source.ingest_mode)}
              </span>
            </EuiText>
          </EuiFlexItem>
        </EuiFlexGroup>

        <EuiSpacer size="m" />

        <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false} wrap>
          <EuiFlexItem style={{ minWidth: 220 }}>
            <EuiFieldSearch
              fullWidth
              compressed
              placeholder="Search message, rule, host…"
              aria-label="Search log events"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onSearch={(v) => {
                setQuery(v);
                void load(true);
              }}
              incremental={false}
            />
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiSuperDatePicker
              compressed
              start={start}
              end={end}
              onTimeChange={onTimeChange}
              showUpdateButton={false}
              width="auto"
            />
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiSwitch
              compressed
              label="Live tail"
              checked={liveTail}
              onChange={(e) => setLiveTail(e.target.checked)}
              aria-label="Auto-refresh every 10 seconds"
            />
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiButton
              size="s"
              iconType="refresh"
              onClick={() => void load(true)}
              isLoading={loading}
              aria-label="Refresh log events"
            >
              Refresh
            </EuiButton>
          </EuiFlexItem>
        </EuiFlexGroup>
      </EuiFlyoutHeader>

      <EuiFlyoutBody>
        {error ? (
          <>
            <ErrorCallout error={error} title="Could not load logs" />
            <EuiSpacer size="s" />
            <EuiButton size="s" iconType="refresh" onClick={() => void load(true)}>
              Retry
            </EuiButton>
          </>
        ) : loading ? (
          <Skeleton rows={8} height={28} />
        ) : rows.length === 0 ? (
          <EmptyState
            iconType="discoverApp"
            title="No events"
            body="No log events in this window."
          />
        ) : (
          <>
            <EuiFlexGroup
              gutterSize="s"
              alignItems="center"
              responsive={false}
              wrap
              justifyContent="spaceBetween"
            >
              <EuiFlexItem grow={false}>
                <EuiText size="xs" color="subdued">
                  <span>
                    mode: {mode || DASH} · {count} shown
                  </span>
                </EuiText>
              </EuiFlexItem>
              {liveTail ? (
                <EuiFlexItem grow={false}>
                  <EuiBadge color={COLORS.success} iconType="dot">
                    Live · every 10s
                  </EuiBadge>
                </EuiFlexItem>
              ) : null}
            </EuiFlexGroup>

            {isBuffer ? (
              <>
                <EuiSpacer size="xs" />
                <EuiText size="xs" color="subdued">
                  <span>
                    This is a push source — these rows are its in-memory live tail. The
                    time range and search apply to pull (search) sources only.
                  </span>
                </EuiText>
              </>
            ) : null}

            <EuiSpacer size="s" />

            <EuiBasicTable<SourceLogRow>
              items={rows}
              itemId="id"
              columns={columns}
              itemIdToExpandedRowMap={expanded}
              tableLayout="auto"
              rowHeader="ts"
            />

            <EuiSpacer size="m" />
            <EuiText size="xs" color="subdued">
              <span>
                Log values are untrusted source data — shown as plain text and raw JSON,
                never executed.
              </span>
            </EuiText>
          </>
        )}
      </EuiFlyoutBody>
    </EuiFlyout>
  );
};
