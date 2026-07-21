import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));

vi.mock('@/lib/api', () => ({ api: { post: postMock } }));
vi.mock('@/soc/components/Can', () => ({
  Can: ({ children }: { children: ReactNode }) => children,
}));

import { DataExportSection } from '../data-export';

const response = {
  format: 'agentic-soc-portable-export',
  format_version: 1,
  selection: { scopes: ['cases'] },
  limits: { items_per_scope: 1000, max_bytes: 26214400 },
  excluded: ['credentials', 'sessions', 'raw logs'],
  manifest: { cases: { count: 2, total: 2, truncated: false } },
  data: { cases: [{ case_id: 'case-1' }, { case_id: 'case-2' }] },
};

describe('DataExportSection', () => {
  beforeEach(() => {
    postMock.mockReset();
    postMock.mockResolvedValue(response);
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

  it('exports all safe scopes through the RBAC-protected backend contract', async () => {
    render(<DataExportSection />);
    fireEvent.click(screen.getByRole('button', { name: /export selected data/i }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('admin/export', {
        scopes: ['all'],
        limit_per_scope: 1000,
      }),
    );
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('sends an explicit scope list after one scope is cleared', async () => {
    render(<DataExportSection />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include Audit' }));
    fireEvent.click(screen.getByRole('button', { name: /export selected data/i }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock.mock.calls[0][1]).toEqual({
      scopes: ['cases', 'usage', 'configuration', 'automation', 'knowledge'],
      limit_per_scope: 1000,
    });
  });

  it('prevents an empty export selection', () => {
    render(<DataExportSection />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all export scopes' }));
    expect(screen.getByRole('button', { name: /export selected data/i })).toBeDisabled();
  });
});
