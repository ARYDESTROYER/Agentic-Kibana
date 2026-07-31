/**
 * CaseDetail — "Why" panel (Coupling-D split).
 *
 * The explainability tab: the deterministic decision summary, the agent's reasoning
 * excerpt, the knowledge it retrieved (RAG/runbook/playbook), the tools/queries it
 * ran, operator memory applied, enrichment + playbook, and MITRE techniques.
 *
 * SECURITY (#9): every model/agent/log-derived string (reasoning, snippets, tool
 * output, enrichment values, playbook reason) is UNTRUSTED — rendered plain text or
 * inside <CodeBlock>. #3: read-only projection; it never decides or mutates the case.
 */
import * as React from 'react';
import {
  Activity,
  BookOpen,
  Brain,
  GitBranch,
  Globe,
  Shield,
  SlidersHorizontal,
  Terminal,
  User,
  Wrench,
} from 'lucide-react';

import type { Case, CaseRationale } from '@/lib/types';
import { formatTimestamp, humanizeToken } from '@/lib/format';
import { cn } from '@/lib/cn';

import { Badge } from '@/ui/badge';
import { Alert, AlertTitle, AlertDescription } from '@/ui/alert';
import { Skeleton } from '@/ui/skeleton';

import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { CodeBlock } from '@/soc/components/CodeBlock';
import {
  VerdictBadge,
  StatusBadge,
  ConfidenceBadge,
} from '@/soc/components/badges';

import { PanelCard, SectionHeading } from './shared';

function decisionByLabel(decisionBy?: string): { text: string; isHuman: boolean } {
  const d = (decisionBy || '').toLowerCase();
  const isHuman = d.includes('human') || d.includes('analyst') || d.includes('operator');
  return { text: decisionBy ? humanizeToken(decisionBy) : 'Automated pipeline', isHuman };
}

export const WhyPanel: React.FC<{
  c: Case;
  rationale: CaseRationale | null;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  /**
   * Omit the leading "Decision" summary card (verdict/status/decided-by + the
   * deterministic-decision Alert). Used by the merged InvestigationPanel, where the
   * pinned <DecisionCard> is the single authority for the decision lane (#3) so the
   * AI-assessment lane shows only reasoning / knowledge / tools / enrichment. Default
   * false → the standalone "Why" surface keeps the decision summary.
   */
  hideDecision?: boolean;
  /**
   * Omit the trailing MITRE ATT&CK card. Used by InvestigationPanel, where MITRE is
   * surfaced once (in the Threat / Overview lane) instead of repeated here. Default
   * false → the standalone surface keeps MITRE.
   */
  hideMitre?: boolean;
}> = ({ c, rationale, loading, error, onRetry, hideDecision = false, hideMitre = false }) => {
  if (loading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-6">
        <LoadError error={error} title="Could not load decision rationale" onRetry={onRetry} />
      </div>
    );
  }
  if (!rationale) {
    return (
      <div className="p-6">
        <EmptyState
          icon={Brain}
          title="No rationale recorded yet"
          description="The decision rationale appears after an investigation runs. It shows the agent's reasoning, the knowledge it retrieved, and the deterministic close / escalate decision."
        />
      </div>
    );
  }

  const r = rationale;
  const verdict = r.verdict ?? c.verdict;
  const confidence = typeof r.confidence === 'number' ? r.confidence : c.confidence;
  const status = r.status ?? c.status;
  const persona = r.persona ?? c.agent_persona;
  const decision = decisionByLabel(r.decision_by ?? c.decision_by);

  const knowledge = r.knowledge || [];
  const runbooks = knowledge.filter((item) => {
    const source = (item.source || '').trim().toLowerCase();
    return source === 'runbook' || source.startsWith('runbook:');
  });
  const retrievedKnowledge = knowledge.filter((item) => !runbooks.includes(item));
  const tools = r.tools || [];
  const memory = (r.memory_used || []).filter((m) => (m || '').trim());
  const mitre = r.mitre || [];
  const enr = r.enrichment || null;
  // Only treat enrichment as present when it carries one of the fields the card
  // actually renders — a fail-open `{}` / `{asn: 5}` result is truthy but would
  // otherwise draw a heading-only card with an empty grid.
  const hasEnr =
    !!enr &&
    (typeof enr.reputation_score === 'number' ||
      typeof enr.is_malicious === 'boolean' ||
      !!enr.country);
  const playbook = r.playbook || null;
  const platformTuning = r.platform_tuning || [];

  return (
    <div className="space-y-6 p-6">
      {/* ------------------------------------------- decision summary */}
      {hideDecision ? null : (
        <PanelCard>
          <SectionHeading icon={Brain}>
            Decision
          </SectionHeading>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <VerdictBadge verdict={verdict} />
            <StatusBadge status={status} />
            {typeof confidence === 'number' ? (
              <ConfidenceBadge confidence={confidence} />
            ) : null}
            <Badge variant={decision.isHuman ? 'success' : 'info'} className="gap-1">
              {decision.isHuman ? <User className="h-3 w-3" /> : <Brain className="h-3 w-3" />}
              Decided by {decision.text}
            </Badge>
            {persona && persona !== 'generalist' ? (
              <Badge variant="outline" className="gap-1">
                <User className="h-3 w-3" />
                {humanizeToken(persona)}
              </Badge>
            ) : null}
          </div>
          <Alert>
            <GitBranch className="h-4 w-4" />
            <AlertTitle>Deterministic decision</AlertTitle>
            {/* UNTRUSTED — plain text. */}
            <AlertDescription className="whitespace-pre-wrap">
              {r.decision_rationale
                ? r.decision_rationale
                : 'The close / escalate decision is made by deterministic code against the operator-configured auto-close policy — never by raw model output. No rationale string was recorded for this case.'}
            </AlertDescription>
          </Alert>
        </PanelCard>
      )}

      {/* ------------------------------------------- agent reasoning */}
      <PanelCard>
        <SectionHeading icon={Activity}>
          Agent reasoning
        </SectionHeading>
        {r.reasoning && r.reasoning.trim() ? (
          /* UNTRUSTED — plain text. */
          <p className="whitespace-pre-wrap text-sm text-foreground/90">{r.reasoning}</p>
        ) : (
          <p className="text-sm text-muted-foreground">
            No reasoning excerpt was recorded for this investigation.
          </p>
        )}
      </PanelCard>

      {/* ------------------------------------------- knowledge retrieved */}
      <PanelCard>
        <SectionHeading icon={BookOpen}>
          Knowledge retrieved
        </SectionHeading>
        <p className="mb-3 text-xs text-muted-foreground">
          Reference excerpts retrieved through RAG. Runbooks are identified separately;
          playbooks are operator procedures shown below.
        </p>
        {knowledge.length === 0 ? (
          <EmptyState
            icon={BookOpen}
            compact
            title="No knowledge retrieved"
            description="The investigation did not retrieve any knowledge or runbook excerpts."
          />
        ) : (
          <div className="space-y-5">
            {[
              { label: 'Knowledge', items: retrievedKnowledge },
              { label: 'Runbook references', items: runbooks },
            ].map((group) =>
              group.items.length ? (
                <div key={group.label} className="space-y-3">
                  <h4 className="text-2xs font-semibold uppercase tracking-widest text-muted-foreground">
                    {group.label}
                  </h4>
                  {group.items.map((k, i) => (
                    <div key={`${group.label}-${i}`} className="rounded-md border border-border bg-muted/30 p-3">
                      <Badge variant="info" className="mb-2 gap-1">
                        <BookOpen className="h-3 w-3" />
                        {/* humanizeToken('') returns the DASH glyph (truthy), so guard the
                            empty source explicitly to hit the 'Knowledge' fallback. */}
                        {k.source ? humanizeToken(k.source) : 'Knowledge reference'}
                      </Badge>
                      {k.snippet ? (
                        /* UNTRUSTED — inside CodeBlock fence. */
                        <CodeBlock value={k.snippet} wrap copyable maxHeightClassName="max-h-40" />
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null,
            )}
          </div>
        )}
      </PanelCard>

      {/* ------------------------------------------- commands the agent ran */}
      <PanelCard>
        <SectionHeading icon={Terminal}>
          Commands the agent ran
        </SectionHeading>
        <p className="mb-3 text-xs text-muted-foreground">
          The tools / read-only queries the investigator invoked to gather evidence.
        </p>
        {tools.length === 0 ? (
          <EmptyState
            icon={Terminal}
            compact
            title="No tools were invoked"
            description="This case reached its verdict without running any investigation tools."
          />
        ) : (
          <div className="space-y-3">
            {tools.map((t, i) => (
              <div key={i} className="rounded-md border border-border bg-muted/30 p-3">
                <Badge variant="info" className="mb-2 gap-1">
                  <Wrench className="h-3 w-3" />
                  {t.tool || `Tool ${i + 1}`}
                </Badge>
                {t.query ? (
                  <CodeBlock value={t.query} wrap copyable maxHeightClassName="max-h-40" />
                ) : null}
                {t.summary ? (
                  /* UNTRUSTED — plain text. */
                  <p className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">
                    {t.summary}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </PanelCard>

      {/* ------------------------------------------- operator memory */}
      {memory.length ? (
        <PanelCard>
          <SectionHeading icon={Brain}>
            Operator memory consulted
          </SectionHeading>
          <p className="mb-3 text-xs text-muted-foreground">
            Approved operator facts supplied as trusted context to this investigation.
          </p>
          <ul className="space-y-2">
            {memory.map((m, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <Badge variant="medium" className="shrink-0 gap-1">
                  <Brain className="h-3 w-3" /> Memory
                </Badge>
                {/* UNTRUSTED — plain text. */}
                <span className="whitespace-pre-wrap text-foreground/90">{m}</span>
              </li>
            ))}
          </ul>
        </PanelCard>
      ) : null}

      {/* ------------------------------- deterministic platform tuning */}
      {platformTuning.length ? (
        <PanelCard>
          <SectionHeading icon={SlidersHorizontal}>
            Platform tuning
          </SectionHeading>
          <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
            This case traversed a detection threshold previously adjusted by Agentic SOC
            auto-tuning. This is threshold tuning, not model fine-tuning, and it does not
            make the final close / escalate decision.
          </p>
          <div className="divide-y divide-border/60 border-y border-border/60">
            {platformTuning.map((record, index) => {
              const target =
                record.target === 'correlation_n'
                  ? 'Correlation threshold'
                  : record.target === 'severity_floor'
                    ? 'Severity floor'
                    : humanizeToken(record.target);
              const hasValues =
                typeof record.before === 'number' && typeof record.after === 'number';
              return (
                <div key={record.record_id || `${record.target}-${record.rule_id}-${index}`} className="py-4 first:pt-3 last:pb-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-foreground">{target}</div>
                      <div className="mt-1 font-mono text-xs text-muted-foreground">
                        {record.rule_id || 'Scope not recorded'}
                      </div>
                    </div>
                    {hasValues ? (
                      <Badge variant="outline" className="font-mono">
                        {record.before} → {record.after}
                      </Badge>
                    ) : null}
                  </div>
                  {record.rationale ? (
                    <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
                      {record.rationale}
                    </p>
                  ) : null}
                  {record.applied_at ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Applied {formatTimestamp(record.applied_at)}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        </PanelCard>
      ) : null}

      {/* ------------------------------- enrichment + playbook */}
      {hasEnr || (playbook && playbook.id && playbook.consulted !== false) ? (
        <div className="grid gap-6 lg:grid-cols-2">
          {hasEnr && enr ? (
            <PanelCard>
              <SectionHeading icon={Globe}>
                Enrichment
              </SectionHeading>
              <div className="grid grid-cols-2 gap-3">
                {typeof enr.reputation_score === 'number' ? (
                  <div className="rounded-md border border-border bg-muted/30 p-3">
                    <div className="text-xs text-muted-foreground">Reputation score</div>
                    <div className="mt-1 text-xl font-semibold text-foreground">
                      {Math.round(enr.reputation_score)}
                    </div>
                  </div>
                ) : null}
                {typeof enr.is_malicious === 'boolean' ? (
                  <div className="rounded-md border border-border bg-muted/30 p-3">
                    <div className="text-xs text-muted-foreground">Threat verdict</div>
                    <div
                      className={cn(
                        'mt-1 text-xl font-semibold',
                        enr.is_malicious ? 'text-critical' : 'text-success',
                      )}
                    >
                      {enr.is_malicious ? 'Malicious' : 'Clean'}
                    </div>
                  </div>
                ) : null}
                {enr.country ? (
                  <div className="rounded-md border border-border bg-muted/30 p-3">
                    <div className="text-xs text-muted-foreground">Country</div>
                    {/* UNTRUSTED — plain text. */}
                    <div className="mt-1 text-xl font-semibold text-foreground">{enr.country}</div>
                  </div>
                ) : null}
              </div>
            </PanelCard>
          ) : null}
          {playbook && playbook.id && playbook.consulted !== false ? (
            <PanelCard>
              <SectionHeading icon={BookOpen}>
                Playbook consulted
              </SectionHeading>
              <Badge variant="info" className="font-mono">
                {playbook.id}{playbook.version ? ` · v${playbook.version}` : ''}
              </Badge>
              {playbook.reason ? (
                /* UNTRUSTED — plain text. */
                <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
                  {playbook.reason}
                </p>
              ) : null}
            </PanelCard>
          ) : null}
        </div>
      ) : null}

      {/* ------------------------------------------- MITRE */}
      {!hideMitre && mitre.length ? (
        <PanelCard>
          <SectionHeading icon={Shield}>
            MITRE ATT&amp;CK techniques
          </SectionHeading>
          <div className="flex flex-wrap gap-2">
            {mitre.map((m, i) => (
              <Badge key={`${m}-${i}`} variant="outline" className="font-mono">
                {m}
              </Badge>
            ))}
          </div>
        </PanelCard>
      ) : null}
    </div>
  );
};

export default WhyPanel;
