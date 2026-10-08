import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("@/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
    startSession: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined),
    getCurrentSession: vi.fn().mockReturnValue(null),
  },
}));
const startOfferRun = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agent/client/runs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/client/runs")>()),
  startOfferRun,
}));

import { AgentRunCard, describeOfferTarget, estimateRunCost } from "@/components/agent/AgentRunCard";
import { AgentTranscriptActionsProvider, type AgentTranscriptActions } from "@/components/agent/AgentSession";
import { useAgentRuns } from "@/lib/agent/client/runs";
import type { AgentRunOffer, AgentRunRecord } from "@/lib/agent/types";
import { useWorkflowStore } from "@/store/workflowStore";
import type { NodeGroup, WorkflowNode } from "@/types";
import type { WorkflowTabSnapshot } from "@/store/utils/workflowTabs";

function node(id: string, type: string, data: Record<string, unknown> = {}): WorkflowNode {
  return { id, type, position: { x: 0, y: 0 }, data } as WorkflowNode;
}

const NODES = [
  node("prompt", "prompt", { customTitle: "Hero prompt" }),
  node("gen", "nanoBanana", { model: "nano-banana" }),
  node("out", "output"),
];

const offer: AgentRunOffer = {
  offerId: "offer-1",
  tabId: "tab-a",
  workflowName: "Hero shots",
  primary: { scope: { kind: "nodes", nodeIds: ["gen", "out"] }, label: "Run 2 changed nodes", nodeIds: ["gen", "out"] },
  alternatives: [{ scope: { kind: "all" }, label: "Run whole workflow", nodeIds: ["prompt", "gen", "out"] }],
};

function actions(): AgentTranscriptActions {
  return { chatId: "chat-1", send: vi.fn(() => true), showOnCanvas: vi.fn(() => true), busy: false };
}

function renderOffer(value: AgentRunOffer = offer, transcript: AgentTranscriptActions | null = actions()) {
  const card = <AgentRunCard offer={value} />;
  return render(transcript ? <AgentTranscriptActionsProvider value={transcript}>{card}</AgentTranscriptActionsProvider> : card);
}

function record(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    id: "run-1",
    chatId: "chat-1",
    anchor: { offerId: "offer-1" },
    tabId: "tab-a",
    label: "Run 2 changed nodes",
    scope: { kind: "nodes", nodeIds: ["gen", "out"] },
    runs: 1,
    startedAt: Date.now() - 3_000,
    finishedAt: Date.now(),
    status: "done",
    progress: { index: 1, count: 1 },
    plannedNodeIds: ["gen", "out"],
    ranNodeIds: ["gen", "out"],
    outputs: [],
    errors: [],
    ...overrides,
  };
}

function runButton() {
  return screen.getByRole("button", { name: /^Run( again)?( in .+)?$/ });
}

/** Held: still focusable, with its reason as the button's description, and a press runs nothing. */
function expectHeld(reason?: string) {
  const button = runButton();
  expect(button).toHaveAttribute("aria-disabled", "true");
  expect(button).not.toBeDisabled();
  if (reason) expect(button).toHaveAccessibleDescription(reason);
  fireEvent.click(button);
  expect(startOfferRun).not.toHaveBeenCalled();
}

function expectReady() {
  expect(runButton()).not.toHaveAttribute("aria-disabled");
}

beforeEach(() => {
  useWorkflowStore.setState({
    nodes: NODES,
    edges: [],
    tabs: [{ id: "tab-a", snapshot: null }],
    activeTabId: "tab-a",
    workflowName: "Hero shots",
    isRunning: false,
    batch: null,
  });
  useAgentRuns.setState({ records: [] });
  startOfferRun.mockReset();
  startOfferRun.mockReturnValue({ ok: true, record: record() });
});

describe("AgentRunCard", () => {
  it("names what it runs: the nodes, the generators among them and the estimated cost", () => {
    renderOffer();
    const card = screen.getByRole("group", { name: "Run 2 changed nodes" });
    expect(within(card).getByText("Ready to run")).toBeInTheDocument();
    expect(within(card).getByText("2 nodes · 1 generator · ≈ $0.04")).toBeInTheDocument();
    const chips = within(card).getByRole("list", { name: "Nodes it runs" });
    expect(within(chips).getAllByRole("listitem").map((chip) => chip.textContent)).toEqual(["Generate Image", "Output"]);
    expect(runButton()).toHaveAccessibleName("Run");
    expectReady();
  });

  it("multiplies the estimate by the runs, from a 1–50 stepper", () => {
    renderOffer();
    const fewer = screen.getByRole("button", { name: "Fewer runs" });
    expect(fewer).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "More runs" }));
    fireEvent.click(screen.getByRole("button", { name: "More runs" }));
    expect(screen.getByText("2 nodes · 1 generator · ≈ $0.12")).toBeInTheDocument();
    fireEvent.click(runButton());
    expect(startOfferRun).toHaveBeenCalledWith({ chatId: "chat-1", offer, option: offer.primary, runs: 3 });
  });

  it("shows six chips at most, then how many more", () => {
    const many = Array.from({ length: 9 }, (_, index) => node(`p${index}`, "prompt"));
    useWorkflowStore.setState({ nodes: many });
    renderOffer({ ...offer, primary: { scope: { kind: "all" }, label: "Run workflow", nodeIds: many.map((n) => n.id) }, alternatives: [] });
    const chips = screen.getByRole("list", { name: "Nodes it runs" });
    expect(within(chips).getAllByRole("listitem")).toHaveLength(7);
    expect(within(chips).getByLabelText("and 3 more")).toHaveTextContent("+3");
    // No generators priced (none at all): no estimate.
    expect(screen.getByText("9 nodes · 0 generators")).toBeInTheDocument();
  });

  it("is held, saying why, while a run goes", () => {
    useWorkflowStore.setState({ isRunning: true });
    renderOffer();
    expectHeld("Wait for the run to finish");
    expect(screen.getByRole("button", { name: "Other ways to run" })).toBeDisabled();
    expect(screen.getByText("Wait for the run to finish")).toBeInTheDocument();
  });

  it("is held once its nodes are gone, or its tab was closed", () => {
    useWorkflowStore.setState({ nodes: [NODES[0]] });
    const { unmount } = renderOffer();
    expect(screen.getByText("The nodes it would run are no longer on the canvas")).toBeInTheDocument();
    unmount();

    useWorkflowStore.setState({ tabs: [{ id: "tab-z", snapshot: null }], activeTabId: "tab-z" });
    renderOffer();
    expect(screen.getByText("Ready to run · In Hero shots")).toBeInTheDocument();
    expect(screen.getByText("2 nodes")).toBeInTheDocument();
    expect(screen.getByText("That workflow is no longer open")).toBeInTheDocument();
    expectHeld("That workflow is no longer open");
  });

  it("is held when the tab now holds another workflow than the one it was offered for", () => {
    // Cleared and rebuilt since: none of the offered nodes is left, so "Run workflow" would run something else.
    renderOffer({ ...offer, primary: { scope: { kind: "all" }, label: "Run workflow", nodeIds: ["old-1", "old-2"] }, alternatives: [] });
    expect(screen.getByText("The nodes it would run are no longer on the canvas")).toBeInTheDocument();
    expectHeld("The nodes it would run are no longer on the canvas");
  });

  it("runs in another open tab by name", () => {
    useWorkflowStore.setState({
      nodes: [node("elsewhere", "prompt")],
      workflowName: "Scratch",
      tabs: [
        { id: "tab-a", snapshot: { nodes: NODES, workflowName: "Hero shots v2" } as unknown as WorkflowTabSnapshot },
        { id: "tab-b", snapshot: null },
      ],
      activeTabId: "tab-b",
    });
    renderOffer();
    expect(screen.getByText("Ready to run · In Hero shots v2")).toBeInTheDocument();
    expect(runButton()).toHaveAccessibleName("Run in Hero shots v2");
    expect(screen.getByText("2 nodes · 1 generator · ≈ $0.04")).toBeInTheDocument();
    fireEvent.click(runButton());
    expect(startOfferRun).toHaveBeenCalledWith(expect.objectContaining({ option: offer.primary, runs: 1 }));
  });

  it("tells its tab from another of the same name by its place in the strip", () => {
    useWorkflowStore.setState({
      nodes: [node("elsewhere", "prompt")],
      workflowName: null,
      tabs: [
        { id: "tab-b", snapshot: null },
        { id: "tab-a", snapshot: { nodes: NODES, groups: {}, workflowName: null } as unknown as WorkflowTabSnapshot },
      ],
      activeTabId: "tab-b",
    });
    renderOffer({ ...offer, workflowName: undefined });
    expect(screen.getByText("Ready to run · In Untitled (tab 2)")).toBeInTheDocument();
    expect(runButton()).toHaveAccessibleName("Run in Untitled (tab 2)");
  });

  it("waits for the agent's turn before running in another tab (switching would stop the turn)", () => {
    useWorkflowStore.setState({
      tabs: [
        { id: "tab-a", snapshot: { nodes: NODES, workflowName: "Hero shots" } as unknown as WorkflowTabSnapshot },
        { id: "tab-b", snapshot: null },
      ],
      activeTabId: "tab-b",
    });
    renderOffer(offer, { ...actions(), busy: true });
    expectHeld("Wait for the agent to finish");
    expect(screen.getByText("Wait for the agent to finish")).toBeInTheDocument();
  });

  it("offers the alternatives in the chevron's menu", () => {
    renderOffer();
    fireEvent.keyDown(screen.getByRole("button", { name: "Other ways to run" }), { key: "Enter" });
    const menu = screen.getByRole("menu");
    const whole = within(menu).getByRole("menuitem", { name: /Run whole workflow/ });
    expect(whole).toHaveTextContent("3 nodes");
    fireEvent.click(whole);
    expect(startOfferRun).toHaveBeenCalledWith({ chatId: "chat-1", offer, option: offer.alternatives[0], runs: 1 });
  });

  it("has no chevron without alternatives", () => {
    renderOffer({ ...offer, alternatives: [] });
    expect(screen.queryByRole("button", { name: "Other ways to run" })).not.toBeInTheDocument();
  });

  it("says why a run didn't start", () => {
    startOfferRun.mockReturnValue({ ok: false, reason: "The run didn't start" });
    renderOffer();
    fireEvent.click(runButton());
    expect(screen.getByRole("alert")).toHaveTextContent("The run didn't start");
  });

  it("shows its run's results once run, and offers to run it again", () => {
    useAgentRuns.setState({ records: [record({ status: "running", finishedAt: undefined })] });
    useWorkflowStore.setState({ isRunning: true });
    const { rerender } = renderOffer();
    // Under the card's own title, the results are headed by their status.
    const card = screen.getByRole("group", { name: "Run 2 changed nodes" });
    expect(within(card).getByRole("group", { name: "Running" })).toBeInTheDocument();
    expect(within(card).getByRole("heading", { name: "Running" })).toBeInTheDocument();
    // Its own run: Stop is in the results, and the hold needs no explanation.
    expect(screen.queryByText("Wait for the run to finish")).not.toBeInTheDocument();
    expect(runButton()).toHaveAccessibleName("Run again");
    expectHeld();

    useWorkflowStore.setState({ isRunning: false });
    useAgentRuns.setState({ records: [record()] });
    rerender(
      <AgentTranscriptActionsProvider value={actions()}>
        <AgentRunCard offer={offer} />
      </AgentTranscriptActionsProvider>,
    );
    expect(screen.getByRole("heading", { name: "Done" })).toBeInTheDocument();
    expectReady();
    // Run again lives on the card's own button, not twice.
    expect(screen.getAllByRole("button", { name: /^Run again/ })).toHaveLength(1);
  });

  it("runs an alternative it ran last time from the main button, offering the primary in the menu", () => {
    useAgentRuns.setState({ records: [record({ label: "Run whole workflow", scope: { kind: "all" } })] });
    renderOffer();
    expect(screen.getAllByRole("heading", { name: "Run whole workflow" }).length).toBeGreaterThan(0);
    fireEvent.click(runButton());
    expect(startOfferRun).toHaveBeenCalledWith(expect.objectContaining({ option: offer.alternatives[0] }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Other ways to run" }), { key: "Enter" });
    expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: /Run 2 changed nodes/ })).toBeInTheDocument();
  });

  it("leaves the Run controls out without an agent session", () => {
    renderOffer(offer, null);
    expect(screen.getByRole("group", { name: "Run 2 changed nodes" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Run/ })).not.toBeInTheDocument();
  });
});

describe("describeOfferTarget", () => {
  it("leaves out nodes no longer on the canvas", () => {
    const target = describeOfferTarget(offer, offer.primary, {
      activeTabId: "tab-a",
      tabs: [{ id: "tab-a", snapshot: null }],
      nodes: [NODES[1]],
      groups: {},
      workflowName: null,
    });
    expect(target).toMatchObject({ live: true, open: true, workflowName: "Hero shots", generators: 1 });
    expect(target.nodes.map((entry) => entry.id)).toEqual(["gen"]);
  });

  it("describes a whole-workflow run as what the tab holds now, outside locked groups", () => {
    const locked: NodeGroup = { id: "g-locked", name: "Locked", color: "neutral", position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, locked: true };
    const target = describeOfferTarget(offer, offer.alternatives[0], {
      activeTabId: "tab-a",
      tabs: [{ id: "tab-a", snapshot: null }],
      // A video generator added after the offer, and a node in a locked group, which doesn't run.
      nodes: [...NODES, node("vid", "generateVideo"), { ...node("held", "nanoBanana"), groupId: "g-locked" } as WorkflowNode],
      groups: { "g-locked": locked },
      workflowName: null,
    });
    expect(target.nodes.map((entry) => entry.id)).toEqual(["prompt", "gen", "out", "vid"]);
    expect(target.generators).toBe(2);
  });
});

describe("estimateRunCost", () => {
  it("prices Gemini and provider models with a per-run price", () => {
    const priced = node("v", "generateVideo", {
      selectedModel: { provider: "fal", modelId: "fal/video", displayName: "Video", pricing: { type: "per-run", amount: 0.5 } },
    });
    expect(estimateRunCost([NODES[1], priced], 2)).toBeCloseTo(0.539);
  });

  it("gives none when a generator's price is unknown or not per run", () => {
    const unpriced = node("r", "nanoBanana", { selectedModel: { provider: "replicate", modelId: "r/img", displayName: "Img" } });
    expect(estimateRunCost([NODES[1], unpriced], 2)).toBeNull();
    const perSecond = node("s", "generateVideo", {
      selectedModel: { provider: "kie", modelId: "kie/v", displayName: "V", pricing: { type: "per-second", amount: 0.1 } },
    });
    expect(estimateRunCost([perSecond], 1)).toBeNull();
    // An LLM isn't priced: the sum would leave it out.
    expect(estimateRunCost([NODES[1], node("l", "llmGenerate")], 2)).toBeNull();
  });
});
