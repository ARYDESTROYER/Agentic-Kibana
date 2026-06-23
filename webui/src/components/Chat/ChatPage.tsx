/**
 * Chat — the conversational triage console (page surface).
 *
 * A thin wrapper around the reusable <ChatPanel>: this file owns only the page
 * chrome (the PageHeader + a "New chat" reset action). All of the chat behaviour —
 * the transcript, composer, send flow, history, markdown rendering, AnswerMeta,
 * the memory action/suggestion surfaces, and model selection — lives in
 * <ChatPanel> so the case flyout can embed the very same engine via
 * `<ChatPanel caseId={id} compact />`.
 */
import React, { useRef } from 'react';
import { EuiButton } from '@elastic/eui';
import { ChatPanel, type ChatPanelHandle } from './ChatPanel';
import { PageHeader } from '../common/ui';
import { COLORS } from '../../lib/theme';

/** The default starter prompts for the full-page chat empty state. */
const SUGGESTED_PROMPTS = [
  'Show failed logins for 10.0.0.5 in the last 24h',
  "Summarize today's true positives",
  'Any brute-force activity in the last 24h?',
  'Which hosts had the most alerts this week?',
];

export const ChatPage: React.FC = () => {
  const panelRef = useRef<ChatPanelHandle>(null);

  return (
    <div
      className="socPageEnter"
      style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 160px)' }}
    >
      <PageHeader
        icon="discuss"
        accent={COLORS.accent}
        title="Chat"
        description="Ask the SOC agent about your environment — it queries logs, summarizes, and explains."
        actions={
          <EuiButton size="s" iconType="refresh" onClick={() => panelRef.current?.reset()}>
            New chat
          </EuiButton>
        }
      />
      <div style={{ flex: 1, minHeight: 0 }}>
        <ChatPanel ref={panelRef} starters={SUGGESTED_PROMPTS} />
      </div>
    </div>
  );
};
