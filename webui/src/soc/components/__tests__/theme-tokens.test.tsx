/**
 * Design-system layer regression coverage (Round 3, Stage 1):
 *   - `applyTokens` writes ONLY allow-listed, sanitised CSS custom properties —
 *     unknown keys + unsafe values (url()/braces/semicolons/expression/long) are
 *     dropped, so an operator/branding payload can never inject arbitrary CSS (#10/#9).
 *   - `applyBranding` resolves accent + material + bounded token overrides, with
 *     theme_tokens winning over the accent/material defaults.
 *   - `resolveDark` honours the explicit-user > org-default > OS precedence.
 *   - `GlassSurface` carries the `glass-surface` reduced-transparency marker class
 *     so the media rule can neutralise its blur, and renders a translucent token fill.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import {
  applyTokens,
  sanitizeTokenValue,
  applyBranding,
  resolveDark,
  effectiveBrandingTheme,
  resolveMaterial,
  ALLOWED_TOKENS,
  ACCENT_PRESETS,
  MATERIAL_PACKS,
  hexToHslTriplet,
} from '../../theme-tokens';
import { GlassSurface } from '../GlassSurface';

function freshRoot(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

describe('applyTokens — allow-listing + sanitisation (#10/#9)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = freshRoot();
  });

  it('writes an allow-listed token (with and without the -- prefix)', () => {
    const written = applyTokens({ '--primary': '210 90% 50%', radius: '0.5rem' }, root);
    expect(written).toContain('--primary');
    expect(written).toContain('--radius');
    expect(root.style.getPropertyValue('--primary')).toBe('210 90% 50%');
    expect(root.style.getPropertyValue('--radius')).toBe('0.5rem');
  });

  it('DROPS unknown / non-allow-listed properties', () => {
    const written = applyTokens(
      { '--evil': 'red', '--background': '0 0% 0%', position: 'fixed' },
      root,
    );
    expect(written).toEqual([]);
    expect(root.style.getPropertyValue('--evil')).toBe('');
    // --background is intentionally NOT in the allow-list (only tints are).
    expect(root.style.getPropertyValue('--background')).toBe('');
  });

  it('rejects values that could break out of a declaration', () => {
    const dangerous = [
      'red; position: fixed',
      'url(javascript:alert(1))',
      'expression(alert(1))',
      'blue } body {',
      'red /* x */',
      '<script>',
      'a\\b',
      'x'.repeat(300),
    ];
    for (const v of dangerous) {
      expect(sanitizeTokenValue('--primary', v)).toBeNull();
    }
    const written = applyTokens({ '--primary': 'url(x)' }, root);
    expect(written).toEqual([]);
    expect(root.style.getPropertyValue('--primary')).toBe('');
  });

  it('restricts --font-display to the vetted font enum', () => {
    expect(sanitizeTokenValue('--font-display', 'inter')).toContain('Inter');
    expect(sanitizeTokenValue('--font-display', 'grotesk')).toContain('Space Grotesk');
    // An arbitrary family is rejected (no injection of foreign @font-face refs).
    expect(sanitizeTokenValue('--font-display', 'Comic Sans')).toBeNull();
  });

  it('every ALLOWED_TOKENS entry is a -- custom property', () => {
    for (const t of ALLOWED_TOKENS) expect(t.startsWith('--')).toBe(true);
  });
});

describe('hexToHslTriplet', () => {
  it('converts hex to an "H S% L%" triple and rejects junk', () => {
    expect(hexToHslTriplet('#000000')).toBe('0 0% 0%');
    expect(hexToHslTriplet('#ffffff')).toBe('0 0% 100%');
    expect(hexToHslTriplet('#fff')).toBe('0 0% 100%');
    expect(hexToHslTriplet('not-a-hex')).toBeNull();
    expect(hexToHslTriplet('rgb(0,0,0)')).toBeNull();
  });
});

describe('applyBranding — accent + material + token overrides', () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = freshRoot();
  });

  it('quiet branding leaves the chrome at the quiet pack (identity)', () => {
    const mat = applyBranding({ material: 'quiet' }, root);
    expect(mat).toBe('quiet');
    expect(root.style.getPropertyValue('--grid-opacity')).toBe('0');
    expect(root.style.getPropertyValue('--glow-strength')).toBe('0');
  });

  it('command material raises the chrome vars', () => {
    const mat = applyBranding({ material: 'command' }, root);
    expect(mat).toBe('command');
    expect(root.style.getPropertyValue('--grid-opacity')).toBe(MATERIAL_PACKS.command['--grid-opacity']);
    expect(Number(root.style.getPropertyValue('--glow-strength'))).toBeGreaterThan(0);
  });

  it('accent_color drives --primary/--ring; accent_color2 drives --accent2', () => {
    applyBranding({ accent_color: '#1f6feb', accent_color2: '#6366f1' }, root);
    expect(root.style.getPropertyValue('--primary')).toBe(hexToHslTriplet('#1f6feb'));
    expect(root.style.getPropertyValue('--ring')).toBe(hexToHslTriplet('#1f6feb'));
    expect(root.style.getPropertyValue('--accent2')).toBe(hexToHslTriplet('#6366f1'));
  });

  it('theme_tokens override the accent default (applied last) and stay allow-listed', () => {
    applyBranding(
      { accent_color: '#1f6feb', theme_tokens: { '--primary': '120 50% 40%', '--evil': 'x' } },
      root,
    );
    expect(root.style.getPropertyValue('--primary')).toBe('120 50% 40%');
    expect(root.style.getPropertyValue('--evil')).toBe('');
  });

  it('clearing accent restores the stylesheet default (no stale inline override)', () => {
    applyBranding({ accent_color: '#1f6feb' }, root);
    expect(root.style.getPropertyValue('--primary')).not.toBe('');
    applyBranding({}, root); // empty branding
    expect(root.style.getPropertyValue('--primary')).toBe('');
  });

  it('exports AA accent presets with valid hex', () => {
    expect(ACCENT_PRESETS.length).toBeGreaterThanOrEqual(4);
    for (const p of ACCENT_PRESETS) {
      expect(hexToHslTriplet(p.hex)).not.toBeNull();
      if (p.hex2) expect(hexToHslTriplet(p.hex2)).not.toBeNull();
    }
  });
});

describe('resolveDark — explicit > org-default > OS precedence', () => {
  it('explicit user choice always wins over branding', () => {
    expect(resolveDark('dark', { default_theme: 'light' })).toBe(true);
    expect(resolveDark('light', { default_theme: 'dark' })).toBe(false);
  });

  it('on system, the org default decides', () => {
    expect(resolveDark('system', { default_theme: 'dark' })).toBe(true);
    expect(resolveDark('system', { default_theme: 'light' })).toBe(false);
    // legacy dark_mode_default still forces dark.
    expect(resolveDark('system', { dark_mode_default: true })).toBe(true);
  });

  it('falls back to OS (false in jsdom) when nothing chooses', () => {
    expect(resolveDark('system', {})).toBe(false);
    expect(resolveDark(undefined, null)).toBe(false);
  });
});

describe('effectiveBrandingTheme + resolveMaterial', () => {
  it('reconciles new + legacy theme fields', () => {
    expect(effectiveBrandingTheme({ dark_mode_default: true })).toBe('dark');
    expect(effectiveBrandingTheme({ default_theme: 'light' })).toBe('light');
    expect(effectiveBrandingTheme({ theme: 'dark' })).toBe('dark');
    expect(effectiveBrandingTheme({})).toBe('');
  });

  it('resolveMaterial defaults to quiet', () => {
    expect(resolveMaterial('command')).toBe('command');
    expect(resolveMaterial('quiet')).toBe('quiet');
    expect(resolveMaterial(undefined)).toBe('quiet');
    expect(resolveMaterial('bogus')).toBe('quiet');
  });
});

describe('GlassSurface — reduced-transparency marker + token fill', () => {
  it('carries the glass-surface marker class (media rule neutralises blur)', () => {
    const { container } = render(<GlassSurface>hi</GlassSurface>);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain('glass-surface');
  });

  it('renders a translucent token fill + an inline backdrop blur', () => {
    const { container } = render(<GlassSurface blur="lg">x</GlassSurface>);
    const el = container.firstElementChild as HTMLElement;
    expect(el.style.backgroundColor).toContain('var(--glass-tint)');
    expect(el.style.backdropFilter).toContain('blur(22px)');
  });

  it('renders a hairline rim by default and can drop it', () => {
    const rim = render(<GlassSurface>a</GlassSurface>).container.firstElementChild as HTMLElement;
    expect(rim.className).toContain('border');
    const noRim = render(<GlassSurface rim={false}>a</GlassSurface>).container.firstElementChild as HTMLElement;
    expect(noRim.className).not.toContain('border-border/70');
  });

  it('renders as a semantic element when `as` is set', () => {
    const { container } = render(<GlassSurface as="header">h</GlassSurface>);
    expect(container.querySelector('header')).not.toBeNull();
  });
});
