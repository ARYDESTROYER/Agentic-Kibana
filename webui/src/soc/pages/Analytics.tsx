/**
 * Analytics — the single reporting host (Round 4 / #10 declutter).
 *
 * The reporting surfaces used to be split four ways (Metrics operational / Cost /
 * Overview KPIs / Standup) and hosted here behind a SECOND tab strip that wrapped
 * the Metrics page (which had its OWN three tabs) plus a duplicate Cost tab. That
 * double strip is gone: `Metrics` now owns the ONE consolidated strip —
 *
 *   Operational | Performance | Posture | Cost
 *
 * — with Cost folded in as the single spend home. This host is a thin shell that
 * renders the unified page header and threads the route tab through so `#/metrics`
 * (Operational) and `#/cost` (Cost) deep-links land on the right view, and picking a
 * tab mirrors back into the route opts via `navigate('metrics', { tab })`.
 *
 * SECURITY (#9): the header copy is static operator-facing text; all data rendering
 * happens inside Metrics/Cost, which render backend-derived values as plain text.
 */
import { BarChart3 } from 'lucide-react';
import type { Navigate } from '@/soc/router';
import { PageHeader } from '@/soc/components/PageHeader';
import Metrics from './Metrics';

export interface AnalyticsProps {
  onNavigate?: Navigate;
  /** Active sub-tab from the route opts ('operational' | 'performance' | 'posture' | 'cost'). */
  tab?: string;
}

export default function Analytics({ onNavigate, tab }: AnalyticsProps = {}) {
  return (
    <div className="space-y-6">
      <PageHeader
        icon={BarChart3}
        eyebrow="Analytics"
        title="Analytics"
        description="Triage performance, security posture, and LLM spend — the metrics, the posture rollup, and the cost ledger in one place."
      />
      <Metrics
        embedded
        onNavigate={onNavigate}
        tab={tab}
        onTabChange={(next) => onNavigate?.('metrics', { tab: next })}
      />
    </div>
  );
}
