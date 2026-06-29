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
 *
 * Height anchoring: the AppShell content slot does NOT propagate a definite height
 * (the shell root is `min-h-screen` and `<main>`/its wrapper are auto-height), so a
 * bare `h-full` here would collapse to content height — the classic broken flex
 * chain (empty-state floats high, composer drifts mid-page, dead band below). To be
 * self-sufficient we anchor the frame to the viewport: the shell top bar is `h-14`
 * (56px) and the content wrapper adds `py-6` (24px top + 24px bottom). The frame is
 * therefore sized `calc(100vh - 104px)` so it fills exactly the available slot while
 * still respecting the wrapper's bottom padding, with `min-h-0` so the transcript
 * lane (not the page) is what scrolls.
 */
import { useRef } from 'react';
import { MessageSquare, RefreshCw } from 'lucide-react';

import type { Navigate } from '@/soc/router';
import { cn } from '@/lib/cn';
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
  /**
   * When hosted as a tab inside the Workspace scaffold (Round-2 W4 consolidation),
   * suppress the page's own PageHeader and surface only the "New chat" reset action
   * (the host owns the title) and shrink the full-height frame to fit below the tab
   * bar so the transcript still fills the slot without overflowing.
   */
  embedded?: boolean;
}

export default function Chat({ embedded = false }: ChatPageProps = {}) {
  const panelRef = useRef<ChatPanelHandle>(null);

  const resetAction = (
    <Button variant="outline" size="sm" onClick={() => panelRef.current?.reset()}>
      <RefreshCw className="h-4 w-4" />
      New chat
    </Button>
  );

  return (
    // Full-height frame anchored to the viewport (see header note): fills the shell
    // content slot exactly so the chat never collapses to content height. `min-h-0`
    // on the column lets the transcript lane scroll instead of the whole page.
    // Embedded inside the Workspace scaffold, the header + tab bar already consume
    // vertical space, so the frame is a touch shorter.
    <div
      className={cn(
        'flex min-h-0 flex-col gap-5',
        embedded ? 'h-[calc(100vh-220px)]' : 'h-[calc(100vh-104px)]',
      )}
    >
      {/* Fixed page header — does not scroll. Embedded: just the reset action. */}
      <div className="shrink-0">
        {embedded ? (
          <div className="flex flex-wrap items-center justify-end gap-2">{resetAction}</div>
        ) : (
          <PageHeader
            eyebrow="Assistant"
            icon={MessageSquare}
            title="Chat"
            description="Ask the SOC agent about your environment — it queries logs, summarizes, and explains."
            actions={resetAction}
          />
        )}
      </div>

      {/* Panel host — grows to fill everything below the header; min-h-0 lets the
          inner transcript lane scroll instead of the page. */}
      <div className="min-h-0 flex-1">
        <ChatPanel ref={panelRef} starters={SUGGESTED_PROMPTS} />
      </div>
    </div>
  );
}
