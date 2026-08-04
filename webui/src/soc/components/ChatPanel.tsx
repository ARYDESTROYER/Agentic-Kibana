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
 * empty Workspace state groups its introduction, useful starting questions, and
 * composer in one focused workbench. Once a turn exists, the transcript is the only
 * scrolling region and the composer docks to the bottom. The Workspace lane uses a
 * 60rem readability cap; the embedded `compact` case surface stays full-bleed so it
 * is not double-constrained.
 *
 * SECURITY (UNTRUSTED rendering): assistant answers, queries, table cells, memory
 * text, reasoning, knowledge snippets and tool output are all model- or log-derived
 * and therefore UNTRUSTED. They are rendered EXCLUSIVELY as React text nodes (light
 * inline markdown is parsed into React elements — bold / `code` / bullets — never
 * via dangerouslySetInnerHTML). There is no HTML-injection path anywhere here.
 */
import * as React from "react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowDown,
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
} from "lucide-react";
import type {
  ChatMemoryAction,
  ChatMemorySuggestion,
  ChatConversation,
  ChatResponse,
  ChatTable,
  ChatTurn,
  ModelsResponse,
  SourceInstance,
} from "@/lib/types";
import { api, ApiError } from "@/lib/api";
import { fmtMoney } from "@/lib/format";
import { cn } from "@/lib/cn";
import { copyText } from "@/lib/clipboard";
import { LoadingGlyph } from "@/design-system";
import { LoadingState } from "@/design-system/loading";
import { Button } from "@/ui/button";
import { Textarea } from "@/ui/textarea";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/ui/tooltip";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/ui/accordion";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { CodeBlock, InlineCode } from "./CodeBlock";
import { Markdown } from "./Markdown";

/* ------------------------------------------------------------------ types -- */

/** A rendered transcript entry. Assistant turns may carry the full response so we
 *  can render the table / query / cost / memory / provenance surfaces beneath the
 *  bubble. Error turns render as a non-fatal alert instead of prose. */
interface TranscriptItem {
  id: number | string;
  role: "user" | "assistant";
  content: string;
  resp?: ChatResponse;
  isError?: boolean;
  /** Links an optimistic user turn and its retryable error without entering model history. */
  requestKey?: string;
  retry?: RetrySpec;
  /** ms epoch the turn was added (for a subdued time-of-day footnote). */
  at: number;
  /** The model used for this assistant turn (subtle meta), when known. */
  model?: string;
  /** Effective source used for this assistant turn, when known. */
  source?: string;
}

interface RetrySpec {
  message: string;
  idempotencyKey: string;
  history: ChatTurn[];
  model?: string;
  sourceId?: string;
  conversationId?: string;
}

export type ChatPanelPresentation = "default" | "case-manager" | "workspace";

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
  /** Controlled persisted Workspace conversation. Undefined keeps the legacy,
   * entirely local mode used by embeds; null represents a fresh draft. */
  conversation?: ChatConversation | null;
  /** Opt this panel into the per-user Workspace conversation store. */
  persistConversation?: boolean;
  /** Thread-header copy owned by the Workspace page/history rail. */
  workspaceTitle?: string;
  workspaceSubtitle?: string;
  /** Controlled unsent Workspace draft. Omitted preserves legacy local behavior. */
  draft?: string;
  onDraftChange?: (value: string) => void;
  /** Honest bounded-history disclosure supplied by the Workspace controller. */
  workspaceRetentionNote?: string | null;
  /** Reports the id/title after a persisted first turn or subsequent activity. */
  onConversationPersisted?: (id: string, title: string) => void;
  /** Keep the workspace frame mounted while an authoritative saved thread restores. */
  restoring?: boolean;
  /** Recoverable saved-thread error rendered inside the transcript lane. */
  restoreError?: string | null;
  onRetryRestore?: () => void;
  onStartNew?: () => void;
  /** Lets the Workspace prevent thread switching while a turn is in flight. */
  onBusyChange?: (busy: boolean) => void;
  className?: string;
}

/** Imperative handle so a host page can reset the conversation ("New chat"). */
export interface ChatPanelHandle {
  reset: () => void;
}

/** The composer source-scope sentinel: query the configured (primary) source. */
const ALL_SOURCES = "__all__";
/** The model sentinel: use the backend-configured default chat model. */
const DEFAULT_MODEL = "__default__";
/** Cap the rows we render from a single chat result table. */
const MAX_TABLE_ROWS = 50;

/* --------------------------------------------------------------- helpers --- */

/** Compact time-of-day stamp for a transcript footnote (e.g. "3:42 PM"). */
function clockTime(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

/** A client-generated key survives an explicit retry and is bounded for the API contract. */
function newIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `chat-${globalThis.crypto.randomUUID()}`;
  }
  return `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

/** True for an "empty" cell value (null / undefined / blank string). */
function isBlankCell(v: unknown): boolean {
  return (
    v === null || v === undefined || (typeof v === "string" && v.trim() === "")
  );
}

/** A friendly label for a configured source (display name, else type · id). */
function sourceLabel(s: SourceInstance): string {
  const name = (s.display_name || "").trim();
  if (name) return name;
  const type = (s.source_type || "").trim();
  return type ? `${type} · ${s.id}` : s.id;
}

/**
 * Pull a usable http(s) deep-link out of the backend's `discover` payload. Anything
 * that is not a plain http(s) URL (or a leading-slash same-origin path) is rejected
 * so we never render a `javascript:` / `data:` link from a model-derived value.
 */
function discoverHref(discover: ChatResponse["discover"]): string | null {
  if (!discover || typeof discover !== "object") return null;
  const d = discover as Record<string, unknown>;
  const candidate =
    (typeof d.url === "string" && d.url) ||
    (typeof d.href === "string" && d.href) ||
    (typeof d.path === "string" && d.path) ||
    "";
  const s = candidate.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("/")) return s; // same-origin path
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

  const cappedRows = useMemo(
    () => table.rows.slice(0, MAX_TABLE_ROWS),
    [table.rows],
  );
  const hiddenRowCount = Math.max(0, table.rows.length - cappedRows.length);

  if (!table.columns.length || !table.rows.length) return null;

  if (!visibleCols.length) {
    return (
      <div className="mt-3 rounded-md border border-border bg-surface px-3 py-2 text-xs text-muted-foreground">
        {table.rows.length} {table.rows.length === 1 ? "row" : "rows"} returned,
        but no field values to display.
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
                  <td
                    key={ci}
                    className="whitespace-nowrap px-3 py-2 font-mono text-foreground"
                  >
                    {/* cell value is UNTRUSTED → plain text node. */}
                    {isBlankCell(row[ci]) ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      String(row[ci])
                    )}
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
            : "Results truncated."}
        </div>
      ) : null}
    </div>
  );
};

/** A tiny copy-to-clipboard icon button (best-effort; silent on denial). */
const CopyButton: React.FC<{ text: string; label: string }> = ({
  text,
  label,
}) => {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
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
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onCopy}
          aria-label={label}
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-success" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : label}</TooltipContent>
    </Tooltip>
  );
};

/** One quiet disclosure for the evidence and execution metadata behind an answer. */
const ResponseEvidence: React.FC<{
  resp: ChatResponse;
  model?: string;
  source?: string;
  turnId: number | string;
}> = ({ resp, model, source, turnId }) => {
  const hasQuery =
    typeof resp.query === "string" && resp.query.trim().length > 0;
  const hasCost = typeof resp.cost === "number" && resp.cost > 0;
  const hasModel = typeof model === "string" && model.trim().length > 0;
  const hasSource = typeof source === "string" && source.trim().length > 0;
  const tools = Array.isArray(resp.tools) ? resp.tools : [];
  const knowledge = Array.isArray(resp.knowledge) ? resp.knowledge : [];
  const citations = Array.isArray(resp.citations) ? resp.citations : [];
  const reasoning =
    typeof resp.reasoning === "string" ? resp.reasoning.trim() : "";
  const savedEvidenceTruncated = resp.truncated === true;
  const hasAny =
    savedEvidenceTruncated ||
    hasQuery ||
    hasCost ||
    hasModel ||
    hasSource ||
    tools.length > 0 ||
    knowledge.length > 0 ||
    citations.length > 0 ||
    !!reasoning;
  if (!hasAny) return null;

  return (
    <div className="mt-3 border-y border-border/80">
      <Accordion type="single" collapsible>
        <AccordionItem value={`evidence-${turnId}`} className="border-b-0">
          <AccordionTrigger className="py-2.5 text-xs font-medium text-muted-foreground hover:no-underline">
            <span className="flex min-w-0 flex-1 items-center justify-between gap-3 pr-2">
              <span className="inline-flex items-center gap-1.5 text-foreground">
                <Sparkles className="h-3.5 w-3.5" aria-hidden />
                Evidence &amp; execution
              </span>
              <span className="truncate font-normal text-muted-foreground">
                {[
                  tools.length ? `${tools.length} ${tools.length === 1 ? "tool" : "tools"}` : "",
                  citations.length
                    ? `${citations.length} ${citations.length === 1 ? "citation" : "citations"}`
                    : "",
                  hasCost ? fmtMoney(resp.cost) : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </span>
          </AccordionTrigger>
          <AccordionContent className="pb-3">
            <div className="grid gap-x-6 gap-y-4 border-t border-border/70 pt-3 sm:grid-cols-2">
              {savedEvidenceTruncated ? (
                <div
                  className="border-l-2 border-warning px-3 py-1.5 text-xs leading-relaxed text-muted-foreground sm:col-span-2"
                  role="note"
                >
                  This saved response exceeded the history limit. The answer and
                  available scalar evidence were preserved; larger tables and evidence
                  collections may be omitted.
                </div>
              ) : null}
              {hasQuery ? (
                <div className="min-w-0 space-y-2 sm:col-span-2">
                  <div className="flex items-center justify-between gap-2 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <span>Query executed</span>
                    <CopyButton text={(resp.query as string) ?? ""} label="Copy query" />
                  </div>
                  <CodeBlock value={resp.query as string} copyable={false} wrap />
                </div>
              ) : null}

              {tools.length ? (
                <div className="space-y-2">
                  <div className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Tools run
                  </div>
                  {tools.map((t, i) => (
                    <div key={i} className="space-y-1.5">
                      <div className="text-xs text-foreground">
                        {/* tool name is engine-derived → plain text. */}
                        <span className="font-semibold">
                          {String(t.tool ?? "tool")}
                        </span>
                        {t.summary ? (
                          <span className="text-muted-foreground">{` — ${t.summary}`}</span>
                        ) : null}
                      </div>
                      {t.query ? (
                        <CodeBlock value={t.query} caption="query" wrap />
                      ) : null}
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
                      <div className="font-mono text-xs text-muted-foreground">
                        {String(k.source ?? "")}
                      </div>
                      {k.snippet ? (
                        <CodeBlock value={k.snippet} copyable={false} wrap />
                      ) : null}
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
                      <span className="font-mono">{String(c.source ?? "")}</span>
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
              {hasCost || hasModel || hasSource ? (
                <div className="space-y-2">
                  <div className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Execution
                  </div>
                  <div className="space-y-1.5 text-xs text-foreground">
                    {hasModel ? (
                      <div className="flex items-center gap-2">
                        <Cpu className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                        <span className="font-mono">{model}</span>
                      </div>
                    ) : null}
                    {hasSource ? (
                      <div className="flex items-center gap-2">
                        <Database className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                        <span className="font-mono">{source}</span>
                      </div>
                    ) : null}
                    {hasCost ? (
                      <div className="flex items-center gap-2">
                        <Gauge className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                        <span className="tabular-nums">{fmtMoney(resp.cost)} this message</span>
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
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
    <div className="mt-2 flex flex-wrap items-center gap-1 opacity-70 transition-opacity hover:opacity-100 focus-within:opacity-100 motion-reduce:transition-none">
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
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          asChild
        >
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
const MemoryActionEcho: React.FC<{ action: ChatMemoryAction }> = ({
  action,
}) => {
  const op = (action.op || "").toLowerCase();
  const isDelete = op === "delete" || op === "remove";
  const hasText =
    typeof action.text === "string" && action.text.trim().length > 0;
  if (!isDelete && !hasText) return null;
  const label = isDelete
    ? "Forgot this fact"
    : op === "update"
      ? "Memory updated"
      : "Remembered";
  return (
    <div className="mt-3 rounded-md border border-success/30 bg-success/[0.06] px-3 py-2.5">
      <div className="flex items-start gap-2 text-xs">
        <Sparkles
          className="mt-0.5 h-4 w-4 shrink-0 text-success"
          aria-hidden
        />
        <div>
          <span className="font-semibold text-success">{label}</span>
          {/* memory text is UNTRUSTED → plain text node. */}
          {hasText ? (
            <span className="text-muted-foreground">{`: ${action.text}`}</span>
          ) : null}
        </div>
      </div>
    </div>
  );
};

/** An inline, dismissible prompt offering to save a memory the engine PROPOSED. */
const MemorySuggestionPrompt: React.FC<{
  suggestion: ChatMemorySuggestion;
}> = ({ suggestion }) => {
  const [state, setState] = useState<
    "pending" | "saving" | "saved" | "dismissed" | "error"
  >("pending");
  const [error, setError] = useState<string | null>(null);

  const text = (suggestion.text || "").trim();
  if (!text || state === "dismissed") return null;

  const remember = async () => {
    if (state === "saving" || state === "saved") return;
    setState("saving");
    setError(null);
    try {
      await api.addMemory({ text });
      setState("saved");
    } catch (e) {
      const msg =
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : "Could not save to memory.";
      setError(msg);
      setState("error");
    }
  };

  const saving = state === "saving";
  const saved = state === "saved";

  return (
    <div className="mt-3 rounded-md border border-primary/30 bg-primary/[0.06] px-3 py-2.5">
      <div className="flex items-start gap-2">
        <Sparkles
          className="mt-0.5 h-4 w-4 shrink-0 text-primary"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
            Save this to memory?
          </div>
          {/* suggested text is UNTRUSTED → plain text node. */}
          <div className="mt-0.5 text-sm text-foreground">{text}</div>
          {suggestion.reason && suggestion.reason.trim() ? (
            <div className="mt-0.5 text-xs text-muted-foreground">
              {suggestion.reason}
            </div>
          ) : null}
          <div className="mt-2">
            {saved ? (
              <div className="inline-flex items-center gap-1 text-xs text-success">
                <Check className="h-3.5 w-3.5" aria-hidden />
                Saved to memory
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  onClick={() => void remember()}
                  disabled={saving}
                >
                  {saving ? "Saving…" : "Remember this"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setState("dismissed")}
                  disabled={saving}
                >
                  <X className="h-3.5 w-3.5" />
                  Dismiss
                </Button>
              </div>
            )}
            {state === "error" && error ? (
              <div className="mt-1 text-xs text-critical">{error}</div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
};

/* --------------------------------------------------------------- bubbles --- */

const MetaLine: React.FC<{
  who: string;
  at: number;
  align: "start" | "end";
}> = ({ who, at, align }) => (
  <div
    className={cn(
      "mt-1.5 text-2xs text-muted-foreground",
      align === "end" ? "self-end" : "self-start",
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
  onRetry?: (retry: RetrySpec) => void;
  presentation?: ChatPanelPresentation;
}> = ({
  item,
  grouped = false,
  showMeta = true,
  canRegenerate = false,
  onRegenerate,
  onRetry,
  presentation = "default",
}) => {
  const isCaseManager = presentation === "case-manager";
  const isWorkspace = presentation === "workspace";

  if (item.role === "user") {
    return (
      <article
        className={cn("flex justify-end", grouped && "-mt-1")}
        aria-label={`Operator message at ${clockTime(item.at)}`}
      >
        <div
          className={cn(
            "flex max-w-[min(72%,720px)] flex-col max-sm:max-w-[88%]",
            (isCaseManager || isWorkspace) && "items-end",
          )}
        >
          {(isCaseManager || isWorkspace) && !grouped ? (
            <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <span>Operator</span>
              {isWorkspace ? (
                <span className="font-normal normal-case tracking-normal opacity-60">
                  {clockTime(item.at)}
                </span>
              ) : null}
            </div>
          ) : null}
          {/* user content is UNTRUSTED → plain text node (whitespace preserved). */}
          <div
            className={cn(
              "whitespace-pre-wrap break-words px-4 py-2.5 text-md leading-relaxed",
              isCaseManager
                ? "rounded-md border border-border bg-muted/70 text-foreground"
                : isWorkspace
                  ? "rounded-md border border-border bg-surface text-foreground"
                  : "rounded-xl rounded-br-md bg-primary text-primary-foreground",
            )}
          >
            {item.content}
          </div>
          {showMeta && !isCaseManager && !isWorkspace ? (
            <MetaLine who="You" at={item.at} align="end" />
          ) : null}
        </div>
      </article>
    );
  }

  // Assistant (answer or error).
  return (
    <article
      className={cn(
        isCaseManager || isWorkspace
          ? "flex flex-col items-start"
          : "flex items-start gap-3",
        grouped && "-mt-1",
      )}
      aria-label={`SOC agent message at ${clockTime(item.at)}`}
    >
      {isCaseManager || isWorkspace ? (
        !grouped ? (
          <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-foreground">
            <Bot className="h-3.5 w-3.5" aria-hidden />
            <span>{isCaseManager ? "AI analyst" : "SOC agent"}</span>
            {isWorkspace ? (
              <span className="font-normal normal-case tracking-normal text-muted-foreground">
                {clockTime(item.at)}
              </span>
            ) : null}
          </div>
        ) : null
      ) : (
        <div className="shrink-0" aria-hidden>
          {grouped ? <span className="block w-8" /> : <AgentAvatar />}
        </div>
      )}
      <div
        className={cn(
          "flex min-w-0 flex-col",
          isCaseManager || isWorkspace ? "w-full" : "flex-1",
        )}
        style={{
          maxWidth: isCaseManager
            ? "min(88%, 860px)"
            : isWorkspace
              ? "min(92%, 880px)"
              : "min(92%, 820px)",
        }}
      >
        {item.isError ? (
          <Alert variant="destructive">
            <ShieldAlert className="h-4 w-4" aria-hidden />
            <AlertTitle>The agent could not answer</AlertTitle>
            {/* error message from our own API layer — safe text. */}
            <AlertDescription>
              <span className="block">{item.content}</span>
              {item.retry && onRetry ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-3 border-critical/35 bg-background/70 text-foreground"
                  onClick={() => onRetry(item.retry as RetrySpec)}
                >
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                  Retry same request
                </Button>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : (
          <div
            className={cn(
              "border border-border bg-card px-4 py-3 text-foreground",
              isCaseManager
                ? "rounded-md border-primary/25 bg-card/70"
                : isWorkspace
                  ? "rounded-none border-0 bg-transparent px-0 py-0"
                  : "rounded-xl rounded-tl-md",
            )}
          >
            <Markdown text={item.content} />
          </div>
        )}
        {item.resp?.table ? <ResultTable table={item.resp.table} /> : null}
        {item.resp ? (
          <ResponseEvidence
            resp={item.resp}
            model={item.model}
            source={item.source}
            turnId={item.id}
          />
        ) : null}
        {!item.isError ? (
          <MessageActions
            answer={item.content}
            resp={item.resp}
            canRegenerate={canRegenerate}
            onRegenerate={onRegenerate ?? (() => {})}
          />
        ) : null}
        {item.resp?.memory_action ? (
          <MemoryActionEcho action={item.resp.memory_action} />
        ) : null}
        {item.resp?.memory_suggestion ? (
          <MemorySuggestionPrompt suggestion={item.resp.memory_suggestion} />
        ) : null}
        {showMeta && !isCaseManager && !isWorkspace ? (
          <MetaLine who="SOC agent" at={item.at} align="start" />
        ) : null}
      </div>
    </article>
  );
};

/** Animated "agent is thinking" indicator shown while a reply is in flight. */
const TypingIndicator: React.FC<{ presentation?: ChatPanelPresentation }> = ({
  presentation = "default",
}) => {
  const isCaseManager = presentation === "case-manager";
  const isWorkspace = presentation === "workspace";

  if (isCaseManager || isWorkspace) {
    return (
      <div
        className="flex flex-col items-start"
        aria-label={`${isCaseManager ? "AI analyst" : "SOC agent"} is searching configured sources`}
      >
        <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-foreground">
          <Bot className="h-3.5 w-3.5" aria-hidden />
          {isCaseManager ? "AI analyst" : "SOC agent"}
        </div>
        <div
          className={cn(
            "flex items-center gap-2 text-xs italic text-muted-foreground",
            isCaseManager
              ? "rounded-md border border-border bg-card/70 px-3 py-2"
              : "py-2",
          )}
        >
          <LoadingGlyph size="sm" className="size-4" />
          Searching configured sources…
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3" aria-label="Agent is responding">
      <AgentAvatar />
      <div className="flex items-center gap-2 rounded-xl rounded-tl-md border border-border bg-card px-4 py-3 text-xs text-muted-foreground">
        <LoadingGlyph size="sm" className="size-4" />
        Agent is responding…
      </div>
    </div>
  );
};

/* ----------------------------------------------------------- empty state --- */

function starterIcon(prompt: string): React.ReactNode {
  const p = prompt.toLowerCase();
  if (/\bsummar|today|digest|overview\b/.test(p))
    return <Sparkles className="h-4 w-4" />;
  if (/\bbrute|attack|suspicious|malic|threat|exploit\b/.test(p))
    return <ShieldAlert className="h-4 w-4" />;
  if (/\bhost|ip|asset|which |most |top \b/.test(p))
    return <Wand2 className="h-4 w-4" />;
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
        "flex items-center justify-center rounded-xl border border-border bg-surface text-primary",
        compact ? "h-12 w-12" : "h-16 w-16",
      )}
    >
      <MessageSquare className={compact ? "h-6 w-6" : "h-7 w-7"} aria-hidden />
    </span>
    <h3 className="mt-5 text-lg font-semibold tracking-tight text-foreground">
      {scoped ? "Ask about this case" : "Ask the SOC agent anything"}
    </h3>
    {!compact ? (
      <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
        {scoped
          ? "Dig into the evidence, pull related activity, or ask why the agent reached its verdict."
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

/** Compact, top-positioned empty transcript for Workspace Chat. The composer remains
 * docked below this state so starting a conversation never causes a layout jump. */
const WorkspaceReadyState: React.FC<{
  starters: string[];
  loading: boolean;
  onPick: (prompt: string) => void;
}> = ({ starters, loading, onPick }) => (
  <div className="w-full pt-7 sm:pt-9" data-testid="workspace-chat-ready">
    <div className="max-w-2xl">
      <h3 className="text-base font-semibold text-foreground">
        Start an investigation
      </h3>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
        Ask about an indicator, current posture, or the evidence behind a case.
      </p>
    </div>

    {starters.length ? (
      <div className="mt-8">
        <div className="mb-2 text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Suggested investigations
        </div>
        <div
          className="grid grid-cols-1 border-y border-border sm:grid-cols-2"
          role="group"
          aria-label="Suggested questions"
        >
          {starters.map((prompt) => (
            <Button
              key={prompt}
              type="button"
              variant="ghost"
              className="h-auto min-h-14 justify-start rounded-none border-b border-border px-3 py-3 text-left text-sm font-medium last:border-b-0 hover:bg-surface sm:[&:nth-child(even)]:border-l sm:[&:nth-child(n+3)]:border-b-0"
              onClick={() => onPick(prompt)}
              disabled={loading}
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border border-border bg-background text-primary">
                {starterIcon(prompt)}
              </span>
              <span className="min-w-0 whitespace-normal leading-snug">{prompt}</span>
            </Button>
          ))}
        </div>
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
      Case context is ready. Ask me to summarize the evidence, check related
      IOCs, or suggest a response.
    </div>
  </div>
);

/* --------------------------------------------------------------- panel ----- */

export const ChatPanel = forwardRef<ChatPanelHandle, ChatPanelProps>(
  function ChatPanel(
    {
      caseId,
      compact = false,
      placeholder,
      starters = [],
      presentation = "default",
      conversation,
      persistConversation = false,
      workspaceTitle,
      workspaceSubtitle,
      draft,
      onDraftChange,
      workspaceRetentionNote,
      onConversationPersisted,
      restoring = false,
      restoreError,
      onRetryRestore,
      onStartNew,
      onBusyChange,
      className,
    },
    ref,
  ) {
    const [input, setInput] = useState(draft ?? "");
    const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
    const [history, setHistory] = useState<ChatTurn[]>([]);
    const [loading, setLoading] = useState(false);
    const [resetFocusEpoch, setResetFocusEpoch] = useState(0);

    // Model selection (optional per-turn override). DEFAULT_MODEL = backend default.
    const [models, setModels] = useState<ModelsResponse | null>(null);
    const [model, setModel] = useState<string>(DEFAULT_MODEL);

    // Source scope. ALL_SOURCES = the configured/primary source (no source_id sent).
    const [sources, setSources] = useState<SourceInstance[]>([]);
    const [sourceId, setSourceId] = useState<string>(ALL_SOURCES);
    const [activeConversationId, setActiveConversationId] = useState<string | undefined>(
      conversation?.id,
    );

    const idRef = useRef(0);
    const scrollRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement | null>(null);
    const followLatestRef = useRef(true);
    const [showJumpToLatest, setShowJumpToLatest] = useState(false);
    // Each reset starts a new local conversation generation. A response from an older
    // generation is ignored so "New chat" cannot be repopulated by a stale request.
    const conversationGenerationRef = useRef(0);
    // Mirror of `transcript` so regenerate() can read the latest turns WITHOUT doing
    // work inside a setState updater (updaters must stay pure; StrictMode double-invokes
    // them — see regenerate() below).
    const transcriptRef = useRef<TranscriptItem[]>([]);
    const controlledDraftRef = useRef(draft);
    controlledDraftRef.current = draft;

    const nextId = () => {
      idRef.current += 1;
      return idRef.current;
    };

    const updateInput = useCallback(
      (value: string) => {
        setInput(value);
        onDraftChange?.(value);
      },
      [onDraftChange],
    );

    // Workspace owns a separate unsent draft per selected conversation. Embeds omit
    // this prop and remain fully local, preserving the Case Manager chat contract.
    useEffect(() => {
      if (draft !== undefined) setInput(draft);
    }, [draft]);

    // Fetch models + configured sources once (best-effort; pickers stay at defaults).
    useEffect(() => {
      let cancelled = false;
      void api
        .getModels()
        .then((res) => {
          if (!cancelled) setModels(res);
        })
        .catch(() => {
          /* non-fatal */
        });
      void api
        .listSources()
        .then((res) => {
          if (!cancelled) setSources(res.sources || []);
        })
        .catch(() => {
          /* non-fatal */
        });
      return () => {
        cancelled = true;
      };
    }, []);

    // Workspace Chat may be controlled by the page's durable conversation rail.
    // Case embeds leave `conversation` undefined and retain the legacy local engine.
    useEffect(() => {
      if (conversation === undefined) return;
      conversationGenerationRef.current += 1;
      setLoading(false);
      if (controlledDraftRef.current === undefined) setInput("");

      if (conversation === null) {
        followLatestRef.current = true;
        setShowJumpToLatest(false);
        setActiveConversationId(undefined);
        setTranscript([]);
        setHistory([]);
        setModel(DEFAULT_MODEL);
        setSourceId(ALL_SOURCES);
        return;
      }

      setActiveConversationId(conversation.id);
      followLatestRef.current = true;
      setShowJumpToLatest(false);
      setTranscript(
        (conversation.messages || []).map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          resp: message.response ?? undefined,
          at: Number.isFinite(Date.parse(message.created_at))
            ? Date.parse(message.created_at)
            : Date.now(),
          model:
            message.model?.trim() ||
            message.response?.effective_model?.trim() ||
            undefined,
          source:
            message.source_name?.trim() ||
            message.source_id?.trim() ||
            message.response?.effective_source_name?.trim() ||
            message.response?.effective_source_id?.trim() ||
            undefined,
        })),
      );
      setHistory(
        (conversation.messages || []).map(({ role, content }) => ({
          role,
          content,
        })),
      );
      setModel(conversation.model?.trim() || DEFAULT_MODEL);
      setSourceId(conversation.source_id?.trim() || ALL_SOURCES);
    }, [conversation]);

    // Follow new turns only while the analyst is already near the bottom. Reading
    // older evidence must never be interrupted by an unconditional jump.
    useEffect(() => {
      const el = scrollRef.current;
      if (!el) return;
      if (!followLatestRef.current) {
        setShowJumpToLatest(true);
        return;
      }
      const reduce =
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollTo({
        top: el.scrollHeight,
        behavior: reduce ? "auto" : "smooth",
      });
      setShowJumpToLatest(false);
    }, [transcript, loading]);

    useEffect(() => {
      onBusyChange?.(loading);
    }, [loading, onBusyChange]);
    useEffect(
      () => () => {
        onBusyChange?.(false);
      },
      [onBusyChange],
    );

    // Keep the ref mirror in sync so regenerate() can read the latest turns.
    useEffect(() => {
      transcriptRef.current = transcript;
    }, [transcript]);

    const send = useCallback(
      async (raw?: string, retry?: RetrySpec) => {
        const message = (retry?.message ?? raw ?? input).trim();
        if (!message || loading || restoring || restoreError) return;

        const baseHistory = retry?.history ?? history;
        const userTurn: ChatTurn = { role: "user", content: message };
        const generation = conversationGenerationRef.current;
        const usedModel =
          retry?.model ??
          (model !== DEFAULT_MODEL ? model.trim() || undefined : undefined);
        const usedSource =
          retry?.sourceId ??
          (sourceId !== ALL_SOURCES ? sourceId.trim() || undefined : undefined);
        const requestConversationId =
          retry?.conversationId ?? activeConversationId;
        const requestKey =
          retry?.idempotencyKey ??
          (persistConversation ? newIdempotencyKey() : undefined);
        const retrySpec: RetrySpec | undefined = requestKey
          ? {
              message,
              idempotencyKey: requestKey,
              history: baseHistory,
              model: usedModel,
              sourceId: usedSource,
              conversationId: requestConversationId,
            }
          : undefined;

        setTranscript((previous) => [
          ...previous.filter(
            (item) => !retry?.idempotencyKey || item.requestKey !== retry.idempotencyKey,
          ),
          {
            id: nextId(),
            role: "user",
            content: message,
            at: Date.now(),
            requestKey,
          },
        ]);
        if (!retry) updateInput("");
        setLoading(true);

        try {
          // `message` is the current user turn; `baseHistory` contains only earlier
          // successful turns. Failed optimistic prompts never enter hidden context.
          const resp = persistConversation
            ? await api.chat(
                message,
                baseHistory,
                caseId,
                usedModel,
                usedSource,
                requestConversationId,
                true,
                requestKey,
              )
            : await api.chat(
                message,
                baseHistory,
                caseId,
                usedModel,
                usedSource,
                requestConversationId,
                false,
              );
          if (conversationGenerationRef.current !== generation) return;
          if (resp.conversation_id) {
            setActiveConversationId(resp.conversation_id);
            onConversationPersisted?.(
              resp.conversation_id,
              resp.conversation_title?.trim() || message,
            );
          }
          const answer = resp.answer || "(no answer returned)";
          const effectiveModel = resp.effective_model?.trim() || usedModel;
          const effectiveSource =
            resp.effective_source_name?.trim() ||
            resp.effective_source_id?.trim() ||
            usedSource;
          setTranscript((previous) => [
            ...previous,
            {
              id: nextId(),
              role: "assistant",
              content: answer,
              resp,
              at: Date.now(),
              model: effectiveModel,
              source: effectiveSource,
              requestKey,
            },
          ]);
          setHistory([
            ...baseHistory,
            userTurn,
            { role: "assistant", content: answer },
          ]);
        } catch (e) {
          if (conversationGenerationRef.current !== generation) return;
          const msg =
            e instanceof ApiError
              ? e.message
              : e instanceof Error
                ? e.message
                : "Unexpected error contacting the agent.";
          setTranscript((previous) => [
            ...previous,
            {
              id: nextId(),
              role: "assistant",
              content: msg,
              isError: true,
              at: Date.now(),
              requestKey,
              retry: retrySpec,
            },
          ]);
          // Neither the failed prompt nor the transport error enters model history.
        } finally {
          if (conversationGenerationRef.current === generation) {
            setLoading(false);
            inputRef.current?.focus();
          }
        }
      },
      [
        input,
        history,
        loading,
        caseId,
        model,
        sourceId,
        activeConversationId,
        persistConversation,
        onConversationPersisted,
        restoring,
        restoreError,
        updateInput,
      ],
    );

    const retryFailed = useCallback(
      (retry: RetrySpec) => {
        if (!loading) void send(retry.message, retry);
      },
      [loading, send],
    );

    // Regenerate: re-send the user turn that immediately preceded a given assistant turn.
    // Reads the transcript from a ref and calls send() ONCE outside any setState — doing
    // this in a setState updater is impure and StrictMode double-invokes updaters in dev,
    // which would double-send the message.
    const regenerate = useCallback(
      (assistantId: number | string) => {
        if (loading) return;
        const turns = transcriptRef.current;
        const idx = turns.findIndex((t) => t.id === assistantId);
        if (idx < 0) return;
        for (let i = idx - 1; i >= 0; i -= 1) {
          if (turns[i].role === "user") {
            void send(turns[i].content);
            break;
          }
        }
      },
      [loading, send],
    );

    const reset = useCallback(() => {
      conversationGenerationRef.current += 1;
      setTranscript([]);
      setHistory([]);
      // A controlled Workspace draft belongs to the host's selected draft key;
      // resetting the transcript must not erase it. Local embeds still reset fully.
      if (draft === undefined) setInput("");
      setLoading(false);
      setActiveConversationId(undefined);
      // Focus the one docked Workspace composer after the empty-state commit.
      setResetFocusEpoch((epoch) => epoch + 1);
    }, [draft]);

    useImperativeHandle(ref, () => ({ reset }), [reset]);

    const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.nativeEvent.isComposing) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void send();
      }
    };

    const modelOptions = useMemo(() => {
      const out: Array<{ value: string; label: string }> = [];
      if (models) {
        for (const [provider, list] of Object.entries(models.providers || {})) {
          for (const m of list || [])
            out.push({ value: m, label: `${m}  ·  ${provider}` });
        }
      }
      return out;
    }, [models]);
    // Chat can query only an enabled pull connector. Demo adapters are intentionally
    // queryable even when their protocol-faithful ingest mode is push/stream, and the
    // API marks those rows with both `demo` and `can_browse`. Hiding everything else
    // prevents the selector from naming one source while the backend truthfully falls
    // back to Primary.
    const queryableSources = useMemo(
      () =>
        sources.filter(
          (source) =>
            source.enabled !== false &&
            source.can_browse !== false &&
            (source.ingest_mode === "pull" || source.demo === true),
        ),
      [sources],
    );
    const hasModels = modelOptions.length > 0;
    const hasSources = queryableSources.length > 0;
    const interactionDisabled = loading || restoring || !!restoreError;

    const isEmpty = transcript.length === 0;
    const isCaseManager = presentation === "case-manager";
    // The full Workspace chat uses the same compact command-bar grammar as Case
    // Manager. Only narrow generic embeds keep the older two-row controls, where a
    // popover would hide too much context.
    const isWorkspace =
      presentation === "workspace" ||
      (!compact && !caseId && presentation === "default");
    const resolvedPresentation: ChatPanelPresentation = isWorkspace
      ? "workspace"
      : presentation;

    useEffect(() => {
      if (resetFocusEpoch > 0) inputRef.current?.focus();
    }, [resetFocusEpoch]);
    const composerPlaceholder =
      placeholder ??
      (isCaseManager
        ? "Ask AI Analyst…"
        : isWorkspace
          ? "Ask the SOC agent…"
          : "Ask a question…  (Enter to send · Shift+Enter for a new line)");

    // Readability frame: full-page chat centres its content + composer at a sensible
    // max-width; the embedded (compact) flyout surface stays full-bleed so it is not
    // double-constrained inside the already-narrow case sheet.
    const laneInner = compact
      ? "w-full"
      : isWorkspace
        ? "mx-auto w-full max-w-[54rem]"
        : "mx-auto w-full max-w-3xl";
    const scopedCaseLabel =
      caseId && caseId.length > 19 ? `${caseId.slice(0, 18)}…` : caseId;

    const sourcePicker = hasSources ? (
      <Select value={sourceId} onValueChange={setSourceId} disabled={interactionDisabled}>
        <Tooltip>
          <TooltipTrigger asChild>
            <SelectTrigger
              className={cn(
                "h-8 gap-1.5 text-xs",
                (isCaseManager || isWorkspace) && "w-full rounded-sm",
              )}
              aria-label="Source"
              style={
                isCaseManager || isWorkspace ? undefined : { minWidth: 150 }
              }
            >
              <Database className="h-3.5 w-3.5 shrink-0 opacity-70" />
              <SelectValue />
            </SelectTrigger>
          </TooltipTrigger>
          <TooltipContent>Which source the agent queries</TooltipContent>
        </Tooltip>
        <SelectContent>
          <SelectItem value={ALL_SOURCES}>Primary source</SelectItem>
          {queryableSources.map((s) => (
            <SelectItem key={s.id} value={s.id}>
              {/* source label is operator-configured → plain text. */}
              {sourceLabel(s)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ) : null;

    const modelPicker = hasModels ? (
      <Select value={model} onValueChange={setModel} disabled={interactionDisabled}>
        <Tooltip>
          <TooltipTrigger asChild>
            <SelectTrigger
              className={cn(
                "h-8 gap-1.5 text-xs",
                (isCaseManager || isWorkspace) && "w-full rounded-sm",
              )}
              aria-label="Model"
              style={
                isCaseManager || isWorkspace ? undefined : { minWidth: 150 }
              }
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

    const selectedSource = sources.find((source) => source.id === sourceId);
    const activeSourceLabel =
      sourceId === ALL_SOURCES
        ? "Primary source"
        : selectedSource
          ? sourceLabel(selectedSource)
          : sourceId;
    const activeModelLabel = model === DEFAULT_MODEL ? "Default model" : model;

    const updateFollowLatest = () => {
      const el = scrollRef.current;
      if (!el) return;
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      followLatestRef.current = distance <= 80;
      if (followLatestRef.current) setShowJumpToLatest(false);
    };

    const jumpToLatest = () => {
      const el = scrollRef.current;
      if (!el) return;
      followLatestRef.current = true;
      setShowJumpToLatest(false);
      const reduce =
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollTo({ top: el.scrollHeight, behavior: reduce ? "auto" : "smooth" });
    };

    const renderComposer = (mode: "inline" | "docked" = "docked") => {
      const workspaceDocked = isWorkspace && mode === "docked";

      return (
        <div
          data-chat-composer={mode}
          className={cn(
            isWorkspace
              ? workspaceDocked
                ? "shrink-0 border-t border-border bg-background/95 px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3"
                : "mt-6 w-full"
              : cn(
                  "shrink-0 border border-border bg-card focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40",
                  laneInner,
                  isCaseManager
                    ? "mt-2 rounded-sm p-2"
                    : compact
                      ? "mt-3 rounded-lg p-3"
                      : "mt-4 rounded-lg p-3.5",
                ),
          )}
        >
          <div
            className={cn(
              isWorkspace && (workspaceDocked ? laneInner : "w-full"),
            )}
          >
            <div
              className={cn(
                "flex items-end gap-2",
                isWorkspace &&
                  "rounded-sm border border-border bg-card p-2 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40",
              )}
            >
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
                        disabled={interactionDisabled}
                      >
                        <SlidersHorizontal className="h-4 w-4" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent
                      align="start"
                      className="w-72 rounded-sm p-3"
                    >
                      <div className="mb-3 font-mono text-2xs font-semibold uppercase tracking-widest text-muted-foreground">
                        Analyst settings
                      </div>
                      <div className="space-y-2">
                        {sourcePicker}
                        {modelPicker}
                      </div>
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
                onChange={(event) => updateInput(event.target.value)}
                onKeyDown={onKeyDown}
                disabled={interactionDisabled}
                rows={isCaseManager || isWorkspace ? 1 : 2}
                aria-label="Chat message"
                className={cn(
                  "resize-none border-0 bg-transparent shadow-none focus-visible:ring-0",
                  isCaseManager || isWorkspace
                    ? cn(
                        "min-h-10 max-h-28 overflow-y-auto py-2.5 [field-sizing:content]",
                        isCaseManager ? "font-mono text-xs" : "text-sm",
                      )
                    : "min-h-0",
                )}
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size={isCaseManager ? "icon" : "default"}
                    className={cn(
                      "shrink-0 rounded-sm",
                      isCaseManager
                        ? "h-10 w-10"
                        : isWorkspace
                          ? "h-10 px-3 sm:px-4"
                          : "",
                    )}
                    onClick={() => void send()}
                    disabled={!input.trim() || interactionDisabled}
                    aria-label="Send message"
                  >
                    <Send className="h-4 w-4" />
                    {isCaseManager ? null : (
                      <span className={cn(isWorkspace && "hidden sm:inline")}>
                        Send
                      </span>
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {restoring
                    ? "Restoring this conversation…"
                    : restoreError
                      ? "Restore this conversation before sending"
                      : loading
                        ? "Waiting for the agent…"
                        : "Send (Enter)"}
                </TooltipContent>
              </Tooltip>
            </div>

            {isWorkspace ? (
              <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1 text-xs text-muted-foreground">
                <span className="hidden sm:inline">
                  Enter to send · Shift+Enter for a new line
                </span>
                <span className="flex min-w-0 items-center gap-3 truncate">
                  <span className="inline-flex min-w-0 items-center gap-1.5 truncate">
                    <Database className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span className="truncate">{activeSourceLabel}</span>
                  </span>
                  <span className="inline-flex min-w-0 items-center gap-1.5 truncate">
                    <Cpu className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span className="truncate">{activeModelLabel}</span>
                  </span>
                </span>
              </div>
            ) : !isCaseManager ? (
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
              </>
            ) : null}
          </div>
        </div>
      );
    };

    return (
      <TooltipProvider delayDuration={200}>
        <div
          className={cn(
            "flex h-full min-h-0 flex-col",
            isWorkspace && "overflow-hidden bg-background",
            className,
          )}
          data-chat-presentation={
            isCaseManager
              ? "case-manager"
              : isWorkspace
                ? "workspace"
                : undefined
          }
        >
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
                Scoped to:{" "}
                <span className="text-primary">{scopedCaseLabel}</span>
              </span>
              <span className="hidden truncate normal-case tracking-normal sm:block">
                {loading
                  ? "AI Analyst is processing case context…"
                  : "AI Analyst ready with case context."}
              </span>
              <span className={loading ? "text-primary" : "text-success"}>
                Status: {loading ? "Working" : "Ready"}
              </span>
            </div>
          ) : isWorkspace && !caseId ? (
            <div
              className="flex min-h-14 shrink-0 items-center justify-between gap-4 border-b border-border px-4 py-2.5 sm:px-5"
            >
              <div className="min-w-0">
                <h2 className="truncate text-sm font-semibold text-foreground">
                  {workspaceTitle?.trim() || "New conversation"}
                </h2>
                <div className="mt-0.5 truncate text-xs text-muted-foreground">
                  {workspaceSubtitle?.trim() ||
                    (isEmpty
                      ? "Ask about connected telemetry and current posture"
                      : `${transcript.length} messages in this conversation`)}
                </div>
              </div>
              <span
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.5 text-xs",
                  loading ? "text-primary" : "text-success-text",
                )}
                role="status"
                aria-live="polite"
                aria-label={`SOC agent ${loading ? "working" : "ready"}`}
              >
                <span
                  className={cn(
                    "h-2 w-2 rounded-full",
                    loading ? "bg-primary" : "bg-success",
                  )}
                  aria-hidden
                />
                {loading ? "Agent working" : "Agent ready"}
              </span>
            </div>
          ) : caseId ? (
            <div
              className={cn(
                "shrink-0 text-xs text-muted-foreground",
                compact ? "mb-2" : "mb-3",
              )}
            >
              <span className="inline-flex items-center gap-1.5">
                <Link2 className="h-3.5 w-3.5 opacity-70" aria-hidden />
                Scoped to case <InlineCode>{caseId}</InlineCode>
              </span>
            </div>
          ) : null}

          <>
            {/* Transcript is always the single scrolling lane. Workspace empty and
                populated states share one bottom-docked composer, avoiding the old
                vertical jump when the first turn arrived. */}
            <div
              ref={scrollRef}
              onScroll={updateFollowLatest}
              data-chat-scroll-lane="true"
              className={cn(
                "flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden",
                isWorkspace
                  ? "gap-5 px-4 py-5 sm:px-6"
                  : isCaseManager
                    ? "gap-5 px-1 py-4"
                    : compact
                      ? "gap-3 px-1 py-1"
                      : "gap-5 px-1 py-2",
              )}
              data-testid={isWorkspace && isEmpty ? "workspace-chat-empty-workbench" : undefined}
            >
              {isWorkspace && workspaceRetentionNote ? (
                <div
                  className={cn(
                    laneInner,
                    "border-l-2 border-warning px-3 py-1.5 text-xs leading-relaxed text-muted-foreground",
                  )}
                  role="note"
                >
                  {workspaceRetentionNote}
                </div>
              ) : null}
              {restoring && isWorkspace ? (
                <div className={laneInner}>
                  <LoadingState
                    label="Restoring conversation"
                    description="Loading the saved transcript and its evidence."
                    layout="panel"
                    className="min-h-64"
                  />
                </div>
              ) : restoreError && isWorkspace ? (
                <div className={cn(laneInner, "pt-6")}>
                  <Alert>
                    <ShieldAlert className="h-4 w-4" aria-hidden />
                    <AlertTitle>Could not restore this conversation</AlertTitle>
                    <AlertDescription>
                      <span className="block">{restoreError}</span>
                      <span className="mt-3 flex flex-wrap gap-2">
                        {onRetryRestore ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={onRetryRestore}
                          >
                            <RefreshCw className="h-3.5 w-3.5" />
                            Retry
                          </Button>
                        ) : null}
                        {onStartNew ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={onStartNew}
                          >
                            Start new chat
                          </Button>
                        ) : null}
                      </span>
                    </AlertDescription>
                  </Alert>
                </div>
              ) : isEmpty && isWorkspace ? (
                <div className={laneInner}>
                  <WorkspaceReadyState
                    starters={starters}
                    loading={interactionDisabled}
                    onPick={(prompt) => void send(prompt)}
                  />
                </div>
              ) : isEmpty && isCaseManager ? (
                <div className={laneInner}>
                  <AnalystReadyState />
                </div>
              ) : isEmpty ? (
                <div className="m-auto flex min-h-full w-full flex-col items-center justify-center">
                  <EmptyState
                    compact={compact}
                    scoped={!!caseId}
                    starters={starters}
                    loading={loading}
                    onPick={(prompt) => void send(prompt)}
                  />
                </div>
              ) : (
                <div
                  className={cn(
                    "flex flex-col",
                    compact ? "gap-3" : "gap-5",
                    laneInner,
                    isWorkspace && "pb-2",
                  )}
                  role="log"
                  aria-live="polite"
                  aria-relevant="additions text"
                  aria-busy={loading}
                  aria-label="Chat transcript"
                >
                  {transcript.map((item, index) => {
                    const previous = transcript[index - 1];
                    const next = transcript[index + 1];
                    const grouped = !!previous && previous.role === item.role;
                    const showMeta = !next || next.role !== item.role;
                    return (
                      <Bubble
                        key={item.id}
                        item={item}
                        grouped={grouped}
                        showMeta={showMeta}
                        canRegenerate={
                          item.role === "assistant" && !item.isError && !loading
                        }
                        onRegenerate={() => regenerate(item.id)}
                        onRetry={retryFailed}
                        presentation={resolvedPresentation}
                      />
                    );
                  })}
                  {loading ? (
                    <TypingIndicator presentation={resolvedPresentation} />
                  ) : null}
                </div>
              )}
            </div>

            {isCaseManager && starters.length ? (
              <div
                className={cn(
                  "flex min-w-0 shrink-0 flex-nowrap items-center gap-2 overflow-x-auto overscroll-x-contain pb-1",
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

            {isWorkspace && showJumpToLatest ? (
              <div className="pointer-events-none z-10 -mb-1 flex shrink-0 justify-center px-4">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="pointer-events-auto rounded-sm bg-background"
                  onClick={jumpToLatest}
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                  Jump to latest
                </Button>
              </div>
            ) : null}

            {renderComposer("docked")}
          </>
        </div>
      </TooltipProvider>
    );
  },
);
