/**
 * Pure layout helpers for the custom-dashboard grid (Round 5 / G7, CD3/CD4).
 *
 * These are the dependency-free, side-effect-free adapters between the three shapes
 * the same data wears at different layers:
 *
 *   1. PERSISTED (`DashboardWidget` from `@/lib/types`, mirroring the backend
 *      `models.DashboardWidget`) — the wire/store shape. Its stable id is `i` and its
 *      grid geometry is `{x,y,w,h,minW,minH,static}` (12-col grid units). This IS the
 *      react-grid-layout item shape, so persistence and the grid library share ONE
 *      contract (no translation of the geometry itself).
 *   2. IN-MEMORY / registry shape — what `registry.ts` produces (`buildDefaultWidgets`
 *      / `reconcileWidgets`) using `id` as the stable key. The CD-core registry writes
 *      `id`, the backend writes `i`; these helpers read EITHER so a widget from either
 *      producer round-trips.
 *   3. RGL `LayoutItem` (`{i,x,y,w,h,minW,minH,static}`) — the array RGL's `GridLayout`
 *      reads/writes via `layout` / `onLayoutChange`.
 *
 * Everything here is PURE (no React, no fetch, no `decide()` — a layout is advisory,
 * #3). No import of react-grid-layout: these helpers must be safe to load in VIEW mode,
 * where zero grid JS ships.
 */
import type { DashboardWidget } from '@/lib/types';

/** The fixed grid column count (matches backend `DashboardLayout.columns=12`). */
export const GRID_COLS = 12;

/** A hard ceiling on row index / height so a tampered/keyboard-driven y never runs away. */
export const MAX_ROWS = 1000;

/** The RGL `LayoutItem` subset we persist (byte-identical to `DashboardWidget` geometry). */
export interface GridItemShape {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
  static?: boolean;
}

/** A stable widget id: reads `i` (backend/RGL) OR `id` (registry), whichever is set. */
export function widgetId(w: DashboardWidget): string {
  const anyW = w as Record<string, unknown>;
  const i = typeof anyW.i === 'string' ? anyW.i : '';
  const id = typeof anyW.id === 'string' ? anyW.id : '';
  return i || id || '';
}

/** The widget's declarative options bag, reading `options` (backend) OR `config` (types). */
export function widgetOptions(w: DashboardWidget): Record<string, unknown> {
  const anyW = w as Record<string, unknown>;
  const opts = anyW.options ?? anyW.config;
  return opts && typeof opts === 'object' && !Array.isArray(opts)
    ? (opts as Record<string, unknown>)
    : {};
}

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : NaN;
  if (Number.isNaN(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Project a persisted widget onto an RGL `LayoutItem`, clamping geometry into the
 * 12-col grid (defense against a tampered layout — the server also clamps, #9). `i`
 * is the stable id RGL uses as the child key.
 */
export function widgetToItem(w: DashboardWidget, cols = GRID_COLS): GridItemShape {
  const anyW = w as Record<string, unknown>;
  const width = clampInt(anyW.w, 1, cols, Math.min(4, cols));
  const height = clampInt(anyW.h, 1, MAX_ROWS, 4);
  const x = clampInt(anyW.x, 0, Math.max(0, cols - width), 0);
  const y = clampInt(anyW.y, 0, MAX_ROWS, 0);
  const minW =
    anyW.minW == null ? undefined : clampInt(anyW.minW, 1, cols, 1);
  const minH =
    anyW.minH == null ? undefined : clampInt(anyW.minH, 1, MAX_ROWS, 1);
  return {
    i: widgetId(w),
    x,
    y,
    w: width,
    h: height,
    minW,
    minH,
    static: Boolean(anyW.static),
  };
}

/** Build the RGL layout array (clamped) for a widget list. */
export function widgetsToLayout(
  widgets: readonly DashboardWidget[],
  cols = GRID_COLS,
): GridItemShape[] {
  return widgets.map((w) => widgetToItem(w, cols));
}

/**
 * Apply an RGL layout array back onto a widget list, matching by id (`i`). Returns a
 * NEW widget array with updated geometry; the widget `type`/`options` are preserved.
 * Items absent from `layout` keep their prior geometry (RGL always emits all items, so
 * this is just defensive). Pure — no mutation of the inputs.
 */
export function applyLayout(
  widgets: readonly DashboardWidget[],
  layout: readonly GridItemShape[],
): DashboardWidget[] {
  const byId = new Map(layout.map((it) => [it.i, it]));
  return widgets.map((w) => {
    const it = byId.get(widgetId(w));
    if (!it) return w;
    return {
      ...w,
      x: it.x,
      y: it.y,
      w: it.w,
      h: it.h,
      // Preserve any prior minW/minH when the layout item omits them.
      minW: it.minW ?? (w as Record<string, unknown>).minW as number | undefined,
      minH: it.minH ?? (w as Record<string, unknown>).minH as number | undefined,
    } as DashboardWidget;
  });
}

// --------------------------------------------------------------------------- //
// Deterministic packing — the VIEW-mode analogue of RGL's compaction.
// VIEW mode is a plain CSS grid that renders each widget's persisted {x,y} verbatim,
// so it has NO negative-gravity compaction of its own. A per-role DEFAULT dashboard
// (and the reconcile-append path) seeds every widget at (0,0) expecting RGL to pack
// them — but RGL never runs in view mode, so without this they all collide in the
// top-left cell (an unusable pile). `packWidgets` is that missing packer: pure,
// side-effect-free, and safe to load in view mode (no RGL import).
// --------------------------------------------------------------------------- //

interface PackRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Axis-aligned rectangle overlap test (touching edges do NOT count as overlap). */
function rectsIntersect(a: PackRect, b: PackRect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * Return a NEW widget list with non-overlapping geometry, preserving the ORIGINAL
 * array order (so React keys stay stable). Two regimes, chosen by the input:
 *
 *   • UNPLACED (every widget at the origin — the per-role default / freshly-seeded
 *     case): FLOW-pack left→right in reading order, wrapping at the column edge and
 *     advancing rows by the tallest widget in the row. Turns the (0,0) pile into a
 *     coherent grid without needing curated coordinates.
 *   • PLACED (a real saved/RGL layout): COLLISION-resolve only — keep each widget's
 *     x/w/h and push y DOWN until it no longer overlaps an already-placed widget.
 *     A valid non-overlapping layout is returned byte-for-byte (idempotent), so a
 *     user's saved arrangement is respected; only genuine overlaps are repaired.
 *
 * O(n²), deterministic. Clamps geometry via `widgetToItem` first (defense, #9).
 */
export function packWidgets(
  widgets: readonly DashboardWidget[],
  cols = GRID_COLS,
): DashboardWidget[] {
  if (widgets.length <= 1) return widgets.map((w) => ({ ...w }));

  const geo = widgets.map((w, i) => ({ w, i, g: widgetToItem(w, cols) }));
  const out = new Array<DashboardWidget>(widgets.length);

  const allAtOrigin = geo.every(({ g }) => g.x === 0 && g.y === 0);
  if (allAtOrigin) {
    let cx = 0; // running x cursor within the current row
    let rowY = 0; // top of the current row
    let rowH = 0; // tallest widget placed in the current row
    for (const { w, i, g } of geo) {
      const ww = Math.min(g.w, cols);
      if (cx + ww > cols) {
        // wrap to a new row below the tallest widget of the row just filled
        rowY += rowH;
        cx = 0;
        rowH = 0;
      }
      out[i] = { ...w, x: cx, y: rowY, w: ww, h: g.h } as DashboardWidget;
      cx += ww;
      rowH = Math.max(rowH, g.h);
    }
    return out;
  }

  // Collision-resolve: process in reading order (y, then x, then original index for a
  // stable tie-break) and push each widget's y down until it clears prior placements.
  const order = [...geo].sort((a, b) => a.g.y - b.g.y || a.g.x - b.g.x || a.i - b.i);
  const placed: PackRect[] = [];
  for (const { w, i, g } of order) {
    let y = g.y;
    const rect: PackRect = { x: g.x, y, w: g.w, h: g.h };
    while (placed.some((p) => rectsIntersect(rect, p))) {
      y += 1;
      rect.y = y;
    }
    placed.push({ ...rect });
    out[i] = { ...w, x: g.x, y, w: g.w, h: g.h } as DashboardWidget;
  }
  return out;
}

// --------------------------------------------------------------------------- //
// Keyboard move / resize (WCAG 2.5.7 — a non-drag alternative to the pointer).
// Pure functions over ONE widget's geometry; the caller re-packs via RGL compaction.
// --------------------------------------------------------------------------- //

export type MoveDir = 'left' | 'right' | 'up' | 'down';
export type ResizeDir = 'wider' | 'narrower' | 'taller' | 'shorter';

/**
 * Return a copy of `w` moved ONE grid cell in `dir`, clamped so it stays inside the
 * `cols`-wide grid and never goes negative. A no-op at an edge returns an equal (but
 * new) object so React re-renders predictably.
 */
export function moveWidget(
  w: DashboardWidget,
  dir: MoveDir,
  cols = GRID_COLS,
): DashboardWidget {
  const item = widgetToItem(w, cols);
  let { x, y } = item;
  if (dir === 'left') x = Math.max(0, x - 1);
  else if (dir === 'right') x = Math.min(cols - item.w, x + 1);
  else if (dir === 'up') y = Math.max(0, y - 1);
  else if (dir === 'down') y = Math.min(MAX_ROWS, y + 1);
  return { ...w, x, y } as DashboardWidget;
}

/**
 * Return a copy of `w` resized ONE grid cell in `dir`, honouring `minW`/`minH` and the
 * grid bounds (width can never exceed the columns remaining to the right; a shrink can
 * never go below the minimum or 1).
 */
export function resizeWidget(
  w: DashboardWidget,
  dir: ResizeDir,
  cols = GRID_COLS,
): DashboardWidget {
  const item = widgetToItem(w, cols);
  const minW = item.minW ?? 1;
  const minH = item.minH ?? 1;
  let { w: width, h: height } = item;
  if (dir === 'wider') width = Math.min(cols - item.x, width + 1);
  else if (dir === 'narrower') width = Math.max(minW, width - 1);
  else if (dir === 'taller') height = Math.min(MAX_ROWS, height + 1);
  else if (dir === 'shorter') height = Math.max(minH, height - 1);
  return { ...w, w: width, h: height } as DashboardWidget;
}

// --------------------------------------------------------------------------- //
// Fresh widget-instance ids (dep-free; crypto.randomUUID when available).
// --------------------------------------------------------------------------- //

let _seq = 0;
/** A short, collision-resistant widget/dashboard id (no nanoid dep). */
export function freshId(prefix = 'w-'): string {
  const g = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (g?.randomUUID) return `${prefix}${g.randomUUID()}`;
  _seq += 1;
  return `${prefix}${Date.now().toString(36)}-${_seq.toString(36)}`;
}

/**
 * Normalise a widget so it always carries a concrete `i` (its stable id). The builder
 * works in the `i`-keyed shape end-to-end so save maps 1:1 onto the persisted/RGL
 * contract; a registry-produced widget (which may only set `id`) is upgraded here.
 */
export function normalizeWidget(w: DashboardWidget): DashboardWidget {
  const id = widgetId(w) || freshId();
  const item = widgetToItem({ ...w, i: id } as DashboardWidget);
  return {
    ...w,
    i: id,
    x: item.x,
    y: item.y,
    w: item.w,
    h: item.h,
    minW: item.minW,
    minH: item.minH,
    static: item.static,
    options: widgetOptions(w),
  } as DashboardWidget;
}
