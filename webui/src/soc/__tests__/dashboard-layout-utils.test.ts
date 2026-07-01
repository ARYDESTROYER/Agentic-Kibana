/**
 * Pure layout-helper tests (Round 5 / G7, CD3/CD4) for `soc/dashboard/layout-utils`.
 *
 * These cover the id/options adapters (backend `i`/`options` ↔ registry `id`), grid
 * clamping, the RGL layout round-trip (`widgetsToLayout` / `applyLayout`), and the
 * KEYBOARD move/resize helpers (WCAG 2.5.7 non-drag alternative). All pure — no React,
 * no RGL import (these must be safe to load in view mode).
 */
import { describe, it, expect } from 'vitest';
import type { DashboardWidget } from '@/lib/types';
import {
  GRID_COLS,
  widgetId,
  widgetOptions,
  widgetToItem,
  widgetsToLayout,
  applyLayout,
  moveWidget,
  resizeWidget,
  normalizeWidget,
  freshId,
} from '@/soc/dashboard/layout-utils';

function w(partial: Partial<Record<string, unknown>>): DashboardWidget {
  return partial as unknown as DashboardWidget;
}

describe('layout-utils — id + options adapters', () => {
  it('widgetId reads `i` (backend/RGL) OR `id` (registry)', () => {
    expect(widgetId(w({ i: 'w-1' }))).toBe('w-1');
    expect(widgetId(w({ id: 'w-2' }))).toBe('w-2');
    // `i` wins when both are present.
    expect(widgetId(w({ i: 'w-3', id: 'other' }))).toBe('w-3');
    expect(widgetId(w({}))).toBe('');
  });

  it('widgetOptions reads `options` (backend) OR `config` (types)', () => {
    expect(widgetOptions(w({ options: { title: 'A' } }))).toEqual({ title: 'A' });
    expect(widgetOptions(w({ config: { title: 'B' } }))).toEqual({ title: 'B' });
    expect(widgetOptions(w({}))).toEqual({});
    // A non-object options bag degrades to {} (never throws).
    expect(widgetOptions(w({ options: 'bad' }))).toEqual({});
  });
});

describe('layout-utils — geometry clamping + RGL round-trip', () => {
  it('widgetToItem clamps geometry into the 12-col grid', () => {
    const item = widgetToItem(w({ i: 'x', x: 20, y: -5, w: 99, h: 4 }));
    expect(item.w).toBeLessThanOrEqual(GRID_COLS);
    expect(item.x).toBeGreaterThanOrEqual(0);
    expect(item.x + item.w).toBeLessThanOrEqual(GRID_COLS);
    expect(item.y).toBe(0); // negative → clamped to 0
  });

  it('widgetsToLayout produces items keyed by widget id', () => {
    const layout = widgetsToLayout([
      w({ i: 'a', x: 0, y: 0, w: 3, h: 3 }),
      w({ i: 'b', x: 3, y: 0, w: 3, h: 3 }),
    ]);
    expect(layout.map((it) => it.i)).toEqual(['a', 'b']);
  });

  it('applyLayout merges geometry back onto widgets by id, preserving type/options', () => {
    const widgets = [
      w({ i: 'a', type: 'kpi.needs_human', x: 0, y: 0, w: 3, h: 3, options: { title: 'keep' } }),
    ];
    const next = applyLayout(widgets, [{ i: 'a', x: 6, y: 2, w: 4, h: 5 }]);
    expect(next[0].x).toBe(6);
    expect(next[0].w).toBe(4);
    // type + options are preserved through the geometry merge.
    expect(next[0].type).toBe('kpi.needs_human');
    expect(widgetOptions(next[0])).toEqual({ title: 'keep' });
  });
});

describe('layout-utils — keyboard move/resize (WCAG 2.5.7)', () => {
  const base = w({ i: 'k', x: 4, y: 4, w: 3, h: 3, minW: 2, minH: 2 });

  it('moveWidget moves one cell and clamps at the edges', () => {
    expect((moveWidget(base, 'left') as { x: number }).x).toBe(3);
    expect((moveWidget(base, 'right') as { x: number }).x).toBe(5);
    expect((moveWidget(base, 'up') as { y: number }).y).toBe(3);
    expect((moveWidget(base, 'down') as { y: number }).y).toBe(5);
    // Left edge clamp: x never goes negative.
    const atLeft = w({ i: 'k', x: 0, y: 0, w: 3, h: 3 });
    expect((moveWidget(atLeft, 'left') as { x: number }).x).toBe(0);
    // Right edge clamp: x + w never exceeds the grid.
    const atRight = w({ i: 'k', x: GRID_COLS - 3, y: 0, w: 3, h: 3 });
    expect((moveWidget(atRight, 'right') as { x: number }).x).toBe(GRID_COLS - 3);
  });

  it('resizeWidget grows/shrinks one cell honouring minW/minH and grid bounds', () => {
    expect((resizeWidget(base, 'wider') as { w: number }).w).toBe(4);
    expect((resizeWidget(base, 'narrower') as { w: number }).w).toBe(2);
    expect((resizeWidget(base, 'taller') as { h: number }).h).toBe(4);
    expect((resizeWidget(base, 'shorter') as { h: number }).h).toBe(2);
    // Cannot shrink below minW (2).
    const atMin = w({ i: 'k', x: 0, y: 0, w: 2, h: 2, minW: 2, minH: 2 });
    expect((resizeWidget(atMin, 'narrower') as { w: number }).w).toBe(2);
    expect((resizeWidget(atMin, 'shorter') as { h: number }).h).toBe(2);
  });
});

describe('layout-utils — normalizeWidget + freshId', () => {
  it('normalizeWidget always yields a concrete `i`', () => {
    const n = normalizeWidget(w({ type: 'kpi.needs_human', x: 0, y: 0, w: 3, h: 3 }));
    expect(typeof (n as { i?: string }).i).toBe('string');
    expect((n as { i: string }).i.length).toBeGreaterThan(0);
  });

  it('freshId returns unique prefixed ids', () => {
    const a = freshId('w-');
    const b = freshId('w-');
    expect(a).not.toBe(b);
    expect(a.startsWith('w-')).toBe(true);
  });
});
