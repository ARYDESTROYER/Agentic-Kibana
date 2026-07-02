/**
 * Threshold automation settings section (Round-5 Sett-A decomposition + Round-6 de-dup).
 *
 * ⛔ ROUND-6 DE-DUPLICATION: two surfaces used to edit the SAME
 * `threshold_automation.rules` — this legacy section AND the G6 "Detection & rules"
 * home. The Detection & rules home is now THE editor. This section keeps only the
 * NON-rule automation controls — the master enable switch (`threshold_automation.enabled`)
 * and the #3 invariant explainer — and replaces its former embedded rule-list editor
 * with a link CARD into Detection & rules. The wire keys are unchanged (nothing is
 * deleted); case-automation rules are simply authored in one place now.
 *
 * INVARIANT #3 (unchanged): a matched rule can only tag / recommend / notify / queue a
 * re-investigation / draft an approval proposal — it NEVER sets a case's status or
 * auto-closes it. Every outside-world write goes through the approval queue.
 */
import { ArrowRight, Info, ListChecks, Zap } from 'lucide-react';

import type { ThresholdAutomationConfig } from '@/lib/types';

import { Button } from '@/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';

import { SectionTitle, SwitchPref, type SecProps } from './primitives';

/**
 * The threshold-automation section. `onOpenRules` (wired by the Settings page to
 * `setSection('detection_rules')`) switches to the Detection & rules home where the
 * per-rule editor lives. When absent (e.g. a standalone unit render) the link card
 * simply renders without a button.
 */
export function AutomationSection({
  prefs,
  update,
  onOpenRules,
}: SecProps & { onOpenRules?: () => void }) {
  const cfg: ThresholdAutomationConfig = prefs.threshold_automation || {};
  const rules = cfg.rules || [];
  const ruleCount = rules.length;

  const setCfg = (patch: Partial<ThresholdAutomationConfig>) =>
    update({ threshold_automation: { ...cfg, ...patch } });

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Threshold automation"
        sub="Rules that react to a case AFTER the deterministic decision. Disabled by default."
      />

      <Alert>
        <Info className="h-4 w-4" aria-hidden />
        <AlertTitle>Automation can recommend, queue, or propose — never auto-close</AlertTitle>
        <AlertDescription>
          A matched rule can only{' '}
          <strong className="font-semibold text-foreground">tag</strong>,{' '}
          <strong className="font-semibold text-foreground">recommend</strong>,{' '}
          <strong className="font-semibold text-foreground">notify</strong>,{' '}
          <strong className="font-semibold text-foreground">queue a re-investigation</strong>, or{' '}
          <strong className="font-semibold text-foreground">draft a proposal</strong> for an
          approval-required action. It runs after the close/escalate decision and{' '}
          <strong className="font-semibold text-foreground">
            never sets a case&apos;s status or auto-closes it
          </strong>{' '}
          — NEEDS_HUMAN and escalated cases are always held for a human. Any write that affects the
          outside world goes through the approval queue.
        </AlertDescription>
      </Alert>

      <SwitchPref
        label="Threshold automation enabled"
        help="Master switch. When off, no automation rules run and behaviour is unchanged."
        checked={Boolean(cfg.enabled)}
        onChange={(v) => setCfg({ enabled: v })}
      />

      {/* De-dup link card: the per-rule editor now lives in the Detection & rules home so
          the same `threshold_automation.rules` list has ONE editor. This card only points
          there — it never edits a rule (#3-safe: no decide(), no status write). */}
      <div className="flex flex-col gap-3 rounded-md border border-border bg-surface px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <ListChecks className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 space-y-0.5">
            <p className="text-sm font-medium text-foreground">
              Author case-automation rules in Detection &amp; rules
            </p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Case-automation rules now live alongside detection rules in one editor.
              {ruleCount > 0
                ? ` You currently have ${ruleCount} case-automation ${ruleCount === 1 ? 'rule' : 'rules'}.`
                : ' You have no case-automation rules yet.'}
            </p>
          </div>
        </div>
        {onOpenRules ? (
          <Button variant="outline" size="sm" className="shrink-0 gap-1.5" onClick={onOpenRules}>
            <Zap className="h-4 w-4" aria-hidden />
            Open Detection &amp; rules
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
