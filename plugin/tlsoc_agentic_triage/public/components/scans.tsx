import React, { useEffect, useMemo, useState } from 'react';
import {
  EuiBadge,
  EuiButton,
  EuiButtonEmpty,
  EuiButtonIcon,
  EuiCallOut,
  EuiFlexGrid,
  EuiFlexGroup,
  EuiFlexItem,
  EuiHorizontalRule,
  EuiIcon,
  EuiLoadingSpinner,
  EuiPanel,
  EuiSpacer,
  EuiText,
  EuiToolTip,
} from '@elastic/eui';
import type { Case } from '../../common';
import type { TlsocApi } from '../lib/api';
import type { OpenInDiscover } from '../lib/discover';
import { DASH, formatTimestamp, humanizeAge } from '../lib/format';
import {
  COLORS,
  ConfidenceBadge,
  EmptyState,
  RiskBadge,
  SectionHeader,
  StatTile,
  StatusBadge,
  statusHex,
  tint,
  verdictHex,
  VerdictBadge,
} from './ui';
import { TriggerReasonCallout } from './trigger_reason_callout';

interface ScansProps {
  api: TlsocApi;
  openInDiscover: OpenInDiscover;
  /** Open the stored case (GET by id) in the Investigate detail view. */
  onOpenCase?: (caseId: string) => void;
}

/** Small EUI icon that hints at the entity kind (ip / user / host). */
function entityIcon(type?: string): string {
  switch ((type || '').toLowerCase()) {
    case 'user':
      return 'user';
    case 'host':
      return 'desktop';
    case 'ip':
      return 'globe';
    default:
      return 'dot';
  }
}

export const Scans: React.FC<ScansProps> = ({ api, openInDiscover, onOpenCase }) => {
  const [cases, setCases] = useState<Case[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Feature 3: per-card toggle to reveal the "why this fired" explanation. Keyed
  // by case_id; a present key means that card's callout is expanded.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const toggleExpand = (id?: string) => {
    if (!id) {
      return;
    }
    setExpanded((prev) => {
      const next = { ...prev };
      if (next[id]) {
        delete next[id];
      } else {
        next[id] = true;
      }
      return next;
    });
  };

  const loadScans = async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await api.get<{ cases: Case[]; total: number }>('scans', { limit: 100 });
      setCases(resp.cases || []);
      setExpanded({});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadScans();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // KPI roll-up over the loaded cases. Cheap to recompute; memoised so cards
  // don't churn the tiles on every render.
  const stats = useMemo(() => {
    let open = 0;
    let closed = 0;
    let needsHuman = 0;
    let truePositive = 0;
    for (const c of cases) {
      const status = (c.status || '').toLowerCase();
      if (status === 'open') open += 1;
      else if (status === 'closed') closed += 1;
      if (status === 'needs_human') needsHuman += 1;
      if ((c.verdict || '').toUpperCase().includes('TRUE')) truePositive += 1;
    }
    return { total: cases.length, open, closed, needsHuman, truePositive };
  }, [cases]);

  const refreshButton = (
    <EuiButton size="s" iconType="refresh" onClick={loadScans} isLoading={loading}>
      Refresh
    </EuiButton>
  );

  return (
    <div>
      <SectionHeader
        icon="inspect"
        title="Automated Scans"
        description="Cases the agent opened automatically from background correlation. Open one to review at no LLM cost."
        actions={refreshButton}
      />

      {error ? (
        <>
          <EuiCallOut color="danger" size="s" title={error} />
          <EuiSpacer size="m" />
        </>
      ) : null}

      {/* KPI strip — a calm at-a-glance summary of the scan backlog. */}
      <EuiFlexGroup gutterSize="m" responsive wrap>
        <EuiFlexItem>
          <StatTile label="Total scans" value={stats.total} icon="inspect" accent={COLORS.primary} />
        </EuiFlexItem>
        <EuiFlexItem>
          <StatTile label="Open" value={stats.open} icon="folderOpen" accent={COLORS.primary} />
        </EuiFlexItem>
        <EuiFlexItem>
          <StatTile
            label="Needs human"
            value={stats.needsHuman}
            icon="user"
            accent={COLORS.warning}
          />
        </EuiFlexItem>
        <EuiFlexItem>
          <StatTile
            label="True positives"
            value={stats.truePositive}
            icon="alert"
            accent={COLORS.danger}
            sub={`${stats.closed} closed`}
          />
        </EuiFlexItem>
      </EuiFlexGroup>

      <EuiSpacer size="l" />

      {/* Loading: a centred spinner before the first paint of cards. */}
      {loading && cases.length === 0 ? (
        <EuiFlexGroup justifyContent="center" alignItems="center" style={{ minHeight: 160 }}>
          <EuiFlexItem grow={false}>
            <EuiLoadingSpinner size="xl" />
          </EuiFlexItem>
        </EuiFlexGroup>
      ) : cases.length === 0 ? (
        <EmptyState
          iconType="inspect"
          title="No automated scans yet"
          body="When background scanning is enabled, the agent opens cases here automatically."
        />
      ) : (
        // Responsive card grid. Two columns on wide viewports, collapsing to one
        // on narrow ones; each card is self-contained and scannable.
        <EuiFlexGrid columns={2} gutterSize="m">
          {cases.map((item) => {
            const id = item.case_id;
            const isOpen = !!id && !!expanded[id];
            const entity = item.entity;
            const rules = item.rule_ids || [];
            // Left-accent encodes the verdict when known, else the lifecycle status.
            const accent = item.verdict ? verdictHex(item.verdict) : statusHex(item.status);
            const canReproduce = !!item.reproduce_query;
            const canWhy = !!item.trigger_reason;

            const openThisCase = () => {
              if (onOpenCase && id) {
                onOpenCase(id);
              }
            };

            return (
              <EuiFlexItem key={id || JSON.stringify(item.entity)}>
                <EuiPanel
                  hasBorder
                  paddingSize="m"
                  className="tlsocCard"
                  style={{ borderLeft: `4px solid ${accent}`, height: '100%' }}
                >
                  {/* Header row: entity identity + the at-a-glance risk badge. The
                      identity area opens the stored case (no LLM cost); footer
                      buttons below are separate, accessible actions. */}
                  <EuiFlexGroup
                    gutterSize="s"
                    alignItems="center"
                    responsive={false}
                    justifyContent="spaceBetween"
                    onClick={onOpenCase && id ? openThisCase : undefined}
                    style={onOpenCase && id ? { cursor: 'pointer' } : undefined}
                  >
                    <EuiFlexItem grow={false}>
                      <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false}>
                        <EuiFlexItem grow={false}>
                          <span
                            className="tlsocIconChip"
                            style={{ background: tint(accent, 0.14), color: accent }}
                          >
                            <EuiIcon type={entityIcon(entity?.type)} size="m" />
                          </span>
                        </EuiFlexItem>
                        <EuiFlexItem grow={false}>
                          <EuiText size="s">
                            <strong>{entity ? entity.value : DASH}</strong>
                          </EuiText>
                          {entity ? (
                            <EuiText size="xs" color="subdued">
                              <span>{entity.type}</span>
                            </EuiText>
                          ) : null}
                        </EuiFlexItem>
                      </EuiFlexGroup>
                    </EuiFlexItem>
                    <EuiFlexItem grow={false}>
                      <RiskBadge score={item.risk_score} />
                    </EuiFlexItem>
                  </EuiFlexGroup>

                  <EuiSpacer size="s" />

                  {/* Verdict / status / confidence badges. */}
                  <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false} wrap>
                    <EuiFlexItem grow={false}>
                      <VerdictBadge verdict={item.verdict} />
                    </EuiFlexItem>
                    <EuiFlexItem grow={false}>
                      <StatusBadge status={item.status} />
                    </EuiFlexItem>
                    {typeof item.confidence === 'number' ? (
                      <EuiFlexItem grow={false}>
                        <ConfidenceBadge confidence={item.confidence} />
                      </EuiFlexItem>
                    ) : null}
                  </EuiFlexGroup>

                  {/* Rule ids — subdued; the detection(s) behind the case. */}
                  {rules.length ? (
                    <>
                      <EuiSpacer size="s" />
                      <EuiFlexGroup gutterSize="xs" responsive={false} wrap>
                        {rules.map((r) => (
                          <EuiFlexItem grow={false} key={r}>
                            <EuiBadge color="hollow">{r}</EuiBadge>
                          </EuiFlexItem>
                        ))}
                      </EuiFlexGroup>
                    </>
                  ) : null}

                  <EuiSpacer size="s" />

                  {/* Created timestamp + relative age. */}
                  <EuiFlexGroup gutterSize="xs" alignItems="center" responsive={false}>
                    <EuiFlexItem grow={false}>
                      <EuiIcon type="clock" size="s" color="subdued" />
                    </EuiFlexItem>
                    <EuiFlexItem grow={false}>
                      <EuiText size="xs" color="subdued">
                        <span>
                          {formatTimestamp(item.created_at)} · {humanizeAge(item.created_at)}
                        </span>
                      </EuiText>
                    </EuiFlexItem>
                  </EuiFlexGroup>

                  <EuiHorizontalRule margin="s" />

                  {/* Footer actions — separate, explicit, keyboard-accessible
                      controls (the card's identity area handles "open"). */}
                  <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false} wrap>
                    {onOpenCase && id ? (
                      <EuiFlexItem grow={false}>
                        <EuiButtonEmpty size="xs" iconType="eye" onClick={() => onOpenCase(id)}>
                          Open
                        </EuiButtonEmpty>
                      </EuiFlexItem>
                    ) : null}
                    {canReproduce ? (
                      <EuiFlexItem grow={false}>
                        <EuiButtonEmpty
                          size="xs"
                          iconType="discoverApp"
                          onClick={() => {
                            if (item.reproduce_query) {
                              openInDiscover(item.reproduce_query);
                            }
                          }}
                        >
                          Reproduce
                        </EuiButtonEmpty>
                      </EuiFlexItem>
                    ) : null}
                    {canWhy ? (
                      <EuiFlexItem grow={false}>
                        <EuiToolTip content="Why this case fired">
                          <EuiButtonIcon
                            size="xs"
                            color="primary"
                            iconType={isOpen ? 'arrowUp' : 'iInCircle'}
                            aria-label={isOpen ? 'Collapse why this fired' : 'Why this fired'}
                            onClick={() => toggleExpand(id)}
                          />
                        </EuiToolTip>
                      </EuiFlexItem>
                    ) : null}
                  </EuiFlexGroup>

                  {/* Feature 3: inline "why this fired" callout, expanded in place. */}
                  {isOpen ? (
                    <>
                      <EuiSpacer size="s" />
                      <TriggerReasonCallout triggerReason={item.trigger_reason} />
                    </>
                  ) : null}
                </EuiPanel>
              </EuiFlexItem>
            );
          })}
        </EuiFlexGrid>
      )}
    </div>
  );
};
