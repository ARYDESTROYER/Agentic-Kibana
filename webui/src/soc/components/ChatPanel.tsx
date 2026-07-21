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
 * Layout: a full-height flex column that FILLS its host (`h-full min-h-0`). The
 * transcript lane is the ONLY scrolling region (`flex-1 min-h-0 overflow-y-auto`);
 * the composer is pinned at the bottom of the frame (never floating mid-page); the
 * empty state is centred BOTH axes inside the lane so it never pushes the composer
 * down. In full-page mode the transcript content + composer share a readability
 * max-width (`max-w-3xl`, centred); the embedded `compact` case-flyout surface stays
 * full-bleed so it is not double-constrained.
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
  SlidersHorizontal,
  Sparkles,
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
import { copyText } from '@/lib/clipboard';
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
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { CodeBlock, InlineCode } from './CodeBlock';
import { Markdown } from './Markdown';

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

export type ChatPanelPresentation = 'default' | 'case-manager';

export interface ChatPanelProps {
  /** When set, scopes the conversation to a case (passed to api.chat). */
  caseId?: string;
  /** Embedded mode (e.g. the case flyout): denser, no big chrome, fixed-height scroll. */
  compact?: boolean;
  /** Composer placeholder. */
  placeholder?: string;
  /** Suggested prompts for the empty state (clickable; submit immediately). */
  starters?: string[];
  /** Additive visual treatment; all variants use this same transcript/send engine. */
  presentation?: ChatPanelPresentation;
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
      <div className="mt-3 rounded-md border border-border bg-surface px-3 py-2 text-xs text-muted-foreground">
        {table.rows.length} {table.rows.length === 1 ? 'row' : 'rows'} returned, but no field values
        to display.
      </div>
    );
  }

  return (
    <div className="mt-3 max-w-full overflow-hidden rounded-md border border-border bg-card">
      <div className="max-w-full overflow-x-auto">
        <table className="w-full min-w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-border bg-surface">
              {visibleCols.map((ci) => (
                <th
                  key={ci}
                  className="whitespace-nowrap px-3 py-2 text-left text-2xs font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  {/* column name is source/agent-derived → plain text node. */}
                  {table.columns[ci]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cappedRows.map((row, ri) => (
              <tr
                key={ri}
                className="border-b border-border/60 transition-colors last:border-0 hover:bg-surface/60"
              >
                {visibleCols.map((ci) => (
                  <td key={ci} className="whitespace-nowrap px-3 py-2 font-mono text-foreground">
                    {/* cell value is UNTRUSTED → plain text node. */}
                    {isBlankCell(row[ci]) ? <span className="text-muted-foreground">—</span> : String(row[ci])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hiddenRowCount > 0 || table.truncated ? (
        <div className="border-t border-border bg-surface px-3 py-1.5 text-xs text-muted-foreground">
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
    // Route through copyText() so copy ALSO works over plain HTTP (non-secure
    // context, where navigator.clipboard is undefined). Show "Copied" only on a
    // truthy result — never claim success for a copy that never happened (bug #4).
    void copyText(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    });
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
    <div className="mt-3 space-y-2">
      {hasQuery ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
            Query
          </span>
          {/* query is UNTRUSTED → InlineCode (plain text node). */}
          <InlineCode className="max-w-full">{resp.query as string}</InlineCode>
          <CopyButton text={(resp.query as string) ?? ''} label="Copy query" />
        </div>
      ) : null}
      {hasCost || hasModel ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {hasCost ? (
            <span className="inline-flex items-center gap-1.5">
              <Gauge className="h-3.5 w-3.5 opacity-70" aria-hidden />
              <span className="tabular-nums">{fmtMoney(resp.cost)}</span> this message
            </span>
          ) : null}
          {hasModel ? (
            <span className="inline-flex items-center gap-1.5">
              <Cpu className="h-3.5 w-3.5 opacity-70" aria-hidden />
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
          <AccordionContent className="space-y-4 pb-2">
            {tools.length ? (
              <div className="space-y-2">
                <div className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Tools run
                </div>
                {tools.map((t, i) => (
                  <div key={i} className="space-y-1.5">
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
                <div className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Knowledge consulted
                </div>
                {knowledge.map((k, i) => (
                  <div key={i} className="space-y-1.5">
                    {/* source label is corpus-derived → mono plain text. */}
                    <div className="font-mono text-xs text-muted-foreground">{String(k.source ?? '')}</div>
                    {k.snippet ? <CodeBlock value={k.snippet} copyable={false} wrap /> : null}
                  </div>
                ))}
              </div>
            ) : null}

            {citations.length ? (
              <div className="space-y-1.5">
                <div className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Citations
                </div>
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
              <div className="space-y-1.5">
                <div className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Reasoning
                </div>
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
 * and an open-in-Discover deep-link (when safe).
 *
 * NOTE: there is deliberately NO 👍/👎 affordance here. Chat has no feedback
 * endpoint, so a thumbs control could only ever toggle throwaway local state — a
 * dead affordance that misleads operators into thinking their grade was recorded.
 * The persisted feedback loop lives on cases (`POST /api/cases/{id}/feedback`); add
 * a thumbs control here only once a real chat-feedback endpoint exists.
 */
const MessageActions: React.FC<{
  answer: string;
  resp?: ChatResponse;
  canRegenerate: boolean;
  onRegenerate: () => void;
}> = ({ answer, resp, canRegenerate, onRegenerate }) => {
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
              aria-label="Ask this again"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Ask this again</TooltipContent>
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
    <div className="mt-3 rounded-md border border-success/30 bg-success/[0.06] px-3 py-2.5">
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
    <div className="mt-3 rounded-md border border-primary/30 bg-primary/[0.06] px-3 py-2.5">
      <div className="flex items-start gap-2">
        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
            Save this to memory?
          </div>
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
      'mt-1.5 text-2xs text-muted-foreground',
      align === 'end' ? 'self-end' : 'self-start',
    )}
  >
    <span className="font-medium">{who}</span>
    <span className="opacity-60">{` · ${clockTime(at)}`}</span>
  </div>
);

const AgentAvatar: React.FC = () => (
  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-primary">
    <Bot className="h-4 w-4" aria-hidden />
  </span>
);

const Bubble: React.FC<{
  item: TranscriptItem;
  grouped?: boolean;
  showMeta?: boolean;
  canRegenerate?: boolean;
  onRegenerate?: () => void;
  presentation?: ChatPanelPresentation;
}> = ({
  item,
  grouped = false,
  showMeta = true,
  canRegenerate = false,
  onRegenerate,
  presentation = 'default',
}) => {
  const isCaseManager = presentation === 'case-manager';

  if (item.role === 'user') {
    return (
      <div className={cn('flex justify-end', grouped && '-mt-1')}>
        <div
          className={cn(
            'flex max-w-[min(80%,720px)] flex-col',
            isCaseManager && 'items-end',
          )}
        >
          {isCaseManager && !grouped ? (
            <div className="mb-2 font-mono text-2xs font-semibold uppercase tracking-widest text-muted-foreground">
              Operator
            </div>
          ) : null}
          {/* user content is UNTRUSTED → plain text node (whitespace preserved). */}
          <div
            className={cn(
              'whitespace-pre-wrap break-words px-4 py-2.5 text-md leading-relaxed',
              isCaseManager
                ? 'rounded-md border border-border bg-muted/70 text-foreground'
                : 'rounded-xl rounded-br-md bg-primary text-primary-foreground',
            )}
          >
            {item.content}
          </div>
          {showMeta && !isCaseManager ? <MetaLine who="You" at={item.at} align="end" /> : null}
        </div>
      </div>
    );
  }

  // Assistant (answer or error).
  return (
    <div
      className={cn(
        isCaseManager ? 'flex flex-col items-start' : 'flex items-start gap-3',
        grouped && '-mt-1',
      )}
    >
      {isCaseManager ? (
        !grouped ? (
          <div className="mb-2 flex items-center gap-1.5 font-mono text-2xs font-semibold uppercase tracking-widest text-primary">
            <Bot className="h-3.5 w-3.5" aria-hidden />
            AI analyst
          </div>
        ) : null
      ) : (
        <div className="shrink-0" aria-hidden>
          {grouped ? <span className="block w-8" /> : <AgentAvatar />}
        </div>
      )}
      <div
        className={cn('flex min-w-0 flex-col', isCaseManager ? 'w-full' : 'flex-1')}
        style={{ maxWidth: isCaseManager ? 'min(88%, 860px)' : 'min(92%, 820px)' }}
      >
        {item.isError ? (
          <Alert variant="destructive">
            <ShieldAlert className="h-4 w-4" aria-hidden />
            <AlertTitle>The agent could not answer</AlertTitle>
            {/* error message from our own API layer — safe text. */}
            <AlertDescription>{item.content}</AlertDescription>
          </Alert>
        ) : (
          <div
            className={cn(
              'border border-border bg-card px-4 py-3 text-foreground',
              isCaseManager
                ? 'rounded-md border-primary/25 bg-card/70'
                : 'rounded-xl rounded-tl-md',
            )}
          >
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
        {showMeta && !isCaseManager ? <MetaLine who="SOC agent" at={item.at} align="start" /> : null}
      </div>
    </div>
  );
};

/** Animated "agent is thinking" indicator shown while a reply is in flight. */
const TypingIndicator: React.FC<{ presentation?: ChatPanelPresentation }> = ({
  presentation = 'default',
}) => {
  if (presentation === 'case-manager') {
    return (
      <div
        className="flex flex-col items-start"
        aria-label="AI analyst is searching configured sources"
      >
        <div className="mb-2 flex items-center gap-1.5 font-mono text-2xs font-semibold uppercase tracking-widest text-primary">
          <Bot className="h-3.5 w-3.5" aria-hidden />
          AI analyst
        </div>
        <div className="flex items-center gap-2 rounded-md border border-border bg-card/70 px-3 py-2 text-xs italic text-muted-foreground">
          <span className="flex items-center gap-1" aria-hidden>
            <span className="socTypingDot h-1.5 w-1.5 rounded-full bg-primary" />
            <span className="socTypingDot h-1.5 w-1.5 rounded-full bg-primary" />
            <span className="socTypingDot h-1.5 w-1.5 rounded-full bg-primary" />
          </span>
          Searching configured sources…
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3" aria-label="Agent is responding">
      <AgentAvatar />
      <div className="flex items-center gap-1.5 rounded-xl rounded-tl-md border border-border bg-card px-4 py-3.5">
        <span className="socTypingDot h-1.5 w-1.5 rounded-full bg-muted-foreground" />
        <span className="socTypingDot h-1.5 w-1.5 rounded-full bg-muted-foreground" />
        <span className="socTypingDot h-1.5 w-1.5 rounded-full bg-muted-foreground" />
      </div>
    </div>
  );
};

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
  <div className="mx-auto flex max-w-2xl flex-col items-center justify-center px-4 py-8 text-center">
    <span
      className={cn(
        'flex items-center justify-center rounded-xl border border-border bg-surface text-primary',
        compact ? 'h-12 w-12' : 'h-16 w-16',
      )}
    >
      <MessageSquare className={compact ? 'h-6 w-6' : 'h-7 w-7'} aria-hidden />
    </span>
    <h3 className="mt-5 text-lg font-semibold tracking-tight text-foreground">
      {scoped ? 'Ask about this case' : 'Ask the SOC agent anything'}
    </h3>
    {!compact ? (
      <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
        {scoped
          ? 'Dig into the evidence, pull related activity, or ask why the agent reached its verdict.'
          : "Investigate an IP, summarize today's findings, or hunt for suspicious activity. Try one of these to get started:"}
      </p>
    ) : null}
    {starters.length ? (
      <div className="mt-6 flex flex-wrap justify-center gap-2">
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

/** Honest empty transcript for the Case Manager analyst-console treatment. */
const AnalystReadyState: React.FC = () => (
  <div className="flex w-full flex-col items-start pt-2">
    <div className="mb-2 flex items-center gap-1.5 font-mono text-2xs font-semibold uppercase tracking-widest text-primary">
      <Bot className="h-3.5 w-3.5" aria-hidden />
      AI analyst
    </div>
    <div className="max-w-[min(88%,860px)] rounded-md border border-primary/25 bg-card/70 px-4 py-3 text-sm leading-relaxed text-foreground">
      Case context is ready. Ask me to summarize the evidence, check related IOCs, or suggest a
      response.
    </div>
  </div>
);

/* --------------------------------------------------------------- panel ----- */

export const ChatPanel = forwardRef<ChatPanelHandle, ChatPanelProps>(function ChatPanel(
  {
    caseId,
    compact = false,
    placeholder,
    starters = [],
    presentation = 'default',
    className,
  },
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
  // Mirror of `transcript` so regenerate() can read the latest turns WITHOUT doing
  // work inside a setState updater (updaters must stay pure; StrictMode double-invokes
  // them — see regenerate() below).
  const transcriptRef = useRef<TranscriptItem[]>([]);

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

  // Keep the ref mirror in sync so regenerate() can read the latest turns.
  useEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);

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
  // Reads the transcript from a ref and calls send() ONCE outside any setState — doing
  // this in a setState updater is impure and StrictMode double-invokes updaters in dev,
  // which would double-send the message.
  const regenerate = useCallback(
    (assistantId: number) => {
      if (loading) return;
      const turns = transcriptRef.current;
      const idx = turns.findIndex((t) => t.id === assistantId);
      if (idx < 0) return;
      for (let i = idx - 1; i >= 0; i -= 1) {
        if (turns[i].role === 'user') {
          void send(turns[i].content);
          break;
        }
      }
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
  const isCaseManager = presentation === 'case-manager';
  // The full Workspace chat uses the same compact command-bar grammar as Case
  // Manager. Only narrow generic embeds keep the older two-row controls, where a
  // popover would hide too much context.
  const isWorkspace = !compact && !isCaseManager;
  const composerPlaceholder =
    placeholder ??
    (isCaseManager
      ? 'Ask AI Analyst…'
      : 'Ask a question…  (Enter to send · Shift+Enter for a new line)');

  // Readability frame: full-page chat centres its content + composer at a sensible
  // max-width; the embedded (compact) flyout surface stays full-bleed so it is not
  // double-constrained inside the already-narrow case sheet.
  const laneInner = compact ? 'w-full' : 'mx-auto w-full max-w-3xl';
  const scopedCaseLabel = caseId && caseId.length > 19 ? `${caseId.slice(0, 18)}…` : caseId;

  const sourcePicker = hasSources ? (
    <Select value={sourceId} onValueChange={setSourceId}>
      <Tooltip>
        <TooltipTrigger asChild>
          <SelectTrigger
            className={cn(
              'h-8 gap-1.5 text-xs',
              (isCaseManager || isWorkspace) && 'w-full rounded-sm',
            )}
            aria-label="Source"
            style={isCaseManager || isWorkspace ? undefined : { minWidth: 150 }}
          >
            <Database className="h-3.5 w-3.5 shrink-0 opacity-70" />
            <SelectValue />
          </SelectTrigger>
        </TooltipTrigger>
        <TooltipContent>Which source the agent queries</TooltipContent>
      </Tooltip>
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
  ) : null;

  const modelPicker = hasModels ? (
    <Select value={model} onValueChange={setModel}>
      <Tooltip>
        <TooltipTrigger asChild>
          <SelectTrigger
            className={cn(
              'h-8 gap-1.5 text-xs',
              (isCaseManager || isWorkspace) && 'w-full rounded-sm',
            )}
            aria-label="Model"
            style={isCaseManager || isWorkspace ? undefined : { minWidth: 150 }}
          >
            <Cpu className="h-3.5 w-3.5 shrink-0 opacity-70" />
            <SelectValue />
          </SelectTrigger>
        </TooltipTrigger>
        <TooltipContent>Model for this conversation</TooltipContent>
      </Tooltip>
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
  ) : null;

  return (
    <TooltipProvider delayDuration={200}>
      <div
        className={cn('flex h-full min-h-0 flex-col', className)}
        data-chat-presentation={isCaseManager ? 'case-manager' : undefined}
      >
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

        {/* Case Manager uses the prototype's slim context/status rail. */}
        {caseId && isCaseManager ? (
          <div
            className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-sm border border-border bg-card/70 px-3 py-2 font-mono text-2xs uppercase tracking-wide text-muted-foreground sm:grid-cols-[auto_1fr_auto]"
            role="status"
            aria-live="polite"
            aria-label="AI analyst status"
          >
            <span
              className="min-w-0 truncate whitespace-nowrap"
              aria-label={`Scoped to case ${caseId}`}
            >
              <span
                className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-primary"
                aria-hidden
              />
              Scoped to: <span className="text-primary">{scopedCaseLabel}</span>
            </span>
            <span className="hidden truncate normal-case tracking-normal sm:block">
              {loading
                ? 'AI Analyst is processing case context…'
                : 'AI Analyst ready with case context.'}
            </span>
            <span className={loading ? 'text-primary' : 'text-success'}>
              Status: {loading ? 'Working' : 'Ready'}
            </span>
          </div>
        ) : caseId ? (
          <div className={cn('shrink-0 text-xs text-muted-foreground', compact ? 'mb-2' : 'mb-3')}>
            <span className="inline-flex items-center gap-1.5">
              <Link2 className="h-3.5 w-3.5 opacity-70" aria-hidden />
              Scoped to case <InlineCode>{caseId}</InlineCode>
            </span>
          </div>
        ) : null}

        {/* Transcript lane — the ONLY scrolling region. It GROWS to absorb all
            surplus height (`flex-1 min-h-0 overflow-y-auto`). When empty, an inner
            min-h-full wrapper centres the empty-state (see below) — the scroll box
            itself stays in normal flow so nothing is ever clipped/stranded. */}
        <div
          ref={scrollRef}
          className={cn(
            'flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden',
            isCaseManager
              ? 'gap-5 px-1 py-4'
              : compact
                ? 'gap-3 px-1 py-1'
                : 'gap-5 px-1 py-2',
          )}
          role="log"
          aria-live="polite"
          aria-busy={loading}
          aria-label="Chat transcript"
        >
          {isEmpty && isCaseManager ? (
            <div className={laneInner}>
              <AnalystReadyState />
            </div>
          ) : isEmpty ? (
            // Centre without collapsing the scroll region: `m-auto` centres the
            // wrapper when it fits, and `min-h-full` keeps it scrollable from the top
            // when it is taller than the frame (a bare `justify-center` on the scroll
            // box clips/strands the overflowing top under zoom/short viewports).
            <div className="m-auto flex min-h-full w-full flex-col items-center justify-center">
              <EmptyState
                compact={compact}
                scoped={!!caseId}
                starters={starters}
                loading={loading}
                onPick={(p) => void send(p)}
              />
            </div>
          ) : (
            <div className={cn('flex flex-col', compact ? 'gap-3' : 'gap-5', laneInner)}>
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
                    presentation={presentation}
                  />
                );
              })}
              {loading ? <TypingIndicator presentation={presentation} /> : null}
            </div>
          )}
        </div>

        {isCaseManager && starters.length ? (
          <div
            className={cn(
              'flex min-w-0 shrink-0 flex-nowrap items-center gap-2 overflow-x-auto overscroll-x-contain pb-1',
              laneInner,
            )}
            role="group"
            aria-label="Analyst quick actions"
          >
            {starters.map((prompt) => (
              <Button
                key={prompt}
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0 rounded-sm px-3 text-xs"
                onClick={() => void send(prompt)}
                disabled={loading}
              >
                {starterIcon(prompt)}
                {prompt}
              </Button>
            ))}
          </div>
        ) : null}

        {/* Composer — anchored at the bottom of the frame (shrink-0; never floats
            mid-page). Full Workspace and Case Manager surfaces keep model/source
            controls in a compact settings popover so the transcript stays flat and
            the old oversized two-tier form never consumes the working area. */}
        <div
          className={cn(
            'shrink-0 border border-border bg-card',
            laneInner,
            isCaseManager || isWorkspace
              ? 'mt-2 rounded-sm p-2'
              : compact
                ? 'mt-3 rounded-lg p-3'
                : 'mt-4 rounded-lg p-3.5',
          )}
        >
          <div className="flex items-end gap-2">
            {isCaseManager || isWorkspace ? (
              hasSources || hasModels ? (
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-10 w-10 shrink-0 rounded-sm text-muted-foreground"
                      aria-label="Chat settings"
                    >
                      <SlidersHorizontal className="h-4 w-4" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-72 rounded-sm p-3">
                    <div className="mb-3 font-mono text-2xs font-semibold uppercase tracking-widest text-muted-foreground">
                      Analyst settings
                    </div>
                    <div className="space-y-2">
                      {sourcePicker}
                      {modelPicker}
                    </div>
                    {hasSources && sourceId === ALL_SOURCES ? (
                      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                        “All sources” currently queries the primary source.
                      </p>
                    ) : null}
                  </PopoverContent>
                </Popover>
              ) : (
                <span
                  className="flex h-9 w-9 shrink-0 items-center justify-center text-muted-foreground"
                  aria-hidden
                >
                  <MessageSquare className="h-4 w-4" />
                </span>
              )
            ) : null}
            <Textarea
              ref={inputRef}
              placeholder={composerPlaceholder}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={loading}
              rows={isCaseManager || isWorkspace ? 1 : 2}
              aria-label="Chat message"
              className={cn(
                'resize-none border-0 bg-transparent shadow-none focus-visible:ring-0',
                isCaseManager || isWorkspace
                  ? cn(
                      'min-h-10 max-h-28 overflow-y-auto py-2.5 [field-sizing:content]',
                      isCaseManager ? 'font-mono text-xs' : 'text-sm',
                    )
                  : 'min-h-0',
              )}
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size={isCaseManager ? 'icon' : 'default'}
                  className={cn(
                    'shrink-0 rounded-sm',
                    isCaseManager ? 'h-10 w-10' : isWorkspace ? 'h-10 px-4' : '',
                  )}
                  onClick={() => void send()}
                  disabled={(!input.trim() && !loading) || loading}
                  aria-label="Send message"
                >
                  <Send className="h-4 w-4" />
                  {isCaseManager ? null : 'Send'}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{loading ? 'Waiting for the agent…' : 'Send (Enter)'}</TooltipContent>
            </Tooltip>
          </div>

          {!isCaseManager && !isWorkspace ? (
            <>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                <span className="text-xs text-muted-foreground">
                  Enter to send · Shift+Enter for a new line
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  {sourcePicker}
                  {modelPicker}
                </div>
              </div>

              {hasSources && sourceId === ALL_SOURCES ? (
                <div className="mt-2 text-xs text-muted-foreground">
                  “All sources” currently queries the primary source.
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </TooltipProvider>
  );
});
