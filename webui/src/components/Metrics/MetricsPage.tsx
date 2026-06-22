/**
 * Metrics — the triage analytics dashboard. Reads GET /api/metrics and turns it
 * into KPI tiles, a verdict donut, persona/playbook bar lists, a cases-per-day
 * trend, an analyst-feedback quality panel, and a compact cost summary.
 *
 * Built ENTIRELY from the shared primitives (charts.tsx + ui.tsx + format.ts) so
 * it stays consistent with the rest of the console and ships with no new deps.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EuiButton,
  EuiButtonGroup,
  EuiFlexGroup,
  EuiFlexItem,
  EuiSpacer,
  EuiText,
} from '@elastic/eui';
import type { Metrics, MemoryResponse, RagStats } from '../../lib/types';
import { api } from '../../lib/api';
import { COLORS, chartColor, verdictHex } from '../../lib/theme';
import {
  DASH,
  fmtMoney,
  fmtNumber,
  fmtPercent,
  fmtTokens,
  humanizeToken,
} from '../../lib/format';
import { BarList, DonutWithLegend, MiniBars } from '../common/charts';
import type { Segment } from '../common/charts';
import {
  Card,
  EmptyState,
  ErrorCallout,
  PageHeader,
  SectionHeader,
  Skeleton,
  StatTile,
} from '../common/ui';

const WINDOWS = [
  { id: '24', label: '24h', hours: 24 },
  { id: '168', label: '7d', hours: 168 },
  { id: '720', label: '30d', hours: 720 },
] as const;

/** Humanize a minutes value to a compact "Xh Ym" / "Xm" / "Xd" string. */
function humanizeMinutes(mins?: number): string {
  if (typeof mins !== 'number' || Number.isNaN(mins) || mins <= 0) return DASH;
  const m = Math.round(mins);
  if (m < 60) return `${m}m`;
  const hours = Math.floor(m / 60);
  const rem = m % 60;
  if (hours < 24) return rem ? `${hours}h ${rem}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return remH ? `${days}d ${remH}h` : `${days}d`;
}

/** Turn a {label→count} record into ranked, palette-coloured chart segments. */
function recordSegments(rec: Record<string, number> | undefined): Segment[] {
  if (!rec) return [];
  return Object.entries(rec)
    .filter(([, v]) => typeof v === 'number' && v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v], i) => ({ label: humanizeToken(k) ?? k, value: v, color: chartColor(i) }));
}

const MetricsSkeleton: React.FC = () => (
  <>
    <EuiFlexGroup gutterSize="m" wrap>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <EuiFlexItem key={i} style={{ minWidth: 200 }}>
          <Skeleton height={92} radius={8} />
        </EuiFlexItem>
      ))}
    </EuiFlexGroup>
    <EuiSpacer size="l" />
    <div className="socGrid">
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} height={200} radius={8} />
      ))}
    </div>
  </>
);

export const MetricsPage: React.FC = () => {
  const [windowId, setWindowId] = useState<string>('168');
  const [data, setData] = useState<Metrics | null>(null);
  // Point-in-time knowledge-base + memory health (NOT windowed). Loaded
  // alongside the windowed metrics but kept non-fatal: a failure here leaves
  // these null and the rest of the page still renders.
  const [rag, setRag] = useState<RagStats | null>(null);
  const [memory, setMemory] = useState<MemoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const hours = useMemo(
    () => WINDOWS.find((w) => w.id === windowId)?.hours ?? 168,
    [windowId],
  );
  const windowLabel = useMemo(
    () => WINDOWS.find((w) => w.id === windowId)?.label ?? '7d',
    [windowId],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // The windowed metrics drive the page (a failure here surfaces the error
      // state). The RAG/memory calls are point-in-time extras: each is wrapped
      // so one failing never blanks the dashboard.
      const [m, ragStats, mem] = await Promise.all([
        api.getMetrics(hours),
        api.ragStats().catch(() => null),
        api.getMemory().catch(() => null),
      ]);
      setData(m);
      setRag(ragStats);
      setMemory(mem);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [hours]);

  useEffect(() => {
    void load();
  }, [load]);

  // ---- derived series ---------------------------------------------------- //
  const verdictSegments = useMemo<Segment[]>(() => {
    const bv = data?.by_verdict;
    if (!bv) return [];
    const entries: Array<[string, number]> = [
      ['TRUE_POSITIVE', bv.TRUE_POSITIVE ?? 0],
      ['FALSE_POSITIVE', bv.FALSE_POSITIVE ?? 0],
      ['NEEDS_HUMAN', bv.NEEDS_HUMAN ?? 0],
      ['none', bv.none ?? 0],
    ];
    return entries
      .filter(([, v]) => v > 0)
      .map(([k, v]) => ({
        label: k === 'none' ? 'Unverdicted' : humanizeToken(k) ?? k,
        value: v,
        color: k === 'none' ? COLORS.subdued : verdictHex(k),
      }));
  }, [data]);

  const personaSegments = useMemo(() => recordSegments(data?.persona_usage), [data]);
  const playbookSegments = useMemo(() => recordSegments(data?.playbook_usage), [data]);

  const perDay = useMemo(
    () =>
      Array.isArray(data?.cases_per_day)
        ? data!.cases_per_day.map((d) => (typeof d.count === 'number' ? d.count : 0))
        : [],
    [data],
  );

  const fb = data?.feedback;
  const cost = data?.cost;
  const currency = (cost?.currency as string | undefined) || undefined;

  const outcomeSegments = useMemo(
    () => recordSegments(fb?.outcome_distribution),
    [fb],
  );

  // ---- knowledge base & memory (point-in-time) -------------------------- //
  const corpusSegments = useMemo(
    () => recordSegments(rag?.by_source),
    [rag],
  );

  const memoryEntries = useMemo(() => memory?.entries ?? [], [memory]);
  const activeMemoryCount = useMemo(
    () => memoryEntries.filter((e) => e.active).length,
    [memoryEntries],
  );
  const memorySourceSegments = useMemo<Segment[]>(() => {
    let human = 0;
    let agent = 0;
    let other = 0;
    for (const e of memoryEntries) {
      if (e.source === 'human') human += 1;
      else if (e.source === 'agent') agent += 1;
      else other += 1;
    }
    return [
      { label: 'Human', value: human, color: COLORS.primary },
      { label: 'Agent', value: agent, color: COLORS.accent },
      { label: 'Other', value: other, color: COLORS.subdued },
    ].filter((s) => s.value > 0);
  }, [memoryEntries]);

  const hasKnowledge = rag !== null || memory !== null;
  const embeddingValue = rag?.embedding_model
    ? humanizeToken(rag.embedding_model)
    : DASH;

  const hasAny = (data?.total_cases ?? 0) > 0;

  const header = (
    <PageHeader
      eyebrow="Analytics"
      icon="stats"
      title="Metrics"
      description="Triage volume, verdict mix, agent routing, and analyst feedback quality."
      accent={COLORS.primary}
      actions={
        <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false}>
          <EuiFlexItem grow={false}>
            <EuiButtonGroup
              legend="Time window"
              buttonSize="s"
              options={WINDOWS.map((w) => ({ id: w.id, label: w.label }))}
              idSelected={windowId}
              onChange={(id) => setWindowId(id)}
            />
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiButton size="s" iconType="refresh" onClick={() => void load()} isLoading={loading}>
              Refresh
            </EuiButton>
          </EuiFlexItem>
        </EuiFlexGroup>
      }
    />
  );

  // Knowledge base & memory — point-in-time (NOT windowed). Rendered whether or
  // not cases exist, but only when at least one of the two calls succeeded.
  const knowledgeSection = hasKnowledge ? (
    <>
      <EuiSpacer size="l" />
      <SectionHeader
        icon="database"
        accent={COLORS.accent}
        title="Knowledge base & memory"
        description="RAG corpus and durable operator memory the agents draw on — current, independent of the time window above."
      />

      <EuiFlexGroup gutterSize="m" wrap>
        <EuiFlexItem style={{ minWidth: 200 }}>
          <StatTile
            label="RAG documents (current)"
            value={fmtNumber(rag?.document_count)}
            icon="documents"
            accent={COLORS.primary}
          />
        </EuiFlexItem>
        <EuiFlexItem style={{ minWidth: 200 }}>
          <StatTile
            label="RAG chunks (current)"
            value={fmtNumber(rag?.total_chunks)}
            icon="visText"
            accent={COLORS.accent}
          />
        </EuiFlexItem>
        <EuiFlexItem style={{ minWidth: 220 }}>
          <StatTile
            label="Embedding model"
            value={embeddingValue}
            icon="indexMapping"
            accent={COLORS.accent2}
            sub={typeof rag?.dim === 'number' ? `${fmtNumber(rag.dim)} dims` : undefined}
          />
        </EuiFlexItem>
        <EuiFlexItem style={{ minWidth: 200 }}>
          <StatTile
            label="Memory facts (current)"
            value={fmtNumber(memory?.count)}
            icon="bell"
            accent={COLORS.warning}
          />
        </EuiFlexItem>
        <EuiFlexItem style={{ minWidth: 200 }}>
          <StatTile
            label="Active memory"
            value={memory ? fmtNumber(activeMemoryCount) : DASH}
            icon="check"
            accent={COLORS.success}
            sub={memory ? `of ${fmtNumber(memory.count)}` : undefined}
          />
        </EuiFlexItem>
      </EuiFlexGroup>

      <EuiSpacer size="l" />

      <div className="socGrid">
        <Card title="Corpus by source" icon="logstashQueue" accent={COLORS.primary}>
          {corpusSegments.length ? (
            <BarList items={corpusSegments} format={(n) => fmtNumber(n)} />
          ) : (
            <EuiText size="s" color="subdued">
              <span>{rag ? 'No RAG corpus indexed yet.' : 'Corpus stats unavailable.'}</span>
            </EuiText>
          )}
        </Card>

        <Card title="Memory by author" icon="users" accent={COLORS.warning}>
          {memorySourceSegments.length ? (
            <DonutWithLegend
              segments={memorySourceSegments}
              centerValue={fmtNumber(memory?.count)}
              centerLabel="facts"
            />
          ) : (
            <EuiText size="s" color="subdued">
              <span>
                {memory ? 'No memory facts recorded yet.' : 'Memory stats unavailable.'}
              </span>
            </EuiText>
          )}
        </Card>
      </div>
    </>
  ) : null;

  return (
    <div className="socPageEnter">
      {header}

      {error ? (
        <>
          <ErrorCallout error={error} title="Could not load metrics" />
          <EuiSpacer size="m" />
        </>
      ) : null}

      {loading ? (
        <MetricsSkeleton />
      ) : !hasAny ? (
        <>
          <EmptyState
            iconType="stats"
            title="No cases yet"
            body={`Nothing has been triaged in the last ${windowLabel}. As the agent processes alerts, volume, verdicts and feedback analytics will appear here.`}
          />
          {knowledgeSection}
        </>
      ) : (
        <>
          {/* KPI row */}
          <EuiFlexGroup gutterSize="m" wrap>
            <EuiFlexItem style={{ minWidth: 200 }}>
              <StatTile
                label={`Total cases (${windowLabel})`}
                value={fmtNumber(data?.total_cases)}
                icon="securityApp"
                accent={COLORS.primary}
              />
            </EuiFlexItem>
            <EuiFlexItem style={{ minWidth: 200 }}>
              <StatTile
                label="Needs human"
                value={fmtNumber(data?.needs_human_cases)}
                icon="user"
                accent={COLORS.warning}
              />
            </EuiFlexItem>
            <EuiFlexItem style={{ minWidth: 200 }}>
              <StatTile
                label="Closed"
                value={fmtNumber(data?.closed_cases)}
                icon="checkInCircleFilled"
                accent={COLORS.success}
                sub={`${fmtNumber(data?.open_cases)} open`}
              />
            </EuiFlexItem>
            <EuiFlexItem style={{ minWidth: 200 }}>
              <StatTile
                label="MTTR"
                value={humanizeMinutes(data?.mttr_minutes)}
                icon="clock"
                accent={COLORS.accent}
                sub={`${fmtNumber(data?.resolved_count)} resolved`}
              />
            </EuiFlexItem>
            <EuiFlexItem style={{ minWidth: 200 }}>
              <StatTile
                label="Agreement rate"
                value={fb && fb.graded_cases > 0 ? fmtPercent(fb.agreement_rate) : DASH}
                icon="check"
                accent={COLORS.success}
                sub={fb ? `${fmtNumber(fb.graded_cases)} graded` : undefined}
              />
            </EuiFlexItem>
            <EuiFlexItem style={{ minWidth: 200 }}>
              <StatTile
                label="Avg risk"
                value={
                  typeof data?.avg_risk_score === 'number'
                    ? Math.round(data.avg_risk_score)
                    : DASH
                }
                icon="visGauge"
                accent={COLORS.danger}
              />
            </EuiFlexItem>
          </EuiFlexGroup>

          <EuiSpacer size="l" />

          {/* Charts grid */}
          <div className="socGrid">
            <Card title="Verdict mix" icon="visPie" accent={COLORS.primary}>
              {verdictSegments.length ? (
                <DonutWithLegend
                  segments={verdictSegments}
                  centerValue={fmtNumber(data?.total_cases)}
                  centerLabel="cases"
                />
              ) : (
                <EuiText size="s" color="subdued"><span>{DASH}</span></EuiText>
              )}
            </Card>

            <Card title="Persona usage" icon="users" accent={COLORS.accent}>
              {personaSegments.length ? (
                <BarList items={personaSegments} format={(n) => fmtNumber(n)} />
              ) : (
                <EuiText size="s" color="subdued">
                  <span>No specialist routing recorded.</span>
                </EuiText>
              )}
            </Card>

            <Card title="Playbook usage" icon="inspect" accent={COLORS.warning}>
              {playbookSegments.length ? (
                <BarList items={playbookSegments} format={(n) => fmtNumber(n)} />
              ) : (
                <EuiText size="s" color="subdued">
                  <span>No playbooks selected in this window.</span>
                </EuiText>
              )}
            </Card>

            <Card title="Cases per day" icon="visBarVertical" accent={COLORS.success}>
              {perDay.length > 1 ? (
                <>
                  <MiniBars values={perDay} color={COLORS.success} height={120} />
                  <EuiSpacer size="xs" />
                  <EuiText size="xs" color="subdued">
                    <span>{`${perDay.length} days · ${fmtNumber(
                      perDay.reduce((s, x) => s + x, 0),
                    )} cases`}</span>
                  </EuiText>
                </>
              ) : (
                <EuiText size="s" color="subdued">
                  <span>Not enough data points to chart a trend.</span>
                </EuiText>
              )}
            </Card>
          </div>

          <EuiSpacer size="l" />

          {/* Feedback quality + cost */}
          <EuiFlexGroup gutterSize="m" wrap alignItems="stretch">
            <EuiFlexItem style={{ minWidth: 320 }}>
              <Card title="Analyst feedback quality" icon="faceHappy" accent={COLORS.success}>
                {fb && fb.graded_cases > 0 ? (
                  <>
                    <EuiFlexGroup gutterSize="m" wrap responsive={false}>
                      <EuiFlexItem style={{ minWidth: 130 }}>
                        <StatTile
                          label="Agreement"
                          value={fmtPercent(fb.agreement_rate)}
                          accent={COLORS.success}
                        />
                      </EuiFlexItem>
                      <EuiFlexItem style={{ minWidth: 130 }}>
                        <StatTile
                          label="Time saved"
                          value={humanizeMinutes(fb.time_saved_minutes)}
                          accent={COLORS.primary}
                        />
                      </EuiFlexItem>
                    </EuiFlexGroup>
                    <EuiSpacer size="m" />
                    <BarList
                      items={[
                        { label: 'Accuracy', value: Math.round((fb.avg_accuracy || 0) * 100), color: COLORS.success },
                        {
                          label: 'Reasoning quality',
                          value: Math.round((fb.avg_reasoning_quality || 0) * 100),
                          color: COLORS.primary,
                        },
                        {
                          label: 'Action appropriateness',
                          value: Math.round((fb.avg_action_appropriateness || 0) * 100),
                          color: COLORS.accent,
                        },
                      ]}
                      max={100}
                      format={(n) => `${n}%`}
                    />
                    {outcomeSegments.length ? (
                      <>
                        <EuiSpacer size="m" />
                        <EuiText size="xs" color="subdued">
                          <span>Recorded outcomes</span>
                        </EuiText>
                        <EuiSpacer size="xs" />
                        <BarList items={outcomeSegments} format={(n) => fmtNumber(n)} />
                      </>
                    ) : null}
                  </>
                ) : (
                  <EuiText size="s" color="subdued">
                    <span>
                      No analyst feedback recorded yet. Grade closed cases to build accuracy,
                      reasoning and time-saved metrics here.
                    </span>
                  </EuiText>
                )}
              </Card>
            </EuiFlexItem>

            <EuiFlexItem style={{ minWidth: 320 }}>
              <Card title="LLM cost (window)" icon="visLine" accent={COLORS.warning}>
                <EuiFlexGroup gutterSize="m" wrap responsive={false}>
                  <EuiFlexItem style={{ minWidth: 130 }}>
                    <StatTile
                      label="Total cost"
                      value={fmtMoney(cost?.total_cost as number | undefined, currency)}
                      accent={COLORS.warning}
                    />
                  </EuiFlexItem>
                  <EuiFlexItem style={{ minWidth: 130 }}>
                    <StatTile
                      label="Tokens"
                      value={fmtTokens(cost?.total_tokens as number | undefined)}
                      accent={COLORS.accent}
                    />
                  </EuiFlexItem>
                  <EuiFlexItem style={{ minWidth: 130 }}>
                    <StatTile
                      label="LLM calls"
                      value={fmtNumber(cost?.call_count as number | undefined)}
                      accent={COLORS.primary}
                    />
                  </EuiFlexItem>
                </EuiFlexGroup>
                {Array.isArray(cost?.cost_over_time) && cost!.cost_over_time!.length > 1 ? (
                  <>
                    <EuiSpacer size="m" />
                    <MiniBars
                      values={cost!.cost_over_time!.map((p) => Number(p.cost) || 0)}
                      color={COLORS.warning}
                      height={80}
                    />
                  </>
                ) : null}
              </Card>
            </EuiFlexItem>
          </EuiFlexGroup>

          {knowledgeSection}
        </>
      )}
    </div>
  );
};
