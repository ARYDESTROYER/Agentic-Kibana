/**
 * Toaster — the sonner theme follows the app's RESOLVED light/dark (passed in by
 * the ThemeProvider mount) instead of hardcoding `system` (round-6 ui-theme #54).
 * We assert the wrapper forwards the `theme` prop through to sonner's <Toaster>.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

const sonnerSpy = vi.fn();
vi.mock('sonner', () => ({
  Toaster: (props: Record<string, unknown>) => {
    sonnerSpy(props);
    return null;
  },
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { Toaster } from '../sonner';

describe('Toaster — theme prop wiring', () => {
  beforeEach(() => sonnerSpy.mockClear());

  it('forwards an explicit dark theme to sonner', () => {
    render(<Toaster theme="dark" />);
    expect(sonnerSpy).toHaveBeenCalled();
    expect(sonnerSpy.mock.calls[0][0].theme).toBe('dark');
  });

  it('forwards an explicit light theme to sonner', () => {
    render(<Toaster theme="light" />);
    expect(sonnerSpy.mock.calls[0][0].theme).toBe('light');
  });

  it('falls back to system when no theme is passed (standalone default)', () => {
    render(<Toaster />);
    expect(sonnerSpy.mock.calls[0][0].theme).toBe('system');
  });
});
