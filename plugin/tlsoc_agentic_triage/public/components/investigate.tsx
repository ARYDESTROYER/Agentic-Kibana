import React, { useEffect, useMemo, useState } from 'react';
import {
  EuiBadge,
  EuiButton,
  EuiCallOut,
  EuiFieldSearch,
  EuiFlexGrid,
  EuiFlexGroup,
  EuiFlexItem,
  EuiHorizontalRule,
  EuiIcon,
  EuiLoadingSpinner,
  EuiNotificationBadge,
  EuiPanel,
  EuiPopover,
  EuiSelect,
  EuiSpacer,
  EuiSwitch,
  EuiText,
  EuiTitle,
} from '@elastic/eui';
import type { Case, Entity } from '../../common';
import type { TlsocApi } from '../lib/api';
import type { OpenInDiscover } from '../lib/discover';
import { DASH, formatTimestamp, humanizeToken } from '../lib/format';
import { COLORS, SectionHeader } from './ui';
import { CaseDetail } from './case_detail';
import { Chat } from './chat';

/** Shape of a Kibana HttpFetchError; we read the backend's JSON `body` detail
 * and `response.status` so a NEUTRAL 400 ("No events found") becomes an info
 * empty-state instead of a red danger error. */
interface HttpFetchErrorLike {
  body?: { statusCode?: number; message?: string; error?: string; detail?: string };
  response?: { status?: number };
  message?: string;
}

function errorDetail(err: unknown): string {
  const e = err as HttpFetchErrorLike;
  return e?.body?.detail ?? e?.body?.message ?? e?.message ?? 'Request failed';
}

function isNoEventsError(err: unknown): boolean {
  const e = err as HttpFetchErrorLike;
  const status = e?.body?.statusCode ?? e?.response?.status;
  if (status === 400) return true;
  return errorDetail(err).toLowerCase().includes('no events');
}

/** Format a risk score the way the cards present it (two decimals). */
function fmtRisk(score?: number): string {
  if (typeof score !== 'number' || Number.isNaN(score)) {
    return DASH;
  }
  return score.toFixed(2);
}

/**
 * Risk text colour. Deliberately restrained: only genuinely high scores get a
 * hot colour so a card wall reads at a glance (most numbers stay near-ink).
 */
function riskNumberColor(score?: number): string {
  if (typeof score !== 'number' || Number.isNaN(score)) {
    return COLORS.subdued;
  }
  if (score >= 80) return COLORS.danger;
  if (score >= 60) return '#e2725b';
  return '#1a1c21';
}

/** Lifecycle status as a solid pill (open = neutral, needs_human = amber,
 * closed = green). Matches the card footer in the reference design. */
function StatusPill({ status }: { status?: string }) {
  const s = (status || '').toLowerCase();
  if (s === 'open') {
    return <EuiBadge color="hollow">Open</EuiBadge>;
  }
  if (s === 'needs_human') {
    return <EuiBadge color={COLORS.warning}>Needs human</EuiBadge>;
  }
  if (s === 'closed') {
    return <EuiBadge color={COLORS.success}>Closed</EuiBadge>;
  }
  return <EuiBadge color="hollow">{humanizeToken(status)}</EuiBadge>;
}

/** A tiny uppercase, letter-spaced field label (ENTITY / RISK / RULES / CREATED). */
const MetaLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span
    style={{
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: '0.07em',
      textTransform: 'uppercase',
      color: COLORS.subdued,
    }}
  >
    {children}
  </span>
);

/**
 * A single "Active Case" card. The whole card is a selectable control (wrapper
 * div carries the click + keyboard handlers so the EuiPanel stays a plain div and
 * can contain block content like the divider). A primary ring marks the selection.
 */
const CaseGridCard: React.FC<{ theCase: Case; selected: boolean; onOpen: () => void }> = ({
  theCase: c,
  selected,
  onOpen,
}) => {
  const rules = c.rule_ids || [];
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      style={{ cursor: 'pointer', height: '100%' }}
    >
      <EuiPanel
        hasBorder
        paddingSize="m"
        className="tlsocCard"
        style={{
          height: '100%',
          borderColor: selected ? COLORS.primary : undefined,
          boxShadow: selected ? `0 0 0 1px ${COLORS.primary}` : undefined,
        }}
      >
        {/* ENTITY / RISK labels */}
        <EuiFlexGroup justifyContent="spaceBetween" responsive={false} gutterSize="s">
          <EuiFlexItem grow={false}>
            <MetaLabel>Entity</MetaLabel>
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <MetaLabel>Risk</MetaLabel>
          </EuiFlexItem>
        </EuiFlexGroup>
        <EuiSpacer size="xs" />

        {/* Entity value (monospace, primary) + prominent, colour-coded risk. */}
        <EuiFlexGroup justifyContent="spaceBetween" alignItems="center" responsive={false} gutterSize="s">
          <EuiFlexItem>
            <span
              style={{
                fontFamily: 'monospace',
                fontWeight: 600,
                fontSize: 15,
                color: COLORS.primary,
                wordBreak: 'break-all',
              }}
            >
              {c.entity ? `${c.entity.type}: ${c.entity.value}` : c.title || c.case_id}
            </span>
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <span style={{ fontSize: 24, fontWeight: 700, lineHeight: 1, color: riskNumberColor(c.risk_score) }}>
              {fmtRisk(c.risk_score)}
            </span>
          </EuiFlexItem>
        </EuiFlexGroup>

        <EuiSpacer size="m" />
        <MetaLabel>Rules</MetaLabel>
        <EuiSpacer size="xs" />
        {rules.length ? (
          <EuiFlexGroup gutterSize="xs" wrap responsive={false}>
            {rules.map((r) => (
              <EuiFlexItem grow={false} key={r}>
                <EuiBadge color="hollow">{r}</EuiBadge>
              </EuiFlexItem>
            ))}
          </EuiFlexGroup>
        ) : (
          <EuiText size="xs" color="subdued">
            <span>{DASH}</span>
          </EuiText>
        )}

        <EuiHorizontalRule margin="m" />

        {/* CREATED + status pill. */}
        <EuiFlexGroup justifyContent="spaceBetween" alignItems="flexEnd" responsive={false} gutterSize="s">
          <EuiFlexItem grow={false}>
            <MetaLabel>Created</MetaLabel>
            <EuiText size="s">
              <span>{formatTimestamp(c.created_at)}</span>
            </EuiText>
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <StatusPill status={c.status} />
          </EuiFlexItem>
        </EuiFlexGroup>
      </EuiPanel>
    </div>
  );
};

interface InvestigateProps {
  api: TlsocApi;
  openInDiscover: OpenInDiscover;
  /** Selected case id, lifted to app-level state so it survives tab switches. */
  selectedCaseId: string | null;
  /** Open the stored case (GET by id) — does NOT re-investigate. */
  onSelectCase: (caseId: string | null) => void;
}

const STATUS_FILTERS: Array<{ id: string; label: string }> = [
  { id: 'open', label: 'Open' },
  { id: 'needs_human', label: 'Needs human' },
  { id: 'closed', label: 'Closed' },
];

export const Investigate: React.FC<InvestigateProps> = ({
  api,
  openInDiscover,
  selectedCaseId,
  onSelectCase,
}) => {
  const [cases, setCases] = useState<Case[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // BUG-2: NEUTRAL "no events found" outcome — info empty-state, not a red error.
  const [notice, setNotice] = useState<string | null>(null);
  const [investigating, setInvestigating] = useState(false);

  // manual investigation inputs
  const [manualType, setManualType] = useState<Entity['type']>('ip');
  const [manualValue, setManualValue] = useState('');

  // client-side status filter (the "Filters" control)
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [statusOn, setStatusOn] = useState<Record<string, boolean>>({
    open: true,
    needs_human: true,
    closed: true,
  });

  const loadCases = async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await api.get<{ cases: Case[]; total: number }>('cases', { limit: 100 });
      setCases(resp.cases || []);
    } catch (e) {
      setError(errorDetail(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCases();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * PAID investigation. Only call on an explicit user action (the search box's
   * Investigate button / Enter). Selecting the resulting case opens its stored
   * detail view.
   */
  const investigate = async (entity: Entity, group_by: Entity['type']) => {
    setInvestigating(true);
    setError(null);
    setNotice(null);
    try {
      const theCase = await api.post<Case>('investigate', {
        entity,
        group_by,
        source_surface: 'investigate',
      });
      // Refresh the list and open the (now stored) case by id.
      await loadCases();
      if (theCase && theCase.case_id) {
        onSelectCase(theCase.case_id);
      }
    } catch (e) {
      // BUG-2: a NEUTRAL 400 ("No events found for ...") is an empty-state, not
      // a failure. Only real 5xx / unexpected errors render as danger.
      if (isNoEventsError(e)) {
        setNotice(errorDetail(e));
      } else {
        setError(errorDetail(e));
      }
    } finally {
      setInvestigating(false);
    }
  };

  const runManualInvestigate = () => {
    const value = manualValue.trim();
    if (!value) {
      return;
    }
    investigate({ type: manualType, value }, manualType);
  };

  // Client-side status filter over the loaded cases. Unknown statuses always show.
  const visibleCases = useMemo(
    () =>
      cases.filter((c) => {
        const s = (c.status || '').toLowerCase();
        if (s in statusOn) {
          return statusOn[s];
        }
        return true;
      }),
    [cases, statusOn]
  );
  const hiddenFilterCount = STATUS_FILTERS.filter((s) => !statusOn[s.id]).length;

  return (
    <div>
      <SectionHeader
        title="Security Investigation"
        description="Triage emerging threats and analyze entity behavior across the infrastructure."
      />

      {error ? (
        <>
          <EuiCallOut color="danger" size="s" title={error} />
          <EuiSpacer size="m" />
        </>
      ) : null}

      {/* BUG-2: NEUTRAL no-events outcome — info, not an error. */}
      {notice ? (
        <>
          <EuiCallOut color="primary" size="s" iconType="iInCircle" title="No events found">
            <p>{notice}</p>
          </EuiCallOut>
          <EuiSpacer size="m" />
        </>
      ) : null}

      {/* Manual entry: investigate by IP / user / host. */}
      <EuiPanel hasBorder paddingSize="l">
        <MetaLabel>Investigate by IP / user / host</MetaLabel>
        <EuiSpacer size="s" />
        <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false} wrap>
          <EuiFlexItem grow={false} style={{ minWidth: 150 }}>
            <EuiSelect
              value={manualType}
              onChange={(e) => setManualType(e.target.value as Entity['type'])}
              options={[
                { value: 'ip', text: 'IP Address' },
                { value: 'user', text: 'User' },
                { value: 'host', text: 'Host' },
              ]}
              aria-label="Entity type"
            />
          </EuiFlexItem>
          <EuiFlexItem style={{ minWidth: 240 }}>
            <EuiFieldSearch
              fullWidth
              placeholder="Enter entity identifier (e.g. 10.130.171.247 or j.doe)..."
              value={manualValue}
              isClearable
              onChange={(e) => setManualValue(e.target.value)}
              onSearch={(v) => {
                const value = v.trim();
                if (value) {
                  investigate({ type: manualType, value }, manualType);
                }
              }}
              aria-label="Entity identifier"
            />
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiButton
              fill
              isLoading={investigating}
              isDisabled={!manualValue.trim()}
              onClick={runManualInvestigate}
            >
              Investigate
            </EuiButton>
          </EuiFlexItem>
        </EuiFlexGroup>
      </EuiPanel>

      <EuiSpacer size="l" />

      {/* Active cases header: count + Refresh / Filters. */}
      <EuiFlexGroup justifyContent="spaceBetween" alignItems="flexEnd" gutterSize="m" responsive={false} wrap>
        <EuiFlexItem grow={false}>
          <EuiTitle size="s">
            <h3>Active Cases</h3>
          </EuiTitle>
          <EuiText size="s" color="subdued">
            <span>
              {loading
                ? 'Loading cases…'
                : `Reviewing ${visibleCases.length} prioritized alert${
                    visibleCases.length === 1 ? '' : 's'
                  } requiring analyst intervention.`}
            </span>
          </EuiText>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiFlexGroup gutterSize="s" responsive={false}>
            <EuiFlexItem grow={false}>
              <EuiButton size="s" iconType="refresh" onClick={loadCases} isLoading={loading}>
                Refresh
              </EuiButton>
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiPopover
                isOpen={filtersOpen}
                closePopover={() => setFiltersOpen(false)}
                anchorPosition="downRight"
                panelPaddingSize="m"
                button={
                  <EuiButton
                    size="s"
                    iconType="filter"
                    onClick={() => setFiltersOpen((o) => !o)}
                  >
                    Filters
                    {hiddenFilterCount > 0 ? (
                      <>
                        {' '}
                        <EuiNotificationBadge color="subdued">
                          {hiddenFilterCount}
                        </EuiNotificationBadge>
                      </>
                    ) : null}
                  </EuiButton>
                }
              >
                <div style={{ minWidth: 200 }}>
                  <EuiText size="xs" color="subdued">
                    <strong>Filter by status</strong>
                  </EuiText>
                  <EuiSpacer size="s" />
                  {STATUS_FILTERS.map((s) => (
                    <div key={s.id} style={{ marginBottom: 8 }}>
                      <EuiSwitch
                        compressed
                        label={s.label}
                        checked={!!statusOn[s.id]}
                        onChange={(e) =>
                          setStatusOn((prev) => ({ ...prev, [s.id]: e.target.checked }))
                        }
                      />
                    </div>
                  ))}
                </div>
              </EuiPopover>
            </EuiFlexItem>
          </EuiFlexGroup>
        </EuiFlexItem>
      </EuiFlexGroup>

      <EuiSpacer size="m" />

      {/* The case grid — three across on wide viewports, filling the width. */}
      {loading && cases.length === 0 ? (
        <EuiFlexGroup justifyContent="center" alignItems="center" style={{ minHeight: 180 }}>
          <EuiFlexItem grow={false}>
            <EuiLoadingSpinner size="xl" />
          </EuiFlexItem>
        </EuiFlexGroup>
      ) : visibleCases.length === 0 ? (
        <EuiPanel color="subdued" hasShadow={false} paddingSize="l">
          <EuiText size="s" color="subdued" textAlign="center">
            <p>
              {cases.length === 0
                ? 'No cases yet. Investigate an entity above to open one.'
                : 'No cases match the current filters.'}
            </p>
          </EuiText>
        </EuiPanel>
      ) : (
        <EuiFlexGrid columns={3} gutterSize="m">
          {visibleCases.map((c) => (
            <EuiFlexItem key={c.case_id || JSON.stringify(c.entity)}>
              <CaseGridCard
                theCase={c}
                selected={!!c.case_id && c.case_id === selectedCaseId}
                onOpen={() => {
                  if (c.case_id) {
                    onSelectCase(c.case_id);
                  }
                }}
              />
            </EuiFlexItem>
          ))}
        </EuiFlexGrid>
      )}

      <EuiSpacer size="xl" />

      {/* Detail panel: the selected case (+ follow-up chat), else a prompt. */}
      {selectedCaseId ? (
        <>
          <CaseDetail
            api={api}
            caseId={selectedCaseId}
            openInDiscover={openInDiscover}
            onBack={() => onSelectCase(null)}
            onCaseUpdated={(updated) => {
              // Keep the cases grid in sync with the latest stored case.
              setCases((prev) => prev.map((c) => (c.case_id === updated.case_id ? updated : c)));
            }}
          />
          <EuiSpacer size="m" />
          <EuiPanel hasBorder>
            <EuiTitle size="xs">
              <h3>Follow-up on this case</h3>
            </EuiTitle>
            <EuiSpacer size="s" />
            <Chat
              api={api}
              openInDiscover={openInDiscover}
              caseId={selectedCaseId}
              placeholder="Ask a follow-up about this case..."
            />
          </EuiPanel>
        </>
      ) : (
        <div
          style={{
            border: '2px dashed #d3dae6',
            borderRadius: 10,
            minHeight: 280,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 14,
          }}
        >
          <EuiIcon type="search" size="xxl" color="subdued" />
          <EuiText color="subdued">
            <span>Select a case to begin Agentic Triage</span>
          </EuiText>
        </div>
      )}
    </div>
  );
};
