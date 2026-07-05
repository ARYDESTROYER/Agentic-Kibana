import * as React from 'react';
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/ui/hover-card';
import type { Case } from '@/lib/types';
import { humanizeAge, humanizeToken } from '@/lib/format';
import { cn } from '@/lib/cn';
import {
  StatusBadge,
  VerdictBadge,
  RiskBadge,
  ConfidenceBadge,
  SeverityBadge,
  AutoClosedBadge,
  severityBand,
} from './badges';
import { ProvenanceTag, severityProvenance } from './ProvenanceTag';
import { InlineCode } from './CodeBlock';

export interface CaseHoverCardProps {
  /** The case to preview. */
  case: Case;
  /** The trigger element (e.g. the Case ID link / title cell). */
  children: React.ReactNode;
  openDelay?: number;
  className?: string;
}

/**
 * Hover preview of a case — a compact summary card shown when the cursor rests on
 * a case reference (the Cases-table title cell, a Scans card, etc.). All
 * case-derived text is UNTRUSTED and rendered as plain text / InlineCode only.
 */
export function CaseHoverCard({ case: c, children, openDelay = 280, className }: CaseHoverCardProps) {
  // Make the trigger keyboard-focusable so the preview is reachable on FOCUS, not only
  // on hover (WCAG 1.4.13 / 2.1.1) — Radix HoverCard opens on trigger focus too.
  // Consumers commonly pass a non-focusable <span>/<div>, so default tabIndex=0 unless
  // the child already sets one (e.g. it is itself a button/link).
  const trigger =
    React.isValidElement(children) &&
    (children.props as { tabIndex?: number }).tabIndex === undefined
      ? React.cloneElement(children as React.ReactElement<{ tabIndex?: number }>, { tabIndex: 0 })
      : children;

  // Mirror the Cases-list SEVERITY resolution so the hover preview tells the SAME
  // provenance story (Round-7 #9b/#12): prefer the backend advisory `severity_band`,
  // else derive from the deterministic `risk_score` via the ONE `severityBand` ladder.
  // WHO graded it is carried separately in `severity_source` → the ProvenanceTag flips
  // per case (SIEM-asserted vs code-derived).
  const severityBandValue =
    severityBand(c.severity_band) ??
    severityBand(typeof c.risk_score === 'number' ? c.risk_score : null);

  return (
    <HoverCard openDelay={openDelay} closeDelay={120}>
      <HoverCardTrigger asChild>{trigger}</HoverCardTrigger>
      <HoverCardContent align="start" className={cn('w-96', className)}>
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-xs text-muted-foreground">{c.case_id}</span>
          <StatusBadge status={c.status} />
        </div>
        {c.title ? (
          <div className="mt-1.5 line-clamp-2 text-sm font-semibold leading-snug">{c.title}</div>
        ) : null}

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {severityBandValue ? (
            <span className="inline-flex items-center gap-1">
              <SeverityBadge severity={severityBandValue} />
              <ProvenanceTag kind={severityProvenance(c.severity_source)} variant="icon" />
            </span>
          ) : null}
          {c.verdict ? <VerdictBadge verdict={c.verdict} /> : null}
          {typeof c.risk_score === 'number' ? <RiskBadge score={c.risk_score} /> : null}
          {typeof c.confidence === 'number' ? <ConfidenceBadge confidence={c.confidence} /> : null}
          {/* Self-hiding: renders null unless the AI auto-closed the case (terminal +
              decision_by==='agent'). The CLOSE itself is still decide()'s call (#3). */}
          <AutoClosedBadge
            status={c.status}
            decisionBy={c.decision_by}
            objectionWindowExpiresAt={c.objection_window_expires_at}
          />
        </div>

        {c.entity?.value ? (
          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <span className="uppercase tracking-wide">{humanizeToken(c.entity.type)}</span>
            <InlineCode>{c.entity.value}</InlineCode>
          </div>
        ) : null}

        {c.summary ? (
          <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-muted-foreground">{c.summary}</p>
        ) : null}

        <div className="mt-3 flex items-center justify-between border-t border-border pt-2 text-[11px] text-muted-foreground">
          <span>{c.source_name ? c.source_name : 'Case'}</span>
          <span>Updated {humanizeAge(c.updated_at || c.created_at)}</span>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

export default CaseHoverCard;
