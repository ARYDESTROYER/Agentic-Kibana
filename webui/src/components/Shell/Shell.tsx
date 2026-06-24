/**
 * App shell — branded fixed header (logo mark + wordmark + health + dark toggle),
 * a gradient brand accent, and a grouped left side-nav. Health polls /api/health.
 */
import React, { useEffect, useRef, useState } from 'react';
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
  EuiSkipLink,
  EuiSwitch,
  EuiToolTip,
} from '@elastic/eui';
import type { HealthResponse, NavOpts } from '../../lib/types';
import { api } from '../../lib/api';
import { COLORS, HEADER_H, MAX_CONTENT_WIDTH, tint } from '../../lib/theme';
import { useBranding } from '../../lib/branding';

export type PageId =
  | 'overview'
  | 'cases'
  | 'investigate'
  | 'chat'
  | 'scans'
  | 'standup'
  | 'catalog'
  | 'proposals'
  | 'knowledge'
  | 'memory'
  | 'sources'
  | 'cost'
  | 'metrics'
  | 'settings';

/**
 * Navigation callback. Pages call this to move between surfaces; `opts` optionally
 * pre-seeds the destination (e.g. a status filter for a drill-through). Widening
 * the prior `(p) => void` is back-compatible — `opts` is ignorable.
 */
export type Navigate = (page: PageId, opts?: NavOpts) => void;

interface ShellProps {
  page: PageId;
  onNavigate: Navigate;
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
      { id: 'catalog', name: 'Playbooks & Agents', icon: 'article' },
      { id: 'proposals', name: 'Approvals', icon: 'flag' },
    ],
  },
  {
    label: 'Platform',
    items: [
      { id: 'knowledge', name: 'Knowledge', icon: 'indexMapping' },
      { id: 'memory', name: 'Memory', icon: 'memory' },
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
  // Debounce: only flip to "unreachable" after 2 consecutive failed polls, so a
  // single dropped poll keeps the last good state.
  const failCountRef = useRef(0);
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
          failCountRef.current = 0;
          setHealth(h);
          setHealthErr(false);
        }
      } catch {
        if (!alive) return;
        failCountRef.current += 1;
        // Only surface "unreachable" after 2 consecutive failures; a single
        // dropped poll preserves the last good state.
        if (failCountRef.current >= 2) setHealthErr(true);
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
  const healthIcon = healthErr
    ? 'errorFilled'
    : health?.es_connected
      ? 'checkInCircleFilled'
      : 'warning';

  const sideNav = NAV_GROUPS.map((group) => ({
    name: group.label,
    id: group.label,
    items: group.items.map((n) => {
      const selected = page === n.id;
      return {
        id: n.id,
        name: n.name,
        icon: (
          <EuiIcon
            type={n.icon}
            size="m"
            color={selected ? COLORS.primary : 'subdued'}
          />
        ),
        isSelected: selected,
        // Tag the selected row so index.css can paint an accent tint + left bar.
        className: selected ? 'socNavItem socNavItem--selected' : 'socNavItem',
        onClick: () => onNavigate(n.id),
      };
    }),
  }));

  const supportUrl = branding.support_url?.trim() || '';
  const validSupportUrl = /^https?:\/\//i.test(supportUrl) ? supportUrl : '';
  const footerText = branding.footer_text?.trim() || '';

  return (
    <>
      <EuiSkipLink destinationId="socMain" position="fixed" className="socSkipLink">
        Skip to main content
      </EuiSkipLink>
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
                  <span className="socLogo" aria-hidden="true">
                    <EuiIcon type="securityApp" size="m" />
                  </span>
                )}
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <div style={{ lineHeight: 1.15 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, letterSpacing: -0.2 }}>{wordmark}</div>
                  <div
                    style={{
                      fontSize: 10.5,
                      fontWeight: 600,
                      letterSpacing: 0.4,
                      textTransform: 'uppercase',
                      color: COLORS.subdued,
                    }}
                  >
                    {tagline}
                  </div>
                </div>
              </EuiFlexItem>
            </EuiFlexGroup>
          </EuiHeaderSectionItem>
        </EuiHeaderSection>
        <EuiHeaderSection side="right">
          <EuiHeaderSectionItem>
            <EuiFlexGroup
              alignItems="center"
              gutterSize="s"
              responsive={false}
              style={{ paddingRight: 12 }}
            >
              <EuiFlexItem grow={false}>
                <EuiToolTip
                  content={
                    healthErr
                      ? 'Cannot reach the backend API'
                      : `Store: ${health?.store_type ?? 'unknown'}`
                  }
                >
                  <span
                    className="socHealthPill"
                    style={{ borderColor: tint(healthColor, 0.4) }}
                    aria-live="polite"
                  >
                    <EuiHealth color={healthColor}>
                      <EuiFlexGroup alignItems="center" gutterSize="xs" responsive={false}>
                        <EuiFlexItem grow={false}>
                          <EuiIcon type={healthIcon} size="s" color={healthColor} aria-hidden="true" />
                        </EuiFlexItem>
                        <EuiFlexItem grow={false}>{healthLabel}</EuiFlexItem>
                      </EuiFlexGroup>
                    </EuiHealth>
                  </span>
                </EuiToolTip>
              </EuiFlexItem>
              {health?.version ? (
                <EuiFlexItem grow={false}>
                  <EuiBadge color="hollow">v{health.version}</EuiBadge>
                </EuiFlexItem>
              ) : null}
              <EuiFlexItem grow={false}>
                <span className="socHeaderDivider" />
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <EuiToolTip content={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}>
                  <EuiSwitch
                    label={<EuiIcon type={darkMode ? 'moon' : 'sun'} />}
                    showLabel={false}
                    compressed
                    checked={darkMode}
                    onChange={(e) => onToggleDark(e.target.checked)}
                    aria-label="Toggle dark mode"
                  />
                </EuiToolTip>
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
      <div
        className="socBrandAccent"
        style={{ position: 'fixed', top: HEADER_H, left: 0, right: 0, zIndex: 999 }}
      />

      <EuiPage
        paddingSize="none"
        style={{ marginTop: HEADER_H + 3, minHeight: `calc(100vh - ${HEADER_H + 3}px)` }}
      >
        <EuiPageSidebar paddingSize="l" sticky={{ offset: HEADER_H + 3 }}>
          <nav className="socSideNav" aria-label="Primary">
            <EuiSideNav items={sideNav} aria-label="Primary" />
          </nav>
          <div style={{ marginTop: 24 }}>
            {validSupportUrl ? (
              <EuiButtonEmpty
                size="xs"
                iconType="documentation"
                href={validSupportUrl}
                target="_blank"
                rel="noopener noreferrer"
                color="text"
              >
                Docs &amp; help
              </EuiButtonEmpty>
            ) : null}
            {footerText ? (
              <div
                style={{
                  marginTop: 10,
                  fontSize: 11,
                  color: COLORS.subdued,
                  lineHeight: 1.4,
                }}
              >
                {footerText}
              </div>
            ) : null}
          </div>
        </EuiPageSidebar>
        <EuiPageBody>
          <EuiPageSection id="socMain" role="main" restrictWidth={MAX_CONTENT_WIDTH} paddingSize="l">
            {children}
          </EuiPageSection>
        </EuiPageBody>
      </EuiPage>
    </>
  );
};
