/**
 * Chat — the conversational triage console (page surface).
 *
 * A thin wrapper around the reusable <ChatPanel>: this file owns only the page
 * chrome (the PageHeader + a "New chat" reset action) and the full-height layout
 * shell. All of the chat behaviour — the transcript, composer, send flow, history,
 * markdown rendering, AnswerMeta, the memory action/suggestion surfaces, the model
 * picker and the source-scope picker — lives in <ChatPanel> so the case flyout can
 * embed the very same engine via `<ChatPanel caseId={id} compact />`.
 *
 * Layout: the page is a flex COLUMN that fills the page content area. The header is
 * fixed-height at the top; the panel host below it (`flex:1; min-height:0`) absorbs
 * ALL the remaining vertical space so the chat fills the viewport with no wasted
 * band and no viewport-dependent cut-off. The `minHeight` tracks the real shell
 * chrome (51px sticky header + the EuiPageSection's `l` padding ≈ 48px), replacing
 * the old hand-tuned `calc(100vh - 160px)` magic number that left gaps / clipping.
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
      style={{
        display: 'flex',
        flexDirection: 'column',
        // Fill the page content area. The shell's sticky header is 51px and the
        // EuiPageSection adds `l` (~48px) vertical padding; subtracting both lets
        // the column own all remaining height without overflowing the viewport.
        height: 'calc(100vh - 51px - 48px)',
        minHeight: 420,
      }}
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
      {/* Panel host — grows to fill everything below the header; min-height:0 lets
          the inner transcript lane scroll instead of the page. */}
      <div style={{ flex: '1 1 auto', minHeight: 0 }}>
        <ChatPanel ref={panelRef} starters={SUGGESTED_PROMPTS} />
      </div>
    </div>
  );
};
