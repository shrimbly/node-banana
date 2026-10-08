import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { AgentMessage } from "@/components/agent/AgentMessage";
import { AgentTranscriptActionsProvider, type AgentTranscriptActions } from "@/components/agent/AgentSession";
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
