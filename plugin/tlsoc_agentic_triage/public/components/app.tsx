import React, { useEffect, useMemo, useRef, useState } from 'react';
import { I18nProvider } from '@kbn/i18n-react';
import {
  EuiCallOut,
  EuiIcon,
  EuiLoadingSpinner,
  EuiNotificationBadge,
  EuiPageTemplate,
  EuiSpacer,
  EuiTab,
  EuiTabs,
} from '@elastic/eui';
import type { CoreStart } from '@kbn/core/public';
import type { NavigationPublicPluginStart } from '@kbn/navigation-plugin/public';
import type { DataPublicPluginStart } from '@kbn/data-plugin/public';
import type { DataViewsPublicPluginStart } from '@kbn/data-views-plugin/public';
import type { SharePluginStart } from '@kbn/share-plugin/public';

import { PLUGIN_NAME, SetupStatus } from '../../common';
import { TlsocApi } from '../lib/api';
import { makeOpenInDiscover } from '../lib/discover';

import { Chat } from './chat';
import { Investigate } from './investigate';
import { Board } from './board';
import { Scans } from './scans';
import { Standup } from './standup';
import { Cost } from './cost';
import { Settings } from './settings';
import { Wizard } from './wizard';

interface AppDeps {
  basename: string;
  core: CoreStart;
  navigation: NavigationPublicPluginStart;
  data: DataPublicPluginStart;
  dataViews: DataViewsPublicPluginStart;
  share: SharePluginStart;
}

const SCAN_POLL_MS = 30000;

export const TlsocAgenticTriageApp = ({ core, dataViews, share }: AppDeps) => {
  const api = useMemo(() => new TlsocApi(core.http), [core.http]);
  const patternRef = useRef<string>('all-logs-*');

  const openInDiscover = useMemo(
    () => makeOpenInDiscover(share, dataViews, () => patternRef.current),
    [share, dataViews]
  );

  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [selectedTab, setSelectedTab] = useState('chat');
  const [newScanCount, setNewScanCount] = useState(0);
  // App-level case selection so the open case (and its rehydrated detail view)
  // survives switching tabs and coming back. The detail view re-fetches the case
  // by id from the backend, so the analysis is never held in transient state.
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);

  const loadStatus = async () => {
    setLoadingStatus(true);
    setStatusError(null);
    try {
      const s = await api.get<SetupStatus>('setup/status');
      setStatus(s);
      if (s.data_view_pattern) {
        patternRef.current = s.data_view_pattern;
      }
    } catch (e) {
      setStatusError((e as Error).message);
      setStatus(null);
    } finally {
      setLoadingStatus(false);
    }
  };

  useEffect(() => {
    loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll scan notifications for the badge once setup is complete.
  useEffect(() => {
    if (!status?.setup_complete) {
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const resp = await api.get<{ new_count: number }>('scans/notifications', {
          since: 'now-24h',
        });
        if (!cancelled) {
          setNewScanCount(resp.new_count || 0);
        }
      } catch {
        /* ignore polling errors */
      }
    };
    tick();
    const id = window.setInterval(tick, SCAN_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [status?.setup_complete, api]);

  // Each tab carries a well-known EUI icon (shown via EuiTab `prepend`) so the
  // nav reads at a glance. The Automated Scans tab also `append`s a notification
  // badge when new scans have arrived since it was last opened.
  const tabs = [
    { id: 'chat', name: 'Chat', icon: 'discuss' },
    { id: 'investigate', name: 'Investigate', icon: 'search' },
    { id: 'board', name: 'Case Board', icon: 'apps' },
    {
      id: 'scans',
      name: 'Automated Scans',
      icon: 'inspect',
      append:
        newScanCount > 0 ? (
          <EuiNotificationBadge size="m">{newScanCount}</EuiNotificationBadge>
        ) : undefined,
    },
    { id: 'standup', name: 'Standup', icon: 'reportingApp' },
    { id: 'cost', name: 'Cost & Tokens', icon: 'visGauge' },
    { id: 'settings', name: 'Settings', icon: 'gear' },
  ];

  const renderContent = () => {
    switch (selectedTab) {
      case 'chat':
        return <Chat api={api} openInDiscover={openInDiscover} />;
      case 'investigate':
        return (
          <Investigate
            api={api}
            openInDiscover={openInDiscover}
            selectedCaseId={selectedCaseId}
            onSelectCase={setSelectedCaseId}
          />
        );
      case 'board':
        return (
          <Board
            api={api}
            onOpenCase={(caseId) => {
              setSelectedCaseId(caseId);
              setSelectedTab('investigate');
            }}
          />
        );
      case 'scans':
        return (
          <Scans
            api={api}
            openInDiscover={openInDiscover}
            onOpenCase={(caseId) => {
              setSelectedCaseId(caseId);
              setSelectedTab('investigate');
            }}
          />
        );
      case 'standup':
        return <Standup api={api} />;
      case 'cost':
        return <Cost api={api} />;
      case 'settings':
        return <Settings api={api} core={core} />;
      default:
        return null;
    }
  };

  return (
    <I18nProvider>
      <EuiPageTemplate restrictWidth="1280px">
        <EuiPageTemplate.Header
          pageTitle={PLUGIN_NAME}
          description="Agentic SOC triage over your ELK pipeline — read-only, audited, and cost-metered."
        />
        <EuiPageTemplate.Section>
          {loadingStatus ? (
            <>
              <EuiLoadingSpinner size="l" /> <span>Loading TLSOC status...</span>
            </>
          ) : statusError ? (
            <EuiCallOut color="danger" iconType="alert" title="Could not reach the TLSOC backend">
              <p>{statusError}</p>
              <p>
                Verify the backend is running and `tlsocAgenticTriage.backendUrl` is correct in
                kibana.yml.
              </p>
            </EuiCallOut>
          ) : status && !status.setup_complete ? (
            <Wizard api={api} dataViews={dataViews} onComplete={loadStatus} />
          ) : (
            <>
              <EuiTabs bottomBorder>
                {tabs.map((t) => (
                  <EuiTab
                    key={t.id}
                    isSelected={t.id === selectedTab}
                    onClick={() => {
                      setSelectedTab(t.id);
                      if (t.id === 'scans') {
                        setNewScanCount(0);
                      }
                    }}
                    prepend={<EuiIcon type={t.icon} size="s" />}
                    append={t.append}
                  >
                    {t.name}
                  </EuiTab>
                ))}
              </EuiTabs>
              <EuiSpacer size="l" />
              {renderContent()}
            </>
          )}
        </EuiPageTemplate.Section>
      </EuiPageTemplate>
    </I18nProvider>
  );
};
