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
import { AlertTriangle, History, ListTree, Pencil, Plus, Trash2, Workflow, Zap } from 'lucide-react';

import type { Preferences } from '@/lib/types';
import { cn } from '@/lib/cn';

import { useCan } from '@/soc/components/Can';
import { EmptyState } from '@/soc/components/EmptyState';
import { ConfirmDialog } from '@/soc/components/ConfirmDialog';
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
import type { AutomationRule, RuleCatalogItem, RuleForm, RuleTier } from './types';
import { RULES_PERM, RULES_READ_PERM } from './types';
import { RULE_TIER_BY_ID, newRuleForm } from './constants';
import {
  anomalyToBaseline,
  baselineToAnomaly,
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

/**
 * Derive a NEW case-automation rule's id from the operator's typed Name so the required
 * Name field is not silently discarded and shown back as an opaque machine id (#25). The
 * wire `CaseAutomationRule` is keyed only by `id`, so the id doubles as the display name.
 * Empty → auto-generate; a collision with an existing id gets a numeric suffix.
 */
export function automationIdFromName(name: string, existing: readonly AutomationRule[]): string {
  const base = name.trim();
  if (!base) return newAutomationId();
  const taken = new Set(existing.map((r) => r.id));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base} (${i})`;
    if (!taken.has(candidate)) return candidate;
  }
  return newAutomationId();
}

/** Build the merged catalog table rows from both wire sources. Each row carries its
 * source-array INDEX so edit/delete/toggle target exactly that row even when two rules
 * share a display name/id (#24). */
function buildCatalog(prefs: Preferences): RuleCatalogItem[] {
  const detection: RuleCatalogItem[] = (prefs.rule_catalog ?? []).map((r, i) => ({
    key: `det:${i}`,
    sourceIndex: i,
    tier: 'detection_match',
    name: r.name,
    enabled: r.enabled ?? true,
    priority: typeof r.priority === 'number' ? r.priority : 100,
    lifecycle: (r.enabled ?? true) ? 'enabled' : 'disabled',
  }));
  const automation: RuleCatalogItem[] = (prefs.threshold_automation?.rules ?? []).map((r, i) => ({
    key: `auto:${i}`,
    sourceIndex: i,
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
  // The unified `rules` grant (G6 R9 / M2) gates the rules-native actions — the version
  // ledger, one-click rollback, and the read-only preview all call `routes_rules.py`,
  // which enforces `rules:read`/`rules:manage`. This surface is REACHED via the `rules`
  // section gate (`settings-sections-meta.ts`, now `rules:read`).
  const canManageRules = useCan(RULES_PERM.resource, RULES_PERM.action);
  // ⚠ M2 write-path reality: this Settings SECTION persists edits through the shared
  // Settings buffer (a deep-merge `PUT /api/settings`), which the backend enforces on
  // `settings:manage` — NOT the rules-native CRUD endpoints. So a WRITE here needs BOTH
  // the unified `rules:manage` grant AND `settings:manage`. Gating the write affordances
  // on both means a custom role missing either never sees an enabled Save/Delete that
  // would then 403. For every BUILT-IN role `rules`/`settings` derive identically from
  // `settings` (`rbac/policy._settings_like`), so this is behaviour-preserving for them.
  const canWriteSettings = useCan('settings', 'manage');
  const canManage = canManageRules && canWriteSettings;
  // `useCan` returns true when auth/RBAC is off (back-compat), so read is implicit.
  void RULES_READ_PERM;

  const catalog = React.useMemo(() => buildCatalog(prefs), [prefs]);

  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<RuleForm | null>(null);
  const [target, setTarget] = React.useState<EditTarget | null>(null);
  // A validation message surfaced when Save is rejected (e.g. a nameless / condition-less
  // detection rule) so the operator is never left with a silent, dead Save button.
  const [saveError, setSaveError] = React.useState<string | null>(null);
  // A rule pending a delete confirmation — destructive deletes are gated (parity with the
  // confirm-gated Disable in the lifecycle sheet), so a single misclick can't wipe a rule.
  const [confirmDelete, setConfirmDelete] = React.useState<RuleCatalogItem | null>(null);

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
    setSaveError(null);
    setDraft(newRuleForm('detection_match'));
    setTarget({ kind: 'new' });
    setOpen(true);
  };

  const startEdit = (item: RuleCatalogItem) => {
    setSaveError(null);
    // Identify the rule by its source-array INDEX (never a name/id match), so editing one
    // of two same-named rules resolves to exactly the row clicked (#24).
    if (item.tier === 'case_automation') {
      const rule = (prefs.threshold_automation?.rules ?? [])[item.sourceIndex];
      if (!rule) return;
      setDraft(wireToCaseAutomation(rule));
      setTarget({ kind: 'automation', index: item.sourceIndex });
    } else {
      const def = (prefs.rule_catalog ?? [])[item.sourceIndex];
      if (!def) return;
      setDraft(wireToDetectionMatch(def));
      setTarget({ kind: 'detection', index: item.sourceIndex });
    }
    setOpen(true);
  };

  /** Switch a brand-new rule's tier (only allowed before first save). The anomaly tier
   * edits the shared org baseline block, so seed its form from the CURRENT baseline so
   * the operator sees (and tunes) the real values rather than blank defaults. */
  const changeTier = (tier: RuleTier) => {
    setSaveError(null);
    setDraft((cur) => {
      const base = tier === 'detection_anomaly' ? baselineToAnomaly(prefs.baseline) : newRuleForm(tier);
      const carried = cur?.about;
      if (!carried) return base;
      // Carry the shared About metadata across a tier switch so name/description/priority
      // (and MITRE, for detection tiers) the operator already typed isn't wiped (#31).
      const isDetection = RULE_TIER_BY_ID[tier].detection;
      return {
        ...base,
        about: {
          ...base.about,
          name: carried.name,
          description: carried.description,
          priority: carried.priority,
          ...(isDetection ? { mitre: carried.mitre ?? base.about.mitre ?? [] } : {}),
        },
      } as RuleForm;
    });
  };

  /**
   * Open the per-rule LIFECYCLE surface (test/preview + version history + state). Maps
   * the catalog item to the form + ledger coordinates. The version-ledger `kind` uses
   * the backend rule-family vocabulary (`detection`/`case_automation`), distinct from
   * the UI `RuleTier`. Anomaly rules have no per-rule catalog entry to version, so the
   * lifecycle surface is offered for detection + case-automation rules only.
   */
  const openLifecycle = (item: RuleCatalogItem) => {
    // Resolve the exact rule by index (#24). `ruleId` stays the wire identity
    // (detection: name; automation: id) the backend version ledger keys on.
    if (item.tier === 'case_automation') {
      const rule = (prefs.threshold_automation?.rules ?? [])[item.sourceIndex];
      if (!rule) return;
      setLifecycle({
        kind: 'case_automation',
        ruleId: rule.id,
        form: wireToCaseAutomation(rule),
        state: item.lifecycle,
        item,
      });
    } else {
      const def = (prefs.rule_catalog ?? [])[item.sourceIndex];
      if (!def) return;
      setLifecycle({
        kind: 'detection',
        ruleId: def.name,
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
    // Toggle exactly the indexed row (#24) — never every rule that happens to share a name.
    if (item.tier === 'case_automation') {
      const rules = (prefs.threshold_automation?.rules ?? []).map((r, i) =>
        i === item.sourceIndex ? { ...r, enabled } : r,
      );
      update({ threshold_automation: { ...(prefs.threshold_automation ?? {}), rules } });
    } else {
      const catalogList = (prefs.rule_catalog ?? []).map((r, i) =>
        i === item.sourceIndex ? { ...r, enabled } : r,
      );
      update({ rule_catalog: catalogList });
    }
    // Reflect the new state in the open lifecycle surface immediately.
    setLifecycle((cur) => (cur && cur.item.key === item.key ? { ...cur, state: next } : cur));
  };

  /** Deterministically map the draft form → wire and deep-merge it in. */
  const save = () => {
    if (!draft) return;
    setSaveError(null);
    if (draft.tier === 'case_automation') {
      const rules = [...(prefs.threshold_automation?.rules ?? [])];
      // Keep an EXISTING rule's stable id on edit; for a NEW rule derive the id from the
      // typed Name so the operator's input persists + shows in the list (#25).
      const id =
        target && target.kind === 'automation' && rules[target.index]
          ? rules[target.index].id
          : automationIdFromName(draft.about.name, rules);
      const wire = caseAutomationToWire(draft, id);
      if (target && target.kind === 'automation') rules[target.index] = wire;
      else rules.push(wire);
      update({ threshold_automation: { ...(prefs.threshold_automation ?? {}), rules } });
    } else if (draft.tier === 'detection_match') {
      const wire = detectionMatchToWire(draft);
      if (!wire) {
        // Surface WHY the save is a no-op instead of a silent dead button (#3-safe:
        // this only validates the form; it never calls decide()).
        setSaveError('Give the rule a name (About tab) and at least one condition with a field (Define tab) before saving.');
        return; // keep the sheet open so the operator can fix it
      }
      const catalogList = [...(prefs.rule_catalog ?? [])];
      if (target && target.kind === 'detection') catalogList[target.index] = wire;
      else catalogList.push(wire);
      update({ rule_catalog: catalogList });
    } else if (draft.tier === 'detection_anomaly') {
      // Anomaly rules configure the shared org baseline block (there is no per-rule
      // baseline on the wire yet). Persist it through the same deep-merge buffer so the
      // operator's tuning is actually saved rather than silently discarded on close.
      update({ baseline: anomalyToBaseline(draft, prefs.baseline) });
    }
    setOpen(false);
    setDraft(null);
    setTarget(null);
  };

  const removeItem = (item: RuleCatalogItem) => {
    // Delete exactly the indexed row (#24) — a name filter would wipe BOTH rules that
    // share a duplicate name.
    if (item.tier === 'case_automation') {
      const rules = (prefs.threshold_automation?.rules ?? []).filter((_, i) => i !== item.sourceIndex);
      update({ threshold_automation: { ...(prefs.threshold_automation ?? {}), rules } });
    } else {
      const catalogList = (prefs.rule_catalog ?? []).filter((_, i) => i !== item.sourceIndex);
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
        // overflow-x-auto (not overflow-hidden) so a long/unbreakable rule name on a
        // narrow viewport can be scrolled to instead of being clipped with no access (#33).
        <div className="overflow-x-auto rounded-md border border-border">
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
                            onClick={() => setConfirmDelete(item)}
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

      <Sheet
        open={open}
        onOpenChange={(v) => (v ? setOpen(true) : (setOpen(false), setDraft(null), setSaveError(null)))}
      >
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
                onChange={(next) => {
                  setSaveError(null);
                  setDraft(next);
                }}
                readOnly={!canManage}
                allowTierChange={target?.kind === 'new'}
                onTierChange={changeTier}
              />
            ) : null}
          </div>

          {saveError ? (
            <Alert variant="warning">
              <AlertTriangle className="h-4 w-4" aria-hidden />
              <AlertTitle>Can&apos;t save yet</AlertTitle>
              <AlertDescription>{saveError}</AlertDescription>
            </Alert>
          ) : null}

          <SheetFooter>
            <Button variant="outline" onClick={() => (setOpen(false), setDraft(null), setSaveError(null))}>
              Cancel
            </Button>
            {canManage ? <Button onClick={save}>Save rule</Button> : null}
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* Destructive-delete gate — parity with the confirm-gated Disable in the lifecycle
          sheet. Config writer only (#3): the confirmed delete flows through `update`. */}
      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(o) => {
          if (!o) setConfirmDelete(null);
        }}
        destructive
        title="Delete this rule?"
        description={
          confirmDelete
            ? `"${confirmDelete.name || 'This rule'}" will be removed from your configuration. This writes configuration only — it never changes a case.`
            : ''
        }
        confirmLabel="Delete rule"
        onConfirm={() => {
          if (confirmDelete) removeItem(confirmDelete);
          setConfirmDelete(null);
        }}
      />

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
          // Lifecycle-STATE changes ride the Settings buffer (→ `settings:manage`), so
          // they gate on the combined `canManage`. ROLLBACK hits the rules-native
          // endpoint (`rules:manage` only), so it gates on `canManageRules` alone (M2).
          canManage={canManage}
          canRollback={canManageRules}
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
