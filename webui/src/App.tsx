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
import React, { Suspense, useCallback, useEffect, useState } from 'react';
import { EuiProvider, EuiEmptyPrompt, EuiLoadingSpinner } from '@elastic/eui';
import { api, setUnauthorizedHandler } from './lib/api';
import type { AuthMe } from './lib/types';
import { applyEuiTheme } from './lib/euiTheme';
import { BrandingProvider, useBranding } from './lib/branding';
import { Shell, PageId } from './components/Shell/Shell';

const Wizard = React.lazy(() => import('./components/Wizard/Wizard').then(m => ({ default: m.Wizard })));
const LoginScreen = React.lazy(() => import('./components/Auth/LoginScreen').then(m => ({ default: m.LoginScreen })));

const OverviewPage = React.lazy(() => import('./components/Overview/OverviewPage').then(m => ({ default: m.OverviewPage })));
const CasesPage = React.lazy(() => import('./components/Cases/CasesPage').then(m => ({ default: m.CasesPage })));
const ChatPage = React.lazy(() => import('./components/Chat/ChatPage').then(m => ({ default: m.ChatPage })));
const InvestigatePage = React.lazy(() => import('./components/Investigate/InvestigatePage').then(m => ({ default: m.InvestigatePage })));
const ScansPage = React.lazy(() => import('./components/Scans/ScansPage').then(m => ({ default: m.ScansPage })));
const StandupPage = React.lazy(() => import('./components/Standup/StandupPage').then(m => ({ default: m.StandupPage })));
const CatalogPage = React.lazy(() => import('./components/Catalog/CatalogPage').then(m => ({ default: m.CatalogPage })));
const KnowledgePage = React.lazy(() => import('./components/Knowledge/KnowledgePage').then(m => ({ default: m.KnowledgePage })));
const MemoryPage = React.lazy(() => import('./components/Memory/MemoryPage').then(m => ({ default: m.MemoryPage })));
const CostPage = React.lazy(() => import('./components/Cost/CostPage').then(m => ({ default: m.CostPage })));
const MetricsPage = React.lazy(() => import('./components/Metrics/MetricsPage').then(m => ({ default: m.MetricsPage })));
const SourcesPage = React.lazy(() => import('./components/Sources/SourcesPage').then(m => ({ default: m.SourcesPage })));
const SettingsPage = React.lazy(() => import('./components/Settings/SettingsPage').then(m => ({ default: m.SettingsPage })));

type Boot = 'loading' | 'login' | 'wizard' | 'app';

/** Root: provides branding/theme context to the whole tree. */
export const App: React.FC = () => (
  <BrandingProvider>
    <AppShell />
  </BrandingProvider>
);

const AppShell: React.FC = () => {
  const [boot, setBoot] = useState<Boot>('loading');
  const [auth, setAuth] = useState<AuthMe | null>(null);
  const [page, setPage] = useState<PageId>('overview');
  const [forceWizard, setForceWizard] = useState(false);
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
        <Suspense fallback={<div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}><EuiLoadingSpinner size="xl" /></div>}>
          <LoginScreen onAuthenticated={onAuthenticated} />
        </Suspense>
      </EuiProvider>
    );
  }

  if (boot === 'wizard' || forceWizard) {
    return (
      <EuiProvider colorMode={colorMode}>
        <Suspense fallback={<div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}><EuiLoadingSpinner size="xl" /></div>}>
          <Wizard
            onComplete={() => {
              setForceWizard(false);
              setBoot('app');
              setPage('overview');
            }}
            onExit={forceWizard ? () => setForceWizard(false) : undefined}
          />
        </Suspense>
      </EuiProvider>
    );
  }

  const PageFallback = () => (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '50vh' }}>
      <EuiLoadingSpinner size="xl" />
    </div>
  );

  let body: React.ReactNode;
  switch (page) {
    case 'overview':
      body = <OverviewPage onNavigate={setPage} />;
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
      body = <MetricsPage />;
      break;
    case 'sources':
      body = <SourcesPage />;
      break;
    case 'settings':
      body = <SettingsPage onRerunWizard={() => setForceWizard(true)} />;
      break;
    case 'cases':
    default:
      body = <CasesPage />;
  }

  const showUser = Boolean(auth?.enabled && auth?.authenticated && auth?.user);

  return (
    <EuiProvider colorMode={colorMode}>
      <Shell
        page={page}
        onNavigate={setPage}
        darkMode={darkMode}
        onToggleDark={setDarkMode}
        username={showUser ? auth?.user?.username : undefined}
        onLogout={showUser ? onLogout : undefined}
      >
        <Suspense fallback={<PageFallback />}>
          {body}
        </Suspense>
      </Shell>
    </EuiProvider>
  );
};
