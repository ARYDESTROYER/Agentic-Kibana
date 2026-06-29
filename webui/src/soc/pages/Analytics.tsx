/**
 * Analytics — the consolidated host for the reporting surfaces (Round-2 W4 page
 * consolidation). One scaffold, two segmented sub-views:
 *
 *   - Dashboard: triage volume, verdict mix, agent routing, MTTR, feedback quality,
 *                and knowledge-base/memory health (the former Metrics page).
 *   - Cost:      LLM spend metered through the single gateway cost ledger (the
 *                former Cost & usage page).
 *
 * Cost was previously a separate Platform rail item; it is a reporting view like
 * Metrics, so folding it in declutters the rail without dropping functionality.
 * Each sub-page renders `embedded` so the host owns the single page header.
 *
 * The active tab follows `NavOpts.tab` so `navigate('metrics', { tab: 'cost' })`
 * and `#/metrics` deep-links land on the right sub-view.
 */
import { BarChart3, Gauge, CircleDollarSign } from 'lucide-react';
import type { Navigate } from '@/soc/router';
import { TabbedPage } from '@/soc/components/TabbedPage';
import Metrics from './Metrics';
import Cost from './Cost';

export interface AnalyticsProps {
  onNavigate?: Navigate;
  /** Active sub-tab from the route opts ('dashboard' | 'cost'). */
  tab?: string;
}

export default function Analytics({ onNavigate, tab }: AnalyticsProps = {}) {
  return (
    <TabbedPage
      header={{
        icon: BarChart3,
        eyebrow: 'Analytics',
        title: 'Analytics',
        description: 'Triage performance and LLM spend — the metrics and the cost ledger in one place.',
      }}
      value={tab}
      onValueChange={(next) => onNavigate?.('metrics', { tab: next })}
      tabs={[
        {
          value: 'dashboard',
          label: 'Dashboard',
          icon: Gauge,
          content: <Metrics embedded onNavigate={onNavigate} />,
        },
        {
          value: 'cost',
          label: 'Cost & usage',
          icon: CircleDollarSign,
          content: <Cost embedded onNavigate={onNavigate} />,
        },
      ]}
    />
  );
}
