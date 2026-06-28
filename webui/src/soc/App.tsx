/**
 * Root of the rebuilt (Tailwind + shadcn) SOC console.
 *
 * Boot mirrors the legacy flow: GET /api/auth/me (auth disabled => no-op gate),
 * then GET /api/setup/status (first-run => Wizard), else the app shell. Dark/light
 * is owned by ThemeProvider; routing by the hash RouterProvider.
 */
import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { api, setUnauthorizedHandler } from '@/lib/api';
import type { AuthMe, NavOpts } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';
import { ThemeProvider } from './theme';
import { RouterProvider, useRoute, type Navigate } from './router';
import { AppShell } from './AppShell';
import { ErrorBoundary } from './ErrorBoundary';
import type { PageId } from './nav';

import Overview from './pages/Overview';
import Cases from './pages/Cases';
import Chat from './pages/Chat';
import Investigate from './pages/Investigate';
import Scans from './pages/Scans';
import Standup from './pages/Standup';
import Metrics from './pages/Metrics';
import Cost from './pages/Cost';
import Knowledge from './pages/Knowledge';
import Memory from './pages/Memory';
import Sources from './pages/Sources';
import Catalog from './pages/Catalog';
import Settings from './pages/Settings';
import Approvals from './pages/Approvals';
import Login from './pages/Login';
import Wizard from './pages/Wizard';

type Boot = 'loading' | 'login' | 'wizard' | 'app';

const CenterSpinner: React.FC<{ label: string }> = ({ label }) => (
  <div className="flex h-screen items-center justify-center gap-3 bg-canvas text-muted-foreground">
    <Loader2 className="h-5 w-5 animate-spin" />
    <span className="text-sm">{label}</span>
  </div>
);

function renderPage(
  page: PageId,
  opts: NavOpts | undefined,
  navigate: Navigate,
  onRerunWizard: () => void,
): React.ReactNode {
  switch (page) {
    case 'overview':
      return <Overview onNavigate={navigate} />;
    case 'cases':
      return <Cases onNavigate={navigate} initialStatus={opts?.status} />;
    case 'investigate':
      return <Investigate onNavigate={navigate} />;
    case 'chat':
      return <Chat onNavigate={navigate} />;
    case 'metrics':
      return <Metrics onNavigate={navigate} />;
    case 'scans':
      return <Scans onNavigate={navigate} />;
    case 'standup':
      return <Standup onNavigate={navigate} />;
    case 'catalog':
      return <Catalog onNavigate={navigate} />;
    case 'approvals':
      return <Approvals onNavigate={navigate} />;
    case 'knowledge':
      return <Knowledge onNavigate={navigate} />;
    case 'memory':
      return <Memory onNavigate={navigate} />;
    case 'sources':
      return <Sources onNavigate={navigate} />;
    case 'cost':
      return <Cost onNavigate={navigate} />;
    case 'settings':
      return <Settings onNavigate={navigate} onRerunWizard={onRerunWizard} />;
    default:
      return <Overview onNavigate={navigate} />;
  }
}

const Boot: React.FC = () => {
  const [boot, setBoot] = React.useState<Boot>('loading');
  const [auth, setAuth] = React.useState<AuthMe | null>(null);
  const [forceWizard, setForceWizard] = React.useState(false);
  const { page, opts, navigate } = useRoute();

  const checkSetup = React.useCallback(async () => {
    try {
      const st = await api.setupStatus();
      setBoot(st.setup_complete ? 'app' : 'wizard');
    } catch {
      setBoot('app');
    }
  }, []);

  const boot0 = React.useCallback(async () => {
    let me: AuthMe | null = null;
    try {
      me = await api.auth.me();
    } catch {
      me = null;
    }
    setAuth(me);
    if (me?.enabled && !me.authenticated) {
      setBoot('login');
      return;
    }
    await checkSetup();
  }, [checkSetup]);

  React.useEffect(() => {
    void boot0();
  }, [boot0]);

  React.useEffect(() => {
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

  const onAuthenticated = React.useCallback(async () => {
    setBoot('loading');
    try {
      setAuth(await api.auth.me());
    } catch {
      /* fall through to setup */
    }
    await checkSetup();
  }, [checkSetup]);

  const onLogout = React.useCallback(async () => {
    try {
      await api.auth.logout();
    } catch {
      /* drop to login regardless */
    }
    setAuth((prev) => (prev ? { ...prev, authenticated: false, user: null } : prev));
    navigate('overview');
    setBoot('login');
  }, [navigate]);

  if (boot === 'loading') return <CenterSpinner label="Starting console…" />;
  if (boot === 'login') return <Login onAuthenticated={onAuthenticated} />;
  if (boot === 'wizard' || forceWizard) {
    return (
      <Wizard
        onComplete={() => {
          setForceWizard(false);
          setBoot('app');
          navigate('overview');
        }}
        onExit={forceWizard ? () => setForceWizard(false) : undefined}
      />
    );
  }

  const showUser = Boolean(auth?.enabled && auth?.authenticated && auth?.user);
  return (
    <AppShell
      page={page}
      onNavigate={navigate}
      username={showUser ? auth?.user?.username : undefined}
      onLogout={showUser ? onLogout : undefined}
    >
      <ErrorBoundary resetKey={page}>
        {renderPage(page, opts, navigate, () => setForceWizard(true))}
      </ErrorBoundary>
    </AppShell>
  );
};

export const App: React.FC = () => (
  <ThemeProvider>
    <TooltipProvider delayDuration={200}>
      <RouterProvider>
        <Boot />
      </RouterProvider>
    </TooltipProvider>
  </ThemeProvider>
);

export default App;
