/**
 * Case Manager — concise, case-specific investigation-input provenance.
 *
 * Every item comes from the latest run's append-only audit projection.  Nothing is
 * inferred from feature enablement or mutable current settings.  Log/model/operator
 * text is rendered as text only (#9), and the authority note keeps these advisory
 * inputs separate from the deterministic close/escalate decision (#3).
 */
import * as React from 'react';
import {
  BookMarked,
  BookOpen,
  Brain,
  RefreshCw,
  SlidersHorizontal,
  Workflow,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type { CaseRationale, RationalePlatformTuning } from '@/lib/types';
import { cn } from '@/lib/cn';
import { Button } from '@/ui/button';
import { Skeleton } from '@/ui/skeleton';

type InputItem = {
  key: string;
  label: string;
  value: string;
  icon: LucideIcon;
};

function plural(count: number, singular: string, multiple = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : multiple}`;
}

export function isRunbookSource(source?: string): boolean {
  const normalized = (source || '').trim().toLowerCase();
  return normalized === 'runbook' || normalized.startsWith('runbook:');
}

export function tuningSummary(records: RationalePlatformTuning[]): string {
  if (records.length !== 1) return plural(records.length, 'tuned threshold');
  const record = records[0];
  const before = typeof record.before === 'number' ? record.before : null;
  const after = typeof record.after === 'number' ? record.after : null;
  const values = before !== null && after !== null ? ` ${before} → ${after}` : '';
  if (record.target === 'correlation_n') return `Correlation threshold${values}`;
  if (record.target === 'severity_floor') return `Severity floor${values}`;
  return `Tuned threshold${values}`;
}

export const InvestigationInputs: React.FC<{
  rationale: CaseRationale | null;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  onReview?: () => void;
  className?: string;
}> = ({ rationale, loading = false, error, onRetry, onReview, className }) => {
  const knowledge = rationale?.knowledge || [];
  const runbooks = knowledge.filter((item) => isRunbookSource(item.source));
  const otherKnowledge = knowledge.filter((item) => !isRunbookSource(item.source));
  const memories = (rationale?.memory_used || []).filter((item) => item.trim());
  const playbook = rationale?.playbook;
  const tuning = rationale?.platform_tuning || [];
  const tuningUnavailable = rationale?.platform_tuning_status === 'unavailable';

  const items: InputItem[] = [];
  if (memories.length) {
    items.push({
      key: 'memory',
      label: 'Memory',
      value: plural(memories.length, 'approved operator fact'),
      icon: Brain,
    });
  }
  if (otherKnowledge.length) {
    items.push({
      key: 'knowledge',
      label: 'Knowledge',
      value: plural(otherKnowledge.length, 'retrieved reference'),
      icon: BookOpen,
    });
  }
  if (runbooks.length) {
    items.push({
      key: 'runbook',
      label: 'Runbook',
      value: plural(runbooks.length, 'retrieved reference'),
      icon: BookMarked,
    });
  }
  // New rationale rows set consulted explicitly.  Treat an omitted flag as true
  // only for backward-compatible rows whose endpoint already returned a non-empty id.
  if (playbook?.id && playbook.consulted !== false) {
    items.push({
      key: 'playbook',
      label: 'Playbook',
      value: playbook.version ? `${playbook.id} · v${playbook.version}` : playbook.id,
      icon: Workflow,
    });
  }
  if (tuning.length) {
    items.push({
      key: 'platform-tuning',
      label: 'Platform tuning',
      value: tuningSummary(tuning),
      icon: SlidersHorizontal,
    });
  } else if (tuningUnavailable) {
    items.push({
      key: 'platform-tuning-unavailable',
      label: 'Platform tuning',
      value: 'Provenance unavailable',
      icon: SlidersHorizontal,
    });
  }
  const recordedItemCount = items.filter(
    (item) => item.key !== 'platform-tuning-unavailable',
  ).length;

  if (!loading && !error && items.length === 0) return null;

  return (
    <section
      className={cn('space-y-4 border-t border-border/60 pt-6', className)}
      data-case-manager-section="investigation-inputs"
      aria-labelledby="investigation-inputs-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3
            id="investigation-inputs-heading"
            className="text-2xs font-semibold uppercase tracking-widest text-muted-foreground"
          >
            Investigation inputs
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Context and configuration recorded for this investigation.
          </p>
        </div>
        {onReview && recordedItemCount ? (
          <Button type="button" variant="outline" size="sm" onClick={onReview}>
            Review inputs
          </Button>
        ) : null}
      </div>

      {loading ? (
        <div className="flex flex-wrap gap-x-8 gap-y-3" aria-label="Loading investigation inputs">
          <Skeleton className="h-10 w-40" />
          <Skeleton className="h-10 w-44" />
          <Skeleton className="h-10 w-36" />
        </div>
      ) : error ? (
        <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground" role="status">
          <span>Inputs unavailable.</span>
          {onRetry ? (
            <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              Retry
            </Button>
          ) : null}
        </div>
      ) : (
        <ul className="flex list-none flex-wrap gap-x-8 gap-y-4" aria-label="Recorded investigation inputs">
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <li key={item.key} className="flex min-w-[10rem] items-start gap-2.5">
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                <div className="min-w-0">
                  <div className="text-2xs font-semibold uppercase tracking-widest text-muted-foreground">
                    {item.label}
                  </div>
                  <div className="mt-0.5 break-words text-sm font-medium text-foreground">
                    {item.value}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {!loading && !error && recordedItemCount ? (
        <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
          <Workflow className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            These inputs informed preprocessing or the agent assessment. Deterministic policy
            still made the final route.
          </span>
        </p>
      ) : null}
    </section>
  );
};

export default InvestigationInputs;
