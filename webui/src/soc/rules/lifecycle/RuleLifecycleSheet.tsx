/**
 * RuleLifecycleSheet (Round-5 G6 · R5) — the per-rule LIFECYCLE surface: test/preview
 * a rule against recent data, walk its immutable version history (diff + rollback), and
 * move it between enabled / disabled / shadow(preview) states.
 *
 * ┌─ THE INVARIANTS ────────────────────────────────────────────────────────────┐
 * │ #3  Nothing here calls `decide()` or sets a case status. A lifecycle state      │
 * │     change is a CONFIG write the parent performs via the deep-merge buffer       │
 * │     (`onLifecycleChange`); a rollback is a config write on the RB endpoint.      │
 * │ #6  Preview is a pure read — it never bills the LLM (zero UsageDoc).             │
 * │ #2  Every state change / rollback is append-only audited + versioned server-side.│
 * │ #9  Every rule name / field / summary / log value renders PLAIN text.           │
 * └────────────────────────────────────────────────────────────────────────────────┘
 *
 * "Tune" is the PRIMARY CTA over "Disable" (RESEARCH_RULES_UX §6a — disabling a noisy
 * rule instead of tuning it is the #1 SIEM anti-pattern). Disabling a live rule reduces
 * coverage, so it is a secondary, confirm-gated action; a `request_approval`-style
 * risky change is surfaced as routing to the Approvals/Proposals HITL queue.
 */
import * as React from 'react';
import { Pencil, Power, ShieldQuestion } from 'lucide-react';

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/ui/sheet';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/ui/tabs';
import { Button } from '@/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { ConfirmDialog } from '@/soc/components/ConfirmDialog';
import { HelpTip } from '@/soc/components/HelpTip';
import { SegmentedControl } from '@/soc/components/SegmentedControl';

import type { RuleForm } from '../types';
import { RuleVersionLedger } from './RuleVersionLedger';
import { LifecycleStateChip, RuleHealthChip, deriveHealth } from './chips';
import type { RuleHealth, RuleKind, RuleLifecycleState, RulePreviewResult } from './types';

// The preview panel pulls in recharts (the histogram). Lazy-load it so recharts stays
// OFF the first-paint bundle (the Settings/Detection-rules home is statically
// reachable); the chart JS is only fetched when an operator opens the preview tab.
// A dynamic import here is what the bundle-first-paint guard explicitly allows.
const RulePreviewPanel = React.lazy(() =>
  import('./RulePreviewPanel').then((m) => ({ default: m.RulePreviewPanel })),
);

export interface RuleLifecycleSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The rule being managed (for the preview predicate + display name). */
  rule: RuleForm;
  /** The version-ledger coordinates (family + rule key). */
  kind: RuleKind;
  ruleId: string;
  /** Current lifecycle state (enabled/disabled/shadow). */
  state: RuleLifecycleState;
  /** RBAC: only a manager may change state or roll back. */
  canManage?: boolean;
  /**
   * A lifecycle state change (enabled/disabled/shadow). The PARENT maps this to a
   * deep-merge config write (never `decide()`), so this component stays a pure
   * presenter. Omit to render the controls read-only.
   */
  onLifecycleChange?: (next: RuleLifecycleState) => void;
  /** Open the full rule editor to "tune" (the PRIMARY CTA). */
  onTune?: () => void;
  /** Called after a rollback so the parent can refetch the rule config. */
  onRolledBack?: (restoredFrom: string) => void;
}

export function RuleLifecycleSheet({
  open,
  onOpenChange,
  rule,
  kind,
  ruleId,
  state,
  canManage = false,
  onLifecycleChange,
  onTune,
  onRolledBack,
}: RuleLifecycleSheetProps) {
  // Health is derived from the last preview outcome (updated as the operator runs it).
  const [health, setHealth] = React.useState<RuleHealth>(() => deriveHealth({ state }));
  React.useEffect(() => {
    // Re-baseline health when the rule's state changes and no preview has run yet.
    setHealth((h) => (h.status === 'ok' || h.status === 'warning' || h.status === 'failed' ? h : deriveHealth({ state })));
  }, [state]);

  const onPreviewResult = React.useCallback(
    (res: RulePreviewResult) =>
      setHealth(deriveHealth({ state, lastMatched: res.matched, lastScanned: res.scanned })),
    [state],
  );
  const onPreviewError = React.useCallback(
    () => setHealth(deriveHealth({ state, lastErrored: true })),
    [state],
  );

  // Disabling a LIVE rule reduces coverage — gate it behind an explicit confirm.
  const [confirmDisable, setConfirmDisable] = React.useState(false);

  const applyState = (next: RuleLifecycleState) => {
    if (!onLifecycleChange || next === state) return;
    if (next === 'disabled' && state !== 'disabled') {
      setConfirmDisable(true);
      return;
    }
    onLifecycleChange(next);
  };

  const displayName = rule.about?.name || ruleId;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" size="xl" className="flex w-full flex-col">
        <SheetHeader>
          <SheetTitle className="flex flex-wrap items-center gap-2">
            <span>Lifecycle · {displayName}</span>
            <LifecycleStateChip state={state} />
            <RuleHealthChip health={health} />
          </SheetTitle>
          <SheetDescription>
            Test this rule against recent data, review its version history, and choose its state.
            Everything here writes configuration only — it never changes a case decision.
          </SheetDescription>
        </SheetHeader>

        {/* Lifecycle control bar — "Tune" is the PRIMARY CTA over "Disable". */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border pb-3">
          {onTune ? (
            <Button size="sm" onClick={onTune}>
              <Pencil className="h-4 w-4" aria-hidden />
              Tune rule
            </Button>
          ) : null}

          <div className="flex items-center gap-1.5">
            <SegmentedControl
              size="sm"
              aria-label="Rule state"
              value={state}
              onValueChange={(v) => applyState(v as RuleLifecycleState)}
              disabled={!canManage || !onLifecycleChange}
              options={[
                { value: 'enabled', label: 'Enabled' },
                { value: 'shadow', label: 'Shadow' },
                { value: 'disabled', label: 'Disabled' },
              ]}
            />
            <HelpTip text="Shadow evaluates the rule against live data but creates no real cases — safe to run a new or retuned rule before it can escalate. Disabling a live rule reduces coverage; prefer tuning it." />
          </div>
        </div>

        {state === 'shadow' ? (
          <Alert variant="info">
            <ShieldQuestion className="h-4 w-4" aria-hidden />
            <AlertTitle>Shadow (preview) mode</AlertTitle>
            <AlertDescription>
              This rule evaluates against live data but creates no real cases — it is advisory only
              until you promote it to Enabled.
            </AlertDescription>
          </Alert>
        ) : null}

        <Tabs defaultValue="preview" className="flex min-h-0 flex-1 flex-col">
          <TabsList>
            <TabsTrigger value="preview">Test &amp; preview</TabsTrigger>
            <TabsTrigger value="history">Version history</TabsTrigger>
          </TabsList>

          <div className="min-h-0 flex-1 overflow-y-auto pt-3">
            <TabsContent value="preview" className="mt-0">
              <React.Suspense
                fallback={
                  <p className="py-6 text-center text-sm text-muted-foreground">Loading preview…</p>
                }
              >
                <RulePreviewPanel rule={rule} onResult={onPreviewResult} onError={onPreviewError} />
              </React.Suspense>
            </TabsContent>
            <TabsContent value="history" className="mt-0">
              <RuleVersionLedger
                kind={kind}
                ruleId={ruleId}
                canManage={canManage}
                onRolledBack={onRolledBack}
              />
            </TabsContent>
          </div>
        </Tabs>

        <ConfirmDialog
          open={confirmDisable}
          onOpenChange={(o) => {
            if (!o) setConfirmDisable(false);
          }}
          destructive
          title="Disable this rule?"
          description="Disabling a live rule reduces detection coverage. Consider tuning it instead — a noisy rule is usually better narrowed than turned off. This writes configuration only; it never changes a case."
          confirmLabel="Disable rule"
          onConfirm={() => {
            setConfirmDisable(false);
            onLifecycleChange?.('disabled');
          }}
        >
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 p-2 text-xs text-muted-foreground">
            <Power className="h-4 w-4 shrink-0" aria-hidden />
            The rule stops producing candidates until re-enabled. This is recorded as a version you
            can roll back.
          </div>
        </ConfirmDialog>
      </SheetContent>
    </Sheet>
  );
}
RuleLifecycleSheet.displayName = 'RuleLifecycleSheet';
