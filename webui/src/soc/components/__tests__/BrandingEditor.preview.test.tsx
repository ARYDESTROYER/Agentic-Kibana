/**
 * WS-F task 8b — the BrandingEditor "Login preview" is a faithful, NON-CLIPPING
 * miniature.
 *
 * The old preview stuffed the full-size hero (p-12 / text-3xl / justify-between) into a
 * fixed 224px (`h-56`) `overflow-hidden` box, so the headline/chips/footer were clipped
 * and it looked broken. The fix renders the DESIGN-size login stage uniformly scaled
 * down inside an aspect-ratio box, so the whole hero fits and the arrangement matches
 * the selected layout. These tests lock the mechanism (no fixed 224px clip; a scaled
 * stage) and that switching layouts never crashes.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const getMock = vi.fn();
const putMock = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    get: (path: string) => getMock(path),
    put: (path: string, body: unknown) => putMock(path, body),
    getBranding: vi.fn().mockResolvedValue({}),
  },
}));

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
  login_headline: 'Triage at machine speed.',
  login_body: 'A body line.',
  login_chips: ['Audited', 'Cost-metered'],
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

describe('BrandingEditor — faithful login preview', () => {
  beforeEach(() => {
    getMock.mockReset().mockResolvedValue({ ...SAVED_BRANDING });
    putMock.mockReset().mockImplementation((_p: string, b: unknown) => Promise.resolve(b));
  });

  it('renders the preview as an aspect-ratio scaled stage, NOT a fixed 224px clip', async () => {
    const { container } = renderEditor();
    await screen.findByText('Login preview');

    // The preview box holds a fixed aspect ratio (fluid width) rather than the old
    // fixed 224px height that clipped the hero.
    const boxes = Array.from(container.querySelectorAll<HTMLElement>('div')).filter(
      (el) => el.style.aspectRatio,
    );
    expect(boxes.length).toBeGreaterThan(0);

    // The design-size stage is uniformly scaled down (transform: scale(...)), which is
    // what lets the whole hero fit without clipping.
    const scaled = Array.from(container.querySelectorAll<HTMLElement>('div')).filter((el) =>
      /scale\(/.test(el.style.transform || ''),
    );
    expect(scaled.length).toBeGreaterThan(0);

    // The old clipping fixed-height box is gone.
    expect(container.querySelector('.h-56')).toBeNull();
  });

  it('re-renders the preview for each layout without crashing', async () => {
    renderEditor();
    await screen.findByText('Login preview');

    const layout = screen.getByLabelText('Login layout');
    for (const opt of ['Centered card', 'Full-bleed hero', 'Split (brand hero + form)']) {
      fireEvent.click(layout);
      const item = await screen.findByText(opt);
      fireEvent.click(item);
      // The preview label is still present after the layout change (no crash).
      await waitFor(() => expect(screen.getByText('Login preview')).toBeInTheDocument());
    }
  });
});
