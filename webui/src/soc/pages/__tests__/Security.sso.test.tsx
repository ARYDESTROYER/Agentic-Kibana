/**
 * Security SSO provider editor (Round 6 admin-misc, findings #24 / #25).
 *
 * #24: the Group→role map <textarea> used a STATIC id="sso-group-role-map", so with
 *      2+ providers the DOM had duplicate ids and the label focused the wrong control.
 *      FIX: namespace the id/htmlFor per provider (matching the `en-`/`acu-` pattern).
 * #25: it was a raw <textarea> off the design tokens. FIX: the shared Textarea primitive
 *      (border-input + branded focus ring).
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getSettings: vi.fn().mockResolvedValue({ prefs: {}, configured: {} }),
      putSettings: vi.fn().mockResolvedValue({}),
    },
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { TooltipProvider } from '@/ui/tooltip';
import { api } from '@/lib/api';
import { SecuritySsoInner } from '../Security';

/* eslint-disable @typescript-eslint/no-explicit-any */
const providers = [
  { id: 'google-abc', type: 'google', enabled: true, client_id: '', group_role_map: {}, allowed_domains: [], allowed_tenants: [] },
  { id: 'generic-xyz', type: 'generic', enabled: true, client_id: '', group_role_map: {}, allowed_domains: [], allowed_tenants: [] },
];

function renderSso() {
  return render(
    <TooltipProvider>
      <SecuritySsoInner
        prefs={{ sso: { enabled: true, providers }, session_policy: {} } as any}
        update={vi.fn()}
        configured={{}}
      />
    </TooltipProvider>,
  );
}

describe('Security SSO group→role map', () => {
  it('namespaces the group-role-map id per provider (#24 — no duplicate DOM ids)', () => {
    const { container } = renderSso();
    const maps = container.querySelectorAll('[id^="sso-group-role-map-"]');
    expect(maps).toHaveLength(2);
    const ids = Array.from(maps).map((el) => el.id);
    expect(new Set(ids).size).toBe(2); // unique
    expect(ids).toContain('sso-group-role-map-google-abc');
    expect(ids).toContain('sso-group-role-map-generic-xyz');
  });

  it('renders through the shared Textarea primitive (#25 — control-border token)', () => {
    const { container } = renderSso();
    const first = container.querySelector('#sso-group-role-map-google-abc') as HTMLElement;
    expect(first.tagName.toLowerCase()).toBe('textarea');
    // The primitive uses `border-input` (the control-border token), not `border-border`.
    expect(first.className).toContain('border-input');
  });

  it('keeps failed standalone reads unavailable until an explicit retry succeeds', async () => {
    vi.mocked(api.getSettings)
      .mockRejectedValue(new Error('settings unavailable'));

    render(
      <TooltipProvider>
        <SecuritySsoInner />
      </TooltipProvider>,
    );

    const heading = await screen.findByText('Could not load single sign-on settings');
    expect(screen.queryByLabelText('Enable single sign-on')).not.toBeInTheDocument();

    vi.mocked(api.getSettings).mockResolvedValue({ prefs: {}, configured: {} } as any);
    const alert = heading.closest('[role="alert"]');
    expect(alert).not.toBeNull();
    fireEvent.click(within(alert as HTMLElement).getByRole('button', { name: 'Retry' }));

    expect(await screen.findByLabelText('Enable single sign-on')).toBeInTheDocument();
  });
});
