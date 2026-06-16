import React, { useState } from 'react';
import {
  EuiButton,
  EuiButtonEmpty,
  EuiCallOut,
  EuiComment,
  EuiCommentList,
  EuiFlexGroup,
  EuiFlexItem,
  EuiBasicTable,
  EuiSpacer,
  EuiText,
  EuiTextArea,
  EuiPanel,
} from '@elastic/eui';
import type { ChatContext, ChatResponse, ChatTurn, ChatTable } from '../../common';
import type { TlsocApi } from '../lib/api';
import type { OpenInDiscover } from '../lib/discover';

interface ChatProps {
  api: TlsocApi;
  openInDiscover: OpenInDiscover;
  caseId?: string;
  placeholder?: string;
  /**
   * Optional, called AT SEND TIME to snapshot the surface the analyst is on. When
   * present, the result is attached as `body.context`. The in-app Chat tab passes
   * nothing (unchanged behavior); the global flyout passes a screen-context
   * collector so one chat engine serves two entry points.
   */
  getContext?: () => ChatContext | Promise<ChatContext>;
}

interface RenderedTurn extends ChatTurn {
  table?: ChatTable;
  discover?: ChatResponse['discover'];
}

function ChatTableView({ table }: { table: ChatTable }) {
  const columns = table.columns.map((c, i) => ({
    field: `c${i}`,
    name: c,
    truncateText: true,
  }));
  const items = table.rows.map((row, ri) => {
    const obj: Record<string, any> = { id: ri };
    row.forEach((cell, ci) => {
      obj[`c${ci}`] = cell === null || cell === undefined ? '' : String(cell);
    });
    return obj;
  });
  return (
    <>
      <EuiBasicTable items={items} columns={columns} tableLayout="auto" />
      {table.truncated ? (
        <EuiText size="xs" color="subdued">
          <p>Results truncated.</p>
        </EuiText>
      ) : null}
    </>
  );
}

export const Chat: React.FC<ChatProps> = ({
  api,
  openInDiscover,
  caseId,
  placeholder,
  getContext,
}) => {
  const [turns, setTurns] = useState<RenderedTurn[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    const message = input.trim();
    if (!message || loading) {
      return;
    }
    setError(null);
    setLoading(true);
    const history: ChatTurn[] = turns.map((t) => ({ role: t.role, content: t.content }));
    const nextTurns: RenderedTurn[] = [...turns, { role: 'user', content: message }];
    setTurns(nextTurns);
    setInput('');
    try {
      const body: Record<string, unknown> = { message, history };
      if (caseId) {
        body.case_id = caseId;
      }
      if (getContext) {
        try {
          // Snapshot the surface at send time. The backend fences any
          // attacker-influenceable values (query/selection) as untrusted data.
          body.context = await getContext();
        } catch {
          /* context is best-effort; never block the send on it */
        }
      }
      const resp = await api.post<ChatResponse>('chat', body);
      setTurns([
        ...nextTurns,
        {
          role: 'assistant',
          content: resp.answer || '(no answer)',
          table: resp.table,
          discover: resp.discover,
        },
      ]);
    } catch (e) {
      setError((e as Error).message || 'Chat request failed');
      setTurns([
        ...nextTurns,
        { role: 'assistant', content: 'Sorry, the request failed.' },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const openDiscover = async (d: NonNullable<ChatResponse['discover']>) => {
    try {
      await openInDiscover(d.query, d.time_from, d.time_to, d.data_view_pattern);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div>
      {error ? (
        <>
          <EuiCallOut color="danger" size="s" title={error} />
          <EuiSpacer size="s" />
        </>
      ) : null}

      <div className="tlsocAgenticTriage__chatHistory">
        <EuiCommentList>
          {turns.map((t, i) => (
            <EuiComment
              key={i}
              username={t.role === 'user' ? 'You' : 'TLSOC Agent'}
              timelineAvatarAriaLabel={t.role}
              event={t.role === 'user' ? 'asked' : 'replied'}
            >
              <EuiPanel color="subdued" paddingSize="s">
                <EuiText size="s">
                  <p style={{ whiteSpace: 'pre-wrap' }}>{t.content}</p>
                </EuiText>
                {t.table ? (
                  <>
                    <EuiSpacer size="s" />
                    <ChatTableView table={t.table} />
                  </>
                ) : null}
                {t.discover ? (
                  <>
                    <EuiSpacer size="s" />
                    <EuiButton size="s" iconType="discoverApp" onClick={() => openDiscover(t.discover!)}>
                      Open in Discover
                    </EuiButton>
                  </>
                ) : null}
              </EuiPanel>
            </EuiComment>
          ))}
        </EuiCommentList>
      </div>

      <EuiSpacer size="s" />
      <EuiFlexGroup gutterSize="s" alignItems="flexEnd">
        <EuiFlexItem>
          <EuiTextArea
            fullWidth
            rows={2}
            placeholder={placeholder || 'Ask the TLSOC agent...'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                send();
              }
            }}
          />
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiButton fill isLoading={loading} onClick={send} iconType="returnKey">
            Send
          </EuiButton>
        </EuiFlexItem>
      </EuiFlexGroup>
      {turns.length > 0 ? (
        <EuiButtonEmpty size="xs" onClick={() => setTurns([])}>
          Clear conversation
        </EuiButtonEmpty>
      ) : null}
    </div>
  );
};
