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
  accent_color: '',
  accent_color2: '',
  theme: '',
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
 * - Else fall back to the OS preference (the original behaviour).
 */
function resolveDark(branding: Branding, override: StoredTheme | null): boolean {
  if (override) return override === 'dark';
  if (branding.theme === 'dark') return true;
  if (branding.theme === 'light') return false;
  return prefersDark();
}

/** Apply accents from a branding object (no-op for empty fields → defaults). */
function applyBrandingAccents(branding: Branding): void {
  setAccent(branding.accent_color || DEFAULT_ACCENT, branding.accent_color2 || DEFAULT_ACCENT2);
}

interface BrandingContextValue {
  /** The current branding (defaults until/unless the backend overrides). */
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
        applyBrandingAccents(merged);
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
    applyBrandingAccents(merged);
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
