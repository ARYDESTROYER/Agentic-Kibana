/**
 * Round-6 dashboard-core regression tests (pure).
 *
 *   • packWidgets — the VIEW-mode compaction that replaces RGL's missing negative
 *     gravity so a per-role DEFAULT dashboard (every widget seeded at 0,0) no longer
 *     renders as an overlapping pile in the top-left cell. (Finding: dashboard packing)
 *   • the cost-budget widget's RBAC requirement pins the REAL cost action (`view`),
 *     not the un-grantable `read`. (Finding: cost widget requires nonexistent cost:read)
 */
import { describe, it, expect } from 'vitest';
import type { DashboardWidget } from '@/lib/types';
import { packWidgets, GRID_COLS, widgetToItem } from '@/soc/dashboard/layout-utils';
import { WIDGET_REGISTRY } from '@/soc/dashboard/registry';

function w(partial: Record<string, unknown>): DashboardWidget {
  return partial as unknown as DashboardWidget;
}

/** True when NO two placed widgets overlap on the grid. */
function noOverlap(widgets: DashboardWidget[]): boolean {
  const rects = widgets.map((x) => widgetToItem(x));
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const a = rects[i];
      const b = rects[j];
      if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) return false;
    }
  }
  return true;
}

describe('packWidgets — view-mode compaction', () => {
  it('FLOW-packs an all-at-origin default into a non-overlapping grid', () => {
    // The exact per-role default shape: every widget seeded at (0,0).
    const input = [
      w({ i: 'a', type: 'kpi.needs_human', x: 0, y: 0, w: 3, h: 4 }),
      w({ i: 'b', type: 'gauge.active_risk', x: 0, y: 0, w: 3, h: 4 }),
      w({ i: 'c', type: 'chart.verdict_mix', x: 0, y: 0, w: 6, h: 4 }),
      w({ i: 'd', type: 'table.recent_cases', x: 0, y: 0, w: 12, h: 5 }),
    ];
    const out = packWidgets(input, GRID_COLS);

    // No two widgets share the top-left cell any more (the reported bug).
    expect(noOverlap(out)).toBe(true);
    // Order preserved → stable React keys.
    expect(out.map((x) => (x as { i: string }).i)).toEqual(['a', 'b', 'c', 'd']);
    // Row 0 flows left→right: a(0-3), b(3-6), c(6-12); d wraps to the next row.
    const byId = Object.fromEntries(out.map((x) => [(x as { i: string }).i, widgetToItem(x)]));
    expect([byId.a.x, byId.a.y]).toEqual([0, 0]);
    expect([byId.b.x, byId.b.y]).toEqual([3, 0]);
    expect([byId.c.x, byId.c.y]).toEqual([6, 0]);
    expect(byId.d.y).toBeGreaterThan(0); // wrapped below row 0
    expect(byId.d.x).toBe(0);
    // Nothing exceeds the 12-column grid.
    for (const r of Object.values(byId)) expect(r.x + r.w).toBeLessThanOrEqual(GRID_COLS);
  });

  it('is IDEMPOTENT for a valid saved layout (respects user positions)', () => {
    const saved = [
      w({ i: 'a', type: 'kpi.needs_human', x: 0, y: 0, w: 3, h: 4 }),
      w({ i: 'b', type: 'gauge.active_risk', x: 6, y: 2, w: 3, h: 4 }),
      w({ i: 'c', type: 'chart.verdict_mix', x: 0, y: 6, w: 6, h: 4 }),
    ];
    const out = packWidgets(saved, GRID_COLS);
    expect(out.map((x) => [widgetToItem(x).x, widgetToItem(x).y])).toEqual([
      [0, 0],
      [6, 2],
      [0, 6],
    ]);
    expect(noOverlap(out)).toBe(true);
  });

  it('COLLISION-resolves a placed layout that overlaps (push y down, keep x/w/h)', () => {
    const overlapping = [
      w({ i: 'a', type: 'kpi.needs_human', x: 0, y: 0, w: 6, h: 3 }),
      w({ i: 'b', type: 'gauge.active_risk', x: 0, y: 1, w: 6, h: 3 }), // overlaps a
    ];
    const out = packWidgets(overlapping, GRID_COLS);
    expect(noOverlap(out)).toBe(true);
    // x/w preserved; only y moved to clear the collision.
    const b = widgetToItem(out.find((x) => (x as { i: string }).i === 'b')!);
    expect(b.x).toBe(0);
    expect(b.y).toBeGreaterThanOrEqual(3);
  });

  it('handles 0- and 1-widget inputs without throwing', () => {
    expect(packWidgets([])).toEqual([]);
    const one = packWidgets([w({ i: 'a', type: 'kpi.needs_human', x: 0, y: 0, w: 3, h: 3 })]);
    expect(one).toHaveLength(1);
    expect((one[0] as { i: string }).i).toBe('a');
  });
});

describe('cost-budget widget RBAC requirement', () => {
  it('requires the canonical `cost:view` grant (never the un-grantable `cost:read`)', () => {
    const def = WIDGET_REGISTRY.get('kpi.cost_budget')!;
    expect(def.requires).toEqual({ resource: 'cost', action: 'view' });
  });

  it('a role holding only `cost:view` can use the widget', () => {
    const def = WIDGET_REGISTRY.get('kpi.cost_budget')!;
    const canViewOnly = (resource: string, action: string) => resource === 'cost' && action === 'view';
    expect(canViewOnly(def.requires!.resource, def.requires!.action)).toBe(true);
  });
});
