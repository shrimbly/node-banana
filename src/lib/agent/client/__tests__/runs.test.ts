/**
 * Chat-started run records against the real workflow store, with the run
 * itself simulated: the test moves isRunning, the batch, node statuses and
 * the asset run the way executeWorkflow and runBatch do, and plays the asset
 * recorder's events.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RecordAssetResult } from "@/lib/assets/types";

const assetListeners = vi.hoisted(() => new Set<(result: RecordAssetResult) => void>());
vi.mock("@/lib/assets/client/recorder", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/assets/client/recorder")>()),
  onAssetRecorded: (listener: (result: RecordAssetResult) => void) => {
    assetListeners.add(listener);
    return () => assetListeners.delete(listener);
  },
}));
const posterListeners = vi.hoisted(() => new Set<(assetId: string) => void>());
vi.mock("@/lib/assets/client/poster", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/assets/client/poster")>()),
  onPosterReady: (listener: (assetId: string) => void) => {
    posterListeners.add(listener);
    return () => posterListeners.delete(listener);
  },
}));
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

import { useWorkflowStore } from "@/store/workflowStore";
import type { NodeGroup, WorkflowEdge, WorkflowNode } from "@/types";
import type { AgentRunOffer, AgentRunRecord } from "../../types";
import {
  AGENT_RUNS_KEY,
  LATE_ASSET_MS,
  RUN_TEXT_LIMIT,
  chatRunBlockedReason,
  flushAgentRuns,
  forgetChatRuns,
  latestRunFor,
  loadAgentRuns,
  plannedRunNodeIds,
  rerunChatRun,
  startOfferRun,
  stopChatRun,
  trackStartedRun,
  useAgentRuns,
} from "../runs";

function node(id: string, type: string, data: Record<string, unknown> = {}): WorkflowNode {
  return { id, type, position: { x: 0, y: 0 }, data } as WorkflowNode;
}

/** Sets one node's data, as an executor's updateNodeData would. */
function setNode(id: string, data: Record<string, unknown>) {
  useWorkflowStore.setState((state) => ({
    nodes: state.nodes.map((n) => (n.id === id ? ({ ...n, data: { ...n.data, ...data } } as WorkflowNode) : n)),
  }));
}

/** One run starting, as executeWorkflow sets it up (null `runId`: the library is off). */
function beginRun(runId: string | null = "r-run-1") {
  const controller = new AbortController();
  useWorkflowStore.setState((state) => ({
    isRunning: true,
    _abortController: controller,
    _currentRun: runId
      ? {
          run: { runId, workflowId: "wf", workflowName: null, projectDir: null, startedAt: Date.now() },
          canvasGeneration: state.canvasGeneration,
        }
      : null,
  }));
  return controller;
}

function endRun() {
  useWorkflowStore.setState({ isRunning: false, currentNodeIds: [], _abortController: null });
}

function asset(fields: { id: string; runId: string; nodeId: string; nodeType?: string; kind?: "image" | "video" | "audio" | "3d"; batchIndex?: number }) {
  const result = {
    asset: {
      id: fields.id,
      kind: fields.kind ?? "image",
      runId: fields.runId,
      sha256: "f".repeat(64),
      width: 1024,
      height: 768,
      prompt: "a fox in the snow",
      model: { provider: "gemini", modelId: "nano-banana", displayName: "Nano Banana" },
      producer: { nodeId: fields.nodeId, nodeType: fields.nodeType ?? "nanoBanana" },
      ...(fields.batchIndex ? { batch: { id: "batch-1", index: fields.batchIndex, count: 3 } } : {}),
    },
    filename: "x.png",
    legacyId: "x",
    reusedFile: false,
  } as unknown as RecordAssetResult;
  for (const listener of [...assetListeners]) listener(result);
}

function track(overrides: Partial<Parameters<typeof trackStartedRun>[0]> = {}): AgentRunRecord {
  return trackStartedRun({
    chatId: "chat-1",
    anchor: { toolCallId: "call-1" },
    label: "Run workflow",
    scope: { kind: "all" },
    runs: 1,
    tabId: useWorkflowStore.getState().activeTabId,
    plannedNodeIds: [],
    ...overrides,
  });
}

const record = (id: string) => useAgentRuns.getState().records.find((entry) => entry.id === id)!;

function resetStore(nodes: WorkflowNode[]) {
  const store = useWorkflowStore.getState();
  store.stopWorkflow();
  store.clearWorkflow();
  useWorkflowStore.setState({
    tabs: [{ id: store.activeTabId, snapshot: null }],
    nodes,
    batch: null,
    pausedAtNodeId: null,
    _currentRun: null,
  });
}

describe("chat run records", () => {
  beforeEach(() => {
    resetStore([
      node("prompt-1", "prompt", { prompt: "a fox" }),
      node("gen-1", "nanoBanana", { status: "idle" }),
      node("llm-1", "llmGenerate", { status: "idle", outputText: null }),
    ]);
    useAgentRuns.setState({ records: [] });
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("follows a run from start to done: the nodes that ran, their assets and their text", () => {
    beginRun("r-run-1");
    const started = track({ plannedNodeIds: ["gen-1", "llm-1"] });
    expect(started).toMatchObject({ status: "running", chatId: "chat-1", anchor: { toolCallId: "call-1" }, progress: { index: 1, count: 1 } });

    setNode("gen-1", { status: "loading" });
    setNode("llm-1", { status: "loading" });
    expect(record(started.id).ranNodeIds).toEqual(["gen-1", "llm-1"]);

    asset({ id: "a-other", runId: "r-someone-else", nodeId: "gen-1" });
    asset({ id: "a-fox", runId: "r-run-1", nodeId: "gen-1" });
    setNode("gen-1", { status: "complete", outputImage: "data:image/png;base64,AAAA" });
    setNode("llm-1", { status: "complete", outputText: "x".repeat(RUN_TEXT_LIMIT + 50) });
    endRun();

    const done = record(started.id);
    expect(done.status).toBe("done");
    expect(done.finishedAt).toEqual(expect.any(Number));
    expect(done.outputs).toEqual([
      {
        id: "a-fox",
        assetId: "a-fox",
        nodeId: "gen-1",
        nodeTitle: "Generate Image",
        nodeType: "nanoBanana",
        kind: "image",
        sha256: "f".repeat(64),
        width: 1024,
        height: 768,
        model: "Nano Banana",
        prompt: "a fox in the snow",
      },
      { id: "llm-1:0", nodeId: "llm-1", nodeTitle: "LLM Generate", nodeType: "llmGenerate", kind: "text", text: expect.any(String), truncated: true },
    ]);
    expect(done.outputs[1].text).toHaveLength(RUN_TEXT_LIMIT);
    // Never media bytes.
    expect(JSON.stringify(done)).not.toContain("data:");
  });

  it("ends failed when a node that ran errored, with the node and its message", () => {
    beginRun();
    const started = track();
    setNode("gen-1", { status: "loading" });
    setNode("gen-1", { status: "error", error: "Quota exceeded" });
    endRun();
    expect(record(started.id)).toMatchObject({
      status: "failed",
      ranNodeIds: ["gen-1"],
      errors: [{ nodeId: "gen-1", nodeTitle: "Generate Image", message: "Quota exceeded" }],
    });
  });

  it("ends paused at a pause edge", () => {
    const controller = beginRun();
    const started = track();
    setNode("gen-1", { status: "loading" });
    setNode("gen-1", { status: "complete" });
    useWorkflowStore.setState({ pausedAtNodeId: "llm-1" });
    controller.abort();
    endRun();
    expect(record(started.id).status).toBe("paused");
  });

  it("is not paused by a pause the canvas was already at, which a nodes run leaves alone", () => {
    useWorkflowStore.setState({ pausedAtNodeId: "llm-1" });
    beginRun();
    const started = track({ scope: { kind: "nodes", nodeIds: ["gen-1"] } });
    setNode("gen-1", { status: "loading" });
    setNode("gen-1", { status: "complete" });
    endRun();
    expect(record(started.id).status).toBe("done");
    expect(useWorkflowStore.getState().pausedAtNodeId).toBe("llm-1");
  });

  it("ends stopped when Stop was pressed, or nodes were left loading", () => {
    beginRun();
    const first = track();
    setNode("gen-1", { status: "loading" });
    stopChatRun();
    expect(useWorkflowStore.getState().isRunning).toBe(false);
    expect(record(first.id).status).toBe("stopped");

    // Stopped some other way, the aborted node is still "loading".
    setNode("gen-1", { status: "idle" });
    beginRun("r-run-2");
    const second = track({ anchor: { toolCallId: "call-2" } });
    setNode("gen-1", { status: "loading" });
    endRun();
    expect(record(second.id).status).toBe("stopped");
  });

  it("follows a batch through its runs, and a soft stop ends it stopped", () => {
    useWorkflowStore.setState({ batch: { id: "batch-1", index: 1, count: 3, stopping: false } });
    beginRun("r-run-1");
    const started = track({ runs: 3 });
    expect(started.progress).toEqual({ index: 1, count: 3 });
    asset({ id: "a-one", runId: "r-run-1", nodeId: "gen-1", batchIndex: 1 });
    endRun();
    // Between two runs of the batch: still going.
    expect(record(started.id).status).toBe("running");

    useWorkflowStore.setState({ batch: { id: "batch-1", index: 2, count: 3, stopping: false } });
    beginRun("r-run-2");
    expect(record(started.id).progress).toEqual({ index: 2, count: 3 });
    asset({ id: "a-two", runId: "r-run-2", nodeId: "gen-1" });
    useWorkflowStore.setState({ batch: { id: "batch-1", index: 2, count: 3, stopping: true } });
    endRun();
    useWorkflowStore.setState({ batch: null });

    const ended = record(started.id);
    expect(ended.status).toBe("stopped");
    expect(ended.outputs.map((output) => [output.id, output.batchIndex])).toEqual([
      ["a-one", 0],
      ["a-two", 1],
    ]);
  });

  it("shows media the library did not record from the node, and swaps in an asset that lands late", () => {
    vi.useFakeTimers();
    beginRun("r-run-1");
    const started = track();
    setNode("gen-1", { status: "loading" });
    setNode("gen-1", { status: "complete", outputImage: "data:image/png;base64,AAAA" });
    endRun();
    expect(record(started.id).outputs).toEqual([
      { id: "gen-1:0", nodeId: "gen-1", nodeTitle: "Generate Image", nodeType: "nanoBanana", kind: "image", live: true },
    ]);

    // The recorder finishes the upload after the run: the asset takes the live output's place and id.
    asset({ id: "a-late", runId: "r-run-1", nodeId: "gen-1" });
    expect(record(started.id).outputs.map((output) => [output.id, output.assetId, output.live])).toEqual([["gen-1:0", "a-late", undefined]]);

    vi.advanceTimersByTime(LATE_ASSET_MS + 1);
    asset({ id: "a-too-late", runId: "r-run-1", nodeId: "gen-1" });
    expect(record(started.id).outputs.map((output) => output.assetId)).toEqual(["a-late"]);
  });

  it("keeps the outputs' order when a late asset replaces a live one", () => {
    resetStore([node("gen-1", "nanoBanana", { status: "idle" }), node("gen-2", "nanoBanana", { status: "idle" })]);
    beginRun("r-run-1");
    const started = track();
    for (const id of ["gen-1", "gen-2"]) {
      setNode(id, { status: "loading" });
      setNode(id, { status: "complete", outputImage: "data:image/png;base64,AAAA" });
    }
    endRun();
    expect(record(started.id).outputs.map((output) => output.id)).toEqual(["gen-1:0", "gen-2:0"]);

    // The first node's upload lands last: a tile (or the viewer) on it stays where it was.
    asset({ id: "a-two", runId: "r-run-1", nodeId: "gen-2" });
    asset({ id: "a-one", runId: "r-run-1", nodeId: "gen-1" });
    expect(record(started.id).outputs.map((output) => [output.id, output.assetId])).toEqual([
      ["gen-1:0", "a-one"],
      ["gen-2:0", "a-two"],
    ]);
    // Seen once, kept once.
    asset({ id: "a-one", runId: "r-run-1", nodeId: "gen-1" });
    expect(record(started.id).outputs).toHaveLength(2);
  });

  it("marks a video's poster once the recorder has stored it, after reporting the asset", () => {
    resetStore([node("vid-1", "generateVideo", { status: "idle" })]);
    beginRun("r-run-1");
    const started = track();
    setNode("vid-1", { status: "loading" });
    asset({ id: "a-clip", runId: "r-run-1", nodeId: "vid-1", nodeType: "generateVideo", kind: "video" });
    setNode("vid-1", { status: "complete" });
    endRun();
    expect(record(started.id).outputs[0].hasPoster).toBeUndefined();

    const before = useAgentRuns.getState().records;
    for (const listener of posterListeners) listener("a-unrelated");
    expect(useAgentRuns.getState().records).toBe(before);
    for (const listener of posterListeners) listener("a-clip");
    expect(record(started.id).outputs[0]).toMatchObject({ assetId: "a-clip", hasPoster: true });
  });

  it("finds the latest record for an anchor", () => {
    const first = track({ anchor: { offerId: "offer-1" } });
    const second = track({ anchor: { offerId: "offer-1" } });
    track({ anchor: { toolCallId: "offer-1" } });
    const { records } = useAgentRuns.getState();
    expect(latestRunFor(records, { offerId: "offer-1" })?.id).toBe(second.id);
    expect(latestRunFor(records, { offerId: "offer-2" })).toBeUndefined();
    expect(first.id).not.toBe(second.id);
  });

  it("a run that never started reads as stopped", () => {
    const started = track();
    expect(record(started.id).status).toBe("stopped");
  });

  it("forgets a conversation's runs", () => {
    track({ chatId: "chat-1" });
    const kept = track({ chatId: "chat-2" });
    forgetChatRuns("chat-1");
    expect(useAgentRuns.getState().records.map((entry) => entry.id)).toEqual([kept.id]);
  });
});

describe("plannedRunNodeIds", () => {
  const lockedGroup: NodeGroup = { id: "g-locked", name: "Locked", color: "neutral", position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, locked: true };
  const canvas = {
    nodes: [
      node("prompt-1", "prompt"),
      node("gen-1", "nanoBanana"),
      node("out-1", "output"),
      { ...node("locked-1", "nanoBanana"), groupId: "g-locked" } as WorkflowNode,
      node("other-1", "prompt"),
    ],
    edges: [
      { id: "e1", source: "prompt-1", target: "gen-1" },
      { id: "e2", source: "gen-1", target: "out-1" },
      { id: "e3", source: "gen-1", target: "locked-1" },
      { id: "e4", source: "out-1", target: "prompt-1", data: { isLoop: true } },
    ] as WorkflowEdge[],
    groups: { "g-locked": lockedGroup },
  };

  it("plans every node outside a locked group for the whole workflow", () => {
    expect(plannedRunNodeIds({ kind: "all" }, canvas)).toEqual(["prompt-1", "gen-1", "out-1", "other-1"]);
  });

  it("plans the node and what it feeds for a run from it, not back round a loop", () => {
    expect(plannedRunNodeIds({ kind: "from", nodeId: "gen-1" }, canvas)).toEqual(["gen-1", "out-1"]);
  });

  it("keeps only what is on the canvas, taking the agent's own list when it sent one", () => {
    expect(plannedRunNodeIds({ kind: "nodes", nodeIds: ["gen-1", "gone-1"] }, canvas)).toEqual(["gen-1"]);
    expect(plannedRunNodeIds({ kind: "all" }, canvas, ["gen-1", "gone-1"])).toEqual(["gen-1"]);
  });
});

describe("chat run records: persistence", () => {
  beforeEach(() => {
    resetStore([node("gen-1", "nanoBanana", { status: "idle" })]);
    useAgentRuns.setState({ records: [] });
    localStorage.clear();
  });

  it("keeps the newest records, and one still running when the page went away reads as stopped", () => {
    beginRun();
    const running = track();
    flushAgentRuns();
    const stored = JSON.parse(localStorage.getItem(AGENT_RUNS_KEY)!);
    expect(stored.records.map((entry: AgentRunRecord) => entry.id)).toEqual([running.id]);

    const loaded = loadAgentRuns();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ id: running.id, status: "stopped", finishedAt: stored.savedAt });
    endRun();
  });

  it("caps the records and their outputs", () => {
    const many: AgentRunRecord[] = Array.from({ length: 120 }, (_, index) => ({
      ...track({ anchor: { toolCallId: `call-${index}` } }),
      outputs: Array.from({ length: 30 }, (__, output) => ({
        id: `a-${index}-${output}`,
        nodeId: "gen-1",
        nodeTitle: "Generate Image",
        nodeType: "nanoBanana" as const,
        kind: "image" as const,
        assetId: `a-${index}-${output}`,
      })),
    }));
    useAgentRuns.setState({ records: many });
    flushAgentRuns();
    const loaded = loadAgentRuns();
    expect(loaded).toHaveLength(100);
    expect(loaded[0].outputs).toHaveLength(24);
    expect(loaded[0].outputs[0].id).toBe("a-0-6");
  });

  it("reads nothing from a broken entry", () => {
    localStorage.setItem(AGENT_RUNS_KEY, "{not json");
    expect(loadAgentRuns()).toEqual([]);
    localStorage.setItem(AGENT_RUNS_KEY, JSON.stringify({ savedAt: 1, records: [{ id: "x" }] }));
    expect(loadAgentRuns()).toEqual([]);
  });
});

describe("startOfferRun", () => {
  const runBatch = vi.fn<(scope: unknown, count?: number) => Promise<void>>(() => {
    beginRun("r-offer");
    return Promise.resolve();
  });
  const originalRunBatch = useWorkflowStore.getState().runBatch;

  const offer = (fields: Partial<AgentRunOffer> = {}): AgentRunOffer => ({
    offerId: "offer-1",
    primary: { scope: { kind: "nodes", nodeIds: ["gen-1", "gone-1"] }, label: "Run 2 changed nodes", nodeIds: ["gen-1", "gone-1"] },
    alternatives: [{ scope: { kind: "all" }, label: "Run whole workflow", nodeIds: [] }],
    ...fields,
  });

  beforeEach(() => {
    resetStore([node("gen-1", "nanoBanana", { status: "idle" })]);
    useAgentRuns.setState({ records: [] });
    runBatch.mockClear();
    useWorkflowStore.setState({ runBatch });
  });

  afterEach(() => {
    endRun();
    useWorkflowStore.setState({ runBatch: originalRunBatch });
  });

  it("runs what is still on the canvas and records it under the offer", () => {
    const current = offer();
    const result = startOfferRun({ chatId: "chat-1", offer: current, option: current.primary, runs: 2 });
    expect(runBatch).toHaveBeenCalledWith({ kind: "nodes", nodeIds: ["gen-1"] }, 2);
    expect(result).toMatchObject({
      ok: true,
      record: {
        anchor: { offerId: "offer-1" },
        label: "Run 2 changed nodes",
        runs: 2,
        plannedNodeIds: ["gen-1"],
        tabId: useWorkflowStore.getState().activeTabId,
        status: "running",
      },
    });
  });

  it("refuses while a run is going, when its nodes are gone, or when the run doesn't start", () => {
    const current = offer();
    useWorkflowStore.setState({ isRunning: true });
    expect(startOfferRun({ chatId: "chat-1", offer: current, option: current.primary, runs: 1 })).toEqual({
      ok: false,
      reason: "Wait for the run to finish",
    });
    useWorkflowStore.setState({ isRunning: false });

    const gone = offer({ primary: { scope: { kind: "nodes", nodeIds: ["gone-1"] }, label: "Run gone", nodeIds: ["gone-1"] } });
    expect(startOfferRun({ chatId: "chat-1", offer: gone, option: gone.primary, runs: 1 })).toEqual({
      ok: false,
      reason: "The nodes it would run are no longer on the canvas",
    });

    runBatch.mockImplementationOnce(() => Promise.resolve());
    expect(startOfferRun({ chatId: "chat-1", offer: current, option: current.alternatives[0], runs: 1 })).toEqual({
      ok: false,
      reason: "The run didn't start",
    });
    // A batch is set up before its first run is refused; it clears itself a moment later.
    runBatch.mockImplementationOnce(() => {
      useWorkflowStore.setState({ batch: { id: "batch-1", index: 1, count: 3, stopping: false } });
      return Promise.resolve();
    });
    expect(startOfferRun({ chatId: "chat-1", offer: current, option: current.alternatives[0], runs: 3 })).toEqual({
      ok: false,
      reason: "The run didn't start",
    });
    useWorkflowStore.setState({ batch: null });
    expect(useAgentRuns.getState().records).toEqual([]);
  });

  it("refuses a whole-workflow run once none of the nodes it was offered for is on the canvas", () => {
    // The tab's canvas was cleared and something else built in it since the offer.
    const stale = offer({ primary: { scope: { kind: "all" }, label: "Run workflow", nodeIds: ["old-1", "old-2"] }, alternatives: [] });
    expect(chatRunBlockedReason({ scope: { kind: "all" }, plannedNodeIds: stale.primary.nodeIds })).toBe(
      "The nodes it would run are no longer on the canvas",
    );
    expect(startOfferRun({ chatId: "chat-1", offer: stale, option: stale.primary, runs: 1 })).toEqual({
      ok: false,
      reason: "The nodes it would run are no longer on the canvas",
    });
    expect(runBatch).not.toHaveBeenCalled();

    const record = track({ scope: { kind: "all" }, plannedNodeIds: ["old-1"] });
    expect(rerunChatRun(record)).toEqual({ ok: false, reason: "The nodes it would run are no longer on the canvas" });
    expect(runBatch).not.toHaveBeenCalled();

    // One of them is still there: the workflow runs, edits and all.
    const kept = offer({ primary: { scope: { kind: "all" }, label: "Run workflow", nodeIds: ["old-1", "gen-1"] }, alternatives: [] });
    expect(startOfferRun({ chatId: "chat-1", offer: kept, option: kept.primary, runs: 1 })).toMatchObject({ ok: true });
    expect(runBatch).toHaveBeenCalledWith({ kind: "all" }, 1);
  });

  it("switches to the offer's tab first, and refuses when that tab was closed", () => {
    const offerTab = useWorkflowStore.getState().activeTabId;
    const other = useWorkflowStore.getState().newTab()!;
    useWorkflowStore.setState({ nodes: [node("elsewhere-1", "prompt")] });
    expect(useWorkflowStore.getState().activeTabId).toBe(other);

    const closed = offer({ tabId: "tab-closed" });
    expect(startOfferRun({ chatId: "chat-1", offer: closed, option: closed.primary, runs: 1 })).toEqual({
      ok: false,
      reason: "That workflow is no longer open",
    });

    const current = offer({ tabId: offerTab });
    const result = startOfferRun({ chatId: "chat-1", offer: current, option: current.primary, runs: 1 });
    expect(useWorkflowStore.getState().activeTabId).toBe(offerTab);
    expect(runBatch).toHaveBeenCalledWith({ kind: "nodes", nodeIds: ["gen-1"] }, 1);
    expect(result).toMatchObject({ ok: true, record: { tabId: offerTab } });
  });
});
