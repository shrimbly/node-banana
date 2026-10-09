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

/** Opens the folded line over a turn's tool calls. */
function openTools(name: RegExp = /Used \d+ tools?/) {
  fireEvent.click(screen.getByRole("button", { name }));
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
    expect(screen.getByRole("group", { name: "Run workflow" })).toBeInTheDocument();
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

  it("shows the results of a run a run_workflow call once started, after the reply's text", () => {
    const message = reply([
      toolPart("edit_workflow", "call-edit", { ok: true, summary: "Added 2 nodes" }),
      toolPart("mcp__node_banana__run_workflow", "call-run", { ok: true, summary: "Started the run" }),
      { type: "text", text: "Running it now.", state: "done" },
    ]);
    const { container } = render(<AgentMessage message={message} streaming={false} />);
    expect(container.querySelector("[data-run-results]")).toBeNull();

    act(() => useAgentRuns.setState({ records: [runRecord()] }));
    const results = screen.getByRole("group", { name: "Ran the workflow" });
    // In view without opening the folded calls, under the summary.
    expect(screen.getByText("Running it now.").compareDocumentPosition(results) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
    // Folded until opened.
    expect(screen.queryByRole("button", { name: "Show on canvas" })).not.toBeInTheDocument();
    openTools();
    // Only on the call that names nodes.
    const buttons = screen.getAllByRole("button", { name: "Show on canvas" });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(actions.showOnCanvas).toHaveBeenCalledWith({ tabId: "tab-a", nodeIds: ["gen", "out"] });
    expect(screen.queryByText("Input")).not.toBeInTheDocument();
    // One line: the name, then what came of it; a finished call shows no status, only says it to screen readers.
    const row = screen.getByRole("button", { name: /Edit workflow/ });
    expect(row).toHaveTextContent(/^Edit workflowAdded 2 nodesDone$/);
    expect(within(row).getByText("Done")).toHaveClass("sr-only");
  });

  it("always shows a tool row's actions on a touch screen, where nothing hovers", () => {
    render(
      <AgentTranscriptActionsProvider value={transcript()}>
        <AgentMessage
          message={reply([toolPart("edit_workflow", "call-edit", { ok: true, summary: "Added 2 nodes", nodeIds: ["gen"] })])}
          streaming={false}
        />
      </AgentTranscriptActionsProvider>,
    );
    openTools();
    const actions = screen.getByRole("button", { name: "Show on canvas" }).closest("[data-tool-actions]")!;
    expect(actions.className).toContain("pointer-coarse:opacity-100");
  });

  it("leaves Show on canvas out without the agent session", () => {
    render(
      <AgentMessage
        message={reply([toolPart("edit_workflow", "call-edit", { ok: true, summary: "Added", nodeIds: ["gen"] })])}
        streaming={false}
      />,
    );
    openTools();
    expect(screen.queryByRole("button", { name: "Show on canvas" })).not.toBeInTheDocument();
  });
});

describe("AgentMessage tool rows", () => {
  it("folds a turn's calls under one line, Used N tools and what came of them, opening to a line each", () => {
    render(
      <AgentMessage
        message={reply([
          toolPart("get_workflow", "call-read", { ok: true, summary: "Read the workflow (3 nodes)" }),
          toolPart("edit_workflow", "call-edit", { ok: true, summary: "Updated 4 nodes", nodeIds: ["a", "b", "c", "d"] }),
          { type: "text", text: "Updated all four prompts.", state: "done" },
        ])}
        streaming={false}
      />,
    );
    const folded = screen.getByRole("button", { name: /Used 2 tools/ });
    expect(folded).toHaveTextContent(/^Used 2 tools· updated 4 nodes$/);
    expect(folded).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Read the workflow (3 nodes)")).not.toBeInTheDocument();

    fireEvent.click(folded);
    expect(folded).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /Get workflow/ })).toHaveTextContent(/^Get workflowRead the workflow \(3 nodes\)Done$/);
    expect(screen.getByRole("button", { name: /Edit workflow/ })).toBeInTheDocument();
  });

  it("names the call still running in place of the count, and counts failures in red", () => {
    const running = { type: "dynamic-tool", toolName: "edit_workflow", toolCallId: "call-run", state: "input-available", input: {} } as Part;
    const failed = toolPart("run_workflow", "call-fail", { ok: false, summary: "Inputs not ready" });
    const { rerender } = render(<AgentMessage message={reply([failed, running])} streaming />);
    expect(screen.getByRole("button", { name: /Edit workflow…/ })).toHaveTextContent(/^Edit workflow…$/);

    const finished = toolPart("edit_workflow", "call-run", { ok: true, summary: "Updated 1 node", nodeIds: ["gen"] });
    rerender(<AgentMessage message={reply([failed, finished])} streaming={false} />);
    const folded = screen.getByRole("button", { name: /Used 2 tools/ });
    expect(folded).toHaveTextContent(/^Used 2 tools· updated 1 node· 1 failed$/);
    expect(within(folded).getByText("· 1 failed")).toHaveClass("text-red-400");
  });

  it("shows a stopped turn's tools as used, not running: the call cut off by Stop never finishes", () => {
    const failed = toolPart("run_workflow", "call-fail", { ok: false, summary: "Inputs not ready" });
    const cutOff = { type: "dynamic-tool", toolName: "edit_workflow", toolCallId: "call-cut", state: "input-available", input: {} } as Part;
    render(<AgentMessage message={reply([failed, cutOff])} streaming={false} />);
    expect(screen.getByRole("button", { name: /Used 2 tools/ })).toHaveTextContent(/^Used 2 tools· 1 failed$/);
  });

  it("marks a running call with a dot and a failed one in red, at the end of its line", () => {
    const running = { type: "dynamic-tool", toolName: "edit_workflow", toolCallId: "call-run", state: "input-available", input: {} } as Part;
    const failed = toolPart("run_workflow", "call-fail", { ok: false, summary: "Inputs not ready" });
    const { container } = render(<AgentMessage message={reply([running, failed])} streaming />);
    openTools(/Edit workflow…/);
    const [first, second] = container.querySelectorAll<HTMLElement>("[data-agent-tool] button");
    expect(within(first).getByText("Running")).toHaveClass("sr-only");
    expect(first.querySelector('[data-agent-tool-status="input-available"] .animate-ping')).toBeInTheDocument();
    expect(within(second).getByText("Inputs not ready")).toHaveClass("text-red-400");
    expect(second.querySelector('[data-agent-tool-status="output-error"] .bg-error')).toBeInTheDocument();
  });
});

describe("AgentMessage built workflow", () => {
  const graph = { name: "Cat posters", nodes: [["prompt", 0, 0, 320, 220], ["nanoBanana", 420, 0, 300, 460]], edges: [[0, 1]] };
  const message = () =>
    reply([
      toolPart("create_workflow", "call-build", { ok: true, summary: "Added 2 nodes, 1 connection", tabId: "tab-a", nodeIds: ["p", "g"], graph }),
      { type: "text", text: "I built Cat posters.", state: "done" },
    ]);

  beforeEach(() => {
    useWorkflowStore.setState({ tabs: [{ id: "tab-a", snapshot: null }], activeTabId: "tab-a", workflowName: "Cat posters" });
  });

  it("draws the workflow a call built after the reply's text, on the full page", () => {
    const { container } = render(
      <AgentSurfaceProvider value="page">
        <AgentMessage message={message()} streaming={false} />
      </AgentSurfaceProvider>,
    );
    const preview = screen.getByRole("group", { name: "Cat posters" });
    expect(preview).toHaveTextContent("2 nodes · 1 connection");
    const tools = container.querySelector("[data-agent-tool-group]")!;
    const summary = screen.getByText("I built Cat posters.");
    expect(tools.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(summary.compareDocumentPosition(preview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("puts the Run card under the workflow it runs, both after the summary", () => {
    render(
      <AgentSurfaceProvider value="page">
        <AgentMessage message={{ ...message(), parts: [...message().parts, offerPart] }} streaming={false} />
      </AgentSurfaceProvider>,
    );
    const summary = screen.getByText("I built Cat posters.");
    const preview = screen.getByRole("group", { name: "Cat posters" });
    const card = screen.getByRole("group", { name: "Run workflow" });
    expect(summary.compareDocumentPosition(preview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(preview.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("leaves it out of the floating window", () => {
    const { container } = render(
      <AgentSurfaceProvider value="window">
        <AgentMessage message={message()} streaming={false} />
      </AgentSurfaceProvider>,
    );
    expect(container.querySelector("[data-workflow-preview]")).toBeNull();
  });
});
