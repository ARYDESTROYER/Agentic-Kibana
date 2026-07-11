/**
 * Workspace — the host for the agent's interactive surfaces (Chat, Investigate).
 *
 *   - Chat:        the conversational assistant (ONE chat engine — AGENTS.md).
 *   - Investigate: an ad-hoc, agentic investigation on an IP / user / host.
 *
 * The redundant in-page "Chat | Investigate" segmented strip was removed (task: the
 * left-nav Workspace group already exposes a clickable child for BOTH, so an in-page
 * tab bar duplicating those buttons was clutter). The active sub-view is selected by
 * the `tab` route opt (forced by the `chat` / `investigate` routes and by
 * `navigate('chat', { tab })`); the host owns the single PageHeader (each sub-page
 * renders `embedded`), and the header title/icon reflect the active sub-view so a
 * left-nav "Chat"/"Investigate" click lands on a correctly-titled page.
 */
import { MessageSquare, Search } from 'lucide-react';
import { useNavigateOptional, type Navigate } from '@/soc/router';
import { PageHeader } from '@/soc/components/PageHeader';
import { PageContainer } from '@/soc/components/PageContainer';
import Chat from './Chat';
import Investigate from './Investigate';

export interface WorkspaceProps {
  onNavigate?: Navigate;
  /** Active sub-view from the route opts ('chat' | 'investigate'). */
  tab?: string;
}

export default function Workspace({ onNavigate, tab }: WorkspaceProps = {}) {
  // Coupling-A: resolve navigate once (an explicit prop wins for tests). Call the hook
  // UNCONDITIONALLY (rules-of-hooks), then let an explicit prop win.
  const contextNavigate = useNavigateOptional();
  const navigate = onNavigate ?? contextNavigate;
  const isInvestigate = tab === 'investigate';
  return (
    <PageContainer variant="wide" className="space-y-6">
      <PageHeader
        icon={isInvestigate ? Search : MessageSquare}
        eyebrow="Agent workspace"
        title={isInvestigate ? 'Investigate' : 'Chat'}
        description={
          isInvestigate
            ? 'Launch an ad-hoc, agentic investigation on an IP, user, or host — it queries your logs, summarizes, and explains.'
            : 'Talk to the SOC agent — it queries your logs, summarizes findings, and explains its reasoning.'
        }
      />
      {isInvestigate ? (
        // Chat never consumes `onNavigate` (it destructures only `embedded`); Investigate does.
        <Investigate embedded onNavigate={navigate} />
      ) : (
        <Chat embedded />
      )}
    </PageContainer>
  );
}
