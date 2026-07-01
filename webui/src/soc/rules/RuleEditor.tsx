/**
 * RuleEditor (Round-5 G6 · R2/R3) — the four-section rule editor shell:
 * Define → About → Schedule → Actions (Radix `Tabs`), with the **Define** tab
 * POLYMORPHIC on the `RuleForm` discriminated union over three tiers.
 *
 * Adopts Elastic's four-section pattern (RESEARCH_RULES_UX §3): logic (Define) is
 * separated from metadata (About) from ops (Schedule/Actions). Every field is
 * `Field`/`Label`-wrapped for a11y; every numeric knob uses the W0 `NumberField` /
 * `LabeledSlider` (stepper + clamp + readout); tags/allowlists use `TagInput`.
 *
 * ⛔ CONFIG WRITER ONLY (#3): this component edits a `RuleForm` in memory and hands
 * it back via `onChange`; it NEVER calls `decide()` and NEVER sets a case status. The
 * host maps the form ⇄ wire via `./adapter` and saves through the deep-merge
 * `PUT /api/settings`. Threshold/Suppression/Exceptions/MITRE are kept as DISTINCT,
 * clearly-labelled concepts (conflating them is a known analyst pitfall).
 *
 * #9: `name`/`description`/predicate `field`/`value`/tags are operator-authored →
 * rendered as plain-text inputs. #10: no secret is shown; model overrides carry a
 * selection, never a key.
 */
import * as React from 'react';
import { AlertTriangle, Info, Lock, Wrench } from 'lucide-react';

import { humanizeToken } from '@/lib/format';

import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/ui/tabs';
import { Input } from '@/ui/input';
import { Textarea } from '@/ui/textarea';
import { Switch } from '@/ui/switch';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';

import { Field } from '@/soc/components/Field';
import { NumberField } from '@/soc/components/NumberField';
import { LabeledSlider } from '@/soc/components/LabeledSlider';
import { TagInput } from '@/soc/components/TagInput';
import { SegmentedControl } from '@/soc/components/SegmentedControl';
import { HelpTip } from '@/soc/components/HelpTip';

import { ConditionBuilder } from './ConditionBuilder';
import type { RuleForm, RuleTier } from './types';
import {
  AUTOMATION_ACTIONS,
  BOUNDS,
  ENTITY_OPTIONS,
  RULE_TIERS,
  RULE_TIER_BY_ID,
  SEASONALITY_OPTIONS,
  STATUS_CONDITION_OPTIONS,
  VERDICT_CONDITION_LABELS,
  VERDICT_CONDITION_VALUES,
  hasImpossibleVerdict,
} from './constants';

const ANY = '__any__';

export interface RuleEditorProps {
  /** The rule form being edited (controlled). */
  value: RuleForm;
  onChange: (next: RuleForm) => void;
  /** Read-only preview (RBAC without `automation:manage`) — disables every control. */
  readOnly?: boolean;
  /** Allow switching the rule TIER (only for a brand-new rule; editing keeps the tier). */
  allowTierChange?: boolean;
  onTierChange?: (tier: RuleTier) => void;
}

/* ------------------------------------------------------------- About tab --- */

function AboutTab({ value, onChange, readOnly }: RuleEditorProps) {
  const about = value.about;
  const setAbout = (patch: Partial<typeof about>) => onChange({ ...value, about: { ...about, ...patch } } as RuleForm);
  const isDetection = RULE_TIER_BY_ID[value.tier].detection;

  return (
    <div className="space-y-4">
      <Field
        label="Name"
        required
        description="A human-facing rule name. Rendered as plain text everywhere."
      >
        <Input
          value={about.name}
          disabled={readOnly}
          placeholder="e.g. SSH brute-force from a single source"
          onChange={(e) => setAbout({ name: e.target.value })}
        />
      </Field>

      <Field label="Description" description="What this rule detects and why it matters.">
        <Textarea
          value={about.description}
          disabled={readOnly}
          rows={3}
          placeholder="Optional context for the on-call analyst."
          onChange={(e) => setAbout({ description: e.target.value })}
        />
      </Field>

      <NumberField
        label="Priority"
        description="Lower runs first when several rules match."
        value={about.priority}
        min={BOUNDS.priority.min}
        max={BOUNDS.priority.max}
        step={BOUNDS.priority.step}
        defaultValue={BOUNDS.priority.default}
        disabled={readOnly}
        onChange={(v) => setAbout({ priority: v })}
      />

      {isDetection ? (
        <TagInput
          label="MITRE technique ids (advisory)"
          description="Advisory only — feeds the coverage heatmap. Never changes the verdict (#3)."
          value={about.mitre ?? []}
          disabled={readOnly}
          placeholder="e.g. T1110"
          onChange={(next) => setAbout({ mitre: next })}
        />
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------- Define: match tier -- */

function DefineMatch({ value, onChange, readOnly }: RuleEditorProps & { value: Extract<RuleForm, { tier: 'detection_match' }> }) {
  const form = value;
  const th = form.threshold;
  const setThreshold = (patch: Partial<typeof th>) => onChange({ ...form, threshold: { ...th, ...patch } });
  const isThreshold = th.n > 1;
  const multiPredicate = form.predicates.length > 1;

  return (
    <div className="space-y-5">
      {/* conditions */}
      <section className="space-y-2">
        <div className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          Conditions
          <HelpTip text="Match a raw event. All rows are ANDed. The wire currently evaluates the FIRST condition; nested AND/OR is a later, opt-in feature." />
        </div>
        <ConditionBuilder
          value={form.predicates}
          disabled={readOnly}
          onChange={(next) => onChange({ ...form, predicates: next })}
        />
        {multiPredicate ? (
          <Alert variant="warning">
            <AlertTriangle className="h-4 w-4" aria-hidden />
            <AlertTitle>Only the first condition is saved</AlertTitle>
            <AlertDescription>
              A detection rule currently evaluates ONE condition. The extra rows are kept in the
              editor for the upcoming nested AND/OR feature but are not saved to the engine yet.
            </AlertDescription>
          </Alert>
        ) : null}
      </section>

      {/* threshold — DISTINCT from suppression (labelled) */}
      <section className="space-y-3 rounded-md border border-border bg-surface p-3">
        <div className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          Threshold
          <HelpTip text="Group-by + count. n=1 is a simple match rule; n>1 fires only when ≥ N matching events share the group-by within the window." />
          <Badge variant={isThreshold ? 'high' : 'secondary'} className="ml-1">
            {isThreshold ? 'Threshold rule' : 'Match rule'}
          </Badge>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Group by">
            <Select
              value={th.groupBy}
              disabled={readOnly}
              onValueChange={(v) => setThreshold({ groupBy: v as typeof th.groupBy })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ENTITY_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <NumberField
            label="Trigger after N"
            value={th.n}
            min={BOUNDS.n.min}
            max={BOUNDS.n.max}
            step={BOUNDS.n.step}
            defaultValue={BOUNDS.n.default}
            unit="events"
            disabled={readOnly}
            onChange={(v) => setThreshold({ n: v, mode: v <= 1 ? 'every' : 'threshold' })}
          />
          <NumberField
            label="Within window"
            value={th.windowSeconds}
            min={BOUNDS.windowSeconds.min}
            max={BOUNDS.windowSeconds.max}
            step={BOUNDS.windowSeconds.step}
            defaultValue={BOUNDS.windowSeconds.default}
            unit="sec"
            disabled={readOnly}
            onChange={(v) => setThreshold({ windowSeconds: v })}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {isThreshold
            ? `Fires when ${th.n} or more events share the same ${th.groupBy} within ${th.windowSeconds} seconds.`
            : `Fires on every matching event (no count gate).`}
        </p>
      </section>

      {/* suppression — DISTINCT concept, optional */}
      <SuppressionCard value={form} onChange={onChange} readOnly={readOnly} />
    </div>
  );
}

function SuppressionCard({
  value,
  onChange,
  readOnly,
}: {
  value: Extract<RuleForm, { tier: 'detection_match' }>;
  onChange: (next: RuleForm) => void;
  readOnly?: boolean;
}) {
  const on = Boolean(value.suppression);
  const sup = value.suppression;
  const setSup = (patch: Partial<NonNullable<typeof sup>>) =>
    onChange({
      ...value,
      suppression: { by: [], scope: 'per_run', missingField: 'suppress', ...(sup ?? {}), ...patch },
    });

  return (
    <section className="space-y-3 rounded-md border border-border bg-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          Suppression
          <HelpTip text="Collapse alert storms by grouping matching events. Distinct from Threshold. Never DROPS a candidate — it only collapses duplicates (#4)." />
        </div>
        <Switch
          checked={on}
          disabled={readOnly}
          aria-label="Enable suppression"
          onCheckedChange={(v) =>
            onChange({
              ...value,
              suppression: v ? { by: [], scope: 'per_run', missingField: 'suppress' } : undefined,
            })
          }
        />
      </div>
      {on && sup ? (
        <div className="space-y-4">
          <TagInput
            label="Suppress by (up to 3 fields)"
            description="Collapse events that share these fields."
            value={sup.by}
            max={3}
            disabled={readOnly}
            placeholder="e.g. source_ip"
            onChange={(next) => setSup({ by: next })}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Scope">
              <SegmentedControl
                aria-label="Suppression scope"
                value={sup.scope}
                options={[
                  { value: 'per_run', label: 'Per run' },
                  { value: 'per_window', label: 'Per time window' },
                ]}
                disabled={readOnly}
                onValueChange={(v) => setSup({ scope: v as typeof sup.scope })}
              />
            </Field>
            {sup.scope === 'per_window' ? (
              <NumberField
                label="Suppression window"
                value={sup.windowSeconds ?? 300}
                min={1}
                max={86400}
                step={1}
                unit="sec"
                disabled={readOnly}
                onChange={(v) => setSup({ windowSeconds: v })}
              />
            ) : null}
          </div>
          <Field label="When a field is missing">
            <SegmentedControl
              aria-label="Missing-field behaviour"
              value={sup.missingField}
              options={[
                { value: 'suppress', label: 'Suppress' },
                { value: 'keep', label: 'Do not suppress' },
              ]}
              disabled={readOnly}
              onValueChange={(v) => setSup({ missingField: v as typeof sup.missingField })}
            />
          </Field>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Off — every matching cluster is surfaced.</p>
      )}
    </section>
  );
}

/* -------------------------------------------------- Define: anomaly tier -- */

function DefineAnomaly({ value, onChange, readOnly }: RuleEditorProps & { value: Extract<RuleForm, { tier: 'detection_anomaly' }> }) {
  const form = value;
  const an = form.anomaly;
  const setAnomaly = (patch: Partial<typeof an>) => onChange({ ...form, anomaly: { ...an, ...patch } });

  return (
    <div className="space-y-5">
      <Alert variant="info">
        <Info className="h-4 w-4" aria-hidden />
        <AlertTitle>Anomaly rules are advisory</AlertTitle>
        <AlertDescription>
          A deviation raises a CANDIDATE that re-enters the normal correlate/decide pipeline. It
          never auto-closes and never overrides the deterministic decision (#3).
        </AlertDescription>
      </Alert>

      <Field label="Group by" description="The signature whose hour-of-week baseline is learned.">
        <Select
          value={an.groupBy}
          disabled={readOnly}
          onValueChange={(v) => setAnomaly({ groupBy: v as typeof an.groupBy })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ENTITY_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <LabeledSlider
        label="Sensitivity (modified-z)"
        description="Lower = more sensitive (more anomalies). Default |M| > 3.5."
        value={an.sensitivity}
        min={BOUNDS.sensitivity.min}
        max={BOUNDS.sensitivity.max}
        step={BOUNDS.sensitivity.step}
        disabled={readOnly}
        formatValue={(v) => `|M| > ${v.toFixed(1)}`}
        ticks={[
          { value: 2, label: '2 (loose)' },
          { value: 3.5, label: '3.5' },
          { value: 6, label: '6 (strict)' },
        ]}
        onChange={(v) => setAnomaly({ sensitivity: v })}
      />

      <NumberField
        label="Warm-up multiplier"
        description="warmup × min-samples must accrue before a cold series can fire."
        value={an.warmupMultiplier}
        min={BOUNDS.warmupMultiplier.min}
        max={BOUNDS.warmupMultiplier.max}
        step={BOUNDS.warmupMultiplier.step}
        defaultValue={BOUNDS.warmupMultiplier.default}
        disabled={readOnly}
        onChange={(v) => setAnomaly({ warmupMultiplier: v })}
      />

      <Field label="Seasonality" description="How observations are bucketed for the baseline.">
        <Select
          value={an.seasonality}
          disabled={readOnly}
          onValueChange={(v) => setAnomaly({ seasonality: v as typeof an.seasonality })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SEASONALITY_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </div>
  );
}

/* ------------------------------------------ Define: case-automation tier -- */

function DefineCaseAutomation({
  value,
  onChange,
  readOnly,
}: RuleEditorProps & { value: Extract<RuleForm, { tier: 'case_automation' }> }) {
  const form = value;
  const cond = form.automation.conditions;
  const setCond = (patch: Partial<typeof cond>) =>
    onChange({ ...form, automation: { ...form.automation, conditions: { ...cond, ...patch } } });
  const invalidVerdict = hasImpossibleVerdict(cond.verdict);

  return (
    <div className="space-y-5">
      <Alert variant="warning">
        <Lock className="h-4 w-4" aria-hidden />
        <AlertTitle>Runs after the deterministic decision — never sets status</AlertTitle>
        <AlertDescription>
          A matched rule can only tag, recommend, notify, queue a re-investigation, or draft an
          approval proposal. It NEVER closes or changes a case&apos;s status (#3, code-enforced).
        </AlertDescription>
      </Alert>

      <section className="space-y-3">
        <div className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          When a case matches (all ANDed)
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Verdict"
            error={
              invalidVerdict
                ? 'This rule will never fire: a verdict is only ever true/false positive or needs-human.'
                : undefined
            }
          >
            <Select
              value={cond.verdict || ANY}
              disabled={readOnly}
              onValueChange={(v) => setCond({ verdict: v === ANY ? undefined : v })}
            >
              <SelectTrigger aria-invalid={invalidVerdict || undefined}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any verdict</SelectItem>
                {VERDICT_CONDITION_VALUES.map((v) => (
                  <SelectItem key={v} value={v}>
                    {VERDICT_CONDITION_LABELS[v]}
                  </SelectItem>
                ))}
                {invalidVerdict && typeof cond.verdict === 'string' ? (
                  <SelectItem value={cond.verdict} disabled>
                    {cond.verdict} (invalid)
                  </SelectItem>
                ) : null}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Status">
            <Select
              value={cond.status || ANY}
              disabled={readOnly}
              onValueChange={(v) => setCond({ status: v === ANY ? undefined : v })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any status</SelectItem>
                {STATUS_CONDITION_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <NumberField
            label="Minimum risk"
            value={typeof cond.min_risk === 'number' ? cond.min_risk : 0}
            min={BOUNDS.minRisk.min}
            max={BOUNDS.minRisk.max}
            step={BOUNDS.minRisk.step}
            unit="/100"
            disabled={readOnly}
            onChange={(v) => setCond({ min_risk: v === 0 ? undefined : v })}
          />
          <NumberField
            label="Minimum severity"
            value={typeof cond.min_severity === 'number' ? cond.min_severity : 0}
            min={BOUNDS.minSeverity.min}
            max={BOUNDS.minSeverity.max}
            step={BOUNDS.minSeverity.step}
            disabled={readOnly}
            onChange={(v) => setCond({ min_severity: v === 0 ? undefined : v })}
          />

          <Field label="Source id (optional)">
            <Input
              value={cond.source_id || ''}
              disabled={readOnly}
              placeholder="Any source"
              onChange={(e) => setCond({ source_id: e.target.value || undefined })}
            />
          </Field>
          <Field label="Rule name contains (optional)">
            <Input
              value={cond.rule_name || ''}
              disabled={readOnly}
              placeholder="Any rule"
              onChange={(e) => setCond({ rule_name: e.target.value || undefined })}
            />
          </Field>
        </div>

        {invalidVerdict ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1"
            disabled={readOnly}
            onClick={() => setCond({ verdict: undefined })}
          >
            <Wrench className="h-3.5 w-3.5" aria-hidden />
            Clear the invalid verdict
          </Button>
        ) : null}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------ Define tab -- */

function DefineTab(props: RuleEditorProps) {
  const { value } = props;
  if (value.tier === 'detection_match') return <DefineMatch {...props} value={value} />;
  if (value.tier === 'detection_anomaly') return <DefineAnomaly {...props} value={value} />;
  return <DefineCaseAutomation {...props} value={value} />;
}

/* ---------------------------------------------------------- Schedule tab -- */

function ScheduleTab({ value, onChange, readOnly }: RuleEditorProps) {
  // Case-automation reacts post-decision (no schedule of its own).
  if (value.tier === 'case_automation') {
    return (
      <Alert variant="info">
        <Info className="h-4 w-4" aria-hidden />
        <AlertTitle>No schedule</AlertTitle>
        <AlertDescription>
          Case-automation rules evaluate immediately after each case is decided — there is no
          separate run schedule.
        </AlertDescription>
      </Alert>
    );
  }
  const sched = value.schedule ?? {};
  const setSched = (patch: Partial<typeof sched>) =>
    onChange({ ...value, schedule: { ...sched, ...patch } } as RuleForm);

  return (
    <div className="space-y-4">
      <Alert variant="info">
        <Info className="h-4 w-4" aria-hidden />
        <AlertTitle>Cadence comes from the source feed</AlertTitle>
        <AlertDescription>
          Detection rules run on the poller&apos;s durable per-feed cursor. These are optional
          per-rule overrides; leave blank to inherit the feed schedule.
        </AlertDescription>
      </Alert>
      <NumberField
        label="Run every"
        description="Optional override — how often this rule evaluates."
        value={sched.intervalSeconds ?? 0}
        min={0}
        max={86400}
        step={1}
        unit="sec"
        disabled={readOnly}
        onChange={(v) => setSched({ intervalSeconds: v === 0 ? undefined : v })}
      />
      <NumberField
        label="Additional look-back"
        description="Extra window each run to catch late-arriving events."
        value={sched.lookbackSeconds ?? 0}
        min={0}
        max={86400}
        step={1}
        unit="sec"
        disabled={readOnly}
        onChange={(v) => setSched({ lookbackSeconds: v === 0 ? undefined : v })}
      />
    </div>
  );
}

/* ----------------------------------------------------------- Actions tab -- */

function ActionsTab({ value, onChange, readOnly }: RuleEditorProps) {
  // Only case-automation carries a bound action; detection tiers create candidate cases.
  if (value.tier !== 'case_automation') {
    return (
      <Alert variant="info">
        <Info className="h-4 w-4" aria-hidden />
        <AlertTitle>Detection rules create candidate cases</AlertTitle>
        <AlertDescription>
          A detection rule&apos;s survivors re-enter the normal correlate/decide pipeline. To react
          to the RESULTING case (tag/notify/propose), add a Case-automation rule.
        </AlertDescription>
      </Alert>
    );
  }
  const auto = value.automation;
  const setPayload = (patch: Record<string, unknown>) =>
    onChange({ ...value, automation: { ...auto, payload: { ...auto.payload, ...patch } } });
  const actionMeta = AUTOMATION_ACTIONS.find((a) => a.value === auto.action);

  return (
    <div className="space-y-4">
      <Field label="Action" description={actionMeta?.help}>
        <Select
          value={String(auto.action)}
          disabled={readOnly}
          onValueChange={(v) => onChange({ ...value, automation: { ...auto, action: v, payload: {} } })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AUTOMATION_ACTIONS.map((a) => (
              <SelectItem key={String(a.value)} value={String(a.value)}>
                {a.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Badge variant="warning" className="gap-1">
        <Lock className="h-3 w-3" aria-hidden />
        Proposal / recommend only — never auto-closes
      </Badge>

      {auto.action === 'tag' ? (
        <TagInput
          label="Tags"
          value={Array.isArray(auto.payload.tags) ? (auto.payload.tags as string[]) : []}
          disabled={readOnly}
          placeholder="e.g. auto-triaged"
          onChange={(next) => setPayload({ tags: next })}
        />
      ) : null}
      {auto.action === 'recommend' ? (
        <Field label="Recommendation text">
          <Input
            value={typeof auto.payload.text === 'string' ? auto.payload.text : ''}
            disabled={readOnly}
            placeholder="e.g. Review with the identity team"
            onChange={(e) => setPayload({ text: e.target.value })}
          />
        </Field>
      ) : null}
      {auto.action === 'notify' ? (
        <Field label="Channel id (optional)">
          <Input
            value={typeof auto.payload.channel_id === 'string' ? auto.payload.channel_id : ''}
            disabled={readOnly}
            placeholder="All enabled channels"
            onChange={(e) => setPayload({ channel_id: e.target.value })}
          />
        </Field>
      ) : null}
      {auto.action === 'run_playbook' ? (
        <Field label="Playbook id">
          <Input
            value={typeof auto.payload.playbook_id === 'string' ? auto.payload.playbook_id : ''}
            disabled={readOnly}
            placeholder="playbook id"
            onChange={(e) => setPayload({ playbook_id: e.target.value })}
          />
        </Field>
      ) : null}
      {auto.action === 'request_approval' ? (
        <Field label="Proposal kind">
          <Input
            value={typeof auto.payload.kind === 'string' ? auto.payload.kind : ''}
            disabled={readOnly}
            placeholder="e.g. suppression"
            onChange={(e) => setPayload({ kind: e.target.value })}
          />
        </Field>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------- the shell -- */

export function RuleEditor(props: RuleEditorProps) {
  const { value, readOnly, allowTierChange, onTierChange } = props;
  const [tab, setTab] = React.useState('define');

  return (
    <div className="space-y-4">
      {/* enabled + tier header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Switch
            checked={value.about.enabled}
            disabled={readOnly}
            aria-label="Rule enabled"
            onCheckedChange={(v) => props.onChange({ ...value, about: { ...value.about, enabled: v } } as RuleForm)}
          />
          <span className="text-sm text-muted-foreground">
            {value.about.enabled ? 'Enabled' : 'Disabled'}
          </span>
        </div>
        <div className="min-w-[16rem]">
          {allowTierChange ? (
            <Select
              value={value.tier}
              onValueChange={(v) => onTierChange?.(v as RuleTier)}
              disabled={readOnly}
            >
              <SelectTrigger aria-label="Rule type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RULE_TIERS.map((t) => (
                  <SelectItem key={t.tier} value={t.tier}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Badge variant="secondary">{RULE_TIER_BY_ID[value.tier].label}</Badge>
          )}
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label="Rule editor sections">
          <TabsTrigger value="define">Define</TabsTrigger>
          <TabsTrigger value="about">About</TabsTrigger>
          <TabsTrigger value="schedule">Schedule</TabsTrigger>
          <TabsTrigger value="actions">Actions</TabsTrigger>
        </TabsList>
        <TabsContent value="define" className="pt-4">
          <DefineTab {...props} />
        </TabsContent>
        <TabsContent value="about" className="pt-4">
          <AboutTab {...props} />
        </TabsContent>
        <TabsContent value="schedule" className="pt-4">
          <ScheduleTab {...props} />
        </TabsContent>
        <TabsContent value="actions" className="pt-4">
          <ActionsTab {...props} />
        </TabsContent>
      </Tabs>

      {readOnly ? (
        <p className="text-xs text-muted-foreground">
          {humanizeToken('read_only')} — you can view this rule but not change it.
        </p>
      ) : null}
    </div>
  );
}
RuleEditor.displayName = 'RuleEditor';
