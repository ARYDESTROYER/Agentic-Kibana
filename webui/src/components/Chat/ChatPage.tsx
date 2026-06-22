/**
 * Chat — the conversational triage console.
 *
 * A scrollable transcript of user/assistant bubbles backed by POST /api/chat.
 * Each assistant turn can carry a result `table`, the `query` it ran, and a
 * per-message `cost` footnote. The running `history` is threaded through every
 * request so the backend keeps conversational context. Errors are rendered as
 * non-fatal assistant bubbles so the transcript never crashes.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  EuiBadge,
  EuiBasicTable,
  EuiButton,
  EuiButtonEmpty,
  EuiButtonIcon,
  EuiCallOut,
  EuiCopy,
  EuiFlexGroup,
  EuiFlexItem,
  EuiHorizontalRule,
  EuiIcon,
  EuiLoadingSpinner,
  EuiPanel,
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
} from '../../lib/types';
import { api, ApiError } from '../../lib/api';
import { SectionHeader } from '../common/ui';
import { COLORS, tint } from '../../lib/theme';
import { fmtMoney, formatTimestamp } from '../../lib/format';

/* ------------------------------------------------------------------ types -- */

/** A rendered transcript entry. Assistant turns may carry the full response so
 *  we can render the table / query / cost beneath the bubble. Error turns are
 *  flagged so they render as a non-fatal callout instead of plain prose. */
interface TranscriptItem {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  resp?: ChatResponse;
  isError?: boolean;
  /** ISO time the turn was added to the transcript (for a subdued footnote). */
  at: string;
}

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

const SUGGESTED_PROMPTS = [
  'Show failed logins for 10.0.0.5 in the last 24h',
  "Summarize today's true positives",
  'Any brute-force activity in the last 24h?',
  'Which hosts had the most alerts this week?',
];

/* --------------------------------------------------------------- subviews -- */

/** Render a chat result table (columns + row arrays) as an EuiBasicTable. */
const ResultTable: React.FC<{ table: ChatTable }> = ({ table }) => {
  const items = useMemo(
    () =>
      table.rows.map((row, ri) => {
        const obj: Record<string, unknown> = { __rowId: ri };
        table.columns.forEach((_col, ci) => {
          obj[`c${ci}`] = row[ci];
        });
        return obj;
      }),
    [table],
  );

  const columns = useMemo<Array<EuiBasicTableColumn<Record<string, unknown>>>>(
    () =>
      table.columns.map((name, ci) => ({
        field: `c${ci}`,
        name,
        truncateText: true,
        render: (value: unknown) =>
          value === null || value === undefined || value === ''
            ? '—'
            : String(value),
      })),
    [table.columns],
  );

  if (!table.columns.length || !table.rows.length) {
    return null;
  }

  return (
    <EuiPanel hasBorder paddingSize="s" style={{ marginTop: 8, maxWidth: 760 }}>
      <EuiBasicTable
        items={items}
        columns={columns}
        rowHeader="c0"
        responsiveBreakpoint={false}
        compressed
      />
      {table.truncated ? (
        <EuiText size="xs" color="subdued" style={{ marginTop: 6 }}>
          <span>Results truncated.</span>
        </EuiText>
      ) : null}
    </EuiPanel>
  );
};

/** The "query used" chip + per-message cost footnote shown under an answer. */
const AnswerMeta: React.FC<{ resp: ChatResponse }> = ({ resp }) => {
  const hasQuery = typeof resp.query === 'string' && resp.query.trim().length > 0;
  const hasCost = typeof resp.cost === 'number' && resp.cost > 0;
  if (!hasQuery && !hasCost) {
    return null;
  }
  return (
    <div style={{ maxWidth: 760, marginTop: 8 }}>
      {hasQuery ? (
        <EuiFlexGroup
          gutterSize="xs"
          alignItems="center"
          responsive={false}
          wrap
          style={{ marginBottom: hasCost ? 6 : 0 }}
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
      {hasCost ? (
        <EuiText size="xs" color="subdued">
          <EuiIcon type="visGauge" size="s" style={{ marginRight: 4 }} />
          <span>{fmtMoney(resp.cost)} this message</span>
        </EuiText>
      ) : null}
    </div>
  );
};

/* --------------------------------------------------------------- memory ---- */

/**
 * Echo of a memory mutation the chat engine ALREADY performed this turn (the
 * user explicitly directed "remember"/"forget"). This is purely a confirmation —
 * the change is done server-side, so there is no action here. The memory `text`
 * is UNTRUSTED (agent/log-derived) and is rendered as plain text only.
 */
const MemoryActionEcho: React.FC<{ action: ChatMemoryAction }> = ({ action }) => {
  const op = (action.op || '').toLowerCase();
  const isDelete = op === 'delete';
  const hasText = typeof action.text === 'string' && action.text.trim().length > 0;
  // A delete confirms even without text; add/update need text to be meaningful.
  if (!isDelete && !hasText) {
    return null;
  }
  const label = isDelete
    ? 'Forgot this fact'
    : op === 'update'
      ? 'Memory updated'
      : 'Remembered';
  return (
    <div style={{ maxWidth: 760, marginTop: 8 }}>
      <EuiPanel
        hasBorder
        paddingSize="s"
        color="transparent"
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
 * An inline, dismissible prompt offering to save a memory the chat engine
 * PROPOSED (not yet saved). Local per-message state (this instance is keyed by
 * the message id via its parent <Bubble>) prevents a handled suggestion from
 * re-appearing on re-render and prevents a double-save. The suggested `text` /
 * `reason` are UNTRUSTED and rendered as plain text only.
 */
const MemorySuggestionPrompt: React.FC<{ suggestion: ChatMemorySuggestion }> = ({
  suggestion,
}) => {
  // One of: pending | saving | saved | dismissed | error.
  const [state, setState] = useState<'pending' | 'saving' | 'saved' | 'dismissed' | 'error'>(
    'pending',
  );
  const [error, setError] = useState<string | null>(null);

  const text = (suggestion.text || '').trim();
  if (!text || state === 'dismissed') {
    return null;
  }

  const remember = async () => {
    // Guard against double-save: only fire from the pending/error state.
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
    <div style={{ maxWidth: 760, marginTop: 8 }}>
      <EuiPanel
        hasBorder
        paddingSize="s"
        color="transparent"
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

/** A subdued, right/left-aligned timestamp footnote under a bubble. */
const TimeNote: React.FC<{ at: string; align: 'start' | 'end' }> = ({ at, align }) => (
  <EuiText
    size="xs"
    color="subdued"
    style={{ alignSelf: align === 'end' ? 'flex-end' : 'flex-start', marginTop: 4 }}
  >
    <span>{formatTimestamp(at)}</span>
  </EuiText>
);

/** A single assistant or user bubble, with its trailing metadata/table. */
const Bubble: React.FC<{ item: TranscriptItem }> = ({ item }) => {
  if (item.role === 'user') {
    return (
      <div style={{ alignSelf: 'flex-end', display: 'flex', flexDirection: 'column', maxWidth: 760 }}>
        <div className="socBubble socBubble--user">{item.content}</div>
        <TimeNote at={item.at} align="end" />
      </div>
    );
  }

  if (item.isError) {
    return (
      <div style={{ alignSelf: 'flex-start', maxWidth: 760, width: '100%' }}>
        <EuiCallOut size="s" color="danger" iconType="alert" title="The agent could not answer">
          <p style={{ margin: 0 }}>{item.content}</p>
        </EuiCallOut>
        <TimeNote at={item.at} align="start" />
      </div>
    );
  }

  return (
    <div style={{ alignSelf: 'flex-start', display: 'flex', flexDirection: 'column' }}>
      <div
        className="socBubble socBubble--assistant socMd"
        // Safe: renderMarkdown HTML-escapes the model/log text before injecting
        // only its own known tags (bold/code/bullets). See renderMarkdown above.
        dangerouslySetInnerHTML={{ __html: renderMarkdown(item.content) }}
      />
      {item.resp?.table ? <ResultTable table={item.resp.table} /> : null}
      {item.resp ? <AnswerMeta resp={item.resp} /> : null}
      {item.resp?.memory_action ? <MemoryActionEcho action={item.resp.memory_action} /> : null}
      {item.resp?.memory_suggestion ? (
        <MemorySuggestionPrompt suggestion={item.resp.memory_suggestion} />
      ) : null}
      <TimeNote at={item.at} align="start" />
    </div>
  );
};

/** Animated "agent is thinking" indicator shown while a reply is in flight. */
const TypingIndicator: React.FC = () => (
  <div
    className="socBubble socBubble--assistant"
    style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
    aria-live="polite"
    aria-label="Agent is responding"
  >
    <EuiLoadingSpinner size="s" />
    <EuiText size="s" color="subdued">
      <span>Agent is thinking…</span>
    </EuiText>
  </div>
);

/* ---------------------------------------------------------------- page ----- */

export const ChatPage: React.FC = () => {
  const [input, setInput] = useState('');
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [loading, setLoading] = useState(false);

  const idRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const nextId = () => {
    idRef.current += 1;
    return idRef.current;
  };

  // Keep the transcript pinned to the latest message.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [transcript, loading]);

  const send = useCallback(
    async (raw?: string) => {
      const message = (raw ?? input).trim();
      if (!message || loading) {
        return;
      }

      const userTurn: ChatTurn = { role: 'user', content: message };
      const sentHistory = [...history, userTurn];

      setTranscript((prev) => [
        ...prev,
        { id: nextId(), role: 'user', content: message, at: new Date().toISOString() },
      ]);
      setHistory(sentHistory);
      setInput('');
      setLoading(true);

      try {
        const resp = await api.chat(message, sentHistory);
        const answer = resp.answer || '(no answer returned)';
        setTranscript((prev) => [
          ...prev,
          { id: nextId(), role: 'assistant', content: answer, resp, at: new Date().toISOString() },
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
          { id: nextId(), role: 'assistant', content: msg, isError: true, at: new Date().toISOString() },
        ]);
        // Note: we intentionally do NOT push the error into `history` so the
        // model isn't conditioned on its own failure on the next turn.
      } finally {
        setLoading(false);
      }
    },
    [input, history, loading],
  );

  const newChat = useCallback(() => {
    setTranscript([]);
    setHistory([]);
    setInput('');
    inputRef.current?.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  // On the empty state we pre-fill the composer (so the user can tweak before
  // sending); mid-conversation the thin chip row sends immediately.
  const usePrompt = (prompt: string) => {
    setInput(prompt);
    inputRef.current?.focus();
  };

  const isEmpty = transcript.length === 0;

  return (
    <div
      className="socPageEnter"
      style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 160px)' }}
    >
      {/* Scoped styling for the inline-markdown bubbles (no shared-CSS edits). */}
      <style>{`
        .socMd > div { margin: 0; }
        .socMd > div + div { margin-top: 4px; }
        .socMd .socMd__list { margin: 4px 0; padding-left: 18px; }
        .socMd .socMd__list li { margin: 2px 0; }
        .socMd code.socMono { white-space: pre-wrap; word-break: break-word; }
      `}</style>
      <SectionHeader
        icon="discuss"
        accent={COLORS.accent}
        title="Chat"
        description="Ask the SOC agent about your environment — it queries logs, summarizes, and explains."
        actions={
          <EuiButton
            size="s"
            iconType="refresh"
            onClick={newChat}
            isDisabled={isEmpty && !loading}
          >
            New chat
          </EuiButton>
        }
      />

      {/* Transcript */}
      <div
        ref={scrollRef}
        className="socChat"
        style={{ flex: 1, overflowY: 'auto', paddingRight: 8, paddingBottom: 8 }}
        role="log"
        aria-live="polite"
        aria-label="Chat transcript"
      >
        {isEmpty ? (
          <EuiPanel
            hasBorder
            paddingSize="l"
            color="transparent"
            style={{ alignSelf: 'center', maxWidth: 620, marginTop: 24, textAlign: 'center' }}
          >
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 56,
                height: 56,
                borderRadius: 14,
                background: tint(COLORS.accent, 0.14),
                color: COLORS.accent,
              }}
            >
              <EuiIcon type="discuss" size="xl" />
            </span>
            <EuiSpacer size="m" />
            <EuiText>
              <h3>Ask the SOC agent anything</h3>
              <p style={{ color: COLORS.subdued }}>
                Investigate an IP, summarize today&apos;s findings, or hunt for suspicious
                activity. Try one of these to get started:
              </p>
            </EuiText>
            <EuiSpacer size="m" />
            <EuiFlexGroup gutterSize="s" wrap justifyContent="center" responsive={false}>
              {SUGGESTED_PROMPTS.map((p) => (
                <EuiFlexItem grow={false} key={p}>
                  <EuiBadge
                    color="hollow"
                    iconType="search"
                    onClick={() => usePrompt(p)}
                    onClickAriaLabel={`Use prompt: ${p}`}
                    style={{ cursor: 'pointer' }}
                  >
                    {p}
                  </EuiBadge>
                </EuiFlexItem>
              ))}
            </EuiFlexGroup>
          </EuiPanel>
        ) : (
          <>
            {transcript.map((item) => (
              <Bubble key={item.id} item={item} />
            ))}
            {loading ? <TypingIndicator /> : null}
          </>
        )}
      </div>

      <EuiHorizontalRule margin="s" />

      {/* Persistent suggested-prompt chips — a thin row above the composer that
          stays visible mid-conversation. Clicking sends the prompt directly. */}
      {!isEmpty ? (
        <EuiFlexGroup
          gutterSize="xs"
          wrap
          responsive={false}
          alignItems="center"
          style={{ marginBottom: 8 }}
        >
          <EuiFlexItem grow={false}>
            <EuiText size="xs" color="subdued">
              <span>Try</span>
            </EuiText>
          </EuiFlexItem>
          {SUGGESTED_PROMPTS.map((p) => (
            <EuiFlexItem grow={false} key={p}>
              <EuiBadge
                color="hollow"
                iconType="search"
                onClick={() => void send(p)}
                onClickAriaLabel={`Send prompt: ${p}`}
                isDisabled={loading}
                style={{ cursor: loading ? 'default' : 'pointer' }}
              >
                {p}
              </EuiBadge>
            </EuiFlexItem>
          ))}
        </EuiFlexGroup>
      ) : null}

      {/* Composer */}
      <EuiFlexGroup gutterSize="s" alignItems="flexEnd" responsive={false}>
        <EuiFlexItem>
          <EuiTextArea
            inputRef={(el) => {
              inputRef.current = el;
            }}
            placeholder="Ask a question…  (Enter to send · Shift+Enter for a new line)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={loading}
            fullWidth
            rows={2}
            resize="none"
            aria-label="Chat message"
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
      {!isEmpty ? (
        <EuiText size="xs" color="subdued" style={{ marginTop: 6 }}>
          <EuiButtonEmpty
            size="xs"
            iconType="cross"
            color="text"
            onClick={newChat}
            isDisabled={loading}
            flush="left"
          >
            Clear conversation
          </EuiButtonEmpty>
        </EuiText>
      ) : null}
    </div>
  );
};
