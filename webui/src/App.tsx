/**
 * App root.
 *
 * - On boot, checks GET /api/setup/status; if `setup_complete` is false the
 *   first-run Wizard takes over the whole viewport.
 * - Otherwise renders the Shell + the selected page.
 * - The Wizard is also re-runnable on demand from Settings.
 * - Dark mode swaps the EUI theme stylesheet at runtime.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { EuiProvider, EuiEmptyPrompt, EuiLoadingSpinner } from '@elastic/eui';
import { api } from './lib/api';
import { applyEuiTheme } from './lib/euiTheme';
import { Shell, PageId } from './components/Shell/Shell';
import { Wizard } from './components/Wizard/Wizard';
import { OverviewPage } from './components/Overview/OverviewPage';
import { CasesPage } from './components/Cases/CasesPage';
import { ChatPage } from './components/Chat/ChatPage';
import { InvestigatePage } from './components/Investigate/InvestigatePage';
import { ScansPage } from './components/Scans/ScansPage';
import { StandupPage } from './components/Standup/StandupPage';
import { CostPage } from './components/Cost/CostPage';
import { SourcesPage } from './components/Sources/SourcesPage';
import { SettingsPage } from './components/Settings/SettingsPage';

type Boot = 'loading' | 'wizard' | 'app';

export const App: React.FC = () => {
  const [boot, setBoot] = useState<Boot>('loading');
  const [page, setPage] = useState<PageId>('overview');
  const [forceWizard, setForceWizard] = useState(false);
  const [darkMode, setDarkMode] = useState<boolean>(
    () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false,
  );

  // Apply EUI theme stylesheet whenever dark mode changes.
  useEffect(() => {
    applyEuiTheme(darkMode);
  }, [darkMode]);

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

  useEffect(() => {
    void checkSetup();
  }, [checkSetup]);

  const colorMode = darkMode ? 'DARK' : 'LIGHT';

  if (boot === 'loading') {
    return (
      <EuiProvider colorMode={colorMode}>
        <EuiEmptyPrompt icon={<EuiLoadingSpinner size="xl" />} title={<h2>Starting console…</h2>} />
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
    case 'cost':
      body = <CostPage />;
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

  return (
    <EuiProvider colorMode={colorMode}>
      <Shell page={page} onNavigate={setPage} darkMode={darkMode} onToggleDark={setDarkMode}>
        {body}
      </Shell>
    </EuiProvider>
  );
};
