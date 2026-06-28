/**
 * Chat — the conversational triage console (page surface, new command-center UI).
 *
 * A thin wrapper around the reusable <ChatPanel>: this file owns only the page
 * chrome (the PageHeader + a "New chat" reset action) and the full-height layout
 * shell. ALL chat behaviour — transcript, composer, send flow, history, markdown
 * rendering, AnswerMeta, provenance, the memory action/suggestion surfaces, the
 * model picker and the source-scope picker — lives in <ChatPanel> so the case
 * detail sheet can embed the very same engine via `<ChatPanel caseId={id} compact />`.
 *
 * Layout: a flex COLUMN that fills the page content area. The header is fixed-height
 * at the top; the panel host below (`flex-1 min-h-0`) absorbs all remaining vertical
 * space so the chat fills the viewport with no wasted band and no cut-off.
 */
import { useRef } from 'react';
import { MessageSquare, RefreshCw } from 'lucide-react';

import type { Navigate } from '@/soc/router';
import { PageHeader } from '@/soc/components/PageHeader';
import { Button } from '@/ui/button';
import { ChatPanel, type ChatPanelHandle } from '@/soc/components/ChatPanel';

/** The default starter prompts for the full-page chat empty state. */
const SUGGESTED_PROMPTS = [
  'Show failed logins for 10.0.0.5 in the last 24h',
  "Summarize today's true positives",
  'Any brute-force activity in the last 24h?',
  'Which hosts had the most alerts this week?',
];

export interface ChatPageProps {
  onNavigate?: Navigate;
}

export default function Chat(_props: ChatPageProps) {
  const panelRef = useRef<ChatPanelHandle>(null);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <PageHeader
        eyebrow="Assistant"
        icon={MessageSquare}
        title="Chat"
        description="Ask the SOC agent about your environment — it queries logs, summarizes, and explains."
        actions={
          <Button variant="outline" size="sm" onClick={() => panelRef.current?.reset()}>
            <RefreshCw className="h-4 w-4" />
            New chat
          </Button>
        }
      />

      {/* Panel host — grows to fill everything below the header; min-h-0 lets the
          inner transcript lane scroll instead of the page. */}
      <div className="min-h-0 flex-1">
        <ChatPanel ref={panelRef} starters={SUGGESTED_PROMPTS} />
      </div>
    </div>
  );
}
