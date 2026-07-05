/**
 * Inbox — the operator's in-app NOTIFICATION CENTER (Group 6 / Feature 8 / Round 3).
 *
 * A full page (route id `inbox`) over the per-user inbox served by
 * `backend/app/api/routes_inapp.py`. It is SELF-SCOPED server-side — a user only ever
 * sees their own inbox. Capabilities:
 *
 *   - a list of notifications, NEWEST first, with an "Unread only" filter + paging,
 *   - per-item mark-read + dismiss, plus mark-ALL-read and a per-category grouping
 *     toggle (group by category vs. a flat chronological feed),
 *   - a deep-link to the referenced case (in-app navigate, never the backend `url`),
 *   - a slide-over with the per-user NotificationPrefs (delivery routing matrix).
 *
 * Security: every `title`/`body`/`category` is UNTRUSTED, render-escaped plain data
 * (#9) — rendered as PLAIN TEXT, never markup, and the backend-supplied `url` is
 * NEVER used as an href (we route via the in-app `case_id`). No secrets (#10). The
 * inbox is advisory — it never feeds `decide()` (#3).
 */
import * as React from 'react';
import {
  ArrowRight,
  Bell,
  BellOff,
  CheckCheck,
  Inbox as InboxIcon,
  RefreshCw,
  Settings2,
  Trash2,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';

import { useNavigateOptional, type Navigate } from '@/soc/router';
import { humanizeAge, humanizeToken } from '@/lib/format';
import { errorMessage } from '@/lib/errorMessage';
import { cn } from '@/lib/cn';
import {
  inboxApi,
  CATEGORY_META,
  NOTIFICATION_CATEGORIES,
  type InboxItem,
} from '@/soc/pages/Inbox.api';

import { PageHeader } from '@/soc/components/PageHeader';
import { PageContainer } from '@/soc/components/PageContainer';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { SegmentedControl } from '@/soc/components/SegmentedControl';

import { Button } from '@/ui/button';
import { Badge, type BadgeProps } from '@/ui/badge';
import { Card, CardContent } from '@/ui/card';
import { Skeleton } from '@/ui/skeleton';
import { Separator } from '@/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/ui/sheet';

import { NotificationPrefs } from '@/soc/components/NotificationPrefs';

/* ---------------------------------------------------------------- constants - */

const PAGE_SIZE = 50;

type GroupMode = 'category' | 'feed';

/* ----------------------------------------------------------------- helpers -- */

function isUnread(item: InboxItem): boolean {
  return item.state === 'unseen' || item.state === 'seen';
}

/** Friendly label for a category (known → curated; unknown → humanised token). */
function categoryLabel(cat: string): string {
  return CATEGORY_META[cat]?.label ?? humanizeToken(cat);
}

/** A semantic badge variant for one severity (UNTRUSTED → mapped, never raw class). */
function severityVariant(sev?: string | null): BadgeProps['variant'] {
  switch ((sev || '').toLowerCase()) {
    case 'critical':
      return 'critical';
    case 'high':
      return 'high';
    case 'medium':
    case 'moderate':
      return 'medium';
    case 'low':
      return 'low';
    case 'info':
    case 'informational':
      return 'info';
    default:
      return 'secondary';
  }
}

/** A category → badge variant (stable, calm; falls back to outline). */
function categoryVariant(cat: string): BadgeProps['variant'] {
  switch (cat) {
    case 'case_escalated':
      return 'high';
    case 'case_resolved':
      return 'success';
    case 'approval':
      return 'warning';
    case 'mention':
    case 'assignment':
      return 'info';
    default:
      return 'secondary';
  }
}

/* ------------------------------------------------------------- item row ----- */

const InboxRow: React.FC<{
  item: InboxItem;
  busy: boolean;
  onMarkRead: (item: InboxItem) => void;
  onDismiss: (item: InboxItem) => void;
  onOpenCase: (caseId: string) => void;
}> = ({ item, busy, onMarkRead, onDismiss, onOpenCase }) => {
  const unread = isUnread(item);
  return (
    <li
      className={cn(
        'flex items-start gap-3 px-4 py-3.5 transition-colors',
        unread ? 'bg-primary/[0.04]' : 'bg-transparent',
      )}
    >
      {/* unread dot */}
      <span className="mt-1.5 flex w-2 shrink-0 justify-center" aria-hidden>
        {unread ? <span className="size-2 rounded-full bg-primary" /> : null}
      </span>

      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={categoryVariant(item.category)}>{categoryLabel(item.category)}</Badge>
          {item.severity ? (
            <Badge variant={severityVariant(item.severity)}>
              {/* UNTRUSTED severity → humanised plain text */}
              {humanizeToken(item.severity)}
            </Badge>
          ) : null}
          {unread ? (
            <span className="text-2xs font-semibold uppercase tracking-wide text-primary">
              New
            </span>
          ) : null}
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            {humanizeAge(item.created_at)}
          </span>
        </div>

        {/* UNTRUSTED title/body → PLAIN TEXT, never markup (#9) */}
        <p
          className={cn(
            'break-words text-sm',
            unread ? 'font-semibold text-foreground' : 'font-medium text-foreground',
          )}
        >
          {item.title || '(no title)'}
        </p>
        {item.body ? (
          <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
            {item.body}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          {item.case_id ? (
            <Button
              variant="outline"
              size="sm"
              className="h-7"
              onClick={() => onOpenCase(item.case_id as string)}
            >
              Open case
              <ArrowRight className="size-3.5" aria-hidden />
            </Button>
          ) : null}
          {unread ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7"
              disabled={busy}
              onClick={() => onMarkRead(item)}
            >
              <CheckCheck className="size-3.5" aria-hidden />
              Mark read
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-muted-foreground hover:text-critical"
            disabled={busy}
            onClick={() => onDismiss(item)}
          >
            <Trash2 className="size-3.5" aria-hidden />
            Dismiss
          </Button>
        </div>
      </div>
    </li>
  );
};

/* ------------------------------------------------------------- group block -- */

const GroupBlock: React.FC<{
  icon: LucideIcon;
  label: string;
  count: number;
  unread: number;
  children: React.ReactNode;
}> = ({ icon: Icon, label, count, unread, children }) => (
  <div className="space-y-2">
    <div className="flex items-center gap-2 px-1">
      <Icon className="size-4 text-muted-foreground" aria-hidden />
      <h2 className="text-sm font-semibold tracking-tight text-foreground">{label}</h2>
      <Badge variant="outline">{count}</Badge>
      {unread > 0 ? <Badge variant="info">{unread} unread</Badge> : null}
    </div>
    <Card>
      <CardContent className="p-0">
        <ul className="divide-y divide-border">{children}</ul>
      </CardContent>
    </Card>
  </div>
);

/* -------------------------------------------------------------------- page -- */

export interface InboxProps {
  onNavigate?: Navigate;
}

export default function Inbox({ onNavigate }: InboxProps = {}) {
  // Coupling-A: prop wins (test); else resolve navigate from the router context.
  // Call the hook UNCONDITIONALLY (rules-of-hooks), then let an explicit prop win.
  const contextNavigate = useNavigateOptional();
  const navigate = onNavigate ?? contextNavigate;
  const [items, setItems] = React.useState<InboxItem[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);

  const [unreadOnly, setUnreadOnly] = React.useState(false);
  const [groupMode, setGroupMode] = React.useState<GroupMode>('feed');
  const [prefsOpen, setPrefsOpen] = React.useState(false);
  // ids with an in-flight per-row action (mark-read / dismiss) — disables their buttons.
  const [busyIds, setBusyIds] = React.useState<Set<string>>(() => new Set());

  // Monotonic request id + mounted flag: only the newest in-flight `load` may write
  // state, so a slow earlier response (e.g. after a fast Unread↔All toggle) — or a
  // resolve after unmount — can never clobber the current view with stale items.
  const seqRef = React.useRef(0);
  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = React.useCallback(
    async (opts?: { unread?: boolean }) => {
      const unread = opts?.unread ?? unreadOnly;
      const seq = ++seqRef.current;
      setLoading(true);
      setError(null);
      try {
        const res = await inboxApi.list({ unread_only: unread, limit: PAGE_SIZE, offset: 0 });
        if (!mountedRef.current || seq !== seqRef.current) return; // superseded / unmounted
        setItems(res.items ?? []);
        setTotal(res.total ?? (res.items?.length ?? 0));
      } catch (e) {
        if (!mountedRef.current || seq !== seqRef.current) return;
        setError(e);
      } finally {
        if (mountedRef.current && seq === seqRef.current) setLoading(false);
      }
    },
    [unreadOnly],
  );

  React.useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setUnreadFilter = React.useCallback(
    (next: boolean) => {
      setUnreadOnly(next);
      void load({ unread: next });
    },
    [load],
  );

  const loadMore = React.useCallback(async () => {
    setLoadingMore(true);
    try {
      const res = await inboxApi.list({
        unread_only: unreadOnly,
        limit: PAGE_SIZE,
        offset: items.length,
      });
      setItems((prev) => [...prev, ...(res.items ?? [])]);
      setTotal(res.total ?? total);
    } catch (e) {
      toast.error(errorMessage(e, 'Could not load more.'));
    } finally {
      setLoadingMore(false);
    }
  }, [items.length, unreadOnly, total]);

  const withBusy = React.useCallback(async (id: string, fn: () => Promise<void>) => {
    setBusyIds((prev) => new Set(prev).add(id));
    try {
      await fn();
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, []);

  const markRead = React.useCallback(
    (item: InboxItem) =>
      withBusy(item.id, async () => {
        try {
          const res = await inboxApi.markRead(item.id);
          if (!res.ok) {
            toast.error(res.detail || 'Could not mark read.');
            return;
          }
          // In the unread-only view a read item drops out; otherwise it stays + dims.
          setItems((prev) =>
            unreadOnly
              ? prev.filter((n) => n.id !== item.id)
              : prev.map((n) => (n.id === item.id ? { ...n, state: 'read' } : n)),
          );
          if (unreadOnly) setTotal((t) => Math.max(0, t - 1));
        } catch (e) {
          toast.error(errorMessage(e, 'Could not mark read.'));
        }
      }),
    [unreadOnly, withBusy],
  );

  const dismiss = React.useCallback(
    (item: InboxItem) =>
      withBusy(item.id, async () => {
        try {
          const res = await inboxApi.dismiss(item.id);
          if (!res.ok) {
            toast.error('Could not dismiss.');
            return;
          }
          setItems((prev) => prev.filter((n) => n.id !== item.id));
          setTotal((t) => Math.max(0, t - 1));
        } catch (e) {
          toast.error(errorMessage(e, 'Could not dismiss.'));
        }
      }),
    [withBusy],
  );

  const markAllRead = React.useCallback(async () => {
    try {
      const res = await inboxApi.markAllRead();
      toast.success(
        res.marked > 0
          ? `Marked ${res.marked} notification${res.marked === 1 ? '' : 's'} read.`
          : 'Nothing to mark.',
      );
      // Reflect locally without a full reload (drop in unread-only; dim otherwise).
      setItems((prev) =>
        unreadOnly ? [] : prev.map((n) => (isUnread(n) ? { ...n, state: 'read' } : n)),
      );
      if (unreadOnly) setTotal(0);
    } catch (e) {
      toast.error(errorMessage(e, 'Could not mark all read.'));
    }
  }, [unreadOnly]);

  const openCase = React.useCallback(
    (caseId: string) => {
      navigate('cases', { caseId });
    },
    [navigate],
  );

  /* ---- derived counts + grouping ---- */
  const unreadCount = React.useMemo(() => items.filter(isUnread).length, [items]);
  const hasMore = items.length < total;

  // If clearing (dismiss / mark-read) empties the loaded page while the server still
  // has more, pull the next page instead of falsely showing "your inbox is empty".
  // `autoLoadedRef` guards against a refetch loop if the server ever reports more
  // (`total`) but returns an empty page — we auto-load once, then wait for real items.
  const autoLoadedRef = React.useRef(false);
  React.useEffect(() => {
    if (loading || loadingMore) return;
    if (items.length === 0 && hasMore && !autoLoadedRef.current) {
      autoLoadedRef.current = true;
      void load();
    } else if (items.length > 0) {
      autoLoadedRef.current = false;
    }
  }, [loading, loadingMore, items.length, hasMore, load]);

  const grouped = React.useMemo(() => {
    const byCat = new Map<string, InboxItem[]>();
    for (const it of items) {
      const arr = byCat.get(it.category) ?? [];
      arr.push(it);
      byCat.set(it.category, arr);
    }
    // Deterministic order: known categories first (catalog order), then any extras.
    const order = [
      ...NOTIFICATION_CATEGORIES.filter((c) => byCat.has(c)),
      ...Array.from(byCat.keys()).filter((c) => !NOTIFICATION_CATEGORIES.includes(c)),
    ];
    return order.map((cat) => ({ cat, items: byCat.get(cat) ?? [] }));
  }, [items]);

  const actions = (
    <>
      {/* group toggle */}
      <SegmentedControl<GroupMode>
        aria-label="Group inbox"
        size="sm"
        value={groupMode}
        onValueChange={setGroupMode}
        options={[
          { value: 'feed', label: 'Feed' },
          { value: 'category', label: 'By category' },
        ]}
      />
      <Button
        variant="outline"
        size="sm"
        onClick={() => setUnreadFilter(!unreadOnly)}
        aria-pressed={unreadOnly}
      >
        {unreadOnly ? (
          <Bell className="size-4" aria-hidden />
        ) : (
          <BellOff className="size-4" aria-hidden />
        )}
        {unreadOnly ? 'Unread only' : 'All'}
      </Button>
      <Button variant="outline" size="sm" onClick={() => void markAllRead()} disabled={total === 0}>
        <CheckCheck className="size-4" aria-hidden />
        Mark all read
      </Button>
      <Button variant="outline" size="sm" onClick={() => setPrefsOpen(true)}>
        <Settings2 className="size-4" aria-hidden />
        Preferences
      </Button>
      <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
        <RefreshCw className={cn('size-4', loading && 'animate-spin')} aria-hidden />
        Refresh
      </Button>
    </>
  );

  return (
    <PageContainer variant="wide" className="space-y-6">
      <PageHeader
        icon={InboxIcon}
        eyebrow="Notifications"
        title="Inbox"
        description="Your in-app notification center — case events, mentions, assignments and approvals. Everything is recorded here; configure extra delivery channels under Preferences."
        actions={actions}
      />

      {error ? (
        <LoadError
          error={error}
          title="Could not load your inbox"
          fallback="Request failed."
          onRetry={() => void load()}
        />
      ) : null}

      {/* Full skeleton only on the FIRST load (no items yet). Refresh / filter-toggle
          reloads keep the current list on screen (stale-while-revalidate) with the
          Refresh button's own spinner signalling the in-flight fetch. */}
      {loading && items.length === 0 ? (
        <Card>
          <CardContent className="space-y-3 p-4">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </CardContent>
        </Card>
      ) : items.length === 0 && !hasMore ? (
        <Card>
          <EmptyState
            icon={InboxIcon}
            title={unreadOnly ? 'No unread notifications' : 'Your inbox is empty'}
            description={
              unreadOnly
                ? 'You are all caught up. Switch to All to see read notifications.'
                : 'Notifications about cases, mentions, assignments and approvals will appear here.'
            }
            action={
              unreadOnly ? (
                <Button variant="outline" size="sm" onClick={() => setUnreadFilter(false)}>
                  <X className="size-4" aria-hidden />
                  Show all
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : items.length === 0 ? (
        // Page cleared but more exist server-side — the effect above is fetching them.
        <Card>
          <CardContent className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
            <RefreshCw className="size-4 animate-spin" aria-hidden />
            Loading more…
          </CardContent>
        </Card>
      ) : groupMode === 'category' ? (
        <div className="space-y-6">
          {grouped.map(({ cat, items: groupItems }) => (
            <GroupBlock
              key={cat}
              icon={Bell}
              label={categoryLabel(cat)}
              count={groupItems.length}
              unread={groupItems.filter(isUnread).length}
            >
              {groupItems.map((item) => (
                <InboxRow
                  key={item.id}
                  item={item}
                  busy={busyIds.has(item.id)}
                  onMarkRead={markRead}
                  onDismiss={dismiss}
                  onOpenCase={openCase}
                />
              ))}
            </GroupBlock>
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y divide-border">
              {items.map((item) => (
                <InboxRow
                  key={item.id}
                  item={item}
                  busy={busyIds.has(item.id)}
                  onMarkRead={markRead}
                  onDismiss={dismiss}
                  onOpenCase={openCase}
                />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* paging + footer counts */}
      {!loading && items.length > 0 ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            Showing {items.length} of {total} · {unreadCount} unread on this page
          </p>
          {hasMore ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void loadMore()}
              disabled={loadingMore}
            >
              {loadingMore ? (
                <RefreshCw className="size-4 animate-spin" aria-hidden />
              ) : null}
              Load more
            </Button>
          ) : null}
        </div>
      ) : null}

      <Separator />
      <div className="flex items-start gap-2 text-xs text-muted-foreground">
        <Bell className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <p>
          Notification text is recorded as plain, escaped data and is never executed as
          markup. The inbox is advisory — it never changes a case decision.
        </p>
      </div>

      {/* preferences slide-over */}
      <Sheet open={prefsOpen} onOpenChange={setPrefsOpen}>
        {/* Header (with the built-in close X) stays pinned; only the inner body
            scrolls — never overflow-y-auto on SheetContent itself or the absolute X
            scrolls away (#19). */}
        <SheetContent side="right" size="lg" className="flex flex-col">
          <SheetHeader>
            <SheetTitle>Notification preferences</SheetTitle>
            <SheetDescription>
              Choose how each kind of notification reaches you across channels.
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
            <NotificationPrefs />
          </div>
        </SheetContent>
      </Sheet>
    </PageContainer>
  );
}
