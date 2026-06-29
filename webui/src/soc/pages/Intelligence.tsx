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
import type { Navigate } from '@/soc/router';
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
      onValueChange={(next) => onNavigate?.('intelligence', { tab: next })}
      tabs={[
        {
          value: 'knowledge',
          label: 'Knowledge',
          icon: Boxes,
          content: <Knowledge embedded onNavigate={onNavigate} />,
        },
        {
          value: 'memory',
          label: 'Memory',
          icon: Brain,
          content: <Memory embedded onNavigate={onNavigate} />,
        },
        {
          value: 'catalog',
          label: 'Playbooks & Agents',
          icon: BookOpenCheck,
          content: <Catalog embedded onNavigate={onNavigate} />,
        },
      ]}
    />
  );
}
