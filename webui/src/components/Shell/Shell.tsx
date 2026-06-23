import React, { useEffect, useState } from 'react';
import {
  EuiBadge,
  EuiButtonEmpty,
  EuiHealth,
  EuiIcon,
  EuiSwitch,
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
  | 'knowledge'
  | 'memory'
  | 'sources'
  | 'cost'
  | 'metrics'
  | 'settings';

interface ShellProps {
  page: PageId;
  onNavigate: (p: PageId) => void;
  darkMode: boolean;
  onToggleDark: (v: boolean) => void;
  username?: string | null;
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
      { id: 'knowledge', name: 'Knowledge', icon: 'indexMapping' },
      { id: 'memory', name: 'Memory', icon: 'bell' },
      { id: 'sources', name: 'Sources', icon: 'logstashQueue' },
      { id: 'cost', name: 'Cost & usage', icon: 'visLine' },
      { id: 'settings', name: 'Settings', icon: 'gear' },
    ],
  },
];

function iconEl(icon: string, color: string, size: 's' | 'm' | 'l' = 'm') {
  return <EuiIcon type={icon} size={size} color={color} />;
}

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
      ? 'Store healthy'
      : 'Store degraded';

  const crumbFor = (key: PageId) => {
    for (const g of NAV_GROUPS) {
      for (const it of g.items) {
        if (it.id === key) return { group: g.label, page: it.name };
      }
    }
    return { group: 'Triage', page: 'Overview' };
  };

  const crumb = crumbFor(page);

  return (
    <div style={{ display: 'flex', minHeight: '100vh', width: '100%', background: '#F8FAFD' }}>
      <aside
        className="socSidebar"
        style={{
          width: 220,
          flex: 'none',
          display: 'flex',
          flexDirection: 'column',
          position: 'sticky',
          top: 0,
          height: '100vh',
          alignSelf: 'flex-start',
          overflow: 'hidden',
          whiteSpace: 'nowrap',
        }}
      >
        <div
          className="socSidebar-header"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 11,
            padding: '14px 18px',
            height: 56,
            flex: 'none',
          }}
        >
          {logoUrl ? (
            <img
              src={logoUrl}
              alt={wordmark}
              style={{ width: 32, height: 32, borderRadius: 6, objectFit: 'contain', flex: 'none' }}
            />
          ) : (
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: 6,
                background: '#16242F',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 13,
                fontWeight: 700,
                color: '#fff',
                flex: 'none',
              }}
            >
              TL
            </div>
          )}
          <div style={{ fontSize: 14, fontWeight: 500, color: '#1A1C21', lineHeight: 1.2 }}>
            {wordmark}
            <div style={{ fontSize: 11, fontWeight: 400, color: '#98A2B3' }}>{tagline}</div>
          </div>
        </div>

        <nav style={{ flex: 1, overflowY: 'auto', padding: '14px 12px' }}>
          {NAV_GROUPS.map((group) => (
            <div key={group.label} style={{ marginBottom: 20 }}>
              <div className="socNavGroupLabel">{group.label}</div>
              {group.items.map((item) => {
                const active = page === item.id;
                return (
                  <button
                    key={item.id}
                    className={`socNavItem${active ? ' socNavItem--active' : ''}`}
                    onClick={() => onNavigate(item.id)}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 11,
                      padding: '8px 10px',
                      border: 'none',
                      background: active ? '#E7F0F8' : 'transparent',
                      color: active ? '#006BB4' : '#343741',
                      fontFamily: 'inherit',
                      fontSize: 13,
                      fontWeight: active ? 600 : 400,
                      cursor: 'pointer',
                      textAlign: 'left',
                      marginBottom: 1,
                    }}
                  >
                    <span
                      style={{
                        flex: 'none',
                        width: 17,
                        display: 'flex',
                        justifyContent: 'center',
                        color: active ? '#006BB4' : '#69707D',
                      }}
                    >
                      {iconEl(item.icon, active ? '#006BB4' : '#69707D', 's')}
                    </span>
                    <span>{item.name}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div style={{ padding: 12, borderTop: '1px solid #D3DAE6' }}>
          <button
            className="socNavItem"
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: 11,
              padding: '8px 10px',
              border: 'none',
              background: 'transparent',
              color: '#343741',
              fontFamily: 'inherit',
              fontSize: 13,
              cursor: 'pointer',
              borderRadius: 4,
              textAlign: 'left',
            }}
          >
            <span style={{ flex: 'none', width: 17, display: 'flex', justifyContent: 'center', color: '#69707D' }}>
              {iconEl('documentation', '#69707D', 's')}
            </span>
            <span>Docs &amp; help</span>
          </button>
        </div>
      </aside>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <header className="socHeader">
          <div style={{ width: 24, height: 24, borderRadius: 5, background: '#16242F', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, color: '#fff', flex: 'none' }}>TL</div>
          <div style={{ fontSize: 15, fontWeight: 500, color: '#1A1C21' }}>{wordmark}</div>
          <span style={{ fontSize: 13, color: '#69707D' }}>{tagline}</span>

          <div style={{ flex: 1 }} />

          {health?.version ? (
            <span style={{ fontSize: 11, fontWeight: 500, color: '#69707D', background: '#F0F4F7', border: '1px solid #E4E8F0', padding: '3px 9px', borderRadius: 10, fontFamily: "'SFMono-Regular', Consolas, monospace" }}>
              v{health.version}
            </span>
          ) : null}

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <EuiToolTip content={healthErr ? 'Cannot reach the backend API' : `Store: ${health?.store_type ?? 'unknown'}`}>
              <EuiHealth color={healthColor}>{healthLabel}</EuiHealth>
            </EuiToolTip>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <EuiSwitch
              label="Toggle dark mode"
              showLabel={false}
              compressed
              checked={darkMode}
              onChange={(e) => onToggleDark(e.target.checked)}
            />
          </div>

          {username ? (
            <EuiToolTip content={`Signed in as ${username}`}>
              <EuiBadge color="hollow" iconType="user">
                {username}
              </EuiBadge>
            </EuiToolTip>
          ) : null}

          {onLogout ? (
            <EuiButtonEmpty size="xs" iconType="exit" color="text" onClick={onLogout} aria-label="Log out">
              Log out
            </EuiButtonEmpty>
          ) : null}

          <div style={{ width: 32, height: 32, borderRadius: '50%', background: '#006BB4', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600, marginLeft: 4, flex: 'none' }}>
            {username ? username.charAt(0).toUpperCase() : 'A'}
          </div>
        </header>

        <div className="socBreadcrumb">
          <span style={{ fontSize: 12, color: '#69707D' }}>{crumb.group}</span>
          <span style={{ fontSize: 12, color: '#98A2B3' }}>›</span>
          <span style={{ fontSize: 12, color: '#343741', fontWeight: 500 }}>{crumb.page}</span>
        </div>

        <main style={{ flex: 1, overflowY: 'auto', background: '#F8FAFD' }}>
          {children}
        </main>
      </div>
    </div>
  );
};
