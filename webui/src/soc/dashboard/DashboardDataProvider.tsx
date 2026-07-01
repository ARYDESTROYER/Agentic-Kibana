/**
 * `DashboardDataProvider` (Round 5 / G7 CD2) — the ONE fetch context for a custom
 * dashboard.
 *
 * WHY: a dashboard renders N widgets, but most widgets read from a SMALL set of
 * shared server rollups (`/api/metrics`, `/api/metrics/posture`, `/api/sources/health`,
 * `/api/cases`, `/api/standup`). If every widget fetched its own copy we'd fan out to
 * dozens of duplicate round-trips on every load/refresh. This provider fetches each
 * underlying source EXACTLY ONCE per (window × refresh) and hands the shared result to
 * every widget through context. The acceptance bar (CD2): read-only default = one
 * provider fetch, no per-widget round-trips.
 *
 * DESIGN:
 *   - Sources are declared in {@link DASHBOARD_SOURCES}. Each has a stable `key`, a
 *     `fetch(ctx)` thunk, and the roll-up window it reads. The provider loads ALL of
 *     them in a single `Promise.allSettled` so one failing source never blocks the
 *     others (#11 breadth-degrades-gracefully).
 *   - A widget declares which sources it needs (`WidgetDef.sources`); the registry can
 *     use that to pre-warm, but at runtime a widget just calls
 *     {@link useDashboardSource}('metrics') and gets `{loading,error,data}`.
 *   - SENTINELS (#): server rollups return honest "unavailable" markers — a
 *     posture `StatBlock` has `available:false` and its numeric fields carry the DASH
 *     string ("—"). Widgets must NEVER print DASH where a number is expected. The
 *     helpers {@link statNumber}/{@link isAvailable} make that check explicit so a
 *     widget renders an EmptyState instead of a bogus "—" masquerading as a value.
 *
 * SECURITY: this provider only READS. It never writes a case, never bills an LLM, and
 * the layout it serves NEVER feeds `case_manager.decide()` (#3 — dashboards are
 * advisory presentation). Every label/title it forwards is plain data (#9); rendering
 * escaping is the widget's job.
 */
import * as React from 'react';

import { api } from '@/lib/api';
import { DASH } from '@/lib/format';
import type { Metrics, StandupResponse, CasesResponse } from '@/lib/types';
import {
  fetchPosture,
  fetchMitreCoverage,
  type PostureResponse,
  type MitreCoverageResponse,
  type StatBlock,
} from '@/soc/pages/Metrics.posture.api';

// --------------------------------------------------------------------------- //
// Source keys + payload types
// --------------------------------------------------------------------------- //

/** A per-source health row from `GET /api/sources/health` (never carries secrets). */
export interface SourceHealthRow {
  source_id: string;
  source_name: string;
  source_type: string;
  enabled: boolean;
  is_primary: boolean;
  ingest_mode: string;
  kind: 'push' | 'pull' | 'unknown' | string;
  can_browse: boolean;
  buffer_depth: number;
  last_poll_millis: number;
  [key: string]: unknown;
}

export interface SourcesHealthResponse {
  sources: SourceHealthRow[];
}

/**
 * The set of shared data sources a dashboard can draw from. Each key maps to one
 * server round-trip that is fetched ONCE and shared across every widget.
 */
export type DashboardSourceKey =
  | 'metrics'
  | 'posture'
  | 'mitre'
  | 'sourcesHealth'
  | 'cases'
  | 'standup';

/** Discriminated payload shape per source key (widgets narrow on the key). */
export interface DashboardSourcePayloads {
  metrics: Metrics;
  posture: PostureResponse;
  mitre: MitreCoverageResponse;
  sourcesHealth: SourcesHealthResponse;
  cases: CasesResponse;
  standup: StandupResponse;
}

/** Fetch context handed to each source thunk (the active window, cases page size). */
export interface DashboardFetchContext {
  /** The active roll-up window in hours (drives every windowed rollup). */
  windowHours: number;
  /** How many recent cases the `cases` source pulls (bounded; table widgets read it). */
  caseLimit: number;
}

/** One declared source: a stable key + a fetch thunk. */
interface DashboardSourceDef<K extends DashboardSourceKey = DashboardSourceKey> {
  key: K;
  fetch: (ctx: DashboardFetchContext) => Promise<DashboardSourcePayloads[K]>;
}

// The declarative source table. Adding a widget that needs a NEW server rollup means
// adding ONE entry here (fetched once, shared) — never a per-widget fetch.
const DASHBOARD_SOURCES: {
  [K in DashboardSourceKey]: DashboardSourceDef<K>;
} = {
  metrics: {
    key: 'metrics',
    fetch: (ctx) => api.getMetrics(ctx.windowHours),
  },
  posture: {
    key: 'posture',
    // `compare='prev'` gives period-over-period deltas the KPI widgets can show.
    fetch: (ctx) => fetchPosture(ctx.windowHours, 'prev'),
  },
  mitre: {
    key: 'mitre',
    // Coverage spans ALL cases (window_hours=0) so the heatmap reflects the whole
    // observed technique footprint, independent of the dashboard window.
    fetch: () => fetchMitreCoverage(0),
  },
  sourcesHealth: {
    key: 'sourcesHealth',
    fetch: () => api.get<SourcesHealthResponse>('sources/health'),
  },
  cases: {
    key: 'cases',
    fetch: (ctx) => api.listCases({ limit: ctx.caseLimit }),
  },
  standup: {
    key: 'standup',
    fetch: (ctx) => api.standup(ctx.windowHours),
  },
};

/** All declared source keys (stable order — drives the single fetch batch). */
export const DASHBOARD_SOURCE_KEYS = Object.keys(
  DASHBOARD_SOURCES,
) as DashboardSourceKey[];

// --------------------------------------------------------------------------- //
// Per-source state
// --------------------------------------------------------------------------- //

/** The reactive state a widget sees for one source. */
export interface DashboardSourceState<K extends DashboardSourceKey = DashboardSourceKey> {
  loading: boolean;
  /** The last successful payload (null until the first success). */
  data: DashboardSourcePayloads[K] | null;
  /** The last error (null when healthy); a source failing never breaks the page. */
  error: unknown;
}

type SourceStateMap = {
  [K in DashboardSourceKey]: DashboardSourceState<K>;
};

function initialSourceState(): SourceStateMap {
  const out = {} as SourceStateMap;
  for (const key of DASHBOARD_SOURCE_KEYS) {
    (out[key] as DashboardSourceState) = { loading: true, data: null, error: null };
  }
  return out;
}

export interface DashboardDataContextValue {
  /** Per-source `{loading,data,error}`, keyed by source key. */
  sources: SourceStateMap;
  /** True while ANY source is still loading its first payload. */
  loading: boolean;
  /** The active roll-up window in hours (widgets may label it). */
  windowHours: number;
  /** Force a re-fetch of every source (the refresh control / auto-refresh tick). */
  refresh: () => void;
  /** Monotonic counter bumped on each refresh (widgets may key memoisation on it). */
  refreshToken: number;
}

const DashboardDataContext = React.createContext<DashboardDataContextValue | null>(null);

// --------------------------------------------------------------------------- //
// Provider
// --------------------------------------------------------------------------- //

export interface DashboardDataProviderProps {
  /** Active roll-up window in hours (default 168h / 7d, matching Metrics). */
  windowHours?: number;
  /** Recent-case page size for table widgets (bounded; default 25). */
  caseLimit?: number;
  /**
   * Which sources to actually fetch. Defaults to ALL declared sources; a host that
   * knows the placed widgets can pass only the needed subset so an empty dashboard
   * (or one with no MITRE widget) skips those round-trips entirely.
   */
  sourceKeys?: readonly DashboardSourceKey[];
  children: React.ReactNode;
}

/**
 * Fetch-once dashboard data context. Loads each declared source a SINGLE time per
 * (window × refresh) via one `Promise.allSettled`, and shares the result with every
 * descendant widget. A failing source degrades to `{error}` without blocking peers.
 */
export function DashboardDataProvider({
  windowHours = 168,
  caseLimit = 25,
  sourceKeys = DASHBOARD_SOURCE_KEYS,
  children,
}: DashboardDataProviderProps) {
  const [state, setState] = React.useState<SourceStateMap>(initialSourceState);
  const [refreshToken, setRefreshToken] = React.useState(0);

  // Stable, deduped list of the keys to fetch this pass.
  const activeKeys = React.useMemo<DashboardSourceKey[]>(
    () => DASHBOARD_SOURCE_KEYS.filter((k) => sourceKeys.includes(k)),
    [sourceKeys],
  );
  // A stable dependency signature so the effect re-runs only when the SET changes,
  // not when a new array literal is passed with the same members.
  const activeKeysSig = activeKeys.join(',');

  const refresh = React.useCallback(() => setRefreshToken((n) => n + 1), []);

  React.useEffect(() => {
    let cancelled = false;
    const ctx: DashboardFetchContext = { windowHours, caseLimit };

    // Mark exactly the active sources as loading (leave un-requested sources as-is).
    setState((prev) => {
      const next = { ...prev };
      for (const key of activeKeys) {
        (next[key] as DashboardSourceState) = {
          ...(next[key] as DashboardSourceState),
          loading: true,
          error: null,
        };
      }
      return next;
    });

    // ONE batch — every source fetched in parallel, exactly once. allSettled so a
    // single rejection never aborts the others.
    const jobs = activeKeys.map((key) =>
      DASHBOARD_SOURCES[key]
        .fetch(ctx)
        .then((data) => ({ key, data, error: null as unknown }))
        .catch((error) => ({ key, data: null, error })),
    );

    void Promise.allSettled(jobs).then((settled) => {
      if (cancelled) return;
      setState((prev) => {
        const next = { ...prev };
        for (const s of settled) {
          if (s.status !== 'fulfilled') continue; // catch() above makes this unreachable
          const { key, data, error } = s.value;
          const cur = next[key] as DashboardSourceState;
          (next[key] as DashboardSourceState) = {
            loading: false,
            // Keep the last good payload on error (stale-but-shown beats a blank card).
            data: error ? cur.data : (data as DashboardSourceState['data']),
            error,
          };
        }
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
    // Re-fetch when the window, page size, requested source SET, or refresh changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowHours, caseLimit, activeKeysSig, refreshToken]);

  const loading = React.useMemo(
    () => activeKeys.some((k) => (state[k] as DashboardSourceState).loading),
    [state, activeKeys],
  );

  const value = React.useMemo<DashboardDataContextValue>(
    () => ({ sources: state, loading, windowHours, refresh, refreshToken }),
    [state, loading, windowHours, refresh, refreshToken],
  );

  return (
    <DashboardDataContext.Provider value={value}>
      {children}
    </DashboardDataContext.Provider>
  );
}

// --------------------------------------------------------------------------- //
// Hooks
// --------------------------------------------------------------------------- //

/** The whole dashboard data context. Throws if used outside the provider. */
export function useDashboardData(): DashboardDataContextValue {
  const ctx = React.useContext(DashboardDataContext);
  if (!ctx) {
    throw new Error('useDashboardData must be used within a <DashboardDataProvider>');
  }
  return ctx;
}

/**
 * Read ONE source's `{loading,data,error}`. This is what widget bodies call — it
 * never triggers a fetch of its own, so N widgets sharing a source produce ZERO extra
 * round-trips.
 */
export function useDashboardSource<K extends DashboardSourceKey>(
  key: K,
): DashboardSourceState<K> {
  const { sources } = useDashboardData();
  return sources[key];
}

// --------------------------------------------------------------------------- //
// Sentinel helpers — never render DASH as a number (#)
// --------------------------------------------------------------------------- //

/**
 * True when a posture `StatBlock` carries a real value. The server sends
 * `available:false` + DASH-string numeric fields when it has no data; a widget must
 * check this before formatting `p50`/`mean` as a number.
 */
export function isAvailable(block: StatBlock | null | undefined): boolean {
  return Boolean(block && block.available);
}

/**
 * Coerce a possibly-sentinel numeric field (a StatBlock/CompareBlock value that may be
 * the DASH string) to a real number, or `null` when it is unavailable. Widgets pass
 * the result to a formatter and render an EmptyState / DASH on `null` — NEVER treating
 * the DASH string as if it were a numeric zero.
 */
export function statNumber(v: number | string | null | undefined): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  // The backend sentinel is the DASH glyph; any non-finite/string reads as "no value".
  if (typeof v === 'string' && v !== DASH) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
