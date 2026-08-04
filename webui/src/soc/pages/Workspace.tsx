/**
 * Workspace — the host for the agent's interactive surfaces (Chat, Investigate).
 *
 *   - Chat:        the conversational assistant (ONE chat engine — AGENTS.md).
 *   - Entity investigation: an ad-hoc, agentic investigation on an IP / user / host.
 *
 * The redundant in-page "Chat | Investigate" segmented strip was removed (task: the
 * left-nav Workspace group already exposes a clickable child for BOTH, so an in-page
 * tab bar duplicating those buttons was clutter). The active sub-view is selected by
 * the `tab` route opt (forced by the `chat` / `investigate` routes and by
 * `navigate('chat', { tab })`). Chat is a focused conversational route and owns its
 * PageHeader/action so the reset control cannot drift into a second band. Entity
 * investigation keeps the wider operational host below.
 */
import { Search } from "lucide-react";
import { useNavigateOptional, type Navigate } from "@/soc/router";
import { PageHeader } from "@/soc/components/PageHeader";
import { PageContainer } from "@/soc/components/PageContainer";
import Chat from "./Chat";
import Investigate from "./Investigate";

export interface WorkspaceProps {
  onNavigate?: Navigate;
  /** Active sub-view from the route opts ('chat' | 'investigate'). */
  tab?: string;
  /** Optional case context preserved by a Case Chat → Workspace deep-link. */
  caseId?: string;
}

export default function Workspace({ onNavigate, tab, caseId }: WorkspaceProps = {}) {
  // Coupling-A: resolve navigate once (an explicit prop wins for tests). Call the hook
  // UNCONDITIONALLY (rules-of-hooks), then let an explicit prop win.
  const contextNavigate = useNavigateOptional();
  const navigate = onNavigate ?? contextNavigate;
  const isInvestigate = tab === "investigate";

  if (!isInvestigate) {
    // Chat owns a fluid PageContainer because its history rail + conversation pane
    // are a split workspace. Wrapping it in the focused 1200px container wastes a
    // large part of desktop screens and creates two competing width authorities.
    return <Chat caseId={caseId} />;
  }

  return (
    <PageContainer variant="wide" className="space-y-6">
      <PageHeader
        icon={Search}
        eyebrow="Agent workspace"
        title="Entity investigation"
        description="Check one IP, user, or host across the selected log window. Matching evidence is correlated, investigated, and saved as a case."
      />
      <Investigate embedded onNavigate={navigate} />
    </PageContainer>
  );
}
