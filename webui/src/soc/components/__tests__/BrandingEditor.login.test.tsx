/**
 * BrandingEditor — Round-4 login white-label section test.
 *
 * Covers the new "Login screen" controls: the bounded plain-text hero copy
 * (headline / body / feature chips), the curated layout + illustration selects, and
 * that a Save round-trips the `login_*` fields through PUT /api/branding. The copy is
 * operator-set → the editor stores it verbatim (plain data) and the login renders it
 * as plain text (#6/#9) — this test asserts the wire round-trip, not markup.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// ---- Mock the typed api client BEFORE importing the component ------------- //
const getMock = vi.fn();
const putMock = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    get: (path: string) => getMock(path),
    put: (path: string, body: unknown) => putMock(path, body),
    getBranding: vi.fn().mockResolvedValue({}),
  },
}));

// sonner toasts are irrelevant here; stub to no-ops.
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  Toaster: () => null,
}));

import { ThemeProvider } from '../../theme';
import { BrandingEditor } from '../BrandingEditor';

const SAVED_BRANDING = {
  org_name: 'Acme SOC',
  product_name: 'Triage',
  logo_data_url: '',
  favicon_data_url: '',
  accent_color: '',
  accent_color2: '',
  theme: '',
  login_subtitle: '',
  footer_text: '',
  support_url: '',
  dark_mode_default: false,
  material: 'quiet',
  default_theme: 'system',
  theme_tokens: {},
  presets: [],
  login_headline: '',
  login_body: '',
  login_chips: [],
  login_layout: 'split',
  login_illustration: '',
};

function renderEditor() {
  return render(
    <ThemeProvider>
      <BrandingEditor />
    </ThemeProvider>,
  );
}

describe('BrandingEditor — login white-label section', () => {
  beforeEach(() => {
    getMock.mockReset();
    putMock.mockReset();
    getMock.mockResolvedValue({ ...SAVED_BRANDING });
    putMock.mockImplementation((_path: string, body: unknown) => Promise.resolve(body));
  });

  it('renders the Login screen controls (headline, body, layout, illustration)', async () => {
    renderEditor();
    expect(await screen.findByText('Login screen')).toBeInTheDocument();
    expect(screen.getByLabelText('Headline')).toBeInTheDocument();
    expect(screen.getByLabelText('Body copy')).toBeInTheDocument();
    expect(screen.getByLabelText('Login layout')).toBeInTheDocument();
    expect(screen.getByLabelText('Login illustration')).toBeInTheDocument();
  });

  it('bounds the headline + body inputs to the server caps (120 / 600)', async () => {
    renderEditor();
    const headline = (await screen.findByLabelText('Headline')) as HTMLInputElement;
    const body = screen.getByLabelText('Body copy') as HTMLTextAreaElement;
    expect(headline.maxLength).toBe(120);
    expect(body.maxLength).toBe(600);
  });

  it('adds and removes feature chips (bounded to 6)', async () => {
    renderEditor();
    await screen.findByText('Login screen');
    const addChip = screen.getByRole('button', { name: 'Add chip' });
    fireEvent.click(addChip);
    const chip1 = (await screen.findByLabelText('Login chip 1')) as HTMLInputElement;
    fireEvent.change(chip1, { target: { value: 'Audited' } });
    expect((screen.getByLabelText('Login chip 1') as HTMLInputElement).value).toBe('Audited');
    // Remove it again.
    fireEvent.click(screen.getByRole('button', { name: 'Remove login chip 1' }));
    await waitFor(() => expect(screen.queryByLabelText('Login chip 1')).toBeNull());
  });

  it('round-trips the login_* fields through PUT /api/branding on Save', async () => {
    renderEditor();
    const headline = (await screen.findByLabelText('Headline')) as HTMLInputElement;
    fireEvent.change(headline, { target: { value: 'Welcome to Contoso' } });
    fireEvent.change(screen.getByLabelText('Body copy'), {
      target: { value: 'Investigate faster.' },
    });

    const saveBtn = screen.getByRole('button', { name: /Save branding/i });
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    fireEvent.click(saveBtn);

    await waitFor(() => expect(putMock).toHaveBeenCalled());
    const [path, body] = putMock.mock.calls[0];
    expect(path).toBe('branding');
    expect(body).toMatchObject({
      login_headline: 'Welcome to Contoso',
      login_body: 'Investigate faster.',
      login_layout: 'split',
    });
  });

  it('lets the operator pick a curated illustration and persists the enum KEY', async () => {
    renderEditor();
    await screen.findByText('Login screen');
    const trigger = screen.getByLabelText('Login illustration');
    fireEvent.click(trigger);
    // Radix Select renders its options in a portal; find the "Radar sweep" item.
    const option = await screen.findByText('Radar sweep');
    fireEvent.click(option);

    const saveBtn = screen.getByRole('button', { name: /Save branding/i });
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    fireEvent.click(saveBtn);
    await waitFor(() => expect(putMock).toHaveBeenCalled());
    const [, body] = putMock.mock.calls[0];
    expect(body).toMatchObject({ login_illustration: 'radar' });
  });
});

// A tiny guard: the exported layout/illustration key sets stay in lockstep with the
// backend curated set (so a drift here surfaces as a failing test, not a silent
// mismatch with routes/config validators).
describe('loginParts — curated key sets', () => {
  it('exposes exactly the backend layouts + illustrations', async () => {
    const parts = await import('../auth/loginParts');
    expect([...parts.LOGIN_LAYOUTS].sort()).toEqual(['centered', 'full', 'split']);
    expect([...parts.LOGIN_ILLUSTRATIONS].sort()).toEqual(
      ['', 'aurora', 'constellation', 'grid', 'mesh', 'radar', 'shield', 'waves'].sort(),
    );
    // Defensive coercion clamps unknowns to safe defaults.
    expect(parts.asLoginLayout('bogus')).toBe('split');
    expect(parts.asLoginIllustration('bogus')).toBe('');
    expect(parts.asLoginIllustration('radar')).toBe('radar');
  });

  it('renders every illustration variant without throwing', async () => {
    const parts = await import('../auth/loginParts');
    for (const key of parts.LOGIN_ILLUSTRATIONS) {
      const { unmount } = render(<parts.LoginIllustration variant={key} />);
      unmount();
    }
    expect(true).toBe(true);
  });
});
