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

import type { Case, ThreatContextPanel as ThreatContextPanelData } from '@/lib/types';
import { humanizeAge, humanizeToken } from '@/lib/format';

import { Badge } from '@/ui/badge';
import { Skeleton } from '@/ui/skeleton';

import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { VerdictBadge, RiskBadge } from '@/soc/components/badges';
import type { Navigate } from '@/soc/router';

import { PanelCard, SectionHeading } from './shared';

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
}> = ({ c, panel, loading, error, onRetry }) => {
  if (loading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
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
  // Related cases + evidence are shown on the Overview tab, not repeated here
  // (Round-7 dedup), so they no longer participate in the "any section" gate.
  const anySection =
    !!panel.summary || iocs.length > 0 || techniques.length > 0 || !!asset;

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
          <div className="space-y-2.5">
            {iocs.map((ioc, i) => (
              <div
                key={`${ioc.indicator}-${i}`}
                className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 p-3"
              >
                {/* UNTRUSTED indicator — plain text, mono. */}
                <span className="min-w-0 flex-1 truncate font-mono text-sm text-foreground">
                  {ioc.indicator}
                </span>
                {ioc.type ? <Badge variant="outline">{humanizeToken(ioc.type)}</Badge> : null}
                {typeof ioc.reputation_score === 'number' ? (
                  <Badge variant={ioc.reputation_score >= 50 ? 'critical' : 'secondary'}>
                    <Gauge className="h-3 w-3" />
                    score {Math.round(ioc.reputation_score)}
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
                {ioc.source ? (
                  <span className="text-xs text-muted-foreground">{humanizeToken(ioc.source)}</span>
                ) : null}
              </div>
            ))}
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
          <div className="space-y-2.5">
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

      {/* Related cases moved to the Overview tab (Round-7 dedup). */}

      {/* ---------------------------------------------- asset context */}
      <PanelCard>
        <SectionHeading icon={Crosshair}>
          Asset context
        </SectionHeading>
        {!asset || (!asset.entity && !asset.criticality && assetAttrs.length === 0) ? (
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
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {humanizeToken(asset.entity_type || 'Entity')}
                </dt>
                {/* UNTRUSTED — plain text, mono. */}
                <dd className="truncate text-right font-mono text-sm text-foreground">
                  {asset.entity}
                </dd>
              </div>
            ) : null}
            {asset.criticality ? (
              <div className="flex items-center justify-between gap-3 py-2.5">
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Criticality
                </dt>
                <dd className="text-right text-sm text-foreground">
                  {humanizeToken(asset.criticality)}
                </dd>
              </div>
            ) : null}
            {assetAttrs.map(([k, v], i) => (
              <div
                key={`${k}-${i}`}
                className="flex items-center justify-between gap-3 py-2.5 last:pb-0"
              >
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {humanizeToken(k)}
                </dt>
                {/* UNTRUSTED — plain text. */}
                <dd className="truncate text-right font-mono text-sm text-foreground">
                  {String(v)}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </PanelCard>

      {/* Evidence moved to the Overview tab (Round-7 dedup). */}

      {!anySection ? (
        <p className="text-xs text-muted-foreground">
          Threat context is enabled but produced no sections for this case.
        </p>
      ) : null}
    </div>
  );
};

export default ThreatContextPanel;
