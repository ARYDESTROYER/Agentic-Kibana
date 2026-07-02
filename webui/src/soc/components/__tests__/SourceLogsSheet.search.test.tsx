/**
 * SourceLogsSheet — search must not refetch (or flash skeletons) on every keystroke;
 * a search fires only on Enter / Refresh (Round-6 sources finding 10).
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const sourceLogs = vi.fn();
vi.mock('@/lib/api', () => ({
  api: { sourceLogs: (...a: unknown[]) => sourceLogs(...a) },
}));

import { SourceLogsSheet } from '../SourceLogsSheet';
import type { SourceInstance } from '@/lib/types';

const source = {
  id: 'es-1',
  source_type: 'elasticsearch',
  display_name: 'Prod ES',
  ingest_mode: 'pull',
  enabled: true,
  is_primary: true,
  config: {},
} as unknown as SourceInstance;

beforeEach(() => {
  sourceLogs.mockReset().mockResolvedValue({ source_id: 'es-1', mode: 'search', count: 0, logs: [] });
});

describe('SourceLogsSheet search (finding 10)', () => {
  it('does not fire a request while typing — only Enter runs the search', async () => {
    render(<SourceLogsSheet source={source} onClose={() => {}} />);

    // The initial auto-load has settled.
    await waitFor(() => expect(sourceLogs).toHaveBeenCalled());
    const afterLoad = sourceLogs.mock.calls.length;

    const input = await screen.findByLabelText('Search log events');
    fireEvent.change(input, { target: { value: 'failure' } });
    fireEvent.change(input, { target: { value: 'failure login' } });

    // Typing must NOT trigger any additional fetches.
    expect(sourceLogs.mock.calls.length).toBe(afterLoad);

    // Enter runs a single search, carrying the typed query.
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(sourceLogs.mock.calls.length).toBe(afterLoad + 1));
    const [, params] = sourceLogs.mock.calls[afterLoad];
    expect(params).toMatchObject({ query: 'failure login' });
  });
});
