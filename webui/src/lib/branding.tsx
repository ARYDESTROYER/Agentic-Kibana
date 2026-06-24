/**
 * Branding + theme context.
 *
 * On mount this fetches GET /api/branding (PUBLIC). On success — and only when a
 * field is actually set — it applies the operator's accents (via `setAccent`) and
 * resolves the configured colour theme. On ANY failure (legacy backend with no
 * /api/branding, network error, etc.) it falls back to the built-in defaults so
 * the experience is byte-identical to today: the historical accent, no logo
 * override, and the OS dark/light preference.
 *
 * Theme resolution order (highest precedence first):
 *   1. The user's explicit in-app toggle, persisted to localStorage (`soc.theme`).
 *   2. The branding `theme` ("dark" | "light"; "system" → prefers-color-scheme).
 *   3. The OS `prefers-color-scheme` preference.
 *
 * The provider is additive: when no branding is configured and the user has not
 * toggled the theme, `darkMode` resolves exactly as the previous app did
 * (prefers-color-scheme only), preserving the no-branding path.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { api } from './api';
import type { Branding } from './types';
import { DEFAULT_ACCENT, DEFAULT_ACCENT2, setAccent } from './theme';

/** Built-in defaults — these reproduce today's no-branding experience exactly. */
export const DEFAULT_BRANDING: Branding = {
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

const THEME_STORAGE_KEY = 'soc.theme';

type StoredTheme = 'dark' | 'light';

function readStoredTheme(): StoredTheme | null {
  try {
    const v = window.localStorage?.getItem(THEME_STORAGE_KEY);
    return v === 'dark' || v === 'light' ? v : null;
  } catch {
    return null;
  }
}

function writeStoredTheme(v: StoredTheme | null): void {
  try {
    if (v === null) window.localStorage?.removeItem(THEME_STORAGE_KEY);
    else window.localStorage?.setItem(THEME_STORAGE_KEY, v);
  } catch {
    /* storage unavailable — non-fatal */
  }
}

function prefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

/**
 * Resolve the effective dark-mode flag.
 * - An explicit user override always wins.
 * - Else honour the branding theme ("dark"/"light"; "system"→OS).
 * - Else, for "system"/unset, honour the operator's `dark_mode_default` as the
 *   seed for new sessions, falling back to the OS preference when it is off.
 *
 * Back-compat: with `dark_mode_default` false (its default) and no theme set,
 * this collapses to the previous `prefersDark()`-only behaviour.
 */
function resolveDark(branding: Branding, override: StoredTheme | null): boolean {
  if (override) return override === 'dark';
  if (branding.theme === 'dark') return true;
  if (branding.theme === 'light') return false;
  if (branding.dark_mode_default) return true;
  return prefersDark();
}

/** Apply accents from a branding object (no-op for empty fields → defaults). */
function applyBrandingAccents(branding: Branding): void {
  setAccent(branding.accent_color || DEFAULT_ACCENT, branding.accent_color2 || DEFAULT_ACCENT2);
}

/**
 * Apply the browser-tab favicon from a branding object. Injects (or updates) a
 * single `<link rel="icon">` tag from `favicon_data_url`. Empty → no change, so
 * the bundled/static favicon is left untouched (back-compatible).
 */
function applyFavicon(branding: Branding): void {
  if (typeof document === 'undefined') return;
  const href = branding.favicon_data_url;
  if (!href || !href.startsWith('data:image/')) return; // only trusted data URLs
  let link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.href = href;
}

/**
 * Set `document.title` from the org + product names. Empty fields fall back so a
 * no-branding deploy keeps a sensible default ("Agentic SOC" / current title).
 */
function applyDocumentTitle(branding: Branding): void {
  if (typeof document === 'undefined') return;
  const org = branding.org_name.trim();
  const product = branding.product_name.trim();
  const title = [org || 'Agentic SOC', product].filter(Boolean).join(' · ');
  if (title) document.title = title;
}

/** Apply ALL passive branding side effects (accents + favicon + title). */
function applyBranding(branding: Branding): void {
  applyBrandingAccents(branding);
  applyFavicon(branding);
  applyDocumentTitle(branding);
}

interface BrandingContextValue {
  /**
   * The current branding (defaults until/unless the backend overrides).
   * Consumers read passive extras straight off this object:
   * `footer_text`, `login_subtitle`, `support_url`, `dark_mode_default`
   * (favicon + document title + accents are applied as provider side effects).
   */
  branding: Branding;
  /** Effective dark-mode flag (drives EuiProvider colorMode). */
  darkMode: boolean;
  /** User toggle — records an explicit override (persisted) and re-resolves. */
  setDarkMode: (v: boolean) => void;
  /** PUT new branding, update context, re-apply accents + theme. */
  update: (patch: Partial<Branding>) => Promise<void>;
  /** True once the initial branding fetch has settled (ok or failed). */
  ready: boolean;
}

const BrandingContext = createContext<BrandingContextValue | null>(null);

export const BrandingProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [branding, setBranding] = useState<Branding>(DEFAULT_BRANDING);
  const [override, setOverride] = useState<StoredTheme | null>(() => readStoredTheme());
  const [ready, setReady] = useState(false);
  // Tracks whether the user has set an explicit override this session, so an OS
  // theme change only auto-applies when they have NOT.
  const hasOverride = override !== null;

  const [darkMode, setDark] = useState<boolean>(() =>
    resolveDark(DEFAULT_BRANDING, readStoredTheme()),
  );

  // Initial fetch — apply accents/theme on success; silently keep defaults on
  // failure so the no-branding path is identical to today.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    void (async () => {
      try {
        const b = await api.getBranding();
        if (!mounted.current) return;
        const merged: Branding = { ...DEFAULT_BRANDING, ...b };
        applyBranding(merged);
        setBranding(merged);
        setDark(resolveDark(merged, readStoredTheme()));
      } catch {
        // Legacy / unreachable backend → defaults already applied.
      } finally {
        if (mounted.current) setReady(true);
      }
    })();
    return () => {
      mounted.current = false;
    };
  }, []);

  // Follow the OS preference while the user has no explicit override and branding
  // is on "system" (or unset) — preserves the original prefers-color-scheme path.
  useEffect(() => {
    if (hasOverride) return undefined;
    if (branding.theme === 'dark' || branding.theme === 'light') return undefined;
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return undefined;
    const onChange = () => setDark(prefersDark());
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, [hasOverride, branding.theme]);

  const setDarkMode = useCallback((v: boolean) => {
    const next: StoredTheme = v ? 'dark' : 'light';
    setOverride(next);
    writeStoredTheme(next);
    setDark(v);
  }, []);

  const update = useCallback(async (patch: Partial<Branding>) => {
    const next: Branding = { ...DEFAULT_BRANDING, ...branding, ...patch };
    const saved = await api.putBranding(next);
    const merged: Branding = { ...DEFAULT_BRANDING, ...saved };
    applyBranding(merged);
    setBranding(merged);
    // Re-resolve theme: an explicit user override still wins.
    setDark(resolveDark(merged, readStoredTheme()));
  }, [branding]);

  const value = useMemo<BrandingContextValue>(
    () => ({ branding, darkMode, setDarkMode, update, ready }),
    [branding, darkMode, setDarkMode, update, ready],
  );

  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
};

/** Access the branding + theme context. Throws if used outside the provider. */
export function useBranding(): BrandingContextValue {
  const ctx = useContext(BrandingContext);
  if (!ctx) {
    throw new Error('useBranding must be used within a <BrandingProvider>');
  }
  return ctx;
}
