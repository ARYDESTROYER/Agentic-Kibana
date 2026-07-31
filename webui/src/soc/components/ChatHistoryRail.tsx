import * as React from "react";
import {
  Check,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";

import { cn } from "@/lib/cn";
import { humanizeAge } from "@/lib/format";
import type { ChatConversationSummary } from "@/lib/types";
import { LoadingGlyph } from "@/design-system";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";

interface ChatHistoryRailProps {
  conversations: ChatConversationSummary[];
  activeId?: string | null;
  loading?: boolean;
  error?: string | null;
  autoFocusSearch?: boolean;
  /** Mobile sheets may expose a local New action; desktop keeps one page-level action. */
  showNewAction?: boolean;
  /** Prevent thread changes while a request is being committed to the current thread. */
  disabled?: boolean;
  /** Server-advertised per-user retention ceiling. Omitted keeps the footer quiet. */
  retentionLimit?: number;
  /** True when the server reports that older conversations were evicted. */
  retentionTruncated?: boolean;
  /** Total conversations accepted before bounded retention evicted older rows. */
  retentionTotal?: number;
  onRetry: () => void;
  onNew: () => void;
  onSelect: (conversation: ChatConversationSummary) => void;
  onRename: (conversation: ChatConversationSummary, title: string) => void;
  onDelete: (conversation: ChatConversationSummary) => void;
}

type HistoryGroup = {
  label: "Today" | "Yesterday" | "Previous 7 days" | "Older";
  conversations: ChatConversationSummary[];
};

function groupConversations(
  conversations: ChatConversationSummary[],
): HistoryGroup[] {
  const now = new Date();
  const day = 24 * 60 * 60 * 1000;
  // Compare calendar-day ordinals instead of elapsed local-midnight milliseconds;
  // daylight-saving transitions can make adjacent local days 23 or 25 hours long.
  const localDay = (value: Date) =>
    Math.floor(
      Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()) / day,
    );
  const today = localDay(now);
  const groups: HistoryGroup[] = [
    { label: "Today", conversations: [] },
    { label: "Yesterday", conversations: [] },
    { label: "Previous 7 days", conversations: [] },
    { label: "Older", conversations: [] },
  ];

  for (const conversation of conversations) {
    const updated = Date.parse(conversation.updated_at);
    const updatedDate = Number.isFinite(updated) ? new Date(updated) : null;
    const updatedDay = updatedDate ? localDay(updatedDate) : Number.NEGATIVE_INFINITY;
    const ageInDays = Number.isFinite(updatedDay)
      ? Math.max(0, today - updatedDay)
      : Number.POSITIVE_INFINITY;
    const group =
      ageInDays === 0
        ? groups[0]
        : ageInDays === 1
          ? groups[1]
          : ageInDays < 7
            ? groups[2]
            : groups[3];
    group.conversations.push(conversation);
  }

  return groups.filter((group) => group.conversations.length > 0);
}

export function ChatHistoryRail({
  conversations,
  activeId,
  loading = false,
  error,
  autoFocusSearch = false,
  showNewAction = false,
  disabled = false,
  retentionLimit,
  retentionTruncated = false,
  retentionTotal,
  onRetry,
  onNew,
  onSelect,
  onRename,
  onDelete,
}: ChatHistoryRailProps) {
  const [query, setQuery] = React.useState("");
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [draftTitle, setDraftTitle] = React.useState("");
  const searchRef = React.useRef<HTMLInputElement>(null);
  const renameRef = React.useRef<HTMLInputElement>(null);
  // Desktop and mobile Sheet rails coexist in the DOM. A component-local prefix
  // keeps every aria-labelledby target unique even while the Sheet is open.
  const headingPrefix = `chat-history-${React.useId().replace(/:/g, "")}`;

  React.useEffect(() => {
    if (autoFocusSearch) searchRef.current?.focus();
  }, [autoFocusSearch]);

  React.useEffect(() => {
    if (!editingId) return;
    renameRef.current?.focus();
    renameRef.current?.select();
  }, [editingId]);

  const filtered = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return conversations;
    return conversations.filter((conversation) =>
      `${conversation.title} ${conversation.preview ?? ""}`
        .toLowerCase()
        .includes(needle),
    );
  }, [conversations, query]);
  const groups = React.useMemo(() => groupConversations(filtered), [filtered]);

  const beginRename = (conversation: ChatConversationSummary) => {
    setEditingId(conversation.id);
    setDraftTitle(conversation.title);
  };

  const commitRename = (conversation: ChatConversationSummary) => {
    const title = draftTitle.trim();
    if (title && title !== conversation.title) onRename(conversation, title);
    setEditingId(null);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface/25">
      <div className="shrink-0 border-b border-border px-3 py-3.5">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-sm font-semibold text-foreground">History</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {conversations.length} {conversations.length === 1 ? "conversation" : "conversations"}
            </div>
          </div>
          {showNewAction ? (
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="h-8 w-8 rounded-sm"
              onClick={onNew}
              disabled={disabled}
              aria-label="New conversation"
            >
              <Plus className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
        {conversations.length > 0 || query ? (
          <div className="relative mt-3">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search history"
              aria-label="Search conversations"
              className="h-9 rounded-sm border-border bg-background/80 pl-8 text-sm"
            />
          </div>
        ) : null}
      </div>

      <nav
        className="min-h-0 flex-1 overflow-y-auto px-2 py-2"
        aria-label="Conversation history"
      >
        {loading && conversations.length === 0 ? (
          <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground">
            <LoadingGlyph size="sm" />
            Loading conversations…
          </div>
        ) : null}

        {error ? (
          <div className="mx-1 mb-2 border-l-2 border-critical px-2 py-2 text-xs text-muted-foreground">
            <div>{error}</div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="mt-1 h-7 px-2"
              onClick={onRetry}
            >
              Retry
            </Button>
          </div>
        ) : null}

        {!loading && !error && filtered.length === 0 ? (
          <div className="px-4 py-6 text-left">
            <span className="flex h-8 w-8 items-center justify-center rounded-sm border border-border bg-background text-muted-foreground">
              <MessageSquare className="h-4 w-4" aria-hidden />
            </span>
            <div className="mt-3 text-sm font-medium text-foreground">
              {query ? "No matching conversations" : "No previous conversations"}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {query
                ? "Try a different search."
                : "A conversation appears here after its first response."}
            </div>
          </div>
        ) : null}

        <div className="space-y-4">
          {groups.map((group) => {
            const groupId = `${headingPrefix}-${group.label.toLowerCase().replace(/\s+/g, "-")}`;
            return (
              <section key={group.label} aria-labelledby={groupId}>
                <h2
                  id={groupId}
                  className="px-2 pb-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground"
                >
                  {group.label}
                </h2>
                <div className="space-y-0.5">
                  {group.conversations.map((conversation) => {
                  const active = activeId === conversation.id;
                  const editing = editingId === conversation.id;
                  return (
                    <div
                      key={conversation.id}
                      className={cn(
                        "group relative min-h-[4.5rem] border-l-2 border-transparent",
                        active && "border-l-primary bg-accent/55",
                      )}
                    >
                      {editing ? (
                        <div className="flex min-h-14 items-center gap-1 px-2 py-2">
                          <Input
                            ref={renameRef}
                            value={draftTitle}
                            onChange={(event) => setDraftTitle(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.nativeEvent.isComposing) return;
                              if (event.key === "Enter") commitRename(conversation);
                              if (event.key === "Escape") setEditingId(null);
                            }}
                            className="h-8 rounded-sm text-xs"
                            aria-label={`Rename ${conversation.title}`}
                          />
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8 shrink-0 rounded-sm"
                            onClick={() => commitRename(conversation)}
                            aria-label="Save conversation name"
                          >
                            <Check className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8 shrink-0 rounded-sm"
                            onClick={() => setEditingId(null)}
                            aria-label="Cancel rename"
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="block min-h-[4.5rem] w-full min-w-0 px-2.5 py-2.5 pr-9 text-left outline-none transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
                            aria-current={active ? "page" : undefined}
                            aria-label={`${conversation.title || "Untitled conversation"} — ${humanizeAge(conversation.updated_at)} · ${conversation.message_count} ${conversation.message_count === 1 ? "message" : "messages"}`}
                            title={conversation.title}
                            disabled={disabled}
                            onClick={() => onSelect(conversation)}
                          >
                            <span className="block truncate text-sm font-medium text-foreground">
                              {conversation.title || "Untitled conversation"}
                            </span>
                            {conversation.preview?.trim() ? (
                              <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                                {conversation.preview}
                              </span>
                            ) : null}
                            <span className="mt-1 block truncate text-2xs text-muted-foreground/80">
                              {humanizeAge(conversation.updated_at)} · {conversation.message_count}{" "}
                              {conversation.message_count === 1 ? "message" : "messages"}
                            </span>
                          </button>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                className={cn(
                                  "absolute right-1 top-2 h-8 w-8 rounded-sm opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100",
                                  active && "opacity-100",
                                )}
                                aria-label={`Actions for ${conversation.title}`}
                                disabled={disabled}
                              >
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-40 rounded-sm">
                              <DropdownMenuItem onSelect={() => beginRename(conversation)}>
                                <Pencil />
                                Rename
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="text-critical-text focus:text-critical-text"
                                onSelect={() => onDelete(conversation)}
                              >
                                <Trash2 />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </>
                      )}
                    </div>
                  );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      </nav>
      {retentionLimit && retentionLimit > 0 ? (
        <div
          className="shrink-0 border-t border-border px-3 py-2 text-2xs leading-relaxed text-muted-foreground"
          role="note"
        >
          {retentionTruncated
            ? `Showing the latest ${conversations.length}${
                typeof retentionTotal === "number" &&
                retentionTotal > conversations.length
                  ? ` of ${retentionTotal}`
                  : ""
              } conversations. Older history was removed by retention.`
            : `Workspace keeps up to ${retentionLimit} conversations.`}
        </div>
      ) : null}
    </div>
  );
}
