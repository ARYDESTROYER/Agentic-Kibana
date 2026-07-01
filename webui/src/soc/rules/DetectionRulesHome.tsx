/**
 * DetectionRulesHome (Round-5 G6 · R2) — the "Detection & rules" HOME.
 *
 * This is the Settings section body for `id: 'detection_rules'` (registered under the
 * General group in `settings-sections.ts`). It lists BOTH rule families in one table —
 * detection rules from `Preferences.rule_catalog` and case-automation rules from
 * `Preferences.threshold_automation.rules` — and opens the four-section `RuleEditor`
 * (Define → About → Schedule → Actions) in a Sheet.
 *
 * ⛔ CONFIG WRITER ONLY (#3): every edit flows form → `./adapter` → the deep-merge
 * `{prefs, update}` buffer the Settings page owns (which PUTs `/api/settings`). No
 * control here calls `decide()` or sets a case status. Mutations are RBAC-gated on the
 * unified `automation:manage` grant (R9); a read-only viewer (no grant) still SEES the
 * catalog + can open the editor read-only. #9: every rule name/field renders plain.
 */
import * as React from 'react';
import { History, ListTree, Pencil, Plus, Trash2, Workflow, Zap } from 'lucide-react';

import type { Preferences } from '@/lib/types';
import { cn } from '@/lib/cn';

import { useCan } from '@/soc/components/Can';
import { EmptyState } from '@/soc/components/EmptyState';
import { Button } from '@/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from '@/ui/sheet';
import { IconButton } from '@/soc/components/IconButton';

import { RuleEditor } from './RuleEditor';
import type { RuleCatalogItem, RuleForm, RuleTier } from './types';
import { RULES_PERM, RULES_READ_PERM } from './types';
import { RULE_TIER_BY_ID, newRuleForm } from './constants';
import {
  caseAutomationToWire,
  detectionMatchToWire,
  wireToCaseAutomation,
  wireToDetectionMatch,
} from './adapter';
// Import from the specific lifecycle submodules (NOT the barrel) so the recharts-heavy
// `RulePreviewPanel` — which the barrel re-exports — is not statically pulled into the
// eager Settings/Detection-rules entry graph. The sheet lazy-loads that panel itself.
import { LifecycleStateChip } from './lifecycle/chips';
import { RuleLifecycleSheet } from './lifecycle/RuleLifecycleSheet';
import type { RuleKind, RuleLifecycleState } from './lifecycle/types';

export interface DetectionRulesHomeProps {
  prefs: Preferences;
  update: (p: Partial<Preferences>) => void;
}

/** A stable id for a freshly-created case-automation rule. */
let _autoSeq = 0;
function newAutomationId(): string {
  _autoSeq += 1;
  return `rule-${Date.now().toString(36)}-${_autoSeq}`;
}

/** Build the merged catalog table rows from both wire sources. */
function buildCatalog(prefs: Preferences): RuleCatalogItem[] {
  const detection: RuleCatalogItem[] = (prefs.rule_catalog ?? []).map((r) => ({
    key: `det:${r.name}`,
    tier: 'detection_match',
    name: r.name,
    enabled: r.enabled ?? true,
    priority: typeof r.priority === 'number' ? r.priority : 100,
    lifecycle: (r.enabled ?? true) ? 'enabled' : 'disabled',
  }));
  const automation: RuleCatalogItem[] = (prefs.threshold_automation?.rules ?? []).map((r) => ({
    key: `auto:${r.id}`,
    tier: 'case_automation',
    name: r.id,
    enabled: r.enabled ?? true,
    priority: typeof r.priority === 'number' ? r.priority : 100,
    lifecycle: (r.enabled ?? true) ? 'enabled' : 'disabled',
  }));
  return [...detection, ...automation].sort((a, b) => a.priority - b.priority);
}

const TIER_ICON: Record<RuleTier, typeof Workflow> = {
  detection_match: Workflow,
  detection_anomaly: ListTree,
  case_automation: Zap,
};

/** A single edit session's target (which wire list + index the form maps back to). */
type EditTarget =
  | { kind: 'new' }
  | { kind: 'detection'; index: number }
  | { kind: 'automation'; index: number };

export function DetectionRulesHome({ prefs, update }: DetectionRulesHomeProps) {
  const canManage = useCan(RULES_PERM.resource, RULES_PERM.action);
  // `useCan` returns true when auth/RBAC is off (back-compat), so read is implicit.
  void RULES_READ_PERM;

  const catalog = React.useMemo(() => buildCatalog(prefs), [prefs]);

  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<RuleForm | null>(null);
  const [target, setTarget] = React.useState<EditTarget | null>(null);

  // The per-rule lifecycle surface (test/preview + version ledger + state). It maps a
  // catalog item to the {kind, ruleId, form, state} the RuleLifecycleSheet needs. A
  // lifecycle STATE change is a config write through the same deep-merge `update`
  // buffer — never `decide()`; a rollback is a config write on the RB endpoint.
  const [lifecycle, setLifecycle] = React.useState<{
    kind: RuleKind;
    ruleId: string;
    form: RuleForm;
    state: RuleLifecycleState;
    item: RuleCatalogItem;
  } | null>(null);

  const startNew = () => {
    setDraft(newRuleForm('detection_match'));
    setTarget({ kind: 'new' });
    setOpen(true);
  };

  const startEdit = (item: RuleCatalogItem) => {
    if (item.tier === 'case_automation') {
      const idx = (prefs.threshold_automation?.rules ?? []).findIndex((r) => r.id === item.name);
      const rule = (prefs.threshold_automation?.rules ?? [])[idx];
      if (!rule) return;
      setDraft(wireToCaseAutomation(rule));
      setTarget({ kind: 'automation', index: idx });
    } else {
      const idx = (prefs.rule_catalog ?? []).findIndex((r) => r.name === item.name);
      const def = (prefs.rule_catalog ?? [])[idx];
      if (!def) return;
      setDraft(wireToDetectionMatch(def));
      setTarget({ kind: 'detection', index: idx });
    }
    setOpen(true);
  };

  /** Switch a brand-new rule's tier (only allowed before first save). */
  const changeTier = (tier: RuleTier) => {
    setDraft(newRuleForm(tier));
  };

  /**
   * Open the per-rule LIFECYCLE surface (test/preview + version history + state). Maps
   * the catalog item to the form + ledger coordinates. The version-ledger `kind` uses
   * the backend rule-family vocabulary (`detection`/`case_automation`), distinct from
   * the UI `RuleTier`. Anomaly rules have no per-rule catalog entry to version, so the
   * lifecycle surface is offered for detection + case-automation rules only.
   */
  const openLifecycle = (item: RuleCatalogItem) => {
    if (item.tier === 'case_automation') {
      const rule = (prefs.threshold_automation?.rules ?? []).find((r) => r.id === item.name);
      if (!rule) return;
      setLifecycle({
        kind: 'case_automation',
        ruleId: item.name,
        form: wireToCaseAutomation(rule),
        state: item.lifecycle,
        item,
      });
    } else {
      const def = (prefs.rule_catalog ?? []).find((r) => r.name === item.name);
      if (!def) return;
      setLifecycle({
        kind: 'detection',
        ruleId: item.name,
        form: wireToDetectionMatch(def),
        state: item.lifecycle,
        item,
      });
    }
  };

  /**
   * Apply a lifecycle STATE change as a CONFIG write through the deep-merge `update`
   * buffer — never `decide()`. `enabled`⇄`disabled` flips the wire `enabled` flag;
   * `shadow` maps to `enabled=true` on the wire today (there is no separate wire flag
   * yet) but is surfaced distinctly in the UI so an operator can preview safely. This
   * NEVER sets a case status (#3).
   */
  const setLifecycleState = (item: RuleCatalogItem, next: RuleLifecycleState) => {
    const enabled = next !== 'disabled';
    if (item.tier === 'case_automation') {
      const rules = (prefs.threshold_automation?.rules ?? []).map((r) =>
        r.id === item.name ? { ...r, enabled } : r,
      );
      update({ threshold_automation: { ...(prefs.threshold_automation ?? {}), rules } });
    } else {
      const catalogList = (prefs.rule_catalog ?? []).map((r) =>
        r.name === item.name ? { ...r, enabled } : r,
      );
      update({ rule_catalog: catalogList });
    }
    // Reflect the new state in the open lifecycle surface immediately.
    setLifecycle((cur) => (cur && cur.item.key === item.key ? { ...cur, state: next } : cur));
  };

  /** Deterministically map the draft form → wire and deep-merge it in. */
  const save = () => {
    if (!draft) return;
    if (draft.tier === 'case_automation') {
      const rules = [...(prefs.threshold_automation?.rules ?? [])];
      const id =
        target && target.kind === 'automation' && rules[target.index]
          ? rules[target.index].id
          : newAutomationId();
      const wire = caseAutomationToWire(draft, id);
      if (target && target.kind === 'automation') rules[target.index] = wire;
      else rules.push(wire);
      update({ threshold_automation: { ...(prefs.threshold_automation ?? {}), rules } });
    } else if (draft.tier === 'detection_match') {
      const wire = detectionMatchToWire(draft);
      if (!wire) return; // unnamed / no predicate — keep the sheet open
      const catalogList = [...(prefs.rule_catalog ?? [])];
      if (target && target.kind === 'detection') catalogList[target.index] = wire;
      else catalogList.push(wire);
      update({ rule_catalog: catalogList });
    }
    // detection_anomaly edits the shared baseline block (handled by its own settings
    // section); the sheet keeps it in-draft only until that lands. Close cleanly.
    setOpen(false);
    setDraft(null);
    setTarget(null);
  };

  const removeItem = (item: RuleCatalogItem) => {
    if (item.tier === 'case_automation') {
      const rules = (prefs.threshold_automation?.rules ?? []).filter((r) => r.id !== item.name);
      update({ threshold_automation: { ...(prefs.threshold_automation ?? {}), rules } });
    } else {
      const catalogList = (prefs.rule_catalog ?? []).filter((r) => r.name !== item.name);
      update({ rule_catalog: catalogList });
    }
  };

  return (
    <div className="space-y-4">
      <Alert variant="info">
        <Workflow className="h-4 w-4" aria-hidden />
        <AlertTitle>Rules write configuration — never the verdict</AlertTitle>
        <AlertDescription>
          Detection rules classify events into candidate cases; case-automation rules react AFTER
          the deterministic decision. The close/escalate decision is always made by deterministic
          code (#3) — a rule can recommend, tag, notify, or propose, but never sets a case status.
        </AlertDescription>
      </Alert>

      <div className="flex items-center justify-between gap-2">
        <div className="text-sm text-muted-foreground">
          {catalog.length} {catalog.length === 1 ? 'rule' : 'rules'}
        </div>
        {canManage ? (
          <Button size="sm" onClick={startNew}>
            <Plus className="h-4 w-4" aria-hidden />
            New rule
          </Button>
        ) : null}
      </div>

      {catalog.length === 0 ? (
        <EmptyState
          icon={Workflow}
          compact
          title="No rules yet"
          description="Create a detection rule to cluster events into cases, or a case-automation rule to react after triage."
          action={
            canManage ? (
              <Button size="sm" onClick={startNew}>
                <Plus className="h-4 w-4" aria-hidden />
                New rule
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="overflow-hidden rounded-md border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
                <th scope="col" className="px-3 py-2 font-medium">
                  Name
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Type
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  State
                </th>
                <th scope="col" className="px-3 py-2 font-medium tabular-nums">
                  Priority
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {catalog.map((item) => {
                const Icon = TIER_ICON[item.tier];
                return (
                  <tr key={item.key} className="border-b border-border last:border-0 hover:bg-muted/40">
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={() => startEdit(item)}
                        className="text-left font-medium text-foreground hover:underline"
                      >
                        {item.name || <span className="italic text-muted-foreground">(unnamed)</span>}
                      </button>
                    </td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Icon className="h-3.5 w-3.5" aria-hidden />
                        {RULE_TIER_BY_ID[item.tier].label}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <LifecycleStateChip state={item.lifecycle} />
                    </td>
                    <td className="px-3 py-2 tabular-nums text-muted-foreground">{item.priority}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-1">
                        {item.tier !== 'detection_anomaly' ? (
                          <IconButton
                            label={`Lifecycle & history for ${item.name || 'rule'}`}
                            size="sm"
                            variant="ghost"
                            tooltip={false}
                            onClick={() => openLifecycle(item)}
                          >
                            <History />
                          </IconButton>
                        ) : null}
                        <IconButton
                          label={`Edit ${item.name || 'rule'}`}
                          size="sm"
                          variant="ghost"
                          tooltip={false}
                          onClick={() => startEdit(item)}
                        >
                          <Pencil />
                        </IconButton>
                        {canManage ? (
                          <IconButton
                            label={`Delete ${item.name || 'rule'}`}
                            size="sm"
                            variant="ghost"
                            tooltip={false}
                            className="text-critical-text hover:text-critical-text"
                            onClick={() => removeItem(item)}
                          >
                            <Trash2 />
                          </IconButton>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Sheet open={open} onOpenChange={(v) => (v ? setOpen(true) : (setOpen(false), setDraft(null)))}>
        <SheetContent side="right" size="lg" className={cn('flex w-full flex-col sm:max-w-2xl')}>
          <SheetHeader>
            <SheetTitle>
              {target?.kind === 'new' ? 'New rule' : 'Edit rule'}
            </SheetTitle>
            <SheetDescription>
              Configure the rule across Define, About, Schedule, and Actions. Saving writes
              configuration only — it never changes a case decision.
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto py-4 pr-1">
            {draft ? (
              <RuleEditor
                value={draft}
                onChange={setDraft}
                readOnly={!canManage}
                allowTierChange={target?.kind === 'new'}
                onTierChange={changeTier}
              />
            ) : null}
          </div>

          <SheetFooter>
            <Button variant="outline" onClick={() => (setOpen(false), setDraft(null))}>
              Cancel
            </Button>
            {canManage ? <Button onClick={save}>Save rule</Button> : null}
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* Per-rule LIFECYCLE surface — test/preview + version ledger + rollback + state.
          Config writer only (#3): a state change flows through `update`; a rollback is a
          config write on the RB endpoint. Never `decide()`, never bills the LLM (#6). */}
      {lifecycle ? (
        <RuleLifecycleSheet
          open
          onOpenChange={(o) => {
            if (!o) setLifecycle(null);
          }}
          rule={lifecycle.form}
          kind={lifecycle.kind}
          ruleId={lifecycle.ruleId}
          state={lifecycle.state}
          canManage={canManage}
          onLifecycleChange={canManage ? (next) => setLifecycleState(lifecycle.item, next) : undefined}
          onTune={() => {
            const item = lifecycle.item;
            setLifecycle(null);
            startEdit(item);
          }}
        />
      ) : null}
    </div>
  );
}
DetectionRulesHome.displayName = 'DetectionRulesHome';
