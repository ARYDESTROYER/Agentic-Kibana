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
import { useBranding } from '../../lib/branding';

export type PageId =
  | 'overview'
  | 'cases'
  | 'investigate'
  | 'chat'
  | 'scans'
  | 'standup'
  | 'catalog'
  | 'sources'
  | 'cost'
  | 'metrics'
  | 'settings';

interface ShellProps {
  page: PageId;
  onNavigate: (p: PageId) => void;
  darkMode: boolean;
  onToggleDark: (v: boolean) => void;
  /** When auth is enabled + authenticated, the signed-in username (shows a logout control). */
  username?: string | null;
  /** Called when the user clicks "Log out" (only rendered when `username` is set). */
  onLogout?: () => void;
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
      { id: 'metrics', name: 'Metrics', icon: 'stats' },
    ],
  },
  {
    label: 'Automation',
    items: [
      { id: 'scans', name: 'Automated scans', icon: 'reportingApp' },
      { id: 'standup', name: 'Standup', icon: 'visText' },
      { id: 'catalog', name: 'Playbooks & Agents', icon: 'inspect' },
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

export const Shell: React.FC<ShellProps> = ({
  page,
  onNavigate,
  darkMode,
  onToggleDark,
  username,
  onLogout,
  children,
}) => {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthErr, setHealthErr] = useState(false);
  const { branding } = useBranding();
  // Fall back to the historical wording when branding fields are empty, so the
  // no-branding header is byte-identical to today.
  const wordmark = branding.org_name?.trim() || 'Agentic SOC';
  const tagline = branding.product_name?.trim() || 'Triage console';
  const logoUrl = branding.logo_data_url?.trim() || '';

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
                {logoUrl ? (
                  <img
                    src={logoUrl}
                    alt={wordmark}
                    style={{ width: 30, height: 30, borderRadius: 8, objectFit: 'contain' }}
                  />
                ) : (
                  <span className="socLogo">
                    <EuiIcon type="securityApp" size="m" />
                  </span>
                )}
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <div style={{ lineHeight: 1.1 }}>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{wordmark}</div>
                  <EuiText size="xs" color="subdued"><span>{tagline}</span></EuiText>
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
              {username ? (
                <EuiFlexItem grow={false}>
                  <EuiToolTip content={`Signed in as ${username}`}>
                    <EuiBadge color="hollow" iconType="user">
                      {username}
                    </EuiBadge>
                  </EuiToolTip>
                </EuiFlexItem>
              ) : null}
              {onLogout ? (
                <EuiFlexItem grow={false}>
                  <EuiButtonEmpty
                    size="xs"
                    iconType="exit"
                    color="text"
                    onClick={onLogout}
                    aria-label="Log out"
                  >
                    Log out
                  </EuiButtonEmpty>
                </EuiFlexItem>
              ) : null}
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
              rel="noopener noreferrer"
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
