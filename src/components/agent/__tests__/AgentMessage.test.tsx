import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { AgentMessage } from "@/components/agent/AgentMessage";
import { AgentTranscriptActionsProvider, type AgentTranscriptActions } from "@/components/agent/AgentSession";
import { AgentSurfaceProvider } from "@/components/agent/AgentSurface";
import { useAgentRuns } from "@/lib/agent/client/runs";
import type { AgentRunOffer, AgentRunRecord, AgentUIMessage } from "@/lib/agent/types";
import { useWorkflowStore } from "@/store/workflowStore";
import type { WorkflowNode } from "@/types";

const thinking: AgentUIMessage = {
  id: "a1",
  role: "assistant",
  parts: [
    {
      type: "reasoning",
      text: "I should use create_workflow to add these nodes, as per rule 4.",
      state: "streaming",
    },
  ],
};

describe("AgentMessage reasoning", () => {
  it("stays collapsed while it streams: a Thinking… line, not the model's working notes (UX audit)", () => {
    render(<AgentMessage message={thinking} streaming />);
    expect(screen.getByText("Thinking…")).toBeInTheDocument();
    expect(screen.queryByText(/create_workflow/)).not.toBeInTheDocument();
  });

  it("opens on request", () => {
    render(<AgentMessage message={thinking} streaming />);
    fireEvent.click(screen.getByRole("button", { name: /Thinking/ }));
    expect(screen.getByText(/create_workflow/)).toBeInTheDocument();
  });

  it("stays open when opened after the reply finished", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<AgentMessage message={thinking} streaming />);
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      const done: AgentUIMessage = { ...thinking, parts: [{ ...thinking.parts[0], state: "done" } as AgentUIMessage["parts"][number]] };
      rerender(<AgentMessage message={done} streaming={false} />);
      fireEvent.click(screen.getByRole("button", { name: /Thought for/ }));
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(screen.getByText(/create_workflow/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

type Part = AgentUIMessage["parts"][number];

function reply(parts: Part[]): AgentUIMessage {
  return { id: "a2", role: "assistant", parts };
}

describe("AgentMessage copy", () => {
  const writeText = vi.fn<(text: string) => Promise<void>>();
  beforeEach(() => {
    writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  });

  const answer = reply([
    { type: "text", text: "Here is the prompt:", state: "done" },
    toolPart("edit_workflow", "call-edit", { ok: true, summary: "Set the prompt" }),
    { type: "text", text: "**A fox at dusk**, 35mm, soft rim light.\n", state: "done" },
  ]);

  it("copies a finished reply's text as markdown, leaving its tool rows and cards out", async () => {
    render(<AgentMessage message={answer} streaming={false} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy reply" })));
    expect(writeText).toHaveBeenCalledWith("Here is the prompt:\n\n**A fox at dusk**, 35mm, soft rim light.");
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("offers no copy while the reply streams, nor under a reply with no text", () => {
    const { rerender } = render(<AgentMessage message={answer} streaming />);
    expect(screen.queryByRole("button", { name: "Copy reply" })).not.toBeInTheDocument();
    rerender(<AgentMessage message={reply([toolPart("edit_workflow", "call-edit", { ok: true, summary: "Added" })])} streaming={false} />);
    expect(screen.queryByRole("button", { name: "Copy reply" })).not.toBeInTheDocument();
    rerender(<AgentMessage message={{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }} streaming={false} />);
    expect(screen.queryByRole("button", { name: "Copy reply" })).not.toBeInTheDocument();
  });

  it("stays quiet until the reply is hovered or the button focused, and always shows on touch", () => {
    render(<AgentMessage message={answer} streaming={false} />);
    const row = screen.getByRole("button", { name: "Copy reply" }).closest("[data-message-actions]")!;
    expect(row.className).toContain("opacity-0");
    expect(row.className).toContain("group-hover/message:opacity-100");
    expect(row.className).toContain("focus-within:opacity-100");
    expect(row.className).toContain("pointer-coarse:opacity-100");
  });

  it("shows under the latest reply on the page, as chat apps do", () => {
    const { rerender } = render(
      <AgentSurfaceProvider value="page">
        <AgentMessage message={answer} streaming={false} latest />
      </AgentSurfaceProvider>,
    );
    const row = () => screen.getByRole("button", { name: "Copy reply" }).closest("[data-message-actions]")!;
    expect(row().className).not.toContain("opacity-0");
    // An earlier one, once another reply follows: on hover again.
    rerender(
      <AgentSurfaceProvider value="page">
        <AgentMessage message={answer} streaming={false} latest={false} />
      </AgentSurfaceProvider>,
    );
    expect(row().className).toContain("opacity-0");
  });
});

function toolPart(toolName: string, toolCallId: string, output: unknown): Part {
  return { type: "dynamic-tool", toolName, toolCallId, state: "output-available", input: { scope: "all" }, output } as Part;
}

const offer: AgentRunOffer = {
  offerId: "offer-1",
  tabId: "tab-a",
  primary: { scope: { kind: "all" }, label: "Run workflow", nodeIds: ["gen"] },
  alternatives: [],
};
const offerPart = { type: "data-run-offer", id: "run-offer", data: offer } as Part;

function runRecord(): AgentRunRecord {
  return {
    id: "run-1",
    chatId: "chat-1",
    anchor: { toolCallId: "call-run" },
    tabId: "tab-a",
    label: "Ran the workflow",
    scope: { kind: "all" },
    runs: 1,
    startedAt: Date.now() - 4_000,
    finishedAt: Date.now(),
    status: "done",
    progress: { index: 1, count: 1 },
    plannedNodeIds: [],
    ranNodeIds: ["gen"],
    outputs: [],
    errors: [],
  };
}

function transcript(): AgentTranscriptActions {
  return { chatId: "chat-1", send: vi.fn(() => true), showOnCanvas: vi.fn(() => true), busy: false };
}

describe("AgentMessage runs", () => {
  beforeEach(() => {
    useWorkflowStore.setState({
      nodes: [{ id: "gen", type: "nanoBanana", position: { x: 0, y: 0 }, data: {} } as WorkflowNode],
      tabs: [{ id: "tab-a", snapshot: null }],
      activeTabId: "tab-a",
      isRunning: false,
      batch: null,
    });
    useAgentRuns.setState({ records: [] });
  });

  it("draws a run offer as the Run card, without the session's Run controls on its own", () => {
    render(<AgentMessage message={reply([offerPart])} streaming={false} />);
    expect(screen.getByRole("group", { name: "Run workflow" })).toHaveTextContent("Ready to run");
    expect(screen.queryByRole("button", { name: "Run" })).not.toBeInTheDocument();
  });

  it("offers Run inside the agent session", () => {
    render(
      <AgentTranscriptActionsProvider value={transcript()}>
        <AgentMessage message={reply([offerPart])} streaming={false} />
      </AgentTranscriptActionsProvider>,
    );
    expect(screen.getByRole("button", { name: "Run" })).toBeEnabled();
  });

  it("shows a run_workflow call's results under the tool rows, once the run is recorded", () => {
    const message = reply([
      toolPart("edit_workflow", "call-edit", { ok: true, summary: "Added 2 nodes" }),
      toolPart("mcp__node_banana__run_workflow", "call-run", { ok: true, summary: "Started the run" }),
      { type: "text", text: "Running it now.", state: "done" },
    ]);
    const { container } = render(<AgentMessage message={message} streaming={false} />);
    expect(container.querySelector("[data-run-results]")).toBeNull();

    act(() => useAgentRuns.setState({ records: [runRecord()] }));
    const results = screen.getByRole("group", { name: "Ran the workflow" });
    const rows = container.querySelector("[data-agent-tool]")!.parentElement!;
    // After the tool list, before the text that followed the calls.
    expect(rows.compareDocumentPosition(results) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(results.compareDocumentPosition(screen.getByText("Running it now.")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("puts Show on canvas on a tool row that changed nodes, without opening the row", () => {
    const actions = transcript();
    render(
      <AgentTranscriptActionsProvider value={actions}>
        <AgentMessage
          message={reply([
            toolPart("edit_workflow", "call-edit", { ok: true, summary: "Added 2 nodes", tabId: "tab-a", nodeIds: ["gen", "out"] }),
            toolPart("get_workflow", "call-read", { ok: true, summary: "Read the workflow" }),
          ])}
          streaming={false}
        />
      </AgentTranscriptActionsProvider>,
    );
    // Only on the call that names nodes.
    const buttons = screen.getAllByRole("button", { name: "Show on canvas" });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(actions.showOnCanvas).toHaveBeenCalledWith({ tabId: "tab-a", nodeIds: ["gen", "out"] });
    expect(screen.queryByText("Input")).not.toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: /Edit workflow/ })).getByText("Done")).toBeInTheDocument();
  });

  it("shows a tool row's actions in place of its status on a touch screen, where nothing hovers", () => {
    render(
      <AgentTranscriptActionsProvider value={transcript()}>
        <AgentMessage
          message={reply([toolPart("edit_workflow", "call-edit", { ok: true, summary: "Added 2 nodes", nodeIds: ["gen"] })])}
          streaming={false}
        />
      </AgentTranscriptActionsProvider>,
    );
    // An invisible button over "Done" would still take the tap meant for the row.
    const actions = screen.getByRole("button", { name: "Show on canvas" }).closest("[data-tool-actions]")!;
    expect(actions.className).toContain("pointer-coarse:opacity-100");
    expect(within(screen.getByRole("button", { name: /Edit workflow/ })).getByText("Done").className).toContain("pointer-coarse:opacity-0");
  });

  it("leaves Show on canvas out without the agent session", () => {
    render(
      <AgentMessage
        message={reply([toolPart("edit_workflow", "call-edit", { ok: true, summary: "Added", nodeIds: ["gen"] })])}
        streaming={false}
      />,
    );
    expect(screen.queryByRole("button", { name: "Show on canvas" })).not.toBeInTheDocument();
  });
});
