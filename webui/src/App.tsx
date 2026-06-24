/**
 * App root.
 *
 * - On boot, checks GET /api/auth/me. If auth is disabled (`enabled === false`)
 *   the app behaves EXACTLY as before (no login, no logout control) — the gate is
 *   a strict no-op. If auth is enabled and the session is not authenticated, a
 *   Login screen gates the whole app; on success we re-enter.
 * - Then checks GET /api/setup/status; if `setup_complete` is false the first-run
 *   Wizard takes over the whole viewport.
 * - Otherwise renders the Shell + the selected page.
 * - The Wizard is also re-runnable on demand from Settings.
 * - Dark mode swaps the EUI theme stylesheet at runtime.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { EuiProvider, EuiEmptyPrompt, EuiLoadingSpinner } from '@elastic/eui';
import { api, setUnauthorizedHandler } from './lib/api';
import type { AuthMe } from './lib/types';
import { applyEuiTheme } from './lib/euiTheme';
import { BrandingProvider, useBranding } from './lib/branding';
import type { NavOpts } from './lib/types';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { Shell, PageId, Navigate } from './components/Shell/Shell';
import { Wizard } from './components/Wizard/Wizard';
import { LoginScreen } from './components/Auth/LoginScreen';
import { OverviewPage } from './components/Overview/OverviewPage';
import { CasesPage } from './components/Cases/CasesPage';
import { ChatPage } from './components/Chat/ChatPage';
import { InvestigatePage } from './components/Investigate/InvestigatePage';
import { ScansPage } from './components/Scans/ScansPage';
import { StandupPage } from './components/Standup/StandupPage';
import { CatalogPage } from './components/Catalog/CatalogPage';
import { ProposalsPanel } from './components/Proposals/ProposalsPanel';
import { KnowledgePage } from './components/Knowledge/KnowledgePage';
import { MemoryPage } from './components/Memory/MemoryPage';
import { CostPage } from './components/Cost/CostPage';
import { MetricsPage } from './components/Metrics/MetricsPage';
import { SourcesPage } from './components/Sources/SourcesPage';
import { SettingsPage } from './components/Settings/SettingsPage';

type Boot = 'loading' | 'login' | 'wizard' | 'app';

/** The valid page ids (mirrors the Shell `PageId` union) for hash validation. */
const PAGE_IDS: PageId[] = [
  'overview',
  'cases',
  'investigate',
  'chat',
  'scans',
  'standup',
  'catalog',
  'proposals',
  'knowledge',
  'memory',
  'sources',
  'cost',
  'metrics',
  'settings',
];

/** Parse `#/<pageid>` from the current location hash; unknown → 'overview'. */
function pageFromHash(): PageId {
  try {
    const raw = (window.location.hash || '').replace(/^#\/?/, '').split(/[?&/]/)[0];
    return (PAGE_IDS as string[]).includes(raw) ? (raw as PageId) : 'overview';
  } catch {
    return 'overview';
  }
}

/** Root: provides branding/theme context to the whole tree. */
export const App: React.FC = () => (
  <BrandingProvider>
    <AppShell />
  </BrandingProvider>
);

const AppShell: React.FC = () => {
  const [boot, setBoot] = useState<Boot>('loading');
  const [auth, setAuth] = useState<AuthMe | null>(null);
  const [page, setPage] = useState<PageId>(() => pageFromHash());
  const [navOpts, setNavOpts] = useState<NavOpts | undefined>();
  const [forceWizard, setForceWizard] = useState(false);

  // Hash routing (st01): one navigate() seeds page + opts and writes the hash;
  // a hashchange listener keeps back/forward + direct deep-links in sync.
  const navigate = useCallback<Navigate>((p, opts) => {
    setPage(p);
    setNavOpts(opts);
    const target = '#/' + p;
    if (window.location.hash !== target) window.location.hash = target;
  }, []);

  useEffect(() => {
    const onHashChange = () => {
      const next = pageFromHash();
      setPage((prev) => (prev === next ? prev : next));
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  // Dark mode + theme is owned by the branding context (persisted user override,
  // branding theme, or — when neither is set — the OS preference, exactly as
  // before). The local toggle simply forwards to it.
  const { darkMode, setDarkMode } = useBranding();

  // Apply EUI theme stylesheet whenever dark mode changes.
  useEffect(() => {
    applyEuiTheme(darkMode);
  }, [darkMode]);

  // Resolve setup state → wizard or app shell (used once authenticated, or when
  // auth is disabled).
  const checkSetup = useCallback(async () => {
    try {
      const st = await api.setupStatus();
      setBoot(st.setup_complete ? 'app' : 'wizard');
    } catch {
      // If the backend is unreachable, default to the app shell so the health
      // indicator can surface the problem rather than trapping the user in setup.
      setBoot('app');
    }
  }, []);

  // Boot: first establish the auth posture, then resolve setup if allowed in.
  const boot0 = useCallback(async () => {
    let me: AuthMe | null = null;
    try {
      me = await api.auth.me();
    } catch {
      // Treat an unreachable/legacy backend (no /api/auth/me) as "auth disabled"
      // so the no-auth experience is preserved exactly.
      me = null;
    }
    setAuth(me);
    if (me?.enabled && !me.authenticated) {
      setBoot('login');
      return;
    }
    await checkSetup();
  }, [checkSetup]);

  useEffect(() => {
    void boot0();
  }, [boot0]);

  // When auth is enabled, register a 401 handler so any lapsed-session API call
  // bounces back to login. When auth is disabled, no handler is registered (inert).
  useEffect(() => {
    if (auth?.enabled) {
      setUnauthorizedHandler(() => {
        setAuth((prev) => (prev ? { ...prev, authenticated: false, user: null } : prev));
        setBoot('login');
      });
      return () => setUnauthorizedHandler(null);
    }
    setUnauthorizedHandler(null);
    return undefined;
  }, [auth?.enabled]);

  const onAuthenticated = useCallback(async () => {
    setBoot('loading');
    try {
      const me = await api.auth.me();
      setAuth(me);
    } catch {
      /* fall through to setup */
    }
    await checkSetup();
  }, [checkSetup]);

  const onLogout = useCallback(async () => {
    try {
      await api.auth.logout();
    } catch {
      /* ignore — we drop to login regardless */
    }
    setAuth((prev) => (prev ? { ...prev, authenticated: false, user: null } : prev));
    setPage('overview');
    setBoot('login');
  }, []);

  const colorMode = darkMode ? 'DARK' : 'LIGHT';

  if (boot === 'loading') {
    return (
      <EuiProvider colorMode={colorMode}>
        <EuiEmptyPrompt icon={<EuiLoadingSpinner size="xl" />} title={<h2>Starting console…</h2>} />
      </EuiProvider>
    );
  }

  if (boot === 'login') {
    return (
      <EuiProvider colorMode={colorMode}>
        <LoginScreen onAuthenticated={onAuthenticated} />
      </EuiProvider>
    );
  }

  if (boot === 'wizard' || forceWizard) {
    return (
      <EuiProvider colorMode={colorMode}>
        <Wizard
          onComplete={() => {
            setForceWizard(false);
            setBoot('app');
            setPage('overview');
          }}
          onExit={forceWizard ? () => setForceWizard(false) : undefined}
        />
      </EuiProvider>
    );
  }

  let body: React.ReactNode;
  switch (page) {
    case 'overview':
      body = <OverviewPage onNavigate={navigate} />;
      break;
    case 'chat':
      body = <ChatPage />;
      break;
    case 'investigate':
      body = <InvestigatePage />;
      break;
    case 'scans':
      body = <ScansPage />;
      break;
    case 'standup':
      body = <StandupPage />;
      break;
    case 'catalog':
      body = <CatalogPage />;
      break;
    case 'proposals':
      // The source-case chips deep-link back to the Cases surface.
      body = <ProposalsPanel onOpenCase={() => setPage('cases')} />;
      break;
    case 'knowledge':
      body = <KnowledgePage />;
      break;
    case 'memory':
      body = <MemoryPage />;
      break;
    case 'cost':
      body = <CostPage />;
      break;
    case 'metrics':
      body = <MetricsPage onNavigate={navigate} />;
      break;
    case 'sources':
      body = <SourcesPage />;
      break;
    case 'settings':
      body = <SettingsPage onRerunWizard={() => setForceWizard(true)} />;
      break;
    case 'cases':
    default:
      body = <CasesPage initialStatus={navOpts?.status} />;
  }

  // The username + logout control only appear when auth is enabled AND
  // authenticated — otherwise the shell is byte-for-byte the original.
  const showUser = Boolean(auth?.enabled && auth?.authenticated && auth?.user);

  return (
    <EuiProvider colorMode={colorMode}>
      <ErrorBoundary resetKey={page}>
        <Shell
          page={page}
          onNavigate={navigate}
          darkMode={darkMode}
          onToggleDark={setDarkMode}
          username={showUser ? auth?.user?.username : undefined}
          onLogout={showUser ? onLogout : undefined}
        >
          {body}
        </Shell>
      </ErrorBoundary>
    </EuiProvider>
  );
};
