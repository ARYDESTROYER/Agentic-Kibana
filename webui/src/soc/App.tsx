/**
 * Root of the rebuilt (Tailwind + shadcn) SOC console.
 *
 * Boot mirrors the legacy flow: GET /api/auth/me (auth disabled => no-op gate),
 * then GET /api/setup/status (first-run => Wizard), else the app shell. Dark/light
 * is owned by ThemeProvider; routing by the hash RouterProvider.
 */
import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import type { NavOpts } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';
import { ThemeProvider } from './theme';
import { AuthProvider, useAuth, useUnauthorizedRedirect } from './auth';
import { DemoProvider } from './demo';
import { RouterProvider, useRoute, type Navigate } from './router';
import { AppShell } from './AppShell';
import { ErrorBoundary } from './ErrorBoundary';
import type { PageId } from './nav';

import Home from './pages/Home';
import Cases from './pages/Cases';
import Workspace from './pages/Workspace';
import Investigate from './pages/Investigate';
import Scans from './pages/Scans';
import Standup from './pages/Standup';
import Analytics from './pages/Analytics';
import Cost from './pages/Cost';
import Intelligence from './pages/Intelligence';
import Knowledge from './pages/Knowledge';
import Memory from './pages/Memory';
import Sources from './pages/Sources';
import Catalog from './pages/Catalog';
import Settings from './pages/Settings';
import Security from './pages/Security';
import Approvals from './pages/Approvals';
import Users from './pages/Users';
import Account from './pages/Account';
import SessionsPage from './pages/Sessions';
import AdminSessions from './pages/AdminSessions';
import Login from './pages/Login';
import Wizard from './pages/Wizard';
import { ReauthDialog } from './components/ReauthDialog';

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
    // ---- Round-2 W4 consolidated HOST pages (render a tabbed scaffold) ---- //
    case 'overview':
      // Home = Dashboard (Overview) | Standup.
      return <Home onNavigate={navigate} tab={opts?.tab} />;
    case 'chat':
      // Workspace = Chat | Investigate (ONE chat engine).
      return <Workspace onNavigate={navigate} tab={opts?.tab} />;
    case 'metrics':
      // Analytics = Dashboard (Metrics) | Cost & usage.
      return <Analytics onNavigate={navigate} tab={opts?.tab} />;
    case 'intelligence':
      // Intelligence = Knowledge | Memory | Playbooks & Agents.
      return <Intelligence onNavigate={navigate} tab={opts?.tab} />;

    case 'cases':
      return <Cases onNavigate={navigate} initialStatus={opts?.status} />;
    case 'scans':
      return <Scans onNavigate={navigate} />;
    case 'approvals':
      return <Approvals onNavigate={navigate} />;
    case 'sources':
      return <Sources onNavigate={navigate} />;

    // ---- Hidden-but-routable consolidated sub-pages (deep-link fallbacks; the
    //      host pages above are the primary entry, but bare `#/cost` etc. still
    //      resolve to the standalone page rather than falling through to Home). -- //
    case 'investigate':
      return <Investigate onNavigate={navigate} />;
    case 'standup':
      return <Standup onNavigate={navigate} />;
    case 'cost':
      return <Cost onNavigate={navigate} />;
    case 'knowledge':
      return <Knowledge onNavigate={navigate} />;
    case 'memory':
      return <Memory onNavigate={navigate} />;
    case 'catalog':
      return <Catalog onNavigate={navigate} />;
    case 'account':
      return <Account onNavigate={navigate} />;
    case 'sessions':
      return <SessionsPage onNavigate={navigate} />;
    case 'admin_sessions':
      return <AdminSessions onNavigate={navigate} />;
    case 'settings':
      return <Settings onNavigate={navigate} onRerunWizard={onRerunWizard} />;
    case 'security':
      return <Security onNavigate={navigate} />;
    case 'users':
      return <Users onNavigate={navigate} />;
    default:
      return <Home onNavigate={navigate} tab={opts?.tab} />;
  }
}

const Boot: React.FC = () => {
  const { authEnabled, isAuthenticated, username, loading: authLoading, refresh, logout } =
    useAuth();
  const [setupChecked, setSetupChecked] = React.useState(false);
  const [setupComplete, setSetupComplete] = React.useState(true);
  const [forceWizard, setForceWizard] = React.useState(false);
  const { page, opts, navigate } = useRoute();

  // Whether the gate currently shows the login screen (auth on + no session).
  const showLogin = authEnabled && !isAuthenticated;

  const checkSetup = React.useCallback(async () => {
    try {
      const st = await api.setupStatus();
      setSetupComplete(st.setup_complete);
    } catch {
      setSetupComplete(true);
    } finally {
      setSetupChecked(true);
    }
  }, []);

  // Once we have a session (or auth is off), check whether the wizard is needed.
  React.useEffect(() => {
    if (authLoading || showLogin) return;
    void checkSetup();
  }, [authLoading, showLogin, checkSetup]);

  // A 401 on any non-auth call bounces back to the login screen (auth on only).
  useUnauthorizedRedirect(
    React.useCallback(() => {
      void refresh();
    }, [refresh]),
    authEnabled,
  );

  const onAuthenticated = React.useCallback(async () => {
    setSetupChecked(false);
    await refresh();
    await checkSetup();
  }, [refresh, checkSetup]);

  const onLogout = React.useCallback(async () => {
    await logout();
    navigate('overview');
  }, [logout, navigate]);

  if (authLoading) return <CenterSpinner label="Starting console…" />;
  if (showLogin) return <Login onAuthenticated={onAuthenticated} />;
  if (!setupChecked) return <CenterSpinner label="Starting console…" />;

  if (!setupComplete || forceWizard) {
    return (
      <Wizard
        onComplete={() => {
          setForceWizard(false);
          setSetupComplete(true);
          navigate('overview');
        }}
        onExit={forceWizard ? () => setForceWizard(false) : undefined}
      />
    );
  }

  const showUser = Boolean(authEnabled && isAuthenticated && username);
  return (
    <>
      <AppShell
        page={page}
        onNavigate={navigate}
        username={showUser ? username : undefined}
        onLogout={showUser ? onLogout : undefined}
      >
        <ErrorBoundary resetKey={page}>
          {renderPage(page, opts, navigate, () => setForceWizard(true))}
        </ErrorBoundary>
      </AppShell>
      {/* Step-up re-auth modal: only armed when auth is enabled (back-compat). */}
      <ReauthDialog active={authEnabled} />
    </>
  );
};

export const App: React.FC = () => (
  <ThemeProvider>
    <TooltipProvider delayDuration={200}>
      <AuthProvider>
        <DemoProvider>
          <RouterProvider>
            <Boot />
          </RouterProvider>
        </DemoProvider>
      </AuthProvider>
    </TooltipProvider>
  </ThemeProvider>
);

export default App;
