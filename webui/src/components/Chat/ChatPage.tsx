/**
 * Chat (preview) — sends a message to POST /api/chat and renders the answer (and
 * an optional result table). A minimal port; the full conversational surface
 * lands later.
 */
import React, { useState } from 'react';
import {
  EuiBasicTable,
  EuiButton,
  EuiCommentList,
  EuiFieldText,
  EuiFlexGroup,
  EuiFlexItem,
  EuiPanel,
  EuiSpacer,
  EuiText,
} from '@elastic/eui';
import type { ChatResponse, ChatTurn } from '../../lib/types';
import { api } from '../../lib/api';
import { ErrorCallout, PreviewPill, SectionHeader } from '../common/ui';
import { fmtMoney } from '../../lib/format';

export const ChatPage: React.FC = () => {
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [last, setLast] = useState<ChatResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const send = async () => {
    const message = input.trim();
    if (!message) return;
    setLoading(true);
    setError(null);
    const nextHistory: ChatTurn[] = [...history, { role: 'user', content: message }];
    setHistory(nextHistory);
    setInput('');
    try {
      const resp = await api.chat(message, nextHistory);
      setLast(resp);
      setHistory([...nextHistory, { role: 'assistant', content: resp.answer }]);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  };

  const comments = history.map((t, i) => ({
    username: t.role === 'user' ? 'You' : 'Agent',
    timelineAvatarAriaLabel: t.role,
    event: t.role === 'user' ? 'asked' : 'replied',
    children: <EuiText size="s">{t.content}</EuiText>,
    timelineAvatar: t.role === 'user' ? 'user' : 'compute',
    key: i,
  }));

  return (
    <div>
      <SectionHeader
        icon="discuss"
        title="Chat"
        description="Ask the SOC about your environment."
        actions={<PreviewPill />}
      />
      {error ? (
        <>
          <ErrorCallout error={error} />
          <EuiSpacer size="m" />
        </>
      ) : null}

      {history.length ? (
        <>
          <EuiCommentList comments={comments} />
          <EuiSpacer size="m" />
        </>
      ) : (
        <EuiText color="subdued">
          <p>Try: “Show failed logins for 10.0.0.5 in the last 24h”.</p>
        </EuiText>
      )}

      {last?.table && last.table.columns.length ? (
        <EuiPanel hasBorder paddingSize="m">
          <EuiBasicTable
            items={last.table.rows.map((r, ri) =>
              Object.fromEntries([['__i', ri], ...last.table!.columns.map((c, ci) => [c, r[ci]])]),
            )}
            columns={last.table.columns.map((c) => ({ field: c, name: c }))}
          />
        </EuiPanel>
      ) : null}

      <EuiSpacer size="m" />
      <EuiFlexGroup gutterSize="s" responsive={false}>
        <EuiFlexItem>
          <EuiFieldText
            placeholder="Ask a question…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void send();
            }}
            fullWidth
          />
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiButton fill iconType="returnKey" onClick={send} isLoading={loading}>
            Send
          </EuiButton>
        </EuiFlexItem>
      </EuiFlexGroup>
      {last?.cost ? (
        <EuiText size="xs" color="subdued">
          <span>Cost: {fmtMoney(last.cost)}</span>
        </EuiText>
      ) : null}
    </div>
  );
};
