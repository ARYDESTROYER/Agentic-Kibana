/**
 * Investigate — start an ad-hoc investigation of an entity.
 *
 * Submits POST /api/investigate ({ entity, group_by, source_surface, lookback })
 * and renders the returned Case as a rich verdict card: badge row, recommended
 * action, evidence, MITRE techniques, the reproduce query, and the risk
 * breakdown. A 400 "no events" response is rendered as a neutral empty state
 * (not a scary error) with a hint to widen the lookback. Each completed run is
 * kept in a small per-session history.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EuiBadge,
  EuiButton,
  EuiButtonGroup,
  EuiCallOut,
  EuiCopy,
  EuiDescriptionList,
  EuiFieldText,
  EuiFlexGroup,
  EuiFlexItem,
  EuiHorizontalRule,
  EuiIcon,
  EuiPanel,
  EuiSelect,
  EuiSpacer,
  EuiText,
  EuiTitle,
  EuiToolTip,
} from '@elastic/eui';
import type { Case, Entity, Evidence } from '../../lib/types';
import { api, ApiError } from '../../lib/api';
import {
  Card,
  ConfidenceBadge,
  EmptyState,
  ErrorCallout,
  IconChip,
  Loading,
  PageHeader,
  RiskBadge,
  StatusBadge,
  VerdictBadge,
} from '../common/ui';
import { BarList } from '../common/charts';
import type { Segment } from '../common/charts';
import { CaseDetailFlyout } from '../Cases/CaseDetailFlyout';
import { COLORS, riskBand, riskHex } from '../../lib/theme';
import { DASH, fmtMoney, humanizeAge, humanizeToken } from '../../lib/format';

/** sessionStorage key for the in-session investigation history. */
const RECENT_KEY = 'tlsoc.investigate.recent';
const RECENT_CAP = 6;

/* ---------------------------------------------------------------- types ---- */

type EntityType = Entity['type'];

interface LookbackOption {
  value: string;
  label: string;
}

const ENTITY_OPTIONS: Array<{ id: EntityType; label: string; placeholder: string; icon: string }> = [
  { id: 'ip', label: 'IP', placeholder: 'e.g. 10.0.0.5', icon: 'globe' },
  { id: 'user', label: 'User', placeholder: 'e.g. jdoe', icon: 'user' },
  { id: 'host', label: 'Host', placeholder: 'e.g. web-prod-01', icon: 'desktop' },
];

const LOOKBACK_OPTIONS: LookbackOption[] = [
  { value: 'now-24h', label: 'Last 24 hours' },
  { value: 'now-7d', label: 'Last 7 days' },
  { value: 'now-30d', label: 'Last 30 days' },
];

/** A finished run in the session history. */
interface RunRecord {
  id: string;
  entity: Entity;
  lookback: string;
  case: Case;
}

/* --------------------------------------------------- risk-breakdown view --- */

/** Round a factor to at most two decimals for the bar-list value label. */
function roundFactor(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Pull a numeric risk-factor map off the case (if the backend included one) and
 *  shape it as ranked chart `Segment`s for the shared `BarList`. */
function riskFactors(c: Case): Segment[] {
  const candidates = [c.risk_factors, c.risk_breakdown, c.risk_components];
  for (const raw of candidates) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const out: Segment[] = [];
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        const n = typeof v === 'number' ? v : Number(v);
        if (!Number.isNaN(n)) {
          out.push({ label: humanizeToken(k), value: n, color: COLORS.primary });
        }
      }
      if (out.length) {
        return out.sort((a, b) => b.value - a.value);
      }
    }
  }
  return [];
}

/* ------------------------------------------------------------ result view -- */

const MonoBlock: React.FC<{ text: string }> = ({ text }) => (
  <EuiFlexGroup gutterSize="xs" alignItems="flexStart" responsive={false}>
    <EuiFlexItem>
      <span
        className="socMono"
        style={{ display: 'block', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
      >
        {text}
      </span>
    </EuiFlexItem>
    <EuiFlexItem grow={false}>
      <EuiCopy textToCopy={text}>
        {(copy) => (
          <EuiButton size="s" iconType="copyClipboard" onClick={copy} color="text">
            Copy
          </EuiButton>
        )}
      </EuiCopy>
    </EuiFlexItem>
  </EuiFlexGroup>
);

const ResultCard: React.FC<{ c: Case; onOpen?: (caseId: string) => void }> = ({ c, onOpen }) => {
  const entityLabel = c.entity ? `${humanizeToken(c.entity.type)} · ${c.entity.value}` : DASH;
  const band = riskBand(c.risk_score);
  const evidence: Evidence[] = Array.isArray(c.evidence) ? c.evidence : [];
  const mitre: string[] = Array.isArray(c.mitre) ? c.mitre : [];
  const factors = riskFactors(c);

  return (
    <Card
      icon="inspect"
      accent={riskHex(c.risk_score)}
      accentLeft={riskHex(c.risk_score)}
      title={c.title || `Investigation: ${entityLabel}`}
      actions={
        <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false}>
          <EuiFlexItem grow={false}>
            <EuiText size="xs" color="subdued">
              <span>{humanizeAge(c.updated_at || c.created_at)}</span>
            </EuiText>
          </EuiFlexItem>
          {onOpen && c.case_id ? (
            <EuiFlexItem grow={false}>
              <EuiButton size="s" iconType="inspect" onClick={() => onOpen(c.case_id)}>
                Open case
              </EuiButton>
            </EuiFlexItem>
          ) : null}
        </EuiFlexGroup>
      }
    >
      {/* Badge row */}
      <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false} wrap>
        <EuiFlexItem grow={false}>
          <VerdictBadge verdict={c.verdict} />
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <RiskBadge score={c.risk_score} />
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <ConfidenceBadge confidence={c.confidence} />
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <StatusBadge status={c.status} />
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiBadge color="hollow">{band.label} risk</EuiBadge>
        </EuiFlexItem>
      </EuiFlexGroup>

      <EuiSpacer size="m" />

      {/* Summary / recommended action */}
      {c.summary ? (
        <EuiText size="s">
          <p style={{ whiteSpace: 'pre-wrap' }}>{c.summary}</p>
        </EuiText>
      ) : null}

      {c.recommended_action ? (
        <>
          <EuiSpacer size="s" />
          <EuiCallOut
            size="s"
            color={band.color === COLORS.danger ? 'danger' : 'primary'}
            iconType="namespace"
            title="Recommended action"
          >
            <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{c.recommended_action}</p>
          </EuiCallOut>
        </>
      ) : null}

      {/* Evidence */}
      {evidence.length ? (
        <>
          <EuiSpacer size="m" />
          <EuiTitle size="xxs">
            <h4>Evidence</h4>
          </EuiTitle>
          <EuiSpacer size="xs" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {evidence.map((ev, i) => (
              <Card key={i} variant="flat" paddingSize="m">
                <EuiFlexGroup gutterSize="s" alignItems="flexStart" responsive={false}>
                  <EuiFlexItem grow={false}>
                    <EuiIcon type="dot" color={COLORS.primary} />
                  </EuiFlexItem>
                  <EuiFlexItem>
                    <EuiText size="s">
                      <span>{ev.summary}</span>
                    </EuiText>
                    {ev.event_ids && ev.event_ids.length ? (
                      <EuiText size="xs" color="subdued">
                        <span>
                          {ev.event_ids.length} event{ev.event_ids.length === 1 ? '' : 's'}
                        </span>
                      </EuiText>
                    ) : null}
                  </EuiFlexItem>
                </EuiFlexGroup>
              </Card>
            ))}
          </div>
        </>
      ) : null}

      {/* MITRE */}
      {mitre.length ? (
        <>
          <EuiSpacer size="m" />
          <EuiTitle size="xxs">
            <h4>MITRE ATT&amp;CK</h4>
          </EuiTitle>
          <EuiSpacer size="xs" />
          <EuiFlexGroup gutterSize="xs" wrap responsive={false}>
            {mitre.map((m) => (
              <EuiFlexItem grow={false} key={m}>
                <EuiBadge color={COLORS.accent} iconType="branch">
                  {m}
                </EuiBadge>
              </EuiFlexItem>
            ))}
          </EuiFlexGroup>
        </>
      ) : null}

      {/* Risk breakdown */}
      {factors.length ? (
        <>
          <EuiSpacer size="m" />
          <EuiTitle size="xxs">
            <h4>Risk breakdown</h4>
          </EuiTitle>
          <EuiSpacer size="xs" />
          <BarList items={factors} format={(n) => String(roundFactor(n))} />
        </>
      ) : null}

      {/* Reproduce query */}
      {c.reproduce_query ? (
        <>
          <EuiSpacer size="m" />
          <EuiTitle size="xxs">
            <h4>Reproduce query</h4>
          </EuiTitle>
          <EuiSpacer size="xs" />
          <MonoBlock text={c.reproduce_query} />
        </>
      ) : null}

      <EuiHorizontalRule margin="m" />

      <EuiDescriptionList
        compressed
        type="column"
        textStyle="reverse"
        listItems={[
          { title: 'Case ID', description: c.case_id },
          { title: 'Entity', description: entityLabel },
          ...(c.rule_ids && c.rule_ids.length
            ? [{ title: 'Rules', description: c.rule_ids.join(', ') }]
            : []),
          {
            title: 'Members',
            description: String(c.member_event_ids?.length ?? 0) + ' events',
          },
          { title: 'Token cost', description: fmtMoney(c.token_cost) },
        ]}
      />

      <EuiSpacer size="s" />
      <EuiText size="xs" color="subdued">
        <EuiIcon type="save" size="s" style={{ marginRight: 4 }} />
        <span>Saved to the case queue — review it on the Cases tab.</span>
      </EuiText>
    </Card>
  );
};

/* ---------------------------------------------------------------- page ----- */

export const InvestigatePage: React.FC = () => {
  const [entityType, setEntityType] = useState<EntityType>('ip');
  const [entityValue, setEntityValue] = useState('');
  const [lookback, setLookback] = useState<string>('now-24h');

  const [result, setResult] = useState<Case | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [noEvents, setNoEvents] = useState<{ entity: Entity; lookback: string } | null>(null);
  const [runningEntity, setRunningEntity] = useState<Entity | null>(null);
  // Hydrate the in-session history from sessionStorage so it survives a soft
  // navigation away and back within the same tab (qu17).
  const [recent, setRecent] = useState<RunRecord[]>(() => {
    try {
      const raw = sessionStorage.getItem(RECENT_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return Array.isArray(parsed) ? (parsed as RunRecord[]).slice(0, RECENT_CAP) : [];
    } catch {
      return [];
    }
  });
  // Empty-submit feedback flag (qu30) + the case opened in the flyout (qu16).
  const [emptySubmit, setEmptySubmit] = useState(false);
  const [openCaseId, setOpenCaseId] = useState<string | null>(null);

  // Persist the history whenever it changes (best-effort; quota-safe).
  useEffect(() => {
    try {
      sessionStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, RECENT_CAP)));
    } catch {
      /* private mode / quota — history is non-essential. */
    }
  }, [recent]);

  // Seed the lookback from prefs.investigate_lookback once (best-effort, qu30).
  useEffect(() => {
    let cancelled = false;
    void api
      .getSettings()
      .then((s) => {
        if (cancelled) return;
        const lb = s?.prefs?.investigate_lookback;
        if (typeof lb === 'string' && LOOKBACK_OPTIONS.some((o) => o.value === lb)) {
          setLookback(lb);
        }
      })
      .catch(() => {
        /* advisory seed; keep the default lookback. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = useMemo(
    () => ENTITY_OPTIONS.find((o) => o.id === entityType) ?? ENTITY_OPTIONS[0],
    [entityType],
  );

  const lookbackLabel = useMemo(
    () => LOOKBACK_OPTIONS.find((o) => o.value === lookback)?.label ?? lookback,
    [lookback],
  );

  const run = useCallback(async () => {
    const value = entityValue.trim();
    if (!value) {
      setEmptySubmit(true);
      return;
    }
    if (loading) {
      return;
    }
    setEmptySubmit(false);
    const entity: Entity = { type: entityType, value };
    setLoading(true);
    setError(null);
    setResult(null);
    setNoEvents(null);
    setRunningEntity(entity);

    try {
      const c = await api.investigate({
        entity,
        group_by: entityType,
        source_surface: 'investigate',
        lookback,
      });
      setResult(c);
      setRecent((prev) =>
        [{ id: `${Date.now()}`, entity, lookback, case: c }, ...prev].slice(0, 6),
      );
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) {
        // Neutral "no in-scope events" outcome, not a failure.
        setNoEvents({ entity, lookback });
      } else {
        setError(e);
      }
    } finally {
      setLoading(false);
      setRunningEntity(null);
    }
  }, [entityType, entityValue, lookback, loading]);

  const widenLookback = useCallback(() => {
    const idx = LOOKBACK_OPTIONS.findIndex((o) => o.value === lookback);
    const next = LOOKBACK_OPTIONS[Math.min(idx + 1, LOOKBACK_OPTIONS.length - 1)];
    setLookback(next.value);
    setNoEvents(null);
  }, [lookback]);

  const replayRecent = useCallback((r: RunRecord) => {
    setEntityType(r.entity.type);
    setEntityValue(r.entity.value);
    setLookback(r.lookback);
    setResult(r.case);
    setNoEvents(null);
    setError(null);
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      void run();
    }
  };

  return (
    <div className="socPageEnter">
      <PageHeader
        icon="inspect"
        eyebrow="Ad-hoc triage"
        title="Investigate"
        description="Run an ad-hoc, agentic investigation on an IP, user, or host."
      />

      {/* Form */}
      <Card>
        <EuiFlexGroup gutterSize="m" alignItems="flexEnd" responsive wrap>
          <EuiFlexItem grow={false}>
            <EuiText size="xs" color="subdued" style={{ marginBottom: 4 }}>
              <span>Entity type</span>
            </EuiText>
            <EuiButtonGroup
              legend="Entity type"
              idSelected={entityType}
              onChange={(id) => setEntityType(id as EntityType)}
              options={ENTITY_OPTIONS.map((o) => ({ id: o.id, label: o.label, iconType: o.icon }))}
              buttonSize="m"
            />
          </EuiFlexItem>
          <EuiFlexItem style={{ minWidth: 220 }}>
            <EuiText size="xs" color="subdued" style={{ marginBottom: 4 }}>
              <span>{selected.label} value</span>
            </EuiText>
            <EuiFieldText
              placeholder={selected.placeholder}
              value={entityValue}
              onChange={(e) => {
                setEntityValue(e.target.value);
                if (emptySubmit && e.target.value.trim()) setEmptySubmit(false);
              }}
              onKeyDown={onKeyDown}
              icon={selected.icon}
              fullWidth
              isInvalid={emptySubmit}
              aria-label={`${selected.label} to investigate`}
            />
            {emptySubmit ? (
              <EuiText size="xs" color="danger" style={{ marginTop: 4 }}>
                <span>Enter a {selected.label.toLowerCase()} value to investigate.</span>
              </EuiText>
            ) : null}
          </EuiFlexItem>
          <EuiFlexItem grow={false} style={{ minWidth: 180 }}>
            <EuiText size="xs" color="subdued" style={{ marginBottom: 4 }}>
              <span>Lookback</span>
            </EuiText>
            <EuiSelect
              options={LOOKBACK_OPTIONS.map((o) => ({ value: o.value, text: o.label }))}
              value={lookback}
              onChange={(e) => setLookback(e.target.value)}
              aria-label="Lookback window"
            />
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiToolTip content="Correlate events, enrich, and reason about this entity">
              <EuiButton
                fill
                iconType="play"
                onClick={() => void run()}
                isLoading={loading}
                isDisabled={!entityValue.trim() && !loading}
              >
                Run investigation
              </EuiButton>
            </EuiToolTip>
          </EuiFlexItem>
        </EuiFlexGroup>
      </Card>

      <EuiSpacer size="l" />

      {/* Loading */}
      {loading ? (
        <Card>
          <Loading
            label={`Investigating ${runningEntity?.value ?? selected.label}… correlating events, enriching, reasoning`}
          />
        </Card>
      ) : null}

      {/* Hard error */}
      {!loading && error ? (
        <ErrorCallout error={error} title="Investigation failed" />
      ) : null}

      {/* Neutral no-events empty state */}
      {!loading && noEvents ? (
        <EmptyState
          iconType="search"
          title={`No in-scope events for ${noEvents.entity.type}:${noEvents.entity.value}`}
          body={`Nothing matched in ${LOOKBACK_OPTIONS.find((o) => o.value === noEvents.lookback)?.label ?? noEvents.lookback}. The activity may be older, or outside the configured scope. Try widening the lookback window.`}
          actions={
            lookback !== LOOKBACK_OPTIONS[LOOKBACK_OPTIONS.length - 1].value ? (
              <EuiButton iconType="timeRefresh" onClick={widenLookback}>
                Widen lookback
              </EuiButton>
            ) : undefined
          }
        />
      ) : null}

      {/* Result */}
      {!loading && result ? <ResultCard c={result} onOpen={setOpenCaseId} /> : null}

      {/* Idle empty state */}
      {!loading && !result && !error && !noEvents ? (
        <EmptyState
          iconType="inspect"
          title="Investigate an entity"
          body={`Pick an entity type, enter a value (e.g. ${selected.placeholder.replace('e.g. ', '')}), and run an investigation over ${lookbackLabel.toLowerCase()}.`}
        />
      ) : null}

      {/* Recent (this session) */}
      {recent.length ? (
        <>
          <EuiSpacer size="xl" />
          <EuiTitle size="xs">
            <h3>Recent investigations (this session)</h3>
          </EuiTitle>
          <EuiSpacer size="s" />
          <EuiFlexGroup direction="column" gutterSize="s">
            {recent.map((r) => (
              <EuiFlexItem key={r.id}>
                <EuiPanel
                  hasBorder
                  paddingSize="s"
                  className="socCard socCard--clickable"
                  onClick={() => replayRecent(r)}
                >
                  <EuiFlexGroup gutterSize="m" alignItems="center" responsive={false}>
                    <EuiFlexItem grow={false}>
                      <IconChip
                        icon={ENTITY_OPTIONS.find((o) => o.id === r.entity.type)?.icon ?? 'inspect'}
                        accent={riskHex(r.case.risk_score)}
                      />
                    </EuiFlexItem>
                    <EuiFlexItem>
                      <EuiText size="s">
                        <strong>
                          {r.entity.type}:{r.entity.value}
                        </strong>
                      </EuiText>
                      <EuiText size="xs" color="subdued">
                        <span>
                          {r.case.title || r.case.case_id} ·{' '}
                          {LOOKBACK_OPTIONS.find((o) => o.value === r.lookback)?.label ?? r.lookback}
                        </span>
                      </EuiText>
                    </EuiFlexItem>
                    <EuiFlexItem grow={false}>
                      <VerdictBadge verdict={r.case.verdict} />
                    </EuiFlexItem>
                    <EuiFlexItem grow={false}>
                      <RiskBadge score={r.case.risk_score} />
                    </EuiFlexItem>
                    {r.case.case_id ? (
                      <EuiFlexItem grow={false}>
                        <EuiButton
                          size="s"
                          color="text"
                          iconType="inspect"
                          onClick={(e: React.MouseEvent) => {
                            e.stopPropagation();
                            setOpenCaseId(r.case.case_id);
                          }}
                          aria-label={`Open case ${r.case.case_id}`}
                        >
                          Open case
                        </EuiButton>
                      </EuiFlexItem>
                    ) : null}
                  </EuiFlexGroup>
                </EuiPanel>
              </EuiFlexItem>
            ))}
          </EuiFlexGroup>
        </>
      ) : null}

      {/* Case detail flyout — opened from the result card or a recent row (qu16). */}
      {openCaseId ? (
        <CaseDetailFlyout caseId={openCaseId} onClose={() => setOpenCaseId(null)} />
      ) : null}
    </div>
  );
};
