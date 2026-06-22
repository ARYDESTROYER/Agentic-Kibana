import type { CoreStart } from '@kbn/core/public';
import type { DataPublicPluginStart } from '@kbn/data-plugin/public';
import type { DataViewsPublicPluginStart } from '@kbn/data-views-plugin/public';
import type { ChatContext } from '../../common';

interface CollectArgs {
  core: CoreStart;
  data: DataPublicPluginStart;
  dataViews: DataViewsPublicPluginStart;
  /** Latest known app id (from a `currentAppId$` subscription held by the caller). */
  currentAppId?: string;
}

/**
 * Best-effort snapshot of the surface the analyst is looking at, taken AT SEND
 * TIME (call inside the send path, not on mount). EVERY source is wrapped in its
 * own try/catch so a single failing API never breaks the chat send.
 *
 * SECURITY: the collected `query` and `selection` are attacker-influenceable log
 * data — they are placed into the request body ONLY and are NEVER rendered as
 * anything but plain data. The backend fences them as untrusted (#9).
 */
export async function collectScreenContext({
  core,
  data,
  dataViews,
  currentAppId,
}: CollectArgs): Promise<ChatContext> {
  const ctx: ChatContext = {};

  // App id — prefer the latest from the caller's subscription.
  try {
    if (currentAppId) {
      ctx.app = currentAppId;
    }
  } catch {
    /* ignore */
  }

  try {
    ctx.url = window.location.href;
  } catch {
    /* ignore */
  }

  try {
    const sel = window.getSelection()?.toString();
    if (sel) {
      ctx.selection = sel.slice(0, 2000);
    }
  } catch {
    /* ignore */
  }

  // The Discover-specific signals are only meaningful when we are on Discover.
  if (ctx.app === 'discover') {
    try {
      const q = data.query.queryString.getQuery() as { query?: unknown; language?: string };
      if (q && typeof q === 'object') {
        if (typeof q.query === 'string') {
          ctx.query = q.query;
        } else if (q.query != null) {
          ctx.query = JSON.stringify(q.query);
        }
        if (q.language) {
          ctx.language = q.language;
        }
      }
    } catch {
      /* ignore */
    }

    try {
      const t = data.query.timefilter.timefilter.getTime();
      if (t) {
        ctx.time_range = { from: t.from, to: t.to };
      }
    } catch {
      /* ignore */
    }

    try {
      const sid = data.search.session.getSessionId?.();
      if (sid) {
        ctx.search_session = sid;
      }
    } catch {
      /* ignore */
    }

    // Best-effort data-view title: use the default data view's title.
    try {
      const def = await dataViews.getDefaultDataView();
      if (def?.title) {
        ctx.data_view = def.title;
      }
    } catch {
      /* ignore */
    }
  }

  // Keep `core` referenced for future signals (notifications/space) and to keep
  // the signature stable; intentionally not used for any value above.
  void core;

  return ctx;
}
