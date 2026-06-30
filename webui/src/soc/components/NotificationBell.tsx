/**
 * NotificationBell — the top-bar in-app notification indicator (Round-3 Stage 2).
 *
 * A self-contained bell button that:
 *   - polls GET /api/notifications/inbox/unread-count on an interval and shows a
 *     dot + numeric unread badge (capped "9+") when there are unseen items;
 *   - opens a Radix Popover dropdown listing the most recent inbox items
 *     (GET /api/notifications/inbox), each rendered as PLAIN text;
 *   - offers "Mark all read" (POST …/read-all) and a "View all" link that routes to
 *     the in-app Inbox page (PageId 'inbox') — NOT to any item's source-controlled
 *     `url` (#9: never follow attacker-influenceable hrefs).
 *
 * SECURITY (#9): item `title`/`body`/`category`/`severity` originate from
 * cases/sources/operator text and are UNTRUSTED — they are rendered as plain text,
 * never as markup, and no value is ever placed in an `href`/`src`.
 *
 * ACCESSIBILITY: the trigger is a labelled button announcing the unread count via
 * `aria-label`; the badge is `aria-hidden` (the label carries the count). The poll
 * pauses on `document.hidden` to avoid background churn.
 *
 * SSE seam (Wave 4): polling is isolated in `useUnreadCount`; swap the interval for
 * an EventSource there without touching the render.
 */
import * as React from 'react';
import { Bell, CheckCheck, Inbox as InboxIcon, AlertTriangle } from 'lucide-react';
import { Button } from '@/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { ScrollArea } from '@/ui/scroll-area';
import { Separator } from '@/ui/separator';
import { cn } from '@/lib/cn';
import { humanizeAge } from '@/lib/format';
import { ApiError } from '@/lib/api';
import type { Navigate } from '../router';
import {
  fetchInbox,
  fetchUnreadCount,
  markAllRead,
  type InboxItem,
} from './NotificationBell.api';

/** Poll cadence for the unread count (ms). The dropdown refetches on open. */
const POLL_MS = 30000;
/** How many recent items the dropdown shows. */
const RECENT_LIMIT = 8;

/**
 * Poll the unread count. Pauses while the tab is hidden; refetches immediately when
 * it becomes visible again. A 401/auth-off backend simply yields 0 (the bell stays
 * quiet) — never throws into the shell.
 */
function useUnreadCount(): { unread: number; refresh: () => void } {
  const [unread, setUnread] = React.useState(0);
  const refresh = React.useCallback(() => {
    void fetchUnreadCount()
      .then((r) => setUnread(Math.max(0, r.unread | 0)))
      .catch((e) => {
        // A lapsed/disabled inbox or auth bounce → stay quiet, don't surface.
        if (e instanceof ApiError) setUnread(0);
      });
  }, []);

  React.useEffect(() => {
    let alive = true;
    const tick = () => {
      if (!alive || (typeof document !== 'undefined' && document.hidden)) return;
      refresh();
    };
    tick();
    const t = window.setInterval(tick, POLL_MS);
    const onVis = () => {
      if (typeof document !== 'undefined' && !document.hidden) tick();
    };
    document.addEventListener?.('visibilitychange', onVis);
    return () => {
      alive = false;
      window.clearInterval(t);
      document.removeEventListener?.('visibilitychange', onVis);
    };
  }, [refresh]);

  return { unread, refresh };
}

/** Compact "9+" formatting for the numeric badge. */
function badgeText(n: number): string {
  if (n <= 0) return '';
  return n > 9 ? '9+' : String(n);
}

/** Map a severity token → a calm dot colour class (UNTRUSTED token, enum-matched). */
function severityDot(sev?: string | null): string {
  switch ((sev || '').toLowerCase()) {
    case 'critical':
      return 'bg-critical';
    case 'high':
      return 'bg-warning';
    case 'medium':
      return 'bg-primary';
    default:
      return 'bg-muted-foreground/50';
  }
}

/** One row in the bell dropdown. All text is UNTRUSTED → rendered PLAIN. */
const InboxRow: React.FC<{ item: InboxItem }> = ({ item }) => {
  const unread = item.state === 'unseen' || item.state === 'seen';
  return (
    <li
      className={cn(
        'flex gap-2.5 rounded-md px-2 py-2 text-sm',
        unread ? 'bg-primary/[0.04]' : '',
      )}
    >
      <span
        className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', severityDot(item.severity))}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-start justify-between gap-2">
          {/* UNTRUSTED title → plain text. */}
          <span className={cn('min-w-0 break-words', unread ? 'font-medium' : '')}>
            {item.title || 'Notification'}
          </span>
          <span className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground">
            {humanizeAge(item.created_at)}
          </span>
        </span>
        {/* UNTRUSTED body → plain text, clamped. */}
        {item.body ? (
          <span className="mt-0.5 line-clamp-2 break-words text-xs text-muted-foreground">
            {item.body}
          </span>
        ) : null}
      </span>
    </li>
  );
};

export interface NotificationBellProps {
  /** Navigate to a page (the bell routes to the Inbox page id). */
  onNavigate: Navigate;
  className?: string;
}

/**
 * The mounted-once top-bar bell. Owns its own poll + dropdown state. Safe when auth
 * is off / the inbox is unavailable: it shows a clean, empty, quiet bell.
 */
export function NotificationBell({ onNavigate, className }: NotificationBellProps) {
  const { unread, refresh } = useUnreadCount();
  const [open, setOpen] = React.useState(false);
  const [items, setItems] = React.useState<InboxItem[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  // Load the recent window each time the dropdown opens.
  React.useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    setLoading(true);
    setFailed(false);
    void fetchInbox(RECENT_LIMIT)
      .then((r) => {
        if (!alive) return;
        setItems(Array.isArray(r.items) ? r.items : []);
      })
      .catch(() => {
        if (alive) setFailed(true);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open]);

  const onMarkAll = React.useCallback(() => {
    // Optimistic: clear the unread styling immediately, then persist + re-sync.
    setItems((prev) => prev.map((i) => ({ ...i, state: 'read' as const })));
    void markAllRead()
      .catch(() => undefined)
      .finally(() => refresh());
  }, [refresh]);

  const goInbox = React.useCallback(() => {
    setOpen(false);
    onNavigate('inbox');
  }, [onNavigate]);

  const badge = badgeText(unread);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn('relative h-8 w-8', className)}
          aria-label={
            unread > 0 ? `Notifications, ${unread} unread` : 'Notifications, none unread'
          }
        >
          <Bell className="h-4 w-4" aria-hidden />
          {unread > 0 ? (
            <span
              className={cn(
                'absolute -right-0.5 -top-0.5 flex min-w-[15px] items-center justify-center rounded-full',
                'border border-surface bg-critical px-[3px] text-[9px] font-semibold leading-none text-white',
                'h-[15px]',
              )}
              aria-hidden
            >
              {badge}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0" sideOffset={8}>
        <div className="flex items-center justify-between gap-2 px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <Bell className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            Notifications
          </p>
          <button
            type="button"
            onClick={onMarkAll}
            disabled={unread === 0}
            className={cn(
              'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground',
              'transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              'disabled:pointer-events-none disabled:opacity-40',
            )}
          >
            <CheckCheck className="h-3.5 w-3.5" aria-hidden />
            Mark all read
          </button>
        </div>
        <Separator />

        <ScrollArea className="max-h-80">
          <div className="p-1.5">
            {loading ? (
              <p className="px-2 py-6 text-center text-xs text-muted-foreground">Loading…</p>
            ) : failed ? (
              <p className="flex items-center justify-center gap-1.5 px-2 py-6 text-center text-xs text-muted-foreground">
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                Couldn’t load notifications
              </p>
            ) : items.length === 0 ? (
              <div className="flex flex-col items-center gap-1.5 px-2 py-8 text-center">
                <InboxIcon className="h-6 w-6 text-muted-foreground/60" aria-hidden />
                <p className="text-xs text-muted-foreground">You’re all caught up</p>
              </div>
            ) : (
              <ul className="space-y-0.5">
                {items.map((item) => (
                  <InboxRow key={item.id} item={item} />
                ))}
              </ul>
            )}
          </div>
        </ScrollArea>

        <Separator />
        <button
          type="button"
          onClick={goInbox}
          className={cn(
            'flex w-full items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-primary',
            'transition-colors hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            'rounded-b-lg',
          )}
        >
          <InboxIcon className="h-3.5 w-3.5" aria-hidden />
          View all notifications
        </button>
      </PopoverContent>
    </Popover>
  );
}

export default NotificationBell;
