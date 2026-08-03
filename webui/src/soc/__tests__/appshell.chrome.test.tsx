/**
 * AppShell chrome unit tests (Round-6 shell-chrome batch).
 *
 * Covers two shell-chrome fixes:
 *   - `healthView` returns a NEUTRAL "Checking…" state before the first /api/health
 *     resolves (health === null, not yet failed twice) instead of falsely flashing the
 *     amber "State store unreachable" warning on every fresh load / the first ~15s of a
 *     total backend outage.
 *   - `UserAvatar` re-syncs its broken-image fallback when the `src` prop changes, so a
 *     one-time onError never permanently pins the initials placeholder for a NEW URL.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }));
vi.mock('@/lib/api', () => ({ api: {}, ApiError: class ApiError extends Error {} }));

import { healthView, UserAvatar } from '@/soc/AppShell';
import type { HealthResponse } from '@/lib/types';

const health = (partial: Partial<HealthResponse>): HealthResponse => partial as HealthResponse;

describe('healthView — first-paint / pre-response neutral state', () => {
  it('shows a muted "Checking…" note before the first health response (null, not errored)', () => {
    const v = healthView(null, false);
    expect(v.tone).toBe('muted');
    expect(v.label).toBe('Checking…');
    // It must NOT mislabel an unknown store as "State store unreachable".
    expect(v.label).not.toBe('State store unreachable');
  });

  it('shows the critical "Backend unreachable" pill once errored (2 consecutive fails)', () => {
    const v = healthView(null, true);
    expect(v.tone).toBe('critical');
    expect(v.label).toBe('Backend unreachable');
  });

  it('shows Healthy when the store is connected + persistent', () => {
    const v = healthView(health({ es_connected: true, store_type: 'EsClient' }), false);
    expect(v.tone).toBe('success');
    expect(v.label).toBe('Healthy');
  });

  it('prefers the explicit owned-state field over the legacy alias', () => {
    const v = healthView(
      health({
        state_store_connected: true,
        es_connected: false,
        state_backend: 'postgres',
        store_type: 'PostgresStateStore',
      }),
      false,
    );
    expect(v.tone).toBe('success');
    expect(v.label).toBe('Healthy');
  });

  it('still surfaces a real unreachable store once health resolved with es_connected=false', () => {
    const v = healthView(health({ es_connected: false, store_type: 'EsClient' }), false);
    expect(v.tone).toBe('warning');
    expect(v.label).toBe('State store unreachable');
  });
});

describe('UserAvatar — broken fallback resets on src change', () => {
  it('falls back to initials on error, then renders the image again for a new src', () => {
    const { rerender, container } = render(
      <UserAvatar src="http://example.test/a.png" name="Jane Doe" />,
    );
    // Image renders initially.
    expect(container.querySelector('img')).toBeInTheDocument();

    // Simulate a load failure → initials fallback (no <img>).
    fireEvent.error(container.querySelector('img') as HTMLImageElement);
    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(screen.getByText('JD')).toBeInTheDocument();

    // A NEW valid src must re-render the image (broken flag re-synced).
    rerender(<UserAvatar src="http://example.test/b.png" name="Jane Doe" />);
    expect(container.querySelector('img')).toBeInTheDocument();
  });
});
