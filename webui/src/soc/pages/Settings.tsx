/**
 * Settings — the full Preferences console, driven by a data-driven section registry.
 *
 * Round-5 Sett-A: the former 2673-line god-file was decomposed into a single-source
 * section registry (`settings/settings-sections.ts`) + one extracted renderer per
 * section under `settings/*`. This page now:
 *   - loads GET /api/settings (`prefs` + `configured` + `read_only`) + GET /api/models;
 *   - buffers an editable `prefs` draft against the last saved snapshot;
 *   - lights a per-section "modified" dot from the DERIVED `SECTION_KEYS` map;
 *   - saves via PUT /api/settings sending ONLY the changed top-level keys (a minimal
 *     deep-merge-safe patch, never a full-doc replace — a sibling block is never wiped);
 *   - pushes write-only secret keys separately via the dedicated secrets route (the
 *     console only ever sees whether a key is configured — a boolean, never a value).
 *
 * The section rail, group structure, id union, and per-section keys are all DERIVED
 * from the ONE registry (kills the former 3-file hand-sync). The Save/Discard bar is
 * the single StickySaveBar for the whole page (no more parallel save mechanisms).
 *
 * Security: every preference value here is operator-entered (trusted); the only
 * displayed externally-derived values are model ids (plain text). No secrets are shown.
 */
import * as React from 'react';
import {
  AlertTriangle,
  Lock,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  Wand2,
} from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import type {
  ConfiguredStatus,
  ModelsResponse,
  Preferences,
} from '@/lib/types';
import { cn } from '@/lib/cn';

import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Badge } from '@/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Skeleton } from '@/ui/skeleton';
import { Card, CardContent } from '@/ui/card';

import { PageHeader } from '@/soc/components/PageHeader';
import { EmptyState } from '@/soc/components/EmptyState';
import { Can } from '@/soc/components/Can';
import { StickySaveBar } from '@/soc/components/SettingsGrid';
import {
  changedKeys as computeChangedKeys,
  changedPatch,
  sectionIsDirty,
} from '@/soc/pages/settings-dirty';
import {
  SECTION_BY_ID,
  SECTION_GROUPS,
  GRID_SECTIONS,
  isSectionId,
  sectionMatchesQuery,
  matchedAnchorsForSection,
  type SectionId,
  type SectionRenderContext,
  type SettingsSectionDef,
} from '@/soc/pages/settings/settings-sections';
import { errMsg } from '@/soc/pages/settings/primitives';
import { useNavigate, settingsSectionHash } from '@/soc/router';
import { useAuth } from '@/soc/auth';
import { usePrefersReducedMotion } from '@/soc/hooks/usePrefersReducedMotion';

/* -------------------------------------------------------------------- page -- */

export interface SettingsPageProps {
  /** Re-launch the first-run setup wizard. */
  onRerunWizard?: () => void;
  onNavigate?: (page: any, opts?: any) => void;
}

/** Read the active section from the hash query (`#/settings?s=<id>`). */
function sectionFromHash(): SectionId | null {
  try {
    // Allow underscores so deep-links like `#/settings?s=admin_users` resolve.
    const m = (window.location.hash || '').match(/[?&]s=([a-z0-9_]+)/i);
    const id = m?.[1];
    return id && isSectionId(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Read the in-section card anchor from the hash query (`#/settings?s=<id>&a=<anchor>`),
 * decoded. Returns `null` when absent. Used to scroll+highlight a specific `SettingsCard`
 * on a card-level deep-link. Anchor ids are `[a-z0-9_-]`-shaped.
 */
function anchorFromHash(): string | null {
  try {
    const m = (window.location.hash || '').match(/[?&]a=([a-z0-9_-]+)/i);
    return m?.[1] ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}

export default function Settings({ onRerunWizard, onNavigate: onNavigateProp }: SettingsPageProps) {
  const navigate = useNavigate();
  const onNavigate = onNavigateProp ?? navigate;
  const { hasPermission } = useAuth();

  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);
  const [prefs, setPrefs] = React.useState<Preferences | null>(null);
  const [savedPrefs, setSavedPrefs] = React.useState<Preferences | null>(null);
  const [configured, setConfigured] = React.useState<ConfiguredStatus>({});
  const [readOnly, setReadOnly] = React.useState(false);
  const [models, setModels] = React.useState<ModelsResponse | null>(null);
  const [section, setSectionState] = React.useState<SectionId>(() => sectionFromHash() ?? 'general');
  const [query, setQuery] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  // The pending card anchor to scroll+highlight (from `#/settings?s=<id>&a=<anchor>`).
  // Set on mount + on any hashchange carrying an `a=`; cleared once consumed by the
  // scroll/highlight effect so a re-render never re-scrolls.
  const [pendingAnchor, setPendingAnchor] = React.useState<string | null>(() => anchorFromHash());
  const reducedMotion = usePrefersReducedMotion();

  // Persist the active section (and optional card anchor) in the hash query
  // (`#/settings?s=<id>[&a=<anchor>]`) via the ONE shared hash builder, WITHOUT disturbing
  // the router (which keys on the bare page id before `?`). Writing the FULL hash directly
  // is the fix for the historical strip-bug where a bare `#/settings` dropped `?s=`/`&a=`.
  const setSection = React.useCallback((id: SectionId, anchor?: string) => {
    setSectionState(id);
    setPendingAnchor(anchor ?? null);
    try {
      const next = settingsSectionHash(id, anchor);
      if (window.location.hash !== next) window.location.hash = next;
    } catch {
      /* hash is best-effort */
    }
  }, []);

  // Keep the active section + pending anchor in sync with back/forward navigation and
  // with an external deep-link (e.g. a Cmd-K jump that wrote the full hash).
  React.useEffect(() => {
    const onHash = () => {
      const id = sectionFromHash();
      if (id) setSectionState(id);
      const a = anchorFromHash();
      if (a) setPendingAnchor(a);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Scroll to + briefly highlight the deep-linked card once the active section is
  // rendered. Reduced-motion-safe: `scrollIntoView` uses `auto` (no smooth scroll) under
  // reduced motion, and the highlight is a ring flash (box-shadow only, no transform) that
  // the global reduced-motion reset collapses to ~0 duration; either way it self-clears.
  React.useEffect(() => {
    if (!pendingAnchor || loading || !prefs) return;
    // Defer to the next frame so the freshly-rendered section body is in the DOM.
    const raf = window.requestAnimationFrame(() => {
      let el: HTMLElement | null = null;
      try {
        el = document.getElementById(pendingAnchor);
      } catch {
        el = null;
      }
      if (el) {
        el.scrollIntoView({
          behavior: reducedMotion ? 'auto' : 'smooth',
          block: 'start',
        });
        el.classList.add('animate-settings-highlight');
        window.setTimeout(() => el?.classList.remove('animate-settings-highlight'), 1800);
      }
      setPendingAnchor(null);
    });
    return () => window.cancelAnimationFrame(raf);
    // Re-run when the section changes (a deep-link switches section then anchors).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAnchor, section, loading, prefs, reducedMotion]);

  // buffered secret entries (write-only)
  const [secretDraft, setSecretDraft] = React.useState<Record<string, string>>({});
  const [savingSecrets, setSavingSecrets] = React.useState(false);

  // Per-section dirty map: the set of CHANGED top-level editable keys (vs the saved
  // snapshot). Drives the sticky save bar, per-section "modified" dots, and a MINIMAL
  // Save patch (only the changed keys, never the whole object). `sources`/
  // `setup_complete` are excluded as non-editable.
  const changed = React.useMemo(
    () =>
      computeChangedKeys(
        prefs as Record<string, unknown> | null,
        savedPrefs as Record<string, unknown> | null,
      ),
    [prefs, savedPrefs],
  );
  const dirty = changed.size > 0;
  const changedCount = changed.size;

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [settings, mdl] = await Promise.all([
        api.getSettings(),
        api.getModels().catch(() => null),
      ]);
      setPrefs(settings.prefs);
      setSavedPrefs(settings.prefs);
      setConfigured(settings.configured);
      setReadOnly(settings.read_only);
      setModels(mdl);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const update = React.useCallback(
    (patch: Partial<Preferences>) => setPrefs((p) => (p ? { ...p, ...patch } : p)),
    [],
  );

  const save = React.useCallback(async () => {
    if (!prefs) return;
    // Send ONLY the changed top-level keys (a minimal patch) rather than the whole
    // object — additive/omitted fields are safe, and we never clobber a key the user
    // did not touch (the backend PUT deep-merges). `sources`/`setup_complete` are
    // excluded inside `changedPatch`.
    const patch = changedPatch(
      prefs as Record<string, unknown>,
      savedPrefs as Record<string, unknown> | null,
    );
    if (!Object.keys(patch).length) {
      toast.message('No changes to save.');
      return;
    }
    setSaving(true);
    try {
      const res = await api.putSettings(patch as Partial<Preferences>);
      setPrefs(res.prefs);
      setSavedPrefs(res.prefs);
      toast.success('Settings saved.');
    } catch (e) {
      toast.error(errMsg(e, 'Could not save settings.'));
    } finally {
      setSaving(false);
    }
  }, [prefs, savedPrefs]);

  // Discard: revert the working draft to the last saved snapshot (a clean revert,
  // not a re-fetch, so an in-flight server change is not pulled in mid-edit).
  const discard = React.useCallback(() => {
    setPrefs(savedPrefs);
  }, [savedPrefs]);

  const saveSecrets = React.useCallback(async () => {
    const body: Record<string, string> = {};
    for (const [k, v] of Object.entries(secretDraft)) if (v && v.trim()) body[k] = v;
    if (!Object.keys(body).length) {
      toast.message('No new secret values entered.');
      return;
    }
    setSavingSecrets(true);
    try {
      const res = await api.updateSecrets(body);
      setConfigured(res.configured);
      setSecretDraft({});
      toast.success('Secret keys updated.');
    } catch (e) {
      toast.error(errMsg(e, 'Could not update keys.'));
    } finally {
      setSavingSecrets(false);
    }
  }, [secretDraft]);

  // Filtered, RBAC-aware grouped section list for the rail. A section with a `perm`
  // is hidden from users without the grant; the search matches title/blurb/keywords.
  // RULES OF HOOKS: these hooks MUST run unconditionally — i.e. ABOVE the
  // `if (loading)` / `if (!prefs)` early returns below. If they sit after a return,
  // the hook count changes once `loading` flips false on the first data load and React
  // throws #310 ("Rendered more hooks than during the previous render"). They read only
  // query/hasPermission/section state (never `prefs`), so hoisting is safe. Do NOT move
  // them back down, and do not add early returns between hooks.
  const visibleGroups = React.useMemo(() => {
    return SECTION_GROUPS.map((g) => ({
      ...g,
      sections: g.sections.filter((s) => {
        if (s.perm && !hasPermission(s.perm.resource, s.perm.action)) return false;
        // Round-5 Sett-C: deepened section- AND setting-level match — a hit on any card
        // within a section (e.g. "auto-close", "kill switch") keeps the section visible.
        return sectionMatchesQuery(s, query);
      }),
    })).filter((g) => g.sections.length > 0);
  }, [hasPermission, query]);

  const flatVisible = React.useMemo(
    () => visibleGroups.flatMap((g) => g.sections),
    [visibleGroups],
  );

  // If a search/RBAC change hides the active section, jump to the first visible one.
  React.useEffect(() => {
    if (flatVisible.length && !flatVisible.some((s) => s.id === section)) {
      setSectionState(flatVisible[0].id as SectionId);
    }
  }, [flatVisible, section]);

  /* ------------------------------------------------------------- states ---- */

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader icon={SettingsIcon} eyebrow="Platform" title="Settings" />
        <div className="grid gap-6 lg:grid-cols-[224px_minmax(0,1fr)]">
          <div className="space-y-1.5">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
          <Skeleton className="h-96 w-full rounded-lg" />
        </div>
      </div>
    );
  }

  if (!prefs) {
    return (
      <div className="space-y-6">
        <PageHeader icon={SettingsIcon} eyebrow="Platform" title="Settings" />
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" aria-hidden />
          <AlertTitle>Could not load settings</AlertTitle>
          <AlertDescription>{errMsg(error, 'No settings loaded.')}</AlertDescription>
        </Alert>
        <EmptyState
          variant="error"
          icon={SettingsIcon}
          title="Settings unavailable"
          description="The backend did not return preferences. Check connectivity and try again."
          action={
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw className="h-4 w-4" aria-hidden />
              Retry
            </Button>
          }
        />
      </div>
    );
  }

  // The single render context handed to whichever section is active. `prefs` is
  // guaranteed non-null here (past the early returns above).
  const renderCtx: SectionRenderContext = {
    prefs,
    update,
    models,
    configured,
    readOnly,
    onNavigate: onNavigate as SectionRenderContext['onNavigate'],
    setSection,
    secretDraft,
    setSecretDraft,
    onSaveSecrets: () => void saveSecrets(),
    savingSecrets,
  };

  /**
   * Render the active section from the registry. Perm-gated sections are wrapped in a
   * <Can> guard so a direct deep-link (`#/settings?s=admin_users`) that bypasses the
   * rail filter still degrades to a "restricted" notice rather than the body. The
   * no-perm personal sections (profile/account_security/sessions/customization/
   * general/models/keys/standup/enrichment) render unguarded (auth-off back-compat).
   */
  const renderSection = (def: SettingsSectionDef): React.ReactNode => {
    const body = def.Component(renderCtx);
    if (!def.perm) return body;
    const { resource, action } = def.perm;
    return (
      <Can
        resource={resource}
        action={action}
        fallback={
          <EmptyState
            icon={def.icon}
            title="Restricted"
            description={`${def.title} is managed by administrators.`}
          />
        }
      >
        {body}
      </Can>
    );
  };

  const activeDef = SECTION_BY_ID[section] ?? SECTION_BY_ID.general;
  const isGrid = GRID_SECTIONS.has(activeDef.id);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={SettingsIcon}
        eyebrow="Platform"
        title="Settings"
        description="Tune every preference the agent uses. Secrets are write-only."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {dirty ? (
              <Badge variant="warning" className="gap-1">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-warning" aria-hidden />
                {changedCount} unsaved
              </Badge>
            ) : null}
            {onRerunWizard ? (
              <Button variant="outline" size="sm" onClick={onRerunWizard}>
                <Wand2 className="h-4 w-4" aria-hidden />
                Re-run setup wizard
              </Button>
            ) : null}
          </div>
        }
      />

      {readOnly ? (
        <Alert variant="warning">
          <Lock className="h-4 w-4" aria-hidden />
          <AlertTitle>Read-only mode</AlertTitle>
          <AlertDescription>
            Settings are read-only in this deployment. Edits cannot be saved.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[256px_minmax(0,1fr)]">
        {/* Section nav: searchable, grouped, RBAC-aware. */}
        <nav aria-label="Settings sections" className="lg:sticky lg:top-4 lg:self-start">
          <div className="space-y-3">
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search settings…"
                aria-label="Search settings sections"
                className="h-9 pl-8"
              />
            </div>

            {flatVisible.length === 0 ? (
              <p className="px-1 py-3 text-xs text-muted-foreground">No sections match “{query}”.</p>
            ) : (
              <div className="space-y-4">
                {visibleGroups.map((g) => (
                  <div key={g.id} className="space-y-1">
                    <p className="px-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">
                      {g.label}
                    </p>
                    <div className="flex flex-col gap-0.5">
                      {g.sections.map((s) => {
                        const Icon = s.icon;
                        const active = section === s.id;
                        const modified = sectionIsDirty(s.id, changed);
                        // Setting-level matches under this section (only while searching).
                        const subMatches = matchedAnchorsForSection(s.id, query);
                        return (
                          <React.Fragment key={s.id}>
                            <button
                              type="button"
                              onClick={() => setSection(s.id as SectionId)}
                              aria-current={active ? 'page' : undefined}
                              data-testid={`settings-section-${s.id}`}
                              title={modified ? `${s.blurb} (unsaved changes)` : s.blurb}
                              className={cn(
                                'group inline-flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                                active
                                  ? 'bg-accent text-foreground'
                                  : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                              )}
                            >
                              <Icon
                                className={cn(
                                  'h-4 w-4 shrink-0 transition-colors',
                                  active
                                    ? 'text-primary'
                                    : 'text-muted-foreground group-hover:text-foreground',
                                )}
                                aria-hidden
                              />
                              <span className="truncate">{s.title}</span>
                              {modified ? (
                                <span
                                  className="ml-auto inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
                                  aria-label="Unsaved changes in this section"
                                  title="Unsaved changes"
                                />
                              ) : null}
                            </button>
                            {/* Setting-level deep-link sub-list (search only): jump straight
                                to the matched card via #/settings?s=<id>&a=<anchor>. */}
                            {subMatches.length > 0 ? (
                              <div className="ml-7 flex flex-col gap-0.5 border-l border-border pl-2">
                                {subMatches.map((a) => (
                                  <button
                                    key={a.anchor}
                                    type="button"
                                    onClick={() => setSection(s.id as SectionId, a.anchor)}
                                    data-testid={`settings-anchor-${a.anchor}`}
                                    title={`Jump to “${a.label}” in ${s.title}`}
                                    className="truncate rounded px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                  >
                                    {a.label}
                                  </button>
                                ))}
                              </div>
                            ) : null}
                          </React.Fragment>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </nav>

        {/* Section body. Grid sections bring their own SettingsCards (full width, no
            outer Card); simpler sections sit on the shared single-card surface. */}
        <div className="min-w-0">
          {isGrid ? (
            renderSection(activeDef)
          ) : (
            <Card>
              <CardContent className="p-6 sm:p-7">{renderSection(activeDef)}</CardContent>
            </Card>
          )}

          {/* Sticky save/discard bar — only visible while there are unsaved changes.
              Save sends only the changed keys; Discard reverts to the saved snapshot. */}
          <StickySaveBar
            visible={dirty}
            busy={saving}
            saveDisabled={readOnly}
            onSave={() => void save()}
            onDiscard={discard}
            saveLabel="Save settings"
            message={
              readOnly
                ? 'Settings are read-only — changes cannot be saved.'
                : `${changedCount} unsaved ${changedCount === 1 ? 'change' : 'changes'}.`
            }
          />
        </div>
      </div>

      <p className="border-t border-border pt-4 text-xs leading-relaxed text-muted-foreground">
        Changes to preferences take effect after Save. Secret keys are stored write-only — the
        console only ever knows whether a key is configured.
      </p>
    </div>
  );
}
