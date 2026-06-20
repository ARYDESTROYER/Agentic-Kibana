/**
 * App shell — fixed top bar (product name + health indicator) and a left side
 * nav across all pages. Health polls GET /api/health.
 */
import React, { useEffect, useState } from 'react';
import {
  EuiButtonEmpty,
  EuiFlexGroup,
  EuiFlexItem,
  EuiHealth,
  EuiHeader,
  EuiHeaderSection,
  EuiHeaderSectionItem,
  EuiPage,
  EuiPageBody,
  EuiPageSection,
  EuiPageSidebar,
  EuiSideNav,
  EuiSwitch,
  EuiText,
  EuiToolTip,
} from '@elastic/eui';
import type { HealthResponse } from '../../lib/types';
import { api } from '../../lib/api';
import { COLORS } from '../../lib/theme';
import { IconChip } from '../common/ui';

export type PageId =
  | 'cases'
  | 'chat'
  | 'investigate'
  | 'scans'
  | 'standup'
  | 'cost'
  | 'sources'
  | 'settings';

interface ShellProps {
  page: PageId;
  onNavigate: (p: PageId) => void;
  darkMode: boolean;
  onToggleDark: (v: boolean) => void;
  children: React.ReactNode;
}

const NAV: Array<{ id: PageId; name: string; icon: string }> = [
  { id: 'cases', name: 'Cases', icon: 'securityApp' },
  { id: 'chat', name: 'Chat', icon: 'discuss' },
  { id: 'investigate', name: 'Investigate', icon: 'inspect' },
  { id: 'scans', name: 'Automated scans', icon: 'reportingApp' },
  { id: 'standup', name: 'Standup', icon: 'visText' },
  { id: 'cost', name: 'Cost', icon: 'visLine' },
  { id: 'sources', name: 'Sources', icon: 'logstashQueue' },
  { id: 'settings', name: 'Settings', icon: 'gear' },
];

export const Shell: React.FC<ShellProps> = ({
  page,
  onNavigate,
  darkMode,
  onToggleDark,
  children,
}) => {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthErr, setHealthErr] = useState(false);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const h = await api.health();
        if (alive) {
          setHealth(h);
          setHealthErr(false);
        }
      } catch {
        if (alive) setHealthErr(true);
      }
    };
    void poll();
    const t = window.setInterval(poll, 15000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  const healthColor = healthErr ? COLORS.danger : health?.es_connected ? COLORS.success : COLORS.warning;
  const healthLabel = healthErr
    ? 'Backend unreachable'
    : health?.es_connected
      ? 'Connected'
      : 'Backend up, store degraded';

  const sideNav = [
    {
      name: 'Console',
      id: 'console',
      items: NAV.map((n) => ({
        id: n.id,
        name: n.name,
        icon: <IconChip icon={n.icon} accent={page === n.id ? COLORS.primary : COLORS.subdued} />,
        isSelected: page === n.id,
        onClick: () => onNavigate(n.id),
      })),
    },
  ];

  return (
    <>
      <EuiHeader position="fixed">
        <EuiHeaderSection grow={false}>
          <EuiHeaderSectionItem>
            <EuiFlexGroup alignItems="center" gutterSize="s" responsive={false} style={{ paddingLeft: 12 }}>
              <EuiFlexItem grow={false}>
                <IconChip icon="securityApp" accent={COLORS.primary} />
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <EuiText>
                  <strong>Agentic SOC Console</strong>
                </EuiText>
              </EuiFlexItem>
            </EuiFlexGroup>
          </EuiHeaderSectionItem>
        </EuiHeaderSection>
        <EuiHeaderSection side="right">
          <EuiHeaderSectionItem>
            <EuiFlexGroup alignItems="center" gutterSize="m" responsive={false} style={{ paddingRight: 12 }}>
              <EuiFlexItem grow={false}>
                <EuiSwitch
                  label="Dark"
                  compressed
                  checked={darkMode}
                  onChange={(e) => onToggleDark(e.target.checked)}
                />
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <EuiToolTip content={health?.version ? `Backend v${health.version}` : 'Backend health'}>
                  <EuiHealth color={healthColor}>{healthLabel}</EuiHealth>
                </EuiToolTip>
              </EuiFlexItem>
            </EuiFlexGroup>
          </EuiHeaderSectionItem>
        </EuiHeaderSection>
      </EuiHeader>

      <EuiPage paddingSize="none" style={{ marginTop: 48, minHeight: 'calc(100vh - 48px)' }}>
        <EuiPageSidebar paddingSize="l" sticky={{ offset: 48 }}>
          <EuiSideNav items={sideNav} />
          <div style={{ marginTop: 24 }}>
            <EuiButtonEmpty
              size="xs"
              iconType="popout"
              href="https://github.com"
              target="_blank"
              color="text"
            >
              Standalone web UI
            </EuiButtonEmpty>
          </div>
        </EuiPageSidebar>
        <EuiPageBody>
          <EuiPageSection restrictWidth={1200}>{children}</EuiPageSection>
        </EuiPageBody>
      </EuiPage>
    </>
  );
};
