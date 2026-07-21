import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }));
vi.mock('@/lib/api', () => ({ api: {}, ApiError: class ApiError extends Error {} }));

import { ReleaseBadge } from '@/soc/AppShell';
import type { ReleaseIdentity } from '@/lib/release';

const stableConsole: ReleaseIdentity = {
  version: '0.1.0',
  channel: 'stable',
  commitSha: 'abc123',
  buildTime: '2026-07-20T10:00:00Z',
};

describe('ReleaseBadge', () => {
  it('keeps the release context visible in the shell', () => {
    render(<ReleaseBadge consoleIdentity={{ ...stableConsole, channel: 'testing' }} />);
    expect(screen.getByTestId('release-badge')).toHaveTextContent('v0.1.0·Testing');
    expect(screen.getByTestId('release-badge')).toHaveAccessibleName(
      'Agentic SOC v0.1.0, Pre-release integration build',
    );
  });

  it('opens practical provenance and visibly downgrades a mismatched pair', async () => {
    render(
      <ReleaseBadge
        consoleIdentity={stableConsole}
        buildInfo={{
          service: 'tlsoc-agentic-triage',
          version: '0.1.0',
          release_channel: 'testing',
          commit_sha: 'different',
          build_time: '2026-07-20T10:01:00Z',
          state_backend: 'postgres',
          ocsf_version: '1.4.0',
        }}
      />,
    );

    const badge = screen.getByTestId('release-badge');
    expect(badge).toHaveTextContent('v0.1.0·Testing');
    expect(badge).toHaveAccessibleName(/build identity mismatch/i);

    fireEvent.click(badge);
    expect(await screen.findByText(/Console and backend build identities differ/i)).toBeVisible();
    expect(screen.getByText('Console build')).toBeVisible();
    expect(screen.getByText('Backend build')).toBeVisible();
    expect(screen.getAllByText('abc123')).toHaveLength(1);
    expect(screen.getAllByText('different')).toHaveLength(1);
  });
});
