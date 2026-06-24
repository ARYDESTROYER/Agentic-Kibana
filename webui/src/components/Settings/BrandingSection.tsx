/**
 * Branding — the org white-label panel.
 *
 * Lets an operator set the org/product wordmark, upload a logo (stored inline as
 * a base64 data: URL), pick the primary + secondary accent colours (with INSTANT
 * live preview via `setAccent`), and choose the default theme (Light / Dark /
 * System). Save persists through `useBranding().update(...)` (PUT /api/branding);
 * Discard reverts the live preview to the saved branding.
 *
 * Like the rest of Settings, the panel honours read-only mode by disabling Save
 * and surfacing the same warning callout pattern.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  EuiButton,
  EuiButtonEmpty,
  EuiButtonGroup,
  EuiCallOut,
  EuiColorPicker,
  EuiFieldText,
  EuiFilePicker,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFormRow,
  EuiIcon,
  EuiPanel,
  EuiSpacer,
  EuiSwitch,
  EuiText,
  isValidHex,
} from '@elastic/eui';
import type { Branding } from '../../lib/types';
import { useBranding } from '../../lib/branding';
import {
  DEFAULT_ACCENT,
  DEFAULT_ACCENT2,
  setAccent,
} from '../../lib/theme';
import { PageHeader } from '../common/ui';

/* ----------------------------------------------------------------- limits --- */

const MAX_LOGO_BYTES = 200 * 1024; // ~200 KB
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'];
const LOGO_ACCEPT = LOGO_TYPES.join(',');

// Favicon: a smaller cap (favicons are tiny). Mirrors the backend's data-URL guard.
const MAX_FAVICON_BYTES = 64 * 1024; // ~64 KB
const FAVICON_TYPES = ['image/png', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/svg+xml'];
const FAVICON_ACCEPT = '.ico,.png,.svg,image/png,image/svg+xml,image/x-icon';

// Free-text caps — mirror the backend BrandingConfig validators.
const MAX_TEXT_LEN = 400;
const MAX_URL_LEN = 2000;

const THEME_OPTIONS = [
  { id: 'light', label: 'Light', iconType: 'sun' },
  { id: 'dark', label: 'Dark', iconType: 'moon' },
  { id: 'system', label: 'System', iconType: 'desktop' },
];

/** Read a File into a base64 data: URL. */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });
}

/** A small read-only section title (mirrors the Settings sub-section header). */
const Heading: React.FC<{ title: string; sub?: string }> = ({ title, sub }) => (
  <>
    <EuiText>
      <h3 style={{ marginBottom: 0 }}>{title}</h3>
    </EuiText>
    {sub ? (
      <EuiText size="xs" color="subdued">
        <p style={{ marginTop: 2 }}>{sub}</p>
      </EuiText>
    ) : null}
    <EuiSpacer size="m" />
  </>
);

interface BrandingSectionProps {
  /** Read-only mode from the parent Settings page (disables Save). */
  readOnly?: boolean;
}

export const BrandingSection: React.FC<BrandingSectionProps> = ({ readOnly = false }) => {
  const { branding, darkMode, setDarkMode, update } = useBranding();

  // Local working copy — edits are buffered and only persisted on Save. Accent +
  // theme changes are previewed live, but the *saved* state is `branding`.
  const [draft, setDraft] = useState<Branding>(branding);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [faviconError, setFaviconError] = useState<string | null>(null);
  // Force-remount the file pickers after a successful read / removal so their
  // labels reset (EuiFilePicker is uncontrolled).
  const [pickerKey, setPickerKey] = useState(0);
  const [faviconPickerKey, setFaviconPickerKey] = useState(0);

  // When the saved branding changes underneath us (e.g. another tab), re-seed the
  // draft so the panel reflects the source of truth.
  useEffect(() => {
    setDraft(branding);
  }, [branding]);

  const set = (patch: Partial<Branding>) => {
    setNote(null);
    setError(null);
    setDraft((d) => ({ ...d, ...patch }));
  };

  /* ------------------------------------------------------------ accents ---- */

  const accent = draft.accent_color || DEFAULT_ACCENT;
  const accent2 = draft.accent_color2 || DEFAULT_ACCENT2;
  const accentValid = isValidHex(accent);
  const accent2Valid = isValidHex(accent2);

  const onAccent = (value: string) => {
    set({ accent_color: value });
    // Live preview only when the new value is a valid hex (or empty → default).
    if (!value || isValidHex(value)) {
      setAccent(value || DEFAULT_ACCENT, draft.accent_color2 || DEFAULT_ACCENT2);
    }
  };
  const onAccent2 = (value: string) => {
    set({ accent_color2: value });
    if (!value || isValidHex(value)) {
      setAccent(draft.accent_color || DEFAULT_ACCENT, value || DEFAULT_ACCENT2);
    }
  };
  const resetAccents = () => {
    set({ accent_color: '', accent_color2: '' });
    setAccent('', ''); // restore the built-in defaults live
  };

  /* ------------------------------------------------------------- theme ----- */

  const onTheme = (id: string) => {
    const theme = (id === 'light' || id === 'dark' || id === 'system' ? id : '') as Branding['theme'];
    set({ theme });
    // Reflect to the live theme so the change is instant. "system" follows the OS.
    if (theme === 'dark') setDarkMode(true);
    else if (theme === 'light') setDarkMode(false);
    else setDarkMode(prefersDark());
  };

  /* -------------------------------------------------------------- logo ----- */

  const onLogo = async (files: FileList | null) => {
    setLogoError(null);
    setNote(null);
    const file = files && files[0];
    if (!file) return;
    if (!LOGO_TYPES.includes(file.type)) {
      setLogoError('Unsupported format. Use a PNG, JPEG, SVG, or WebP image.');
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setLogoError(`Logo is too large (${Math.round(file.size / 1024)} KB). The limit is 200 KB.`);
      return;
    }
    try {
      const dataUrl = await readAsDataUrl(file);
      set({ logo_data_url: dataUrl });
      setPickerKey((k) => k + 1);
    } catch {
      setLogoError('Could not read the file. Please try again.');
    }
  };

  const removeLogo = () => {
    set({ logo_data_url: '' });
    setLogoError(null);
    setPickerKey((k) => k + 1);
  };

  /* ------------------------------------------------------------ favicon ---- */

  const onFavicon = async (files: FileList | null) => {
    setFaviconError(null);
    setNote(null);
    const file = files && files[0];
    if (!file) return;
    // .ico files sometimes report an empty type — accept by extension too.
    const okType = !file.type || FAVICON_TYPES.includes(file.type) || /\.ico$/i.test(file.name);
    if (!okType) {
      setFaviconError('Unsupported format. Use an ICO, PNG, or SVG image.');
      return;
    }
    if (file.size > MAX_FAVICON_BYTES) {
      setFaviconError(
        `Favicon is too large (${Math.round(file.size / 1024)} KB). The limit is 64 KB.`,
      );
      return;
    }
    try {
      const dataUrl = await readAsDataUrl(file);
      if (!dataUrl.startsWith('data:image/')) {
        setFaviconError('That file did not read as an image.');
        return;
      }
      set({ favicon_data_url: dataUrl });
      setFaviconPickerKey((k) => k + 1);
    } catch {
      setFaviconError('Could not read the file. Please try again.');
    }
  };

  const removeFavicon = () => {
    set({ favicon_data_url: '' });
    setFaviconError(null);
    setFaviconPickerKey((k) => k + 1);
  };

  /* ------------------------------------------------------------ persist ---- */

  const dirty = useMemo(
    () =>
      draft.org_name !== branding.org_name ||
      draft.product_name !== branding.product_name ||
      draft.logo_data_url !== branding.logo_data_url ||
      draft.favicon_data_url !== branding.favicon_data_url ||
      draft.accent_color !== branding.accent_color ||
      draft.accent_color2 !== branding.accent_color2 ||
      draft.theme !== branding.theme ||
      draft.login_subtitle !== branding.login_subtitle ||
      draft.footer_text !== branding.footer_text ||
      draft.support_url !== branding.support_url ||
      draft.dark_mode_default !== branding.dark_mode_default,
    [draft, branding],
  );

  // A non-empty support URL must look like an http(s) link (mirrors the backend).
  const supportUrlValid =
    !draft.support_url ||
    (/^https?:\/\//i.test(draft.support_url) && draft.support_url.length <= MAX_URL_LEN);

  const canSave =
    dirty && accentValid && accent2Valid && supportUrlValid && !readOnly && !saving;

  const save = async () => {
    setSaving(true);
    setError(null);
    setNote(null);
    try {
      await update({
        org_name: draft.org_name,
        product_name: draft.product_name,
        logo_data_url: draft.logo_data_url,
        favicon_data_url: draft.favicon_data_url,
        accent_color: draft.accent_color,
        accent_color2: draft.accent_color2,
        theme: draft.theme,
        login_subtitle: draft.login_subtitle,
        footer_text: draft.footer_text,
        support_url: draft.support_url,
        dark_mode_default: draft.dark_mode_default,
      });
      setNote('Branding saved.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save branding.');
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setDraft(branding);
    setNote(null);
    setError(null);
    setLogoError(null);
    setFaviconError(null);
    setPickerKey((k) => k + 1);
    setFaviconPickerKey((k) => k + 1);
    // Revert the live preview to the saved accents + theme.
    setAccent(branding.accent_color || '', branding.accent_color2 || '');
    if (branding.theme === 'dark') setDarkMode(true);
    else if (branding.theme === 'light') setDarkMode(false);
  };

  /* ------------------------------------------------------------- render ---- */

  const wordmark = draft.org_name.trim() || 'Agentic SOC';
  const tagline = draft.product_name.trim() || 'Triage console';
  const gradient = `linear-gradient(135deg, ${accentValid ? accent : DEFAULT_ACCENT} 0%, ${
    accent2Valid ? accent2 : DEFAULT_ACCENT2
  } 100%)`;

  return (
    <div className="socPageEnter">
      <PageHeader
        icon="brush"
        eyebrow="Platform"
        title="Branding"
        description="White-label the console: wordmark, logo, accent colours, and the default theme."
      />

      {readOnly ? (
        <>
          <EuiCallOut size="s" color="warning" iconType="lock" title="Read-only mode" />
          <EuiSpacer size="m" />
        </>
      ) : null}
      {note ? (
        <>
          <EuiCallOut size="s" color="success" iconType="check" title={note} />
          <EuiSpacer size="m" />
        </>
      ) : null}
      {error ? (
        <>
          <EuiCallOut size="s" color="danger" iconType="alert" title={error} />
          <EuiSpacer size="m" />
        </>
      ) : null}

      {/* Live preview of the shell header (logo + wordmark on the accent gradient). */}
      <EuiPanel
        hasBorder
        paddingSize="none"
        style={{ overflow: 'hidden', borderRadius: 10 }}
      >
        <div style={{ height: 3, background: gradient }} />
        <div
          style={{
            background: gradient,
            padding: '18px 20px',
            display: 'flex',
            alignItems: 'center',
            gap: 14,
          }}
        >
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 44,
              height: 44,
              borderRadius: 10,
              background: 'rgba(255,255,255,0.18)',
              color: '#fff',
              boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
              overflow: 'hidden',
            }}
          >
            {draft.logo_data_url ? (
              <img
                src={draft.logo_data_url}
                alt=""
                style={{ width: 44, height: 44, objectFit: 'contain' }}
              />
            ) : (
              <EuiIcon type="securityApp" size="l" />
            )}
          </span>
          <div style={{ lineHeight: 1.2, color: '#fff' }}>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{wordmark}</div>
            <div style={{ fontSize: 12, opacity: 0.9 }}>{tagline}</div>
          </div>
        </div>
      </EuiPanel>
      <EuiText size="xs" color="subdued">
        <p style={{ marginTop: 6 }}>Live preview of the console header.</p>
      </EuiText>

      <EuiSpacer size="l" />

      {/* Wordmark ----------------------------------------------------------- */}
      <EuiFlexGroup gutterSize="l">
        <EuiFlexItem>
          <EuiFormRow label="Organisation name" helpText="Shown as the wordmark. Blank uses “Agentic SOC”." fullWidth>
            <EuiFieldText
              value={draft.org_name}
              onChange={(e) => set({ org_name: e.target.value })}
              placeholder="Agentic SOC"
              disabled={readOnly}
              fullWidth
            />
          </EuiFormRow>
        </EuiFlexItem>
        <EuiFlexItem>
          <EuiFormRow label="Product name" helpText="Tagline beneath the wordmark. Blank uses “Triage console”." fullWidth>
            <EuiFieldText
              value={draft.product_name}
              onChange={(e) => set({ product_name: e.target.value })}
              placeholder="Triage console"
              disabled={readOnly}
              fullWidth
            />
          </EuiFormRow>
        </EuiFlexItem>
      </EuiFlexGroup>

      <EuiSpacer size="l" />

      {/* Logo --------------------------------------------------------------- */}
      <EuiFormRow
        label="Logo"
        helpText="PNG, JPEG, SVG, or WebP up to 200 KB. Stored inline as a data URL."
        fullWidth
        isInvalid={Boolean(logoError)}
        error={logoError || undefined}
      >
        <EuiFlexGroup alignItems="center" gutterSize="l" responsive={false} wrap>
          {/* Previews: header scale (~120px) and a small ~40px chip. */}
          <EuiFlexItem grow={false}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 120,
                height: 120,
                borderRadius: 14,
                background: draft.logo_data_url ? '#fff' : gradient,
                border: '1px solid rgba(0,0,0,0.08)',
                boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
                overflow: 'hidden',
              }}
            >
              {draft.logo_data_url ? (
                <img
                  src={draft.logo_data_url}
                  alt="Logo preview"
                  style={{ maxWidth: 110, maxHeight: 110, objectFit: 'contain' }}
                />
              ) : (
                <EuiIcon type="securityApp" size="xl" color="#fff" />
              )}
            </span>
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 40,
                height: 40,
                borderRadius: 8,
                background: draft.logo_data_url ? '#fff' : gradient,
                border: '1px solid rgba(0,0,0,0.08)',
                overflow: 'hidden',
              }}
            >
              {draft.logo_data_url ? (
                <img
                  src={draft.logo_data_url}
                  alt=""
                  style={{ maxWidth: 36, maxHeight: 36, objectFit: 'contain' }}
                />
              ) : (
                <EuiIcon type="securityApp" size="m" color="#fff" />
              )}
            </span>
          </EuiFlexItem>
          <EuiFlexItem style={{ minWidth: 260 }}>
            <EuiFilePicker
              key={pickerKey}
              accept={LOGO_ACCEPT}
              display="default"
              initialPromptText="Select or drag a logo image"
              onChange={onLogo}
              disabled={readOnly}
              fullWidth
            />
            {draft.logo_data_url ? (
              <>
                <EuiSpacer size="s" />
                <EuiButtonEmpty
                  size="s"
                  color="danger"
                  iconType="trash"
                  onClick={removeLogo}
                  isDisabled={readOnly}
                >
                  Remove logo
                </EuiButtonEmpty>
              </>
            ) : null}
          </EuiFlexItem>
        </EuiFlexGroup>
      </EuiFormRow>

      <EuiSpacer size="l" />

      {/* Favicon ------------------------------------------------------------ */}
      <EuiFormRow
        label="Browser tab icon (favicon)"
        helpText="ICO, PNG, or SVG up to 64 KB. Stored inline; applied to the browser tab."
        fullWidth
        isInvalid={Boolean(faviconError)}
        error={faviconError || undefined}
      >
        <EuiFlexGroup alignItems="center" gutterSize="l" responsive={false} wrap>
          <EuiFlexItem grow={false}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 40,
                height: 40,
                borderRadius: 8,
                background: draft.favicon_data_url ? '#fff' : gradient,
                border: '1px solid rgba(0,0,0,0.08)',
                overflow: 'hidden',
              }}
            >
              {draft.favicon_data_url ? (
                <img
                  src={draft.favicon_data_url}
                  alt="Favicon preview"
                  style={{ maxWidth: 32, maxHeight: 32, objectFit: 'contain' }}
                />
              ) : (
                <EuiIcon type="globe" size="m" color="#fff" />
              )}
            </span>
          </EuiFlexItem>
          <EuiFlexItem style={{ minWidth: 260 }}>
            <EuiFilePicker
              key={faviconPickerKey}
              accept={FAVICON_ACCEPT}
              display="default"
              initialPromptText="Select or drag a favicon"
              onChange={onFavicon}
              disabled={readOnly}
              fullWidth
            />
            {draft.favicon_data_url ? (
              <>
                <EuiSpacer size="s" />
                <EuiButtonEmpty
                  size="s"
                  color="danger"
                  iconType="trash"
                  onClick={removeFavicon}
                  isDisabled={readOnly}
                >
                  Remove favicon
                </EuiButtonEmpty>
              </>
            ) : null}
          </EuiFlexItem>
        </EuiFlexGroup>
      </EuiFormRow>

      <EuiSpacer size="l" />

      {/* Accents ------------------------------------------------------------ */}
      <Heading title="Accent colours" sub="Changes preview instantly across the console." />
      <EuiFlexGroup gutterSize="l" alignItems="flexStart" wrap>
        <EuiFlexItem grow={false} style={{ minWidth: 240 }}>
          <EuiFormRow
            label="Primary accent"
            isInvalid={!accentValid}
            error={accentValid ? undefined : 'Enter a valid #rrggbb hex.'}
          >
            <EuiColorPicker
              color={draft.accent_color}
              onChange={onAccent}
              isInvalid={!accentValid}
              placeholder={DEFAULT_ACCENT}
              disabled={readOnly}
            />
          </EuiFormRow>
        </EuiFlexItem>
        <EuiFlexItem grow={false} style={{ minWidth: 240 }}>
          <EuiFormRow
            label="Secondary accent"
            isInvalid={!accent2Valid}
            error={accent2Valid ? undefined : 'Enter a valid #rrggbb hex.'}
          >
            <EuiColorPicker
              color={draft.accent_color2}
              onChange={onAccent2}
              isInvalid={!accent2Valid}
              placeholder={DEFAULT_ACCENT2}
              disabled={readOnly}
            />
          </EuiFormRow>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiFormRow label="Gradient">
            <div
              style={{
                width: 180,
                height: 38,
                borderRadius: 8,
                background: gradient,
                border: '1px solid rgba(0,0,0,0.08)',
              }}
            />
          </EuiFormRow>
        </EuiFlexItem>
      </EuiFlexGroup>
      <EuiSpacer size="s" />
      <EuiButtonEmpty
        size="s"
        iconType="refresh"
        onClick={resetAccents}
        isDisabled={readOnly}
      >
        Reset to default
      </EuiButtonEmpty>

      <EuiSpacer size="l" />

      {/* Theme -------------------------------------------------------------- */}
      <Heading title="Default theme" sub="The console theme; “System” follows the OS preference." />
      <EuiButtonGroup
        legend="Default theme"
        options={THEME_OPTIONS}
        idSelected={draft.theme || 'system'}
        onChange={onTheme}
        isDisabled={readOnly}
        color="primary"
      />
      <EuiText size="xs" color="subdued">
        <p style={{ marginTop: 6 }}>
          Currently showing the <strong>{darkMode ? 'dark' : 'light'}</strong> theme.
        </p>
      </EuiText>

      <EuiSpacer size="s" />
      <EuiSwitch
        label="Default new sessions to dark mode"
        checked={draft.dark_mode_default}
        onChange={(e) => set({ dark_mode_default: e.target.checked })}
        disabled={readOnly}
      />
      <EuiText size="xs" color="subdued">
        <p style={{ marginTop: 6 }}>
          Seeds the colour mode for a fresh browser when “System” is selected and no
          per-user choice exists. A user’s own light/dark toggle always wins.
        </p>
      </EuiText>

      <EuiSpacer size="l" />

      {/* Messaging ---------------------------------------------------------- */}
      <Heading
        title="Login & messaging"
        sub="Operator-set copy shown on the login screen and console chrome."
      />
      <EuiFormRow
        label="Login subtitle"
        helpText="A short welcome line beneath the wordmark on the sign-in screen."
        fullWidth
      >
        <EuiFieldText
          value={draft.login_subtitle}
          onChange={(e) => set({ login_subtitle: e.target.value })}
          placeholder="Welcome back"
          maxLength={MAX_TEXT_LEN}
          disabled={readOnly}
          fullWidth
        />
      </EuiFormRow>
      <EuiSpacer size="m" />
      <EuiFormRow
        label="Footer text"
        helpText="A footer / classification banner line (e.g. “UNCLASSIFIED // FOUO”)."
        fullWidth
      >
        <EuiFieldText
          value={draft.footer_text}
          onChange={(e) => set({ footer_text: e.target.value })}
          placeholder="UNCLASSIFIED"
          maxLength={MAX_TEXT_LEN}
          disabled={readOnly}
          fullWidth
        />
      </EuiFormRow>
      <EuiSpacer size="m" />
      <EuiFormRow
        label="Support / docs URL"
        helpText="Target for the “Docs & help” link. Must be an http(s) URL."
        fullWidth
        isInvalid={!supportUrlValid}
        error={supportUrlValid ? undefined : 'Enter an http(s):// URL or leave blank.'}
      >
        <EuiFieldText
          value={draft.support_url}
          onChange={(e) => set({ support_url: e.target.value })}
          placeholder="https://help.example.com"
          maxLength={MAX_URL_LEN}
          isInvalid={!supportUrlValid}
          disabled={readOnly}
          fullWidth
        />
      </EuiFormRow>

      <EuiSpacer size="xl" />

      {/* Actions ------------------------------------------------------------ */}
      <EuiFlexGroup gutterSize="s" responsive={false}>
        <EuiFlexItem grow={false}>
          <EuiButton fill iconType="save" onClick={save} isLoading={saving} isDisabled={!canSave}>
            Save branding
          </EuiButton>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiButton iconType="cross" onClick={discard} isDisabled={!dirty || saving}>
            Discard
          </EuiButton>
        </EuiFlexItem>
      </EuiFlexGroup>
    </div>
  );
};

function prefersDark(): boolean {
  return typeof window !== 'undefined'
    ? window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
    : false;
}
