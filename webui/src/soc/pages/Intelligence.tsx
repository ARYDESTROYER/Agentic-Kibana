/**
 * Intelligence — the host for the agent's knowledge and procedure surfaces, each
 * with its own explicit operator job:
 *
 *   - Knowledge corpus: indexed RAG material (import / inspect / search / delete).
 *   - Reference runbooks: retrievable investigation guidance (browse / author / index).
 *   - Operator memory: approved durable facts injected into investigations + chat.
 *   - Response playbooks: deterministically selected operator procedures.
 *   - Agent personas: the read-only specialist roster used by deterministic routing.
 *
 * The redundant in-page "Knowledge | Memory | Playbooks" segmented strip was removed
 * (the left-nav Intelligence group exposes a clickable child for every job, so an
 * in-page tab bar duplicating those buttons is clutter). The active
 * sub-view is selected by the `tab` route opt (forced by the `knowledge` / `memory` /
 * `runbooks` / `playbooks` / `personas` routes and by
 * `navigate('intelligence', { tab })`); the host
 * owns the single PageHeader (each sub-page renders `embedded`), whose title/icon
 * reflect the active sub-view so a left-nav click lands on a correctly-titled page.
 */
import { Boxes, Brain, BookMarked, BookOpenCheck, Users, type LucideIcon } from 'lucide-react';
import { useNavigateOptional, type Navigate } from '@/soc/router';
import { PageHeader } from '@/soc/components/PageHeader';
import { PageContainer } from '@/soc/components/PageContainer';
import Knowledge from './Knowledge';
import Runbooks from './Runbooks';
import Memory from './Memory';
import Catalog from './Catalog';

export interface IntelligenceProps {
  onNavigate?: Navigate;
  /** Active sub-view from the route opts (the legacy 'catalog' alias opens Playbooks). */
  tab?: string;
}

type SubView = 'knowledge' | 'runbooks' | 'memory' | 'playbooks' | 'personas';

const HEADERS: Record<SubView, { icon: LucideIcon; title: string; description: string }> = {
  knowledge: {
    icon: Boxes,
    title: 'Knowledge corpus',
    description: 'Indexed RAG material the agent can retrieve — import, inspect, search, and manage each source.',
  },
  runbooks: {
    icon: BookMarked,
    title: 'Reference runbooks',
    description: 'Trusted investigation guidance retrieved as reference knowledge; never executable authority.',
  },
  memory: {
    icon: Brain,
    title: 'Operator memory',
    description: 'Approved durable operator facts available to automated investigations and Workspace chat.',
  },
  playbooks: {
    icon: BookOpenCheck,
    title: 'Response playbooks',
    description: 'Operator procedures selected deterministically to guide an investigation; never decision authority.',
  },
  personas: {
    icon: Users,
    title: 'Agent personas',
    description: 'Read-only specialist profiles selected deterministically to focus one investigator per cluster.',
  },
};

export default function Intelligence({ onNavigate, tab }: IntelligenceProps = {}) {
  // Coupling-A: resolve navigate once (an explicit prop wins for tests). Call the hook
  // UNCONDITIONALLY (rules-of-hooks), then let an explicit prop win.
  const contextNavigate = useNavigateOptional();
  const navigate = onNavigate ?? contextNavigate;
  const view: SubView =
    tab === 'runbooks'
      ? 'runbooks'
      : tab === 'memory'
        ? 'memory'
        : tab === 'personas'
          ? 'personas'
          : tab === 'playbooks' || tab === 'catalog'
            ? 'playbooks'
            : 'knowledge';
  const header = HEADERS[view];
  return (
    <PageContainer variant="wide" className="space-y-6">
      <PageHeader
        icon={header.icon}
        eyebrow="Intelligence"
        title={header.title}
        description={header.description}
      />
      {view === 'memory' ? (
        <Memory embedded onNavigate={navigate} />
      ) : view === 'runbooks' ? (
        <Runbooks embedded />
      ) : view === 'playbooks' || view === 'personas' ? (
        <Catalog embedded defaultTab={view} />
      ) : (
        <Knowledge embedded onNavigate={navigate} />
      )}
    </PageContainer>
  );
}
