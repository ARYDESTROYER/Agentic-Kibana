/**
 * Thin Workspace Chat integration: real page, real ChatPanel, real typed API client.
 * Only fetch is replaced, keeping the page/panel/client contract in one test without
 * booting FastAPI. This closes the mock seam left by Chat.demo.test.tsx.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ConfirmProvider } from "@/soc/components/ConfirmDialog";
import Chat from "../Chat";

if (
  typeof Element !== "undefined" &&
  !(Element.prototype as unknown as { scrollTo?: unknown }).scrollTo
) {
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Workspace Chat transport integration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retries with one key, persists into the rail, then selects and restores the thread", async () => {
    const user = userEvent.setup();
    const postBodies: Array<Record<string, unknown>> = [];
    let postCount = 0;
    let saved = false;
    let detailReads = 0;

    const summary = {
      id: "conversation-integrated",
      title: "Failed sign-in review",
      preview: "Live persisted answer",
      created_at: "2026-07-27T12:00:00Z",
      updated_at: "2026-07-27T12:01:00Z",
      message_count: 2,
      total_message_count: 2,
      history_truncated: false,
      model: "resolved-model",
      source_id: "elastic-primary",
      source_name: "Elastic production",
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url === "/api/models" && method === "GET") {
        return json({ providers: {} });
      }
      if (url === "/api/sources" && method === "GET") {
        return json({ sources: [] });
      }
      if (url.startsWith("/api/chat/conversations?limit=50") && method === "GET") {
        return json({
          conversations: saved ? [summary] : [],
          total: saved ? 1 : 0,
          total_conversation_count: saved ? 1 : 0,
          history_truncated: false,
          limit: 50,
        });
      }
      if (
        url === "/api/chat/conversations/conversation-integrated" &&
        method === "GET"
      ) {
        detailReads += 1;
        return json({
          ...summary,
          messages: [
            {
              id: "message-user",
              role: "user",
              content: "Review failed sign-ins",
              created_at: "2026-07-27T12:00:00Z",
              idempotency_key: postBodies[0]?.idempotency_key,
            },
            {
              id: "message-assistant",
              role: "assistant",
              content: "Restored server answer",
              created_at: "2026-07-27T12:01:00Z",
              idempotency_key: postBodies[0]?.idempotency_key,
              model: "resolved-model",
              source_id: "elastic-primary",
              source_name: "Elastic production",
              response: {
                answer: "Restored server answer",
                effective_model: "resolved-model",
                effective_source_id: "elastic-primary",
                effective_source_name: "Elastic production",
              },
            },
          ],
        });
      }
      if (url === "/api/chat" && method === "POST") {
        postCount += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        postBodies.push(body);
        if (postCount === 1) {
          return json(
            {
              detail: {
                code: "chat_history_unavailable",
                message: "Conversation storage is temporarily unavailable.",
              },
            },
            503,
          );
        }
        saved = true;
        return json({
          answer: "Live persisted answer",
          conversation_id: summary.id,
          conversation_title: summary.title,
          idempotency_key: body.idempotency_key,
          effective_model: "resolved-model",
          effective_source_id: "elastic-primary",
          effective_source_name: "Elastic production",
        });
      }
      throw new Error(`Unhandled request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ConfirmProvider>
        <Chat />
      </ConfirmProvider>,
    );

    const composer = await screen.findByRole("textbox", { name: "Chat message" });
    fireEvent.change(composer, { target: { value: "Review failed sign-ins" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(
      await screen.findByText("Conversation storage is temporarily unavailable."),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Retry same request" }),
    );
    expect(
      (await screen.findAllByText("Live persisted answer")).length,
    ).toBeGreaterThan(0);
    await waitFor(() => expect(postBodies).toHaveLength(2));
    expect(postBodies[0].idempotency_key).toMatch(/^chat-/);
    expect(postBodies[1].idempotency_key).toBe(postBodies[0].idempotency_key);
    expect(postBodies[1].history).toEqual([]);
    await waitFor(() =>
      expect(screen.queryByText("Restoring conversation")).not.toBeInTheDocument(),
    );
    expect(composer).not.toBeDisabled();

    const savedRow = await screen.findByRole("button", {
      name: /^Failed sign-in review .* messages$/i,
    });
    expect(savedRow).toHaveAttribute("aria-current", "page");

    await user.click(screen.getByRole("button", { name: "New chat" }));
    expect(screen.getByTestId("workspace-chat-ready")).toBeInTheDocument();
    expect(screen.queryByRole("log", { name: "Chat transcript" })).toBeNull();
    await user.click(savedRow);

    expect(await screen.findByText("Restored server answer")).toBeInTheDocument();
    expect(detailReads).toBe(1);
    expect(screen.getAllByText("Review failed sign-ins").length).toBeGreaterThan(0);
  });
});
