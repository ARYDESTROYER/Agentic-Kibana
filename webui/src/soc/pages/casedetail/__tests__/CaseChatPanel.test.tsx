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
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
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
    // Keep best-effort picker discovery pending in this suite; individual tests
    // exercise chat behavior and should not leak unrelated async effect updates.
    getModelsMock.mockReturnValue(new Promise(() => {}));
    listSourcesMock.mockReturnValue(new Promise(() => {}));
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

  it('renders the flat analyst-console composition inside Case Manager', () => {
    const { container } = render(
      <ChatTab
        c={CASE}
        onNavigate={vi.fn()}
        onClose={vi.fn()}
        presentation="case-manager"
      />,
    );

    const panel = container.querySelector(
      '[data-case-panel="chat"][data-presentation="case-manager"]',
    );
    expect(panel).not.toBeNull();
    expect(panel).toHaveClass('flex', 'h-full', 'min-h-0', 'overflow-hidden');
    expect(panel?.className).not.toMatch(/clamp|h-\[/);

    const chatEngine = container.querySelector('[data-chat-presentation="case-manager"]');
    expect(chatEngine).not.toBeNull();
    expect(chatEngine).toHaveClass('h-full', 'min-h-0', 'w-full', 'overflow-hidden');

    // Exact bottom-anchor contract: only the transcript grows/scrolls; the action
    // rail and composer are non-shrinking siblings at the bottom of the full frame.
    expect(screen.getByRole('log', { name: 'Chat transcript' })).toHaveClass(
      'min-h-0',
      'flex-1',
      'overflow-y-auto',
    );
    expect(screen.getByRole('group', { name: 'Analyst quick actions' })).toHaveClass(
      'shrink-0',
      'flex-nowrap',
      'overflow-x-auto',
    );
    for (const action of ['Summarize Case', 'Check IOCs', 'Suggest Remediation']) {
      expect(screen.getByRole('button', { name: action })).toHaveClass('shrink-0');
    }
    expect(chatEngine?.lastElementChild).toHaveClass('shrink-0');
    expect(screen.queryByRole('heading', { name: /case chat/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /open full chat/i })).toBeNull();

    const status = screen.getByRole('status', { name: 'AI analyst status' });
    expect(status).toHaveClass(
      'grid-cols-[minmax(0,1fr)_auto]',
      'items-center',
      'sm:grid-cols-[auto_1fr_auto]',
    );
    expect(status).toHaveTextContent(/Scoped to:\s*case-9/i);
    expect(status).toHaveTextContent(/Status:\s*Ready/i);
    expect(screen.getByText('AI Analyst ready with case context.')).toHaveClass(
      'hidden',
      'sm:block',
    );
    expect(panel).toHaveClass(
      'px-3',
      'pb-3',
      'pt-4',
      'sm:px-8',
      'sm:pb-4',
      'sm:pt-7',
    );
    expect(screen.getByLabelText('Chat message')).toHaveClass('[field-sizing:content]');
    expect(screen.getByPlaceholderText('Ask AI Analyst…')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Analyst quick actions' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Summarize Case' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check IOCs' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Suggest Remediation' })).toBeInTheDocument();
    expect(screen.getByText(/Case context is ready/i)).toBeInTheDocument();
  });

  it('shows honest working/ready states and the analyst transcript around the shared live send flow', async () => {
    let resolveChat: ((value: { answer: string }) => void) | undefined;
    chatMock.mockReturnValueOnce(
      new Promise<{ answer: string }>((resolve) => {
        resolveChat = resolve;
      }),
    );

    render(
      <ChatTab
        c={CASE}
        onNavigate={vi.fn()}
        onClose={vi.fn()}
        presentation="case-manager"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Check IOCs' }));
    await waitFor(() => expect(chatMock).toHaveBeenCalledTimes(1));
    expect(chatMock.mock.calls[0][0]).toBe('Check IOCs');
    expect(chatMock.mock.calls[0][2]).toBe('case-9');
    expect(screen.getByRole('status', { name: 'AI analyst status' })).toHaveTextContent(
      /Status:\s*Working/i,
    );
    expect(screen.getByText('Operator')).toBeInTheDocument();
    expect(screen.getAllByText('Check IOCs').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Searching configured sources…')).toBeInTheDocument();

    await act(async () => {
      resolveChat?.({ answer: 'No additional malicious indicators were found.' });
    });

    expect(
      await screen.findByText('No additional malicious indicators were found.'),
    ).toBeInTheDocument();
    expect(screen.getByText('AI analyst')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'AI analyst status' })).toHaveTextContent(
      /Status:\s*Ready/i,
    );
  });

  it('keeps live source and model selection inside the compact analyst settings control', async () => {
    getModelsMock.mockResolvedValueOnce({ providers: { local: ['soc-model'] } });
    listSourcesMock.mockResolvedValueOnce({
      sources: [{ id: 'siem-1', display_name: 'Primary SIEM', source_type: 'elastic' }],
    });

    render(
      <ChatTab
        c={CASE}
        onNavigate={vi.fn()}
        onClose={vi.fn()}
        presentation="case-manager"
      />,
    );

    const settings = await screen.findByRole('button', { name: 'Chat settings' });
    fireEvent.click(settings);
    expect(await screen.findByLabelText('Source')).toBeInTheDocument();
    expect(screen.getByLabelText('Model')).toBeInTheDocument();
    expect(screen.getByText('Analyst settings')).toBeInTheDocument();
  });

  it('has no accessibility violations in the Case Manager chat frame', async () => {
    const { container } = render(
      <ChatTab
        c={CASE}
        onNavigate={vi.fn()}
        onClose={vi.fn()}
        presentation="case-manager"
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
