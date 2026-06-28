/**
 * BrandingEditor — the org white-label panel for the new (Tailwind/token) console.
 *
 * Mirrors the legacy Settings/BrandingSection data wiring, but on the shadcn-style
 * primitives + design tokens. It lets an operator set the org/product wordmark,
 * upload a logo + favicon (stored inline as base64 data: URLs), pick the primary +
 * secondary accent colours (with INSTANT live preview by rewriting the `--primary`/
 * `--ring`/`--accent2` CSS vars), choose the default theme (Light / Dark / System),
 * and edit login / footer / support copy.
 *
 * Persistence: edits are buffered locally and only written on Save via
 * `api.putBranding(...)`. Discard reverts the live preview to the saved branding.
 * A successful Save reseeds the saved baseline so dirty-tracking resets.
 *
 * Security: the live preview renders the operator-supplied logo/favicon data URLs
 * in <img>; all wordmark/tagline/footer copy renders as PLAIN text (never markup).
 */
import * as React from 'react';
import {
  Brush,
  Check,
  Image as ImageIcon,
  Monitor,
  Moon,
  RotateCcw,
  Save,
  ShieldCheck,
  Sun,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import type { Branding } from '@/lib/types';
import { cn } from '@/lib/cn';
import { useTheme } from '@/soc/theme';

import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Switch } from '@/ui/switch';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Separator } from '@/ui/separator';

/* ----------------------------------------------------------------- limits --- */

const MAX_LOGO_BYTES = 200 * 1024; // ~200 KB
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'];
const LOGO_ACCEPT = LOGO_TYPES.join(',');

const MAX_FAVICON_BYTES = 64 * 1024; // ~64 KB
const FAVICON_TYPES = [
  'image/png',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/svg+xml',
];
const FAVICON_ACCEPT = '.ico,.png,.svg,image/png,image/svg+xml,image/x-icon';

// Free-text caps — mirror the backend BrandingConfig validators.
const MAX_TEXT_LEN = 400;
const MAX_URL_LEN = 2000;

const DEFAULT_ACCENT = '#6c5ce7';
const DEFAULT_ACCENT2 = '#00b894';

/** Built-in defaults — reproduce the no-branding experience. */
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

const THEME_OPTIONS: Array<{ id: 'light' | 'dark' | 'system'; label: string; icon: typeof Sun }> = [
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'system', label: 'System', icon: Monitor },
];

/* -------------------------------------------------------------- utilities --- */

function isValidHex(v: string): boolean {
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v.trim());
}

/** #rrggbb (or #rgb) → "H S% L%" triplet for the CSS token vars (null if bad). */
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
  return `${Math.round(hue * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

/** Live-preview the accent by rewriting (or clearing) the primary/ring CSS vars. */
function applyAccentPreview(accentHex: string): void {
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

/** Live-preview the favicon from a trusted data: URL (empty/blank → no change). */
function applyFaviconPreview(href: string): void {
  if (typeof document === 'undefined') return;
  if (!href || !href.startsWith('data:image/')) return;
  let link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.href = href;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });
}

function errMsg(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

/* ----------------------------------------------------------- small heading -- */

function Heading({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="space-y-0.5">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {sub ? <p className="text-xs text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

/* ----------------------------------------------------------- color field ---- */

function ColorField({
  label,
  value,
  placeholder,
  invalid,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  invalid: boolean;
  disabled?: boolean;
  onChange: (v: string) => void;
}) {
  const swatch = value && isValidHex(value) ? value : placeholder;
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label} swatch`}
          value={isValidHex(value) ? value : placeholder}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-10 shrink-0 cursor-pointer rounded-md border border-border bg-background p-0.5 disabled:cursor-not-allowed disabled:opacity-50"
          style={{ backgroundColor: swatch }}
        />
        <Input
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          aria-invalid={invalid}
          onChange={(e) => onChange(e.target.value)}
          className={cn('font-mono', invalid && 'border-critical focus-visible:ring-critical')}
        />
      </div>
      {invalid ? (
        <p className="text-xs text-critical">Enter a valid #rrggbb hex (or leave blank).</p>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------- image upload --- */

function ImageUpload({
  id,
  value,
  accept,
  promptText,
  disabled,
  onPick,
  onRemove,
  square,
}: {
  id: string;
  value: string;
  accept: string;
  promptText: string;
  disabled?: boolean;
  onPick: (file: File) => void;
  onRemove: () => void;
  square: number;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-wrap items-center gap-4">
      <span
        className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted text-muted-foreground"
        style={{ width: square, height: square }}
      >
        {value ? (
          <img src={value} alt="" className="max-h-full max-w-full object-contain" />
        ) : (
          <ImageIcon className="h-5 w-5" aria-hidden />
        )}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          id={id}
          type="file"
          accept={accept}
          disabled={disabled}
          className="sr-only"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onPick(f);
            // reset so re-picking the same file re-fires change
            e.currentTarget.value = '';
          }}
        />
        <Button
          variant="outline"
          size="sm"
          type="button"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
        >
          <ImageIcon className="h-4 w-4" aria-hidden />
          {promptText}
        </Button>
        {value ? (
          <Button
            variant="ghost"
            size="sm"
            type="button"
            disabled={disabled}
            className="text-critical hover:text-critical"
            onClick={onRemove}
          >
            <Trash2 className="h-4 w-4" aria-hidden />
            Remove
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- main -- */

export interface BrandingEditorProps {
  /** Read-only mode from the parent Settings page (disables every control). */
  readOnly?: boolean;
}

export function BrandingEditor({ readOnly = false }: BrandingEditorProps) {
  const { branding: ctxBranding, setTheme, isDark } = useTheme();

  // The server-confirmed baseline (for dirty-tracking) and the working draft.
  const [saved, setSaved] = React.useState<Branding>({ ...DEFAULT_BRANDING, ...ctxBranding });
  const [draft, setDraft] = React.useState<Branding>({ ...DEFAULT_BRANDING, ...ctxBranding });
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);
  const [saving, setSaving] = React.useState(false);
  const [logoError, setLogoError] = React.useState<string | null>(null);
  const [faviconError, setFaviconError] = React.useState<string | null>(null);

  // Fetch the authoritative branding once (the context value is also seeded from
  // it, but re-fetch so a freshly-saved value in another tab is reflected).
  React.useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const b = await api.getBranding();
        if (!mounted) return;
        const merged = { ...DEFAULT_BRANDING, ...b };
        setSaved(merged);
        setDraft(merged);
      } catch (e) {
        if (mounted) setError(e);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const set = (patch: Partial<Branding>) => {
    setDraft((d) => ({ ...d, ...patch }));
  };

  /* --------------------------------------------------------------- accents -- */

  const accent = draft.accent_color || '';
  const accent2 = draft.accent_color2 || '';
  const accentValid = !accent || isValidHex(accent);
  const accent2Valid = !accent2 || isValidHex(accent2);

  const onAccent = (value: string) => {
    set({ accent_color: value });
    if (!value || isValidHex(value)) applyAccentPreview(value || '');
  };
  const onAccent2 = (value: string) => {
    set({ accent_color2: value });
    // accent2 is informational (gradient); no global var to rewrite live.
  };
  const resetAccents = () => {
    set({ accent_color: '', accent_color2: '' });
    applyAccentPreview('');
  };

  /* ----------------------------------------------------------------- theme -- */

  const onTheme = (id: 'light' | 'dark' | 'system') => {
    set({ theme: id });
    setTheme(id); // instant live preview through the ThemeProvider
  };

  /* ------------------------------------------------------------------ logo -- */

  const onLogo = async (file: File) => {
    setLogoError(null);
    if (!LOGO_TYPES.includes(file.type)) {
      setLogoError('Unsupported format. Use a PNG, JPEG, SVG, or WebP image.');
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setLogoError(`Logo is too large (${Math.round(file.size / 1024)} KB). The limit is 200 KB.`);
      return;
    }
    try {
      set({ logo_data_url: await readAsDataUrl(file) });
    } catch {
      setLogoError('Could not read the file. Please try again.');
    }
  };

  const onFavicon = async (file: File) => {
    setFaviconError(null);
    const okType = !file.type || FAVICON_TYPES.includes(file.type) || /\.ico$/i.test(file.name);
    if (!okType) {
      setFaviconError('Unsupported format. Use an ICO, PNG, or SVG image.');
      return;
    }
    if (file.size > MAX_FAVICON_BYTES) {
      setFaviconError(`Favicon is too large (${Math.round(file.size / 1024)} KB). The limit is 64 KB.`);
      return;
    }
    try {
      const dataUrl = await readAsDataUrl(file);
      if (!dataUrl.startsWith('data:image/')) {
        setFaviconError('That file did not read as an image.');
        return;
      }
      set({ favicon_data_url: dataUrl });
    } catch {
      setFaviconError('Could not read the file. Please try again.');
    }
  };

  /* --------------------------------------------------------------- persist -- */

  const dirty = React.useMemo(
    () =>
      draft.org_name !== saved.org_name ||
      draft.product_name !== saved.product_name ||
      draft.logo_data_url !== saved.logo_data_url ||
      draft.favicon_data_url !== saved.favicon_data_url ||
      draft.accent_color !== saved.accent_color ||
      draft.accent_color2 !== saved.accent_color2 ||
      draft.theme !== saved.theme ||
      draft.login_subtitle !== saved.login_subtitle ||
      draft.footer_text !== saved.footer_text ||
      draft.support_url !== saved.support_url ||
      draft.dark_mode_default !== saved.dark_mode_default,
    [draft, saved],
  );

  const supportUrlValid =
    !draft.support_url ||
    (/^https?:\/\//i.test(draft.support_url) && draft.support_url.length <= MAX_URL_LEN);

  const canSave =
    dirty && accentValid && accent2Valid && supportUrlValid && !readOnly && !saving;

  const save = async () => {
    setSaving(true);
    try {
      const next = await api.putBranding({
        ...draft,
        accent_color: accent,
        accent_color2: accent2,
      });
      const merged = { ...DEFAULT_BRANDING, ...next };
      setSaved(merged);
      setDraft(merged);
      applyAccentPreview(merged.accent_color || '');
      applyFaviconPreview(merged.favicon_data_url || '');
      toast.success('Branding saved.');
    } catch (e) {
      toast.error(errMsg(e, 'Could not save branding.'));
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setDraft(saved);
    setLogoError(null);
    setFaviconError(null);
    applyAccentPreview(saved.accent_color || '');
    applyFaviconPreview(saved.favicon_data_url || '');
    if (saved.theme === 'dark' || saved.theme === 'light' || saved.theme === 'system') {
      setTheme(saved.theme);
    }
  };

  /* ---------------------------------------------------------------- render -- */

  const wordmark = draft.org_name.trim() || 'Agentic SOC';
  const tagline = draft.product_name.trim() || 'Triage console';
  const a1 = accentValid && accent ? accent : DEFAULT_ACCENT;
  const a2 = accent2Valid && accent2 ? accent2 : DEFAULT_ACCENT2;
  const gradient = `linear-gradient(135deg, ${a1} 0%, ${a2} 100%)`;

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading branding…</p>;
  }
  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load branding</AlertTitle>
        <AlertDescription>{errMsg(error, 'An unexpected error occurred.')}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      <Heading
        title="Branding"
        sub="White-label the console: wordmark, logo, accent colours, default theme, and login copy."
      />

      {/* Live preview of the shell header */}
      <div className="overflow-hidden rounded-lg border border-border">
        <div className="h-1" style={{ background: gradient }} />
        <div className="flex items-center gap-3 px-4 py-4" style={{ background: gradient }}>
          <span
            className="inline-flex h-11 w-11 items-center justify-center overflow-hidden rounded-md"
            style={{ background: 'rgba(255,255,255,0.18)' }}
          >
            {draft.logo_data_url ? (
              <img src={draft.logo_data_url} alt="" className="h-11 w-11 object-contain" />
            ) : (
              <ShieldCheck className="h-6 w-6 text-white" aria-hidden />
            )}
          </span>
          <div className="leading-tight text-white">
            <div className="text-lg font-bold">{wordmark}</div>
            <div className="text-xs opacity-90">{tagline}</div>
          </div>
        </div>
      </div>
      <p className="-mt-3 text-xs text-muted-foreground">Live preview of the console header.</p>

      {/* Wordmark */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="brand-org">Organisation name</Label>
          <Input
            id="brand-org"
            value={draft.org_name}
            placeholder="Agentic SOC"
            disabled={readOnly}
            maxLength={MAX_TEXT_LEN}
            onChange={(e) => set({ org_name: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">Shown as the wordmark. Blank uses “Agentic SOC”.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="brand-product">Product name</Label>
          <Input
            id="brand-product"
            value={draft.product_name}
            placeholder="Triage console"
            disabled={readOnly}
            maxLength={MAX_TEXT_LEN}
            onChange={(e) => set({ product_name: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">Tagline beneath the wordmark. Blank uses “Triage console”.</p>
        </div>
      </div>

      <Separator />

      {/* Logo + favicon */}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-2">
          <Heading title="Logo" sub="PNG, JPEG, SVG, or WebP up to 200 KB. Stored inline." />
          <ImageUpload
            id="brand-logo-file"
            value={draft.logo_data_url}
            accept={LOGO_ACCEPT}
            promptText="Select or drag a logo"
            disabled={readOnly}
            square={64}
            onPick={(f) => void onLogo(f)}
            onRemove={() => {
              set({ logo_data_url: '' });
              setLogoError(null);
            }}
          />
          {logoError ? <p className="text-xs text-critical">{logoError}</p> : null}
        </div>
        <div className="space-y-2">
          <Heading title="Browser tab icon (favicon)" sub="ICO, PNG, or SVG up to 64 KB. Stored inline." />
          <ImageUpload
            id="brand-favicon-file"
            value={draft.favicon_data_url}
            accept={FAVICON_ACCEPT}
            promptText="Select or drag a favicon"
            disabled={readOnly}
            square={40}
            onPick={(f) => void onFavicon(f)}
            onRemove={() => {
              set({ favicon_data_url: '' });
              setFaviconError(null);
            }}
          />
          {faviconError ? <p className="text-xs text-critical">{faviconError}</p> : null}
        </div>
      </div>

      <Separator />

      {/* Accents */}
      <div className="space-y-3">
        <Heading title="Accent colours" sub="The primary accent previews instantly across the console." />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <ColorField
            label="Primary accent"
            value={accent}
            placeholder={DEFAULT_ACCENT}
            invalid={!accentValid}
            disabled={readOnly}
            onChange={onAccent}
          />
          <ColorField
            label="Secondary accent"
            value={accent2}
            placeholder={DEFAULT_ACCENT2}
            invalid={!accent2Valid}
            disabled={readOnly}
            onChange={onAccent2}
          />
          <div className="space-y-1.5">
            <Label>Gradient</Label>
            <div
              className="h-9 rounded-md border border-border"
              style={{ background: gradient }}
              aria-hidden
            />
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={resetAccents} disabled={readOnly}>
          <RotateCcw className="h-4 w-4" aria-hidden />
          Reset to default
        </Button>
      </div>

      <Separator />

      {/* Theme */}
      <div className="space-y-3">
        <Heading title="Default theme" sub="The console theme; “System” follows the OS preference." />
        <div className="inline-flex rounded-lg border border-border bg-muted p-1">
          {THEME_OPTIONS.map((o) => {
            const active = (draft.theme || 'system') === o.id;
            const Icon = o.icon;
            return (
              <button
                key={o.id}
                type="button"
                disabled={readOnly}
                onClick={() => onTheme(o.id)}
                aria-pressed={active}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  'disabled:cursor-not-allowed disabled:opacity-50',
                  active
                    ? 'bg-card text-foreground shadow-elev1'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon className="h-4 w-4" aria-hidden />
                {o.label}
              </button>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          Currently showing the <strong className="font-semibold text-foreground">{isDark ? 'dark' : 'light'}</strong> theme.
        </p>
        <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-foreground">
          <Switch
            checked={draft.dark_mode_default}
            disabled={readOnly}
            onCheckedChange={(v) => set({ dark_mode_default: v })}
            aria-label="Default new sessions to dark mode"
          />
          Default new sessions to dark mode
        </label>
        <p className="text-xs text-muted-foreground">
          Seeds the colour mode for a fresh browser when “System” is selected. A user’s own
          light/dark toggle always wins.
        </p>
      </div>

      <Separator />

      {/* Login & messaging */}
      <div className="space-y-4">
        <Heading
          title="Login &amp; messaging"
          sub="Operator-set copy shown on the login screen and console chrome."
        />
        <div className="space-y-1.5">
          <Label htmlFor="brand-subtitle">Login subtitle</Label>
          <Input
            id="brand-subtitle"
            value={draft.login_subtitle}
            placeholder="Welcome back"
            disabled={readOnly}
            maxLength={MAX_TEXT_LEN}
            onChange={(e) => set({ login_subtitle: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="brand-footer">Footer text</Label>
          <Input
            id="brand-footer"
            value={draft.footer_text}
            placeholder="UNCLASSIFIED"
            disabled={readOnly}
            maxLength={MAX_TEXT_LEN}
            onChange={(e) => set({ footer_text: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            A footer / classification banner line (e.g. “UNCLASSIFIED // FOUO”).
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="brand-support">Support / docs URL</Label>
          <Input
            id="brand-support"
            value={draft.support_url}
            placeholder="https://help.example.com"
            disabled={readOnly}
            maxLength={MAX_URL_LEN}
            aria-invalid={!supportUrlValid}
            className={cn(!supportUrlValid && 'border-critical focus-visible:ring-critical')}
            onChange={(e) => set({ support_url: e.target.value })}
          />
          {!supportUrlValid ? (
            <p className="text-xs text-critical">Enter an http(s):// URL or leave blank.</p>
          ) : null}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 border-t border-border pt-4">
        <Button onClick={() => void save()} disabled={!canSave}>
          <Save className="h-4 w-4" aria-hidden />
          {saving ? 'Saving…' : 'Save branding'}
        </Button>
        <Button variant="ghost" onClick={discard} disabled={!dirty || saving}>
          <X className="h-4 w-4" aria-hidden />
          Discard
        </Button>
        {!dirty && !saving ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Check className="h-3.5 w-3.5 text-success" aria-hidden />
            Saved
          </span>
        ) : null}
        {readOnly ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Brush className="h-3.5 w-3.5" aria-hidden />
            Read-only mode
          </span>
        ) : null}
      </div>
    </div>
  );
}

export default BrandingEditor;
