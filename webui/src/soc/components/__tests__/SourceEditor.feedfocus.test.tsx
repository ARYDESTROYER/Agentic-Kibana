/**
 * SourceEditor — typing into a feed's index-pattern input must NOT remount the FeedCard
 * (which would drop focus after every keystroke). The card is keyed on a stable, non-
 * derived `uid`, so the input DOM node is preserved and keeps focus (Round-6 finding 2).
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

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
      setSourceSecrets: ok({ ok: true, configured_secrets: [] }),
      sourceLogs: ok({ source_id: 'es-1', mode: 'search', count: 0, logs: [] }),
      sources: { analyzeSample: ok({ fields: [], suggested_mappings: {} }) },
      demo: { status: ok({ mode: 'off' }) },
    },
  };
});

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { TooltipProvider } from '@/ui/tooltip';
import { SourceEditor } from '../SourceEditor';
import type { ConnectorManifest, SourceInstance } from '@/lib/types';

const manifest: ConnectorManifest = {
  source_type: 'elasticsearch',
  display_name: 'Elasticsearch',
  ingest_modes: ['pull'],
  auth_fields: [],
  config_fields: [],
} as unknown as ConnectorManifest;

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

beforeEach(() => upsertSource.mockReset().mockResolvedValue({ ok: true, sources: [] }));

describe('SourceEditor feed pattern focus (finding 2)', () => {
  it('keeps focus on the pattern input while typing (no remount)', async () => {
    render(
      <TooltipProvider>
        <SourceEditor connectors={[manifest]} existing={existing} onSaved={vi.fn()} />
      </TooltipProvider>,
    );

    const input1 = (await screen.findByLabelText('Feed 1 index pattern')) as HTMLInputElement;
    input1.focus();
    expect(document.activeElement).toBe(input1);

    // A keystroke that changes the pattern (and would change a pattern-derived key).
    fireEvent.change(input1, { target: { value: 'all-logs-2*' } });

    const input2 = (await screen.findByLabelText('Feed 1 index pattern')) as HTMLInputElement;
    // Same DOM node → the FeedCard was NOT remounted → focus is retained.
    expect(input2).toBe(input1);
    expect(document.activeElement).toBe(input1);
    expect(input2.value).toBe('all-logs-2*');
  });
});
