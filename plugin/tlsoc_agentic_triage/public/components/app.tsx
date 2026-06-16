import React, { useEffect, useMemo, useRef, useState } from 'react';
import { I18nProvider } from '@kbn/i18n-react';
import {
  EuiLoadingSpinner,
  EuiNotificationBadge,
  EuiPageTemplate,
  EuiSpacer,
  EuiTab,
  EuiTabs,
  EuiText,
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

  const tabs = [
    { id: 'chat', name: 'Agent Chat' },
    { id: 'investigate', name: 'Alerts / Investigate' },
    {
      id: 'scans',
      name: 'Automated Scans',
      append:
        newScanCount > 0 ? (
          <EuiNotificationBadge size="m">{newScanCount}</EuiNotificationBadge>
        ) : undefined,
    },
    { id: 'standup', name: 'Daily Standup' },
    { id: 'cost', name: 'Cost' },
    { id: 'settings', name: 'Settings' },
  ];

  const renderContent = () => {
    switch (selectedTab) {
      case 'chat':
        return <Chat api={api} openInDiscover={openInDiscover} />;
      case 'investigate':
        return <Investigate api={api} openInDiscover={openInDiscover} />;
      case 'scans':
        return <Scans api={api} openInDiscover={openInDiscover} />;
      case 'standup':
        return <Standup api={api} />;
      case 'cost':
        return <Cost api={api} />;
      case 'settings':
        return <Settings api={api} />;
      default:
        return null;
    }
  };

  return (
    <I18nProvider>
      <EuiPageTemplate restrictWidth="1200px">
        <EuiPageTemplate.Header pageTitle={PLUGIN_NAME} />
        <EuiPageTemplate.Section>
          {loadingStatus ? (
            <>
              <EuiLoadingSpinner size="l" /> <span>Loading TLSOC status...</span>
            </>
          ) : statusError ? (
            <EuiText color="danger">
              <p>Could not reach the TLSOC backend: {statusError}</p>
              <p>
                Verify the backend is running and `tlsocAgenticTriage.backendUrl` is correct in
                kibana.yml.
              </p>
            </EuiText>
          ) : status && !status.setup_complete ? (
            <Wizard api={api} dataViews={dataViews} onComplete={loadStatus} />
          ) : (
            <>
              <EuiTabs>
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
