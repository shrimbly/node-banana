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
const stopChatRun = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agent/client/runs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/client/runs")>()),
  startOfferRun,
  stopChatRun,
}));

import { AgentRunCard, describeOfferTarget, estimateRunCost, groupOfferNodes } from "@/components/agent/AgentRunCard";
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
  return screen.getByRole("button", { name: /^Run( again)?( in .+?)?(, \d+ runs)?$/ });
}

/** The card's one line: its name, then what it runs (or where, or how the run went), then the estimate. */
function offerLine(card: HTMLElement = document.querySelector<HTMLElement>("[data-run-offer]")!) {
  return within(card).getByRole("heading").parentElement as HTMLElement;
}

function openMenu() {
  fireEvent.keyDown(screen.getByRole("button", { name: "Run options" }), { key: "Enter" });
  return screen.getByRole("menu");
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
  stopChatRun.mockReset();
});

describe("AgentRunCard", () => {
  it("is one frameless line: its name, the nodes it runs, the estimate, and the Run button", () => {
    renderOffer();
    const card = screen.getByRole("group", { name: "Run 2 changed nodes" });
    expect(within(card).queryByText(/Ready to run/i)).not.toBeInTheDocument();
    expect(offerLine(card)).toHaveTextContent(/^Run 2 changed nodes· Generate Image · Output≈ \$0\.04$/);
    expect(runButton()).toHaveAccessibleName("Run");
    expect(runButton()).toHaveTextContent(/^Run$/);
    expectReady();
  });

  it("names alike nodes once, with how many", () => {
    const gens = Array.from({ length: 4 }, (_, index) => node(`g${index}`, "nanoBanana"));
    useWorkflowStore.setState({ nodes: [...gens, node("gallery", "outputGallery")] });
    const ids = [...gens.map((n) => n.id), "gallery"];
    renderOffer({ ...offer, primary: { scope: { kind: "nodes", nodeIds: ids }, label: "Run 4 changed nodes", nodeIds: ids }, alternatives: [] });
    expect(offerLine()).toHaveTextContent(/^Run 4 changed nodes· Generate Image ×4 · Output Gallery/);
    // Every node is still named in full on hover.
    expect(offerLine().querySelector("[title]")).toHaveAttribute("title", "Generate Image, Generate Image, Generate Image, Generate Image, Output Gallery");
  });

  it("sets the runs in the button's menu, as the canvas's Run menu does, and prices them", () => {
    renderOffer();
    let menu = openMenu();
    expect(within(menu).getByRole("menuitem", { name: "Fewer runs" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "More runs" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "More runs" }));
    // The steps keep the menu open.
    menu = screen.getByRole("menu");
    expect(within(menu).getByRole("group", { name: "Runs" })).toHaveTextContent("3");
    expect(offerLine()).toHaveTextContent("≈ $0.12");
    expect(runButton()).toHaveTextContent(/^Run ×3$/);
    expect(runButton()).toHaveAccessibleName("Run, 3 runs");
    fireEvent.click(runButton());
    expect(startOfferRun).toHaveBeenCalledWith({ chatId: "chat-1", offer, option: offer.primary, runs: 3 });
  });

  it("is held, saying why, while a run goes; its menu still opens", () => {
    useWorkflowStore.setState({ isRunning: true });
    renderOffer();
    expectHeld("Wait for the run to finish");
    expect(screen.getByText("Wait for the run to finish")).toBeInTheDocument();
    const menu = openMenu();
    expect(within(menu).getByRole("menuitem", { name: /Run whole workflow/ })).toHaveAttribute("aria-disabled", "true");
  });

  it("is held once its nodes are gone, or its tab was closed", () => {
    useWorkflowStore.setState({ nodes: [NODES[0]] });
    const { unmount } = renderOffer();
    expect(screen.getByText("The nodes it would run are no longer on the canvas")).toBeInTheDocument();
    unmount();

    useWorkflowStore.setState({ tabs: [{ id: "tab-z", snapshot: null }], activeTabId: "tab-z" });
    renderOffer();
    expect(offerLine()).toHaveTextContent(/^Run 2 changed nodes· In Hero shots · 2 nodes$/);
    expect(screen.getByText("That workflow is no longer open")).toBeInTheDocument();
    expectHeld("That workflow is no longer open");
  });

  it("is held when the tab now holds another workflow than the one it was offered for", () => {
    // Cleared and rebuilt since: none of the offered nodes is left, so "Run workflow" would run something else.
    renderOffer({ ...offer, primary: { scope: { kind: "all" }, label: "Run workflow", nodeIds: ["old-1", "old-2"] }, alternatives: [] });
    expect(screen.getByText("The nodes it would run are no longer on the canvas")).toBeInTheDocument();
    expectHeld("The nodes it would run are no longer on the canvas");
  });

  it("runs in another open tab, saying which on its line and in the button's name", () => {
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
    expect(offerLine()).toHaveTextContent(/^Run 2 changed nodes· In Hero shots v2 · Generate Image · Output≈ \$0\.04$/);
    expect(runButton()).toHaveAccessibleName("Run in Hero shots v2");
    expect(runButton()).toHaveTextContent(/^Run$/);
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
    expect(offerLine()).toHaveTextContent(/^Run 2 changed nodes· In Untitled \(tab 2\) · /);
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

  it("offers the other ways to run in the button's menu", () => {
    renderOffer();
    const whole = within(openMenu()).getByRole("menuitem", { name: /Run whole workflow/ });
    expect(whole).toHaveTextContent("3 nodes");
    fireEvent.click(whole);
    expect(startOfferRun).toHaveBeenCalledWith({ chatId: "chat-1", offer, option: offer.alternatives[0], runs: 1 });
  });

  it("lays its menu out as the canvas's Run menu: the other ways to run, Show on canvas, then the run count", () => {
    useAgentRuns.setState({ records: [record()] });
    renderOffer();
    const menu = openMenu();
    expect(within(menu).getAllByRole("menuitem").map((item) => item.getAttribute("aria-label") ?? item.textContent)).toEqual([
      "Run whole workflow3 nodes",
      "Show on canvas",
      "Fewer runs",
      "More runs",
    ]);
    expect(within(menu).queryByText(/Run instead/i)).not.toBeInTheDocument();
  });

  it("keeps the run count in the menu when there is no other way to run", () => {
    renderOffer({ ...offer, alternatives: [] });
    const menu = openMenu();
    expect(within(menu).getByRole("group", { name: "Runs" })).toBeInTheDocument();
    expect(within(menu).queryByText("Run instead")).not.toBeInTheDocument();
  });

  it("says why a run didn't start", () => {
    startOfferRun.mockReturnValue({ ok: false, reason: "The run didn't start" });
    renderOffer();
    fireEvent.click(runButton());
    expect(screen.getByRole("alert")).toHaveTextContent("The run didn't start");
  });

  it("once run, its line says how the run goes and its button (now quiet) stops it, then runs it again", () => {
    useAgentRuns.setState({ records: [record({ status: "running", finishedAt: undefined })] });
    useWorkflowStore.setState({ isRunning: true });
    const { rerender } = renderOffer();
    const card = screen.getByRole("group", { name: "Run 2 changed nodes" });
    // Its generator still to make: "0 of 1".
    expect(offerLine(card)).toHaveTextContent(/^Run 2 changed nodes· Running · 0 of 1 · \ds$/);
    // No second header: the previews (a placeholder for the generator still to come) sit straight under the line.
    expect(within(card).getAllByRole("heading")).toHaveLength(1);
    expect(within(card).getByRole("group", { name: "1 preview" }).querySelector('[data-run-skeleton="image"]')).toBeInTheDocument();
    // Its own run: no hold to explain, and the button is its Stop.
    expect(screen.queryByText("Wait for the run to finish")).not.toBeInTheDocument();
    const stop = within(card).getByRole("button", { name: "Stop" });
    expect(stop).not.toHaveAttribute("aria-disabled");
    fireEvent.click(stop);
    expect(stopChatRun).toHaveBeenCalledTimes(1);
    expect(startOfferRun).not.toHaveBeenCalled();

    useWorkflowStore.setState({ isRunning: false });
    useAgentRuns.setState({ records: [record()] });
    const transcript = actions();
    rerender(
      <AgentTranscriptActionsProvider value={transcript}>
        <AgentRunCard offer={offer} />
      </AgentTranscriptActionsProvider>,
    );
    expect(offerLine(card)).toHaveTextContent(/^Run 2 changed nodes· \ds$/);
    expect(within(card).getByRole("img", { name: "Done" })).toBeInTheDocument();
    expectReady();
    expect(screen.getAllByRole("button", { name: /^Run again/ })).toHaveLength(1);
    fireEvent.click(within(openMenu()).getByRole("menuitem", { name: "Show on canvas" }));
    expect(transcript.showOnCanvas).toHaveBeenCalledWith({ tabId: "tab-a", nodeIds: ["gen", "out"] });
  });

  it("runs an alternative it ran last time from the main button, offering the primary in the menu", () => {
    useAgentRuns.setState({ records: [record({ label: "Run whole workflow", scope: { kind: "all" } })] });
    renderOffer();
    expect(screen.getByRole("heading", { name: "Run whole workflow" })).toBeInTheDocument();
    fireEvent.click(runButton());
    expect(startOfferRun).toHaveBeenCalledWith(expect.objectContaining({ option: offer.alternatives[0] }));
    expect(within(openMenu()).getByRole("menuitem", { name: /Run 2 changed nodes/ })).toBeInTheDocument();
  });

  it("leaves the Run controls out without an agent session", () => {
    renderOffer(offer, null);
    expect(screen.getByRole("group", { name: "Run 2 changed nodes" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Run/ })).not.toBeInTheDocument();
  });
});

describe("groupOfferNodes", () => {
  it("counts alike nodes once, keeping run order, and tells same titles of different outputs apart", () => {
    expect(
      groupOfferNodes([
        { id: "a", title: "Generate Image", handle: "image" },
        { id: "b", title: "Generate Image", handle: "image" },
        { id: "c", title: "Hero", handle: "text" },
        { id: "d", title: "Hero", handle: "image" },
        { id: "e", title: "Generate Image", handle: "image" },
      ]),
    ).toEqual([
      { title: "Generate Image", handle: "image", count: 3 },
      { title: "Hero", handle: "text", count: 1 },
      { title: "Hero", handle: "image", count: 1 },
    ]);
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

  it("blocks each way to run on its own: with the changed nodes gone, the whole workflow can still run", () => {
    useWorkflowStore.setState({ nodes: [NODES[0], NODES[2]] });
    renderOffer({ ...offer, primary: { scope: { kind: "nodes", nodeIds: ["gen"] }, label: "Run Generate Image", nodeIds: ["gen"] } });
    expectHeld();
    const whole = within(openMenu()).getByRole("menuitem", { name: /Run whole workflow/ });
    expect(whole).not.toHaveAttribute("aria-disabled");
    fireEvent.click(whole);
    expect(startOfferRun).toHaveBeenCalledWith(expect.objectContaining({ option: offer.alternatives[0] }));
  });
});
