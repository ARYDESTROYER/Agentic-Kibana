/**
 * Threshold automation settings section (Round-5 Sett-A decomposition).
 *
 * Lifted verbatim from the former `Settings.tsx` `AutomationSection` +
 * `AutomationRuleEditor`. Rules that react to a case AFTER the deterministic decision.
 *
 * INVARIANT #3: a matched rule can only tag / recommend / notify / queue a
 * re-investigation / draft an approval proposal — it NEVER sets a case's status or
 * auto-closes it. Every outside-world write goes through the approval queue.
 */
import * as React from 'react';
import { AlertTriangle, Info, Plus, Trash2, Wrench, Zap } from 'lucide-react';

import { api } from '@/lib/api';
import type { AutomationRule, Playbook, ThresholdAutomationConfig } from '@/lib/types';
import { cn } from '@/lib/cn';

import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Switch } from '@/ui/switch';
import { Badge } from '@/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';

import { EmptyState } from '@/soc/components/EmptyState';
import { HelpTip } from '@/soc/components/HelpTip';

import { SectionTitle, SwitchPref, type SecProps } from './primitives';

const AUTOMATION_ACTIONS: Array<{ value: AutomationRule['action']; text: string; help: string }> = [
  { value: 'tag', text: 'Add a tag', help: 'Attach a tag to the matched case (non-binding label).' },
  {
    value: 'recommend',
    text: 'Attach a recommendation',
    help: 'Record a non-binding recommendation note on the case.',
  },
  {
    value: 'notify',
    text: 'Send a notification',
    help: 'Fire a notification through a configured channel. Never changes the case.',
  },
  {
    value: 'run_playbook',
    text: 'Queue a playbook run',
    help: 'Re-investigate the case with a playbook injected as context. Re-runs the deterministic decision; never sets status directly.',
  },
  {
    value: 'request_approval',
    text: 'Request approval (HITL proposal)',
    help: 'Draft a Proposal for an approval-required action. Nothing goes live until a human approves it.',
  },
];

/**
 * A case-automation rule's `verdict` condition is compared against the case's
 * LLM `Verdict` — which is ONLY ever one of these three values (see backend
 * `constants.Verdict`; `engine/threshold_automation._rule_matches` does a
 * case-insensitive equality against `case.verdict.value`). `suspicious` / `benign`
 * are `Disposition` values (the investigative OUTCOME axis) and can NEVER equal a
 * `Verdict`, so a rule conditioned on them silently never fires. The dropdown is
 * therefore populated ONLY from the real `Verdict` enum. (Fix: Rules-FE bug #6.)
 */
const VERDICT_ENUM_VALUES = ['true_positive', 'false_positive', 'needs_human'] as const;

/** The canonical `{value → label}` map for a valid verdict condition. */
const VERDICT_LABELS: Record<string, string> = {
  true_positive: 'True positive',
  false_positive: 'False positive',
  needs_human: 'Needs human',
};

const VERDICT_CONDITION_OPTIONS: Array<{ value: string; text: string }> = [
  { value: '', text: 'Any verdict' },
  ...VERDICT_ENUM_VALUES.map((v) => ({ value: v, text: VERDICT_LABELS[v] })),
];

const VALID_VERDICT_SET = new Set<string>(VERDICT_ENUM_VALUES);

/**
 * True when a rule's `verdict` condition can NEVER match a real `Verdict` — i.e. it
 * is set to a non-empty value outside the enum (e.g. a legacy `suspicious`/`benign`
 * `Disposition` value). Such a rule is inert and never fires; the editor surfaces an
 * "inactive — invalid condition" badge + a one-click migrate. Comparison is
 * case-insensitive to mirror the backend matcher.
 */
function hasImpossibleVerdict(rule: AutomationRule): boolean {
  const v = rule.conditions?.verdict;
  if (typeof v !== 'string' || v === '') return false;
  return !VALID_VERDICT_SET.has(v.toLowerCase());
}

const STATUS_CONDITION_OPTIONS: Array<{ value: string; text: string }> = [
  { value: '', text: 'Any status' },
  { value: 'new', text: 'New' },
  { value: 'open', text: 'Open' },
  { value: 'investigating', text: 'Investigating' },
  { value: 'escalated', text: 'Escalated' },
  { value: 'on_hold', text: 'On hold' },
  { value: 'resolved', text: 'Resolved' },
  { value: 'closed', text: 'Closed' },
];

const ENTITY_CONDITION_OPTIONS: Array<{ value: string; text: string }> = [
  { value: '', text: 'Any entity' },
  { value: 'ip', text: 'IP' },
  { value: 'host', text: 'Host' },
  { value: 'user', text: 'User' },
  { value: 'rule', text: 'Rule' },
];

let _autoRuleSeq = 0;
function newAutomationRuleId(): string {
  _autoRuleSeq += 1;
  return `rule-${Date.now().toString(36)}-${_autoRuleSeq}`;
}

/** One editable automation rule card. */
function AutomationRuleEditor({
  rule,
  playbooks,
  onChange,
  onRemove,
}: {
  rule: AutomationRule;
  playbooks: Playbook[];
  onChange: (next: AutomationRule) => void;
  onRemove: () => void;
}) {
  const cond = rule.conditions || {};
  const setCond = (patch: Partial<typeof cond>) =>
    onChange({ ...rule, conditions: { ...cond, ...patch } });
  const invalidVerdict = hasImpossibleVerdict(rule);
  const payload = rule.payload || {};
  const setPayload = (patch: Record<string, unknown>) =>
    onChange({ ...rule, payload: { ...payload, ...patch } });
  const actionMeta = AUTOMATION_ACTIONS.find((a) => a.value === rule.action);

  // Payload editors keyed by action.
  const tagsValue = Array.isArray(payload.tags) ? (payload.tags as string[]).join(', ') : '';
  const recommendText = typeof payload.text === 'string' ? payload.text : '';
  const channelId = typeof payload.channel_id === 'string' ? payload.channel_id : '';
  const playbookId = typeof payload.playbook_id === 'string' ? payload.playbook_id : '';
  const approvalKind = typeof payload.kind === 'string' ? payload.kind : '';

  return (
    <div
      className={cn(
        'rounded-md border border-border bg-surface p-4 space-y-4',
        invalidVerdict && 'border-warning/40',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="font-mono">
            {rule.id}
          </Badge>
          <Switch
            checked={rule.enabled ?? true}
            onCheckedChange={(v) => onChange({ ...rule, enabled: v })}
            aria-label="Rule enabled"
          />
          <span className="text-xs text-muted-foreground">
            {rule.enabled ?? true ? 'Enabled' : 'Disabled'}
          </span>
          {invalidVerdict ? (
            <Badge variant="warning" className="gap-1">
              <AlertTriangle className="h-3 w-3" aria-hidden />
              Inactive — invalid condition
            </Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <Label className="text-xs">Priority</Label>
            <Input
              type="number"
              className="h-8 w-20"
              value={rule.priority ?? 100}
              onChange={(e) => onChange({ ...rule, priority: Number(e.target.value) })}
              aria-label="Priority"
            />
            <HelpTip text="Lower priority runs first when multiple rules match." />
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="text-critical hover:text-critical"
            onClick={onRemove}
            aria-label="Remove rule"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* conditions */}
      <div>
        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          When a case matches
          <HelpTip text="All set conditions must hold (ANDed). Leave a field at 'Any' to ignore it." />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs">Verdict</Label>
            <Select
              value={cond.verdict || '__any__'}
              onValueChange={(v) => setCond({ verdict: v === '__any__' ? undefined : v })}
            >
              <SelectTrigger
                className={cn('h-9', invalidVerdict && 'border-warning/60')}
                aria-label="Verdict"
                aria-invalid={invalidVerdict || undefined}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VERDICT_CONDITION_OPTIONS.map((o) => (
                  <SelectItem key={o.value || '__any__'} value={o.value || '__any__'}>
                    {o.text}
                  </SelectItem>
                ))}
                {/* Surface a legacy invalid value (e.g. a `suspicious`/`benign`
                    Disposition) so the operator can SEE what is set — it renders
                    plain (#9) and cannot be re-selected once migrated away. */}
                {invalidVerdict && typeof cond.verdict === 'string' ? (
                  <SelectItem value={cond.verdict} disabled>
                    {cond.verdict} (invalid)
                  </SelectItem>
                ) : null}
              </SelectContent>
            </Select>
            {invalidVerdict ? (
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-2.5 py-2">
                <p className="min-w-0 flex-1 text-xs leading-relaxed text-warning-text">
                  This rule will never fire: a case verdict is only ever{' '}
                  <span className="font-medium">true positive</span>,{' '}
                  <span className="font-medium">false positive</span>, or{' '}
                  <span className="font-medium">needs human</span>. Migrate to clear the
                  invalid condition (the rule&apos;s other conditions are kept).
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0 gap-1"
                  onClick={() => setCond({ verdict: undefined })}
                >
                  <Wrench className="h-3.5 w-3.5" aria-hidden />
                  Migrate
                </Button>
              </div>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Status</Label>
            <Select
              value={cond.status || '__any__'}
              onValueChange={(v) => setCond({ status: v === '__any__' ? undefined : v })}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_CONDITION_OPTIONS.map((o) => (
                  <SelectItem key={o.value || '__any__'} value={o.value || '__any__'}>
                    {o.text}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Minimum risk (0–100)</Label>
            <Input
              type="number"
              min={0}
              max={100}
              className="h-9"
              value={typeof cond.min_risk === 'number' ? cond.min_risk : ''}
              placeholder="Any"
              onChange={(e) =>
                setCond({
                  min_risk: e.target.value === '' ? undefined : Number(e.target.value),
                })
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Minimum severity</Label>
            <Input
              type="number"
              min={0}
              className="h-9"
              value={typeof cond.min_severity === 'number' ? cond.min_severity : ''}
              placeholder="Any"
              onChange={(e) =>
                setCond({
                  min_severity: e.target.value === '' ? undefined : Number(e.target.value),
                })
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Entity type</Label>
            <Select
              value={cond.entity_type || '__any__'}
              onValueChange={(v) => setCond({ entity_type: v === '__any__' ? undefined : v })}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ENTITY_CONDITION_OPTIONS.map((o) => (
                  <SelectItem key={o.value || '__any__'} value={o.value || '__any__'}>
                    {o.text}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Source id (optional)</Label>
            <Input
              className="h-9"
              value={cond.source_id || ''}
              placeholder="Any source"
              onChange={(e) => setCond({ source_id: e.target.value || undefined })}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label className="text-xs">Rule name contains (optional)</Label>
            <Input
              className="h-9"
              value={cond.rule_name || ''}
              placeholder="Any rule"
              onChange={(e) => setCond({ rule_name: e.target.value || undefined })}
            />
          </div>
        </div>
      </div>

      {/* action */}
      <div>
        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Then
          <HelpTip text="The action automation takes. It can only recommend / queue / propose — it never closes a case or sets its status." />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs">Action</Label>
            <Select
              value={rule.action}
              onValueChange={(v) => onChange({ ...rule, action: v as AutomationRule['action'], payload: {} })}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AUTOMATION_ACTIONS.map((a) => (
                  <SelectItem key={a.value} value={String(a.value)}>
                    {a.text}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {actionMeta ? (
              <p className="text-xs text-muted-foreground">{actionMeta.help}</p>
            ) : null}
          </div>

          {/* action-specific payload */}
          <div className="space-y-1.5">
            {rule.action === 'tag' ? (
              <>
                <Label className="text-xs">Tags (comma-separated)</Label>
                <Input
                  className="h-9"
                  value={tagsValue}
                  placeholder="e.g. auto-triaged, watchlist"
                  onChange={(e) =>
                    setPayload({
                      tags: e.target.value
                        .split(',')
                        .map((t) => t.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </>
            ) : null}
            {rule.action === 'recommend' ? (
              <>
                <Label className="text-xs">Recommendation text</Label>
                <Input
                  className="h-9"
                  value={recommendText}
                  placeholder="e.g. Review with the identity team"
                  onChange={(e) => setPayload({ text: e.target.value })}
                />
              </>
            ) : null}
            {rule.action === 'notify' ? (
              <>
                <Label className="text-xs">Channel id (optional)</Label>
                <Input
                  className="h-9"
                  value={channelId}
                  placeholder="All enabled channels"
                  onChange={(e) => setPayload({ channel_id: e.target.value })}
                />
              </>
            ) : null}
            {rule.action === 'run_playbook' ? (
              <>
                <Label className="text-xs">Playbook</Label>
                {playbooks.length ? (
                  <Select
                    value={playbookId || undefined}
                    onValueChange={(v) => setPayload({ playbook_id: v })}
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue placeholder="Select a playbook…" />
                    </SelectTrigger>
                    <SelectContent>
                      {playbooks.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name || p.id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    className="h-9"
                    value={playbookId}
                    placeholder="playbook id"
                    onChange={(e) => setPayload({ playbook_id: e.target.value })}
                  />
                )}
              </>
            ) : null}
            {rule.action === 'request_approval' ? (
              <>
                <Label className="text-xs">Proposal kind</Label>
                <Input
                  className="h-9"
                  value={approvalKind}
                  placeholder="e.g. suppression"
                  onChange={(e) => setPayload({ kind: e.target.value })}
                />
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

export function AutomationSection({ prefs, update }: SecProps) {
  const cfg: ThresholdAutomationConfig = prefs.threshold_automation || {};
  const rules = cfg.rules || [];
  const [playbooks, setPlaybooks] = React.useState<Playbook[]>([]);

  React.useEffect(() => {
    let cancelled = false;
    void api
      .getPlaybooks()
      .then((res) => {
        if (!cancelled) setPlaybooks(res.enabled ? res.playbooks ?? [] : []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const setCfg = (patch: Partial<ThresholdAutomationConfig>) =>
    update({ threshold_automation: { ...cfg, ...patch } });

  const updateRule = (idx: number, next: AutomationRule) => {
    const copy = [...rules];
    copy[idx] = next;
    setCfg({ rules: copy });
  };
  const removeRule = (idx: number) => {
    setCfg({ rules: rules.filter((_, i) => i !== idx) });
  };
  const addRule = () => {
    setCfg({
      rules: [
        ...rules,
        {
          id: newAutomationRuleId(),
          enabled: true,
          priority: 100,
          conditions: {},
          action: 'tag',
          payload: { tags: [] },
        },
      ],
    });
  };

  // Show rules in the priority order the backend evaluates them.
  const ordered = React.useMemo(
    () =>
      rules
        .map((r, i) => ({ r, i }))
        .sort((a, b) => (a.r.priority ?? 100) - (b.r.priority ?? 100)),
    [rules],
  );

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

      <div className={cn('space-y-4', !cfg.enabled && 'opacity-60')}>
        {ordered.length === 0 ? (
          <EmptyState
            icon={Zap}
            compact
            title="No automation rules"
            description="Add a rule to react to cases after triage — tag them, attach a recommendation, notify a channel, queue a playbook, or draft an approval proposal."
          />
        ) : (
          ordered.map(({ r, i }) => (
            <AutomationRuleEditor
              key={r.id || i}
              rule={r}
              playbooks={playbooks}
              onChange={(next) => updateRule(i, next)}
              onRemove={() => removeRule(i)}
            />
          ))
        )}
        <Button variant="outline" size="sm" onClick={addRule}>
          <Plus className="h-4 w-4" aria-hidden />
          Add rule
        </Button>
      </div>
    </div>
  );
}
