import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { AgentGraphPreview } from "@/lib/agent/types";
import { useWorkflowStore } from "@/store/workflowStore";
import { AgentTranscriptActionsProvider, type AgentTranscriptActions } from "../AgentSession";
import { AgentWorkflowPreview, layoutGraphMap } from "../AgentWorkflowPreview";

const graph: AgentGraphPreview = {
  name: "Cat posters",
  nodes: [
    ["prompt", -200, 100, 300, 200],
    ["nanoBanana", 300, 0, 300, 500],
    ["output", 800, 100, 300, 300],
  ],
  edges: [
    [0, 1],
    [1, 2],
  ],
};

function transcript(): AgentTranscriptActions {
  return { chatId: "chat-1", send: vi.fn(() => true), showOnCanvas: vi.fn(() => true), busy: false };
}

describe("layoutGraphMap", () => {
  it("fits the graph inside the map's padding at the canvas's proportions, centred", () => {
    const map = layoutGraphMap(graph, 300, 150, 14);
    const left = Math.min(...map.nodes.map((n) => n.x));
    const right = Math.max(...map.nodes.map((n) => n.x + n.width));
    const top = Math.min(...map.nodes.map((n) => n.y));
    const bottom = Math.max(...map.nodes.map((n) => n.y + n.height));
    // 1300 × 500 at 0.244: the width is the tight side.
    expect(left).toBeCloseTo(14);
    expect(right).toBeCloseTo(286);
    expect(top).toBeCloseTo(150 / 2 - (500 * 272) / 1300 / 2);
    expect(top + bottom).toBeCloseTo(150);
    expect(map.nodes[1].height / map.nodes[1].width).toBeCloseTo(500 / 300);
    expect(map.edges).toHaveLength(2);
    expect(map.edges[0]).toMatch(/^M\S+ \S+C/);
  });
});

describe("AgentWorkflowPreview", () => {
  beforeEach(() => {
    useWorkflowStore.setState({
      tabs: [
        { id: "tab-a", snapshot: null },
        { id: "tab-b", snapshot: { workflowName: "Cat posters, final" } as never },
      ],
      activeTabId: "tab-a",
      workflowName: "Fox portraits",
    });
  });

  it("draws the map with the tab's current name and its size, and opens the whole workflow in the canvas", () => {
    const actions = transcript();
    const { container } = render(
      <AgentTranscriptActionsProvider value={actions}>
        <AgentWorkflowPreview tabId="tab-b" graph={graph} />
      </AgentTranscriptActionsProvider>,
    );
    const preview = screen.getByRole("group", { name: "Cat posters, final" });
    expect(preview).toHaveTextContent("3 nodes · 2 connections");
    const map = container.querySelector('svg[width="300"]')!;
    expect(map.querySelectorAll("rect")).toHaveLength(3);
    expect(map.querySelectorAll("path")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: /Open in canvas/ }));
    expect(actions.showOnCanvas).toHaveBeenCalledWith({ tabId: "tab-b", all: true });
  });

  it("keeps the name it was built with once its tab has closed, and says it is no longer open", () => {
    render(
      <AgentTranscriptActionsProvider value={transcript()}>
        <AgentWorkflowPreview tabId="tab-gone" graph={graph} />
      </AgentTranscriptActionsProvider>,
    );
    expect(screen.getByRole("group", { name: "Cat posters" })).toHaveTextContent("No longer open");
    expect(screen.queryByRole("button", { name: /Open in canvas/ })).not.toBeInTheDocument();
  });

  it("offers no way in without the agent session", () => {
    render(<AgentWorkflowPreview tabId="tab-a" graph={graph} />);
    expect(screen.getByRole("group", { name: "Fox portraits" })).not.toHaveTextContent(/Open in canvas|No longer open/);
  });
});
