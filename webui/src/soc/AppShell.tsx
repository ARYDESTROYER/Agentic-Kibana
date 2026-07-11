/**
 * App shell for the SOC console — a slim left ICON RAIL + a top bar + the routed
 * content slot.
 *
 * - Rail: the registry-derived `NavSidebar` (collapsible groups Overview / Triage /
 *   Intelligence / Analytics / Notifications / Platform, per nav.ts ← registry.FEATURES),
 *   with disclosure groups + fly-outs when collapsed; the active item is highlighted
 *   with `bg-primary` + `shadow-glow`. Width toggles with Cmd/Ctrl-B (persisted).
 * - Top bar: product breadcrumb ("<Product> / <Page>" using OUR product name from
 *   branding), and on the right a theme toggle, version badge, a health pill
 *   (polls /api/health, debounced), an optional user chip + logout, and a Cmd-K
 *   hint that opens a cmdk command palette for navigation.
 * - Content: `bg-canvas`, the single gutter/vertical-rhythm authority for every
 *   routed page (per-page width is capped/centered by `<PageContainer variant>`),
 *   re-keyed on the page id so it replays `animate-fade-in` on every route change.
 *
 * Health-poll behaviour mirrors the legacy Shell: poll every 15s, only flip to
 * "unreachable" after 2 consecutive failures, and label Healthy / Store degraded
 * / Backend unreachable. UNTRUSTED branding text renders as plain text only.
 */
import * as React from 'react';
import {
  Moon,
  Sun,
  CheckCircle2,
  AlertTriangle,
  Database,
  Loader2,
  XCircle,
  LogOut,
  UserCircle2,
  ShieldCheck,
  MonitorSmartphone,
  Monitor,
  Palette,
  ChevronDown,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
} from 'lucide-react';
import { Button } from '@/ui/button';
import { Badge } from '@/ui/badge';
import { Separator } from '@/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/ui/dropdown-menu';
import { cn } from '@/lib/cn';
import { api } from '@/lib/api';
import { initialsFrom } from '@/lib/avatar';
import { humanizeToken } from '@/lib/format';
import type { AccountProfile, HealthResponse } from '@/lib/types';
import { useTheme } from './theme';
import { usePrefs } from './prefs';
import { useDemo } from './demo';
import { DemoBanner } from './components/DemoBanner';
import { AnnouncerProvider } from './components/announcer';
import { CommandPalette } from './components/CommandPalette';
import { GlassSurface } from './components/GlassSurface';
import { NavSidebar, useNavPrefs } from './components/NavSidebar';
import { NotificationBell } from './components/NotificationBell';
import { navItem, navLabel, type PageId } from './nav';
import type { Navigate } from './router';
// TYPE-ONLY import (elided at build → zero runtime import): motion.dev must NEVER ride
// the eager App/AppShell first-paint graph, so RouteMotion is reached purely through the
// DYNAMIC `import()` below. See soc/components/motion/* + bundle-first-paint.test.ts.
import type { RouteMotionProps } from './components/motion/RouteMotion';

/** The single content inset (gutter + vertical rhythm) applied to every routed page. */
const CONTENT_INSET = 'mx-auto w-full min-w-0 px-4 py-6 sm:px-6 lg:px-8 2xl:px-12';

export interface AppShellProps {
  /** The currently-active page id (drives the rail highlight + breadcrumb). */
  page: PageId;
  /** Navigate to another page (rail clicks + command palette). */
  onNavigate: Navigate;
  /** When auth is enabled + authenticated, the signed-in username. */
  username?: string | null;
  /** Called when the user clicks "Log out" (only rendered when `username` set). */
  onLogout?: () => void;
  /** The routed page content. */
  children: React.ReactNode;
}

type HealthTone = 'success' | 'warning' | 'critical' | 'muted';

interface HealthView {
  tone: HealthTone;
  /** Short pill label. */
  label: string;
  icon: typeof CheckCircle2;
  /** One-line summary (store_type etc.) — plain text. */
  detail: string;
  /** A bold popover heading. */
  title: string;
  /** Multi-line plain-language help: meaning + consequence + how to fix. */
  help: string;
}

/** The in-memory ES fallback's class name (own-state runs in memory, no persistence). */
const isInMemoryStore = (t?: string): boolean => t === 'InMemoryESClient';

export function healthView(health: HealthResponse | null, err: boolean): HealthView {
  if (err) {
    return {
      tone: 'critical',
      label: 'Backend unreachable',
      icon: XCircle,
      detail: 'Cannot reach the backend API',
      title: 'Backend unreachable',
      help:
        'The console cannot reach the backend API. The agentic pipeline, cases and ' +
        'settings are unavailable until it returns.\n\n' +
        'How to fix: confirm the tlsoc-backend service is running and reachable; ' +
        'see docs/TROUBLESHOOTING.md.',
    };
  }
  // Before the first /api/health resolves (health === null and not yet failed twice)
  // we know NOTHING about the store — show a neutral "Checking…" note, never the
  // alarming amber "State store unreachable" fall-through below (which would flash on
  // every fresh load and mislabel the first ~15s of a total backend outage).
  if (health === null) {
    return {
      tone: 'muted',
      label: 'Checking…',
      icon: Loader2,
      detail: 'Contacting backend',
      title: 'Checking backend health…',
      help: 'Waiting for the first /api/health response. The pill updates as soon as the backend replies.',
    };
  }
  const storeType = health?.store_type ?? 'unknown';
  // The in-memory ES fallback pings OK (reports es_connected:true) but does NOT
  // persist — surface it as a muted, informative note rather than a green "Healthy".
  if (health?.es_connected && isInMemoryStore(storeType)) {
    return {
      tone: 'muted',
      label: 'In-memory store',
      icon: Database,
      detail: `Store: ${storeType}`,
      title: 'In-memory store (not persistent)',
      help:
        "The platform's own state store is running in-memory (Elasticsearch/SQL " +
        'not reachable). Cases, cursors, audit and settings will NOT persist across ' +
        'a backend restart.\n\n' +
        'How to fix: set STATE_BACKEND=elasticsearch or postgres and configure ' +
        'connectivity (see DEPLOY.md).',
    };
  }
  if (health?.es_connected) {
    return {
      tone: 'success',
      label: 'Healthy',
      icon: CheckCircle2,
      detail: `Store: ${storeType}`,
      title: 'Healthy',
      help: `Own-state store connected and persisting. Store: ${storeType}.`,
    };
  }
  return {
    tone: 'warning',
    label: 'State store unreachable',
    icon: AlertTriangle,
    detail: `Store: ${storeType}`,
    title: 'State store unreachable',
    help:
      `The platform's own state store (${storeType}) is not reachable. New cases, ` +
      'cursors and audit may fail to persist.\n\n' +
      'How to fix: check the store connection and credentials; ' +
      'see docs/TROUBLESHOOTING.md.',
  };
}

const TONE_PILL: Record<HealthTone, string> = {
  success: 'border-success/40 text-success',
  warning: 'border-warning/40 text-warning',
  critical: 'border-critical/40 text-critical',
  muted: 'border-border text-muted-foreground',
};

/** Poll /api/health every 15s, debouncing transient failures. */
function useHealth(): { health: HealthResponse | null; err: boolean } {
  const [health, setHealth] = React.useState<HealthResponse | null>(null);
  const [err, setErr] = React.useState(false);
  const failRef = React.useRef(0);

  React.useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const h = await api.health();
        if (!alive) return;
        failRef.current = 0;
        setHealth(h);
        setErr(false);
      } catch {
        if (!alive) return;
        failRef.current += 1;
        if (failRef.current >= 2) setErr(true);
      }
    };
    void poll();
    const t = window.setInterval(poll, 15000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  return { health, err };
}

/**
 * Best-effort fetch of the signed-in user's profile (avatar + display name) so the
 * shell user chip reflects it. Only runs when auth is on + a username is present;
 * any failure leaves `profile` null and the chip falls back to initials + username.
 */
function useAccountProfile(active: boolean): AccountProfile | null {
  const [profile, setProfile] = React.useState<AccountProfile | null>(null);
  React.useEffect(() => {
    if (!active) {
      setProfile(null);
      return undefined;
    }
    let alive = true;
    void (async () => {
      try {
        const p = await api.account.get();
        if (alive) setProfile(p);
      } catch {
        if (alive) setProfile(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [active]);
  return profile;
}

/** Small round avatar (image + initials fallback) used in the shell user chip. */
export const UserAvatar: React.FC<{ src?: string; name: string; className?: string }> = ({
  src,
  name,
  className,
}) => {
  const [broken, setBroken] = React.useState(false);
  // Re-sync when the source changes (e.g. a profile refetch after the user updates
  // their picture): a one-time onError must not permanently pin the initials fallback
  // for a NEW, valid URL.
  React.useEffect(() => setBroken(false), [src]);
  if (src && !broken) {
    return (
      // onError is a broken-image fallback (swap to initials), not a user
      // interaction — the rule flags any handler on a non-interactive element.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
      <img
        src={src}
        alt=""
        onError={() => setBroken(true)}
        className={cn('h-6 w-6 rounded-full border border-border object-cover', className)}
      />
    );
  }
  return (
    <span
      className={cn(
        'flex h-6 w-6 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary',
        className,
      )}
      aria-hidden
    >
      {initialsFrom(name)}
    </span>
  );
};

/**
 * The signed-in user chip — an avatar + display name that opens a menu with the
 * profile, security, and a destructive log-out. Reflects the live profile
 * (avatar/display_name) when available; falls back to the username + initials. All
 * text is user-set → rendered as PLAIN text (#9).
 */
const UserMenu: React.FC<{
  username: string;
  profile: AccountProfile | null;
  onNavigate: Navigate;
  onLogout?: () => void;
}> = ({ username, profile, onNavigate, onLogout }) => {
  const display = (profile?.display_name || username).trim();
  const role = profile?.role ? humanizeToken(String(profile.role)) : '';
  const { themeMode, setThemeMode } = usePrefs();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex items-center gap-2 rounded-full border border-border bg-card py-1 pl-1 pr-2 text-xs',
            'transition-colors hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
          aria-label="Open account menu"
        >
          <UserAvatar src={profile?.avatar} name={display} />
          <span className="hidden max-w-[140px] truncate font-medium sm:inline">{display}</span>
          <ChevronDown className="hidden h-3.5 w-3.5 text-muted-foreground sm:inline" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="flex items-center gap-2.5 py-2.5 text-foreground">
          <UserAvatar src={profile?.avatar} name={display} className="h-8 w-8 text-xs" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{display}</span>
            <span className="block truncate text-xs font-normal text-muted-foreground">
              {role ? `${role} · @${username}` : `@${username}`}
            </span>
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onNavigate('account')}>
          <UserCircle2 aria-hidden />
          Profile
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onNavigate('security')}>
          <ShieldCheck aria-hidden />
          Security &amp; two-factor
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onNavigate('sessions')}>
          <MonitorSmartphone aria-hidden />
          Sessions &amp; activity
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {/* Per-user theme (Wave 7): persisted to the user's prefs. 'system' follows the
            organization default theme when one is set, otherwise the device (Round-6 §18 —
            mirrors the CustomizationSection copy; the org-default cascade lives in
            stores/user_prefs.py). */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Palette aria-hidden />
            Appearance
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={themeMode}
              onValueChange={(v) => setThemeMode(v as 'light' | 'dark' | 'system')}
            >
              <DropdownMenuRadioItem value="light">
                <Sun className="mr-2 size-4" aria-hidden />
                Light
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">
                <Moon className="mr-2 size-4" aria-hidden />
                Dark
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">
                <Monitor className="mr-2 size-4" aria-hidden />
                System
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            {/* Accurate System-mode copy (Round-6 §18): matches the org-default cascade
                and the CustomizationSection helper text — never the bare "follows the OS". */}
            <p className="max-w-[220px] px-2 pb-1 pt-1.5 text-xs leading-snug text-muted-foreground">
              “System” follows the organization default theme when one is set, otherwise
              your device setting.
            </p>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {onLogout ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={onLogout}
              className="text-critical focus:text-critical [&>svg]:text-critical"
            >
              <LogOut aria-hidden />
              Log out
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export const AppShell: React.FC<AppShellProps> = ({
  page,
  onNavigate,
  username,
  onLogout,
  children,
}) => {
  const { isDark, branding } = useTheme();
  const { setThemeMode } = usePrefs();
  // The header toggle flips light↔dark AND persists the choice to the user's prefs
  // (Wave 7), so it survives a reload + follows the user across devices.
  const toggleTheme = React.useCallback(
    () => setThemeMode(isDark ? 'light' : 'dark'),
    [isDark, setThemeMode],
  );
  const { health, err } = useHealth();
  const { active: demoActive, refresh: refreshDemo } = useDemo();
  const profile = useAccountProfile(Boolean(username));
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  // Nav collapse + open-group state (shell-owned; hydrates synchronously from a
  // localStorage mirror to avoid a first-paint flash, then reconciles with the
  // server-side UserPrefs.misc and persists every change). See useNavPrefs.
  const { collapsed, toggleCollapsed, openGroups, toggleGroup, openGroup } = useNavPrefs();

  // TASK 6 — HOVER-TO-EXPAND for the collapsed icon rail. When the PERSISTED pref is
  // "collapsed" (a 64px rail), pointing at (or keyboard-focusing) the rail temporarily
  // expands it to the full labelled drawer, then collapses back on leave. This is a
  // TRANSIENT visual overlay only — we never call setCollapsed, so the user's persisted
  // choice is untouched and a PINNED-OPEN sidebar (collapsed === false) is unaffected.
  // Pointer + focus are tracked separately and OR'd so a keyboard user mid-navigation
  // keeps the labels even if the pointer wanders off the rail.
  const [railHovered, setRailHovered] = React.useState(false);
  const [railFocused, setRailFocused] = React.useState(false);
  const transientExpand = railHovered || railFocused;
  // The width the sidebar actually renders at: the persisted rail expands on hover/focus,
  // a pinned-open drawer is left alone.
  const effectiveCollapsed = collapsed && !transientExpand;

  // Refetch the demo status on every route change so the banner/badges stay fresh
  // even between the background poll ticks (cheap GET; inert when demo is off).
  React.useEffect(() => {
    void refreshDemo();
  }, [page, refreshDemo]);

  // ---- Route/page transitions (motion.dev, lazy) ------------------------------------
  // Progressive enhancement: the motion.dev layer is dynamically imported AFTER first
  // paint (never on the eager entry graph — that would break the <400 kB entry budget),
  // and the animated route wrapper is engaged only on an ACTUAL page navigation that
  // happens WHILE the chunk is already loaded. That keeps the initial landing page — and
  // any page shown when the chunk merely finishes resolving — on its cheap CSS
  // `animate-fade-in` with NO remount / no double data-fetch; from the first navigation
  // after motion is ready onward, AnimatePresence cross-fades page → page.
  const [RouteMotion, setRouteMotion] = React.useState<React.ComponentType<RouteMotionProps> | null>(
    null,
  );
  React.useEffect(() => {
    let alive = true;
    void import('./components/motion/RouteMotion').then((mod) => {
      if (alive) setRouteMotion(() => mod.RouteMotion);
    });
    return () => {
      alive = false;
    };
  }, []);
  // BUG FIX (motion #1): the render branch must NOT flip plain→motion merely because the
  // lazy chunk RESOLVED. Keying the branch on `Boolean(RouteMotion)` meant that when the
  // chunk arrived mid-session while a page was already displayed, React unmounted +
  // remounted that SAME page (losing its component state, double-firing mount effects,
  // re-fetching data). Instead, a monotonic `motionActive` latch flips to `true` ONLY at
  // the moment of a real navigation (`page` changed since the last render) AND only when
  // the chunk is already loaded then — never on the chunk resolving while the page is
  // unchanged. Both set-states run during render (React's supported "adjust state while
  // rendering" pattern; React discards the intermediate render and re-renders with the
  // updated state BEFORE committing), so the first motion-engaging navigation lands
  // straight in the motion branch with no plain→motion remount of the incoming page.
  const [prevPage, setPrevPage] = React.useState(page);
  const [motionActive, setMotionActive] = React.useState(false);
  if (page !== prevPage) {
    setPrevPage(page);
    // A real navigation just happened. Engage motion from now on IFF the chunk is loaded;
    // if it is not, stay plain — a later chunk resolution alone must never flip the branch.
    if (RouteMotion && !motionActive) setMotionActive(true);
  }
  const useMotionRoute = motionActive && Boolean(RouteMotion);

  // Product name for the breadcrumb prefix; falls back to a neutral default.
  const productName = branding.product_name?.trim() || branding.org_name?.trim() || 'ASP';
  const logoUrl = branding.logo_data_url?.trim() || '';
  // Breadcrumb leaf label — resolves top-level items, disclosure children, and the
  // consolidated sub-pages (navItem only knows top-level rail items).
  const pageLabel = navItem(page)?.label ?? navLabel(page);

  const baseHv = healthView(health, err);
  // Round-2 Wave 5 tie-in (promised in W1): while demo mode is active the app's own
  // state runs in a throwaway in-memory store, so a "Store degraded"/unreachable
  // warning is expected and irrelevant — MUTE it to a calm demo note rather than
  // alarming the operator. The backend-unreachable critical state still shows.
  const hv: HealthView =
    demoActive && baseHv.tone !== 'critical'
      ? {
          tone: 'muted',
          label: 'Demo mode',
          icon: Database,
          detail: 'Synthetic data (in-memory)',
          title: 'Demo mode — health checks muted',
          help:
            "Demo mode is active, so the platform's own state runs in a throwaway " +
            'in-memory store. Store warnings are expected and muted here. Exit demo ' +
            'mode to see the real store health.',
        }
      : baseHv;
  const HealthIcon = hv.icon;

  // Cmd/Ctrl-K opens the palette; Cmd/Ctrl-B toggles the sidebar width.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (k === 'b') {
        e.preventDefault();
        toggleCollapsed();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleCollapsed]);

  // The hamburger toggle, shared by the expanded-header + collapsed-rail slots.
  const navToggle = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={toggleCollapsed}
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          aria-keyshortcuts="Control+B Meta+B"
        >
          {collapsed ? (
            <PanelLeftOpen className="h-4 w-4" aria-hidden />
          ) : (
            <PanelLeftClose className="h-4 w-4" aria-hidden />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side={collapsed ? 'right' : 'bottom'}>
        {collapsed ? 'Expand navigation' : 'Collapse navigation'}
        <kbd className="ml-1.5 rounded border border-border bg-muted px-1 text-[10px]">⌘B</kbd>
      </TooltipContent>
    </Tooltip>
  );

  return (
    // AnnouncerProvider mounts the ONE app-level aria-live region (§6.3 / E3) and
    // shares announce() so deep components (DataTable sort/bulk outcomes, etc.) can
    // speak status to assistive tech without a visible UI change.
    <AnnouncerProvider>
    <div className="flex min-h-screen bg-canvas text-foreground">
      {/* Skip-to-main link (#1 — WCAG 2.4.1). Visually hidden until it receives
          keyboard focus, then it pins to the top-left so a keyboard/SR user can jump
          straight past the nav to the routed content (#socMain). */}
      <a
        href="#socMain"
        className={cn(
          'sr-only z-[100] rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground shadow-elev2',
          'focus:not-sr-only focus:fixed focus:left-3 focus:top-3',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
        )}
      >
        Skip to main content
      </a>

      {/* ---- Single expandable navigation sidebar (icon rail ↔ labelled drawer) --
          The wrapper reserves the nav's LAYOUT FOOTPRINT (64px collapsed / 240px
          pinned-open). When the persisted rail is hover/focus-expanded, only the
          sidebar INSIDE grows to the drawer width and FLOATS over the content
          (elevated via `floating`), so the footprint — and the page layout — never
          shift on hover (no reflow). `min-w-0` defeats flex `min-width:auto` so the
          overflowing drawer can exceed the reserved 64px. onMouseEnter/Leave +
          onFocus/Blur drive the transient expand; the persisted pref is untouched. */}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- purely
          presentational hover/focus affordance (expand-on-hover); the nav inside is
          fully operable without it, so giving this wrapper an interactive role would be
          semantically wrong. */}
      <div
        className={cn(
          // Springy ease (the app's `--motion-ease-premium` curve) gives the rail a
          // physical "settle" without pulling the motion.dev runtime onto the eager
          // first-paint graph (NavSidebar/AppShell are eager; motion stays lazy, §budget).
          'relative shrink-0 min-w-0 transition-[width] duration-200 ease-premium motion-reduce:transition-none',
          collapsed ? 'z-40 w-16' : 'w-60',
        )}
        onMouseEnter={() => setRailHovered(true)}
        onMouseLeave={() => setRailHovered(false)}
        onFocus={() => setRailFocused(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setRailFocused(false);
        }}
      >
        <NavSidebar
          page={page}
          onNavigate={onNavigate}
          collapsed={effectiveCollapsed}
          floating={collapsed}
          openGroups={openGroups}
          onToggleGroup={toggleGroup}
          onOpenGroup={openGroup}
          logoUrl={logoUrl}
          productName={productName}
          toggleSlot={navToggle}
        />
      </div>

      {/* ---- Main column --------------------------------------------------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar — frosted command-center chrome (GlassSurface honours
            prefers-reduced-transparency by falling back to a solid surface). */}
        <GlassSurface
          as="header"
          blur="md"
          rim={false}
          className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border px-4"
        >
          {/* Breadcrumb: OUR product name / current page (plain text — untrusted). */}
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
            <span className="truncate font-semibold text-foreground">{productName}</span>
            <span className="text-muted-foreground" aria-hidden>
              /
            </span>
            <span className="truncate text-muted-foreground">{pageLabel}</span>
          </nav>

          {/* Wide search trigger — an input-styled button that spans the bar and
              opens the command palette (Cmd-K). It grows to fill the space between
              the breadcrumb and the right cluster; on the narrowest widths it is
              hidden and the `sm:hidden` icon opener in the right cluster takes over.
              The visible placeholder is decorative — the accessible name comes from
              `aria-label` so it stays distinct from the mobile "Open search" opener. */}
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            aria-label="Search cases, sources, and actions"
            aria-keyshortcuts="Control+K Meta+K"
            className={cn(
              'hidden h-9 min-w-0 max-w-md flex-1 items-center gap-2 rounded-md border border-input bg-background/60 px-3 text-sm text-muted-foreground transition-colors sm:flex lg:max-w-lg',
              'hover:border-border-strong hover:text-foreground',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            )}
          >
            <Search className="h-4 w-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-left">
              Search cases, sources, actions…
            </span>
            <kbd className="ml-1 hidden shrink-0 rounded border border-border bg-muted px-1 text-[10px] font-medium md:inline-block">
              ⌘K
            </kbd>
          </button>

          <div className="ml-auto flex items-center gap-2">
            {/* Compact search opener for the narrowest widths, where the wide trigger
                above is hidden (`sm:hidden`). Opens the same command palette. */}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 sm:hidden"
              onClick={() => setPaletteOpen(true)}
              aria-label="Open search"
              aria-keyshortcuts="Control+K Meta+K"
            >
              <Search className="h-4 w-4" aria-hidden />
            </Button>

            {/* In-app notification bell (#8) — self-contained: polls the unread
                count, opens a recent-items dropdown, links to the Inbox page. */}
            <NotificationBell onNavigate={onNavigate} />

            {/* Theme toggle */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={toggleTheme}
                  aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
                >
                  {isDark ? (
                    <Sun className="h-4 w-4" aria-hidden />
                  ) : (
                    <Moon className="h-4 w-4" aria-hidden />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{isDark ? 'Light mode' : 'Dark mode'}</TooltipContent>
            </Tooltip>

            {/* Version badge */}
            {health?.version ? (
              <Badge variant="outline" className="hidden font-normal md:inline-flex">
                v{health.version}
              </Badge>
            ) : null}

            {/* Health pill — a click-to-open Popover with plain-language help.
                store_type/help text is backend-derived and rendered as PLAIN
                text only (never markup). */}
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-xs font-medium',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    TONE_PILL[hv.tone],
                  )}
                  aria-live="polite"
                  aria-label={`Platform health: ${hv.label}`}
                >
                  <HealthIcon className="h-3.5 w-3.5" aria-hidden />
                  <span className="hidden sm:inline">{hv.label}</span>
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-80 space-y-1.5 text-xs leading-relaxed">
                <p className="flex items-center gap-1.5 font-semibold text-foreground">
                  <HealthIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  {hv.title}
                </p>
                <p className="whitespace-pre-line text-muted-foreground">{hv.help}</p>
                <p className="border-t border-border pt-1.5 font-mono text-[11px] text-muted-foreground">
                  {hv.detail}
                </p>
              </PopoverContent>
            </Popover>

            {/* User chip + menu (only when auth enabled + authenticated) */}
            {username ? (
              <>
                <Separator orientation="vertical" className="hidden h-6 sm:block" />
                <UserMenu
                  username={username}
                  profile={profile}
                  onNavigate={onNavigate}
                  onLogout={onLogout}
                />
              </>
            ) : null}
          </div>
        </GlassSurface>

        {/* Content slot — re-keyed so the fade-in replays on each route change.
            tabIndex={-1} lets the skip-link (#1) move focus here without making it a
            tab stop in the normal order.

            W0-C: the hard `max-w-[1400px]` cap was removed — per-page WIDTH is now
            owned by `<PageContainer variant>` (§4.1). This wrapper is the SINGLE
            gutter/vertical-rhythm authority applied exactly once to every routed page
            (PageContainer no longer re-declares the gutter), so PageContainer and
            not-yet-migrated pages share one consistent inset. Keep `min-w-0` so
            flex/grid children can shrink + truncate. */}
        <main id="socMain" role="main" tabIndex={-1} className="flex-1 outline-none">
          {/* Once a real navigation has engaged motion (the lazy chunk was loaded AT the
              time of that navigation — see the `motionActive` latch above), the routed
              content is wrapped in RouteMotion's AnimatePresence for a page → page
              cross-fade; before that it keeps the cheap enter-only CSS fade. The branch
              never flips just because the chunk finished resolving, so neither the landing
              page nor the page shown when the chunk arrives is ever remounted. Both paths
              share CONTENT_INSET so the gutter/vertical rhythm is identical. */}
          {useMotionRoute && RouteMotion ? (
            <RouteMotion routeKey={page} className={CONTENT_INSET}>
              {/* Demo-mode banner — renders only when the demo tenant is active. */}
              <DemoBanner />
              <div className={cn(demoActive && 'mt-4')}>{children}</div>
            </RouteMotion>
          ) : (
            <div key={page} className={cn(CONTENT_INSET, 'animate-fade-in')}>
              {/* Demo-mode banner — renders only when the demo tenant is active. */}
              <DemoBanner />
              <div className={cn(demoActive && 'mt-4')}>{children}</div>
            </div>
          )}
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onNavigate={onNavigate}
      />
    </div>
    </AnnouncerProvider>
  );
};
