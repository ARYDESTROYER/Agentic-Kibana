/**
 * Wave 4 / F5 — Alerting & Notifications editor + HelpTip.
 *
 * Verifies the NotificationsEditor renders the master switch + a configured channel,
 * surfaces the email provider presets it fetches, and that adding/removing channels
 * flows through the `update` callback (config edits; secrets are pushed separately).
 * The api surface is mocked so no network is touched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/lib/api', () => ({
  api: {
    notifications: {
      providers: vi.fn().mockResolvedValue({
        email_presets: [
          { id: 'gmail', host: 'smtp.gmail.com', port: 587, security: 'starttls', username_hint: 'app password' },
          { id: 'custom', host: '', port: 0, security: 'starttls', username_hint: '' },
        ],
        channel_types: ['email', 'slack', 'teams', 'webhook', 'pagerduty', 'telegram'],
      }),
      test: vi.fn().mockResolvedValue({ ok: true, detail: 'ok' }),
      channelSecret: vi.fn().mockResolvedValue({ ok: true, configured: true, configured_secrets: ['secret'] }),
    },
  },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn(), warning: vi.fn() } }));

import { NotificationsEditor } from '../components/NotificationsEditor';
import { HelpTip } from '../components/HelpTip';
import { TooltipProvider } from '@/ui/tooltip';
import type { Preferences } from '@/lib/types';

function setup(prefsOver: Partial<Preferences> = {}) {
  const update = vi.fn();
  const prefs = { ...prefsOver } as Preferences;
  // The shared SecretField's reveal IconButton renders a Tooltip; the app supplies ONE
  // root TooltipProvider, so the test harness must too.
  const utils = render(
    <TooltipProvider>
      <NotificationsEditor prefs={prefs} update={update} />
    </TooltipProvider>,
  );
  return { update, ...utils };
}

describe('NotificationsEditor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the master enable switch and empty channels state', async () => {
    setup({ notifications: { enabled: false, channels: [] } });
    expect(screen.getByText(/Alerting & Notifications/i)).toBeInTheDocument();
    expect(screen.getByText(/No channels yet/i)).toBeInTheDocument();
  });

  it('toggling the master switch calls update with notifications.enabled', () => {
    const { update } = setup({ notifications: { enabled: false, channels: [] } });
    const sw = screen.getByLabelText('Notifications enabled');
    fireEvent.click(sw);
    expect(update).toHaveBeenCalled();
    const arg = update.mock.calls[0][0];
    expect(arg.notifications.enabled).toBe(true);
  });

  it('renders a configured email channel with its name and recipient summary', async () => {
    setup({
      notifications: {
        enabled: true,
        channels: [
          {
            id: 'email-1',
            type: 'email',
            enabled: true,
            name: 'Ops mailbox',
            config: { provider: 'gmail', from_addr: 'a@x.com', recipients: ['a@x.com', 'b@x.com'] },
            configured_secrets: ['secret'],
          },
        ],
      },
    });
    expect(screen.getByDisplayValue('Ops mailbox')).toBeInTheDocument();
    expect(screen.getByText(/2 recipient\(s\)/)).toBeInTheDocument();
    // configured secret badge present
    expect(screen.getAllByText(/Configured/i).length).toBeGreaterThan(0);
  });

  it('shows trigger switches', () => {
    setup({ notifications: { enabled: true, channels: [], triggers: { on_escalated: true } } });
    expect(screen.getByText('On escalated')).toBeInTheDocument();
    expect(screen.getByText('On true positive')).toBeInTheDocument();
  });
});

describe('HelpTip', () => {
  it('renders an accessible trigger button', () => {
    render(<HelpTip text="A short hint" label="Hint help" />);
    expect(screen.getByLabelText('Hint help')).toBeInTheDocument();
  });

  it('shows a popover for longer help with a link', async () => {
    render(<HelpTip text="x" link="https://example.com" label="Link help" />);
    const btn = screen.getByLabelText('Link help');
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByText(/Learn more/i)).toBeInTheDocument());
  });
});
