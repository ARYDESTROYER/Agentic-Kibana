/**
 * Wave 6 — per-source Feeds editor render + config-build test.
 *
 * Mounts <SourceEditor/> in EDIT mode for an existing Elasticsearch source whose
 * connector manifest has NO required fields (so Save is reachable without filling a
 * dynamic form). It pre-seeds one legacy events feed, then:
 *   1. adds a second feed and flips its role to "Alerts",
 *   2. adds a third feed and flips its role to "Ignore",
 *   3. clicks "Save changes",
 * and asserts `api.upsertSource` is called with a `config.index_patterns` carrying
 * the alerts + ignore feeds, and that `config.data_view_pattern` EXCLUDES the ignore
 * feed (Wave 6 writer contract).
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const upsertSource = vi.fn();

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = 'ApiError';
    }
  }
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  return {
    ApiError,
    setUnauthorizedHandler: vi.fn(),
    api: {
      upsertSource: (body: unknown) => upsertSource(body),
      updateSecrets: ok({ ok: true }),
      sourceLogs: ok({ source_id: 'es-1', mode: 'search', count: 0, logs: [] }),
      sources: { analyzeSample: ok({ fields: [], suggested_mappings: {} }) },
      demo: { status: ok({ mode: 'off' }) },
    },
  };
});

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { TooltipProvider } from '@/ui/tooltip';
import { SourceEditor } from '../components/SourceEditor';
import type { ConnectorManifest, SourceInstance } from '@/lib/types';

// A connector manifest with no required auth/config fields → Save is reachable.
const manifest: ConnectorManifest = {
  source_type: 'elasticsearch',
  display_name: 'Elasticsearch',
  ingest_modes: ['pull'],
  auth_fields: [],
  config_fields: [],
} as unknown as ConnectorManifest;

// An existing source (edit mode) seeded with a single legacy events feed.
const existing: SourceInstance = {
  id: 'es-1',
  source_type: 'elasticsearch',
  display_name: 'Prod ES',
  enabled: true,
  is_primary: true,
  configured_secrets: [],
  config: {
    index_patterns: [{ pattern: 'all-logs-*', role: 'events', auto_correlate: true }],
    data_view_pattern: 'all-logs-*',
  },
};

function renderEditor() {
  return render(
    <TooltipProvider>
      <SourceEditor connectors={[manifest]} existing={existing} onSaved={vi.fn()} />
    </TooltipProvider>,
  );
}

describe('Source Feeds editor (Wave 6)', () => {
  beforeEach(() => upsertSource.mockReset().mockResolvedValue({ ok: true, sources: [] }));

  it('builds index_patterns with an alerts feed + an ignore feed (excluded from data_view)', async () => {
    renderEditor();

    // The seeded events feed renders its pattern input.
    const firstPattern = (await screen.findByLabelText(
      'Feed 1 index pattern',
    )) as HTMLInputElement;
    expect(firstPattern.value).toBe('all-logs-*');

    // --- add feed #2 → make it an Alerts feed ----------------------------- //
    fireEvent.click(screen.getByRole('button', { name: /Add feed/i }));
    const second = (await screen.findByLabelText('Feed 2 index pattern')) as HTMLInputElement;
    fireEvent.change(second, { target: { value: 'wazuh-alerts-*' } });
    // The role segmented control: pick "Alerts" within feed 2's card.
    const alertsRadio = document.getElementById('feed-1-role-alerts')!;
    fireEvent.click(alertsRadio);

    // --- add feed #3 → make it an Ignore feed ----------------------------- //
    fireEvent.click(screen.getByRole('button', { name: /Add feed/i }));
    const third = (await screen.findByLabelText('Feed 3 index pattern')) as HTMLInputElement;
    fireEvent.change(third, { target: { value: 'all-logs-noise-*' } });
    const ignoreRadio = document.getElementById('feed-2-role-ignore')!;
    fireEvent.click(ignoreRadio);

    // --- save ------------------------------------------------------------- //
    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));
    await waitFor(() => expect(upsertSource).toHaveBeenCalledTimes(1));

    const body = upsertSource.mock.calls[0][0] as {
      config: { index_patterns: Array<Record<string, unknown>>; data_view_pattern: string };
    };
    const feeds = body.config.index_patterns;
    expect(feeds).toHaveLength(3);

    const byPattern = Object.fromEntries(feeds.map((f) => [f.pattern, f]));
    expect(byPattern['all-logs-*'].role).toBe('events');
    expect(byPattern['wazuh-alerts-*'].role).toBe('alerts');
    expect(byPattern['all-logs-noise-*'].role).toBe('ignore');

    // alerts feed → effective auto-forward on (legacy key kept in sync).
    expect(byPattern['wazuh-alerts-*'].auto_correlate).toBe(true);
    // ignore feed → never auto-forwarded.
    expect(byPattern['all-logs-noise-*'].auto_correlate).toBe(false);

    // The derived read view EXCLUDES the ignore feed (Wave 6 writer contract).
    const dv = body.config.data_view_pattern.split(',');
    expect(dv).toContain('all-logs-*');
    expect(dv).toContain('wazuh-alerts-*');
    expect(dv).not.toContain('all-logs-noise-*');
  });

  it('round-trips a legacy bare-string + {pattern,role} feed unchanged', async () => {
    // Re-mount with mixed legacy entries; assert effective auto_correlate preserved.
    const legacy: SourceInstance = {
      ...existing,
      config: {
        index_patterns: [
          'plain-logs-*', // bare string → events, auto-forward on
          { pattern: 'siem-alerts-*', role: 'alerts' }, // alerts → auto-forward on
          { pattern: 'audit-*', role: 'events', auto_correlate: false }, // manual triage
        ],
      },
    };
    render(
      <TooltipProvider>
        <SourceEditor connectors={[manifest]} existing={legacy} onSaved={vi.fn()} />
      </TooltipProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /Save changes/i }));
    await waitFor(() => expect(upsertSource).toHaveBeenCalled());
    const body = upsertSource.mock.calls.at(-1)![0] as {
      config: { index_patterns: Array<Record<string, unknown>> };
    };
    const byPattern = Object.fromEntries(body.config.index_patterns.map((f) => [f.pattern, f]));
    expect(byPattern['plain-logs-*'].role).toBe('events');
    expect(byPattern['plain-logs-*'].auto_correlate).toBe(true);
    expect(byPattern['siem-alerts-*'].auto_correlate).toBe(true);
    // legacy auto_correlate:false → manual triage preserved.
    expect(byPattern['audit-*'].auto_correlate).toBe(false);
  });
});
