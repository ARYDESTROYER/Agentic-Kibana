/**
 * CaseDetail — Threat context panel (Coupling-D split).
 *
 * The threat-context tab (F11): a threat summary banner, IOC reputation, MITRE
 * ATT&CK techniques (with canonical links), and asset context. Fail-open: renders
 * empty/disabled states when the panel is off or bare. Related cases + evidence are
 * intentionally NOT repeated here — they live on the Overview tab (Round-7 dedup).
 *
 * SECURITY (#9): every indicator, country, entity, asset attribute and summary string
 * is UNTRUSTED — rendered plain text / inside <CodeBlock>. MITRE technique NAMES are
 * from the curated corpus (TRUSTED) but still rendered as plain text nodes. #3:
 * read-only projection; it never decides or mutates the case.
 */
import * as React from 'react';
import {
  AlertTriangle,
  Crosshair,
  Gauge,
  Globe,
  Link2,
  Shield,
  Target,
} from 'lucide-react';

import type {
  Case,
  IocReputation,
  ThreatContextPanel as ThreatContextPanelData,
} from '@/lib/types';
import { humanizeAge, humanizeToken } from '@/lib/format';
import { cn } from '@/lib/cn';

import { Badge } from '@/ui/badge';
import { LoadingState } from '@/design-system';

import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { VerdictBadge, RiskBadge } from '@/soc/components/badges';
import type { Navigate } from '@/soc/router';

import { CASE_MANAGER_PANEL_PADDING, PanelCard, SectionHeading } from './shared';
import type { CasePanelPresentation } from './shared';
import {
  ClusterFormationDiagram,
  type ClusterExplanation,
} from './ClusterFormationDiagram';

/** Canonical MITRE ATT&CK technique URL (id like "T1110" or "T1110.001"). */
function mitreUrl(id: string, fallback?: string): string {
  if (fallback && /^https?:\/\//i.test(fallback)) return fallback;
  const clean = (id || '').trim().toUpperCase();
  const m = /^T(\d{4})(?:\.(\d{3}))?$/.exec(clean);
  if (!m) return 'https://attack.mitre.org/techniques/';
  return m[2]
    ? `https://attack.mitre.org/techniques/T${m[1]}/${m[2]}/`
    : `https://attack.mitre.org/techniques/T${m[1]}/`;
}

/** The backend currently emits `score`; older saved payloads used
 * `reputation_score`. Read both without changing the API or losing history. */
function iocScore(ioc: IocReputation): number | undefined {
  const value =
    typeof ioc.reputation_score === 'number' ? ioc.reputation_score : ioc.score;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Likewise, live payloads carry a provider map while older projections had one
 * source string. Provider ids remain plain text (#9). */
function iocSource(ioc: IocReputation): string | undefined {
  if (typeof ioc.source === 'string' && ioc.source.trim()) return ioc.source;
  if (ioc.sources && typeof ioc.sources === 'object') {
    // Some fail-open enrichers return metadata-only maps such as `{note: ...}`;
    // those are not provider names and must not be labelled as the IOC source.
    const metadataKeys = new Set(['note', 'error', 'cached', 'score', 'country', 'raw']);
    const first = Object.keys(ioc.sources).find((key) => !metadataKeys.has(key.toLowerCase()));
    if (first) return first;
  }
  return undefined;
}

function scalarLabel(value: unknown): string {
  if (typeof value === 'string') return humanizeToken(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value ?? '—');
}

export const ThreatContextPanel: React.FC<{
  c: Case;
  panel: ThreatContextPanelData | null;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  /**
   * Accepted for API stability with the CaseDetail shell, but no longer used: the
   * only case-to-case navigation on this panel was the Related-cases list, which now
   * lives on the Overview tab (Round-7 dedup). Kept optional so callers can pass it.
   */
  onNavigate?: Navigate;
  presentation?: CasePanelPresentation;
}> = ({ c, panel, loading, error, onRetry, presentation = 'default' }) => {
  if (loading) {
    return (
      <div className="p-6">
        <LoadingState
          label="Loading threat context"
          description="Preparing IOC reputation, ATT&CK techniques, and asset context."
          layout="panel"
          shape="panel"
        />
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-6">
        <LoadError error={error} title="Could not load threat context" onRetry={onRetry} />
      </div>
    );
  }
  if (panel?.disabled) {
    return (
      <div className="p-6">
        <EmptyState
          icon={Globe}
          title="Threat context is disabled"
          description="Enable the threat-context panel under Settings → Threat context to assemble IOC reputation, MITRE techniques, related cases and asset context for each case."
        />
      </div>
    );
  }
  if (!panel) {
    return (
      <div className="p-6">
        <EmptyState
          icon={Globe}
          title="No threat context"
          description="No threat context could be assembled for this case yet."
        />
      </div>
    );
  }

  const iocs = (panel.ioc_reputation || []).filter((x) => x && x.indicator);
  const techniques = (panel.mitre_techniques || []).filter((t) => t && t.id);
  const asset = panel.asset_context || null;
  const assetAttrs =
    asset && asset.attributes && typeof asset.attributes === 'object'
      ? Object.entries(asset.attributes).filter(
          ([, v]) => v !== null && v !== undefined && typeof v !== 'object',
        )
      : [];
  const assetNetworks =
    asset && Array.isArray(asset.networks)
      ? asset.networks.filter((value) => ['string', 'number', 'boolean'].includes(typeof value))
      : [];
  const clustering = (panel.clustering || null) as ClusterExplanation | null;
  // Related cases + evidence are shown on the Overview tab, not repeated here
  // (Round-7 dedup), so they no longer participate in the "any section" gate.
  const anySection =
    !!panel.summary || iocs.length > 0 || techniques.length > 0 || !!asset || !!clustering?.available;

  if (presentation === 'case-manager') {
    return (
      <div className={cn('space-y-5', CASE_MANAGER_PANEL_PADDING)} data-case-panel="threat-context" data-presentation="case-manager">
        {/* Screenshot-first row: the ZIP's two equal threat-intelligence cards. */}
        <div className="grid gap-6 md:grid-cols-2">
          <PanelCard className="rounded-[8px] p-6">
            <div className="mb-5 flex items-center gap-2.5">
              <Shield className="h-5 w-5 text-primary" aria-hidden />
              <h2 className="text-lg font-semibold tracking-tight text-foreground">
                MITRE ATT&amp;CK® Mapping
              </h2>
            </div>
            {techniques.length === 0 ? (
              <EmptyState
                icon={Shield}
                compact
                title="No techniques mapped"
                description="No MITRE ATT&CK techniques were resolved for this case."
              />
            ) : (
              <div className="space-y-3">
                {techniques.map((technique, index) => (
                  <div
                    key={`${technique.id}-${index}`}
                    className="rounded-[4px] border border-border bg-surface-sunken p-3"
                  >
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-xs font-semibold text-primary">
                        {technique.id}
                      </span>
                      {technique.tactics?.[0] ? (
                        <span className="ml-auto text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                          {humanizeToken(technique.tactics[0])}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <span className="min-w-0 flex-1 text-sm font-semibold text-foreground">
                        {technique.name || 'Unknown technique'}
                      </span>
                      <a
                        href={mitreUrl(technique.id, technique.url)}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Open MITRE ATT&CK ${technique.id} in a new tab`}
                        className="rounded p-1 text-muted-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Link2 className="h-3.5 w-3.5" aria-hidden />
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </PanelCard>

          <PanelCard className="rounded-[8px] p-6">
            <div className="mb-5 flex items-center gap-2.5">
              <Target className="h-5 w-5 text-critical-text" aria-hidden />
              <h2 className="text-lg font-semibold tracking-tight text-foreground">
                IOC Reputation
              </h2>
            </div>
            {iocs.length === 0 ? (
              <EmptyState
                icon={Target}
                compact
                title="No indicator reputation"
                description="No IOC reputation was available for this case."
              />
            ) : (
              <div className="space-y-3">
                {iocs.map((ioc, index) => {
                  const score = iocScore(ioc);
                  const source = iocSource(ioc);
                  return (
                    <div
                      key={`${ioc.indicator}-${index}`}
                      className={cn(
                        'rounded-[4px] border bg-surface-sunken p-4',
                        ioc.is_malicious ? 'border-critical/30' : 'border-border',
                      )}
                    >
                      <div className="flex items-center gap-3">
                        <span className="min-w-0 flex-1 truncate font-mono text-sm font-semibold text-foreground">
                          {ioc.indicator}
                        </span>
                        {typeof ioc.is_malicious === 'boolean' ? (
                          <Badge variant={ioc.is_malicious ? 'critical' : 'success'}>
                            {ioc.is_malicious ? 'Malicious' : 'Clean'}
                          </Badge>
                        ) : null}
                      </div>
                      <dl className="mt-4 space-y-2 text-xs">
                        <div className="flex items-center justify-between gap-3">
                          <dt className="text-muted-foreground">Source</dt>
                          <dd className="text-right text-foreground">
                            {source ? humanizeToken(source) : 'Unavailable'}
                          </dd>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <dt className="text-muted-foreground">Confidence score</dt>
                          <dd
                            className={cn(
                              'font-mono font-semibold',
                              typeof score === 'number' && score >= 50
                                ? 'text-critical-text'
                                : 'text-foreground',
                            )}
                          >
                            {typeof score === 'number' ? `${Math.round(score)}%` : 'Unavailable'}
                          </dd>
                        </div>
                        {panel.generated_at ? (
                          <div className="flex items-center justify-between gap-3">
                            <dt className="text-muted-foreground">Assembled</dt>
                            <dd className="text-right text-foreground">
                              {humanizeAge(panel.generated_at)}
                            </dd>
                          </div>
                        ) : null}
                      </dl>
                    </div>
                  );
                })}
              </div>
            )}
          </PanelCard>
        </div>

        <ClusterFormationDiagram data={clustering} />

        {/* Production-only context remains available below the exact reference row. */}
        <div className="grid gap-6 md:grid-cols-2">
          <PanelCard className="rounded-[8px]">
            <SectionHeading icon={Shield}>Threat summary</SectionHeading>
            {panel.summary ? (
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
                {panel.summary}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                No threat summary was assembled for this case.
              </p>
            )}
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <VerdictBadge verdict={c.verdict} />
              <RiskBadge score={c.risk_score} />
            </div>
          </PanelCard>

          <PanelCard className="rounded-[8px]">
            <SectionHeading icon={Crosshair}>Asset context</SectionHeading>
            {!asset ||
            (!asset.entity &&
              asset.criticality === undefined &&
              asset.is_internal === undefined &&
              assetNetworks.length === 0 &&
              assetAttrs.length === 0) ? (
              <EmptyState
                icon={Crosshair}
                compact
                title="No asset context"
                description="No additional context was recorded for the case's primary entity."
              />
            ) : (
              <dl className="divide-y divide-border">
                {asset.entity ? (
                  <div className="flex items-center justify-between gap-3 py-2.5 first:pt-0">
                    <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                      {humanizeToken(asset.entity_type || 'Entity')}
                    </dt>
                    <dd className="truncate text-right font-mono text-sm text-foreground">
                      {asset.entity}
                    </dd>
                  </div>
                ) : null}
                {asset.criticality !== undefined ? (
                  <div className="flex items-center justify-between gap-3 py-2.5">
                    <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                      Criticality
                    </dt>
                    <dd className="text-right font-mono text-sm text-foreground">
                      {scalarLabel(asset.criticality)}
                    </dd>
                  </div>
                ) : null}
                {asset.is_internal !== undefined ? (
                  <div className="flex items-center justify-between gap-3 py-2.5">
                    <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                      Internal asset
                    </dt>
                    <dd className="text-right text-sm text-foreground">
                      {asset.is_internal ? 'Yes' : 'No'}
                    </dd>
                  </div>
                ) : null}
                {assetNetworks.length ? (
                  <div className="flex items-start justify-between gap-3 py-2.5">
                    <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                      Networks
                    </dt>
                    <dd className="max-w-[70%] text-right font-mono text-sm text-foreground">
                      {assetNetworks.map(String).join(', ')}
                    </dd>
                  </div>
                ) : null}
                {assetAttrs.map(([key, value], index) => (
                  <div
                    key={`${key}-${index}`}
                    className="flex items-center justify-between gap-3 py-2.5 last:pb-0"
                  >
                    <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                      {humanizeToken(key)}
                    </dt>
                    <dd className="truncate text-right font-mono text-sm text-foreground">
                      {scalarLabel(value)}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </PanelCard>
        </div>

        {!anySection ? (
          <p className="text-xs text-muted-foreground">
            Threat context is enabled but produced no sections for this case.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      {/* ---------------------------------------------- threat banner */}
      <PanelCard>
        <SectionHeading icon={Shield}>
          Threat summary
        </SectionHeading>
        {panel.summary ? (
          /* UNTRUSTED — plain text. */
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
            {panel.summary}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            No threat summary was assembled for this case.
          </p>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <VerdictBadge verdict={c.verdict} />
          <RiskBadge score={c.risk_score} />
          {iocs.some((i) => i.is_malicious) ? (
            <Badge variant="critical" className="gap-1">
              <AlertTriangle className="h-3 w-3" />
              Malicious indicator present
            </Badge>
          ) : null}
          {panel.generated_at ? (
            <span className="ml-auto text-xs text-muted-foreground">
              assembled {humanizeAge(panel.generated_at)}
            </span>
          ) : null}
        </div>
      </PanelCard>

      <ClusterFormationDiagram data={clustering} />

      {/* ---------------------------------------------- IOC reputation */}
      <PanelCard>
        <SectionHeading icon={Target}>
          IOC reputation
        </SectionHeading>
        {iocs.length === 0 ? (
          <EmptyState
            icon={Target}
            compact
            title="No indicator reputation"
            description="No IOC reputation was available — enrichment may be off, uncached, or the indicators are internal."
          />
        ) : (
          <div className="space-y-2">
            {iocs.map((ioc, i) => {
              const score = iocScore(ioc);
              const source = iocSource(ioc);
              return (
                <div
                  key={`${ioc.indicator}-${i}`}
                  className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 p-3"
                >
                  {/* UNTRUSTED indicator — plain text, mono. */}
                  <span className="min-w-0 flex-1 truncate font-mono text-sm text-foreground">
                    {ioc.indicator}
                  </span>
                  {ioc.type ? <Badge variant="outline">{humanizeToken(ioc.type)}</Badge> : null}
                  {typeof score === 'number' ? (
                    <Badge variant={score >= 50 ? 'critical' : 'secondary'}>
                      <Gauge className="h-3 w-3" />
                      score {Math.round(score)}
                    </Badge>
                  ) : null}
                  {typeof ioc.is_malicious === 'boolean' ? (
                    <Badge variant={ioc.is_malicious ? 'critical' : 'success'}>
                      {ioc.is_malicious ? 'Malicious' : 'Clean'}
                    </Badge>
                  ) : null}
                  {ioc.country ? (
                    /* UNTRUSTED — plain text. */
                    <Badge variant="outline" className="gap-1">
                      <Globe className="h-3 w-3" />
                      <span className="max-w-[10rem] truncate">{ioc.country}</span>
                    </Badge>
                  ) : null}
                  {source ? (
                    <span className="text-xs text-muted-foreground">{humanizeToken(source)}</span>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </PanelCard>

      {/* ---------------------------------------------- MITRE techniques */}
      <PanelCard>
        <SectionHeading icon={Shield}>
          MITRE ATT&amp;CK techniques
        </SectionHeading>
        {techniques.length === 0 ? (
          <EmptyState
            icon={Shield}
            compact
            title="No techniques mapped"
            description="No MITRE ATT&CK techniques were resolved for this case."
          />
        ) : (
          <div className="space-y-2">
            {techniques.map((t, i) => (
              <div key={`${t.id}-${i}`} className="rounded-md border border-border bg-muted/30 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="font-mono">
                    {t.id}
                  </Badge>
                  {/* Name is from the curated MITRE corpus (TRUSTED) — still a plain text node. */}
                  <span className="text-sm font-semibold text-foreground">
                    {t.name || 'Unknown technique'}
                  </span>
                  <a
                    href={mitreUrl(t.id, t.url)}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Open MITRE ATT&CK ${t.id} in a new tab`}
                    className="ml-auto inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    <Link2 className="h-3 w-3" aria-hidden /> MITRE
                  </a>
                </div>
                {t.tactics && t.tactics.length ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {t.tactics.map((tac, j) => (
                      <Badge key={`${tac}-${j}`} variant="medium">
                        {humanizeToken(tac)}
                      </Badge>
                    ))}
                  </div>
                ) : null}
                {t.description ? (
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    {t.description}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </PanelCard>

      {/* ---------------------------------------------- asset context */}
      <PanelCard>
        <SectionHeading icon={Crosshair}>
          Asset context
        </SectionHeading>
        {!asset ||
        (!asset.entity &&
          asset.criticality === undefined &&
          asset.is_internal === undefined &&
          assetNetworks.length === 0 &&
          assetAttrs.length === 0) ? (
          <EmptyState
            icon={Crosshair}
            compact
            title="No asset context"
            description="No additional context was recorded for the case's primary entity."
          />
        ) : (
          <dl className="divide-y divide-border">
            {asset.entity ? (
              <div className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {humanizeToken(asset.entity_type || 'Entity')}
                </dt>
                {/* UNTRUSTED — plain text, mono. */}
                <dd className="truncate text-right font-mono text-sm text-foreground">
                  {asset.entity}
                </dd>
              </div>
            ) : null}
            {asset.criticality !== undefined ? (
              <div className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Criticality
                </dt>
                <dd className="text-right text-sm text-foreground">
                  {scalarLabel(asset.criticality)}
                </dd>
              </div>
            ) : null}
            {asset.is_internal !== undefined ? (
              <div className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Internal asset
                </dt>
                <dd className="text-right text-sm text-foreground">
                  {asset.is_internal ? 'Yes' : 'No'}
                </dd>
              </div>
            ) : null}
            {assetNetworks.length ? (
              <div className="flex items-start justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Networks
                </dt>
                <dd className="max-w-[70%] text-right font-mono text-sm text-foreground">
                  {assetNetworks.map(String).join(', ')}
                </dd>
              </div>
            ) : null}
            {assetAttrs.map(([k, v], i) => (
              <div
                key={`${k}-${i}`}
                className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
              >
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {humanizeToken(k)}
                </dt>
                {/* UNTRUSTED — plain text. */}
                <dd className="truncate text-right font-mono text-sm text-foreground">
                  {scalarLabel(v)}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </PanelCard>

      {!anySection ? (
        <p className="text-xs text-muted-foreground">
          Threat context is enabled but produced no sections for this case.
        </p>
      ) : null}
    </div>
  );
};

export default ThreatContextPanel;
