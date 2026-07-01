/**
 * Lifecycle chips (Round-5 G6 · R5) — the small, plain-text status affordances the
 * rules home + history surface render per rule:
 *
 *  - `LifecycleStateChip` — enabled / disabled / SHADOW(preview). Shadow = evaluates
 *    against live data but creates no real cases (advisory). Non-color-only: each
 *    state carries a distinct icon beside the color (WCAG 1.4.1).
 *  - `RuleHealthChip` — the "last response" health signal (ok/warning/failed/unknown).
 *    A rule that goes silent is a top breakage signal; this makes it visible.
 *
 * Both are advisory badges over the shared <Badge> primitive; every label is plain
 * text (#9). They never drive a decision (#3).
 */
import * as React from 'react';
import {
  CircleCheck,
  CircleSlash,
  Eye,
  TriangleAlert,
  CircleHelp,
  XCircle,
} from 'lucide-react';

import { Badge, type BadgeProps } from '@/ui/badge';
import { cn } from '@/lib/cn';
import type { RuleHealth, RuleHealthStatus, RuleLifecycleState } from './types';

type Variant = NonNullable<BadgeProps['variant']>;

/* ------------------------------------------------------ lifecycle state ---- */

const STATE_META: Record<
  RuleLifecycleState,
  { label: string; variant: Variant; Icon: React.ComponentType<{ className?: string }> }
> = {
  enabled: { label: 'Enabled', variant: 'success', Icon: CircleCheck },
  disabled: { label: 'Disabled', variant: 'secondary', Icon: CircleSlash },
  shadow: { label: 'Shadow (preview)', variant: 'info', Icon: Eye },
};

export interface LifecycleStateChipProps {
  state: RuleLifecycleState;
  className?: string;
}

/**
 * The enabled/disabled/shadow chip. `shadow` is deliberately styled with the neutral
 * `info` (blue-grey) so it never reads as a green "on" — a shadow rule creates no real
 * cases. The icon is the redundant non-color channel.
 */
export function LifecycleStateChip({ state, className }: LifecycleStateChipProps) {
  const meta = STATE_META[state] ?? STATE_META.disabled;
  const Icon = meta.Icon;
  return (
    <Badge variant={meta.variant} className={cn('gap-1', className)}>
      <Icon className="size-3 shrink-0" aria-hidden />
      {meta.label}
    </Badge>
  );
}
LifecycleStateChip.displayName = 'LifecycleStateChip';

/* ------------------------------------------------------------- health ------ */

const HEALTH_META: Record<
  RuleHealthStatus,
  { variant: Variant; Icon: React.ComponentType<{ className?: string }> }
> = {
  ok: { variant: 'success', Icon: CircleCheck },
  warning: { variant: 'warning', Icon: TriangleAlert },
  failed: { variant: 'critical', Icon: XCircle },
  unknown: { variant: 'secondary', Icon: CircleHelp },
};

export interface RuleHealthChipProps {
  health: RuleHealth;
  className?: string;
}

/**
 * The per-rule "last response" health chip. `label` is a short plain-text summary the
 * caller derives (e.g. "Succeeded", "No recent matches", "Never run"). Advisory (#3).
 */
export function RuleHealthChip({ health, className }: RuleHealthChipProps) {
  const meta = HEALTH_META[health.status] ?? HEALTH_META.unknown;
  const Icon = meta.Icon;
  return (
    <Badge variant={meta.variant} className={cn('gap-1', className)}>
      <Icon className="size-3 shrink-0" aria-hidden />
      {health.label}
    </Badge>
  );
}
RuleHealthChip.displayName = 'RuleHealthChip';

/* ----------------------------------------------------- health derivation --- */

/**
 * Derive an advisory health signal from a rule's last preview outcome + its recorded
 * lifecycle state. Pure + defensive. This is intentionally simple — the real "last
 * run" telemetry is the version ledger + preview; a disabled rule is `unknown`
 * (silence is expected), an enabled rule with zero recent matches is a `warning`
 * (it may be mis-tuned or the source may be silent), and a healthy match count is
 * `ok`. Never throws; unknown inputs degrade to `unknown`.
 */
export function deriveHealth(input: {
  state: RuleLifecycleState;
  /** The last preview's matched count, if a preview has been run. */
  lastMatched?: number | null;
  /** The last preview's scanned count, if a preview has been run. */
  lastScanned?: number | null;
  /** Whether the last preview errored. */
  lastErrored?: boolean;
  lastRunAt?: string | null;
}): RuleHealth {
  const { state, lastMatched, lastScanned, lastErrored, lastRunAt } = input;
  if (lastErrored) {
    return { status: 'failed', label: 'Last preview failed', lastRunAt: lastRunAt ?? null };
  }
  if (state === 'disabled') {
    return { status: 'unknown', label: 'Disabled', lastRunAt: lastRunAt ?? null };
  }
  if (typeof lastMatched !== 'number' || typeof lastScanned !== 'number') {
    return { status: 'unknown', label: 'Not yet previewed', lastRunAt: lastRunAt ?? null };
  }
  if (lastScanned === 0) {
    return { status: 'warning', label: 'No recent events', lastRunAt: lastRunAt ?? null };
  }
  if (lastMatched === 0) {
    return { status: 'warning', label: 'No recent matches', lastRunAt: lastRunAt ?? null };
  }
  const label = state === 'shadow' ? 'Matching (shadow)' : 'Matching';
  return { status: 'ok', label, lastRunAt: lastRunAt ?? null };
}
