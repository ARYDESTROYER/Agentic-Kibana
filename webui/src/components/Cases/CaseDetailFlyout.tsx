/**
 * Case detail flyout — the core analyst workflow surface.
 *
 * Opened with a `caseId`, it fetches the full case (`api.getCase`) and presents:
 *   - a header with title/entity + risk gauge + verdict/status/confidence badges
 *     plus an Export menu (JSON / Markdown report, downloaded via a Blob),
 *   - four tabs: Overview (why-it-fired, recommended action, reproduce query,
 *     evidence cards, MITRE techniques, risk breakdown), Agent trace (the audited
 *     pipeline timeline from `GET /cases/{id}/trace`), Timeline (the merged
 *     analyst history + verdict evolution), and Notes & feedback (AI-decision
 *     grading, comments thread, tags editor, assignee),
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
  EuiButtonIcon,
  EuiCallOut,
  EuiCodeBlock,
  EuiComboBox,
  EuiContextMenu,
  EuiFieldText,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFlyout,
  EuiFlyoutBody,
  EuiFlyoutFooter,
  EuiFlyoutHeader,
  EuiFormRow,
  EuiHorizontalRule,
  EuiIcon,
  EuiIconTip,
  EuiModal,
  EuiModalBody,
  EuiModalFooter,
  EuiModalHeader,
  EuiModalHeaderTitle,
  EuiPopover,
  EuiRange,
  EuiSelect,
  EuiSpacer,
  EuiTab,
  EuiTabs,
  EuiText,
  EuiTextArea,
  EuiTimeline,
  EuiTimelineItem,
  EuiTitle,
  EuiToolTip,
} from '@elastic/eui';
import type { EuiComboBoxOptionOption } from '@elastic/eui';
import type { Case, CaseActionInput, CaseRationale, ModelsResponse } from '../../lib/types';
import { api } from '../../lib/api';
import type { CaseFeedbackInput } from '../../lib/api';
import { COLORS, riskBand, riskHex, tint } from '../../lib/theme';
import { DASH, fmtMoney, formatTimestamp, humanizeAge, humanizeToken } from '../../lib/format';
import {
  Card,
  ConfidenceBadge,
  EmptyState,
  ErrorCallout,
  Loading,
  RiskBadge,
  Skeleton,
  StatTile,
  StatusBadge,
  VerdictBadge,
} from '../common/ui';
import { BarList, RiskGauge } from '../common/charts';
import { ChatPanel } from '../Chat/ChatPanel';

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

/** Which optional structured fields the confirm modal collects for an action. */
type ActionField = 'resolution' | 'tags' | 'assignee' | 'priority';

interface ActionDef {
  key: ActionKind;
  label: string;
  icon: string;
  color: 'primary' | 'success' | 'warning' | 'danger' | 'text';
  /** Whether to fill the button (primary action of the current state). */
  fill?: boolean;
  confirmTitle: string;
  confirmBody: string;
  /** A one-line, in-product explainer of what the action does (tooltip + modal). */
  help: string;
  /** Optional structured fields the confirm modal collects (all optional). */
  fields: ActionField[];
}

const ALL_ACTIONS: Record<ActionKind, ActionDef> = {
  close: {
    key: 'close',
    label: 'Close case',
    icon: 'check',
    color: 'success',
    confirmTitle: 'Close this case?',
    confirmBody: 'Mark this case as CLOSED — triaged and handled.',
    help: 'Mark this case as CLOSED — triaged / handled.',
    fields: ['resolution', 'tags'],
  },
  confirm_fp: {
    key: 'confirm_fp',
    label: 'Confirm false positive',
    icon: 'faceHappy',
    color: 'success',
    confirmTitle: 'Confirm false positive?',
    confirmBody:
      'Close the case as a FALSE POSITIVE. The resolved case is fed into the RAG baseline memory so future triage learns from it.',
    help: 'Close as FALSE_POSITIVE; also feeds the resolved case into RAG baseline memory.',
    fields: ['resolution', 'tags'],
  },
  escalate: {
    key: 'escalate',
    label: 'Escalate',
    icon: 'bell',
    color: 'warning',
    confirmTitle: 'Escalate to a human?',
    confirmBody: 'Set this case to NEEDS_HUMAN — route it to a human / senior analyst for review.',
    help: 'Set NEEDS_HUMAN — route to a human / senior analyst.',
    fields: ['assignee', 'priority'],
  },
  reopen: {
    key: 'reopen',
    label: 'Reopen',
    icon: 'refresh',
    color: 'primary',
    confirmTitle: 'Reopen this case?',
    confirmBody: 'Reopen a closed case and return it to the open queue.',
    help: 'Reopen a closed case.',
    fields: [],
  },
  acknowledge: {
    key: 'acknowledge',
    label: 'Acknowledge',
    icon: 'eye',
    color: 'text',
    confirmTitle: 'Acknowledge this case?',
    confirmBody: 'Mark this case as seen / being worked, without closing it.',
    help: 'Mark as seen / being worked, without closing.',
    fields: [],
  },
};

/** Resolution options for close / confirm_fp (all optional). */
const RESOLUTION_OPTIONS: Array<{ value: string; text: string }> = [
  { value: '', text: '— No resolution —' },
  { value: 'handled', text: 'Handled' },
  { value: 'benign', text: 'Benign' },
  { value: 'duplicate', text: 'Duplicate' },
  { value: 'no_action', text: 'No action needed' },
  { value: 'other', text: 'Other' },
];

/** Priority options for escalate (all optional). */
const PRIORITY_OPTIONS: Array<{ value: string; text: string }> = [
  { value: '', text: '— No priority —' },
  { value: 'low', text: 'Low' },
  { value: 'medium', text: 'Medium' },
  { value: 'high', text: 'High' },
  { value: 'critical', text: 'Critical' },
];

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
  const [tab, setTab] =
    useState<'overview' | 'why' | 'trace' | 'timeline' | 'collab' | 'chat'>('overview');

  // Agent-trace (lazy: fetched the first time the tab is opened).
  const [trace, setTrace] = useState<TraceStep[] | null>(null);
  const [traceLoading, setTraceLoading] = useState(false);
  const [traceError, setTraceError] = useState<unknown>(null);

  // Decision rationale / "Why" (lazy: fetched the first time the tab is opened).
  const [rationale, setRationale] = useState<CaseRationale | null>(null);
  const [rationaleLoading, setRationaleLoading] = useState(false);
  const [rationaleError, setRationaleError] = useState<unknown>(null);

  // Pending lifecycle action (drives the confirm modal) + the OPTIONAL structured
  // fields it collects (all optional — they never block submit).
  const [pending, setPending] = useState<ActionDef | null>(null);
  const [note, setNote] = useState('');
  const [resolution, setResolution] = useState('');
  const [priority, setPriority] = useState('');
  const [actionAssignee, setActionAssignee] = useState('');
  const [actionTags, setActionTags] = useState<Array<EuiComboBoxOptionOption<string>>>([]);
  const [acting, setActing] = useState(false);

  // Reinvestigate (force re-run the AI pipeline, optionally pinning a model).
  const [reinvestOpen, setReinvestOpen] = useState(false);
  const [reinvestModel, setReinvestModel] = useState('');
  const [reinvesting, setReinvesting] = useState(false);
  const [models, setModels] = useState<ModelsResponse | null>(null);

  // Export menu (header popover) + in-flight format.
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState<'json' | 'md' | null>(null);

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

  const loadRationale = useCallback(async () => {
    setRationaleLoading(true);
    setRationaleError(null);
    try {
      const res = await api.caseRationale(caseId);
      setRationale(res);
    } catch (e) {
      setRationaleError(e);
    } finally {
      setRationaleLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    if (tab === 'why' && rationale === null && !rationaleLoading) {
      void loadRationale();
    }
  }, [tab, rationale, rationaleLoading, loadRationale]);

  // Reset all confirm-modal field state (called whenever the modal opens/closes).
  const resetActionFields = useCallback(() => {
    setNote('');
    setResolution('');
    setPriority('');
    setActionAssignee('');
    setActionTags([]);
  }, []);

  const openAction = useCallback(
    (a: ActionDef) => {
      resetActionFields();
      setPending(a);
    },
    [resetActionFields],
  );

  const closeAction = useCallback(() => {
    setPending(null);
    resetActionFields();
  }, [resetActionFields]);

  const runAction = useCallback(async () => {
    if (!pending) return;
    setActing(true);
    try {
      // Assemble the action payload — only attach a field when the action collects
      // it AND a value was provided (every field is optional, never blocks submit).
      const input: CaseActionInput = { action: pending.key };
      const trimmedNote = note.trim();
      if (trimmedNote) input.note = trimmedNote;
      if (pending.fields.includes('resolution') && resolution) input.resolution = resolution;
      if (pending.fields.includes('assignee') && actionAssignee.trim()) {
        input.assignee = actionAssignee.trim();
      }
      if (pending.fields.includes('priority') && priority) input.priority = priority;
      if (pending.fields.includes('tags')) {
        const tags = Array.from(
          new Set(actionTags.map((o) => (o.label || '').trim()).filter(Boolean)),
        );
        if (tags.length) input.tags = tags;
      }
      const next = await api.caseActionExec(caseId, input);
      setC(next);
      setPending(null);
      resetActionFields();
      setTrace(null); // invalidate the trace so it refetches if reopened
      setRationale(null); // invalidate the rationale so it refetches if reopened
      onChanged?.();
    } catch (e) {
      setError(e);
      setPending(null);
    } finally {
      setActing(false);
    }
  }, [pending, note, resolution, priority, actionAssignee, actionTags, caseId, resetActionFields, onChanged]);

  // Fetch the available models once (best-effort) for the reinvestigate picker; the
  // picker simply stays at "Use configured model" if the call fails / none exist.
  useEffect(() => {
    let cancelled = false;
    void api
      .getModels()
      .then((res) => {
        if (!cancelled) setModels(res);
      })
      .catch(() => {
        /* non-fatal: reinvestigate works fine on the configured model. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const runReinvestigate = useCallback(async () => {
    setReinvesting(true);
    setError(null);
    try {
      const input = reinvestModel.trim() ? { model: reinvestModel.trim() } : undefined;
      const next = await api.reinvestigateCase(caseId, input);
      setC(next);
      setReinvestOpen(false);
      setTrace(null); // invalidate the trace so it refetches if reopened
      setRationale(null); // invalidate the rationale so it refetches if reopened
      onChanged?.();
    } catch (e) {
      setError(e);
    } finally {
      setReinvesting(false);
    }
  }, [reinvestModel, caseId, onChanged]);

  // Export the case (JSON or Markdown) and trigger a browser download — no deps:
  // build a Blob from the returned content and click a transient <a download>.
  const runExport = useCallback(
    async (fmt: 'json' | 'md') => {
      setExporting(fmt);
      try {
        const res = await api.exportCase(caseId, fmt);
        const blob = new Blob([res.content], {
          type: res.content_type || 'application/octet-stream',
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = res.filename || `case-${caseId}.${fmt === 'md' ? 'md' : 'json'}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        setExportOpen(false);
      } catch (e) {
        setError(e);
      } finally {
        setExporting(null);
      }
    },
    [caseId],
  );

  const riskScore = typeof c?.risk_score === 'number' ? c.risk_score : 0;
  const band = riskBand(riskScore);

  // Flatten provider→models into "<model> · <provider>" options for the picker.
  const modelOptions = useMemo<Array<{ value: string; text: string }>>(() => {
    const out: Array<{ value: string; text: string }> = [
      { value: '', text: 'Use configured model' },
    ];
    for (const [provider, list] of Object.entries(models?.providers || {})) {
      for (const m of list || []) {
        out.push({ value: m, text: `${m}  ·  ${provider}` });
      }
    }
    return out;
  }, [models]);

  const tabs: Array<{ id: typeof tab; label: string; icon: string }> = [
    { id: 'overview', label: 'Overview', icon: 'documentation' },
    { id: 'why', label: 'Why', icon: 'inspect' },
    { id: 'trace', label: 'Agent trace', icon: 'graphApp' },
    { id: 'timeline', label: 'Timeline', icon: 'clock' },
    { id: 'collab', label: 'Notes & feedback', icon: 'editorComment' },
    { id: 'chat', label: 'Ask', icon: 'discuss' },
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
                {c.agent_persona && c.agent_persona !== 'generalist' ? (
                  <EuiFlexItem grow={false}>
                    <EuiBadge
                      color={tint(COLORS.accent, 0.18)}
                      style={{ color: COLORS.accent }}
                      iconType="userAvatar"
                      title="Specialized investigator persona assigned to this case"
                    >
                      {humanizeToken(c.agent_persona)}
                    </EuiBadge>
                  </EuiFlexItem>
                ) : null}
              </EuiFlexGroup>
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <div style={{ textAlign: 'center' }}>
                <EuiFlexGroup
                  gutterSize="s"
                  responsive={false}
                  justifyContent="flexEnd"
                  alignItems="center"
                  style={{ marginBottom: 4 }}
                >
                  {/* ---------------------------------------- Reinvestigate */}
                  <EuiFlexItem grow={false}>
                    <EuiPopover
                      button={
                        <EuiButton
                          size="s"
                          iconType="refresh"
                          iconSide="left"
                          color="primary"
                          onClick={() => {
                            setReinvestModel('');
                            setReinvestOpen((o) => !o);
                          }}
                          isLoading={reinvesting}
                          isDisabled={reinvesting}
                        >
                          Reinvestigate
                        </EuiButton>
                      }
                      isOpen={reinvestOpen}
                      closePopover={() => {
                        if (!reinvesting) setReinvestOpen(false);
                      }}
                      anchorPosition="downRight"
                    >
                      <div style={{ maxWidth: 320, padding: 4, textAlign: 'left' }}>
                        <EuiFlexGroup gutterSize="xs" alignItems="center" responsive={false}>
                          <EuiFlexItem grow={false}>
                            <EuiText size="s">
                              <strong>Re-run the investigation</strong>
                            </EuiText>
                          </EuiFlexItem>
                          <EuiFlexItem grow={false}>
                            <EuiIconTip
                              type="iInCircle"
                              color="subdued"
                              content="Re-run the AI investigation on this case (force), optionally with a different model."
                            />
                          </EuiFlexItem>
                        </EuiFlexGroup>
                        <EuiSpacer size="s" />
                        <EuiText size="xs" color="subdued">
                          <span>
                            Forces a fresh AI investigation. This runs the LLM
                            pipeline and may take a few seconds.
                          </span>
                        </EuiText>
                        <EuiSpacer size="s" />
                        <EuiFormRow label="Model" fullWidth>
                          <EuiSelect
                            fullWidth
                            compressed
                            options={modelOptions}
                            value={reinvestModel}
                            onChange={(e) => setReinvestModel(e.target.value)}
                            disabled={reinvesting}
                            aria-label="Model for reinvestigation"
                          />
                        </EuiFormRow>
                        <EuiSpacer size="s" />
                        <EuiFlexGroup
                          gutterSize="s"
                          justifyContent="flexEnd"
                          responsive={false}
                        >
                          <EuiFlexItem grow={false}>
                            <EuiButtonEmpty
                              size="s"
                              onClick={() => setReinvestOpen(false)}
                              isDisabled={reinvesting}
                            >
                              Cancel
                            </EuiButtonEmpty>
                          </EuiFlexItem>
                          <EuiFlexItem grow={false}>
                            <EuiButton
                              size="s"
                              fill
                              iconType="play"
                              onClick={() => void runReinvestigate()}
                              isLoading={reinvesting}
                              isDisabled={reinvesting}
                            >
                              Reinvestigate
                            </EuiButton>
                          </EuiFlexItem>
                        </EuiFlexGroup>
                      </div>
                    </EuiPopover>
                  </EuiFlexItem>

                  {/* ----------------------------------------------- Export */}
                  <EuiFlexItem grow={false}>
                    <EuiPopover
                      button={
                        <EuiButton
                          size="s"
                          iconType="exportAction"
                          iconSide="left"
                          onClick={() => setExportOpen((o) => !o)}
                          isLoading={exporting !== null}
                        >
                          Export
                        </EuiButton>
                      }
                      isOpen={exportOpen}
                      closePopover={() => setExportOpen(false)}
                      panelPaddingSize="none"
                      anchorPosition="downRight"
                    >
                      <EuiContextMenu
                        initialPanelId={0}
                        panels={[
                          {
                            id: 0,
                            title: 'Export case',
                            items: [
                              {
                                name: 'JSON',
                                icon: 'document',
                                onClick: () => void runExport('json'),
                              },
                              {
                                name: 'Markdown report',
                                icon: 'documentEdit',
                                onClick: () => void runExport('md'),
                              },
                            ],
                          },
                        ]}
                      />
                    </EuiPopover>
                  </EuiFlexItem>
                </EuiFlexGroup>
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
            <EuiTab
              key={t.id}
              isSelected={tab === t.id}
              onClick={() => setTab(t.id)}
              prepend={<EuiIcon type={t.icon} size="s" />}
            >
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
        ) : tab === 'why' ? (
          <WhyTab
            c={c}
            rationale={rationale}
            loading={rationaleLoading}
            error={rationaleError}
            onRetry={loadRationale}
          />
        ) : tab === 'trace' ? (
          <TraceTab
            steps={trace}
            loading={traceLoading}
            error={traceError}
            onRetry={loadTrace}
          />
        ) : tab === 'timeline' ? (
          <TimelineTab c={c} />
        ) : tab === 'chat' ? (
          // Embedded "Ask about this case" chat — scoped to the case. The panel must
          // live in a bounded, fixed-height flex column so its transcript scrolls
          // within the flyout body (the flyout is size="l").
          <div style={{ height: '60vh', display: 'flex', flexDirection: 'column' }}>
            <ChatPanel
              caseId={c.case_id}
              compact
              starters={[
                'Summarize this case',
                'Why was this flagged?',
                'What should I check next?',
                'Is this a known false positive?',
              ]}
            />
          </div>
        ) : (
          <CollaborationTab c={c} onUpdated={(next) => { setC(next); onChanged?.(); }} />
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
            <EuiFlexGroup
              gutterSize="s"
              responsive={false}
              wrap
              justifyContent="flexEnd"
              alignItems="center"
            >
              {(c ? actionsForStatus(c.status) : []).map((a) => (
                <EuiFlexItem grow={false} key={a.key}>
                  <EuiFlexGroup gutterSize="xs" responsive={false} alignItems="center">
                    <EuiFlexItem grow={false}>
                      <EuiToolTip content={a.help}>
                        <EuiButton
                          size="s"
                          fill={a.fill}
                          color={a.color}
                          iconType={a.icon}
                          onClick={() => openAction(a)}
                          isDisabled={loading || acting}
                        >
                          {a.label}
                        </EuiButton>
                      </EuiToolTip>
                    </EuiFlexItem>
                    <EuiFlexItem grow={false}>
                      <EuiIconTip
                        type="questionInCircle"
                        color="subdued"
                        content={a.help}
                        aria-label={`What does "${a.label}" do?`}
                      />
                    </EuiFlexItem>
                  </EuiFlexGroup>
                </EuiFlexItem>
              ))}
            </EuiFlexGroup>
          </EuiFlexItem>
        </EuiFlexGroup>
      </EuiFlyoutFooter>

      {pending ? (
        <EuiModal onClose={closeAction} aria-label={pending.confirmTitle}>
          <EuiModalHeader>
            <EuiModalHeaderTitle>
              <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false}>
                <EuiFlexItem grow={false}>
                  <EuiIcon type={pending.icon} size="m" />
                </EuiFlexItem>
                <EuiFlexItem grow={false}>{pending.confirmTitle}</EuiFlexItem>
              </EuiFlexGroup>
            </EuiModalHeaderTitle>
          </EuiModalHeader>

          <EuiModalBody>
            {/* One-line, in-product explainer of what this action does. */}
            <EuiCallOut
              size="s"
              color={pending.color === 'warning' ? 'warning' : 'primary'}
              iconType="iInCircle"
              title={pending.confirmBody}
            />
            <EuiSpacer size="m" />

            {/* close / confirm_fp → optional Resolution + Tags. */}
            {pending.fields.includes('resolution') ? (
              <EuiFormRow
                label="Resolution"
                helpText="How was this resolved? (optional)"
                fullWidth
              >
                <EuiSelect
                  fullWidth
                  options={RESOLUTION_OPTIONS}
                  value={resolution}
                  onChange={(e) => setResolution(e.target.value)}
                  aria-label="Resolution"
                />
              </EuiFormRow>
            ) : null}

            {pending.fields.includes('tags') ? (
              <EuiFormRow
                label="Tags"
                helpText="Type and press enter to add (optional)."
                fullWidth
              >
                <EuiComboBox
                  fullWidth
                  noSuggestions
                  placeholder="Add a tag…"
                  selectedOptions={actionTags}
                  onCreateOption={(value) => {
                    const v = value.trim();
                    if (!v) return;
                    setActionTags((prev) =>
                      prev.some((o) => o.label === v) ? prev : [...prev, { label: v }],
                    );
                  }}
                  onChange={(selected) => setActionTags(selected)}
                  isClearable
                />
              </EuiFormRow>
            ) : null}

            {/* escalate → optional Assignee + Priority. */}
            {pending.fields.includes('assignee') ? (
              <EuiFormRow
                label="Assign to"
                helpText="Analyst or team to route this to (optional)."
                fullWidth
              >
                <EuiFieldText
                  fullWidth
                  icon="user"
                  placeholder="e.g. tier-2 or jdoe"
                  value={actionAssignee}
                  onChange={(e) => setActionAssignee(e.target.value)}
                  aria-label="Assignee"
                />
              </EuiFormRow>
            ) : null}

            {pending.fields.includes('priority') ? (
              <EuiFormRow label="Priority" helpText="Escalation priority (optional)." fullWidth>
                <EuiSelect
                  fullWidth
                  options={PRIORITY_OPTIONS}
                  value={priority}
                  onChange={(e) => setPriority(e.target.value)}
                  aria-label="Priority"
                />
              </EuiFormRow>
            ) : null}

            {/* note — always available. */}
            <EuiFormRow
              label="Analyst note"
              helpText="Why are you taking this action? (optional)"
              fullWidth
            >
              <EuiTextArea
                fullWidth
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Add context for the next analyst…"
                aria-label="Analyst note"
              />
            </EuiFormRow>
          </EuiModalBody>

          <EuiModalFooter>
            <EuiButtonEmpty onClick={closeAction} isDisabled={acting}>
              Cancel
            </EuiButtonEmpty>
            <EuiButton
              fill
              iconType={pending.icon}
              color={pending.color === 'text' ? 'primary' : pending.color}
              onClick={() => void runAction()}
              isLoading={acting}
            >
              {pending.label}
            </EuiButton>
          </EuiModalFooter>
        </EuiModal>
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

/* ===================================================================== Why == */

/** Best-effort label for who/what made the deterministic close/escalate call. */
function decisionByLabel(decisionBy?: string): { text: string; isHuman: boolean } {
  const d = (decisionBy || '').toLowerCase();
  const isHuman = d.includes('human') || d.includes('analyst') || d.includes('operator');
  return { text: decisionBy ? humanizeToken(decisionBy) : 'Automated pipeline', isHuman };
}

/**
 * The "Why" / decision-rationale tab — a skimmable narrative of HOW the case
 * reached its conclusion: the deterministic decision, the agent's reasoning, the
 * knowledge (RAG / runbooks / playbooks) it drew on, the commands it ran, the
 * operator memory applied, enrichment, the selected playbook, and MITRE mapping.
 *
 * Everything sourced from logs / the model / retrieved knowledge is UNTRUSTED and
 * is rendered as plain text or inside `<EuiCodeBlock>` — never as executable markup.
 */
const WhyTab: React.FC<{
  c: Case;
  rationale: CaseRationale | null;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}> = ({ c, rationale, loading, error, onRetry }) => {
  if (loading) {
    return (
      <div>
        <Skeleton height={88} radius={10} />
        <EuiSpacer size="m" />
        <Skeleton rows={4} />
        <EuiSpacer size="m" />
        <Skeleton height={120} radius={10} />
      </div>
    );
  }
  if (error) {
    return (
      <>
        <ErrorCallout error={error} title="Could not load decision rationale" />
        <EuiSpacer size="m" />
        <EuiButton size="s" iconType="refresh" onClick={onRetry}>
          Retry
        </EuiButton>
      </>
    );
  }
  if (!rationale) {
    return (
      <EuiCallOut title="No rationale recorded yet" color="primary" iconType="inspect" size="s">
        <p>
          The decision rationale appears after an investigation runs. It shows the
          agent&apos;s reasoning, the knowledge it retrieved, and the deterministic
          close / escalate decision.
        </p>
      </EuiCallOut>
    );
  }

  const r = rationale;
  const verdict = r.verdict ?? c.verdict;
  const confidence = typeof r.confidence === 'number' ? r.confidence : c.confidence;
  const status = r.status ?? c.status;
  const persona = r.persona ?? c.agent_persona;
  const decision = decisionByLabel(r.decision_by ?? c.decision_by);

  const knowledge = r.knowledge || [];
  const tools = r.tools || [];
  const memory = (r.memory_used || []).filter((m) => (m || '').trim());
  const mitre = r.mitre || [];
  const enr = r.enrichment || null;
  const playbook = r.playbook || null;

  /** Source → accent for a knowledge snippet's provenance badge. */
  const knowledgeAccent = (source?: string): string => {
    const s = (source || '').toLowerCase();
    if (s.includes('mitre')) return COLORS.warning;
    if (s.includes('runbook') || s.includes('playbook')) return COLORS.accent;
    if (s.includes('case')) return COLORS.success;
    return COLORS.primary;
  };

  return (
    <div>
      {/* -------------------------------------------------- decision summary */}
      <Card title="Decision" icon="inspect" accent={COLORS.primary}>
        <EuiFlexGroup gutterSize="s" wrap responsive={false} alignItems="center">
          <EuiFlexItem grow={false}>
            <VerdictBadge verdict={verdict} />
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <StatusBadge status={status} />
          </EuiFlexItem>
          {typeof confidence === 'number' ? (
            <EuiFlexItem grow={false}>
              <ConfidenceBadge confidence={confidence} />
            </EuiFlexItem>
          ) : null}
          <EuiFlexItem grow={false}>
            <EuiBadge
              color={decision.isHuman ? tint(COLORS.success, 0.18) : tint(COLORS.accent, 0.18)}
              iconType={decision.isHuman ? 'user' : 'machineLearningApp'}
              style={{ color: decision.isHuman ? COLORS.success : COLORS.accent }}
              title="Who made the close / escalate decision"
            >
              Decided by {decision.text}
            </EuiBadge>
          </EuiFlexItem>
          {persona && persona !== 'generalist' ? (
            <EuiFlexItem grow={false}>
              <EuiBadge
                color={tint(COLORS.primary, 0.18)}
                iconType="userAvatar"
                style={{ color: COLORS.primary }}
                title="Specialized investigator persona assigned to this case"
              >
                {humanizeToken(persona)}
              </EuiBadge>
            </EuiFlexItem>
          ) : null}
        </EuiFlexGroup>

        <EuiSpacer size="m" />

        <EuiCallOut
          title="Deterministic decision"
          color="primary"
          iconType="logstashIf"
          size="s"
        >
          <EuiText size="s">
            <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
              {r.decision_rationale
                ? r.decision_rationale
                : 'The close / escalate decision is made by deterministic code against the operator-configured auto-close policy — never by raw model output. No rationale string was recorded for this case.'}
            </p>
          </EuiText>
        </EuiCallOut>
      </Card>

      <EuiSpacer size="m" />

      {/* ----------------------------------------------------- agent reasoning */}
      <Card title="Agent reasoning" icon="discoverApp" accent={COLORS.accent}>
        {r.reasoning && r.reasoning.trim() ? (
          <EuiText size="s">
            <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{r.reasoning}</p>
          </EuiText>
        ) : (
          <EuiText size="s" color="subdued">
            <span>No reasoning excerpt was recorded for this investigation.</span>
          </EuiText>
        )}
      </Card>

      <EuiSpacer size="m" />

      {/* ----------------------------- knowledge used (RAG / runbooks / playbooks) */}
      <Card title="Knowledge used" icon="documents" accent={COLORS.success}>
        <EuiText size="xs" color="subdued">
          <span>
            Retrieved RAG / runbook / playbook context the investigation drew on
            (e.g. &ldquo;because the runbook says this IP range is internal&rdquo;).
          </span>
        </EuiText>
        <EuiSpacer size="s" />
        {knowledge.length === 0 ? (
          <EmptyState
            iconType="documents"
            title="No knowledge retrieved"
            body="The investigation did not pull any RAG / runbook / playbook snippets."
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {knowledge.map((k, i) => {
              const accent = knowledgeAccent(k.source);
              return (
                <Card key={i} variant="flat" paddingSize="m">
                  <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false} wrap>
                    <EuiFlexItem grow={false}>
                      <EuiBadge
                        color={tint(accent, 0.18)}
                        iconType="document"
                        style={{ color: accent }}
                      >
                        {humanizeToken(k.source) || 'Knowledge'}
                      </EuiBadge>
                    </EuiFlexItem>
                  </EuiFlexGroup>
                  {k.snippet ? (
                    <>
                      <EuiSpacer size="xs" />
                      <EuiCodeBlock
                        whiteSpace="pre-wrap"
                        fontSize="s"
                        paddingSize="s"
                        isCopyable
                      >
                        {k.snippet}
                      </EuiCodeBlock>
                    </>
                  ) : null}
                </Card>
              );
            })}
          </div>
        )}
      </Card>

      <EuiSpacer size="m" />

      {/* ---------------------------------------------- commands the agent ran */}
      <Card title="Commands the agent ran" icon="console" accent={COLORS.primary}>
        <EuiText size="xs" color="subdued">
          <span>The tools / read-only queries the investigator invoked to gather evidence.</span>
        </EuiText>
        <EuiSpacer size="s" />
        {tools.length === 0 ? (
          <EmptyState
            iconType="console"
            title="No tools were invoked"
            body="This case reached its verdict without running any investigation tools."
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {tools.map((t, i) => (
              <Card key={i} variant="flat" paddingSize="m">
                <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false} wrap>
                  <EuiFlexItem grow={false}>
                    <EuiBadge
                      color={tint(COLORS.accent, 0.18)}
                      iconType="wrench"
                      style={{ color: COLORS.accent }}
                    >
                      {t.tool || `Tool ${i + 1}`}
                    </EuiBadge>
                  </EuiFlexItem>
                </EuiFlexGroup>
                {t.query ? (
                  <>
                    <EuiSpacer size="xs" />
                    <EuiCodeBlock
                      language="sql"
                      whiteSpace="pre-wrap"
                      fontSize="s"
                      paddingSize="s"
                      isCopyable
                      className="socMono"
                    >
                      {t.query}
                    </EuiCodeBlock>
                  </>
                ) : null}
                {t.summary ? (
                  <>
                    <EuiSpacer size="xs" />
                    <EuiText size="xs" color="subdued">
                      <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{t.summary}</p>
                    </EuiText>
                  </>
                ) : null}
              </Card>
            ))}
          </div>
        )}
      </Card>

      {/* --------------------------------------------------- operator memory */}
      {memory.length ? (
        <>
          <EuiSpacer size="m" />
          <Card title="Operator memory applied" icon="storage" accent={COLORS.warning}>
            <EuiText size="xs" color="subdued">
              <span>Durable operator facts the investigation was told to honour.</span>
            </EuiText>
            <EuiSpacer size="s" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {memory.map((m, i) => (
                <EuiFlexGroup key={i} gutterSize="s" alignItems="flexStart" responsive={false}>
                  <EuiFlexItem grow={false}>
                    <EuiBadge
                      color={tint(COLORS.warning, 0.18)}
                      iconType="bell"
                      style={{ color: COLORS.warning }}
                    >
                      Memory
                    </EuiBadge>
                  </EuiFlexItem>
                  <EuiFlexItem>
                    <EuiText size="s">
                      <span style={{ whiteSpace: 'pre-wrap' }}>{m}</span>
                    </EuiText>
                  </EuiFlexItem>
                </EuiFlexGroup>
              ))}
            </div>
          </Card>
        </>
      ) : null}

      {/* -------------------------------------------------- enrichment + playbook */}
      {enr || (playbook && playbook.id) ? (
        <>
          <EuiSpacer size="m" />
          <EuiFlexGroup gutterSize="m" wrap>
            {enr ? (
              <EuiFlexItem>
                <Card title="Enrichment" icon="globe" accent={COLORS.danger}>
                  <EuiFlexGroup gutterSize="m" wrap responsive={false}>
                    {typeof enr.reputation_score === 'number' ? (
                      <EuiFlexItem grow={false} style={{ minWidth: 150 }}>
                        <StatTile
                          label="Reputation score"
                          value={Math.round(enr.reputation_score)}
                          icon="visGauge"
                          accent={riskHex(enr.reputation_score)}
                        />
                      </EuiFlexItem>
                    ) : null}
                    {typeof enr.is_malicious === 'boolean' ? (
                      <EuiFlexItem grow={false} style={{ minWidth: 150 }}>
                        <StatTile
                          label="Threat verdict"
                          value={enr.is_malicious ? 'Malicious' : 'Clean'}
                          icon={enr.is_malicious ? 'alert' : 'check'}
                          accent={enr.is_malicious ? COLORS.danger : COLORS.success}
                        />
                      </EuiFlexItem>
                    ) : null}
                    {enr.country ? (
                      <EuiFlexItem grow={false} style={{ minWidth: 150 }}>
                        <StatTile
                          label="Country"
                          value={enr.country}
                          icon="mapMarker"
                          accent={COLORS.accent}
                        />
                      </EuiFlexItem>
                    ) : null}
                  </EuiFlexGroup>
                </Card>
              </EuiFlexItem>
            ) : null}
            {playbook && playbook.id ? (
              <EuiFlexItem>
                <Card title="Playbook" icon="indexMapping" accent={COLORS.accent}>
                  <EuiBadge color={tint(COLORS.accent, 0.18)} style={{ color: COLORS.accent }}>
                    {playbook.id}
                  </EuiBadge>
                  {playbook.reason ? (
                    <>
                      <EuiSpacer size="s" />
                      <EuiText size="s" color="subdued">
                        <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{playbook.reason}</p>
                      </EuiText>
                    </>
                  ) : null}
                </Card>
              </EuiFlexItem>
            ) : null}
          </EuiFlexGroup>
        </>
      ) : null}

      {/* --------------------------------------------------------------- MITRE */}
      {mitre.length ? (
        <>
          <EuiSpacer size="m" />
          <Card title="MITRE ATT&CK techniques" icon="graphApp" accent={COLORS.warning}>
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
          </Card>
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
                <EuiText
                  size="xs"
                  color="subdued"
                  style={{
                    textTransform: 'uppercase',
                    letterSpacing: 0.6,
                    fontWeight: 700,
                  }}
                >
                  <span>{s.tool_name ? 'Command run' : 'Query'}</span>
                </EuiText>
                <EuiSpacer size="xs" />
                <EuiCodeBlock
                  language="sql"
                  whiteSpace="pre-wrap"
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

/* ============================================================ Collaboration == */

/** Assessment options — icon + colour coded (green / orange / red). */
const ASSESSMENTS: Array<{
  key: 'agree' | 'partial' | 'disagree';
  label: string;
  icon: string;
  color: string;
}> = [
  { key: 'agree', label: 'Agree', icon: 'checkInCircleFilled', color: COLORS.success },
  { key: 'partial', label: 'Partially', icon: 'minusInCircleFilled', color: COLORS.warning },
  { key: 'disagree', label: 'Disagree', icon: 'crossInCircle', color: COLORS.danger },
];

const OUTCOME_OPTIONS: Array<{ value: string; text: string }> = [
  { value: '', text: 'Unknown' },
  { value: 'true_positive', text: 'True positive' },
  { value: 'false_positive', text: 'False positive' },
  { value: 'true_negative', text: 'True negative' },
  { value: 'false_negative', text: 'False negative' },
];

function assessmentMeta(key?: string) {
  return ASSESSMENTS.find((a) => a.key === key);
}

/** A 1–5 star control (EuiRating is unavailable in this EUI build). */
const StarRating: React.FC<{
  label: string;
  value: number;
  onChange: (v: number) => void;
}> = ({ label, value, onChange }) => (
  <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false} wrap>
    <EuiFlexItem grow={false} style={{ minWidth: 168 }}>
      <EuiText size="s">
        <span>{label}</span>
      </EuiText>
    </EuiFlexItem>
    <EuiFlexItem grow={false}>
      <EuiFlexGroup gutterSize="none" responsive={false}>
        {[1, 2, 3, 4, 5].map((n) => (
          <EuiFlexItem grow={false} key={n}>
            <EuiButtonIcon
              iconType={n <= value ? 'starFilled' : 'starEmpty'}
              aria-label={`${label}: ${n} of 5`}
              color={n <= value ? 'warning' : 'text'}
              onClick={() => onChange(n === value ? 0 : n)}
            />
          </EuiFlexItem>
        ))}
      </EuiFlexGroup>
    </EuiFlexItem>
    <EuiFlexItem grow={false}>
      <EuiText size="xs" color="subdued">
        <span>{value ? `${value}/5` : DASH}</span>
      </EuiText>
    </EuiFlexItem>
  </EuiFlexGroup>
);

/** Map a 1–5 star rating to a 0..1 score (0 stars → undefined / not recorded). */
function starsToScore(n: number): number | undefined {
  if (!n || n < 1) return undefined;
  return Math.max(0, Math.min(1, n / 5));
}

const CollaborationTab: React.FC<{
  c: Case;
  onUpdated: (next: Case) => void;
}> = ({ c, onUpdated }) => {
  const caseId = c.case_id;

  /* -------------------------------------------------------- AI-decision grading */
  const [assessment, setAssessment] = useState<'agree' | 'partial' | 'disagree'>('agree');
  const [accuracy, setAccuracy] = useState(0);
  const [reasoning, setReasoning] = useState(0);
  const [appropriateness, setAppropriateness] = useState(0);
  const [outcome, setOutcome] = useState('');
  const [timeSaved, setTimeSaved] = useState(0);
  const [fbAnalyst, setFbAnalyst] = useState('');
  const [fbComment, setFbComment] = useState('');
  const [submittingFb, setSubmittingFb] = useState(false);
  const [fbError, setFbError] = useState<unknown>(null);

  const submitFeedback = useCallback(async () => {
    setSubmittingFb(true);
    setFbError(null);
    try {
      const body: CaseFeedbackInput = { assessment };
      const a = starsToScore(accuracy);
      const r = starsToScore(reasoning);
      const ap = starsToScore(appropriateness);
      if (a !== undefined) body.accuracy = a;
      if (r !== undefined) body.reasoning_quality = r;
      if (ap !== undefined) body.action_appropriateness = ap;
      if (outcome) body.actual_outcome = outcome;
      if (timeSaved > 0) body.time_saved_minutes = timeSaved;
      if (fbAnalyst.trim()) body.analyst = fbAnalyst.trim();
      if (fbComment.trim()) body.comment = fbComment.trim();
      const next = await api.caseFeedback(caseId, body);
      onUpdated(next);
      // reset the editable parts, keeping the analyst id for the next entry
      setAccuracy(0);
      setReasoning(0);
      setAppropriateness(0);
      setOutcome('');
      setTimeSaved(0);
      setFbComment('');
    } catch (e) {
      setFbError(e);
    } finally {
      setSubmittingFb(false);
    }
  }, [
    assessment,
    accuracy,
    reasoning,
    appropriateness,
    outcome,
    timeSaved,
    fbAnalyst,
    fbComment,
    caseId,
    onUpdated,
  ]);

  const priorFeedback = useMemo(
    () =>
      [...(c.feedback || [])].sort((x, y) => tsValue(y.ts) - tsValue(x.ts)),
    [c.feedback],
  );

  /* ----------------------------------------------------------------- comments */
  const [commentAuthor, setCommentAuthor] = useState('');
  const [commentBody, setCommentBody] = useState('');
  const [submittingComment, setSubmittingComment] = useState(false);
  const [commentError, setCommentError] = useState<unknown>(null);

  const submitComment = useCallback(async () => {
    const body = commentBody.trim();
    if (!body) return;
    setSubmittingComment(true);
    setCommentError(null);
    try {
      const next = await api.caseComment(caseId, {
        author: commentAuthor.trim() || undefined,
        body,
      });
      onUpdated(next);
      setCommentBody('');
    } catch (e) {
      setCommentError(e);
    } finally {
      setSubmittingComment(false);
    }
  }, [commentBody, commentAuthor, caseId, onUpdated]);

  const comments = useMemo(
    () => [...(c.comments || [])].sort((x, y) => tsValue(x.ts) - tsValue(y.ts)),
    [c.comments],
  );

  /* --------------------------------------------------------------------- tags */
  const tagOptions = useMemo<Array<EuiComboBoxOptionOption<string>>>(
    () => (c.tags || []).map((t) => ({ label: t })),
    [c.tags],
  );
  const [savingTags, setSavingTags] = useState(false);
  const [tagsError, setTagsError] = useState<unknown>(null);

  const persistTags = useCallback(
    async (selected: Array<EuiComboBoxOptionOption<string>>) => {
      const tags = Array.from(
        new Set(selected.map((o) => (o.label || '').trim()).filter(Boolean)),
      );
      setSavingTags(true);
      setTagsError(null);
      try {
        const next = await api.caseTags(caseId, tags);
        onUpdated(next);
      } catch (e) {
        setTagsError(e);
      } finally {
        setSavingTags(false);
      }
    },
    [caseId, onUpdated],
  );

  const onCreateTag = useCallback(
    (value: string) => {
      const v = value.trim();
      if (!v) return;
      void persistTags([...tagOptions, { label: v }]);
    },
    [tagOptions, persistTags],
  );

  const onChangeTags = useCallback(
    (selected: Array<EuiComboBoxOptionOption<string>>) => {
      void persistTags(selected);
    },
    [persistTags],
  );

  /* ----------------------------------------------------------------- assignee */
  const [assignee, setAssignee] = useState(c.assignee || '');
  const [savingAssignee, setSavingAssignee] = useState(false);
  const [assigneeError, setAssigneeError] = useState<unknown>(null);

  useEffect(() => {
    setAssignee(c.assignee || '');
  }, [c.assignee]);

  const saveAssignee = useCallback(async () => {
    setSavingAssignee(true);
    setAssigneeError(null);
    try {
      const next = await api.caseAssign(caseId, assignee.trim());
      onUpdated(next);
    } catch (e) {
      setAssigneeError(e);
    } finally {
      setSavingAssignee(false);
    }
  }, [caseId, assignee, onUpdated]);

  return (
    <div>
      {/* -------------------------------------------------- assignee + tags */}
      <EuiFlexGroup gutterSize="m" wrap>
        <EuiFlexItem>
          <Card title="Assignee" icon="user" accent={COLORS.accent}>
            <EuiFormRow
              label="Owning analyst"
              helpText="Who is responsible for this case."
              fullWidth
              isInvalid={!!assigneeError}
              error={assigneeError ? 'Could not save assignee.' : undefined}
            >
              <EuiFlexGroup gutterSize="s" responsive={false} alignItems="center">
                <EuiFlexItem>
                  <EuiFieldText
                    fullWidth
                    icon="user"
                    placeholder="e.g. jdoe"
                    value={assignee}
                    onChange={(e) => setAssignee(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void saveAssignee();
                    }}
                  />
                </EuiFlexItem>
                <EuiFlexItem grow={false}>
                  <EuiButton
                    size="s"
                    iconType="save"
                    onClick={() => void saveAssignee()}
                    isLoading={savingAssignee}
                    isDisabled={assignee.trim() === (c.assignee || '').trim()}
                  >
                    Save
                  </EuiButton>
                </EuiFlexItem>
              </EuiFlexGroup>
            </EuiFormRow>
          </Card>
        </EuiFlexItem>
        <EuiFlexItem>
          <Card title="Tags" icon="tag" accent={COLORS.primary}>
            <EuiFormRow
              label="Case tags"
              helpText="Type and press enter to add; click ✕ to remove."
              fullWidth
              isInvalid={!!tagsError}
              error={tagsError ? 'Could not save tags.' : undefined}
            >
              <EuiComboBox
                fullWidth
                noSuggestions
                placeholder="Add a tag…"
                selectedOptions={tagOptions}
                onCreateOption={onCreateTag}
                onChange={onChangeTags}
                isLoading={savingTags}
                isClearable={false}
              />
            </EuiFormRow>
          </Card>
        </EuiFlexItem>
      </EuiFlexGroup>

      <EuiSpacer size="m" />

      {/* ------------------------------------------------ AI-decision grading */}
      <Card title="Grade the AI decision" icon="inspect" accent={COLORS.warning}>
        <EuiText size="xs" color="subdued">
          <span>
            Help calibrate the agent: rate the verdict, reasoning, and recommended action.
          </span>
        </EuiText>
        <EuiSpacer size="m" />

        <EuiFormRow label="Overall assessment" fullWidth>
          <EuiFlexGroup gutterSize="s" responsive={false} wrap>
            {ASSESSMENTS.map((a) => {
              const active = assessment === a.key;
              return (
                <EuiFlexItem grow={false} key={a.key}>
                  <EuiButton
                    size="s"
                    iconType={a.icon}
                    fill={active}
                    onClick={() => setAssessment(a.key)}
                    style={
                      active
                        ? { background: a.color, borderColor: a.color }
                        : { color: a.color, borderColor: tint(a.color, 0.5) }
                    }
                  >
                    {a.label}
                  </EuiButton>
                </EuiFlexItem>
              );
            })}
          </EuiFlexGroup>
        </EuiFormRow>

        <EuiSpacer size="s" />
        <StarRating label="Accuracy" value={accuracy} onChange={setAccuracy} />
        <EuiSpacer size="xs" />
        <StarRating label="Reasoning quality" value={reasoning} onChange={setReasoning} />
        <EuiSpacer size="xs" />
        <StarRating
          label="Action appropriateness"
          value={appropriateness}
          onChange={setAppropriateness}
        />

        <EuiSpacer size="m" />
        <EuiFlexGroup gutterSize="m" wrap>
          <EuiFlexItem>
            <EuiFormRow label="Actual outcome" fullWidth>
              <EuiSelect
                fullWidth
                options={OUTCOME_OPTIONS}
                value={outcome}
                onChange={(e) => setOutcome(e.target.value)}
              />
            </EuiFormRow>
          </EuiFlexItem>
          <EuiFlexItem>
            <EuiFormRow label="Analyst id (optional)" fullWidth>
              <EuiFieldText
                fullWidth
                icon="user"
                placeholder="e.g. jdoe"
                value={fbAnalyst}
                onChange={(e) => setFbAnalyst(e.target.value)}
              />
            </EuiFormRow>
          </EuiFlexItem>
        </EuiFlexGroup>

        <EuiSpacer size="s" />
        <EuiFormRow label={`Analyst time saved: ${timeSaved} min`} fullWidth>
          <EuiRange
            min={0}
            max={120}
            step={5}
            value={timeSaved}
            onChange={(e) => setTimeSaved(Number((e.target as HTMLInputElement).value))}
            showLabels
            showValue
            valueAppend=" min"
            fullWidth
          />
        </EuiFormRow>

        <EuiSpacer size="s" />
        <EuiFormRow label="Comment (optional)" fullWidth>
          <EuiTextArea
            fullWidth
            rows={2}
            placeholder="Anything the agent missed or got right?"
            value={fbComment}
            onChange={(e) => setFbComment(e.target.value)}
          />
        </EuiFormRow>

        {fbError ? (
          <>
            <EuiSpacer size="s" />
            <ErrorCallout error={fbError} title="Could not submit feedback" />
          </>
        ) : null}

        <EuiSpacer size="m" />
        <EuiFlexGroup justifyContent="flexEnd" responsive={false}>
          <EuiFlexItem grow={false}>
            <EuiButton
              fill
              size="s"
              iconType="check"
              color="warning"
              onClick={() => void submitFeedback()}
              isLoading={submittingFb}
            >
              Submit grading
            </EuiButton>
          </EuiFlexItem>
        </EuiFlexGroup>

        {priorFeedback.length ? (
          <>
            <EuiHorizontalRule margin="m" />
            <EuiText size="xs" color="subdued">
              <span>
                {priorFeedback.length} prior grading{priorFeedback.length === 1 ? '' : 's'}
              </span>
            </EuiText>
            <EuiSpacer size="s" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {priorFeedback.map((f, i) => {
                const meta = assessmentMeta(f.assessment);
                return (
                  <Card key={i} variant="flat" paddingSize="m">
                    <EuiFlexGroup
                      gutterSize="s"
                      alignItems="center"
                      responsive={false}
                      wrap
                    >
                      <EuiFlexItem grow={false}>
                        <EuiBadge
                          color={meta ? tint(meta.color, 0.18) : 'hollow'}
                          iconType={meta?.icon}
                          style={meta ? { color: meta.color } : undefined}
                        >
                          {meta?.label || humanizeToken(f.assessment) || 'Graded'}
                        </EuiBadge>
                      </EuiFlexItem>
                      {f.actual_outcome ? (
                        <EuiFlexItem grow={false}>
                          <EuiBadge color="hollow">
                            {humanizeToken(f.actual_outcome)}
                          </EuiBadge>
                        </EuiFlexItem>
                      ) : null}
                      {typeof f.time_saved_minutes === 'number' && f.time_saved_minutes > 0 ? (
                        <EuiFlexItem grow={false}>
                          <EuiBadge color="hollow" iconType="clock">
                            {f.time_saved_minutes} min saved
                          </EuiBadge>
                        </EuiFlexItem>
                      ) : null}
                      <EuiFlexItem />
                      <EuiFlexItem grow={false}>
                        <EuiText size="xs" color="subdued">
                          <span>
                            {f.analyst ? `${f.analyst} · ` : ''}
                            {f.ts ? formatTimestamp(f.ts) : DASH}
                          </span>
                        </EuiText>
                      </EuiFlexItem>
                    </EuiFlexGroup>
                    {f.comment ? (
                      <>
                        <EuiSpacer size="xs" />
                        <EuiText size="xs">
                          <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{f.comment}</p>
                        </EuiText>
                      </>
                    ) : null}
                  </Card>
                );
              })}
            </div>
          </>
        ) : null}
      </Card>

      <EuiSpacer size="m" />

      {/* ------------------------------------------------------------ comments */}
      <Card title="Comments" icon="editorComment" accent={COLORS.accent}>
        {comments.length === 0 ? (
          <EmptyState
            iconType="editorComment"
            title="No comments yet"
            body="Leave a note for the next analyst on this case."
          />
        ) : (
          <EuiTimeline>
            {comments.map((cm, i) => (
              <EuiTimelineItem key={i} icon="user" verticalAlign="top">
                <div>
                  <EuiFlexGroup
                    justifyContent="spaceBetween"
                    alignItems="center"
                    gutterSize="s"
                    responsive={false}
                    wrap
                  >
                    <EuiFlexItem grow={false}>
                      <EuiText size="s">
                        <strong>{cm.author || 'Analyst'}</strong>
                      </EuiText>
                    </EuiFlexItem>
                    <EuiFlexItem grow={false}>
                      <EuiText size="xs" color="subdued">
                        <span>{cm.ts ? formatTimestamp(cm.ts) : DASH}</span>
                      </EuiText>
                    </EuiFlexItem>
                  </EuiFlexGroup>
                  <EuiSpacer size="xs" />
                  <EuiText size="s">
                    <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{cm.body}</p>
                  </EuiText>
                </div>
              </EuiTimelineItem>
            ))}
          </EuiTimeline>
        )}

        <EuiHorizontalRule margin="m" />

        <EuiFormRow label="Author (optional)" fullWidth>
          <EuiFieldText
            fullWidth
            icon="user"
            placeholder="e.g. jdoe"
            value={commentAuthor}
            onChange={(e) => setCommentAuthor(e.target.value)}
          />
        </EuiFormRow>
        <EuiSpacer size="s" />
        <EuiFormRow label="Add a comment" fullWidth>
          <EuiTextArea
            fullWidth
            rows={3}
            placeholder="Share context, findings, or a hand-off note…"
            value={commentBody}
            onChange={(e) => setCommentBody(e.target.value)}
          />
        </EuiFormRow>

        {commentError ? (
          <>
            <EuiSpacer size="s" />
            <ErrorCallout error={commentError} title="Could not post comment" />
          </>
        ) : null}

        <EuiSpacer size="s" />
        <EuiFlexGroup justifyContent="flexEnd" responsive={false}>
          <EuiFlexItem grow={false}>
            <EuiButton
              fill
              size="s"
              iconType="plusInCircle"
              onClick={() => void submitComment()}
              isLoading={submittingComment}
              isDisabled={!commentBody.trim()}
            >
              Add comment
            </EuiButton>
          </EuiFlexItem>
        </EuiFlexGroup>
      </Card>
    </div>
  );
};
