import { readFileSync } from 'node:fs';
import path from 'node:path';

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { axe, toHaveNoViolations } from 'jest-axe';

import {
  BUILTIN_CONNECTOR_SOURCE_TYPES,
  DESIGN_SYSTEM_CATALOG,
  LoadingState,
  SOURCE_MARK_CATALOG,
  SourceMark,
} from '@/design-system';

expect.extend(toHaveNoViolations);

const themeCss = readFileSync(path.resolve(__dirname, '../../styles/theme.css'), 'utf8');

describe('application scroll policy', () => {
  it('prevents native document rubber-banding from moving the application chrome', () => {
    const rootRule = themeCss.match(/html,\s*body,\s*#root\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(rootRule).toContain('height: 100%');
    expect(rootRule).toContain('overscroll-behavior-y: none');
  });
});

describe('LoadingState', () => {
  it('is centered, visibly named, and explicitly reduced-motion safe', () => {
    render(
      <LoadingState
        label="Loading cases"
        description="Preparing the latest records."
        layout="page"
        shape="page"
      />,
    );

    const status = screen.getByRole('status', { name: 'Loading cases' });
    expect(status).toHaveClass('items-center', 'justify-center');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Loading cases')).toBeVisible();
    expect(status.querySelector('[data-loading-shape="page"]')).toHaveAttribute(
      'aria-hidden',
      'true',
    );

    const ring = screen.getByTestId('console-loading-glyph').querySelector('svg');
    expect(ring).toHaveClass('console-progress-ring');
    expect(ring).toHaveAttribute('data-loading-motion', 'indeterminate-ring');
    expect(ring?.querySelectorAll('[data-loading-arc="true"]')).toHaveLength(1);
    expect(ring?.querySelector('[data-loading-track="true"]')).toBeInTheDocument();
    expect(ring?.querySelector('[data-loading-arc="true"]')).toHaveAttribute(
      'stroke-dasharray',
      '26 74',
    );
    expect(screen.getByTestId('console-loading-glyph').querySelector('span')).toBeNull();
  });

  it('has no detectable accessibility violations', async () => {
    const { container } = render(<LoadingState label="Loading source catalog" layout="panel" />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('keeps ring motion opt-in and preserves Windows forced-color distinction', () => {
    const motionGateStart = themeCss.indexOf('@media (prefers-reduced-motion: no-preference)');
    const motionGateEnd = themeCss.indexOf('/* Thin, subtle scrollbars', motionGateStart);
    const motionGate = themeCss.slice(motionGateStart, motionGateEnd);

    expect(motionGateStart).toBeGreaterThan(-1);
    expect(motionGate).toContain('animation: console-progress-ring-rotate');
    expect(motionGate).toContain('animation: console-progress-ring-dash');

    const forcedColorsStart = themeCss.indexOf('@media (forced-colors: active)', motionGateStart);
    const forcedColors = themeCss.slice(forcedColorsStart, motionGateEnd);
    expect(forcedColorsStart).toBeGreaterThan(-1);
    expect(forcedColors).toContain('forced-color-adjust: none');
    expect(forcedColors).toContain('stroke: GrayText');
    expect(forcedColors).toContain('stroke: Highlight');
  });
});

describe('source-mark catalog', () => {
  it('covers every built-in connector with a unique stable asset and geometry', () => {
    const byType = new Map(SOURCE_MARK_CATALOG.map((mark) => [mark.sourceType, mark]));
    for (const sourceType of BUILTIN_CONNECTOR_SOURCE_TYPES) {
      expect(byType.has(sourceType), `missing ${sourceType}`).toBe(true);
    }

    const ids = SOURCE_MARK_CATALOG.map((mark) => mark.id);
    expect(new Set(ids).size).toBe(ids.length);

    const geometry = SOURCE_MARK_CATALOG.map((mark) =>
      JSON.stringify({
        paths: mark.paths,
        circles: mark.circles,
        rects: mark.rects,
        lines: mark.lines,
      }),
    );
    expect(new Set(geometry).size).toBe(geometry.length);
  });

  it('renders named marks and a deterministic fallback for plugin types', () => {
    const { rerender } = render(<SourceMark sourceType="elasticsearch" />);
    expect(screen.getByRole('img', { name: 'Elasticsearch source' })).toHaveAttribute(
      'data-source-mark',
      'source.elasticsearch.segmented-orbit',
    );

    rerender(<SourceMark sourceType="plugin_acme" label="Acme event stream" />);
    expect(screen.getByRole('img', { name: 'Acme event stream' })).toHaveAttribute(
      'data-source-mark',
      'source.generic.connected-grid',
    );
  });

  it('exposes a JSON-safe catalog without claiming a running MCP transport', () => {
    expect(() => JSON.stringify(DESIGN_SYSTEM_CATALOG)).not.toThrow();
    expect(DESIGN_SYSTEM_CATALOG.futureAgentInterface.transport).toBe('none');
    expect(DESIGN_SYSTEM_CATALOG.components.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        'feedback.loading-state',
        'feedback.loading-glyph',
        'asset.source-mark',
        'surface.card',
        'navigation.tabs',
        'control.segmented',
        'layout.control-bar',
        'layout.filter-bar',
        'data.table',
        'feedback.empty-state',
        'settings.section',
      ]),
    );
  });
});
