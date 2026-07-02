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
import { useNavigateOptional, type Navigate } from '@/soc/router';
import { PageHeader } from '@/soc/components/PageHeader';
import { PageContainer } from '@/soc/components/PageContainer';
import Metrics from './Metrics';

export interface AnalyticsProps {
  onNavigate?: Navigate;
  /** Active sub-tab from the route opts ('operational' | 'performance' | 'posture' | 'cost'). */
  tab?: string;
}

export default function Analytics({ onNavigate, tab }: AnalyticsProps = {}) {
  // Coupling-A: the host resolves navigate once (prop wins for tests) and threads it +
  // the tab round-trip into the embedded Metrics — App no longer prop-drills onNavigate.
  // Call the hook UNCONDITIONALLY (rules-of-hooks), then let an explicit prop win.
  const contextNavigate = useNavigateOptional();
  const navigate = onNavigate ?? contextNavigate;
  return (
    <PageContainer variant="wide" className="space-y-6">
      <PageHeader
        icon={BarChart3}
        title="Analytics"
        description="Triage performance, security posture, and LLM spend — the metrics, the posture rollup, and the cost ledger in one place."
      />
      <Metrics
        embedded
        onNavigate={navigate}
        tab={tab}
        onTabChange={(next) => navigate('metrics', { tab: next })}
      />
    </PageContainer>
  );
}
