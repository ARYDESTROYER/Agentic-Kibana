/**
 * Home — the Overview landing host.
 *
 * Overview and Standup each own their full PageContainer + PageHeader, so Home is a
 * thin router that renders exactly ONE of them based on the active `tab`:
 *
 *   - dashboard (default): the live security-posture command center (Overview page).
 *   - standup:             the daily aggregate digest (Standup page).
 *
 * The redundant in-page "Dashboard | Standup" segmented strip was removed (task: the
 * left-nav Overview group already exposes a clickable child for BOTH destinations, so
 * an in-page tab bar duplicating those buttons was pure clutter atop the Security
 * Command Center). Switching now happens via the left nav; the `tab` route opt (forced
 * by the `dashboard` / `standup` routes and by `navigate('overview', { tab })`) selects
 * which sub-page renders here, so deep-links + in-app navigation still land correctly.
 */
import { useNavigateOptional, type Navigate } from '@/soc/router';
import Overview from './Overview';
import Standup from './Standup';

export interface HomeProps {
  onNavigate?: Navigate;
  /** Active sub-view from the route opts ('dashboard' | 'standup'). */
  tab?: string;
}

export default function Home({ onNavigate, tab }: HomeProps = {}) {
  // Coupling-A: resolve navigate once (an explicit prop wins for tests), then thread it
  // into whichever sub-page is active. Call the hook UNCONDITIONALLY (rules-of-hooks).
  const contextNavigate = useNavigateOptional();
  const navigate = onNavigate ?? contextNavigate;
  return tab === 'standup' ? (
    <Standup onNavigate={navigate} />
  ) : (
    <Overview onNavigate={navigate} />
  );
}
