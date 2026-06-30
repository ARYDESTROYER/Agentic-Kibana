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
import {
  applyBranding as applyBrandingTokens,
  resolveDark as resolveDarkPrecedence,
  type BrandingLike,
  type Material,
} from './theme-tokens';

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

/**
 * Resolve a mode to the effective dark flag, delegating to the ONE precedence
 * resolver. `branding` (when provided) acts as the org default for users on
 * `system` — see theme-tokens.resolveDark. Omitting it keeps the prior user-pref /
 * OS-only behaviour.
 */
function resolveDark(mode: ThemeMode, branding?: BrandingLike | null): boolean {
  return resolveDarkPrecedence(mode, branding ?? null);
}

/** Apply or remove the `.dark` class on <html>. */
function applyDarkClass(dark: boolean): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.style.colorScheme = dark ? 'dark' : 'light';
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

/**
 * Toggle the decorative command-grid overlay class on <html>. Driven by the
 * resolved material; in 'quiet' the class is removed (and `--grid-opacity` is 0
 * anyway, so even a stale class would be invisible). Decorative only.
 */
function applyMaterialClass(material: Material): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle('command-grid', material === 'command');
  root.dataset.material = material;
}

/**
 * Apply ALL branding side effects: appearance tokens (accent + material pack +
 * bounded theme-token overrides, via the ONE allow-listed resolver) + favicon +
 * title + the material overlay class. The token application is fully delegated to
 * `theme-tokens.applyBranding`, which writes ONLY allow-listed, sanitised CSS vars
 * (#10/#9). Returns the resolved material.
 *
 * `branding` is typed `Branding` for the known fields; the backend forwards the
 * additive round-3 fields (`material`/`theme_tokens`/`presets`/`default_theme`)
 * verbatim, so we read it structurally as a `BrandingLike`.
 */
function applyBranding(branding: Branding): Material {
  const material = applyBrandingTokens(branding as unknown as BrandingLike);
  applyMaterialClass(material);
  applyFavicon(branding);
  applyDocumentTitle(branding);
  return material;
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
  /** The resolved shell material pack ('quiet' === pre-wave default). */
  material: Material;
  /** True once the initial branding fetch has settled (ok or failed). */
  ready: boolean;
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [mode, setMode] = React.useState<ThemeMode>(() => readStoredMode());
  const [branding, setBranding] = React.useState<Branding>(DEFAULT_BRANDING);
  const [material, setMaterial] = React.useState<Material>('quiet');
  const [ready, setReady] = React.useState(false);
  const [isDark, setIsDark] = React.useState<boolean>(() => resolveDark(readStoredMode()));

  // Branding-as-default is only consulted when the user is on `system`; keep a
  // stable ref so the OS-change listener re-resolves against the latest branding.
  const brandingRef = React.useRef<Branding>(branding);
  brandingRef.current = branding;

  // Apply the `.dark` class whenever the resolved value changes.
  React.useEffect(() => {
    applyDarkClass(isDark);
  }, [isDark]);

  // Re-resolve when the mode OR the org-default (branding) changes. For an
  // explicit light/dark user choice the branding is irrelevant (precedence #1).
  React.useEffect(() => {
    setIsDark(resolveDark(mode, branding as unknown as BrandingLike));
  }, [mode, branding]);

  // Follow the OS preference while on `system` (consulting the branding default).
  React.useEffect(() => {
    if (mode !== 'system') return undefined;
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return undefined;
    const onChange = () =>
      setIsDark(resolveDark('system', brandingRef.current as unknown as BrandingLike));
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
        const resolvedMaterial = applyBranding(merged);
        setBranding(merged);
        setMaterial(resolvedMaterial);
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
      const currentlyDark = resolveDark(prev, brandingRef.current as unknown as BrandingLike);
      const next: ThemeMode = currentlyDark ? 'light' : 'dark';
      writeStoredMode(next);
      return next;
    });
  }, []);

  const value = React.useMemo<ThemeContextValue>(
    () => ({ theme: mode, isDark, setTheme, toggle, branding, material, ready }),
    [mode, isDark, setTheme, toggle, branding, material, ready],
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
