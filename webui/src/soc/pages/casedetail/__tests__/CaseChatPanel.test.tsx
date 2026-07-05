/**
 * CaseChatPanel (ChatTab) — Round-8 #6 declutter: reuse the shared <ChatPanel>.
 *
 * The tab used to hand-roll its own transcript + composer (~150 lines). It now embeds
 * the shared ChatPanel in `compact` mode, scoped to the case, wrapped in the shared
 * PanelCard, with a slim right-aligned "Open full chat" deep-link. This spec locks:
 *
 *   1. It renders the SHARED ChatPanel — the composer carries ChatPanel's "Chat message"
 *      label (the old hand-rolled composer never did), and ChatPanel's "Scoped to case"
 *      chip proves the caseId is threaded through.
 *   2. The case-scoped starter prompts show in the empty state.
 *   3. Sending a starter calls api.chat with THIS case id (context threading) — chat is
 *      advisory only (#3): nothing here decides or mutates the case.
 *   4. The "Open full chat" deep-link closes the sheet then navigates to the chat page
 *      scoped to the case.
 *   5. No a11y violations (jest-axe).
 *
 * `api` is mocked so the mount is hermetic (no models/sources/chat network).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);

const { chatMock, getModelsMock, listSourcesMock } = vi.hoisted(() => ({
  chatMock: vi.fn(),
  getModelsMock: vi.fn(),
  listSourcesMock: vi.fn(),
}));

vi.mock('@/lib/api', () => {
  class ApiError extends Error {}
  return {
    ApiError,
    api: {
      getModels: getModelsMock,
      listSources: listSourcesMock,
      chat: chatMock,
      addMemory: vi.fn().mockResolvedValue({}),
    },
  };
});

import type { Case } from '@/lib/types';
import { ChatTab } from '../CaseChatPanel';

// jsdom doesn't implement Element.scrollTo (ChatPanel pins the transcript on update).
if (typeof Element !== 'undefined' && !(Element.prototype as unknown as { scrollTo?: unknown }).scrollTo) {
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
}

const CASE = { case_id: 'case-9' } as unknown as Case;

describe('ChatTab — reuses the shared ChatPanel (Round-8 #6)', () => {
  beforeEach(() => {
    chatMock.mockReset();
    getModelsMock.mockReset();
    listSourcesMock.mockReset();
    getModelsMock.mockResolvedValue({ providers: {} });
    listSourcesMock.mockResolvedValue({ sources: [] });
    chatMock.mockResolvedValue({ answer: 'hello from agent' });
  });

  it('embeds the shared ChatPanel, scoped to the case, with the case starters', () => {
    render(<ChatTab c={CASE} onNavigate={vi.fn()} onClose={vi.fn()} />);

    // The shared composer (only ChatPanel labels its textarea "Chat message").
    expect(screen.getByLabelText('Chat message')).toBeInTheDocument();
    // ChatPanel's scope chip proves the caseId is threaded in.
    expect(screen.getByText(/Scoped to case/i)).toBeInTheDocument();
    expect(screen.getByText('case-9')).toBeInTheDocument();
    // The case-scoped starters render in the empty state.
    expect(screen.getByText('Summarize this case')).toBeInTheDocument();
    expect(screen.getByText('Why was this flagged?')).toBeInTheDocument();
  });

  it('threads THIS case id into api.chat when a starter is sent (#3 advisory)', async () => {
    render(<ChatTab c={CASE} onNavigate={vi.fn()} onClose={vi.fn()} />);

    fireEvent.click(screen.getByText('Summarize this case'));
    await waitFor(() => expect(chatMock).toHaveBeenCalledTimes(1));
    // ChatPanel.send() calls api.chat(message, history, caseId, ...).
    expect(chatMock.mock.calls[0][0]).toBe('Summarize this case');
    expect(chatMock.mock.calls[0][2]).toBe('case-9');
  });

  it('"Open full chat" closes the sheet then navigates to the case-scoped chat', () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();
    render(<ChatTab c={CASE} onNavigate={onNavigate} onClose={onClose} />);

    fireEvent.click(screen.getByText('Open full chat'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith('chat', { caseId: 'case-9' });
  });

  it('omits the deep-link when no navigate handler is provided', () => {
    render(<ChatTab c={CASE} onClose={vi.fn()} />);
    expect(screen.queryByText('Open full chat')).not.toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<ChatTab c={CASE} onNavigate={vi.fn()} onClose={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
