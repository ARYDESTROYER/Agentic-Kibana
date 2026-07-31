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
import { StrictMode, createRef } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  act,
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe, toHaveNoViolations } from "jest-axe";

expect.extend(toHaveNoViolations);

const { chatMock, getModelsMock, listSourcesMock } = vi.hoisted(() => ({
  chatMock: vi.fn(),
  getModelsMock: vi.fn(),
  listSourcesMock: vi.fn(),
}));

vi.mock("@/lib/api", () => {
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

import { TooltipProvider } from "@/ui/tooltip";
import { ChatPanel, type ChatPanelHandle } from "../ChatPanel";

// jsdom doesn't implement Element.scrollTo (ChatPanel pins the transcript on update).
if (
  typeof Element !== "undefined" &&
  !(Element.prototype as unknown as { scrollTo?: unknown }).scrollTo
) {
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo =
    () => {};
}

function typeAndSend(text: string) {
  fireEvent.change(screen.getByLabelText("Chat message"), {
    target: { value: text },
  });
  fireEvent.click(screen.getByLabelText("Send message"));
}

async function sendMessage(text: string) {
  typeAndSend(text);
  return screen.findByText("hello from agent");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("ChatPanel", () => {
  beforeEach(() => {
    chatMock.mockReset();
    getModelsMock.mockReset();
    listSourcesMock.mockReset();
    getModelsMock.mockResolvedValue({ providers: {} });
    listSourcesMock.mockResolvedValue({ sources: [] });
    chatMock.mockResolvedValue({ answer: "hello from agent" });
  });

  it("re-sends the PRECEDING user turn exactly once on regenerate", async () => {
    render(
      <StrictMode>
        <TooltipProvider>
          <ChatPanel />
        </TooltipProvider>
      </StrictMode>,
    );

    typeAndSend("first question");
    await waitFor(() => expect(chatMock).toHaveBeenCalledTimes(1));
    typeAndSend("second question");
    await waitFor(() => expect(chatMock).toHaveBeenCalledTimes(2));

    // Regenerate the FIRST assistant answer → resend its preceding user turn.
    const again = await screen.findAllByLabelText("Ask this again");
    fireEvent.click(again[0]);

    await waitFor(() => expect(chatMock).toHaveBeenCalledTimes(3));
    // Let any stray microtask settle; the count must hold at exactly one resend.
    await new Promise((r) => setTimeout(r, 30));
    expect(chatMock).toHaveBeenCalledTimes(3);
    // It re-used the correct (preceding) user message, not the latest turn.
    expect(chatMock.mock.calls[2][0]).toBe("first question");
  });

  it("does not render a dead thumbs-up/down feedback affordance", async () => {
    render(
      <TooltipProvider>
        <ChatPanel />
      </TooltipProvider>,
    );
    await sendMessage("hi");

    expect(screen.queryByLabelText(/helpful/i)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/thanks for the feedback/i),
    ).not.toBeInTheDocument();
    // Copy + regenerate remain the live actions.
    expect(screen.getByLabelText("Ask this again")).toBeInTheDocument();
    expect(screen.getByLabelText("Copy answer")).toBeInTheDocument();
  });

  it("renders assistant prose at the comfortable reading size (text-md)", async () => {
    render(
      <TooltipProvider>
        <ChatPanel />
      </TooltipProvider>,
    );
    const p = await sendMessage("hi");
    // The Markdown wrapper (direct parent of the paragraph) carries text-md, not text-sm.
    const wrapper = p.parentElement as HTMLElement;
    expect(wrapper.className).toContain("text-md");
    expect(wrapper.className).not.toContain("text-sm");
  });

  it("keeps the Workspace introduction and composer in one stable transcript frame", async () => {
    const starters = [
      "Investigate this IP",
      "Summarize true positives",
      "Find brute-force activity",
      "Show the busiest hosts",
    ];
    const { container } = render(
      <ChatPanel presentation="workspace" starters={starters} />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    const root = container.querySelector(
      '[data-chat-presentation="workspace"]',
    );
    expect(root).toBeInTheDocument();

    const workbench = screen.getByTestId("workspace-chat-empty-workbench");
    expect(
      within(workbench).getByTestId("workspace-chat-ready"),
    ).toBeInTheDocument();
    expect(workbench).not.toHaveAttribute("role", "log");
    expect(
      screen.queryByRole("log", { name: "Chat transcript" }),
    ).not.toBeInTheDocument();
    expect(container.querySelector('[data-chat-composer="inline"]')).toBeNull();
    expect(container.querySelector('[data-chat-composer="docked"]')).not.toBeNull();
    expect(
      within(workbench).getByRole("group", { name: "Suggested questions" }),
    ).toHaveClass("grid-cols-1", "sm:grid-cols-2");
    expect(screen.getByLabelText("Chat message")).toHaveAttribute(
      "placeholder",
      "Ask the SOC agent…",
    );
    expect(screen.getByLabelText("Chat message").parentElement).toHaveClass(
      "focus-within:border-ring",
      "focus-within:ring-2",
      "focus-within:ring-ring/40",
    );
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(
      screen.getByRole("status", { name: "SOC agent ready" }),
    ).toBeInTheDocument();
    for (const starter of starters) {
      const button = within(workbench).getByRole("button", { name: starter });
      expect(button.querySelector(".truncate")).toBeNull();
    }
  });

  it("keeps the transcript top-aligned and the same docked composer after the first turn", async () => {
    const { container } = render(<ChatPanel presentation="workspace" />);
    const composerBefore = container.querySelector(
      '[data-chat-composer="docked"]',
    );

    await sendMessage("show current posture");

    expect(
      screen.queryByTestId("workspace-chat-ready"),
    ).not.toBeInTheDocument();
    expect(container.querySelector('[data-chat-composer="inline"]')).toBeNull();
    expect(container.querySelector('[data-chat-composer="docked"]')).toBe(
      composerBefore,
    );
    const transcript = screen.getByRole("log", { name: "Chat transcript" });
    expect(container.querySelector('[data-chat-scroll-lane="true"]')).toHaveClass(
      "min-h-0",
      "flex-1",
      "overflow-y-auto",
    );
    expect(transcript).not.toHaveClass("justify-end", "min-h-full");
    expect(screen.getByText("show current posture")).toBeInTheDocument();
  });

  it("sends only prior turns as history instead of duplicating the current prompt", async () => {
    render(<ChatPanel presentation="workspace" />);

    await sendMessage("first question");
    expect(chatMock.mock.calls[0][0]).toBe("first question");
    expect(chatMock.mock.calls[0][1]).toEqual([]);

    typeAndSend("second question");
    await waitFor(() => expect(chatMock).toHaveBeenCalledTimes(2));
    expect(chatMock.mock.calls[1][0]).toBe("second question");
    expect(chatMock.mock.calls[1][1]).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "hello from agent" },
    ]);
  });

  it("restores a selected durable conversation and resumes it with saved scope", async () => {
    render(
      <ChatPanel
        presentation="workspace"
        persistConversation
        conversation={{
          id: "conversation-1",
          title: "Investigate sign-ins",
          preview: "saved answer",
          created_at: "2026-07-26T08:00:00Z",
          updated_at: "2026-07-26T08:01:00Z",
          message_count: 2,
          model: "model-a",
          source_id: "elastic-live",
          messages: [
            {
              id: "message-1",
              role: "user",
              content: "saved question",
              created_at: "2026-07-26T08:00:00Z",
            },
            {
              id: "message-2",
              role: "assistant",
              content: "saved answer",
              created_at: "2026-07-26T08:01:00Z",
              model: "model-a",
              response: { answer: "saved answer", cost: 0.002 },
            },
          ],
        }}
      />,
    );

    expect(await screen.findByText("saved question")).toBeInTheDocument();
    expect(screen.getByText("saved answer")).toBeInTheDocument();

    typeAndSend("continue the investigation");
    await waitFor(() => expect(chatMock).toHaveBeenCalledTimes(1));
    expect(chatMock).toHaveBeenCalledWith(
      "continue the investigation",
      [
        { role: "user", content: "saved question" },
        { role: "assistant", content: "saved answer" },
      ],
      undefined,
      "model-a",
      "elastic-live",
      "conversation-1",
      true,
      expect.stringMatching(/^chat-/),
    );
  });

  it("opts a new Workspace turn into persistence and reports the created conversation", async () => {
    const onConversationPersisted = vi.fn();
    chatMock.mockResolvedValueOnce({
      answer: "persisted answer",
      conversation_id: "conversation-new",
      conversation_title: "Suspicious host review",
    });
    render(
      <ChatPanel
        presentation="workspace"
        conversation={null}
        persistConversation
        onConversationPersisted={onConversationPersisted}
      />,
    );

    typeAndSend("review suspicious host");
    expect(await screen.findByText("persisted answer")).toBeInTheDocument();
    expect(chatMock).toHaveBeenCalledWith(
      "review suspicious host",
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      expect.stringMatching(/^chat-/),
    );
    expect(onConversationPersisted).toHaveBeenCalledWith(
      "conversation-new",
      "Suspicious host review",
    );
  });

  it("keeps a failed prompt visible but excludes it from the next request history", async () => {
    chatMock
      .mockRejectedValueOnce(new Error("Temporary upstream failure"))
      .mockResolvedValueOnce({ answer: "second request succeeded" });
    render(
      <ChatPanel
        presentation="workspace"
        conversation={null}
        persistConversation
      />,
    );

    typeAndSend("failed prompt");
    expect(await screen.findByText("Temporary upstream failure")).toBeInTheDocument();
    expect(screen.getByText("failed prompt")).toBeInTheDocument();

    typeAndSend("clean follow-up");
    expect(await screen.findByText("second request succeeded")).toBeInTheDocument();
    expect(chatMock.mock.calls[1][1]).toEqual([]);
    expect(chatMock.mock.calls[1][7]).not.toBe(chatMock.mock.calls[0][7]);
  });

  it("retries a failed persisted turn with the same idempotency key", async () => {
    chatMock
      .mockRejectedValueOnce(new Error("Gateway timed out"))
      .mockResolvedValueOnce({
        answer: "replayed safely",
        conversation_id: "conversation-retry",
        conversation_title: "Retry investigation",
      });
    render(
      <ChatPanel
        presentation="workspace"
        conversation={null}
        persistConversation
      />,
    );

    typeAndSend("retry this request");
    fireEvent.click(
      await screen.findByRole("button", { name: "Retry same request" }),
    );

    expect(await screen.findByText("replayed safely")).toBeInTheDocument();
    await waitFor(() => expect(chatMock).toHaveBeenCalledTimes(2));
    expect(chatMock.mock.calls[0][7]).toMatch(/^chat-/);
    expect(chatMock.mock.calls[1][7]).toBe(chatMock.mock.calls[0][7]);
    expect(screen.queryByText("Gateway timed out")).not.toBeInTheDocument();
    expect(screen.getAllByText("retry this request")).toHaveLength(1);
  });

  it("reports controlled draft changes without sharing them between hosts", async () => {
    const onDraftChange = vi.fn();
    const { rerender } = render(
      <ChatPanel
        presentation="workspace"
        conversation={null}
        draft="unfinished query"
        onDraftChange={onDraftChange}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    const input = screen.getByLabelText("Chat message");
    expect(input).toHaveValue("unfinished query");
    fireEvent.change(input, { target: { value: "updated query" } });
    expect(onDraftChange).toHaveBeenCalledWith("updated query");

    await act(async () => {
      rerender(
        <ChatPanel
          presentation="workspace"
          conversation={null}
          draft="another thread draft"
          onDraftChange={onDraftChange}
        />,
      );
      await Promise.resolve();
    });
    expect(screen.getByLabelText("Chat message")).toHaveValue(
      "another thread draft",
    );
  });

  it("shows effective per-turn model and source provenance plus retention honesty", async () => {
    const user = userEvent.setup();
    chatMock.mockResolvedValueOnce({
      answer: "provenance answer",
      effective_model: "resolved-model",
      effective_source_id: "elastic-primary",
      effective_source_name: "Elastic production",
    });
    render(
      <ChatPanel
        presentation="workspace"
        conversation={null}
        persistConversation
        workspaceRetentionNote="Showing the latest 100 of 148 messages. Older turns were removed by retention."
      />,
    );

    expect(screen.getByRole("note")).toHaveTextContent(
      "Showing the latest 100 of 148 messages",
    );
    typeAndSend("show provenance");
    expect(await screen.findByText("provenance answer")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /Evidence & execution/i }),
    );
    expect(screen.getByText("resolved-model")).toBeInTheDocument();
    expect(screen.getByText("Elastic production")).toBeInTheDocument();
  });

  it("keeps case-scoped chat on the shared engine without Workspace persistence", async () => {
    render(
      <ChatPanel
        caseId="case-123"
        presentation="case-manager"
      />,
    );

    typeAndSend("summarize this case");
    await waitFor(() => expect(chatMock).toHaveBeenCalledTimes(1));
    expect(chatMock).toHaveBeenCalledWith(
      "summarize this case",
      [],
      "case-123",
      undefined,
      undefined,
      undefined,
      false,
    );
  });

  it("sends with Enter while Shift+Enter remains available for a new line", async () => {
    render(<ChatPanel presentation="workspace" />);
    const input = screen.getByLabelText("Chat message");

    fireEvent.change(input, { target: { value: "keyboard question" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(chatMock).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(chatMock).toHaveBeenCalledTimes(1));
    expect(chatMock.mock.calls[0][0]).toBe("keyboard question");
  });

  it("does not submit Enter while an IME composition is active", async () => {
    render(<ChatPanel presentation="workspace" />);
    const input = screen.getByLabelText("Chat message");

    fireEvent.change(input, { target: { value: "正在调查" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(chatMock).not.toHaveBeenCalled();
    expect(input).toHaveValue("正在调查");

    fireEvent.keyDown(input, { key: "Enter", isComposing: false });
    await waitFor(() => expect(chatMock).toHaveBeenCalledTimes(1));
    expect(chatMock.mock.calls[0][0]).toBe("正在调查");
  });

  it("keeps one disabled docked composer through restore and retryable error states", async () => {
    const onRetryRestore = vi.fn();
    const onStartNew = vi.fn();
    const { container, rerender } = render(
      <ChatPanel presentation="workspace" restoring />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText("Restoring conversation")).toBeInTheDocument();
    expect(screen.getByLabelText("Chat message")).toBeDisabled();
    expect(
      container.querySelectorAll('[data-chat-composer="docked"]'),
    ).toHaveLength(1);
    expect(
      container.querySelector('[data-chat-composer="inline"]'),
    ).toBeNull();

    await act(async () => {
      rerender(
        <ChatPanel
          presentation="workspace"
          restoreError="The saved transcript is temporarily unavailable."
          onRetryRestore={onRetryRestore}
          onStartNew={onStartNew}
        />,
      );
      await Promise.resolve();
    });

    expect(
      screen.getByText("Could not restore this conversation"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("The saved transcript is temporarily unavailable."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Chat message")).toBeDisabled();
    expect(
      container.querySelectorAll('[data-chat-composer="docked"]'),
    ).toHaveLength(1);
    expect(screen.queryByTestId("workspace-chat-ready")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    fireEvent.click(screen.getByRole("button", { name: "Start new chat" }));
    expect(onRetryRestore).toHaveBeenCalledTimes(1);
    expect(onStartNew).toHaveBeenCalledTimes(1);
  });

  it("reveals the complete evidence and execution disclosure for an answer", async () => {
    const user = userEvent.setup();
    render(
      <ChatPanel
        presentation="workspace"
        conversation={{
          id: "conversation-evidence",
          title: "Explain evidence",
          preview: "Evidence-backed answer",
          created_at: "2026-07-26T08:00:00Z",
          updated_at: "2026-07-26T08:01:00Z",
          message_count: 2,
          messages: [
            {
              id: "question-evidence",
              role: "user",
              content: "Why is this suspicious?",
              created_at: "2026-07-26T08:00:00Z",
            },
            {
              id: "answer-evidence",
              role: "assistant",
              content: "Evidence-backed answer",
              created_at: "2026-07-26T08:01:00Z",
              model: "analysis-model",
              response: {
                answer: "Evidence-backed answer",
                truncated: true,
                query: "source.ip: 198.51.100.23",
                cost: 0.0042,
                tools: [
                  {
                    tool: "es_query",
                    summary: "Reviewed sign-in telemetry",
                    query: "event.category:authentication",
                  },
                ],
                knowledge: [
                  {
                    source: "identity-runbook.md",
                    snippet: "Confirm impossible travel against device history.",
                  },
                ],
                citations: [
                  {
                    n: 1,
                    source: "identity-runbook.md",
                    snippet: "Review the prior sign-in location.",
                  },
                ],
                reasoning: "The source and device pattern diverge from baseline.",
              },
            },
          ],
        }}
      />,
    );

    expect(await screen.findByText("Evidence-backed answer")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /Evidence & execution/i }),
    );

    expect(screen.getByText("Query executed")).toBeInTheDocument();
    expect(
      screen.getByText(/saved response exceeded the history limit/i),
    ).toBeInTheDocument();
    expect(screen.getByText("source.ip: 198.51.100.23")).toBeInTheDocument();
    expect(screen.getByText("Tools run")).toBeInTheDocument();
    expect(screen.getByText("es_query")).toBeInTheDocument();
    expect(screen.getByText(/Reviewed sign-in telemetry/)).toBeInTheDocument();
    expect(screen.getByText("Knowledge consulted")).toBeInTheDocument();
    expect(screen.getAllByText("identity-runbook.md")).toHaveLength(2);
    expect(screen.getByText("Citations")).toBeInTheDocument();
    expect(screen.getByText("Reasoning")).toBeInTheDocument();
    expect(
      screen.getByText("The source and device pattern diverge from baseline."),
    ).toBeInTheDocument();
    expect(screen.getByText("Execution")).toBeInTheDocument();
    expect(screen.getByText("analysis-model")).toBeInTheDocument();
    expect(screen.getByText(/this message$/)).toBeInTheDocument();
  });

  it("confirms a memory remove operation as a forgotten fact", async () => {
    chatMock.mockResolvedValueOnce({
      answer: "I removed that saved context.",
      memory_action: {
        op: "remove",
        text: "The legacy gateway is trusted.",
      },
    });
    render(<ChatPanel presentation="workspace" />);

    typeAndSend("Forget the legacy gateway note");
    expect(
      await screen.findByText("I removed that saved context."),
    ).toBeInTheDocument();
    expect(screen.getByText("Forgot this fact")).toBeInTheDocument();
    expect(
      screen.getByText(/The legacy gateway is trusted\./),
    ).toBeInTheDocument();
  });

  it("ignores an in-flight reply after New chat resets the conversation", async () => {
    const pending = deferred<{ answer: string }>();
    chatMock.mockReturnValueOnce(pending.promise);
    const panelRef = createRef<ChatPanelHandle>();
    render(<ChatPanel ref={panelRef} presentation="workspace" />);

    typeAndSend("old conversation");
    await waitFor(() => expect(chatMock).toHaveBeenCalledTimes(1));
    act(() => panelRef.current?.reset());
    expect(screen.getByTestId("workspace-chat-ready")).toBeInTheDocument();
    expect(screen.getByLabelText("Chat message")).toHaveFocus();

    await act(async () => {
      pending.resolve({ answer: "stale answer that must stay hidden" });
      await pending.promise;
    });

    expect(
      screen.queryByText("stale answer that must stay hidden"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("workspace-chat-ready")).toBeInTheDocument();
  });

  it("uses the shared reduced-motion-aware loading glyph while the agent works", async () => {
    const pending = deferred<{ answer: string }>();
    chatMock.mockReturnValueOnce(pending.promise);
    render(<ChatPanel presentation="workspace" />);

    typeAndSend("slow question");
    await waitFor(() => expect(chatMock).toHaveBeenCalledTimes(1));

    expect(screen.getByTestId("console-loading-glyph")).toBeInTheDocument();
    expect(document.querySelector(".socTypingDot")).toBeNull();

    await act(async () => {
      pending.resolve({ answer: "done" });
      await pending.promise;
    });
  });

  it("offers only enabled queryable sources and labels the default scope truthfully", async () => {
    listSourcesMock.mockResolvedValueOnce({
      sources: [
        {
          id: "elastic-live",
          source_type: "elasticsearch",
          display_name: "Elastic live",
          enabled: true,
          ingest_mode: "pull",
          can_browse: true,
        },
        {
          id: "elastic-disabled",
          source_type: "elasticsearch",
          display_name: "Elastic disabled",
          enabled: false,
          ingest_mode: "pull",
          can_browse: true,
        },
        {
          id: "webhook-push",
          source_type: "webhook",
          display_name: "Webhook push",
          enabled: true,
          ingest_mode: "push_http",
          can_browse: false,
        },
        {
          id: "demo-entra",
          source_type: "entra_id",
          display_name: "Microsoft Entra ID",
          enabled: true,
          ingest_mode: "stream",
          can_browse: true,
          demo: true,
        },
      ],
    });
    render(<ChatPanel presentation="workspace" />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Chat settings" }),
    );
    const source = await screen.findByRole("combobox", { name: "Source" });
    fireEvent.click(source);

    expect(
      screen.getByRole("option", { name: "Primary source" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Elastic live" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Microsoft Entra ID" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "Elastic disabled" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "Webhook push" }),
    ).not.toBeInTheDocument();
  });

  it("has no detectable accessibility violations in the Workspace empty state", async () => {
    const { container } = render(
      <ChatPanel
        presentation="workspace"
        starters={["Investigate this IP", "Summarize current posture"]}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(await axe(container)).toHaveNoViolations();
  });
});
