/**
 * SLA, priority & suppression settings section (Round-6 — mount the orphaned G6 editors).
 *
 * The G6 rules-customization wave (Round 5) built four config-writer editors under
 * `components/rules/*` but left three of them with NO UI mount point. This section is
 * that mount point for the case-policy trio (PROPOSAL §G6 R5):
 *   - {@link SlaPolicyEditor}         → writes `Preferences.sla` (advisory timers),
 *   - {@link PriorityMatrixEditor}    → writes `Preferences.priority_matrix` (advisory),
 *   - {@link SuppressionRuleBuilder}  → writes `Preferences.suppression_rules`.
 *
 * ⛔ CONFIG WRITER ONLY (#3): every editor emits config via the shared deep-merge
 * `{prefs, update}` buffer the Settings page owns (which PUTs `/api/settings`). NONE call
 * `decide()`, set a case status, or bill an LLM (#6). SLA + priority are ADVISORY
 * (sorting / badges / MTTR only). Suppression is the ONE family that can hide events
 * (drops a matching event before triage) — so deletes of a LIVE rule route through a
 * `ConfirmDialog`. Every operator-authored value renders as plain text (#9).
 */
import * as React from 'react';
import { Ban, Gauge, Timer } from 'lucide-react';

import type { SuppressionRuleConfig } from '@/lib/types';

import { SettingsGrid, SettingsCard, type SettingsTOCItem } from '@/soc/components/SettingsGrid';
import { ConfirmDialog } from '@/soc/components/ConfirmDialog';
import {
  SlaPolicyEditor,
  PriorityMatrixEditor,
  SuppressionRuleBuilder,
} from '@/soc/components/rules';

import { SectionShell, type SecProps } from './primitives';

const CASE_POLICY_TOC: SettingsTOCItem[] = [
  { anchor: 'case-policy-sla', label: 'SLA targets', icon: Timer },
  { anchor: 'case-policy-priority', label: 'Priority matrix', icon: Gauge },
  { anchor: 'case-policy-suppression', label: 'Suppression', icon: Ban },
];

export function CasePolicySection({ prefs, update }: SecProps) {
  const rules = prefs.suppression_rules ?? [];
  // A LIVE suppression rule silently hides events, so its delete is gated. The builder
  // calls `onRequestRemove` for a live rule; we hold the pending target for the dialog.
  const [pendingRemove, setPendingRemove] = React.useState<{
    index: number;
    rule: SuppressionRuleConfig;
  } | null>(null);

  return (
    <SectionShell
      title="SLA, priority & suppression"
      sub="Advisory SLA targets and the impact × urgency priority matrix (they drive sorting, badges, and MTTR reporting only — never the deterministic decision), plus operator suppression rules that drop known-benign events before triage."
      toc={CASE_POLICY_TOC}
    >
      <SettingsGrid>
        <SettingsCard
          anchor="case-policy-sla"
          title="SLA targets"
          icon={Timer}
          description="Per-priority response and resolution timers. Advisory: they surface at-risk / breached badges and feed MTTR reporting, and never change a verdict."
          wide="full"
        >
          <SlaPolicyEditor policy={prefs.sla ?? {}} onChange={(next) => update({ sla: next })} />
        </SettingsCard>

        <SettingsCard
          anchor="case-policy-priority"
          title="Priority matrix"
          icon={Gauge}
          description="Map every impact × urgency pair to a P-level. Advisory: priority drives sorting, SLA tiers, and reporting, never the deterministic decision."
          wide="full"
        >
          <PriorityMatrixEditor
            matrix={prefs.priority_matrix ?? {}}
            onChange={(next) => update({ priority_matrix: next })}
          />
        </SettingsCard>

        <SettingsCard
          anchor="case-policy-suppression"
          title="Suppression rules"
          icon={Ban}
          description="Operator field == value rules that DROP a matching event before it becomes a candidate. The one rule family that can hide events — keep rules narrow and prefer disabling over deleting."
          wide="full"
        >
          <SuppressionRuleBuilder
            rules={rules}
            onChange={(next) => update({ suppression_rules: next })}
            onRequestRemove={(index, rule) => setPendingRemove({ index, rule })}
          />
        </SettingsCard>
      </SettingsGrid>

      {/* Destructive-delete gate for a LIVE suppression rule (parity with the rest of the
          console). Config writer only (#3): the confirmed delete flows through `update`. */}
      <ConfirmDialog
        open={pendingRemove !== null}
        onOpenChange={(o) => {
          if (!o) setPendingRemove(null);
        }}
        destructive
        title="Delete this suppression rule?"
        description={
          pendingRemove
            ? `This enabled rule (${pendingRemove.rule.field || 'field'} == ${pendingRemove.rule.value || 'value'}) currently drops matching events before triage. Deleting it stops the suppression. This writes configuration only — it never changes a case.`
            : ''
        }
        confirmLabel="Delete rule"
        onConfirm={() => {
          if (pendingRemove) {
            update({ suppression_rules: rules.filter((_, i) => i !== pendingRemove.index) });
          }
          setPendingRemove(null);
        }}
      />
    </SectionShell>
  );
}
