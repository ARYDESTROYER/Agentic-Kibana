/**
 * Theme + branding provider for the new SOC console.
 *
 * - Light/dark is driven by the `.dark` class on <html> (Tailwind `darkMode:
 *   'class'`). The choice is persisted in localStorage `soc.theme`; the default
 *   is `system` (follows `prefers-color-scheme`).
 * - On mount it fetches GET /api/branding (PUBLIC). On success it applies the
 *   org/product names (document title) + favicon, and — when a custom accent hex
 *   is configured — overrides the `--primary` / `--ring` CSS vars (hex→HSL) so
 *   branding still drives the theme in BOTH modes. ANY failure (legacy/unreachable
 *   backend) silently keeps the built-in defaults.
 * - Mounts the sonner <Toaster/> once, here, so every surface can fire toasts.
 *
 * This mirrors the legacy branding behaviour (see src/lib/branding.tsx) but for
 * the Tailwind/token UI: instead of swapping an EUI stylesheet, it toggles the
 * `.dark` class and (optionally) rewrites the accent CSS vars.
 */
import * as React from 'react';
import { Toaster } from '@/ui/sonner';
import { api } from '@/lib/api';
import type { Branding } from '@/lib/types';

type ThemeMode = 'light' | 'dark' | 'system';

/** Built-in branding defaults — reproduce the no-branding experience. */
const DEFAULT_BRANDING: Branding = {
  org_name: '',
  product_name: '',
  logo_data_url: '',
  favicon_data_url: '',
  accent_color: '',
  accent_color2: '',
  theme: '',
  login_subtitle: '',
  footer_text: '',
  support_url: '',
  dark_mode_default: false,
};

const STORAGE_KEY = 'soc.theme';

function readStoredMode(): ThemeMode {
  try {
    const v = window.localStorage?.getItem(STORAGE_KEY);
    return v === 'dark' || v === 'light' || v === 'system' ? v : 'system';
  } catch {
    return 'system';
  }
}

function writeStoredMode(v: ThemeMode): void {
  try {
    window.localStorage?.setItem(STORAGE_KEY, v);
  } catch {
    /* storage unavailable — non-fatal */
  }
}

function prefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

/** Resolve a mode to the effective dark flag. */
function resolveDark(mode: ThemeMode): boolean {
  if (mode === 'dark') return true;
  if (mode === 'light') return false;
  return prefersDark();
}

/** Apply or remove the `.dark` class on <html>. */
function applyDarkClass(dark: boolean): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.style.colorScheme = dark ? 'dark' : 'light';
}

/**
 * Convert a `#rrggbb` (or `#rgb`) hex string to an HSL triplet string in the
 * `"H S% L%"` form the tokens expect (so it can be assigned to `--primary` etc.).
 * Returns null for anything that does not parse, so callers can no-op safely.
 */
function hexToHslTriplet(hex: string): string | null {
  let h = hex.trim();
  if (!h.startsWith('#')) return null;
  h = h.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null;
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let s = 0;
  let hue = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        hue = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        hue = (b - r) / d + 2;
        break;
      default:
        hue = (r - g) / d + 4;
        break;
    }
    hue /= 6;
  }
  const H = Math.round(hue * 360);
  const S = Math.round(s * 100);
  const L = Math.round(l * 100);
  return `${H} ${S}% ${L}%`;
}

/** Apply the branding accent (hex) to the primary/ring CSS vars, or clear them. */
function applyAccent(accentHex: string): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const triplet = accentHex ? hexToHslTriplet(accentHex) : null;
  if (triplet) {
    root.style.setProperty('--primary', triplet);
    root.style.setProperty('--ring', triplet);
  } else {
    root.style.removeProperty('--primary');
    root.style.removeProperty('--ring');
  }
}

/** Inject/update the favicon from a trusted data: URL (empty → no change). */
function applyFavicon(branding: Branding): void {
  if (typeof document === 'undefined') return;
  const href = branding.favicon_data_url;
  if (!href || !href.startsWith('data:image/')) return;
  let link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.href = href;
}

/** Set document.title from org + product names. */
function applyDocumentTitle(branding: Branding): void {
  if (typeof document === 'undefined') return;
  const org = branding.org_name.trim();
  const product = branding.product_name.trim();
  const title = [org || 'Agentic SOC', product].filter(Boolean).join(' · ');
  if (title) document.title = title;
}

/** Apply all passive branding side effects (accent + favicon + title). */
function applyBranding(branding: Branding): void {
  applyAccent(branding.accent_color || '');
  applyFavicon(branding);
  applyDocumentTitle(branding);
}

export interface ThemeContextValue {
  /** The selected mode (light | dark | system). */
  theme: ThemeMode;
  /** The effective resolved dark flag. */
  isDark: boolean;
  /** Set the mode explicitly (persisted). */
  setTheme: (mode: ThemeMode) => void;
  /** Cycle between light and dark (resolving `system` to its current value first). */
  toggle: () => void;
  /** The current branding (defaults until/unless the backend overrides). */
  branding: Branding;
  /** True once the initial branding fetch has settled (ok or failed). */
  ready: boolean;
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [mode, setMode] = React.useState<ThemeMode>(() => readStoredMode());
  const [branding, setBranding] = React.useState<Branding>(DEFAULT_BRANDING);
  const [ready, setReady] = React.useState(false);
  const [isDark, setIsDark] = React.useState<boolean>(() => resolveDark(readStoredMode()));

  // Apply the `.dark` class whenever the resolved value changes.
  React.useEffect(() => {
    applyDarkClass(isDark);
  }, [isDark]);

  // Re-resolve when the mode changes.
  React.useEffect(() => {
    setIsDark(resolveDark(mode));
  }, [mode]);

  // Follow the OS preference while on `system`.
  React.useEffect(() => {
    if (mode !== 'system') return undefined;
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return undefined;
    const onChange = () => setIsDark(prefersDark());
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, [mode]);

  // Initial branding fetch — apply side effects on success; keep defaults on
  // failure so the no-branding path is identical to the legacy app.
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    void (async () => {
      try {
        const b = await api.getBranding();
        if (!mounted.current) return;
        const merged: Branding = { ...DEFAULT_BRANDING, ...b };
        applyBranding(merged);
        setBranding(merged);
      } catch {
        /* legacy / unreachable backend → defaults already in effect */
      } finally {
        if (mounted.current) setReady(true);
      }
    })();
    return () => {
      mounted.current = false;
    };
  }, []);

  const setTheme = React.useCallback((next: ThemeMode) => {
    setMode(next);
    writeStoredMode(next);
  }, []);

  const toggle = React.useCallback(() => {
    setMode((prev) => {
      const currentlyDark = resolveDark(prev);
      const next: ThemeMode = currentlyDark ? 'light' : 'dark';
      writeStoredMode(next);
      return next;
    });
  }, []);

  const value = React.useMemo<ThemeContextValue>(
    () => ({ theme: mode, isDark, setTheme, toggle, branding, ready }),
    [mode, isDark, setTheme, toggle, branding, ready],
  );

  return (
    <ThemeContext.Provider value={value}>
      {children}
      <Toaster />
    </ThemeContext.Provider>
  );
};

/** Access the theme + branding context. Throws if used outside the provider. */
export function useTheme(): ThemeContextValue {
  const ctx = React.useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within a <ThemeProvider>');
  }
  return ctx;
}
