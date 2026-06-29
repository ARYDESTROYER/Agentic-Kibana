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
  XCircle,
  LogOut,
  User,
  Command as CommandIcon,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/ui/button';
import { Badge } from '@/ui/badge';
import { Separator } from '@/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/ui/dialog';
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/ui/command';
import { cn } from '@/lib/cn';
import { api } from '@/lib/api';
import type { HealthResponse } from '@/lib/types';
import { useTheme } from './theme';
import { useAuth } from './auth';
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

type HealthTone = 'success' | 'warning' | 'critical';

interface HealthView {
  tone: HealthTone;
  label: string;
  icon: typeof CheckCircle2;
  detail: string;
}

function healthView(health: HealthResponse | null, err: boolean): HealthView {
  if (err) {
    return {
      tone: 'critical',
      label: 'Backend unreachable',
      icon: XCircle,
      detail: 'Cannot reach the backend API',
    };
  }
  if (health?.es_connected) {
    return {
      tone: 'success',
      label: 'Healthy',
      icon: CheckCircle2,
      detail: `Store: ${health?.store_type ?? 'unknown'}`,
    };
  }
  return {
    tone: 'warning',
    label: 'Store degraded',
    icon: AlertTriangle,
    detail: `Store: ${health?.store_type ?? 'unknown'}`,
  };
}

const TONE_PILL: Record<HealthTone, string> = {
  success: 'border-success/40 text-success',
  warning: 'border-warning/40 text-warning',
  critical: 'border-critical/40 text-critical',
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

/** The Cmd/Ctrl-K command palette: flat nav list, grouped. */
const CommandPalette: React.FC<{
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onNavigate: Navigate;
  groups: NavGroup[];
}> = ({ open, onOpenChange, onNavigate, groups }) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="overflow-hidden p-0 sm:max-w-lg">
      <DialogTitle className="sr-only">Command palette</DialogTitle>
      <DialogDescription className="sr-only">Jump to a page in the console.</DialogDescription>
      <Command>
        <CommandInput placeholder="Jump to a page…" />
        <CommandList>
          <CommandEmpty>No matching pages.</CommandEmpty>
          {groups.map((group) => (
            <CommandGroup key={group.id} heading={group.label}>
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <CommandItem
                    key={item.id}
                    value={`${item.label} ${item.id}`}
                    onSelect={() => {
                      onNavigate(item.id);
                      onOpenChange(false);
                    }}
                  >
                    <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
                    <span>{item.label}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
    </DialogContent>
  </Dialog>
);

export const AppShell: React.FC<AppShellProps> = ({
  page,
  onNavigate,
  username,
  onLogout,
  children,
}) => {
  const { isDark, toggle, branding } = useTheme();
  const { hasPermission } = useAuth();
  const { health, err } = useHealth();
  const [paletteOpen, setPaletteOpen] = React.useState(false);

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

  const hv = healthView(health, err);
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
                  onClick={toggle}
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

            {/* Health pill */}
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-xs font-medium',
                    TONE_PILL[hv.tone],
                  )}
                  aria-live="polite"
                >
                  <HealthIcon className="h-3.5 w-3.5" aria-hidden />
                  <span className="hidden sm:inline">{hv.label}</span>
                </span>
              </TooltipTrigger>
              <TooltipContent>{hv.detail}</TooltipContent>
            </Tooltip>

            {/* User + logout (only when auth enabled + authenticated) */}
            {username ? (
              <>
                <Separator orientation="vertical" className="hidden h-6 sm:block" />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs">
                      <User className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                      <span className="hidden max-w-[120px] truncate sm:inline">{username}</span>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>Signed in as {username}</TooltipContent>
                </Tooltip>
                {onLogout ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={onLogout}
                        aria-label="Log out"
                      >
                        <LogOut className="h-4 w-4" aria-hidden />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Log out</TooltipContent>
                  </Tooltip>
                ) : null}
              </>
            ) : null}
          </div>
        </header>

        {/* Content slot — re-keyed so the fade-in replays on each route change. */}
        <main id="socMain" role="main" className="flex-1">
          <div key={page} className="mx-auto w-full max-w-[1400px] px-4 py-6 animate-fade-in sm:px-6">
            {children}
          </div>
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onNavigate={onNavigate}
        groups={navGroups}
      />
    </div>
  );
};
