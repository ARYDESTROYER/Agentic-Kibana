/**
 * Wave 7a (email) — Resend/SES channels + the email TEMPLATE editor + preview pane.
 *
 * Verifies that the new email-style channels surface in the add-channel picker, that
 * Resend/SES channel cards render their provider note + provider-specific config, and
 * that the template editor renders, lists variables, and calls the SERVER-side preview
 * endpoint (the server is authoritative for escaping) — surfacing the rendered subject
 * + plain-text part. The api surface is mocked so no network is touched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api', () => ({
  api: {
    notifications: {
      providers: vi.fn().mockResolvedValue({
        email_presets: [
          { id: 'gmail', host: 'smtp.gmail.com', port: 587, security: 'starttls', username_hint: 'app password' },
          { id: 'custom', host: '', port: 0, security: 'starttls', username_hint: '' },
        ],
        channel_types: ['email', 'resend', 'ses', 'slack', 'teams', 'webhook', 'pagerduty', 'telegram'],
      }),
      test: vi.fn().mockResolvedValue({ ok: true, detail: 'ok' }),
      channelSecret: vi.fn().mockResolvedValue({ ok: true, configured: true, configured_secrets: ['secret'] }),
      preview: vi.fn().mockResolvedValue({
        trigger: 'case.new',
        subject: '[Acme SOC] New case: phishing wave',
        html: '<h2>phishing wave</h2><p>Risk 80</p>',
        text: 'New case\nRisk: 80\nhttps://soc.example.com/cases/abc',
        variables: ['org_name', 'case_id', 'title', 'risk_score'],
        is_override: false,
      }),
    },
  },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn(), warning: vi.fn() } }));

import { NotificationsEditor } from '../components/NotificationsEditor';
import { TooltipProvider } from '@/ui/tooltip';
import { api } from '@/lib/api';
import type { Preferences } from '@/lib/types';

const previewMock = vi.mocked(api.notifications.preview);

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

describe('NotificationsEditor — Resend / SES channels', () => {
  beforeEach(() => vi.clearAllMocks());

  it('offers Resend and Amazon SES in the add-channel picker', () => {
    setup({ notifications: { enabled: true, channels: [] } });
    fireEvent.click(screen.getByRole('button', { name: /Add channel/i }));
    expect(screen.getByText('Resend')).toBeInTheDocument();
    expect(screen.getByText('Amazon SES')).toBeInTheDocument();
  });

  it('renders a Resend channel with its domain-verification note + From + secret label', () => {
    setup({
      notifications: {
        enabled: true,
        channels: [
          {
            id: 'resend-1',
            type: 'resend',
            enabled: true,
            name: 'Resend prod',
            config: { from_addr: 'soc@acme.com', recipients: ['a@x.com'] },
            configured_secrets: [],
          },
        ],
      },
    });
    expect(screen.getByDisplayValue('Resend prod')).toBeInTheDocument();
    expect(screen.getByText(/verified in the Resend dashboard/i)).toBeInTheDocument();
    expect(screen.getByText(/Resend API key/i)).toBeInTheDocument();
  });

  it('renders an SES channel with its sandbox note + region + IAM key id', () => {
    setup({
      notifications: {
        enabled: true,
        channels: [
          {
            id: 'ses-1',
            type: 'ses',
            enabled: true,
            name: 'SES east',
            config: { region: 'us-east-1', recipients: [] },
            configured_secrets: [],
          },
        ],
      },
    });
    expect(screen.getByText(/SANDBOX/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue('us-east-1')).toBeInTheDocument();
    // Exact label match: the field's HelpTip carries the accessible name "AWS region help",
    // so a loose /AWS region/i would ambiguously match both the input and the help button.
    expect(screen.getByLabelText('AWS region')).toBeInTheDocument();
    expect(screen.getByText(/IAM access key id/i)).toBeInTheDocument();
  });
});

describe('NotificationsEditor — template editor + preview', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the template editor with a trigger picker and variable reference', () => {
    setup({ notifications: { enabled: true, channels: [] } });
    expect(screen.getByText('Email templates')).toBeInTheDocument();
    expect(screen.getByLabelText('Template trigger')).toBeInTheDocument();
    // default variable reference list is shown before any preview
    expect(screen.getByText('{{case_id}}')).toBeInTheDocument();
    expect(screen.getByLabelText('Template HTML body')).toBeInTheDocument();
  });

  it('calls the server-side preview and shows the rendered subject + text part', async () => {
    setup({ notifications: { enabled: true, channels: [] } });
    fireEvent.click(screen.getByRole('button', { name: /Render preview/i }));
    await waitFor(() => expect(previewMock).toHaveBeenCalled());
    // server is authoritative for escaping; the trigger is passed through
    expect(previewMock.mock.calls[0][0]).toBe('case.new');
    await waitFor(() =>
      expect(screen.getByText(/New case: phishing wave/)).toBeInTheDocument(),
    );
    // the server-rendered HTML lands in a SANDBOXED iframe (verbatim, already escaped)
    const frame = screen.getByTitle('Email HTML preview') as HTMLIFrameElement;
    expect(frame).toHaveAttribute('sandbox', '');
    expect(frame.getAttribute('srcdoc') || '').toContain('phishing wave');
    // switch to the plain-text tab and assert the server text part is rendered
    await userEvent.click(screen.getByRole('tab', { name: /Plain text/i }));
    await waitFor(() =>
      expect(
        screen.getByText(
          (_, el) => el?.tagName === 'PRE' && el.textContent?.includes('Risk: 80') === true,
        ),
      ).toBeInTheDocument(),
    );
  });

  it('passes the unsaved draft override to the preview endpoint', async () => {
    setup({ notifications: { enabled: true, channels: [] } });
    const subj = screen.getByLabelText('Template subject');
    fireEvent.change(subj, { target: { value: '[{{org_name}}] custom {{title}}' } });
    fireEvent.click(screen.getByRole('button', { name: /Render preview/i }));
    await waitFor(() => expect(previewMock).toHaveBeenCalled());
    expect(previewMock.mock.calls[0][1]).toMatchObject({
      subject: '[{{org_name}}] custom {{title}}',
    });
  });
});
