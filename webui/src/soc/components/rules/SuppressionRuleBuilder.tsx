/**
 * SuppressionRuleBuilder — the operator field==value suppression-rule editor (G6 R6,
 * DESIGN_STANDARD §8, RESEARCH_RULES_UX §7). Writes `Preferences.suppression_rules`
 * (a `SuppressionRuleConfig[]`) via deep-merge PUT /api/settings.
 *
 * SEMANTICS (#4 non-destructive, honestly framed): a live suppression rule drops a
 * matching event BEFORE it becomes a candidate — this is the ONE rule family that can
 * hide events, so the copy is explicit and every rule carries provenance
 * (`created_by="operator"`) + an off-switch (`enabled`) + optional expiry. It is a
 * CONFIG WRITER only: it never calls `decide()`, never sets a case status, never bills
 * an LLM (#3/#6). Agent-DRAFTED suppression rules still flow through the Approvals /
 * Proposals queue; this builder authors operator rules directly and the settings write
 * path audits the change (#2).
 *
 * Every operator-authored `field`/`value`/`reason` renders as plain text (#9).
 *
 * CONTROLLED: `rules` + `onChange`; the host owns dirty/save (StickySaveBar) and any
 * ConfirmDialog on delete of a live rule.
 */
import { Ban, Bot, Plus, Trash2, TriangleAlert } from 'lucide-react';
import type { SuppressionRuleConfig } from '@/lib/types';
import { humanizeToken } from '@/lib/format';

import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Switch } from '@/ui/switch';
import { Badge } from '@/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Field } from '@/soc/components/Field';
import { IconButton } from '@/soc/components/IconButton';
import { EmptyState } from '@/soc/components/EmptyState';

export interface SuppressionRuleBuilderProps {
  rules: SuppressionRuleConfig[];
  onChange: (next: SuppressionRuleConfig[]) => void;
  /** Called instead of a direct remove for a LIVE rule (host shows a ConfirmDialog). */
  onRequestRemove?: (index: number, rule: SuppressionRuleConfig) => void;
  disabled?: boolean;
}

/** A new, operator-authored suppression rule (provenance stamped). */
function newRule(): SuppressionRuleConfig {
  return { field: '', value: '', reason: '', enabled: true, created_by: 'operator', confidence: 1 };
}

function SuppressionRow({
  rule,
  onChange,
  onRemove,
  disabled,
}: {
  rule: SuppressionRuleConfig;
  onChange: (next: SuppressionRuleConfig) => void;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const isAgent = (rule.created_by ?? '') === 'agent';
  return (
    <div className="space-y-3 rounded-md border border-border bg-surface px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Ban className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          <span className="text-xs font-medium text-muted-foreground">Drop matching events</span>
          {isAgent ? (
            <Badge variant="secondary" className="gap-1">
              <Bot className="h-3 w-3" aria-hidden />
              agent-drafted
            </Badge>
          ) : null}
          {!(rule.enabled ?? true) ? <Badge variant="outline">disabled</Badge> : null}
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span aria-hidden>Enabled</span>
            <Switch
              checked={rule.enabled ?? true}
              disabled={disabled}
              aria-label={`Rule ${rule.enabled ?? true ? 'enabled' : 'disabled'} — toggle`}
              onCheckedChange={(v) => onChange({ ...rule, enabled: v })}
            />
          </span>
          <IconButton
            label="Remove suppression rule"
            size="md"
            variant="ghost"
            disabled={disabled}
            onClick={onRemove}
            className="text-muted-foreground hover:text-critical-text"
          >
            <Trash2 />
          </IconButton>
        </div>
      </div>

      <div className="grid items-center gap-3 sm:grid-cols-[1fr_auto_1fr]">
        <Field label="Field" hideLabel>
          <Input
            value={rule.field}
            disabled={disabled}
            placeholder="rule.name / source.ip / user.name"
            aria-label="Field to match"
            onChange={(e) => onChange({ ...rule, field: e.target.value })}
            className="font-mono text-sm"
          />
        </Field>
        <span className="text-center text-xs font-medium text-muted-foreground" aria-hidden>
          equals
        </span>
        <Field label="Value" hideLabel>
          <Input
            value={rule.value}
            disabled={disabled}
            placeholder="value to match (exact)"
            aria-label="Value to match"
            onChange={(e) => onChange({ ...rule, value: e.target.value })}
            className="font-mono text-sm"
          />
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Reason" hideLabel>
          <Input
            value={rule.reason ?? ''}
            disabled={disabled}
            placeholder="Why suppress? (e.g. known benign scanner)"
            aria-label="Suppression reason"
            onChange={(e) => onChange({ ...rule, reason: e.target.value })}
          />
        </Field>
        <Field label="Expires (optional)" hideLabel>
          <Input
            type="date"
            value={(rule.expires_at ?? '').slice(0, 10)}
            disabled={disabled}
            aria-label="Expiry date (optional)"
            onChange={(e) =>
              onChange({
                ...rule,
                expires_at: e.target.value ? `${e.target.value}T00:00:00Z` : null,
              })
            }
          />
        </Field>
      </div>

      {rule.rationale ? (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Rationale: </span>
          {rule.rationale}
        </p>
      ) : null}
      {(rule.created_by ?? '') ? (
        <p className="text-2xs text-muted-foreground">
          Created by {humanizeToken(rule.created_by)}
        </p>
      ) : null}
    </div>
  );
}

export function SuppressionRuleBuilder({
  rules,
  onChange,
  onRequestRemove,
  disabled,
}: SuppressionRuleBuilderProps) {
  const remove = (i: number) => {
    const rule = rules[i];
    // A LIVE (enabled) rule can silently hide events — route through the host's
    // ConfirmDialog when one is provided; otherwise remove directly.
    if ((rule?.enabled ?? true) && onRequestRemove) {
      onRequestRemove(i, rule);
      return;
    }
    onChange(rules.filter((_, idx) => idx !== i));
  };

  return (
    <div className="space-y-4">
      <Alert variant="warning">
        <TriangleAlert className="h-4 w-4" aria-hidden />
        <AlertTitle>Suppression drops events before triage</AlertTitle>
        <AlertDescription>
          A matching event is dropped and never becomes a candidate. Suppression can
          silently hide true positives if the match is too broad — keep rules narrow,
          set an expiry where you can, and prefer disabling over deleting. The decision
          engine is untouched: this only controls what reaches it.
        </AlertDescription>
      </Alert>

      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {rules.length} suppression rule{rules.length === 1 ? '' : 's'}
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => onChange([...rules, newRule()])}
        >
          <Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
          Add rule
        </Button>
      </div>

      {rules.length ? (
        <div className="space-y-3">
          {rules.map((rule, i) => (
            <SuppressionRow
              key={i}
              rule={rule}
              disabled={disabled}
              onChange={(nx) => onChange(rules.map((r, idx) => (idx === i ? nx : r)))}
              onRemove={() => remove(i)}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          compact
          icon={Ban}
          title="No suppression rules"
          description="Add a rule to drop a known-benign event pattern before it becomes a case."
        />
      )}
    </div>
  );
}

SuppressionRuleBuilder.displayName = 'SuppressionRuleBuilder';
