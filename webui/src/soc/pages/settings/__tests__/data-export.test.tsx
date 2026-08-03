import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const { postMock, postAbortableMock } = vi.hoisted(() => ({
  postMock: vi.fn(),
  postAbortableMock: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { ...actual.api, post: postMock, postAbortable: postAbortableMock },
  };
});
vi.mock('@/soc/components/Can', () => ({
  Can: ({ children }: { children: ReactNode }) => children,
}));

import { DataExportSection } from '../data-export';

function response(scope: string, part = 1, complete = true, cursor: string | null = null) {
  return {
    format: 'agentic-soc-portable-export-segment',
    format_version: 2,
    selection: { scope },
    consistency: { mode: 'point_in_time', exact: true, detail: 'fixed snapshot' },
    segment: {
      number: part,
      count: 2,
      cumulative_count: part * 2,
      snapshot_total: complete ? part * 2 : 4,
      remaining: complete ? 0 : 2,
      complete,
      status: complete ? 'complete' : 'partial',
      next_cursor: cursor,
    },
    records: [{ record: { id: `${scope}-${part}-1` } }, { record: { id: `${scope}-${part}-2` } }],
  };
}

describe('DataExportSection', () => {
  beforeEach(() => {
    postMock.mockReset();
    postMock.mockResolvedValue({ ok: true });
    postAbortableMock.mockReset();
    postAbortableMock.mockImplementation((_path: string, body: { scope: string }) =>
      Promise.resolve(response(body.scope)),
    );
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:agentic-soc-export'),
      revokeObjectURL: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('automatically exports every selected scope through the resumable endpoint', async () => {
    render(<DataExportSection />);
    fireEvent.click(screen.getByRole('button', { name: /export selected data/i }));

    await waitFor(() => expect(postAbortableMock).toHaveBeenCalledTimes(6));
    expect(postAbortableMock.mock.calls.map((call) => call[1].scope)).toEqual([
      'cases', 'audit', 'usage', 'configuration', 'automation', 'knowledge',
    ]);
    expect(postAbortableMock.mock.calls[0][1]).toEqual({
      scope: 'cases', cursor: null, page_size: 1000,
    });
    expect(URL.createObjectURL).toHaveBeenCalledTimes(6);
  });

  it('follows continuation cursors until the scope explicitly reports complete', async () => {
    postAbortableMock
      .mockResolvedValueOnce(response('cases', 1, false, 'cursor-2'))
      .mockResolvedValueOnce(response('cases', 2, true, null));
    render(<DataExportSection />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all export scopes' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include Cases' }));
    fireEvent.click(screen.getByRole('button', { name: /export selected data/i }));

    await waitFor(() => expect(postAbortableMock).toHaveBeenCalledTimes(2));
    expect(postAbortableMock.mock.calls[1][1]).toEqual({
      scope: 'cases', cursor: 'cursor-2', page_size: 1000,
    });
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
  });

  it('downloads the compact segment payload without pretty-print inflation', async () => {
    const segment = response('cases');
    const blobConstructor = vi.fn();
    vi.stubGlobal('Blob', blobConstructor);
    postAbortableMock.mockResolvedValueOnce(segment);
    render(<DataExportSection />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all export scopes' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include Cases' }));
    fireEvent.click(screen.getByRole('button', { name: /export selected data/i }));

    await waitFor(() => expect(blobConstructor).toHaveBeenCalledTimes(1));
    expect(blobConstructor).toHaveBeenCalledWith(
      [JSON.stringify(segment)],
      { type: 'application/json' },
    );
    expect(JSON.stringify(segment)).not.toContain('\n');
  });

  it('prevents an empty export selection', () => {
    render(<DataExportSection />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all export scopes' }));
    expect(screen.getByRole('button', { name: /export selected data/i })).toBeDisabled();
  });

  it('best-effort releases the active cursor after a non-cancellation failure', async () => {
    postAbortableMock
      .mockResolvedValueOnce(response('cases', 1, false, 'cursor-2'))
      .mockRejectedValueOnce(new Error('backend failed'));
    render(<DataExportSection />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all export scopes' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include Cases' }));
    fireEvent.click(screen.getByRole('button', { name: /export selected data/i }));

    await waitFor(() => expect(postMock).toHaveBeenCalledWith(
      'admin/export/segment/cancel',
      { scope: 'cases', cursor: 'cursor-2' },
    ));
  });
});
