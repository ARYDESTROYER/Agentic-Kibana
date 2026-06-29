/**
 * Workspace — the consolidated host for the agent's interactive surfaces
 * (Round-2 W4 page consolidation). One scaffold, two segmented sub-views:
 *
 *   - Chat:        the conversational assistant (ONE chat engine — CLAUDE.md).
 *   - Investigate: an ad-hoc, agentic investigation on an IP / user / host.
 *
 * Both formerly lived as separate top-level rail items; they share the same
 * investigative intent, so folding them into one tabbed surface declutters the rail
 * without dropping any functionality (each sub-page keeps its full behaviour and is
 * rendered `embedded` so the host owns the single page header).
 *
 * The active tab follows `NavOpts.tab` so `navigate('chat', { tab: 'investigate' })`
 * and `#/chat` deep-links land on the right sub-view.
 */
import { MessageSquare, Search } from 'lucide-react';
import type { Navigate } from '@/soc/router';
import { TabbedPage } from '@/soc/components/TabbedPage';
import Chat from './Chat';
import Investigate from './Investigate';

export interface WorkspaceProps {
  onNavigate?: Navigate;
  /** Active sub-tab from the route opts ('chat' | 'investigate'). */
  tab?: string;
}

export default function Workspace({ onNavigate, tab }: WorkspaceProps = {}) {
  return (
    <TabbedPage
      header={{
        icon: MessageSquare,
        eyebrow: 'Agent workspace',
        title: 'Workspace',
        description:
          'Talk to the SOC agent or launch an ad-hoc investigation — both query your logs, summarize, and explain.',
      }}
      value={tab}
      onValueChange={(next) => onNavigate?.('chat', { tab: next })}
      tabs={[
        {
          value: 'chat',
          label: 'Chat',
          icon: MessageSquare,
          content: <Chat embedded onNavigate={onNavigate} />,
        },
        {
          value: 'investigate',
          label: 'Investigate',
          icon: Search,
          content: <Investigate embedded onNavigate={onNavigate} />,
        },
      ]}
    />
  );
}
