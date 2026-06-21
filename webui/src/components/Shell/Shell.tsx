/**
 * App shell — branded fixed header (logo mark + wordmark + health + dark toggle),
 * a gradient brand accent, and a grouped left side-nav. Health polls /api/health.
 */
import React, { useEffect, useState } from 'react';
import {
  EuiBadge,
  EuiButtonEmpty,
  EuiFlexGroup,
  EuiFlexItem,
  EuiHeader,
  EuiHeaderSection,
  EuiHeaderSectionItem,
  EuiHealth,
  EuiIcon,
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

export type PageId =
  | 'overview'
  | 'cases'
  | 'investigate'
  | 'chat'
  | 'scans'
  | 'standup'
  | 'sources'
  | 'cost'
  | 'settings';

interface ShellProps {
  page: PageId;
  onNavigate: (p: PageId) => void;
  darkMode: boolean;
  onToggleDark: (v: boolean) => void;
  children: React.ReactNode;
}

interface NavItem {
  id: PageId;
  name: string;
  icon: string;
}
const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: 'Triage',
    items: [
      { id: 'overview', name: 'Overview', icon: 'dashboardApp' },
      { id: 'cases', name: 'Cases', icon: 'securityApp' },
      { id: 'investigate', name: 'Investigate', icon: 'inspect' },
      { id: 'chat', name: 'Chat', icon: 'discuss' },
    ],
  },
  {
    label: 'Automation',
    items: [
      { id: 'scans', name: 'Automated scans', icon: 'reportingApp' },
      { id: 'standup', name: 'Standup', icon: 'visText' },
    ],
  },
  {
    label: 'Platform',
    items: [
      { id: 'sources', name: 'Sources', icon: 'logstashQueue' },
      { id: 'cost', name: 'Cost & usage', icon: 'visLine' },
      { id: 'settings', name: 'Settings', icon: 'gear' },
    ],
  },
];

export const Shell: React.FC<ShellProps> = ({ page, onNavigate, darkMode, onToggleDark, children }) => {
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
      ? 'Healthy'
      : 'Store degraded';

  const sideNav = NAV_GROUPS.map((group) => ({
    name: group.label,
    id: group.label,
    items: group.items.map((n) => ({
      id: n.id,
      name: n.name,
      icon: <EuiIcon type={n.icon} color={page === n.id ? COLORS.primary : 'subdued'} />,
      isSelected: page === n.id,
      onClick: () => onNavigate(n.id),
    })),
  }));

  return (
    <>
      <EuiHeader position="fixed">
        <EuiHeaderSection grow={false}>
          <EuiHeaderSectionItem>
            <EuiFlexGroup alignItems="center" gutterSize="s" responsive={false} style={{ paddingLeft: 12 }}>
              <EuiFlexItem grow={false}>
                <span className="socLogo">
                  <EuiIcon type="securityApp" size="m" />
                </span>
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <div style={{ lineHeight: 1.1 }}>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>Agentic SOC</div>
                  <EuiText size="xs" color="subdued"><span>Triage console</span></EuiText>
                </div>
              </EuiFlexItem>
            </EuiFlexGroup>
          </EuiHeaderSectionItem>
        </EuiHeaderSection>
        <EuiHeaderSection side="right">
          <EuiHeaderSectionItem>
            <EuiFlexGroup alignItems="center" gutterSize="m" responsive={false} style={{ paddingRight: 12 }}>
              {health?.version ? (
                <EuiFlexItem grow={false}>
                  <EuiBadge color="hollow">v{health.version}</EuiBadge>
                </EuiFlexItem>
              ) : null}
              <EuiFlexItem grow={false}>
                <EuiToolTip content={healthErr ? 'Cannot reach the backend API' : `Store: ${health?.store_type ?? 'unknown'}`}>
                  <EuiHealth color={healthColor}>{healthLabel}</EuiHealth>
                </EuiToolTip>
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <EuiSwitch
                  label={<EuiIcon type={darkMode ? 'moon' : 'sun'} />}
                  showLabel={false}
                  compressed
                  checked={darkMode}
                  onChange={(e) => onToggleDark(e.target.checked)}
                  aria-label="Toggle dark mode"
                />
              </EuiFlexItem>
            </EuiFlexGroup>
          </EuiHeaderSectionItem>
        </EuiHeaderSection>
      </EuiHeader>

      {/* Gradient brand accent just under the fixed header. */}
      <div className="socBrandAccent" style={{ position: 'fixed', top: 48, left: 0, right: 0, zIndex: 999 }} />

      <EuiPage paddingSize="none" style={{ marginTop: 51, minHeight: 'calc(100vh - 51px)' }}>
        <EuiPageSidebar paddingSize="l" sticky={{ offset: 51 }}>
          <EuiSideNav items={sideNav} />
          <div style={{ marginTop: 24 }}>
            <EuiButtonEmpty
              size="xs"
              iconType="documentation"
              href="https://github.com"
              target="_blank"
              color="text"
            >
              Docs &amp; help
            </EuiButtonEmpty>
          </div>
        </EuiPageSidebar>
        <EuiPageBody>
          <EuiPageSection restrictWidth={1280} paddingSize="l">
            {children}
          </EuiPageSection>
        </EuiPageBody>
      </EuiPage>
    </>
  );
};
