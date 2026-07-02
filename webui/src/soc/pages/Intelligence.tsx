/**
 * Intelligence — the consolidated host for the agent's knowledge surfaces
 * (Round-2 W4 page consolidation). One scaffold, three segmented sub-views, each
 * keeping its own distinct CRUD:
 *
 *   - Knowledge: the RAG retrieval corpus (import / inspect / search / delete).
 *   - Memory:    durable operator facts injected into every investigation + chat.
 *   - Catalog:   the read-only Playbooks & Agents (personas + runbooks) catalog.
 *
 * These three formerly lived as separate top-level rail items; they are all "what
 * the agents know" surfaces, so grouping them under one Intelligence area declutters
 * the rail without dropping any functionality. Each sub-page renders `embedded` so
 * the host owns the single page header; each keeps its full, independent CRUD.
 *
 * The active tab follows `NavOpts.tab` so `navigate('intelligence', { tab: 'memory' })`
 * and `#/intelligence` deep-links land on the right sub-view.
 */
import { Library, Boxes, Brain, BookOpenCheck } from 'lucide-react';
import { useNavigateOptional, type Navigate } from '@/soc/router';
import { TabbedPage } from '@/soc/components/TabbedPage';
import Knowledge from './Knowledge';
import Memory from './Memory';
import Catalog from './Catalog';

export interface IntelligenceProps {
  onNavigate?: Navigate;
  /** Active sub-tab from the route opts ('knowledge' | 'memory' | 'catalog'). */
  tab?: string;
}

export default function Intelligence({ onNavigate, tab }: IntelligenceProps = {}) {
  // Coupling-A: the host resolves navigate once (prop wins for tests) and threads it +
  // the tab round-trip into its sub-views — App no longer prop-drills onNavigate.
  // Call the hook UNCONDITIONALLY (rules-of-hooks), then let an explicit prop win.
  const contextNavigate = useNavigateOptional();
  const navigate = onNavigate ?? contextNavigate;
  return (
    <TabbedPage
      header={{
        icon: Library,
        eyebrow: 'Intelligence',
        title: 'Intelligence',
        description:
          'Everything the agents know — the RAG knowledge corpus, durable operator memory, and the playbooks & agents catalog.',
      }}
      value={tab}
      onValueChange={(next) => navigate('intelligence', { tab: next })}
      tabs={[
        {
          value: 'knowledge',
          label: 'Knowledge',
          icon: Boxes,
          content: <Knowledge embedded onNavigate={navigate} />,
        },
        {
          value: 'memory',
          label: 'Memory',
          icon: Brain,
          content: <Memory embedded onNavigate={navigate} />,
        },
        {
          // Label MUST match the nav child + the `#/playbooks` breadcrumb leaf
          // (navLabel('playbooks') === 'Playbooks'). Round-6 #32: the tab formerly read
          // 'Playbooks & Agents' while the rail child + breadcrumb read 'Playbooks',
          // so a `#/playbooks` deep-link showed three disagreeing labels. Aligned on the
          // short 'Playbooks' (matching the Knowledge/Memory sibling pattern where each
          // tab label equals its disclosure-child label). The "& Agents" content stays
          // discoverable inside the Catalog page's own Agents section.
          value: 'catalog',
          label: 'Playbooks',
          icon: BookOpenCheck,
          content: <Catalog embedded />,
        },
      ]}
    />
  );
}
