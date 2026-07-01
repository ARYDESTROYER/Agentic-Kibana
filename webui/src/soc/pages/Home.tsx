/**
 * Home — the consolidated landing host (Round-2 W4 page consolidation). One
 * scaffold, two segmented sub-views:
 *
 *   - Dashboard: the live security-posture command center (the Overview page).
 *   - Standup:   the daily aggregate digest (the former Standup page).
 *
 * Standup was previously a separate Automation rail item; it is a glanceable
 * summary that belongs next to the posture dashboard, so folding it in declutters
 * the rail without dropping functionality. Both sub-pages own a HeroPanel, so the
 * host renders NO unified PageHeader — just the segmented tab bar above the heroes.
 *
 * The active tab follows `NavOpts.tab` so `navigate('overview', { tab: 'standup' })`
 * and `#/overview` deep-links land on the right sub-view.
 */
import { Gauge, FileText } from 'lucide-react';
import { useNavigateOptional, type Navigate } from '@/soc/router';
import { TabbedPage } from '@/soc/components/TabbedPage';
import Overview from './Overview';
import Standup from './Standup';

export interface HomeProps {
  onNavigate?: Navigate;
  /** Active sub-tab from the route opts ('dashboard' | 'standup'). */
  tab?: string;
}

export default function Home({ onNavigate, tab }: HomeProps = {}) {
  // Coupling-A: the host resolves navigate once (prop wins for tests) and threads it +
  // the tab round-trip into its sub-views — App no longer prop-drills onNavigate.
  // Call the hook UNCONDITIONALLY (rules-of-hooks), then let an explicit prop win.
  const contextNavigate = useNavigateOptional();
  const navigate = onNavigate ?? contextNavigate;
  return (
    <TabbedPage
      value={tab}
      onValueChange={(next) => navigate('overview', { tab: next })}
      tabs={[
        {
          value: 'dashboard',
          label: 'Dashboard',
          icon: Gauge,
          content: <Overview onNavigate={navigate} />,
        },
        {
          value: 'standup',
          label: 'Standup',
          icon: FileText,
          content: <Standup onNavigate={navigate} />,
        },
      ]}
    />
  );
}
