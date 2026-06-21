/**
 * Case detail flyout — the core analyst workflow surface.
 *
 * Opened with a `caseId`, it fetches the full case (`api.getCase`) and presents:
 *   - a header with title/entity + risk gauge + verdict/status/confidence badges,
 *   - three tabs: Overview (why-it-fired, recommended action, reproduce query,
 *     evidence cards, MITRE techniques, risk breakdown), Agent trace (the audited
 *     pipeline timeline from `GET /cases/{id}/trace`), and Timeline (the merged
 *     analyst history + verdict evolution),
 *   - a sticky footer with lifecycle actions (close / confirm FP / escalate /
 *     reopen / acknowledge) each gated behind a small confirm-with-note modal.
 *
 * Log-derived values (queries, evidence, tool output) are UNTRUSTED — they are
 * always rendered inside code blocks / fenced text, never interpolated as markup.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EuiBadge,
  EuiButton,
  EuiButtonEmpty,
  EuiCallOut,
  EuiCodeBlock,
  EuiConfirmModal,
  EuiFieldText,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFlyout,
  EuiFlyoutBody,
  EuiFlyoutFooter,
  EuiFlyoutHeader,
  EuiHorizontalRule,
  EuiSpacer,
  EuiTab,
  EuiTabs,
  EuiText,
  EuiTimeline,
  EuiTimelineItem,
  EuiTitle,
} from '@elastic/eui';
import type { Case } from '../../lib/types';
import { api } from '../../lib/api';
import { COLORS, riskBand, riskHex, tint } from '../../lib/theme';
import { DASH, fmtMoney, formatTimestamp, humanizeAge, humanizeToken } from '../../lib/format';
import {
  Card,
  ConfidenceBadge,
  ErrorCallout,
  Loading,
  RiskBadge,
  StatusBadge,
  VerdictBadge,
} from '../common/ui';
import { BarList, RiskGauge } from '../common/charts';

/* --------------------------------------------------------------- contracts -- */

/** One agent-pipeline step (mirrors backend `TraceStep`). */
interface TraceStep {
  ts?: string;
  actor?: string;
  action_type?: string | null;
  model?: string | null;
  query_text?: string | null;
  tool_name?: string | null;
  tool_input?: unknown;
  tool_output_summary?: string | null;
  result_summary?: string | null;
  prompt_excerpt?: string | null;
}

interface TraceResponse {
  case_id: string;
  steps: TraceStep[];
  total: number;
}

type ActionKind = 'close' | 'confirm_fp' | 'escalate' | 'reopen' | 'acknowledge';

interface ActionDef {
  key: ActionKind;
  label: string;
  icon: string;
  color: 'primary' | 'success' | 'warning' | 'danger' | 'text';
  /** Whether to fill the button (primary action of the current state). */
  fill?: boolean;
  confirmTitle: string;
  confirmBody: string;
}

const ALL_ACTIONS: Record<ActionKind, ActionDef> = {
  close: {
    key: 'close',
    label: 'Close case',
    icon: 'check',
    color: 'success',
    confirmTitle: 'Close this case?',
    confirmBody: 'Mark this case as resolved. It will be indexed as RAG memory for future triage.',
  },
  confirm_fp: {
    key: 'confirm_fp',
    label: 'Confirm false positive',
    icon: 'cross',
    color: 'success',
    confirmTitle: 'Confirm false positive?',
    confirmBody: 'Close the case as a confirmed false positive. This decision teaches future triage.',
  },
  escalate: {
    key: 'escalate',
    label: 'Escalate',
    icon: 'alert',
    color: 'warning',
    confirmTitle: 'Escalate to a human?',
    confirmBody: 'Move this case to "Needs human" for manual review.',
  },
  reopen: {
    key: 'reopen',
    label: 'Reopen',
    icon: 'refresh',
    color: 'primary',
    confirmTitle: 'Reopen this case?',
    confirmBody: 'Return this case to the open queue.',
  },
  acknowledge: {
    key: 'acknowledge',
    label: 'Acknowledge',
    icon: 'eye',
    color: 'text',
    confirmTitle: 'Acknowledge this case?',
    confirmBody: 'Record that you have reviewed this case without changing its status.',
  },
};

/** Lifecycle buttons appropriate to the current status (left→right priority). */
function actionsForStatus(status?: string): ActionDef[] {
  const s = (status || '').toLowerCase();
  if (s === 'closed') {
    return [{ ...ALL_ACTIONS.reopen, fill: true }];
  }
  if (s === 'needs_human') {
    return [
      { ...ALL_ACTIONS.close, fill: true },
      ALL_ACTIONS.confirm_fp,
      ALL_ACTIONS.acknowledge,
    ];
  }
  // open / unknown
  return [
    { ...ALL_ACTIONS.escalate, fill: true },
    ALL_ACTIONS.close,
    ALL_ACTIONS.confirm_fp,
    ALL_ACTIONS.acknowledge,
  ];
}

/* ------------------------------------------------------------------ helpers -- */

const MITRE_RE = /^T\d{4}(\.\d{3})?$/i;

function mitreUrl(id: string): string | null {
  const m = id.trim().toUpperCase();
  if (!MITRE_RE.test(m)) return null;
  // sub-techniques (Txxxx.yyy) map to the parent path with the sub appended.
  const [base, sub] = m.split('.');
  return sub
    ? `https://attack.mitre.org/techniques/${base}/${sub}/`
    : `https://attack.mitre.org/techniques/${base}/`;
}

/** Best-effort epoch for sorting mixed history entries (ts is ISO). */
function tsValue(ts?: string): number {
  if (!ts) return 0;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? 0 : ms;
}

interface TimelineEntry {
  ts?: string;
  kind: 'verdict' | 'history';
  icon: string;
  accent: string;
  title: React.ReactNode;
  detail?: React.ReactNode;
}

/* --------------------------------------------------------------- component -- */

export const CaseDetailFlyout: React.FC<{
  caseId: string;
  onClose: () => void;
  onChanged?: () => void;
}> = ({ caseId, onClose, onChanged }) => {
  const [c, setC] = useState<Case | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [tab, setTab] = useState<'overview' | 'trace' | 'timeline'>('overview');

  // Agent-trace (lazy: fetched the first time the tab is opened).
  const [trace, setTrace] = useState<TraceStep[] | null>(null);
  const [traceLoading, setTraceLoading] = useState(false);
  const [traceError, setTraceError] = useState<unknown>(null);

  // Pending lifecycle action (drives the confirm modal).
  const [pending, setPending] = useState<ActionDef | null>(null);
  const [note, setNote] = useState('');
  const [acting, setActing] = useState(false);

  const flyoutTitleId = `caseDetail-${caseId}`;

  const loadCase = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getCase(caseId);
      setC(res);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    void loadCase();
  }, [loadCase]);

  const loadTrace = useCallback(async () => {
    setTraceLoading(true);
    setTraceError(null);
    try {
      const res = await api.get<TraceResponse>(`cases/${encodeURIComponent(caseId)}/trace`);
      setTrace(res.steps || []);
    } catch (e) {
      setTraceError(e);
    } finally {
      setTraceLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    if (tab === 'trace' && trace === null && !traceLoading) {
      void loadTrace();
    }
  }, [tab, trace, traceLoading, loadTrace]);

  const runAction = useCallback(async () => {
    if (!pending) return;
    setActing(true);
    try {
      await api.post(`cases/${encodeURIComponent(caseId)}/action`, {
        action: pending.key,
        note: note.trim(),
      });
      setPending(null);
      setNote('');
      await loadCase();
      setTrace(null); // invalidate the trace so it refetches if reopened
      onChanged?.();
    } catch (e) {
      setError(e);
      setPending(null);
    } finally {
      setActing(false);
    }
  }, [pending, note, caseId, loadCase, onChanged]);

  const riskScore = typeof c?.risk_score === 'number' ? c.risk_score : 0;
  const band = riskBand(riskScore);

  const tabs: Array<{ id: typeof tab; label: string; icon: string }> = [
    { id: 'overview', label: 'Overview', icon: 'documentation' },
    { id: 'trace', label: 'Agent trace', icon: 'graphApp' },
    { id: 'timeline', label: 'Timeline', icon: 'clock' },
  ];

  return (
    <EuiFlyout onClose={onClose} size="l" aria-labelledby={flyoutTitleId} ownFocus>
      <EuiFlyoutHeader hasBorder>
        {loading || !c ? (
          <EuiTitle size="m">
            <h2 id={flyoutTitleId}>Case</h2>
          </EuiTitle>
        ) : (
          <EuiFlexGroup gutterSize="m" alignItems="flexStart" responsive={false}>
            <EuiFlexItem>
              <EuiTitle size="m">
                <h2 id={flyoutTitleId}>{c.title || c.case_id}</h2>
              </EuiTitle>
              <EuiSpacer size="xs" />
              <EuiText size="s" color="subdued">
                <span>
                  {c.entity ? (
                    <>
                      <strong>{c.entity.type}</strong>
                      {': '}
                      <span className="socMono">{c.entity.value}</span>
                    </>
                  ) : (
                    'No entity'
                  )}
                  {'  ·  '}
                  {humanizeAge(c.updated_at || c.created_at)}
                </span>
              </EuiText>
              <EuiSpacer size="s" />
              <EuiFlexGroup gutterSize="s" wrap responsive={false} alignItems="center">
                <EuiFlexItem grow={false}>
                  <VerdictBadge verdict={c.verdict} />
                </EuiFlexItem>
                <EuiFlexItem grow={false}>
                  <StatusBadge status={c.status} />
                </EuiFlexItem>
                <EuiFlexItem grow={false}>
                  <RiskBadge score={c.risk_score} />
                </EuiFlexItem>
                <EuiFlexItem grow={false}>
                  <ConfidenceBadge confidence={c.confidence} />
                </EuiFlexItem>
              </EuiFlexGroup>
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <div style={{ textAlign: 'center' }}>
                <RiskGauge score={riskScore} color={band.color} size={132} />
                <EuiText size="xs" style={{ color: band.color, fontWeight: 700, marginTop: -8 }}>
                  <span>{band.label} risk</span>
                </EuiText>
              </div>
            </EuiFlexItem>
          </EuiFlexGroup>
        )}
        <EuiSpacer size="s" />
        <EuiTabs bottomBorder={false}>
          {tabs.map((t) => (
            <EuiTab key={t.id} isSelected={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}
            </EuiTab>
          ))}
        </EuiTabs>
      </EuiFlyoutHeader>

      <EuiFlyoutBody>
        {error ? (
          <>
            <ErrorCallout error={error} title="Could not load case" />
            <EuiSpacer size="m" />
          </>
        ) : null}

        {loading ? (
          <Loading label="Loading case…" />
        ) : !c ? (
          error ? null : <EuiText color="subdued">Case not found.</EuiText>
        ) : tab === 'overview' ? (
          <OverviewTab c={c} />
        ) : tab === 'trace' ? (
          <TraceTab
            steps={trace}
            loading={traceLoading}
            error={traceError}
            onRetry={loadTrace}
          />
        ) : (
          <TimelineTab c={c} />
        )}
      </EuiFlyoutBody>

      <EuiFlyoutFooter>
        <EuiFlexGroup justifyContent="spaceBetween" alignItems="center" responsive={false}>
          <EuiFlexItem grow={false}>
            <EuiButtonEmpty iconType="cross" onClick={onClose} flush="left">
              Dismiss
            </EuiButtonEmpty>
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiFlexGroup gutterSize="s" responsive={false} wrap justifyContent="flexEnd">
              {(c ? actionsForStatus(c.status) : []).map((a) => (
                <EuiFlexItem grow={false} key={a.key}>
                  <EuiButton
                    size="s"
                    fill={a.fill}
                    color={a.color}
                    iconType={a.icon}
                    onClick={() => {
                      setNote('');
                      setPending(a);
                    }}
                    isDisabled={loading || acting}
                  >
                    {a.label}
                  </EuiButton>
                </EuiFlexItem>
              ))}
            </EuiFlexGroup>
          </EuiFlexItem>
        </EuiFlexGroup>
      </EuiFlyoutFooter>

      {pending ? (
        <EuiConfirmModal
          title={pending.confirmTitle}
          onCancel={() => {
            setPending(null);
            setNote('');
          }}
          onConfirm={() => void runAction()}
          cancelButtonText="Cancel"
          confirmButtonText={pending.label}
          buttonColor={pending.color === 'text' ? 'primary' : pending.color}
          isLoading={acting}
        >
          <EuiText size="s">
            <p>{pending.confirmBody}</p>
          </EuiText>
          <EuiSpacer size="s" />
          <EuiText size="xs" color="subdued">
            <label htmlFor="caseActionNote">Analyst note (optional)</label>
          </EuiText>
          <EuiSpacer size="xs" />
          <EuiFieldText
            id="caseActionNote"
            fullWidth
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why are you taking this action?"
          />
        </EuiConfirmModal>
      ) : null}
    </EuiFlyout>
  );
};

/* ================================================================ Overview == */

const OverviewTab: React.FC<{ c: Case }> = ({ c }) => {
  const trigger = c.trigger_reason as { sentence?: string } | undefined;
  const triggerSentence = trigger?.sentence;
  const evidence = c.evidence || [];
  const mitre = c.mitre || [];

  const rb = c.risk_breakdown as
    | {
        volume?: number;
        velocity?: number;
        reputation?: number;
        diversity?: number;
        asset_criticality?: number;
        total?: number;
      }
    | undefined;

  const riskItems = useMemo(() => {
    if (!rb) return [];
    const comps: Array<{ label: string; value: number }> = [
      { label: 'Volume', value: rb.volume ?? 0 },
      { label: 'Velocity', value: rb.velocity ?? 0 },
      { label: 'Reputation', value: rb.reputation ?? 0 },
      { label: 'Diversity', value: rb.diversity ?? 0 },
      { label: 'Asset criticality', value: rb.asset_criticality ?? 0 },
    ];
    return comps.map((x) => ({ ...x, color: riskHex(x.value) }));
  }, [rb]);

  return (
    <div>
      {triggerSentence ? (
        <>
          <EuiCallOut title="Why this fired" color="primary" iconType="iInCircle" size="s">
            <p>{triggerSentence}</p>
          </EuiCallOut>
          <EuiSpacer size="m" />
        </>
      ) : null}

      {c.summary ? (
        <>
          <Card title="Summary" icon="documentation" accent={COLORS.primary}>
            <EuiText size="s">
              <p style={{ whiteSpace: 'pre-wrap' }}>{c.summary}</p>
            </EuiText>
          </Card>
          <EuiSpacer size="m" />
        </>
      ) : null}

      <EuiFlexGroup gutterSize="m" wrap>
        <EuiFlexItem>
          <Card
            title="Recommended action"
            icon="inspect"
            accent={COLORS.accent}
            accentLeft={COLORS.accent}
          >
            <EuiText size="s">
              <p style={{ whiteSpace: 'pre-wrap' }}>{c.recommended_action || DASH}</p>
            </EuiText>
          </Card>
        </EuiFlexItem>
        <EuiFlexItem>
          <Card title="Risk breakdown" icon="visGauge" accent={COLORS.danger}>
            {riskItems.length ? (
              <BarList items={riskItems} max={100} format={(n) => Math.round(n)} />
            ) : (
              <EuiText size="s" color="subdued">
                <span>No risk breakdown recorded.</span>
              </EuiText>
            )}
            {rb && typeof rb.total === 'number' ? (
              <>
                <EuiHorizontalRule margin="s" />
                <EuiFlexGroup justifyContent="spaceBetween" responsive={false}>
                  <EuiFlexItem grow={false}>
                    <EuiText size="xs" color="subdued">
                      <span>Total</span>
                    </EuiText>
                  </EuiFlexItem>
                  <EuiFlexItem grow={false}>
                    <EuiBadge color={riskHex(rb.total)}>{Math.round(rb.total)}</EuiBadge>
                  </EuiFlexItem>
                </EuiFlexGroup>
              </>
            ) : null}
          </Card>
        </EuiFlexItem>
      </EuiFlexGroup>

      <EuiSpacer size="m" />

      <Card title="Evidence" icon="visTable" accent={COLORS.primary}>
        {evidence.length === 0 ? (
          <EuiText size="s" color="subdued">
            <span>No evidence recorded for this case.</span>
          </EuiText>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {evidence.map((ev, i) => (
              <Card key={i} accentLeft={COLORS.primary} paddingSize="m">
                <EuiText size="s">
                  <strong>{ev.summary || `Evidence ${i + 1}`}</strong>
                </EuiText>
                <EuiSpacer size="xs" />
                <EuiText size="xs" color="subdued">
                  <span>
                    {ev.event_ids && ev.event_ids.length
                      ? `${ev.event_ids.length} matching event${ev.event_ids.length === 1 ? '' : 's'}`
                      : 'No matched event ids'}
                  </span>
                </EuiText>
                {ev.query ? (
                  <>
                    <EuiSpacer size="xs" />
                    <EuiCodeBlock
                      language="sql"
                      fontSize="s"
                      paddingSize="s"
                      isCopyable
                      className="socMono"
                    >
                      {ev.query}
                    </EuiCodeBlock>
                  </>
                ) : null}
              </Card>
            ))}
          </div>
        )}
      </Card>

      <EuiSpacer size="m" />

      <Card title="MITRE ATT&CK techniques" icon="graphApp" accent={COLORS.warning}>
        {mitre.length === 0 ? (
          <EuiText size="s" color="subdued">
            <span>No techniques mapped.</span>
          </EuiText>
        ) : (
          <EuiFlexGroup gutterSize="s" wrap responsive={false}>
            {mitre.map((m) => {
              const url = mitreUrl(m);
              return (
                <EuiFlexItem grow={false} key={m}>
                  {url ? (
                    <EuiBadge
                      color={tint(COLORS.warning, 0.18)}
                      style={{ color: COLORS.warning }}
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {m}
                    </EuiBadge>
                  ) : (
                    <EuiBadge color="hollow">{m}</EuiBadge>
                  )}
                </EuiFlexItem>
              );
            })}
          </EuiFlexGroup>
        )}
      </Card>

      {c.reproduce_query ? (
        <>
          <EuiSpacer size="m" />
          <Card title="Reproduce query" icon="console" accent={COLORS.subdued}>
            <EuiText size="xs" color="subdued">
              <span>Read-only query to reproduce this case&apos;s evidence.</span>
            </EuiText>
            <EuiSpacer size="xs" />
            <EuiCodeBlock
              language="sql"
              fontSize="s"
              paddingSize="m"
              isCopyable
              className="socMono"
            >
              {c.reproduce_query}
            </EuiCodeBlock>
          </Card>
        </>
      ) : null}

      <EuiSpacer size="m" />
      <EuiFlexGroup gutterSize="m" wrap responsive={false}>
        <EuiFlexItem grow={false}>
          <EuiText size="xs" color="subdued">
            <span>Created {formatTimestamp(c.created_at)}</span>
          </EuiText>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiText size="xs" color="subdued">
            <span>Token cost {fmtMoney(c.token_cost)}</span>
          </EuiText>
        </EuiFlexItem>
        {c.decision_by ? (
          <EuiFlexItem grow={false}>
            <EuiText size="xs" color="subdued">
              <span>Decided by {humanizeToken(c.decision_by)}</span>
            </EuiText>
          </EuiFlexItem>
        ) : null}
      </EuiFlexGroup>

      {c.error ? (
        <>
          <EuiSpacer size="m" />
          <EuiCallOut title="Investigation error" color="danger" iconType="alert" size="s">
            <p style={{ whiteSpace: 'pre-wrap' }}>{c.error}</p>
          </EuiCallOut>
        </>
      ) : null}
    </div>
  );
};

/* =============================================================== Agent trace == */

const TraceTab: React.FC<{
  steps: TraceStep[] | null;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}> = ({ steps, loading, error, onRetry }) => {
  if (loading) return <Loading label="Loading agent trace…" />;
  if (error) {
    return (
      <>
        <ErrorCallout error={error} title="Could not load trace" />
        <EuiSpacer size="m" />
        <EuiButton size="s" iconType="refresh" onClick={onRetry}>
          Retry
        </EuiButton>
      </>
    );
  }
  if (!steps || steps.length === 0) {
    return (
      <EuiCallOut title="No agent trace yet" color="primary" iconType="graphApp" size="s">
        <p>
          This case has no recorded pipeline steps. Trace rows appear after an
          investigation runs (router → investigator → tools → verdict).
        </p>
      </EuiCallOut>
    );
  }

  const iconFor = (s: TraceStep): string => {
    if (s.tool_name) return 'wrench';
    const a = (s.action_type || '').toLowerCase();
    if (a.includes('verdict')) return 'check';
    if (a.includes('rout')) return 'branch';
    if (a.includes('invest')) return 'search';
    if (a.includes('format')) return 'documentEdit';
    if (a.includes('decision') || a.includes('case')) return 'gear';
    return 'dot';
  };

  return (
    <EuiTimeline>
      {steps.map((s, i) => (
        <EuiTimelineItem key={i} icon={iconFor(s)} verticalAlign="top">
          <div>
            <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false} wrap>
              <EuiFlexItem grow={false}>
                <EuiText size="s">
                  <strong>{humanizeToken(s.actor) || 'Step'}</strong>
                </EuiText>
              </EuiFlexItem>
              {s.action_type ? (
                <EuiFlexItem grow={false}>
                  <EuiBadge color="hollow">{humanizeToken(s.action_type)}</EuiBadge>
                </EuiFlexItem>
              ) : null}
              {s.tool_name ? (
                <EuiFlexItem grow={false}>
                  <EuiBadge color={tint(COLORS.accent, 0.18)} style={{ color: COLORS.accent }}>
                    {s.tool_name}
                  </EuiBadge>
                </EuiFlexItem>
              ) : null}
              {s.model ? (
                <EuiFlexItem grow={false}>
                  <EuiText size="xs" color="subdued">
                    <span className="socMono">{s.model}</span>
                  </EuiText>
                </EuiFlexItem>
              ) : null}
              <EuiFlexItem grow={false}>
                <EuiText size="xs" color="subdued">
                  <span>{s.ts ? formatTimestamp(s.ts) : DASH}</span>
                </EuiText>
              </EuiFlexItem>
            </EuiFlexGroup>

            {s.query_text ? (
              <>
                <EuiSpacer size="xs" />
                <EuiCodeBlock
                  language="sql"
                  fontSize="s"
                  paddingSize="s"
                  isCopyable
                  className="socMono"
                >
                  {s.query_text}
                </EuiCodeBlock>
              </>
            ) : null}

            {s.tool_output_summary || s.result_summary ? (
              <>
                <EuiSpacer size="xs" />
                <EuiText size="xs" color="subdued">
                  <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                    {s.tool_output_summary || s.result_summary}
                  </p>
                </EuiText>
              </>
            ) : null}
          </div>
        </EuiTimelineItem>
      ))}
    </EuiTimeline>
  );
};

/* ================================================================== Timeline == */

const TimelineTab: React.FC<{ c: Case }> = ({ c }) => {
  const entries = useMemo<TimelineEntry[]>(() => {
    const out: TimelineEntry[] = [];

    const verdictHistory = (c.verdict_history as Array<Record<string, unknown>> | undefined) || [];
    for (const v of verdictHistory) {
      const verdict = typeof v.verdict === 'string' ? v.verdict : undefined;
      const conf = typeof v.confidence === 'number' ? v.confidence : undefined;
      const score = typeof v.risk_score === 'number' ? v.risk_score : undefined;
      out.push({
        ts: typeof v.ts === 'string' ? v.ts : undefined,
        kind: 'verdict',
        icon: 'inspect',
        accent: COLORS.primary,
        title: (
          <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false} wrap>
            <EuiFlexItem grow={false}>
              <EuiText size="s">
                <strong>Verdict reached</strong>
              </EuiText>
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <VerdictBadge verdict={verdict} />
            </EuiFlexItem>
            {typeof score === 'number' ? (
              <EuiFlexItem grow={false}>
                <RiskBadge score={score} />
              </EuiFlexItem>
            ) : null}
            {typeof conf === 'number' ? (
              <EuiFlexItem grow={false}>
                <ConfidenceBadge confidence={conf} />
              </EuiFlexItem>
            ) : null}
          </EuiFlexGroup>
        ),
      });
    }

    const history = (c.history as Array<Record<string, unknown>> | undefined) || [];
    for (const h of history) {
      const event = typeof h.event === 'string' ? h.event : 'event';
      const action = typeof h.action === 'string' ? h.action : undefined;
      const analyst = typeof h.analyst === 'string' ? h.analyst : undefined;
      const noteText = typeof h.note === 'string' ? h.note : undefined;
      out.push({
        ts: typeof h.ts === 'string' ? h.ts : undefined,
        kind: 'history',
        icon: action ? 'user' : 'dot',
        accent: COLORS.accent,
        title: (
          <EuiText size="s">
            <strong>{humanizeToken(action || event)}</strong>
            {analyst ? <EuiText size="xs" color="subdued"><span>by {analyst}</span></EuiText> : null}
          </EuiText>
        ),
        detail: noteText ? (
          <EuiText size="xs" color="subdued">
            <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>“{noteText}”</p>
          </EuiText>
        ) : undefined,
      });
    }

    out.sort((a, b) => tsValue(a.ts) - tsValue(b.ts));
    return out;
  }, [c]);

  if (entries.length === 0) {
    return (
      <EuiCallOut title="No timeline events yet" color="primary" iconType="clock" size="s">
        <p>Verdict changes and analyst actions will appear here as they happen.</p>
      </EuiCallOut>
    );
  }

  return (
    <EuiTimeline>
      {entries.map((e, i) => (
        <EuiTimelineItem key={i} icon={e.icon} verticalAlign="top">
          <div>
            <EuiFlexGroup
              justifyContent="spaceBetween"
              alignItems="center"
              gutterSize="s"
              responsive={false}
              wrap
            >
              <EuiFlexItem>{e.title}</EuiFlexItem>
              <EuiFlexItem grow={false}>
                <EuiText size="xs" color="subdued">
                  <span>{e.ts ? formatTimestamp(e.ts) : DASH}</span>
                </EuiText>
              </EuiFlexItem>
            </EuiFlexGroup>
            {e.detail ? (
              <>
                <EuiSpacer size="xs" />
                {e.detail}
              </>
            ) : null}
          </div>
        </EuiTimelineItem>
      ))}
    </EuiTimeline>
  );
};
