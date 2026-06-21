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
import type { ChatResponse, ChatTable, ChatTurn } from '../../lib/types';
import { api, ApiError } from '../../lib/api';
import { SectionHeader } from '../common/ui';
import { COLORS, tint } from '../../lib/theme';
import { fmtMoney } from '../../lib/format';

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

/** A single assistant or user bubble, with its trailing metadata/table. */
const Bubble: React.FC<{ item: TranscriptItem }> = ({ item }) => {
  if (item.role === 'user') {
    return <div className="socBubble socBubble--user">{item.content}</div>;
  }

  if (item.isError) {
    return (
      <div style={{ alignSelf: 'flex-start', maxWidth: 760, width: '100%' }}>
        <EuiCallOut size="s" color="danger" iconType="alert" title="The agent could not answer">
          <p style={{ margin: 0 }}>{item.content}</p>
        </EuiCallOut>
      </div>
    );
  }

  return (
    <div style={{ alignSelf: 'flex-start', display: 'flex', flexDirection: 'column' }}>
      <div className="socBubble socBubble--assistant">{item.content}</div>
      {item.resp?.table ? <ResultTable table={item.resp.table} /> : null}
      {item.resp ? <AnswerMeta resp={item.resp} /> : null}
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
        { id: nextId(), role: 'user', content: message },
      ]);
      setHistory(sentHistory);
      setInput('');
      setLoading(true);

      try {
        const resp = await api.chat(message, sentHistory);
        const answer = resp.answer || '(no answer returned)';
        setTranscript((prev) => [
          ...prev,
          { id: nextId(), role: 'assistant', content: answer, resp },
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
          { id: nextId(), role: 'assistant', content: msg, isError: true },
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

  const usePrompt = (prompt: string) => {
    setInput(prompt);
    inputRef.current?.focus();
  };

  const isEmpty = transcript.length === 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 160px)' }}>
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
