/**
 * ChatPanel — the reusable conversational-triage engine (new SOC console).
 *
 * Single source of truth for the chat experience: it owns its own transcript,
 * composer input, send flow, running `history`, in-flight "thinking" indicator,
 * model selection and source-scope selection. Both the standalone Chat *page* and
 * (in future) the case flyout embed it:
 *
 *   <ChatPanel starters={[...]} />                 // full-page surface
 *   <ChatPanel caseId={id} compact />              // embedded (flyout) surface
 *
 * When `caseId` is set it is threaded into every `api.chat(...)` call so the agent
 * has case context, and a "Scoped to case <id>" chip is shown at the top.
 *
 * Layout: a full-height flex column. The transcript lane is the ONLY scrolling
 * region; the composer is pinned at the bottom; the empty state is centred inside
 * the lane so it never pushes the composer down.
 *
 * SECURITY (UNTRUSTED rendering): assistant answers, queries, table cells, memory
 * text, reasoning, knowledge snippets and tool output are all model- or log-derived
 * and therefore UNTRUSTED. They are rendered EXCLUSIVELY as React text nodes (light
 * inline markdown is parsed into React elements — bold / `code` / bullets — never
 * via dangerouslySetInnerHTML). There is no HTML-injection path anywhere here.
 */
import * as React from 'react';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Bot,
  Check,
  Copy,
  Cpu,
  Database,
  ExternalLink,
  Gauge,
  Link2,
  MessageSquare,
  RefreshCw,
  Search,
  Send,
  ShieldAlert,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Wand2,
  X,
} from 'lucide-react';
import type {
  ChatMemoryAction,
  ChatMemorySuggestion,
  ChatResponse,
  ChatTable,
  ChatTurn,
  ModelsResponse,
  SourceInstance,
} from '@/lib/types';
import { api, ApiError } from '@/lib/api';
import { fmtMoney } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Button } from '@/ui/button';
import { Textarea } from '@/ui/textarea';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/ui/tooltip';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/ui/accordion';
import { CodeBlock, InlineCode } from './CodeBlock';

/* ------------------------------------------------------------------ types -- */

/** A rendered transcript entry. Assistant turns may carry the full response so we
 *  can render the table / query / cost / memory / provenance surfaces beneath the
 *  bubble. Error turns render as a non-fatal alert instead of prose. */
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
  /** Embedded mode (e.g. the case flyout): denser, no big chrome, fixed-height scroll. */
  compact?: boolean;
  /** Composer placeholder. */
  placeholder?: string;
  /** Suggested prompts for the empty state (clickable; submit immediately). */
  starters?: string[];
  className?: string;
}

/** Imperative handle so a host page can reset the conversation ("New chat"). */
export interface ChatPanelHandle {
  reset: () => void;
}

/** The composer source-scope sentinel: query the configured (primary) source. */
const ALL_SOURCES = '__all__';
/** The model sentinel: use the backend-configured default chat model. */
const DEFAULT_MODEL = '__default__';
/** Cap the rows we render from a single chat result table. */
const MAX_TABLE_ROWS = 50;

/* ------------------------------------------------ inline markdown (React) -- */

/**
 * Parse a SINGLE line of text into React nodes with light inline markdown:
 * `code` spans first (so their contents are not further formatted), then **bold**.
 * EVERYTHING is a React text node or one of our own known elements — there is no
 * HTML string anywhere, so UNTRUSTED content can never inject live markup.
 */
function renderInline(text: string, keyBase: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Split on `code` spans first; odd indices are code contents.
  const codeParts = text.split(/`([^`]+)`/g);
  codeParts.forEach((part, i) => {
    if (i % 2 === 1) {
      nodes.push(
        <code
          key={`${keyBase}-c${i}`}
          className="rounded border border-border bg-muted px-1 py-0.5 font-mono text-[0.8em] text-foreground"
        >
          {part}
        </code>,
      );
      return;
    }
    // **bold** within the non-code segments.
    const boldParts = part.split(/\*\*([^*]+)\*\*/g);
    boldParts.forEach((bp, j) => {
      if (!bp) return;
      if (j % 2 === 1) {
        nodes.push(
          <strong key={`${keyBase}-b${i}-${j}`} className="font-semibold text-foreground">
            {bp}
          </strong>,
        );
      } else {
        nodes.push(<React.Fragment key={`${keyBase}-t${i}-${j}`}>{bp}</React.Fragment>);
      }
    });
  });
  return nodes;
}

/**
 * Render an assistant answer as React nodes supporting **bold**, `code`, bullet
 * lines (`- ` / `* `) and paragraph breaks. Dependency-free; no HTML injection.
 */
const Markdown: React.FC<{ text: string }> = ({ text }) => {
  const blocks: React.ReactNode[] = [];
  const lines = text.split('\n');
  let listBuf: string[] = [];

  const flushList = (key: string) => {
    if (!listBuf.length) return;
    const items = listBuf;
    listBuf = [];
    blocks.push(
      <ul key={key} className="my-1 list-disc space-y-0.5 pl-5">
        {items.map((li, i) => (
          <li key={i}>{renderInline(li, `${key}-${i}`)}</li>
        ))}
      </ul>,
    );
  };

  lines.forEach((line, idx) => {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      listBuf.push(bullet[1]);
      return;
    }
    flushList(`ul-${idx}`);
    if (line.trim() === '') {
      blocks.push(<div key={`sp-${idx}`} className="h-2" aria-hidden />);
    } else {
      blocks.push(<p key={`p-${idx}`} className="leading-relaxed">{renderInline(line, `p-${idx}`)}</p>);
    }
  });
  flushList('ul-end');

  return <div className="space-y-0.5 text-sm">{blocks}</div>;
};

/* --------------------------------------------------------------- helpers --- */

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

/** A friendly label for a configured source (display name, else type · id). */
function sourceLabel(s: SourceInstance): string {
  const name = (s.display_name || '').trim();
  if (name) return name;
  const type = (s.source_type || '').trim();
  return type ? `${type} · ${s.id}` : s.id;
}

/**
 * Pull a usable http(s) deep-link out of the backend's `discover` payload. Anything
 * that is not a plain http(s) URL (or a leading-slash same-origin path) is rejected
 * so we never render a `javascript:` / `data:` link from a model-derived value.
 */
function discoverHref(discover: ChatResponse['discover']): string | null {
  if (!discover || typeof discover !== 'object') return null;
  const d = discover as Record<string, unknown>;
  const candidate =
    (typeof d.url === 'string' && d.url) ||
    (typeof d.href === 'string' && d.href) ||
    (typeof d.path === 'string' && d.path) ||
    '';
  const s = candidate.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('/')) return s; // same-origin path
  return null;
}

/* --------------------------------------------------------------- subviews -- */

/**
 * Render a chat result table (columns + row arrays). Empty columns (all-blank) are
 * hidden; rows capped at MAX_TABLE_ROWS; wrapped in a horizontally-scrollable box.
 * Column names + cell values are UNTRUSTED → rendered as plain text nodes only.
 */
const ResultTable: React.FC<{ table: ChatTable }> = ({ table }) => {
  const visibleCols = useMemo(() => {
    const out: number[] = [];
    table.columns.forEach((_name, ci) => {
      if (table.rows.some((row) => !isBlankCell(row[ci]))) out.push(ci);
    });
    return out;
  }, [table]);

  const cappedRows = useMemo(() => table.rows.slice(0, MAX_TABLE_ROWS), [table.rows]);
  const hiddenRowCount = Math.max(0, table.rows.length - cappedRows.length);

  if (!table.columns.length || !table.rows.length) return null;

  if (!visibleCols.length) {
    return (
      <div className="mt-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        {table.rows.length} {table.rows.length === 1 ? 'row' : 'rows'} returned, but no field values
        to display.
      </div>
    );
  }

  return (
    <div className="mt-2 max-w-full overflow-hidden rounded-md border border-border bg-card">
      <div className="max-w-full overflow-x-auto">
        <table className="w-full min-w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-border bg-muted/40">
              {visibleCols.map((ci) => (
                <th
                  key={ci}
                  className="whitespace-nowrap px-3 py-2 text-left font-semibold text-muted-foreground"
                >
                  {/* column name is source/agent-derived → plain text node. */}
                  {table.columns[ci]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cappedRows.map((row, ri) => (
              <tr key={ri} className="border-b border-border/60 last:border-0">
                {visibleCols.map((ci) => (
                  <td key={ci} className="whitespace-nowrap px-3 py-1.5 font-mono text-foreground">
                    {/* cell value is UNTRUSTED → plain text node. */}
                    {isBlankCell(row[ci]) ? '—' : String(row[ci])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hiddenRowCount > 0 || table.truncated ? (
        <div className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
          {hiddenRowCount > 0
            ? `Showing first ${cappedRows.length} of ${table.rows.length} rows · +${hiddenRowCount} more`
            : 'Results truncated.'}
        </div>
      ) : null}
    </div>
  );
};

/** A tiny copy-to-clipboard icon button (best-effort; silent on denial). */
const CopyButton: React.FC<{ text: string; label: string }> = ({ text, label }) => {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const onCopy = () => {
    const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (!clip?.writeText) return;
    clip
      .writeText(text)
      .then(() => {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => { /* clipboard denied — no-op */ });
  };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onCopy} aria-label={label}>
          {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{copied ? 'Copied' : label}</TooltipContent>
    </Tooltip>
  );
};

/** The "query used" chip + per-message cost/model footnote shown under an answer. */
const AnswerMeta: React.FC<{ resp: ChatResponse; model?: string }> = ({ resp, model }) => {
  const hasQuery = typeof resp.query === 'string' && resp.query.trim().length > 0;
  const hasCost = typeof resp.cost === 'number' && resp.cost > 0;
  const hasModel = typeof model === 'string' && model.trim().length > 0;
  if (!hasQuery && !hasCost && !hasModel) return null;
  return (
    <div className="mt-2 space-y-1">
      {hasQuery ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Query used</span>
          {/* query is UNTRUSTED → InlineCode (plain text node). */}
          <InlineCode className="max-w-full">{resp.query as string}</InlineCode>
          <CopyButton text={(resp.query as string) ?? ''} label="Copy query" />
        </div>
      ) : null}
      {hasCost || hasModel ? (
        <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
          {hasCost ? (
            <span className="inline-flex items-center gap-1">
              <Gauge className="h-3.5 w-3.5" aria-hidden />
              {fmtMoney(resp.cost)} this message
            </span>
          ) : null}
          {hasModel ? (
            <span className="inline-flex items-center gap-1">
              <Cpu className="h-3.5 w-3.5" aria-hidden />
              {/* model id is operator-configured → mono plain text. */}
              <span className="font-mono">{model}</span>
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

/**
 * "How the agent got this" — a collapsed provenance disclosure rendered only when
 * the response carries any of tools / knowledge / reasoning / citations. EVERY value
 * is UNTRUSTED (model- or log-derived) and rendered as plain text / CodeBlock.
 */
const Provenance: React.FC<{ resp: ChatResponse; turnId: number }> = ({ resp, turnId }) => {
  const tools = Array.isArray(resp.tools) ? resp.tools : [];
  const knowledge = Array.isArray(resp.knowledge) ? resp.knowledge : [];
  const citations = Array.isArray(resp.citations) ? resp.citations : [];
  const reasoning = typeof resp.reasoning === 'string' ? resp.reasoning.trim() : '';
  const hasAny = tools.length > 0 || knowledge.length > 0 || citations.length > 0 || !!reasoning;
  if (!hasAny) return null;

  return (
    <div className="mt-2">
      <Accordion type="single" collapsible>
        <AccordionItem value={`prov-${turnId}`} className="border-b-0">
          <AccordionTrigger className="py-2 text-xs font-medium text-muted-foreground hover:no-underline">
            <span className="inline-flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5" aria-hidden />
              How the agent got this
            </span>
          </AccordionTrigger>
          <AccordionContent className="space-y-3 pb-2">
            {tools.length ? (
              <div className="space-y-2">
                <div className="text-xs font-semibold text-muted-foreground">Tools run</div>
                {tools.map((t, i) => (
                  <div key={i} className="space-y-1">
                    <div className="text-xs text-foreground">
                      {/* tool name is engine-derived → plain text. */}
                      <span className="font-semibold">{String(t.tool ?? 'tool')}</span>
                      {t.summary ? (
                        <span className="text-muted-foreground">{` — ${t.summary}`}</span>
                      ) : null}
                    </div>
                    {t.query ? <CodeBlock value={t.query} caption="query" wrap /> : null}
                  </div>
                ))}
              </div>
            ) : null}

            {knowledge.length ? (
              <div className="space-y-2">
                <div className="text-xs font-semibold text-muted-foreground">Knowledge consulted</div>
                {knowledge.map((k, i) => (
                  <div key={i} className="space-y-1">
                    {/* source label is corpus-derived → mono plain text. */}
                    <div className="font-mono text-xs text-muted-foreground">{String(k.source ?? '')}</div>
                    {k.snippet ? <CodeBlock value={k.snippet} copyable={false} wrap /> : null}
                  </div>
                ))}
              </div>
            ) : null}

            {citations.length ? (
              <div className="space-y-1">
                <div className="text-xs font-semibold text-muted-foreground">Citations</div>
                {citations.map((c, i) => (
                  <div key={i} className="text-xs text-foreground">
                    <span className="font-semibold">{`[${c.n}] `}</span>
                    {/* citation source/snippet UNTRUSTED → plain text. */}
                    <span className="font-mono">{String(c.source ?? '')}</span>
                    {c.snippet ? (
                      <span className="text-muted-foreground">{` — ${c.snippet}`}</span>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}

            {reasoning ? (
              <div className="space-y-1">
                <div className="text-xs font-semibold text-muted-foreground">Reasoning</div>
                {/* reasoning excerpt model-derived → CodeBlock (plain text). */}
                <CodeBlock value={reasoning} copyable={false} wrap />
              </div>
            ) : null}
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
};

/**
 * Per-message action row under an assistant answer: Copy (raw answer), Regenerate,
 * an open-in-Discover deep-link (when safe), and local 👍/👎 feedback (component
 * state only — no backend call this round).
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
    <div className="socMsgActions mt-2 flex flex-wrap items-center gap-1">
      <CopyButton text={answer} label="Copy answer" />
      {canRegenerate ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={onRegenerate}
              aria-label="Regenerate answer"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Regenerate this answer</TooltipContent>
        </Tooltip>
      ) : null}
      {href ? (
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" asChild>
          <a href={href} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="h-3.5 w-3.5" />
            Open in Discover
          </a>
        </Button>
      ) : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={cn('h-7 w-7', feedback === 'up' && 'text-success')}
            aria-label="Mark answer helpful"
            aria-pressed={feedback === 'up'}
            onClick={() => setFeedback((f) => (f === 'up' ? null : 'up'))}
          >
            <ThumbsUp className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Helpful</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={cn('h-7 w-7', feedback === 'down' && 'text-critical')}
            aria-label="Mark answer not helpful"
            aria-pressed={feedback === 'down'}
            onClick={() => setFeedback((f) => (f === 'down' ? null : 'down'))}
          >
            <ThumbsDown className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Not helpful</TooltipContent>
      </Tooltip>
      {feedback ? <span className="text-xs text-muted-foreground">Thanks for the feedback</span> : null}
    </div>
  );
};

/* --------------------------------------------------------------- memory ---- */

/** Echo of a memory mutation the chat engine ALREADY performed this turn. */
const MemoryActionEcho: React.FC<{ action: ChatMemoryAction }> = ({ action }) => {
  const op = (action.op || '').toLowerCase();
  const isDelete = op === 'delete';
  const hasText = typeof action.text === 'string' && action.text.trim().length > 0;
  if (!isDelete && !hasText) return null;
  const label = isDelete ? 'Forgot this fact' : op === 'update' ? 'Memory updated' : 'Remembered';
  return (
    <div className="mt-2 rounded-md border border-success/40 bg-success/5 px-3 py-2">
      <div className="flex items-start gap-2 text-xs">
        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
        <div>
          <span className="font-semibold text-success">{label}</span>
          {/* memory text is UNTRUSTED → plain text node. */}
          {hasText ? <span className="text-muted-foreground">{`: ${action.text}`}</span> : null}
        </div>
      </div>
    </div>
  );
};

/** An inline, dismissible prompt offering to save a memory the engine PROPOSED. */
const MemorySuggestionPrompt: React.FC<{ suggestion: ChatMemorySuggestion }> = ({ suggestion }) => {
  const [state, setState] = useState<'pending' | 'saving' | 'saved' | 'dismissed' | 'error'>(
    'pending',
  );
  const [error, setError] = useState<string | null>(null);

  const text = (suggestion.text || '').trim();
  if (!text || state === 'dismissed') return null;

  const remember = async () => {
    if (state === 'saving' || state === 'saved') return;
    setState('saving');
    setError(null);
    try {
      await api.addMemory({ text });
      setState('saved');
    } catch (e) {
      const msg =
        e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Could not save to memory.';
      setError(msg);
      setState('error');
    }
  };

  const saving = state === 'saving';
  const saved = state === 'saved';

  return (
    <div className="mt-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-2">
      <div className="flex items-start gap-2">
        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-xs text-muted-foreground">Save this to memory?</div>
          {/* suggested text is UNTRUSTED → plain text node. */}
          <div className="mt-0.5 text-sm text-foreground">{text}</div>
          {suggestion.reason && suggestion.reason.trim() ? (
            <div className="mt-0.5 text-xs text-muted-foreground">{suggestion.reason}</div>
          ) : null}
          <div className="mt-2">
            {saved ? (
              <div className="inline-flex items-center gap-1 text-xs text-success">
                <Check className="h-3.5 w-3.5" aria-hidden />
                Saved to memory
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => void remember()} disabled={saving}>
                  {saving ? 'Saving…' : 'Remember this'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setState('dismissed')}
                  disabled={saving}
                >
                  <X className="h-3.5 w-3.5" />
                  Dismiss
                </Button>
              </div>
            )}
            {state === 'error' && error ? (
              <div className="mt-1 text-xs text-critical">{error}</div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
};

/* --------------------------------------------------------------- bubbles --- */

const MetaLine: React.FC<{ who: string; at: number; align: 'start' | 'end' }> = ({ who, at, align }) => (
  <div
    className={cn(
      'mt-1 text-xs text-muted-foreground',
      align === 'end' ? 'self-end' : 'self-start',
    )}
  >
    <span className="font-semibold">{who}</span>
    <span className="opacity-70">{` · ${clockTime(at)}`}</span>
  </div>
);

const AgentAvatar: React.FC = () => (
  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-primary/10 text-primary">
    <Bot className="h-4 w-4" aria-hidden />
  </span>
);

const Bubble: React.FC<{
  item: TranscriptItem;
  grouped?: boolean;
  showMeta?: boolean;
  canRegenerate?: boolean;
  onRegenerate?: () => void;
}> = ({ item, grouped = false, showMeta = true, canRegenerate = false, onRegenerate }) => {
  if (item.role === 'user') {
    return (
      <div className={cn('flex justify-end', grouped && '-mt-1.5')}>
        <div className="flex max-w-[min(80%,720px)] flex-col">
          {/* user content is UNTRUSTED → plain text node (whitespace preserved). */}
          <div className="whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-primary px-4 py-2.5 text-sm text-primary-foreground">
            {item.content}
          </div>
          {showMeta ? <MetaLine who="You" at={item.at} align="end" /> : null}
        </div>
      </div>
    );
  }

  // Assistant (answer or error).
  return (
    <div className={cn('flex items-start gap-2.5', grouped && '-mt-1.5')}>
      <div className="shrink-0" aria-hidden>
        {grouped ? <span className="block w-8" /> : <AgentAvatar />}
      </div>
      <div className="flex min-w-0 flex-1 flex-col" style={{ maxWidth: 'min(92%, 820px)' }}>
        {item.isError ? (
          <Alert variant="destructive">
            <ShieldAlert className="h-4 w-4" aria-hidden />
            <AlertTitle>The agent could not answer</AlertTitle>
            {/* error message from our own API layer — safe text. */}
            <AlertDescription>{item.content}</AlertDescription>
          </Alert>
        ) : (
          <div className="rounded-2xl rounded-tl-sm border border-border bg-card px-4 py-2.5 text-foreground">
            <Markdown text={item.content} />
          </div>
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
  <div className="flex items-start gap-2.5" aria-label="Agent is responding">
    <AgentAvatar />
    <div className="flex items-center gap-1.5 rounded-2xl rounded-tl-sm border border-border bg-card px-4 py-3">
      <span className="socTypingDot h-1.5 w-1.5 rounded-full bg-primary" />
      <span className="socTypingDot h-1.5 w-1.5 rounded-full bg-primary" />
      <span className="socTypingDot h-1.5 w-1.5 rounded-full bg-primary" />
    </div>
  </div>
);

/* ----------------------------------------------------------- empty state --- */

function starterIcon(prompt: string): React.ReactNode {
  const p = prompt.toLowerCase();
  if (/\bsummar|today|digest|overview\b/.test(p)) return <Sparkles className="h-4 w-4" />;
  if (/\bbrute|attack|suspicious|malic|threat|exploit\b/.test(p)) return <ShieldAlert className="h-4 w-4" />;
  if (/\bhost|ip|asset|which |most |top \b/.test(p)) return <Wand2 className="h-4 w-4" />;
  return <Search className="h-4 w-4" />;
}

const EmptyState: React.FC<{
  compact: boolean;
  scoped: boolean;
  starters: string[];
  loading: boolean;
  onPick: (p: string) => void;
}> = ({ compact, scoped, starters, loading, onPick }) => (
  <div className="mx-auto flex max-w-2xl flex-col items-center justify-center px-4 py-6 text-center">
    <span
      className={cn(
        'flex items-center justify-center rounded-2xl bg-primary/10 text-primary',
        compact ? 'h-12 w-12' : 'h-16 w-16',
      )}
    >
      <MessageSquare className={compact ? 'h-6 w-6' : 'h-8 w-8'} aria-hidden />
    </span>
    <h3 className="mt-4 text-lg font-semibold text-foreground">
      {scoped ? 'Ask about this case' : 'Ask the SOC agent anything'}
    </h3>
    {!compact ? (
      <p className="mt-1.5 max-w-md text-sm text-muted-foreground">
        {scoped
          ? 'Dig into the evidence, pull related activity, or ask why the agent reached its verdict.'
          : "Investigate an IP, summarize today's findings, or hunt for suspicious activity. Try one of these to get started:"}
      </p>
    ) : null}
    {starters.length ? (
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        {starters.map((p) => (
          <Button
            key={p}
            variant="outline"
            size="sm"
            className="max-w-full"
            onClick={() => onPick(p)}
            disabled={loading}
          >
            {starterIcon(p)}
            <span className="truncate">{p}</span>
          </Button>
        ))}
      </div>
    ) : null}
  </div>
);

/* --------------------------------------------------------------- panel ----- */

export const ChatPanel = forwardRef<ChatPanelHandle, ChatPanelProps>(function ChatPanel(
  { caseId, compact = false, placeholder, starters = [], className },
  ref,
) {
  const [input, setInput] = useState('');
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [loading, setLoading] = useState(false);

  // Model selection (optional per-turn override). DEFAULT_MODEL = backend default.
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [model, setModel] = useState<string>(DEFAULT_MODEL);

  // Source scope. ALL_SOURCES = the configured/primary source (no source_id sent).
  const [sources, setSources] = useState<SourceInstance[]>([]);
  const [sourceId, setSourceId] = useState<string>(ALL_SOURCES);

  const idRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const nextId = () => {
    idRef.current += 1;
    return idRef.current;
  };

  // Fetch models + configured sources once (best-effort; pickers stay at defaults).
  useEffect(() => {
    let cancelled = false;
    void api
      .getModels()
      .then((res) => { if (!cancelled) setModels(res); })
      .catch(() => { /* non-fatal */ });
    void api
      .listSources()
      .then((res) => { if (!cancelled) setSources(res.sources || []); })
      .catch(() => { /* non-fatal */ });
    return () => { cancelled = true; };
  }, []);

  // Keep the transcript pinned to the latest message (honours reduced-motion).
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
      if (!message || loading) return;

      const userTurn: ChatTurn = { role: 'user', content: message };
      const sentHistory = [...history, userTurn];
      const usedModel = model !== DEFAULT_MODEL ? model.trim() || undefined : undefined;
      const usedSource = sourceId !== ALL_SOURCES ? sourceId.trim() || undefined : undefined;

      setTranscript((prev) => [
        ...prev,
        { id: nextId(), role: 'user', content: message, at: Date.now() },
      ]);
      setHistory(sentHistory);
      setInput('');
      setLoading(true);

      try {
        const resp = await api.chat(message, sentHistory, caseId, usedModel, usedSource);
        const answer = resp.answer || '(no answer returned)';
        setTranscript((prev) => [
          ...prev,
          { id: nextId(), role: 'assistant', content: answer, resp, at: Date.now(), model: usedModel },
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
        // Do NOT push the error into `history` (don't condition the model on failure).
      } finally {
        setLoading(false);
        inputRef.current?.focus();
      }
    },
    [input, history, loading, caseId, model, sourceId],
  );

  // Regenerate: re-send the user turn that immediately preceded a given assistant turn.
  const regenerate = useCallback(
    (assistantId: number) => {
      if (loading) return;
      setTranscript((prev) => {
        const idx = prev.findIndex((t) => t.id === assistantId);
        for (let i = idx - 1; i >= 0; i -= 1) {
          if (prev[i].role === 'user') {
            const content = prev[i].content;
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

  const modelOptions = useMemo(() => {
    const out: Array<{ value: string; label: string }> = [];
    if (models) {
      for (const [provider, list] of Object.entries(models.providers || {})) {
        for (const m of list || []) out.push({ value: m, label: `${m}  ·  ${provider}` });
      }
    }
    return out;
  }, [models]);
  const hasModels = modelOptions.length > 0;
  const hasSources = sources.length > 0;

  const isEmpty = transcript.length === 0;
  const composerPlaceholder =
    placeholder ?? 'Ask a question…  (Enter to send · Shift+Enter for a new line)';

  return (
    <TooltipProvider delayDuration={200}>
      <div className={cn('flex h-full min-h-0 flex-col', className)}>
        <style>{`
          @keyframes socTypingPulse {
            0%, 80%, 100% { opacity: 0.35; transform: translateY(0); }
            40% { opacity: 1; transform: translateY(-2px); }
          }
          .socTypingDot { opacity: 0.5; animation: socTypingPulse 1.1s ease-in-out infinite; }
          .socTypingDot:nth-child(2) { animation-delay: 0.18s; }
          .socTypingDot:nth-child(3) { animation-delay: 0.36s; }
          .socMsgActions { opacity: 0.7; transition: opacity 0.15s ease; }
          .socMsgActions:hover, .socMsgActions:focus-within { opacity: 1; }
          @media (prefers-reduced-motion: reduce) {
            .socTypingDot { animation: none; opacity: 0.6; }
            .socMsgActions { transition: none; }
          }
        `}</style>

        {/* Scope chip — only when scoped to a case. */}
        {caseId ? (
          <div className={cn('shrink-0 text-xs text-muted-foreground', compact ? 'mb-1.5' : 'mb-2.5')}>
            <span className="inline-flex items-center gap-1">
              <Link2 className="h-3.5 w-3.5" aria-hidden />
              Scoped to case <InlineCode>{caseId}</InlineCode>
            </span>
          </div>
        ) : null}

        {/* Transcript lane — the ONLY scrolling region. */}
        <div
          ref={scrollRef}
          className={cn(
            'flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden',
            compact ? 'gap-2.5 px-1 py-1' : 'gap-3.5 px-1 py-2',
            isEmpty && 'justify-center',
          )}
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
        <div
          className={cn(
            'shrink-0 rounded-xl border border-border bg-card shadow-elev1',
            compact ? 'mt-2 p-2.5' : 'mt-3 p-3',
          )}
        >
          <div className="flex items-end gap-2">
            <Textarea
              ref={inputRef}
              placeholder={composerPlaceholder}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={loading}
              rows={compact ? 2 : 3}
              aria-label="Chat message"
              className="min-h-0 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onClick={() => void send()}
                  disabled={(!input.trim() && !loading) || loading}
                  aria-label="Send message"
                >
                  <Send className="h-4 w-4" />
                  Send
                </Button>
              </TooltipTrigger>
              <TooltipContent>{loading ? 'Waiting for the agent…' : 'Send (Enter)'}</TooltipContent>
            </Tooltip>
          </div>

          <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              Enter to send · Shift+Enter for a new line
            </span>
            <div className="flex flex-wrap items-center gap-2">
              {hasSources ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div>
                      <Select value={sourceId} onValueChange={setSourceId}>
                        <SelectTrigger
                          className="h-8 gap-1.5 text-xs"
                          aria-label="Source"
                          style={{ minWidth: compact ? 150 : 190 }}
                        >
                          <Database className="h-3.5 w-3.5 shrink-0 opacity-70" />
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={ALL_SOURCES}>All sources</SelectItem>
                          {sources.map((s) => (
                            <SelectItem key={s.id} value={s.id}>
                              {/* source label is operator-configured → plain text. */}
                              {sourceLabel(s)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>Which source the agent queries</TooltipContent>
                </Tooltip>
              ) : null}
              {hasModels ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div>
                      <Select value={model} onValueChange={setModel}>
                        <SelectTrigger
                          className="h-8 gap-1.5 text-xs"
                          aria-label="Model"
                          style={{ minWidth: compact ? 150 : 200 }}
                        >
                          <Cpu className="h-3.5 w-3.5 shrink-0 opacity-70" />
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={DEFAULT_MODEL}>Default model</SelectItem>
                          {modelOptions.map((o) => (
                            <SelectItem key={o.value} value={o.value}>
                              {/* model id is operator-configured → plain text. */}
                              {o.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>Model for this conversation</TooltipContent>
                </Tooltip>
              ) : null}
            </div>
          </div>

          {hasSources && sourceId === ALL_SOURCES ? (
            <div className="mt-1.5 text-xs text-muted-foreground">
              “All sources” currently queries the primary source.
            </div>
          ) : null}
        </div>
      </div>
    </TooltipProvider>
  );
});
