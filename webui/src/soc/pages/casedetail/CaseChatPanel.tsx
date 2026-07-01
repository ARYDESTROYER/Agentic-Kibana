/**
 * CaseDetail — per-case Chat panel (Coupling-D split).
 *
 * A lightweight, focused chat composer + transcript scoped to this case
 * (`api.chat` with the case id), plus a deep-link to the full Chat surface. The full
 * ChatPanel lives on the Chat page; this is the case-scoped view.
 *
 * SECURITY (#9): every assistant/user message renders as plain text (newlines
 * preserved) — never markup, never an href/CSS value. #3: chat is advisory; it never
 * decides or mutates the case.
 */
import * as React from 'react';
import { AlertTriangle, MessageSquare, RefreshCw } from 'lucide-react';

import { api } from '@/lib/api';
import type { Case } from '@/lib/types';
import { cn } from '@/lib/cn';

import { Textarea } from '@/ui/textarea';
import { Button } from '@/ui/button';
import { Alert, AlertTitle } from '@/ui/alert';

import type { Navigate } from '@/soc/router';

import { SectionHeading } from './shared';

export const ChatTab: React.FC<{
  c: Case;
  onNavigate?: Navigate;
  onClose: () => void;
}> = ({ c, onNavigate, onClose }) => {
  const [history, setHistory] = React.useState<Array<{ role: 'user' | 'assistant'; content: string }>>(
    [],
  );
  const [draft, setDraft] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const [err, setErr] = React.useState<unknown>(null);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  const starters = [
    'Summarize this case',
    'Why was this flagged?',
    'What should I check next?',
    'Is this a known false positive?',
  ];

  const send = React.useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || sending) return;
      setErr(null);
      const nextHistory = [...history, { role: 'user' as const, content: message }];
      setHistory(nextHistory);
      setDraft('');
      setSending(true);
      try {
        const res = await api.chat(message, history, c.case_id);
        setHistory([...nextHistory, { role: 'assistant', content: res.answer || '' }]);
      } catch (e) {
        setErr(e);
      } finally {
        setSending(false);
      }
    },
    [history, sending, c.case_id],
  );

  React.useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [history, sending]);

  return (
    <div className="flex h-full min-h-0 flex-col p-6">
      <div className="mb-3 flex items-center justify-between gap-3">
        <SectionHeading icon={MessageSquare} tone="info">
          Ask about this case
        </SectionHeading>
        {onNavigate ? (
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
        ) : null}
      </div>

      <div
        ref={scrollRef}
        className="min-h-[16rem] flex-1 space-y-3 overflow-y-auto rounded-lg border border-border bg-muted/20 p-4"
      >
        {history.length === 0 ? (
          <div className="flex flex-wrap gap-2">
            {starters.map((s) => (
              <Button key={s} size="sm" variant="outline" onClick={() => void send(s)}>
                {s}
              </Button>
            ))}
          </div>
        ) : (
          history.map((m, i) => (
            <div
              key={i}
              className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}
            >
              <div
                className={cn(
                  'max-w-[85%] rounded-lg px-3 py-2 text-sm',
                  m.role === 'user'
                    ? 'bg-primary text-primary-foreground'
                    : 'border border-border bg-card text-foreground',
                )}
              >
                {/* UNTRUSTED — plain text, preserve newlines. */}
                <p className="whitespace-pre-wrap break-words">{m.content}</p>
              </div>
            </div>
          ))
        )}
        {sending ? (
          <div className="flex justify-start">
            <div className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground">
              <RefreshCw className="inline h-3.5 w-3.5 animate-spin" /> Thinking…
            </div>
          </div>
        ) : null}
      </div>

      {err ? (
        <Alert variant="destructive" className="mt-3">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Could not reach the assistant</AlertTitle>
        </Alert>
      ) : null}

      <form
        className="mt-3 flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        <Textarea
          rows={2}
          className="flex-1 resize-none"
          placeholder="Ask about this case…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send(draft);
            }
          }}
        />
        <Button type="submit" disabled={sending || !draft.trim()}>
          Send
        </Button>
      </form>
    </div>
  );
};

export default ChatTab;
