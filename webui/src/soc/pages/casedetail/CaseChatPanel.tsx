/**
 * CaseDetail — per-case Chat panel (Coupling-D split).
 *
 * A thin wrapper that embeds the SHARED <ChatPanel> (the ONE chat engine) in compact
 * mode, scoped to this case, plus a slim deep-link to the full Chat surface. This
 * deliberately REUSES ChatPanel instead of hand-rolling a second transcript + composer,
 * so bubbles / avatars / markdown / provenance / the "thinking" indicator / scroll all
 * stay identical to the standalone Chat page (Round-8 #6 declutter).
 *
 * SECURITY (#9): ChatPanel renders every assistant / user / model-derived value as
 * plain-text or parsed-markdown React nodes — never markup, never an href/CSS value.
 * #3: chat is advisory; it never decides or mutates the case.
 */
import * as React from 'react';
import { MessageSquare } from 'lucide-react';

import type { Case } from '@/lib/types';

import { Button } from '@/ui/button';

import { ChatPanel } from '@/soc/components/ChatPanel';
import type { Navigate } from '@/soc/router';

import { PanelCard, SectionHeading } from './shared';

/** Case-scoped starter prompts surfaced in the empty state. */
const CASE_CHAT_STARTERS = [
  'Summarize this case',
  'Why was this flagged?',
  'What should I check next?',
  'Is this a known false positive?',
];

export const ChatTab: React.FC<{
  c: Case;
  onNavigate?: Navigate;
  onClose: () => void;
}> = ({ c, onNavigate, onClose }) => (
  <div className="space-y-6 p-6">
    <PanelCard>
      <SectionHeading
        icon={MessageSquare}
        actions={
          onNavigate ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                onClose();
                onNavigate('chat', { caseId: c.case_id });
              }}
            >
              <MessageSquare className="h-4 w-4" /> Open full chat
            </Button>
          ) : null
        }
      >
        Case chat
      </SectionHeading>

      {/* The shared chat engine, embedded compact + scoped to this case. A definite
          height gives ChatPanel's internal transcript scroll + bottom-pinned composer
          a frame to work in (the transcript lane is the only scrolling region). */}
      <div className="h-[60vh] min-h-[24rem]">
        <ChatPanel caseId={c.case_id} compact starters={CASE_CHAT_STARTERS} />
      </div>
    </PanelCard>
  </div>
);

export default ChatTab;
