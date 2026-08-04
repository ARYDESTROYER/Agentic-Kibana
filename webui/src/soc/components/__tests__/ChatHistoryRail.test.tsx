import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe, toHaveNoViolations } from "jest-axe";

import type { ChatConversationSummary } from "@/lib/types";
import { ChatHistoryRail } from "../ChatHistoryRail";

expect.extend(toHaveNoViolations);

function summary(
  id: string,
  title: string,
  updatedAt: string,
  messageCount = 2,
): ChatConversationSummary {
  return {
    id,
    title,
    preview: `${title} preview`,
    created_at: updatedAt,
    updated_at: updatedAt,
    message_count: messageCount,
  };
}

function dayAtNoon(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  date.setHours(12, 0, 0, 0);
  return date.toISOString();
}

const CONVERSATIONS = [
  summary("today", "Investigate sign-ins", dayAtNoon(0)),
  summary("yesterday", "Review endpoint alert", dayAtNoon(1), 4),
  summary("older", "Quarterly posture", dayAtNoon(10), 8),
];

function renderRail(
  overrides: Partial<React.ComponentProps<typeof ChatHistoryRail>> = {},
) {
  const handlers = {
    onRetry: vi.fn(),
    onNew: vi.fn(),
    onSelect: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
  };
  const view = render(
    <ChatHistoryRail
      conversations={CONVERSATIONS}
      activeId="today"
      {...handlers}
      {...overrides}
    />,
  );
  return { ...view, ...handlers };
}

describe("ChatHistoryRail", () => {
  it("exposes grouped saved conversations and the current thread", () => {
    const { onSelect } = renderRail();

    expect(screen.getByRole("navigation", { name: "Conversation history" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Today" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Yesterday" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Older" })).toBeInTheDocument();

    const active = screen.getByRole("button", {
      name: /^Investigate sign-ins .* messages$/i,
    });
    const previous = screen.getByRole("button", {
      name: /^Review endpoint alert .* messages$/i,
    });
    expect(active).toHaveAttribute("aria-current", "page");
    expect(previous).not.toHaveAttribute("aria-current");

    fireEvent.click(previous);
    expect(onSelect).toHaveBeenCalledWith(CONVERSATIONS[1]);
  });

  it("starts a new conversation and filters title or preview text", () => {
    const { onNew } = renderRail({ showNewAction: true });

    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    expect(onNew).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByRole("textbox", { name: "Search conversations" }), {
      target: { value: "endpoint" },
    });
    expect(
      screen.getByRole("button", {
        name: /^Review endpoint alert .* messages$/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: /^Investigate sign-ins .* messages$/i,
      }),
    ).toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: "Search conversations" }), {
      target: { value: "no such thread" },
    });
    expect(screen.getByText("No matching conversations")).toBeInTheDocument();
  });

  it("keeps a true empty history quiet until a conversation exists", () => {
    renderRail({ conversations: [] });

    expect(screen.getByText("No previous conversations")).toBeInTheDocument();
    expect(
      screen.getByText("A conversation appears here after its first response."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "Search conversations" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "New conversation" }),
    ).toBeNull();
  });

  it("shows searchable previews and disables row actions while a turn is committing", () => {
    const previewOnly = {
      ...CONVERSATIONS[0],
      preview: "Unusual device fingerprint from Madrid",
    };
    const { onSelect } = renderRail({
      conversations: [previewOnly],
      activeId: previewOnly.id,
      showNewAction: true,
      disabled: true,
    });

    expect(
      screen.getByText("Unusual device fingerprint from Madrid"),
    ).toBeInTheDocument();
    fireEvent.change(
      screen.getByRole("textbox", { name: "Search conversations" }),
      { target: { value: "Madrid" } },
    );
    const row = screen.getByRole("button", {
      name: /^Investigate sign-ins .* messages$/i,
    });
    expect(row).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Actions for Investigate sign-ins" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "New conversation" }),
    ).toBeDisabled();

    fireEvent.click(row);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("renames and deletes from the row action menu", async () => {
    const user = userEvent.setup();
    const { onRename, onDelete } = renderRail();

    await user.click(
      screen.getByRole("button", { name: "Actions for Investigate sign-ins" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }));

    const input = screen.getByRole("textbox", { name: "Rename Investigate sign-ins" });
    await user.clear(input);
    await user.type(input, "Failed sign-in review{Enter}");
    expect(onRename).toHaveBeenCalledWith(CONVERSATIONS[0], "Failed sign-in review");

    await user.click(
      screen.getByRole("button", { name: "Actions for Investigate sign-ins" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledWith(CONVERSATIONS[0]);
  });

  it("does not commit a rename while an IME composition is active", async () => {
    const user = userEvent.setup();
    const { onRename } = renderRail();

    await user.click(
      screen.getByRole("button", { name: "Actions for Investigate sign-ins" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Rename Investigate sign-ins" });
    fireEvent.change(input, { target: { value: "正在调查" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(onRename).not.toHaveBeenCalled();
    expect(input).toHaveValue("正在调查");

    fireEvent.keyDown(input, { key: "Enter", isComposing: false });
    expect(onRename).toHaveBeenCalledWith(CONVERSATIONS[0], "正在调查");
  });

  it("discloses the bounded history window without implying infinite retention", () => {
    const { rerender, onRetry, onNew, onSelect, onRename, onDelete } = renderRail({
      retentionLimit: 50,
    });
    expect(screen.getByRole("note")).toHaveTextContent(
      "Workspace keeps up to 50 conversations",
    );

    rerender(
      <ChatHistoryRail
        conversations={CONVERSATIONS}
        retentionLimit={50}
        retentionTruncated
        retentionTotal={64}
        onRetry={onRetry}
        onNew={onNew}
        onSelect={onSelect}
        onRename={onRename}
        onDelete={onDelete}
      />,
    );
    expect(screen.getByRole("note")).toHaveTextContent(
      "Showing the latest 3 of 64 conversations",
    );
    expect(screen.getByRole("note")).toHaveTextContent("removed by retention");
  });

  it("renders honest loading and retryable error states", () => {
    const { rerender, onRetry, onNew, onSelect, onRename, onDelete } = renderRail({
      conversations: [],
      loading: true,
    });
    expect(screen.getByRole("navigation", { name: "Conversation history" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading conversations…");

    rerender(
      <ChatHistoryRail
        conversations={[]}
        error="Conversation history is unavailable"
        onRetry={onRetry}
        onNew={onNew}
        onSelect={onSelect}
        onRename={onRename}
        onDelete={onDelete}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Conversation history is unavailable",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("has no detectable accessibility violations with saved conversations", async () => {
    const { container } = renderRail();
    expect(await axe(container)).toHaveNoViolations();
  });
});
