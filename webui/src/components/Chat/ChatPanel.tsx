/**
 * ChatPanel — the reusable conversational-triage engine.
 *
 * This is the single source of truth for the chat experience: it owns its own
 * message list, composer input, send flow, running `history`, in-flight "thinking"
 * indicator, model-selection state, and the (new) source-scope selection. The
 * standalone Chat *page* and the case flyout both embed it:
 *
 *   <ChatPanel starters={[...]} />                 // full page surface
 *   <ChatPanel caseId={id} compact />              // embedded (flyout) surface
 *
 * When `caseId` is set it is threaded into every `api.chat(...)` call so the agent
 * has case context, and a "Scoped to case <id>" chip is shown in the header.
 *
 * Layout: a robust full-height flex column. The transcript lane (`.socChatLane`)
 * is the ONLY thing that scrolls (`flex:1; min-height:0; overflow:auto`); the
 * composer is pinned at the bottom and the optional scope chip sits compactly at
 * the top. The empty state is vertically centred *inside* the lane, so it never
 * pushes the composer down or leaves a dead band. The result table renders inside
 * the assistant bubble flow (width-constrained, horizontally scrollable) so it can
 * never detach / float over the page.
 *
 * Security: assistant answers are rendered through an HTML-escaping `renderMarkdown`
 * (escape FIRST, then inject only our own known-safe tags). All other model- or
 * log-derived text (memory text/reason, query, table cells) is rendered as plain
 * text nodes. There is no `dangerouslySetInnerHTML` on any untrusted text other
 * than that one pre-escaped markdown path. See `renderMarkdown` below.
 */
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  EuiAccordion,
  EuiBasicTable,
  EuiButton,
  EuiButtonEmpty,
  EuiButtonIcon,
  EuiCallOut,
  EuiCodeBlock,
  EuiCopy,
  EuiFlexGroup,
  EuiFlexItem,
  EuiIcon,
  EuiPanel,
  EuiSelect,
  EuiSpacer,
  EuiText,
  EuiTextArea,
  EuiToolTip,
  type EuiBasicTableColumn,
} from '@elastic/eui';
import type {
  ChatMemoryAction,
  ChatMemorySuggestion,
  ChatResponse,
  ChatTable,
  ChatTurn,
  ModelsResponse,
  SourceInstance,
} from '../../lib/types';
import { api, ApiError } from '../../lib/api';
import { IconChip } from '../common/ui';
import { COLORS, tint } from '../../lib/theme';
import { fmtMoney } from '../../lib/format';

/* ------------------------------------------------------------------ types -- */

/** A rendered transcript entry. Assistant turns may carry the full response so we
 *  can render the table / query / cost / memory surfaces beneath the bubble. Error
 *  turns render as a non-fatal callout instead of prose. */
interface TranscriptItem {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  resp?: ChatResponse;
  isError?: boolean;
  /** ms epoch the turn was added (for a subdued time-of-day footnote). */
  at: number;
  /** The model used for this assistant turn (subtle meta), when known. */
  model?: string;
}

export interface ChatPanelProps {
  /** When set, scopes the conversation to a case (passed to api.chat). */
  caseId?: string;
  /** Embedded mode (e.g. the case flyout): denser, no big page chrome, fixed-height scroll. */
  compact?: boolean;
  /** Composer placeholder. */
  placeholder?: string;
  /** Suggested prompts for the empty state (clickable; submit immediately). */
  starters?: string[];
}

/** Imperative handle so a host page can reset the conversation ("New chat"). */
export interface ChatPanelHandle {
  reset: () => void;
}

/** The composer source-scope sentinel: query the configured (primary) source. */
const ALL_SOURCES = '';

/** Cap the rows we render from a single chat result table. */
const MAX_TABLE_ROWS = 50;

/* ------------------------------------------------------ inline markdown ----- */

/** HTML-escape a raw string so nothing it contains can become live markup. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render a SINGLE line of already-escaped-safe text with light inline markdown:
 * `code` spans first (so their contents are not further formatted), then **bold**.
 * Input MUST already be HTML-escaped; we only inject our own known-safe tags.
 */
function renderInline(escaped: string): string {
  // `code` — capture non-greedy between backticks.
  let out = escaped.replace(/`([^`]+)`/g, (_m, code: string) => `<code class="socMono">${code}</code>`);
  // **bold**
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, b: string) => `<strong>${b}</strong>`);
  return out;
}

/**
 * Turn an assistant answer into XSS-safe HTML supporting **bold**, `code`, and
 * bullet lines (lines starting with `- ` or `* `). Everything is HTML-escaped
 * BEFORE any of our own tags are introduced, so log-derived / model output can
 * never inject live markup. Dependency-free; local to this file by design.
 */
function renderMarkdown(raw: string): string {
  const lines = raw.split('\n');
  const html: string[] = [];
  let inList = false;
  for (const line of lines) {
    const escaped = escapeHtml(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(escaped);
    if (bullet) {
      if (!inList) {
        html.push('<ul class="socMd__list">');
        inList = true;
      }
      html.push(`<li>${renderInline(bullet[1])}</li>`);
      continue;
    }
    if (inList) {
      html.push('</ul>');
      inList = false;
    }
    if (escaped.trim() === '') {
      html.push('<br/>');
    } else {
      html.push(`<div>${renderInline(escaped)}</div>`);
    }
  }
  if (inList) {
    html.push('</ul>');
  }
  return html.join('');
}

/** Compact time-of-day stamp for a transcript footnote (e.g. "3:42 PM"). */
function clockTime(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

/** True for an "empty" cell value (null / undefined / blank string). */
function isBlankCell(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

/* --------------------------------------------------------------- subviews -- */

/**
 * Render a chat result table (columns + row arrays) as an EuiBasicTable, INSIDE
 * the assistant bubble flow.
 *
 * Hardening over the old version:
 *  - Columns that are entirely empty (every row blank for that column) are HIDDEN,
 *    so the agent's typical sparse rows (host/ip/user all missing) don't render as
 *    a wall of em-dashes. If *every* column is empty we show a subtle note instead.
 *  - Rows are capped at MAX_TABLE_ROWS with a "+N more" footnote (this is in
 *    addition to any server-side `truncated` flag).
 *  - The table is wrapped in a width-constrained, horizontally-scrollable box so a
 *    wide table can never blow past the bubble or detach its sticky header.
 */
const ResultTable: React.FC<{ table: ChatTable }> = ({ table }) => {
  // Which column indices have at least one non-empty value across all rows.
  const visibleCols = useMemo(() => {
    const out: number[] = [];
    table.columns.forEach((_name, ci) => {
      const hasValue = table.rows.some((row) => !isBlankCell(row[ci]));
      if (hasValue) out.push(ci);
    });
    return out;
  }, [table]);

  const cappedRows = useMemo(() => table.rows.slice(0, MAX_TABLE_ROWS), [table.rows]);
  const hiddenRowCount = Math.max(0, table.rows.length - cappedRows.length);

  const items = useMemo(
    () =>
      cappedRows.map((row, ri) => {
        const obj: Record<string, unknown> = { __rowId: ri };
        visibleCols.forEach((ci) => {
          obj[`c${ci}`] = row[ci];
        });
        return obj;
      }),
    [cappedRows, visibleCols],
  );

  const columns = useMemo<Array<EuiBasicTableColumn<Record<string, unknown>>>>(
    () =>
      visibleCols.map((ci) => ({
        field: `c${ci}`,
        // Column name is source/agent-derived — EUI renders the `name` string as a
        // plain text node, so this is safe.
        name: table.columns[ci],
        truncateText: true,
        render: (value: unknown) => (isBlankCell(value) ? '—' : String(value)),
      })),
    [visibleCols, table.columns],
  );

  if (!table.columns.length || !table.rows.length) {
    return null;
  }

  // Every column was empty — don't render an empty grid; say so subtly.
  if (!visibleCols.length) {
    return (
      <div className="socResultTable">
        <EuiPanel hasBorder paddingSize="s" color="subdued" hasShadow={false}>
          <EuiText size="xs" color="subdued">
            <EuiIcon type="tableDensityCompact" size="s" style={{ marginRight: 6 }} aria-hidden />
            <span>
              {table.rows.length} {table.rows.length === 1 ? 'row' : 'rows'} returned, but no field
              values to display.
            </span>
          </EuiText>
        </EuiPanel>
      </div>
    );
  }

  return (
    <div className="socResultTable">
      <EuiPanel hasBorder paddingSize="none" hasShadow={false}>
        <div className="socResultTable__scroll">
          <EuiBasicTable
            items={items}
            columns={columns}
            rowHeader={`c${visibleCols[0]}`}
            responsiveBreakpoint={false}
            compressed
          />
        </div>
        {hiddenRowCount > 0 || table.truncated ? (
          <div className="socResultTable__foot">
            <EuiText size="xs" color="subdued">
              <span>
                {hiddenRowCount > 0
                  ? `Showing first ${cappedRows.length} of ${table.rows.length} rows · +${hiddenRowCount} more`
                  : 'Results truncated.'}
              </span>
            </EuiText>
          </div>
        ) : null}
      </EuiPanel>
    </div>
  );
};

/** The "query used" chip + per-message cost/model footnote shown under an answer. */
const AnswerMeta: React.FC<{ resp: ChatResponse; model?: string }> = ({ resp, model }) => {
  const hasQuery = typeof resp.query === 'string' && resp.query.trim().length > 0;
  const hasCost = typeof resp.cost === 'number' && resp.cost > 0;
  const hasModel = typeof model === 'string' && model.trim().length > 0;
  if (!hasQuery && !hasCost && !hasModel) {
    return null;
  }
  return (
    <div style={{ marginTop: 8 }}>
      {hasQuery ? (
        <EuiFlexGroup
          gutterSize="xs"
          alignItems="center"
          responsive={false}
          wrap
          style={{ marginBottom: hasCost || hasModel ? 6 : 0 }}
        >
          <EuiFlexItem grow={false}>
            <EuiText size="xs" color="subdued">
              <span>Query used</span>
            </EuiText>
          </EuiFlexItem>
          <EuiFlexItem grow={false} style={{ minWidth: 0 }}>
            <span className="socMono" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {resp.query}
            </span>
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiCopy textToCopy={resp.query ?? ''}>
              {(copy) => (
                <EuiButtonIcon
                  iconType="copyClipboard"
                  aria-label="Copy query"
                  onClick={copy}
                  color="text"
                  size="xs"
                />
              )}
            </EuiCopy>
          </EuiFlexItem>
        </EuiFlexGroup>
      ) : null}
      {hasCost || hasModel ? (
        <EuiFlexGroup gutterSize="m" alignItems="center" responsive={false} wrap>
          {hasCost ? (
            <EuiFlexItem grow={false}>
              <EuiText size="xs" color="subdued">
                <EuiIcon type="visGauge" size="s" style={{ marginRight: 4 }} aria-hidden />
                <span>{fmtMoney(resp.cost)} this message</span>
              </EuiText>
            </EuiFlexItem>
          ) : null}
          {hasModel ? (
            <EuiFlexItem grow={false}>
              <EuiText size="xs" color="subdued">
                <EuiIcon type="machineLearningApp" size="s" style={{ marginRight: 4 }} aria-hidden />
                {/* model id is operator-configured, not log-derived; plain text. */}
                <span className="socMono">{model}</span>
              </EuiText>
            </EuiFlexItem>
          ) : null}
        </EuiFlexGroup>
      ) : null}
    </div>
  );
};

/* ----------------------------------------------------------- provenance ---- */

/**
 * Pull a usable http(s) deep-link out of the backend's `discover` payload. The
 * backend returns an open-in-Discover descriptor; we accept either a direct
 * `url`/`href` string or a `path` we treat as same-origin. Anything that is not a
 * plain http(s) URL (or a leading-slash path) is rejected so we never render a
 * `javascript:` / `data:` link from a model- or log-derived value.
 */
function discoverHref(discover: ChatResponse['discover']): string | null {
  if (!discover || typeof discover !== 'object') return null;
  const candidate =
    (typeof discover.url === 'string' && discover.url) ||
    (typeof discover.href === 'string' && discover.href) ||
    (typeof discover.path === 'string' && discover.path) ||
    '';
  const s = candidate.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('/')) return s; // same-origin path
  return null;
}

/**
 * "How the agent got this" — a collapsed provenance disclosure rendered only when
 * the response carries any of tools / knowledge / reasoning / citations. EVERY value
 * is UNTRUSTED (model- or log-derived) and rendered as plain text / `EuiCodeBlock`.
 */
const Provenance: React.FC<{ resp: ChatResponse; turnId: number }> = ({ resp, turnId }) => {
  const tools = Array.isArray(resp.tools) ? resp.tools : [];
  const knowledge = Array.isArray(resp.knowledge) ? resp.knowledge : [];
  const citations = Array.isArray(resp.citations) ? resp.citations : [];
  const reasoning = typeof resp.reasoning === 'string' ? resp.reasoning.trim() : '';
  const hasAny = tools.length > 0 || knowledge.length > 0 || citations.length > 0 || !!reasoning;
  if (!hasAny) return null;

  return (
    <div style={{ marginTop: 8 }}>
      <EuiAccordion
        // The per-turn id keeps the accordion DOM id unique across turns (two
        // consecutive answers can carry the same case_id + counts otherwise).
        id={`socProv-${turnId}`}
        arrowDisplay="left"
        buttonContent={
          <EuiText size="xs" color="subdued">
            <EuiIcon type="inspect" size="s" style={{ marginRight: 6 }} aria-hidden />
            <span>How the agent got this</span>
          </EuiText>
        }
        paddingSize="none"
      >
        <div style={{ paddingTop: 8 }}>
          {tools.length ? (
            <div style={{ marginBottom: 10 }}>
              <EuiText size="xs" color="subdued">
                <strong>Tools run</strong>
              </EuiText>
              <EuiSpacer size="xs" />
              {tools.map((t, i) => (
                <div key={i} style={{ marginBottom: 6 }}>
                  <EuiText size="xs">
                    {/* tool name is engine-derived → plain text. */}
                    <strong>{String(t.tool ?? 'tool')}</strong>
                    {t.summary ? <span style={{ color: COLORS.subdued }}>{` — ${t.summary}`}</span> : null}
                  </EuiText>
                  {t.query ? (
                    <EuiCodeBlock language="text" fontSize="s" paddingSize="s" isCopyable>
                      {t.query}
                    </EuiCodeBlock>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          {knowledge.length ? (
            <div style={{ marginBottom: 10 }}>
              <EuiText size="xs" color="subdued">
                <strong>Knowledge consulted</strong>
              </EuiText>
              <EuiSpacer size="xs" />
              {knowledge.map((k, i) => (
                <div key={i} style={{ marginBottom: 6 }}>
                  <EuiText size="xs" color="subdued">
                    {/* source label is corpus-derived → plain text. */}
                    <span className="socMono">{String(k.source ?? '')}</span>
                  </EuiText>
                  {k.snippet ? (
                    <EuiCodeBlock language="text" fontSize="s" paddingSize="s">
                      {k.snippet}
                    </EuiCodeBlock>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          {citations.length ? (
            <div style={{ marginBottom: 10 }}>
              <EuiText size="xs" color="subdued">
                <strong>Citations</strong>
              </EuiText>
              <EuiSpacer size="xs" />
              {citations.map((c, i) => (
                <EuiText key={i} size="xs">
                  {/* citation source/snippet are UNTRUSTED → plain text. */}
                  <span style={{ fontWeight: 600 }}>{`[${c.n}] `}</span>
                  <span className="socMono">{String(c.source ?? '')}</span>
                  {c.snippet ? <span style={{ color: COLORS.subdued }}>{` — ${c.snippet}`}</span> : null}
                </EuiText>
              ))}
            </div>
          ) : null}

          {reasoning ? (
            <div>
              <EuiText size="xs" color="subdued">
                <strong>Reasoning</strong>
              </EuiText>
              <EuiSpacer size="xs" />
              {/* reasoning excerpt is model-derived → plain text via EuiCodeBlock. */}
              <EuiCodeBlock language="text" fontSize="s" paddingSize="s" whiteSpace="pre-wrap">
                {reasoning}
              </EuiCodeBlock>
            </div>
          ) : null}
        </div>
      </EuiAccordion>
    </div>
  );
};

/**
 * Per-message action row under an assistant answer: Copy (raw answer), Regenerate
 * (re-send the prior user turn), an open-in-Discover deep-link (when the backend
 * returned a safe one), and local 👍/👎 feedback (kept in component state only — no
 * backend call). Feedback is purely a local affordance for this round.
 */
const MessageActions: React.FC<{
  answer: string;
  resp?: ChatResponse;
  canRegenerate: boolean;
  onRegenerate: () => void;
}> = ({ answer, resp, canRegenerate, onRegenerate }) => {
  const [feedback, setFeedback] = useState<'up' | 'down' | null>(null);
  const href = discoverHref(resp?.discover);

  return (
    <EuiFlexGroup
      gutterSize="xs"
      alignItems="center"
      responsive={false}
      wrap
      className="socMsgActions"
      style={{ marginTop: 8 }}
    >
      <EuiFlexItem grow={false}>
        <EuiCopy textToCopy={answer}>
          {(copy) => (
            <EuiToolTip content="Copy answer">
              <EuiButtonIcon
                iconType="copy"
                aria-label="Copy answer"
                onClick={copy}
                color="text"
                size="xs"
              />
            </EuiToolTip>
          )}
        </EuiCopy>
      </EuiFlexItem>
      {canRegenerate ? (
        <EuiFlexItem grow={false}>
          <EuiToolTip content="Regenerate this answer">
            <EuiButtonIcon
              iconType="refresh"
              aria-label="Regenerate answer"
              onClick={onRegenerate}
              color="text"
              size="xs"
            />
          </EuiToolTip>
        </EuiFlexItem>
      ) : null}
      {href ? (
        <EuiFlexItem grow={false}>
          <EuiButtonEmpty
            size="xs"
            iconType="popout"
            color="text"
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            flush="both"
          >
            Open in Discover
          </EuiButtonEmpty>
        </EuiFlexItem>
      ) : null}
      <EuiFlexItem grow={false}>
        <EuiToolTip content="Helpful">
          <EuiButtonIcon
            iconType="faceHappy"
            aria-label="Mark answer helpful"
            aria-pressed={feedback === 'up'}
            color={feedback === 'up' ? 'success' : 'text'}
            size="xs"
            onClick={() => setFeedback((f) => (f === 'up' ? null : 'up'))}
          />
        </EuiToolTip>
      </EuiFlexItem>
      <EuiFlexItem grow={false}>
        <EuiToolTip content="Not helpful">
          <EuiButtonIcon
            iconType="faceSad"
            aria-label="Mark answer not helpful"
            aria-pressed={feedback === 'down'}
            color={feedback === 'down' ? 'danger' : 'text'}
            size="xs"
            onClick={() => setFeedback((f) => (f === 'down' ? null : 'down'))}
          />
        </EuiToolTip>
      </EuiFlexItem>
      {feedback ? (
        <EuiFlexItem grow={false}>
          <EuiText size="xs" color="subdued">
            <span>Thanks for the feedback</span>
          </EuiText>
        </EuiFlexItem>
      ) : null}
    </EuiFlexGroup>
  );
};

/* --------------------------------------------------------------- memory ---- */

/**
 * Echo of a memory mutation the chat engine ALREADY performed this turn (the user
 * explicitly directed "remember"/"forget"). Purely a confirmation — the change is
 * done server-side. The memory `text` is UNTRUSTED and rendered as plain text only.
 */
const MemoryActionEcho: React.FC<{ action: ChatMemoryAction }> = ({ action }) => {
  const op = (action.op || '').toLowerCase();
  const isDelete = op === 'delete';
  const hasText = typeof action.text === 'string' && action.text.trim().length > 0;
  if (!isDelete && !hasText) {
    return null;
  }
  const label = isDelete ? 'Forgot this fact' : op === 'update' ? 'Memory updated' : 'Remembered';
  return (
    <div style={{ marginTop: 8 }}>
      <EuiPanel
        hasBorder
        paddingSize="s"
        color="transparent"
        hasShadow={false}
        style={{ borderColor: tint(COLORS.success, 0.4) }}
      >
        <EuiFlexGroup gutterSize="s" alignItems="flexStart" responsive={false}>
          <EuiFlexItem grow={false}>
            <EuiIcon type="memory" color={COLORS.success} size="m" aria-hidden />
          </EuiFlexItem>
          <EuiFlexItem>
            <EuiText size="xs">
              <strong style={{ color: COLORS.success }}>{label}</strong>
              {hasText ? (
                // UNTRUSTED — plain text node, never markup.
                <span style={{ color: COLORS.subdued }}>{`: ${action.text}`}</span>
              ) : null}
            </EuiText>
          </EuiFlexItem>
        </EuiFlexGroup>
      </EuiPanel>
    </div>
  );
};

/**
 * An inline, dismissible prompt offering to save a memory the chat engine PROPOSED
 * (not yet saved). Local per-message state prevents a handled suggestion from
 * re-appearing and prevents a double-save. The suggested `text` / `reason` are
 * UNTRUSTED and rendered as plain text only.
 */
const MemorySuggestionPrompt: React.FC<{ suggestion: ChatMemorySuggestion }> = ({ suggestion }) => {
  const [state, setState] = useState<'pending' | 'saving' | 'saved' | 'dismissed' | 'error'>(
    'pending',
  );
  const [error, setError] = useState<string | null>(null);

  const text = (suggestion.text || '').trim();
  if (!text || state === 'dismissed') {
    return null;
  }

  const remember = async () => {
    if (state === 'saving' || state === 'saved') {
      return;
    }
    setState('saving');
    setError(null);
    try {
      await api.addMemory({ text });
      setState('saved');
    } catch (e) {
      const msg =
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Could not save to memory.';
      setError(msg);
      setState('error');
    }
  };

  const saved = state === 'saved';
  const saving = state === 'saving';

  return (
    <div style={{ marginTop: 8 }}>
      <EuiPanel
        hasBorder
        paddingSize="s"
        color="transparent"
        hasShadow={false}
        style={{ borderColor: tint(COLORS.accent, 0.4) }}
      >
        <EuiFlexGroup gutterSize="s" alignItems="flexStart" responsive={false}>
          <EuiFlexItem grow={false}>
            <EuiIcon type="memory" color={COLORS.accent} size="m" aria-hidden />
          </EuiFlexItem>
          <EuiFlexItem>
            <EuiText size="xs" color="subdued">
              <span>Save this to memory?</span>
            </EuiText>
            <EuiSpacer size="xs" />
            <EuiText size="s">
              {/* UNTRUSTED — plain text node, never markup. */}
              <span>{text}</span>
            </EuiText>
            {suggestion.reason && suggestion.reason.trim() ? (
              <>
                <EuiSpacer size="xs" />
                <EuiText size="xs" color="subdued">
                  {/* UNTRUSTED — plain text node. */}
                  <span>{suggestion.reason}</span>
                </EuiText>
              </>
            ) : null}

            <EuiSpacer size="s" />

            {saved ? (
              <EuiText size="xs" style={{ color: COLORS.success }}>
                <EuiIcon type="check" size="s" style={{ marginRight: 4 }} aria-hidden />
                <span>Saved to memory</span>
              </EuiText>
            ) : (
              <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false} wrap>
                <EuiFlexItem grow={false}>
                  <EuiButton
                    size="s"
                    fill
                    iconType="memory"
                    onClick={() => void remember()}
                    isLoading={saving}
                    isDisabled={saving}
                  >
                    Remember this
                  </EuiButton>
                </EuiFlexItem>
                <EuiFlexItem grow={false}>
                  <EuiButtonEmpty
                    size="s"
                    color="text"
                    iconType="cross"
                    onClick={() => setState('dismissed')}
                    isDisabled={saving}
                    flush="left"
                  >
                    Dismiss
                  </EuiButtonEmpty>
                </EuiFlexItem>
              </EuiFlexGroup>
            )}

            {state === 'error' && error ? (
              <>
                <EuiSpacer size="xs" />
                <EuiText size="xs" color="danger">
                  {/* Error message from our own API layer — safe text. */}
                  <span>{error}</span>
                </EuiText>
              </>
            ) : null}
          </EuiFlexItem>
        </EuiFlexGroup>
      </EuiPanel>
    </div>
  );
};

/* --------------------------------------------------------------- bubbles --- */

/** A subdued, role-aligned sender label + time-of-day footnote under a bubble. */
const MetaLine: React.FC<{ who: string; at: number; align: 'start' | 'end' }> = ({
  who,
  at,
  align,
}) => (
  <EuiText
    size="xs"
    color="subdued"
    className="socMsgMeta"
    style={{ alignSelf: align === 'end' ? 'flex-end' : 'flex-start' }}
  >
    <span style={{ fontWeight: 600 }}>{who}</span>
    <span style={{ opacity: 0.7 }}>{` · ${clockTime(at)}`}</span>
  </EuiText>
);

/**
 * A single assistant or user message row, with avatar + trailing metadata/table.
 *
 * `grouped` = this turn immediately follows another from the SAME sender; when set
 * we suppress the avatar + sender meta-line so consecutive turns read as one block
 * (the time-of-day stamp still shows on the last turn of a run via `showMeta`).
 */
const Bubble: React.FC<{
  item: TranscriptItem;
  grouped?: boolean;
  showMeta?: boolean;
  canRegenerate?: boolean;
  onRegenerate?: () => void;
}> = ({ item, grouped = false, showMeta = true, canRegenerate = false, onRegenerate }) => {
  if (item.role === 'user') {
    return (
      <div className={`socMsgRow socMsgRow--user${grouped ? ' socMsgRow--grouped' : ''}`}>
        <div className="socMsgRow__stack socMsgRow__stack--user">
          <div className="socBubble socBubble--user">{item.content}</div>
          {showMeta ? <MetaLine who="You" at={item.at} align="end" /> : null}
        </div>
      </div>
    );
  }

  // Assistant (answer or error) — left-aligned with an agent avatar (hidden when
  // this turn is grouped under the previous assistant turn).
  return (
    <div className={`socMsgRow socMsgRow--assistant${grouped ? ' socMsgRow--grouped' : ''}`}>
      <div className="socMsgRow__avatar" aria-hidden>
        {grouped ? null : <IconChip icon="discuss" accent={COLORS.accent} />}
      </div>
      <div className="socMsgRow__stack socMsgRow__stack--assistant">
        {item.isError ? (
          <EuiCallOut size="s" color="danger" iconType="alert" title="The agent could not answer">
            <p style={{ margin: 0 }}>{item.content}</p>
          </EuiCallOut>
        ) : (
          <div
            className="socBubble socBubble--assistant socMd"
            // Safe: renderMarkdown HTML-escapes the model/log text before injecting
            // only its own known tags (bold/code/bullets). See renderMarkdown above.
            dangerouslySetInnerHTML={{ __html: renderMarkdown(item.content) }}
          />
        )}
        {item.resp?.table ? <ResultTable table={item.resp.table} /> : null}
        {item.resp ? <AnswerMeta resp={item.resp} model={item.model} /> : null}
        {item.resp ? <Provenance resp={item.resp} turnId={item.id} /> : null}
        {!item.isError ? (
          <MessageActions
            answer={item.content}
            resp={item.resp}
            canRegenerate={canRegenerate}
            onRegenerate={onRegenerate ?? (() => {})}
          />
        ) : null}
        {item.resp?.memory_action ? <MemoryActionEcho action={item.resp.memory_action} /> : null}
        {item.resp?.memory_suggestion ? (
          <MemorySuggestionPrompt suggestion={item.resp.memory_suggestion} />
        ) : null}
        {showMeta ? <MetaLine who="SOC agent" at={item.at} align="start" /> : null}
      </div>
    </div>
  );
};

/** Animated "agent is thinking" indicator shown while a reply is in flight. */
const TypingIndicator: React.FC = () => (
  <div className="socMsgRow socMsgRow--assistant" aria-label="Agent is responding">
    <div className="socMsgRow__avatar" aria-hidden>
      <IconChip icon="discuss" accent={COLORS.accent} />
    </div>
    <div className="socBubble socBubble--assistant socTyping">
      <span className="socTyping__dot" />
      <span className="socTyping__dot" />
      <span className="socTyping__dot" />
    </div>
  </div>
);

/* ----------------------------------------------------------- model select -- */

interface SelectOption {
  value: string;
  text: string;
}

/** Flatten provider→models into "<model> · <provider>" options. */
function buildModelOptions(models: ModelsResponse | null): SelectOption[] {
  if (!models) return [];
  const out: SelectOption[] = [];
  for (const [provider, list] of Object.entries(models.providers || {})) {
    for (const m of list || []) {
      out.push({ value: m, text: `${m}  ·  ${provider}` });
    }
  }
  return out;
}

/** A friendly label for a configured source (display name, else type · id). */
function sourceLabel(s: SourceInstance): string {
  const name = (s.display_name || '').trim();
  if (name) return name;
  const type = (s.source_type || '').trim();
  return type ? `${type} · ${s.id}` : s.id;
}

/* --------------------------------------------------------------- panel ----- */

/**
 * The reusable chat engine. Forwards a `ChatPanelHandle` so hosts can reset the
 * conversation (the standalone page's "New chat"). Embeds inside the flyout via
 * `<ChatPanel caseId={id} compact />`.
 */
export const ChatPanel = forwardRef<ChatPanelHandle, ChatPanelProps>(function ChatPanel(
  { caseId, compact = false, placeholder, starters = [] },
  ref,
) {
  const [input, setInput] = useState('');
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [loading, setLoading] = useState(false);

  // Model selection (optional per-turn override). Empty string = backend default.
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [model, setModel] = useState<string>('');

  // Source scope. ALL_SOURCES ('') = the configured/primary source (no source_id
  // is sent); a specific id scopes the chat to that one source.
  const [sources, setSources] = useState<SourceInstance[]>([]);
  const [sourceId, setSourceId] = useState<string>(ALL_SOURCES);

  const idRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const nextId = () => {
    idRef.current += 1;
    return idRef.current;
  };

  // Fetch the available models + configured sources once (best-effort; the pickers
  // simply stay at their defaults — "Default model" / "All sources" — if the calls
  // fail or nothing is configured).
  useEffect(() => {
    let cancelled = false;
    void api
      .getModels()
      .then((res) => {
        if (!cancelled) setModels(res);
      })
      .catch(() => {
        /* non-fatal: chat works fine on the backend default model. */
      });
    void api
      .listSources()
      .then((res) => {
        if (!cancelled) setSources(res.sources || []);
      })
      .catch(() => {
        /* non-fatal: the source selector just shows "All sources". */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep the transcript pinned to the latest message (smooth auto-scroll within the
  // lane; honours prefers-reduced-motion via the conditional behaviour).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const reduce =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ top: el.scrollHeight, behavior: reduce ? 'auto' : 'smooth' });
  }, [transcript, loading]);

  const send = useCallback(
    async (raw?: string) => {
      const message = (raw ?? input).trim();
      if (!message || loading) {
        return;
      }

      const userTurn: ChatTurn = { role: 'user', content: message };
      const sentHistory = [...history, userTurn];
      const usedModel = model.trim() || undefined;
      const usedSource = sourceId.trim() || undefined;

      setTranscript((prev) => [
        ...prev,
        { id: nextId(), role: 'user', content: message, at: Date.now() },
      ]);
      setHistory(sentHistory);
      setInput('');
      setLoading(true);

      try {
        // caseId + model + sourceId are only forwarded when set, so the
        // no-case / no-model / no-source path is byte-for-byte the original
        // behaviour (see api.chat).
        const resp = await api.chat(message, sentHistory, caseId, usedModel, usedSource);
        const answer = resp.answer || '(no answer returned)';
        setTranscript((prev) => [
          ...prev,
          {
            id: nextId(),
            role: 'assistant',
            content: answer,
            resp,
            at: Date.now(),
            model: usedModel,
          },
        ]);
        setHistory((prev) => [...prev, { role: 'assistant', content: answer }]);
      } catch (e) {
        const msg =
          e instanceof ApiError
            ? e.message
            : e instanceof Error
              ? e.message
              : 'Unexpected error contacting the agent.';
        setTranscript((prev) => [
          ...prev,
          { id: nextId(), role: 'assistant', content: msg, isError: true, at: Date.now() },
        ]);
        // Intentionally do NOT push the error into `history` so the model isn't
        // conditioned on its own failure on the next turn.
      } finally {
        setLoading(false);
        // Return focus to the composer after a turn so keyboard users can keep
        // typing without re-targeting the input (a11y: qu31).
        inputRef.current?.focus();
      }
    },
    [input, history, loading, caseId, model, sourceId],
  );

  // Regenerate: re-send the user turn that immediately preceded a given assistant
  // turn (a fresh exchange is appended — the original answer is left in place). No-op
  // if a reply is in flight or no preceding user turn can be found.
  const regenerate = useCallback(
    (assistantId: number) => {
      if (loading) return;
      setTranscript((prev) => {
        const idx = prev.findIndex((t) => t.id === assistantId);
        for (let i = idx - 1; i >= 0; i -= 1) {
          if (prev[i].role === 'user') {
            const content = prev[i].content;
            // Defer the send so we don't dispatch during this state update.
            queueMicrotask(() => void send(content));
            break;
          }
        }
        return prev;
      });
    },
    [loading, send],
  );

  const reset = useCallback(() => {
    setTranscript([]);
    setHistory([]);
    setInput('');
    inputRef.current?.focus();
  }, []);

  useImperativeHandle(ref, () => ({ reset }), [reset]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const modelOptions = useMemo(() => buildModelOptions(models), [models]);
  const hasModels = modelOptions.length > 0;

  const sourceOptions = useMemo<SelectOption[]>(
    () => [
      { value: ALL_SOURCES, text: 'All sources' },
      ...sources.map((s) => ({ value: s.id, text: sourceLabel(s) })),
    ],
    [sources],
  );
  const hasSources = sources.length > 0;

  const isEmpty = transcript.length === 0;
  const composerPlaceholder =
    placeholder ?? 'Ask a question…  (Enter to send · Shift+Enter for a new line)';

  /* The model selector — compact, lives in the composer toolbar. Only shown when
     the backend reports at least one configured provider/model. */
  const modelSelect = hasModels ? (
    <EuiToolTip content="Model for this conversation (defaults to the configured chat model)">
      <EuiSelect
        compressed
        prepend={<EuiIcon type="machineLearningApp" size="s" />}
        aria-label="Model"
        options={[{ value: '', text: 'Default model' }, ...modelOptions]}
        value={model}
        onChange={(e) => setModel(e.target.value)}
        style={{ minWidth: compact ? 150 : 200 }}
      />
    </EuiToolTip>
  ) : null;

  /* The source-scope selector — defaults to "All sources". Shown whenever any
     source is configured. */
  const sourceSelect = hasSources ? (
    <EuiToolTip content="Which source the agent queries for this conversation">
      <EuiSelect
        compressed
        prepend={<EuiIcon type="database" size="s" />}
        aria-label="Source"
        options={sourceOptions}
        value={sourceId}
        onChange={(e) => setSourceId(e.target.value)}
        style={{ minWidth: compact ? 150 : 190 }}
      />
    </EuiToolTip>
  ) : null;

  return (
    <div className={`socChatPanel${compact ? ' socChatPanel--compact' : ''}`}>
      {/* Scoped styling — chat-only visuals (layout shell, avatars, composer,
          typing dots, result-table box) kept local to this component so no shared
          CSS is edited. Uses the runtime accent CSS vars (--soc-accent /
          --soc-accent-tint) so it is theme-safe (light + dark). */}
      <style>{`
        /* Full-height flex shell — the panel fills its host; ONLY the lane scrolls. */
        .socChatPanel { display: flex; flex-direction: column; height: 100%; min-height: 0; }

        .socChatPanel .socMd > div { margin: 0; }
        .socChatPanel .socMd > div + div { margin-top: 4px; }
        .socChatPanel .socMd .socMd__list { margin: 4px 0; padding-left: 18px; }
        .socChatPanel .socMd .socMd__list li { margin: 2px 0; }
        .socChatPanel .socMd code.socMono { white-space: pre-wrap; word-break: break-word; }

        /* The scrolling transcript lane. flex:1 + min-height:0 lets it absorb all
           remaining vertical space (no dead band) and scroll internally. The inner
           rows stack via display:flex (NOT inherited from .socChat's gap rule,
           which we restate here so the lane owns its own spacing). */
        .socChatLane {
          flex: 1 1 auto;
          min-height: 0;
          overflow-y: auto;
          overflow-x: hidden;
          display: flex;
          flex-direction: column;
          padding: 6px 12px 10px 6px;
        }
        .socChatLane--compact { padding: 4px 6px 8px 2px; }

        /* When empty, centre the empty state in the lane instead of top-anchoring,
           so the composer stays pinned to the bottom with no gap above it. */
        .socChatLane--empty { justify-content: center; }

        .socMsgRow { display: flex; gap: 10px; align-items: flex-start; }
        .socMsgRow--user { justify-content: flex-end; }
        .socMsgRow--assistant { justify-content: flex-start; }
        .socMsgRow__avatar { flex: 0 0 auto; margin-top: 2px; }
        .socMsgRow__stack { display: flex; flex-direction: column; min-width: 0; }
        .socMsgRow__stack--user { max-width: min(80%, 720px); }
        /* Assistant grows to take the lane width (so wide tables get room) but is
           still capped so prose stays a comfortable measure. */
        .socMsgRow__stack--assistant { flex: 1 1 auto; max-width: min(92%, 820px); }
        .socMsgRow .socBubble { margin: 0; }
        .socMsgMeta { margin-top: 4px; }

        /* Grouped (same-sender continuation) rows sit tighter under their lead row
           and reserve the avatar gutter so bubbles stay aligned. */
        .socMsgRow--grouped { margin-top: -6px; }
        .socMsgRow--assistant.socMsgRow--grouped .socMsgRow__avatar { width: 28px; }

        /* Per-message action row — slightly recessed until hovered/focused so it
           doesn't compete with the answer, but always reachable by keyboard. */
        .socMsgActions { opacity: 0.65; transition: opacity 0.15s ease; }
        .socMsgRow--assistant:hover .socMsgActions,
        .socMsgActions:focus-within { opacity: 1; }
        @media (prefers-reduced-motion: reduce) {
          .socMsgActions { transition: none; }
        }

        .socChatPanel--compact .socBubble { padding: 8px 12px; border-radius: 12px; }
        .socChatPanel--compact .socMsgRow__stack--user { max-width: 92%; }
        .socChatPanel--compact .socMsgRow__stack--assistant { max-width: 100%; }

        /* Result table — constrained to the bubble width, horizontally scrollable
           if the table is wider. The wrapper's max-width keeps the table inside the
           assistant stack so its sticky header can never detach/float. */
        .socResultTable { margin-top: 8px; max-width: 100%; }
        .socResultTable__scroll { overflow-x: auto; overflow-y: hidden; max-width: 100%; }
        .socResultTable__scroll .euiTable { width: auto; min-width: 100%; }
        .socResultTable__foot { padding: 6px 10px; }

        /* Composer — pinned at the bottom of the shell. */
        .socChatComposer { flex: 0 0 auto; }

        /* Typing indicator — three pulsing dots. */
        .socTyping { display: inline-flex; align-items: center; gap: 5px; }
        .socTyping__dot {
          width: 6px; height: 6px; border-radius: 50%;
          background: var(--soc-accent, ${COLORS.accent});
          opacity: 0.5; animation: socTypingPulse 1.1s ease-in-out infinite;
        }
        .socTyping__dot:nth-child(2) { animation-delay: 0.18s; }
        .socTyping__dot:nth-child(3) { animation-delay: 0.36s; }
        @keyframes socTypingPulse {
          0%, 80%, 100% { opacity: 0.35; transform: translateY(0); }
          40% { opacity: 1; transform: translateY(-2px); }
        }

        /* Empty-state starter chips. */
        .socStarter { animation: socStarterIn 0.25s ease both; }
        @keyframes socStarterIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

        @media (prefers-reduced-motion: reduce) {
          .socTyping__dot { animation: none; opacity: 0.6; }
          .socStarter { animation: none; }
        }
      `}</style>

      {/* Scope chip — only when scoped to a case. Compact header at the top. */}
      {caseId ? (
        <div style={{ flex: '0 0 auto', marginBottom: compact ? 6 : 10 }}>
          <EuiText size="xs" color="subdued">
            <EuiIcon type="link" size="s" style={{ marginRight: 4 }} aria-hidden />
            <span>Scoped to case </span>
            <span className="socMono">{caseId}</span>
          </EuiText>
        </div>
      ) : null}

      {/* Transcript lane — the ONLY scrolling region. */}
      <div
        ref={scrollRef}
        className={`socChatLane${compact ? ' socChatLane--compact' : ''}${
          isEmpty ? ' socChatLane--empty' : ''
        }`}
        style={{ gap: isEmpty ? 0 : compact ? 10 : 14 }}
        role="log"
        aria-live="polite"
        aria-busy={loading}
        aria-label="Chat transcript"
      >
        {isEmpty ? (
          <EmptyState
            compact={compact}
            scoped={!!caseId}
            starters={starters}
            loading={loading}
            onPick={(p) => void send(p)}
          />
        ) : (
          <>
            {transcript.map((item, i) => {
              const prev = transcript[i - 1];
              const next = transcript[i + 1];
              // Group when the previous turn is from the same sender (suppress the
              // avatar + sender label); show the time stamp only on the LAST turn of
              // a same-sender run so a grouped block reads as one block.
              const grouped = !!prev && prev.role === item.role;
              const showMeta = !next || next.role !== item.role;
              return (
                <Bubble
                  key={item.id}
                  item={item}
                  grouped={grouped}
                  showMeta={showMeta}
                  canRegenerate={item.role === 'assistant' && !item.isError && !loading}
                  onRegenerate={() => regenerate(item.id)}
                />
              );
            })}
            {loading ? <TypingIndicator /> : null}
          </>
        )}
      </div>

      {/* Composer — pinned bottom card. */}
      <EuiPanel
        className="socChatComposer"
        hasBorder
        hasShadow={false}
        paddingSize={compact ? 's' : 'm'}
        style={{ marginTop: compact ? 8 : 12, borderRadius: 14 }}
      >
        <EuiFlexGroup gutterSize="s" alignItems="flexEnd" responsive={false}>
          <EuiFlexItem>
            <EuiTextArea
              inputRef={(el) => {
                inputRef.current = el;
              }}
              placeholder={composerPlaceholder}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={loading}
              fullWidth
              rows={compact ? 2 : 3}
              resize="none"
              aria-label="Chat message"
              style={{ background: 'transparent' }}
            />
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiToolTip content={loading ? 'Waiting for the agent…' : 'Send (Enter)'}>
              <EuiButton
                fill
                iconType="returnKey"
                onClick={() => void send()}
                isLoading={loading}
                isDisabled={!input.trim() && !loading}
              >
                Send
              </EuiButton>
            </EuiToolTip>
          </EuiFlexItem>
        </EuiFlexGroup>

        {modelSelect || sourceSelect ? (
          <>
            <EuiSpacer size="s" />
            <EuiFlexGroup
              gutterSize="s"
              alignItems="center"
              justifyContent="spaceBetween"
              responsive={false}
              wrap
            >
              <EuiFlexItem grow={false}>
                <EuiText size="xs" color="subdued">
                  <span>Enter to send · Shift+Enter for a new line</span>
                </EuiText>
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false} wrap>
                  {sourceSelect ? <EuiFlexItem grow={false}>{sourceSelect}</EuiFlexItem> : null}
                  {modelSelect ? <EuiFlexItem grow={false}>{modelSelect}</EuiFlexItem> : null}
                </EuiFlexGroup>
              </EuiFlexItem>
            </EuiFlexGroup>
            {/* Honest one-liner: "All sources" currently queries the primary
                source only (a known backend limitation). */}
            {sourceSelect && sourceId === ALL_SOURCES ? (
              <>
                <EuiSpacer size="xs" />
                <EuiText size="xs" color="subdued">
                  <EuiIcon type="iInCircle" size="s" style={{ marginRight: 4 }} aria-hidden />
                  <span>“All sources” currently queries the primary source.</span>
                </EuiText>
              </>
            ) : null}
          </>
        ) : (
          <>
            <EuiSpacer size="s" />
            <EuiText size="xs" color="subdued">
              <span>Enter to send · Shift+Enter for a new line</span>
            </EuiText>
          </>
        )}
      </EuiPanel>
    </div>
  );
});

/* ----------------------------------------------------------- empty state --- */

/**
 * Pick an intent glyph for a starter prompt from a few keyword heuristics, so the
 * chips read at a glance (summaries vs. hunts vs. lookups). Falls back to `search`.
 * Only returns icons registered in `lib/icons.ts`.
 */
function starterIcon(prompt: string): string {
  const p = prompt.toLowerCase();
  if (/\bsummar|today|digest|overview\b/.test(p)) return 'reportingApp';
  if (/\bbrute|attack|suspicious|malic|threat|exploit\b/.test(p)) return 'securityApp';
  if (/\bhost|ip|asset|which |most |top \b/.test(p)) return 'stats';
  return 'search';
}

const EmptyState: React.FC<{
  compact: boolean;
  scoped: boolean;
  starters: string[];
  loading: boolean;
  onPick: (p: string) => void;
}> = ({ compact, scoped, starters, loading, onPick }) => (
  <div
    style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      textAlign: 'center',
      width: '100%',
      padding: compact ? '12px 8px' : '24px 16px',
      margin: '0 auto',
      maxWidth: 620,
    }}
  >
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: compact ? 48 : 64,
        height: compact ? 48 : 64,
        borderRadius: 18,
        background: tint(COLORS.accent, 0.14),
        color: COLORS.accent,
      }}
    >
      <EuiIcon type="discuss" size="xl" />
    </span>
    <EuiSpacer size={compact ? 's' : 'm'} />
    <EuiText>
      <h3 style={{ margin: 0 }}>
        {scoped ? 'Ask about this case' : 'Ask the SOC agent anything'}
      </h3>
      {!compact ? (
        <p style={{ color: COLORS.subdued, marginTop: 6 }}>
          {scoped
            ? 'Dig into the evidence, pull related activity, or ask why the agent reached its verdict.'
            : "Investigate an IP, summarize today's findings, or hunt for suspicious activity. Try one of these to get started:"}
        </p>
      ) : null}
    </EuiText>
    {starters.length ? (
      <>
        <EuiSpacer size={compact ? 's' : 'm'} />
        <EuiFlexGroup gutterSize="s" wrap justifyContent="center" responsive={false}>
          {starters.map((p) => (
            <EuiFlexItem grow={false} key={p} className="socStarter">
              <EuiButton
                size="s"
                color="text"
                iconType={starterIcon(p)}
                onClick={() => onPick(p)}
                isDisabled={loading}
              >
                {p}
              </EuiButton>
            </EuiFlexItem>
          ))}
        </EuiFlexGroup>
      </>
    ) : null}
  </div>
);
