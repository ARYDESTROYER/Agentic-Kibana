/**
 * CustomizationSection — Settings > Appearance & customization (Wave 7).
 *
 * Two-store model surfaced in one panel:
 *  - PERSONAL (every signed-in user): the colour-mode theme + a manager for the
 *    user's saved views (delete + clone an org-shared one into the personal set).
 *  - ORG (admin-only, wrapped in <Can>): the terminology label editor + the org
 *    default theme. Org edits go through `api.prefs.putOrg` / `api.terminology.put`,
 *    then the cascade is refreshed so the change applies immediately.
 *
 * SECURITY (#9): every terminology key/label + saved-view name is user/operator DATA
 * — rendered as plain text, never markup, never an LLM-prompt input.
 *
 * IMPORTANT (React #310): every hook is declared at the top of the component, ABOVE
 * any conditional return.
 */
import * as React from 'react';
import { Sun, Moon, Monitor, Trash2, Copy, Save, Bookmark, Users } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import type { OrgCustomization, ThemeMode } from '@/lib/types';
import { usePrefs, DEFAULT_TERMS } from '@/soc/prefs';
import { Can, useCan } from '@/soc/components/Can';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { RadioGroup, RadioGroupItem } from '@/ui/radio-group';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/ui/select';
import { toast } from 'sonner';

const THEME_OPTIONS: Array<{ value: ThemeMode; label: string; icon: typeof Sun }> = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

/** The high-traffic terminology keys offered in the editor (each defaulted). */
const TERM_KEYS: Array<{ key: string; help: string }> = [
  { key: 'cases', help: 'The "Cases" nav + page title' },
  { key: 'case', help: 'The singular noun, e.g. "this case"' },
  { key: 'alerts', help: 'The "Alerts" label' },
  { key: 'alert', help: 'The singular alert noun' },
  { key: 'sources', help: 'The "Sources" label' },
  { key: 'source', help: 'The singular source noun' },
  { key: 'analyst', help: 'The operator role noun' },
];

export const CustomizationSection: React.FC = () => {
  const { themeMode, setThemeMode, savedViews, deleteView, cloneView, refresh } = usePrefs();
  const isAdmin = useCan('settings', 'manage');

  // ORG terminology draft (admin). Hydrated from the org prefs on mount.
  const [terms, setTerms] = React.useState<Record<string, string>>({});
  const [orgTheme, setOrgTheme] = React.useState<ThemeMode>('system');
  const [orgLoaded, setOrgLoaded] = React.useState(false);
  const [savingOrg, setSavingOrg] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const org = await api.prefs.getOrg();
        if (!alive) return;
        setTerms({ ...(org.terminology ?? {}) });
        setOrgTheme((org.default_theme as ThemeMode) ?? 'system');
      } catch {
        /* non-admins may 403 on a future write — the GET is allowed, but be safe */
      } finally {
        if (alive) setOrgLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const setTerm = (key: string, value: string) =>
    setTerms((t) => ({ ...t, [key]: value }));

  const saveTerminology = async () => {
    setSavingOrg(true);
    // Drop blank labels so they fall back to the built-in default.
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(terms)) {
      if (v && v.trim()) cleaned[k] = v;
    }
    try {
      await api.terminology.put(cleaned);
      await refresh();
      toast.success('Terminology saved');
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Could not save terminology';
      toast.error(msg);
    } finally {
      setSavingOrg(false);
    }
  };

  const saveOrgDefaults = async () => {
    setSavingOrg(true);
    try {
      const patch: OrgCustomization = { default_theme: orgTheme };
      await api.prefs.putOrg(patch);
      await refresh();
      toast.success('Org defaults saved');
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Could not save org defaults';
      toast.error(msg);
    } finally {
      setSavingOrg(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* ---- Personal theme -------------------------------------------------- */}
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Theme</h3>
          <p className="text-sm text-muted-foreground">
            Your personal colour mode. “System” follows your device. Saved to your
            account, so it follows you across devices.
          </p>
        </div>
        <RadioGroup
          value={themeMode}
          onValueChange={(v) => setThemeMode(v as ThemeMode)}
          className="flex flex-wrap gap-3"
        >
          {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
            <Label
              key={value}
              htmlFor={`theme-${value}`}
              className="flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 has-[:checked]:border-primary has-[:checked]:ring-1 has-[:checked]:ring-primary"
            >
              <RadioGroupItem id={`theme-${value}`} value={value} />
              <Icon className="size-4" aria-hidden />
              <span className="text-sm">{label}</span>
            </Label>
          ))}
        </RadioGroup>
      </section>

      {/* ---- Saved views (personal) ----------------------------------------- */}
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Saved views</h3>
          <p className="text-sm text-muted-foreground">
            Reusable list configurations. Create them from a list’s “Save view”
            button; manage them here. Org-shared views are marked.
          </p>
        </div>
        {savedViews.length === 0 ? (
          <div className="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
            <Bookmark className="size-4" aria-hidden />
            No saved views yet. Save one from the Cases list.
          </div>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {savedViews.map((v) => (
              <li key={v.id} className="flex items-center gap-2 px-3 py-2">
                <Bookmark className="size-4 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">{v.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {v.scope || 'cases'}
                  </span>
                </span>
                {v.shared ? (
                  <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    <Users className="size-3" aria-hidden />
                    Shared
                  </span>
                ) : null}
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label={`Clone ${v.name}`}
                  onClick={() => void cloneView(v.id).then((c) => c && toast.success(`Cloned “${v.name}”`))}
                >
                  <Copy className="size-4" aria-hidden />
                </Button>
                {!v.shared ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-critical hover:text-critical"
                    aria-label={`Delete ${v.name}`}
                    onClick={() =>
                      void deleteView(v.id).then((ok) => ok && toast.success(`Deleted “${v.name}”`))
                    }
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---- Terminology + org defaults (admin only) ------------------------ */}
      <Can resource="settings" action="manage">
        <section className="space-y-4 border-t border-border pt-6">
          <div>
            <h3 className="text-sm font-semibold text-foreground">
              Terminology <span className="text-xs font-normal text-muted-foreground">(org default — admin)</span>
            </h3>
            <p className="text-sm text-muted-foreground">
              Rename high-traffic labels org-wide (e.g. call a case an “incident”).
              Leave blank to use the built-in label. Plain text only.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {TERM_KEYS.map(({ key, help }) => (
              <div key={key} className="space-y-1">
                <Label htmlFor={`term-${key}`} className="text-xs text-muted-foreground">
                  {key}{' '}
                  <span className="text-muted-foreground/70">
                    (default: {DEFAULT_TERMS[key] ?? key})
                  </span>
                </Label>
                <Input
                  id={`term-${key}`}
                  value={terms[key] ?? ''}
                  onChange={(e) => setTerm(key, e.target.value)}
                  placeholder={DEFAULT_TERMS[key] ?? key}
                  aria-label={`Terminology for ${key} — ${help}`}
                  disabled={!orgLoaded}
                  maxLength={120}
                />
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => void saveTerminology()} disabled={savingOrg || !orgLoaded}>
              <Save className="mr-1.5 size-4" aria-hidden />
              Save terminology
            </Button>
          </div>

          <div className="space-y-2 pt-2">
            <Label className="text-xs text-muted-foreground">Org default theme</Label>
            <div className="flex items-center gap-2">
              <Select value={orgTheme} onValueChange={(v) => setOrgTheme(v as ThemeMode)}>
                <SelectTrigger className="w-[12rem]" aria-label="Org default theme">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="system">System</SelectItem>
                  <SelectItem value="light">Light</SelectItem>
                  <SelectItem value="dark">Dark</SelectItem>
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void saveOrgDefaults()}
                disabled={savingOrg || !orgLoaded}
              >
                Save default
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Applied to users who haven’t picked their own theme.
            </p>
          </div>
        </section>
      </Can>

      {!isAdmin ? (
        <p className="text-xs text-muted-foreground">
          Terminology &amp; organization defaults are managed by an administrator.
        </p>
      ) : null}
    </div>
  );
};

export default CustomizationSection;
