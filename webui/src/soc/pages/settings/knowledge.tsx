/**
 * Knowledge & threat context settings section (Round-5 Sett-A decomposition).
 *
 * Lifted verbatim from the former `Settings.tsx` `KnowledgeSection` + `RagControls`.
 * RAG retrieval config, the per-case threat-context panel, and deep-links to the
 * corpus and response-playbook management pages.
 */
import { FileText, Library, ShieldAlert } from 'lucide-react';

import type { ThreatContextConfig } from '@/lib/types';
import { cn } from '@/lib/cn';

import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { SettingsGrid, SettingsCard, type SettingsTOCItem } from '@/soc/components/SettingsGrid';
import { Field } from '@/soc/components/Field';
import { HelpTip } from '@/soc/components/HelpTip';

import { SectionShell, NumPref, SwitchPref, type NavigateFn, type SecProps } from './primitives';

const KNOWLEDGE_TOC: SettingsTOCItem[] = [
  { anchor: 'knowledge-rag', label: 'Retrieval (RAG)', icon: Library },
  { anchor: 'knowledge-threat', label: 'Threat context', icon: ShieldAlert },
  { anchor: 'knowledge-corpus', label: 'Corpus', icon: FileText },
];

/** RAG retrieval toggles (also reused by the Advanced › Suppression card). */
export function RagControls({ prefs, update }: SecProps) {
  const r = prefs.rag || {};
  const set = (patch: Partial<typeof r>) => update({ rag: { ...r, ...patch } });
  return (
    <div className="space-y-4">
      <SwitchPref label="RAG enabled" checked={r.enabled ?? true} onChange={(v) => set({ enabled: v })} />
      <div className={cn('grid gap-4 sm:grid-cols-2', !(r.enabled ?? true) && 'opacity-60')}>
        <NumPref label="Top K" value={r.top_k} disabled={!(r.enabled ?? true)} onChange={(v) => set({ top_k: v })} />
        <NumPref label="Minimum score" value={r.min_score} step={0.05} disabled={!(r.enabled ?? true)} onChange={(v) => set({ min_score: v })} />
      </div>
      <div className={cn('space-y-2', !(r.enabled ?? true) && 'opacity-60')}>
        <SwitchPref label="Use runbooks" checked={r.use_runbooks ?? true} disabled={!(r.enabled ?? true)} onChange={(v) => set({ use_runbooks: v })} />
        <SwitchPref label="Use MITRE" checked={r.use_mitre ?? true} disabled={!(r.enabled ?? true)} onChange={(v) => set({ use_mitre: v })} />
        <SwitchPref label="Use resolved cases" checked={r.use_resolved_cases ?? true} disabled={!(r.enabled ?? true)} onChange={(v) => set({ use_resolved_cases: v })} />
        <SwitchPref label="Use threat intel" checked={r.use_threat_context ?? true} disabled={!(r.enabled ?? true)} onChange={(v) => set({ use_threat_context: v })} />
      </div>
    </div>
  );
}

export function KnowledgeSection({
  prefs,
  update,
  onNavigate,
}: SecProps & { onNavigate?: NavigateFn }) {
  const cfg: ThreatContextConfig = prefs.threat_context || {};
  const set = (patch: Partial<ThreatContextConfig>) =>
    update({ threat_context: { ...cfg, ...patch } });

  return (
    <SectionShell
      title="Knowledge & threat context"
      sub="Retrieval-augmented context for investigations, the per-case threat-context panel (IOC reputation, MITRE, related cases), and the reusable-knowledge loop."
      toc={KNOWLEDGE_TOC}
    >
      <SettingsGrid>
        <SettingsCard
          anchor="knowledge-rag"
          title="Retrieval (RAG)"
          icon={Library}
          description="Hybrid BM25 + vector retrieval injects relevant knowledge into investigations as a clearly-labelled TRUSTED block."
          wide="full"
        >
          <RagControls prefs={prefs} update={update} />
        </SettingsCard>

        <SettingsCard
          anchor="knowledge-threat"
          title="Threat-context panel"
          icon={ShieldAlert}
          description="The Threat context tab on each case. Sections fail open — a missing enrichment or MITRE lookup degrades to empty, never an error."
          wide="full"
        >
          <div className="space-y-3">
            <SwitchPref
              label="Threat-context panel enabled"
              help="Assemble and show the Threat context tab on each case."
              checked={cfg.enabled ?? true}
              onChange={(v) => set({ enabled: v })}
            />
            <SwitchPref
              label="MITRE ATT&CK technique lookup"
              help="Resolve technique ids against the bundled curated MITRE corpus (name, tactics, link)."
              checked={cfg.mitre_enabled ?? true}
              onChange={(v) => set({ mitre_enabled: v })}
            />
            <SwitchPref
              label="Reuse resolved cases"
              help="Auto-index closed/resolved cases into the corpus so future triage can retrieve 'we've seen this before'."
              checked={cfg.reuse_resolved_cases ?? true}
              onChange={(v) => set({ reuse_resolved_cases: v })}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="IOC malicious threshold"
                description="Reputation scores at or above this threshold are marked malicious."
                labelAction={
                  <HelpTip text="A reputation score at or above this (0–100) marks an indicator as malicious in the panel." />
                }
              >
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    type="number"
                    min={0}
                    max={100}
                    value={cfg.ioc_malicious_threshold ?? 50}
                    onChange={(e) => set({ ioc_malicious_threshold: Number(e.target.value) })}
                  />
                )}
              </Field>
            </div>
          </div>
        </SettingsCard>

        <SettingsCard
          anchor="knowledge-corpus"
          title="Corpus & procedures"
          icon={FileText}
          description="Manage the RAG knowledge corpus (runbooks, MITRE, imported threat-intel) and the per-cluster playbooks on their dedicated pages."
          wide="full"
        >
          <div className="divide-y divide-border/70 border-y border-border/70 sm:grid sm:grid-cols-2 sm:divide-x sm:divide-y-0">
            <div className="flex flex-wrap items-center justify-between gap-3 py-3 sm:pr-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">Knowledge corpus</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Runbooks, MITRE context, and imported intelligence.
                </p>
              </div>
              {onNavigate ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onNavigate('intelligence', { tab: 'knowledge' })}
                >
                  <Library className="h-4 w-4" aria-hidden />
                  Open
                </Button>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 py-3 sm:pl-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">Response playbooks</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Deterministically selected procedures that guide an investigation.
                </p>
              </div>
              {onNavigate ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onNavigate('intelligence', { tab: 'playbooks' })}
                >
                  <FileText className="h-4 w-4" aria-hidden />
                  Open
                </Button>
              ) : null}
            </div>
          </div>
        </SettingsCard>
      </SettingsGrid>
    </SectionShell>
  );
}
