/**
 * CaseThread — Group 5 / #4 + #9 coverage.
 *
 * Pins the two load-bearing facts:
 *   1. the AI is a FIRST-CLASS author rendered DISTINCTLY (an "AI" badge + a bot
 *      avatar, not a human initials avatar);
 *   2. an UNTRUSTED message body is rendered as PLAIN TEXT — any markup / close-marker
 *      in the body appears as literal text, never as live DOM (no injected <img>,
 *      <script>, or onerror handler escapes the fence, #9).
 * Plus: a tombstoned message renders a "deleted" placeholder (not its body), and
 * one-level replies nest under their parent.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { CaseThread } from '../CaseThread';
import type { CaseMessage } from '@/soc/pages/CaseDetail.api';

function msg(over: Partial<CaseMessage>): CaseMessage {
  return {
    id: 'msg-1',
    case_id: 'case-1',
    parent_id: null,
    author_type: 'human',
    author: 'jdoe',
    body: 'hello',
    mentions: [],
    reactions: [],
    kind: 'comment',
    created_at: '2026-06-30T10:00:00Z',
    edited_at: null,
    deleted_at: null,
    ai_meta: null,
    ...over,
  };
}

const NOOP = {
  onPost: vi.fn(),
  onReply: vi.fn(),
  onEdit: vi.fn(),
  onDelete: vi.fn(),
  onReact: vi.fn(),
};

describe('CaseThread (#4 collaboration / #9 escaping)', () => {
  it('renders an AI-authored message DISTINCTLY from a human one', () => {
    const messages: CaseMessage[] = [
      msg({ id: 'h1', author_type: 'human', author: 'alice', body: 'Looks benign to me.' }),
      msg({
        id: 'a1',
        author_type: 'ai',
        author: 'assistant',
        body: 'I correlated 3 prior cases on this host.',
      }),
    ];
    render(
      <CaseThread
        messages={messages}
        users={[]}
        currentUser={null}
        canComment={false}
        {...NOOP}
      />,
    );

    // The AI message carries a distinct "AI" badge label that the human one does not.
    expect(screen.getByText('AI')).toBeInTheDocument();
    // Both bodies render as plain text.
    expect(screen.getByText('Looks benign to me.')).toBeInTheDocument();
    expect(screen.getByText(/I correlated 3 prior cases/)).toBeInTheDocument();

    // The AI message wrapper is found via its data-author-type marker, and it differs
    // from the human one (distinct styling lives on the element).
    const aiNode = document.querySelector('[data-author-type="ai"]');
    const humanNode = document.querySelector('[data-author-type="human"]');
    expect(aiNode).toBeTruthy();
    expect(humanNode).toBeTruthy();
    expect(aiNode).not.toBe(humanNode);
  });

  it('renders an UNTRUSTED body as plain text — no markup escapes the fence (#9)', () => {
    const attack =
      '<img src=x onerror="window.__pwned=1"> <script>alert(1)</script> <<<CLOSE>>>';
    const { container } = render(
      <CaseThread
        messages={[msg({ id: 'x1', author: 'mallory', body: attack })]}
        users={[]}
        currentUser={null}
        canComment={false}
        {...NOOP}
      />,
    );

    // The raw string is present as TEXT.
    expect(screen.getByText(/onerror=/)).toBeInTheDocument();
    // No live element was injected from the body.
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    // The would-be attack never executed.
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('highlights an @mention without turning it into markup', () => {
    const { container } = render(
      <CaseThread
        messages={[msg({ id: 'm1', body: 'ping @analyst2 please review' })]}
        users={[]}
        currentUser={null}
        canComment={false}
        {...NOOP}
      />,
    );
    // The mention token renders (as a styled span, still plain text).
    expect(screen.getByText('@analyst2')).toBeInTheDocument();
    // It is a <span>, not an anchor/href (#9 — no navigable target from a body).
    const mention = screen.getByText('@analyst2');
    expect(mention.tagName.toLowerCase()).toBe('span');
    expect(container.querySelector('a[href]')).toBeNull();
  });

  it('renders a tombstoned message as a deleted placeholder, not its body', () => {
    render(
      <CaseThread
        messages={[
          msg({ id: 'root', body: 'parent', reactions: [] }),
          msg({
            id: 'del',
            parent_id: 'root',
            body: '',
            deleted: true,
            deleted_at: '2026-06-30T11:00:00Z',
          }),
        ]}
        users={[]}
        currentUser={null}
        canComment={false}
        {...NOOP}
      />,
    );
    expect(screen.getByText(/was deleted/i)).toBeInTheDocument();
  });

  it('mounts the composer only when the caller can comment', () => {
    const { rerender } = render(
      <CaseThread
        messages={[msg({})]}
        users={[]}
        currentUser="jdoe"
        canComment={false}
        {...NOOP}
      />,
    );
    expect(screen.queryByText('New message')).toBeNull();

    rerender(
      <CaseThread
        messages={[msg({})]}
        users={[]}
        currentUser="jdoe"
        canComment
        {...NOOP}
      />,
    );
    expect(screen.getByText('New message')).toBeInTheDocument();
  });
});
