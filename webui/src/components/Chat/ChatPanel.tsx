/**
 * ChatPanel — the reusable conversational-triage engine.
 *
 * This is the single source of truth for the chat experience: it owns its own
 * message list, composer input, send flow, running `history`, in-flight "thinking"
 * indicator, and model-selection state. The standalone Chat *page* and the case
 * flyout both embed it:
 *
 *   <ChatPanel starters={[...]} />                 // full page surface
 *   <ChatPanel caseId={id} compact />              // embedded (flyout) surface
 *
 * When `caseId` is set it is threaded into every `api.chat(...)` call so the agent
 * has case context, and a "Scoped to case <id>" chip is shown in the header.
 *
 * Security: assistant answers are rendered through an HTML-escaping `renderMarkdown`
 * (escape FIRST, then inject only our own known-safe tags). All other model- or
 * log-derived text (memory text/reason, query) is rendered as plain text nodes.
 * There is no `dangerouslySetInnerHTML` on any untrusted text other than that one
 * pre-escaped markdown path. See `renderMarkdown` below.
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
  EuiBasicTable,
  EuiButton,
  EuiButtonEmpty,
  EuiButtonIcon,
  EuiCallOut,
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
          value === null || value === undefined || value === '' ? '—' : String(value),
      })),
    [table.columns],
  );

  if (!table.columns.length || !table.rows.length) {
    return null;
  }

  return (
    <EuiPanel hasBorder paddingSize="s" style={{ marginTop: 8 }}>
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
    style={{ alignSelf: align === 'end' ? 'flex-end' : 'flex-start', marginTop: 4 }}
  >
    <span style={{ fontWeight: 600 }}>{who}</span>
    <span style={{ opacity: 0.7 }}>{` · ${clockTime(at)}`}</span>
  </EuiText>
);

/** A single assistant or user message row, with avatar + trailing metadata/table. */
const Bubble: React.FC<{ item: TranscriptItem; maxWidth: number }> = ({ item, maxWidth }) => {
  if (item.role === 'user') {
    return (
      <div className="socMsgRow socMsgRow--user">
        <div style={{ display: 'flex', flexDirection: 'column', maxWidth, minWidth: 0 }}>
          <div className="socBubble socBubble--user">{item.content}</div>
          <MetaLine who="You" at={item.at} align="end" />
        </div>
      </div>
    );
  }

  // Assistant (answer or error) — left-aligned with an agent avatar.
  return (
    <div className="socMsgRow socMsgRow--assistant">
      <div className="socMsgRow__avatar" aria-hidden>
        <IconChip icon="discuss" accent={COLORS.accent} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', maxWidth, minWidth: 0, flex: 1 }}>
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
        {item.resp?.memory_action ? <MemoryActionEcho action={item.resp.memory_action} /> : null}
        {item.resp?.memory_suggestion ? (
          <MemorySuggestionPrompt suggestion={item.resp.memory_suggestion} />
        ) : null}
        <MetaLine who="SOC agent" at={item.at} align="start" />
      </div>
    </div>
  );
};

/** Animated "agent is thinking" indicator shown while a reply is in flight. */
const TypingIndicator: React.FC = () => (
  <div className="socMsgRow socMsgRow--assistant" aria-live="polite" aria-label="Agent is responding">
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

interface ModelOption {
  value: string;
  text: string;
}

/** Flatten provider→models into "<model> · <provider>" options. */
function buildModelOptions(models: ModelsResponse | null): ModelOption[] {
  if (!models) return [];
  const out: ModelOption[] = [];
  for (const [provider, list] of Object.entries(models.providers || {})) {
    for (const m of list || []) {
      out.push({ value: m, text: `${m}  ·  ${provider}` });
    }
  }
  return out;
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

  const idRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const nextId = () => {
    idRef.current += 1;
    return idRef.current;
  };

  // Fetch the available models once (best-effort; the picker simply stays empty —
  // i.e. "default model" — if the call fails or no providers are configured).
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
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep the transcript pinned to the latest message (auto-scroll within the lane).
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
      const usedModel = model.trim() || undefined;

      setTranscript((prev) => [
        ...prev,
        { id: nextId(), role: 'user', content: message, at: Date.now() },
      ]);
      setHistory(sentHistory);
      setInput('');
      setLoading(true);

      try {
        // caseId + model are only forwarded when set, so the no-case / no-model
        // path is byte-for-byte the original behaviour (see api.chat).
        const resp = await api.chat(message, sentHistory, caseId, usedModel);
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
      }
    },
    [input, history, loading, caseId, model],
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

  const isEmpty = transcript.length === 0;
  const bubbleMax = compact ? 9999 : 760;
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
        style={{ minWidth: compact ? 160 : 220 }}
      />
    </EuiToolTip>
  ) : null;

  return (
    <div className={`socChatPanel${compact ? ' socChatPanel--compact' : ''}`}>
      {/* Scoped styling — chat-only visuals (avatars, composer, typing dots) kept
          local to this component so no shared CSS is edited. Uses the runtime
          accent CSS vars (--soc-accent / --soc-accent-tint) so it is theme-safe. */}
      <style>{`
        .socChatPanel { display: flex; flex-direction: column; height: 100%; min-height: 0; }
        .socChatPanel .socMd > div { margin: 0; }
        .socChatPanel .socMd > div + div { margin-top: 4px; }
        .socChatPanel .socMd .socMd__list { margin: 4px 0; padding-left: 18px; }
        .socChatPanel .socMd .socMd__list li { margin: 2px 0; }
        .socChatPanel .socMd code.socMono { white-space: pre-wrap; word-break: break-word; }

        .socChatLane { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 10px 8px 4px; }
        .socChatLane--compact { padding: 2px 6px 6px 2px; }

        .socMsgRow { display: flex; gap: 10px; align-items: flex-start; }
        .socMsgRow--user { justify-content: flex-end; }
        .socMsgRow--assistant { justify-content: flex-start; }
        .socMsgRow__avatar { flex: 0 0 auto; margin-top: 2px; }
        .socMsgRow .socBubble { margin: 0; }

        .socChatPanel--compact .socBubble { padding: 8px 12px; border-radius: 12px; }

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

        .socStarter { animation: socStarterIn 0.25s ease both; }
        @keyframes socStarterIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

        @media (prefers-reduced-motion: reduce) {
          .socTyping__dot { animation: none; opacity: 0.6; }
          .socStarter { animation: none; }
        }
      `}</style>

      {/* Scope chip — only when scoped to a case. */}
      {caseId ? (
        <div style={{ marginBottom: compact ? 6 : 10 }}>
          <EuiText size="xs" color="subdued">
            <EuiIcon type="link" size="s" style={{ marginRight: 4 }} aria-hidden />
            <span>Scoped to case </span>
            <span className="socMono">{caseId}</span>
          </EuiText>
        </div>
      ) : null}

      {/* Transcript lane */}
      <div
        ref={scrollRef}
        className={`socChat socChatLane${compact ? ' socChatLane--compact' : ''}`}
        style={{ gap: compact ? 10 : 14 }}
        role="log"
        aria-live="polite"
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
            {transcript.map((item) => (
              <Bubble key={item.id} item={item} maxWidth={bubbleMax} />
            ))}
            {loading ? <TypingIndicator /> : null}
          </>
        )}
      </div>

      {/* Composer — sticky bottom card. */}
      <EuiPanel
        hasBorder
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
          {modelSelect ? <EuiFlexItem grow={false}>{modelSelect}</EuiFlexItem> : null}
        </EuiFlexGroup>
      </EuiPanel>
    </div>
  );
});

/* ----------------------------------------------------------- empty state --- */

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
      flex: 1,
      padding: compact ? '16px 8px' : '32px 16px',
      margin: 'auto',
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
                iconType="search"
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
