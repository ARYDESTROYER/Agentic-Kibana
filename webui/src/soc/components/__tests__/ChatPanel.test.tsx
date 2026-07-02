/**
 * ChatPanel — regression specs for the Round-6 sweep fixes:
 *  - "Ask this again" re-sends the PRECEDING user turn (not the latest one) EXACTLY
 *    once. The fix moved this out of a setState updater — a pure updater that only
 *    reads a transcript ref and calls send() once — so it can never double-send when
 *    React re-invokes updaters (StrictMode/concurrent). This test rendered under
 *    StrictMode locks the single-resend + correct-turn behavior.
 *  - the inert 👍/👎 feedback affordance is gone (chat has no feedback endpoint).
 *  - assistant prose renders at the comfortable reading scale (text-md), not the
 *    dense-table text-sm.
 *
 * The picker Selects are suppressed (empty models/sources) so the transcript surface
 * is exercised without Radix Select portals.
 */
import { StrictMode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

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

import { TooltipProvider } from '@/ui/tooltip';
import { ChatPanel } from '../ChatPanel';

// jsdom doesn't implement Element.scrollTo (ChatPanel pins the transcript on update).
if (typeof Element !== 'undefined' && !(Element.prototype as unknown as { scrollTo?: unknown }).scrollTo) {
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
}

function typeAndSend(text: string) {
  fireEvent.change(screen.getByLabelText('Chat message'), { target: { value: text } });
  fireEvent.click(screen.getByLabelText('Send message'));
}

async function sendMessage(text: string) {
  typeAndSend(text);
  return screen.findByText('hello from agent');
}

describe('ChatPanel', () => {
  beforeEach(() => {
    chatMock.mockReset();
    getModelsMock.mockReset();
    listSourcesMock.mockReset();
    getModelsMock.mockResolvedValue({ providers: {} });
    listSourcesMock.mockResolvedValue({ sources: [] });
    chatMock.mockResolvedValue({ answer: 'hello from agent' });
  });

  it('re-sends the PRECEDING user turn exactly once on regenerate', async () => {
    render(
      <StrictMode>
        <TooltipProvider>
          <ChatPanel />
        </TooltipProvider>
      </StrictMode>,
    );

    typeAndSend('first question');
    await waitFor(() => expect(chatMock).toHaveBeenCalledTimes(1));
    typeAndSend('second question');
    await waitFor(() => expect(chatMock).toHaveBeenCalledTimes(2));

    // Regenerate the FIRST assistant answer → resend its preceding user turn.
    const again = await screen.findAllByLabelText('Ask this again');
    fireEvent.click(again[0]);

    await waitFor(() => expect(chatMock).toHaveBeenCalledTimes(3));
    // Let any stray microtask settle; the count must hold at exactly one resend.
    await new Promise((r) => setTimeout(r, 30));
    expect(chatMock).toHaveBeenCalledTimes(3);
    // It re-used the correct (preceding) user message, not the latest turn.
    expect(chatMock.mock.calls[2][0]).toBe('first question');
  });

  it('does not render a dead thumbs-up/down feedback affordance', async () => {
    render(
      <TooltipProvider>
        <ChatPanel />
      </TooltipProvider>,
    );
    await sendMessage('hi');

    expect(screen.queryByLabelText(/helpful/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/thanks for the feedback/i)).not.toBeInTheDocument();
    // Copy + regenerate remain the live actions.
    expect(screen.getByLabelText('Ask this again')).toBeInTheDocument();
    expect(screen.getByLabelText('Copy answer')).toBeInTheDocument();
  });

  it('renders assistant prose at the comfortable reading size (text-md)', async () => {
    render(
      <TooltipProvider>
        <ChatPanel />
      </TooltipProvider>,
    );
    const p = await sendMessage('hi');
    // The Markdown wrapper (direct parent of the paragraph) carries text-md, not text-sm.
    const wrapper = p.parentElement as HTMLElement;
    expect(wrapper.className).toContain('text-md');
    expect(wrapper.className).not.toContain('text-sm');
  });
});
