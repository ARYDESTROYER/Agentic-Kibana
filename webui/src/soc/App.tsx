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
import { PrefsProvider } from './prefs';
import { AuthProvider, useAuth, useUnauthorizedRedirect } from './auth';
import { DemoProvider } from './demo';
import { RouterProvider, useRoute, type Navigate } from './router';
import { AppShell } from './AppShell';
import { ErrorBoundary } from './ErrorBoundary';
import type { PageId } from './nav';

// Login + the first-run Wizard stay EAGER — they own first paint (the login gate
// and the OOBE flow), so we don't want a chunk fetch in front of them.
import Login from './pages/Login';
import Wizard from './pages/Wizard';
import { ReauthDialog } from './components/ReauthDialog';
import { PageSkeleton } from './components/PageSkeleton';

// Every other page is code-split: a route renders only when navigated to, so the
// entry bundle no longer ships all ~25 pages (foundation #6). Lazy loading is
// transparent — the <Suspense> below covers the brief chunk fetch, and the
// surrounding ErrorBoundary catches a failed chunk load instead of white-screening.
// All target pages are DEFAULT exports (verified), so the bare import() resolves
// directly to a `{ default }` module that React.lazy expects.
const Home = React.lazy(() => import('./pages/Home'));
const Cases = React.lazy(() => import('./pages/Cases'));
const Workspace = React.lazy(() => import('./pages/Workspace'));
const Investigate = React.lazy(() => import('./pages/Investigate'));
const Scans = React.lazy(() => import('./pages/Scans'));
const Standup = React.lazy(() => import('./pages/Standup'));
const Analytics = React.lazy(() => import('./pages/Analytics'));
const Cost = React.lazy(() => import('./pages/Cost'));
const Intelligence = React.lazy(() => import('./pages/Intelligence'));
const Knowledge = React.lazy(() => import('./pages/Knowledge'));
const Memory = React.lazy(() => import('./pages/Memory'));
const Sources = React.lazy(() => import('./pages/Sources'));
const Catalog = React.lazy(() => import('./pages/Catalog'));
const Settings = React.lazy(() => import('./pages/Settings'));
const Security = React.lazy(() => import('./pages/Security'));
const Approvals = React.lazy(() => import('./pages/Approvals'));
const Users = React.lazy(() => import('./pages/Users'));
const Audit = React.lazy(() => import('./pages/Audit'));
const Account = React.lazy(() => import('./pages/Account'));
const SessionsPage = React.lazy(() => import('./pages/Sessions'));
const AdminSessions = React.lazy(() => import('./pages/AdminSessions'));
// Round-3 surfaces: standalone admin/notification pages. Models + Roles are their
// own admin pages (promoted out of Settings); Inbox is the notification center.
const Models = React.lazy(() => import('./pages/Models'));
const Roles = React.lazy(() => import('./pages/Roles'));
const Inbox = React.lazy(() => import('./pages/Inbox'));
// Round-4 surfaces: unified logs, campaigns, auto-tuning, batch jobs, baseline stats.
const UnifiedLogs = React.lazy(() => import('./components/UnifiedLogsSheet'));
const Campaigns = React.lazy(() => import('./pages/Campaigns'));
const Tuning = React.lazy(() => import('./pages/Tuning'));
const BatchJobs = React.lazy(() => import('./pages/BatchJobs'));
const BaselineStats = React.lazy(() => import('./pages/Baseline'));

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

    // ---- Round-3 nav-child leaf ids that deep-link into a host page's tab. The
    //      expandable sidebar navigates directly to these leaf ids, so they must
    //      resolve to the owning host with the right sub-tab pre-selected. ---- //
    case 'dashboard':
      // The dashboard IS the Overview/Home posture view (no standalone page).
      return <Home onNavigate={navigate} tab="dashboard" />;
    case 'playbooks':
      // "Playbooks & Agents" is the Catalog tab of the Intelligence host.
      return <Intelligence onNavigate={navigate} tab="catalog" />;

    // ---- Round-3 standalone admin / notification surfaces ---- //
    case 'models':
      // Models & LLMs admin (catalog / cost & budget / providers). Self-gated by
      // <ProtectedRoute resource="models" action="read"> inside the page.
      return <Models />;
    case 'roles':
      // RBAC roles editor. Self-gated by <ProtectedRoute resource="roles" action="manage">.
      return <Roles />;
    case 'inbox':
      // In-app notification center (the top-bar bell links here).
      return <Inbox onNavigate={navigate} />;

    case 'cases':
      return <Cases onNavigate={navigate} initialStatus={opts?.status} />;
    case 'scans':
      return <Scans onNavigate={navigate} />;
    case 'approvals':
      return <Approvals onNavigate={navigate} />;
    case 'sources':
      return <Sources onNavigate={navigate} />;

    // ---- Round-4 surfaces ---- //
    case 'logs':
      return <UnifiedLogs />;
    case 'campaigns':
      return <Campaigns onNavigate={navigate} />;
    case 'tuning':
      return <Tuning onNavigate={navigate} />;
    case 'batchjobs':
      return <BatchJobs />;
    case 'baseline':
      return <BaselineStats />;

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
    case 'audit':
      return <Audit onNavigate={navigate} />;
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
          {/* Single Suspense boundary covers every lazily-loaded page chunk; the
              fallback mirrors the page chrome so navigation never white-screens.
              Keyed by `page` so each route shows its own fresh fallback. */}
          <React.Suspense key={page} fallback={<PageSkeleton />}>
            {renderPage(page, opts, navigate, () => setForceWizard(true))}
          </React.Suspense>
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
        <PrefsProvider>
          <DemoProvider>
            <RouterProvider>
              <Boot />
            </RouterProvider>
          </DemoProvider>
        </PrefsProvider>
      </AuthProvider>
    </TooltipProvider>
  </ThemeProvider>
);

export default App;
