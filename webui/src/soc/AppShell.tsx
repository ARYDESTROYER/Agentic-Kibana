/**
 * App shell for the SOC console — a slim left ICON RAIL + a top bar + the routed
 * content slot.
 *
 * - Rail (~64px): icon-only nav, grouped (TRIAGE / AUTOMATION / PLATFORM) with
 *   thin separators, each item a tooltip'd button; the active item is a filled
 *   primary square.
 * - Top bar: product breadcrumb ("ASP / <Page>" using OUR product name from
 *   branding), and on the right a theme toggle, version badge, a health pill
 *   (polls /api/health, debounced), an optional user chip + logout, and a Cmd-K
 *   hint that opens a cmdk command palette for navigation.
 * - Content: `bg-canvas`, a centered container, re-keyed on the page id so it
 *   replays `animate-fade-in` on every route change.
 *
 * Health-poll behaviour mirrors the legacy Shell: poll every 15s, only flip to
 * "unreachable" after 2 consecutive failures, and label Healthy / Store degraded
 * / Backend unreachable. UNTRUSTED branding text renders as plain text only.
 */
import * as React from 'react';
import {
  Moon,
  Sun,
  Shield,
  CheckCircle2,
  AlertTriangle,
  Database,
  XCircle,
  LogOut,
  UserCircle2,
  ShieldCheck,
  MonitorSmartphone,
  Monitor,
  Palette,
  ChevronDown,
  Command as CommandIcon,
  type LucideIcon,
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
import { useAuth } from './auth';
import { useDemo } from './demo';
import { DemoBanner } from './components/DemoBanner';
import { CommandPalette } from './components/CommandPalette';
import { NAV_GROUPS, navItem, type NavGroup, type PageId } from './nav';
import type { Navigate } from './router';

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

/** One rail item: an icon button with a tooltip; active = filled primary square. */
const RailItem: React.FC<{
  id: PageId;
  label: string;
  icon: LucideIcon;
  active: boolean;
  onSelect: () => void;
}> = ({ label, icon: Icon, active, onSelect }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <button
        type="button"
        onClick={onSelect}
        aria-label={label}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex h-10 w-10 items-center justify-center rounded-lg transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
          active
            ? 'bg-primary text-primary-foreground shadow-glow'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        )}
      >
        <Icon className="h-5 w-5" aria-hidden />
      </button>
    </TooltipTrigger>
    <TooltipContent side="right">{label}</TooltipContent>
  </Tooltip>
);

/** Small round avatar (image + initials fallback) used in the shell user chip. */
const UserAvatar: React.FC<{ src?: string; name: string; className?: string }> = ({
  src,
  name,
  className,
}) => {
  const [broken, setBroken] = React.useState(false);
  if (src && !broken) {
    return (
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
        {/* Per-user theme (Wave 7): persisted to the user's prefs; 'system' follows the OS. */}
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
  const { hasPermission } = useAuth();
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

  // Refetch the demo status on every route change so the banner/badges stay fresh
  // even between the background poll ticks (cheap GET; inert when demo is off).
  React.useEffect(() => {
    void refreshDemo();
  }, [page, refreshDemo]);

  // Filter the nav by RBAC: an item with a `perm` is hidden unless the user has the
  // grant; a group with no visible items is dropped. With auth/RBAC off,
  // hasPermission() is always true so the full nav shows (back-compat).
  const navGroups = React.useMemo<NavGroup[]>(
    () =>
      NAV_GROUPS.map((g) => ({
        ...g,
        items: g.items.filter((it) => !it.perm || hasPermission(it.perm.resource, it.perm.action)),
      })).filter((g) => g.items.length > 0),
    [hasPermission],
  );

  // Product name for the breadcrumb prefix; falls back to a neutral default.
  const productName = branding.product_name?.trim() || branding.org_name?.trim() || 'ASP';
  const logoUrl = branding.logo_data_url?.trim() || '';
  const current = navItem(page);
  const pageLabel = current?.label ?? 'Overview';

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

  // Cmd/Ctrl-K opens the palette.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex min-h-screen bg-canvas text-foreground">
      {/* ---- Slim left icon rail ------------------------------------------- */}
      <aside
        className="sticky top-0 flex h-screen w-16 shrink-0 flex-col items-center border-r border-border bg-surface py-3"
        aria-label="Primary navigation"
      >
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
          {logoUrl ? (
            <img
              src={logoUrl}
              alt=""
              className="h-7 w-7 rounded object-contain"
            />
          ) : (
            <Shield className="h-5 w-5" aria-hidden />
          )}
        </div>
        <nav className="flex flex-1 flex-col items-center gap-1">
          {navGroups.map((group, gi) => (
            <React.Fragment key={group.id}>
              {gi > 0 && <Separator className="my-1.5 w-6" />}
              {group.items.map((item) => (
                <RailItem
                  key={item.id}
                  id={item.id}
                  label={item.label}
                  icon={item.icon}
                  active={page === item.id}
                  onSelect={() => onNavigate(item.id)}
                />
              ))}
            </React.Fragment>
          ))}
        </nav>
      </aside>

      {/* ---- Main column --------------------------------------------------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-surface/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-surface/80">
          {/* Breadcrumb: OUR product name / current page (plain text — untrusted). */}
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
            <span className="truncate font-semibold text-foreground">{productName}</span>
            <span className="text-muted-foreground" aria-hidden>
              /
            </span>
            <span className="truncate text-muted-foreground">{pageLabel}</span>
          </nav>

          <div className="ml-auto flex items-center gap-2">
            {/* Cmd-K hint / palette opener */}
            <Button
              variant="outline"
              size="sm"
              className="hidden h-8 gap-1.5 text-muted-foreground sm:inline-flex"
              onClick={() => setPaletteOpen(true)}
              aria-label="Open command palette"
            >
              <CommandIcon className="h-3.5 w-3.5" aria-hidden />
              <span className="text-xs">Search</span>
              <kbd className="ml-1 rounded border border-border bg-muted px-1 text-[10px] font-medium">
                ⌘K
              </kbd>
            </Button>

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
        </header>

        {/* Content slot — re-keyed so the fade-in replays on each route change. */}
        <main id="socMain" role="main" className="flex-1">
          <div key={page} className="mx-auto w-full max-w-[1400px] px-4 py-6 animate-fade-in sm:px-6">
            {/* Demo-mode banner — renders only when the demo tenant is active. */}
            <DemoBanner />
            <div className={cn(demoActive && 'mt-4')}>{children}</div>
          </div>
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onNavigate={onNavigate}
      />
    </div>
  );
};
