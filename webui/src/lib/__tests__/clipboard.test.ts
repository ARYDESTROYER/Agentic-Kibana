/**
 * clipboard — Round-6 fallback fixes.
 *
 *   1. the execCommand fallback (the plain-HTTP path) must RESTORE focus to the
 *      control the user activated, so keyboard/SR users keep their place and hear
 *      the "Copied" state change (WCAG 2.4.3);
 *   2. on iOS Safari a readOnly textarea + select() copies nothing, so the fallback
 *      selects via a Range instead.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { copyText } from '../clipboard';

const REAL_UA = window.navigator.userAgent;

function setUA(ua: string): void {
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
}

describe('copyText — execCommand fallback (non-secure / plain HTTP)', () => {
  let originalClipboard: unknown;
  let execSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Force the legacy path: pretend the async Clipboard API is unavailable, as it
    // is over plain HTTP (the documented `http://host:8080` deployment).
    originalClipboard = (navigator as unknown as { clipboard?: unknown }).clipboard;
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    execSpy = vi.fn(() => true);
    (document as unknown as { execCommand: unknown }).execCommand = execSpy;
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: originalClipboard, configurable: true });
    setUA(REAL_UA);
    vi.restoreAllMocks();
  });

  it('restores focus to the previously-focused control after the fallback copy', async () => {
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    btn.focus();
    expect(document.activeElement).toBe(btn);

    const ok = await copyText('hello');

    expect(ok).toBe(true);
    expect(execSpy).toHaveBeenCalledWith('copy');
    // Focus returned to the activating button — NOT stranded on <body>.
    expect(document.activeElement).toBe(btn);

    document.body.removeChild(btn);
  });

  it('does not throw when no meaningful element was focused (body active)', async () => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    await expect(copyText('x')).resolves.toBe(true);
  });

  it('resolves false when execCommand reports failure', async () => {
    execSpy.mockReturnValue(false);
    await expect(copyText('nope')).resolves.toBe(false);
  });

  it('resolves false (never throws) when execCommand throws', async () => {
    execSpy.mockImplementation(() => {
      throw new Error('denied');
    });
    await expect(copyText('boom')).resolves.toBe(false);
  });

  it('leaves no injected <textarea> behind in the DOM', async () => {
    await copyText('cleanup');
    expect(document.querySelector('textarea[aria-hidden="true"]')).toBeNull();
  });

  it('iOS: selects via a Range so execCommand has content to copy', async () => {
    setUA(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)',
    );
    const rangeSpy = vi.spyOn(document, 'createRange');

    const ok = await copyText('ios-value');

    expect(ok).toBe(true);
    // The Range-based selection path ran (desktop uses select() and never touches
    // createRange), proving the iOS quirk is handled.
    expect(rangeSpy).toHaveBeenCalled();
  });
});

describe('copyText — async Clipboard API (secure context)', () => {
  it('uses navigator.clipboard.writeText and never falls back', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const execSpy = vi.fn(() => true);
    (document as unknown as { execCommand: unknown }).execCommand = execSpy;
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    const ok = await copyText('secure');

    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith('secure');
    expect(execSpy).not.toHaveBeenCalled();

    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  });
});
