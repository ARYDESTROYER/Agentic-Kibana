import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }));
vi.mock('@/lib/api', () => ({ api: {}, ApiError: class ApiError extends Error {} }));
vi.mock('@/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipContent: () => null,
}));

import {
  DeploymentUpdateButton,
  ReleaseBadge,
  UpstreamSourceNoticeButton,
} from '@/soc/AppShell';
import type { DeployedReleaseManifest } from '@/lib/deployment-update';
import type { ReleaseIdentity } from '@/lib/release';
import type { UpstreamReleaseNotice } from '@/lib/upstream-release';

const stableConsole: ReleaseIdentity = {
  version: '0.1.1',
  channel: 'stable',
  commitSha: 'abc123',
  buildTime: '2026-07-20T10:00:00Z',
};

describe('ReleaseBadge', () => {
  it('keeps the release context visible in the shell', () => {
    render(<ReleaseBadge consoleIdentity={{ ...stableConsole, channel: 'testing' }} />);
    expect(screen.getByTestId('release-badge')).toHaveTextContent('v0.1.1·Testing');
    expect(screen.getByTestId('release-badge')).toHaveAccessibleName(
      'Agentic SOC v0.1.1, Pre-release integration build',
    );
  });

  it('opens practical provenance and visibly downgrades a mismatched pair', async () => {
    render(
      <ReleaseBadge
        consoleIdentity={stableConsole}
        buildInfo={{
          service: 'tlsoc-agentic-triage',
          version: '0.1.1',
          release_channel: 'testing',
          commit_sha: 'different',
          build_time: '2026-07-20T10:01:00Z',
          state_backend: 'postgres',
          ocsf_version: '1.4.0',
        }}
      />,
    );

    const badge = screen.getByTestId('release-badge');
    expect(badge).toHaveTextContent('v0.1.1·Testing');
    expect(badge).toHaveAccessibleName(/build identity mismatch/i);

    fireEvent.click(badge);
    expect(await screen.findByText(/Console and backend build identities differ/i)).toBeVisible();
    expect(screen.getByText('Console build')).toBeVisible();
    expect(screen.getByText('Backend build')).toBeVisible();
    expect(screen.getAllByText('abc123')).toHaveLength(1);
    expect(screen.getAllByText('different')).toHaveLength(1);
  });

  it('explains why an unstamped pair remains Testing', async () => {
    render(
      <ReleaseBadge
        consoleIdentity={{
          version: '0.1.2', channel: 'stable', commitSha: 'unknown', buildTime: 'unknown',
        }}
        buildInfo={{
          service: 'tlsoc-agentic-triage',
          version: '0.1.2',
          release_channel: 'stable',
          commit_sha: 'unknown',
          build_time: 'unknown',
          state_backend: 'postgres',
          ocsf_version: '1.4.0',
          provenance_complete: false,
          provenance_missing: ['commit_sha', 'build_time'],
        }}
      />,
    );
    expect(screen.getByTestId('release-badge')).toHaveTextContent('v0.1.2·Testing');
    fireEvent.click(screen.getByTestId('release-badge'));
    expect(await screen.findByText(/Build provenance is incomplete/i)).toBeVisible();
  });
});

const deployedUpdate: DeployedReleaseManifest = {
  schema: 1,
  product: 'agentic-soc',
  version: '0.1.2',
  channel: 'testing',
  commitSha: 'next123',
  buildTime: '2026-07-31T08:00:00Z',
  entryId: '0.1.2-testing-next123-2026-07-31T08_00_00Z',
};

describe('DeploymentUpdateButton', () => {
  it('confirms a clean activation and restores focus when deferred', async () => {
    const onActivate = vi.fn();
    render(
      <DeploymentUpdateButton
        target={deployedUpdate}
        activating={false}
        hasUnsavedChanges={false}
        onActivate={onActivate}
      />,
    );
    const trigger = screen.getByRole('button', { name: /update agentic soc to v0\.1\.2/i });
    fireEvent.click(trigger);
    expect(screen.getByRole('alertdialog')).toBeVisible();
    expect(screen.getByText(/already deployed and verified against the backend/i)).toBeVisible();
    expect(screen.getByText(/backend jobs continue/i)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Keep working' }));
    await vi.waitFor(() => expect(trigger).toHaveFocus());

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Update now' }));
    expect(onActivate).toHaveBeenCalledOnce();
  });

  it('blocks activation while a registered draft is unsaved', () => {
    const onActivate = vi.fn();
    render(
      <DeploymentUpdateButton
        target={deployedUpdate}
        activating={false}
        hasUnsavedChanges
        onActivate={onActivate}
      />,
    );
    fireEvent.click(screen.getByTestId('deployment-update-button'));
    expect(screen.getByRole('alertdialog')).toHaveTextContent(/save or discard them before updating/i);
    expect(screen.queryByRole('button', { name: 'Update now' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Return to work' }));
    expect(onActivate).not.toHaveBeenCalled();
  });
});

const sourceNotice: UpstreamReleaseNotice = {
  kind: 'version',
  candidate: {
    channel: 'testing',
    branch: 'Testing',
    state: 'available',
    version: '0.1.2',
    commit_sha: 'source1234567890',
    commit_url: 'https://github.com/example/repository/commit/source1234567890',
    source_url: 'https://github.com/example/repository/tree/Testing',
    checked_at: '2026-07-31T08:00:00Z',
    stale: false,
    error_code: null,
    error_message: null,
  },
};

describe('UpstreamSourceNoticeButton', () => {
  it('explains that observed source is not a deployable update', async () => {
    render(<UpstreamSourceNoticeButton notice={sourceNotice} />);
    const trigger = screen.getByTestId('upstream-source-notice');
    expect(trigger).toHaveAccessibleName(/new source version v0\.1\.2 available on Testing/i);
    fireEvent.click(trigger);
    expect(await screen.findByText(/has not been deployed here yet/i)).toBeVisible();
    expect(screen.getByText(/Update button appears only after/i)).toBeVisible();
    expect(screen.getByRole('link', { name: /Review source commit/i })).toHaveAttribute(
      'href',
      sourceNotice.candidate.commit_url,
    );
  });

  it('describes same-version divergence without claiming a newer commit', async () => {
    render(<UpstreamSourceNoticeButton notice={{ ...sourceNotice, kind: 'revision' }} />);
    const trigger = screen.getByTestId('upstream-source-notice');
    expect(trigger).toHaveAccessibleName(/differs from this Console build/i);
    fireEvent.click(trigger);
    expect(await screen.findByText('Source revision differs')).toBeVisible();
    expect(screen.getByText(/currently points to a different commit/i)).toBeVisible();
    expect(screen.queryByText(/new source revision/i)).not.toBeInTheDocument();
  });
});
