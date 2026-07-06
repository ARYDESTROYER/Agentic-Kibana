/**
 * Intelligence — the host for the agent's knowledge surfaces (Knowledge, Memory,
 * Playbooks/Catalog), each with its own independent CRUD:
 *
 *   - Knowledge: the RAG retrieval corpus (import / inspect / search / delete).
 *   - Memory:    durable operator facts injected into every investigation + chat.
 *   - Catalog:   the read-only Playbooks & Agents (personas + runbooks) catalog.
 *
 * The redundant in-page "Knowledge | Memory | Playbooks" segmented strip was removed
 * (task: the left-nav Intelligence group already exposes a clickable child for all
 * three, so an in-page tab bar duplicating those buttons was clutter). The active
 * sub-view is selected by the `tab` route opt (forced by the `knowledge` / `memory` /
 * `catalog` / `playbooks` routes and by `navigate('intelligence', { tab })`); the host
 * owns the single PageHeader (each sub-page renders `embedded`), whose title/icon
 * reflect the active sub-view so a left-nav click lands on a correctly-titled page.
 */
import { Boxes, Brain, BookOpenCheck, type LucideIcon } from 'lucide-react';
import { useNavigateOptional, type Navigate } from '@/soc/router';
import { PageHeader } from '@/soc/components/PageHeader';
import { PageContainer } from '@/soc/components/PageContainer';
import Knowledge from './Knowledge';
import Memory from './Memory';
import Catalog from './Catalog';

export interface IntelligenceProps {
  onNavigate?: Navigate;
  /** Active sub-view from the route opts ('knowledge' | 'memory' | 'catalog'). */
  tab?: string;
}

type SubView = 'knowledge' | 'memory' | 'catalog';

const HEADERS: Record<SubView, { icon: LucideIcon; title: string; description: string }> = {
  knowledge: {
    icon: Boxes,
    title: 'Knowledge',
    description: 'The RAG retrieval corpus — import, inspect, search, and manage what the agents can look up.',
  },
  memory: {
    icon: Brain,
    title: 'Memory',
    description: 'Durable operator facts injected into every automated investigation and chat.',
  },
  catalog: {
    icon: BookOpenCheck,
    title: 'Playbooks',
    description: 'The catalog of playbooks and agent personas that specialise each automated investigation.',
  },
};

export default function Intelligence({ onNavigate, tab }: IntelligenceProps = {}) {
  // Coupling-A: resolve navigate once (an explicit prop wins for tests). Call the hook
  // UNCONDITIONALLY (rules-of-hooks), then let an explicit prop win.
  const contextNavigate = useNavigateOptional();
  const navigate = onNavigate ?? contextNavigate;
  const view: SubView = tab === 'memory' ? 'memory' : tab === 'catalog' ? 'catalog' : 'knowledge';
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
      ) : view === 'catalog' ? (
        <Catalog embedded />
      ) : (
        <Knowledge embedded onNavigate={navigate} />
      )}
    </PageContainer>
  );
}
