/**
 * Round-6 dashboard-core WidgetGrid a11y/layout regression tests.
 *
 *   1. EVERY widget's edit grip is in the tab order (tabIndex 0), so a keyboard-only
 *      user can reach and operate ANY widget — not just the first. Before the fix the
 *      grip roving meant only `widgets[0]` was ever tabbable (WCAG 2.1.1 failure).
 *   2. VIEW mode flow-packs an all-at-origin per-role DEFAULT into distinct grid cells
 *      (no overlapping pile in the top-left cell).
 *
 * Mirrors the offline mock setup of the existing WidgetGrid spec (RGL + data mocked).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('react-grid-layout', () => {
  const React = require('react');
  return {
    GridLayout: ({ children }: { children: React.ReactNode }) =>
      React.createElement('div', { 'data-testid': 'rgl-mock' }, children),
    useContainerWidth: () => ({
      width: 1200,
      mounted: true,
      containerRef: { current: null },
      measureWidth: () => {},
    }),
  };
});
vi.mock('react-grid-layout/css/styles.css', () => ({}));
vi.mock('react-resizable/css/styles.css', () => ({}));

const apiMocks = vi.hoisted(() => ({
  getMetrics: vi.fn(),
  listCases: vi.fn(),
  standup: vi.fn(),
  get: vi.fn(),
}));
vi.mock('@/lib/api', () => ({ api: apiMocks }));
const { fetchPostureMock, fetchMitreMock } = vi.hoisted(() => ({
  fetchPostureMock: vi.fn(),
  fetchMitreMock: vi.fn(),
}));
vi.mock('../../pages/Metrics.posture.api', async () => {
  const actual = await vi.importActual<typeof import('../../pages/Metrics.posture.api')>(
    '../../pages/Metrics.posture.api',
  );
  return { ...actual, fetchPosture: fetchPostureMock, fetchMitreCoverage: fetchMitreMock };
});

import { WidgetGrid, type WidgetEditActions } from '@/soc/dashboard/WidgetGrid';
import { DashboardDataProvider } from '@/soc/dashboard/DashboardDataProvider';
import type { DashboardWidget } from '@/lib/types';

function w(partial: Record<string, unknown>): DashboardWidget {
  return partial as unknown as DashboardWidget;
}

const noopActions: WidgetEditActions = {
  onConfigure: vi.fn(),
  onDuplicate: vi.fn(),
  onRemove: vi.fn(),
  onMove: vi.fn(),
  onResize: vi.fn(),
};

const TWO: DashboardWidget[] = [
  w({ i: 'a', type: 'kpi.needs_human', x: 0, y: 0, w: 3, h: 3, options: {} }),
  w({ i: 'b', type: 'kpi.cost_budget', x: 0, y: 0, w: 3, h: 3, options: {} }),
];

function renderGrid(ui: React.ReactNode) {
  return render(<DashboardDataProvider>{ui}</DashboardDataProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.getMetrics.mockResolvedValue({
    total_cases: 5,
    open_cases: 2,
    needs_human_cases: 1,
    cost: { total_cost: 1.23, currency: 'USD', call_count: 7 },
  });
  apiMocks.listCases.mockResolvedValue({ cases: [], total: 0 });
  apiMocks.standup.mockResolvedValue({ enabled: false });
  apiMocks.get.mockResolvedValue({ sources: [] });
  fetchPostureMock.mockResolvedValue({ window_hours: 168, lifecycle: {}, quality: {}, aging: {}, sla: {} });
  fetchMitreMock.mockResolvedValue({ by_tactic: {}, top_techniques: [], covered_techniques: 0, total_techniques: 0 });
});

describe('WidgetGrid — keyboard grip reachability (WCAG 2.1.1)', () => {
  it('puts EVERY widget grip in the tab order (not just the first)', async () => {
    renderGrid(
      <WidgetGrid widgets={TWO} editing onLayoutChange={vi.fn()} editActions={noopActions} />,
    );
    await waitFor(() => expect(screen.getByTestId('rgl-mock')).toBeInTheDocument());

    const grips = await screen.findAllByLabelText(/Move or resize/i);
    expect(grips.length).toBe(2);
    // Both grips are keyboard-focusable — the second widget is reachable.
    for (const grip of grips) {
      expect(grip.getAttribute('tabindex')).toBe('0');
    }
  });
});

describe('WidgetGrid — VIEW-mode packing', () => {
  it('flow-packs an all-at-origin default into distinct grid cells', async () => {
    renderGrid(<WidgetGrid widgets={TWO} editing={false} />);
    const view = screen.getByTestId('widget-grid-view');

    // The two widget cells are direct children of the grid; their inline gridColumn must
    // differ so they no longer stack in the same top-left cell.
    const cells = Array.from(view.children) as HTMLElement[];
    expect(cells).toHaveLength(2);
    const cols = cells.map((c) => c.style.gridColumn);
    expect(cols[0]).not.toBe(cols[1]);
    // First widget occupies column 1; the second flows to its right (not column 1).
    expect(cols[0]).toContain('1 /');
    expect(cols[1]).not.toContain('1 /');
  });
});
