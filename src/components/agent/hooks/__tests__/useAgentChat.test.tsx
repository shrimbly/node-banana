/**
 * useAgentChat against the real workflow store: a turn's canvas edits belong to
 * the canvas it was sent from. The chat route is faked at fetch with a UI
 * message stream the test feeds chunk by chunk.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const toastShow = vi.hoisted(() => vi.fn());
vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show: toastShow }) } }));
const saveLiveWorkflow = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agent/client/save", () => ({ saveLiveWorkflow }));
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

import { useWorkflowStore, type WorkflowFile } from "@/store/workflowStore";
import { useAgentChat } from "@/components/agent/hooks/useAgentChat";
import type { AgentGraphOp, AgentGraphOpBatch } from "@/lib/agent/types";

/** Two workflows with the store's counter-style ids, so A's ids also exist in B. */
function workflow(id: string, name: string, promptText: string): WorkflowFile {
  return {
    version: 1,
    id,
    name,
    nodes: [
      { id: "prompt-1", type: "prompt", position: { x: 0, y: 0 }, data: { prompt: promptText } },
      { id: "nanoBanana-2", type: "nanoBanana", position: { x: 400, y: 0 }, data: {} },
    ],
    edges: [
      {
        id: "edge-prompt-1-nanoBanana-2-text-text",
        source: "prompt-1",
        sourceHandle: "text",
        target: "nanoBanana-2",
        targetHandle: "text",
      },
    ],
    edgeStyle: "angular",
    groups: {},
  } as unknown as WorkflowFile;
}

/**
 * A UI message stream the test writes to. Like a real fetch body, it errors
 * when the request is aborted; writes after that are ignored.
 */
function controlledStream() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const write = (text: string) => {
    try {
      controller.enqueue(encoder.encode(text));
    } catch {
      // cancelled by stop()
    }
  };
  return {
    abortWith: (signal: AbortSignal) =>
      signal.addEventListener("abort", () => {
        try {
          controller.error(new DOMException("The operation was aborted.", "AbortError"));
        } catch {
          // already closed
        }
      }),
    response: new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" },
    }),
    push: (chunk: unknown) => write(`data: ${JSON.stringify(chunk)}\n\n`),
    end: () => {
      write("data: [DONE]\n\n");
      try {
        controller.close();
      } catch {
        // already cancelled
      }
    },
  };
}

const editPrompt: AgentGraphOpBatch = {
  batchId: "b1",
  toolCallId: "t1",
  summary: "Updated the prompt",
  ops: [{ op: "updateNode", id: "prompt-1", data: { prompt: "a dog" } }],
};
const replaceCanvas: AgentGraphOpBatch = {
  batchId: "b2",
  toolCallId: "t2",
  summary: "Replaced the canvas",
  replacedCanvas: true,
  ops: [
    { op: "clearCanvas" },
    { op: "addNode", id: "prompt-ag1", nodeType: "prompt", position: { x: 0, y: 0 }, data: { prompt: "a dog" } },
  ],
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function startTurn() {
  const stream = controlledStream();
  let signal: AbortSignal | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      if (signal) stream.abortWith(signal);
      return stream.response;
    }),
  );
  const hook = renderHook(() =>
    useAgentChat({ harness: "claude", getViewport: () => ({ x: 0, y: 0, width: 800, height: 600, zoom: 1 }) }),
  );
  act(() => {
    hook.result.current.send("change the prompt to a dog, then rebuild");
  });
  await waitFor(() => expect(signal).toBeDefined());
  stream.push({ type: "start", messageId: "assistant-1" });
  await waitFor(() => expect(hook.result.current.busy).toBe(true));
  return { ...hook, stream, signal: () => signal! };
}

describe("useAgentChat: a turn only edits the canvas it was sent from", () => {
  beforeEach(async () => {
    toastShow.mockClear();
    useWorkflowStore.getState().clearWorkflow();
    await act(() => useWorkflowStore.getState().loadWorkflow(workflow("wf-A", "A", "a cat")));
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["another workflow is opened", () => useWorkflowStore.getState().loadWorkflow(workflow("wf-B", "B", "a mountain lake"))],
    ["the canvas is cleared", () => useWorkflowStore.getState().clearWorkflow()],
  ])("drops the turn's edits and stops it when %s", async (_what, switchCanvas) => {
    const { result, stream, signal } = await startTurn();

    // The switch and the stale batches land before React gets to stop the turn:
    // each batch is checked on its own.
    await act(async () => {
      await switchCanvas();
      stream.push({ type: "data-graph-ops", data: editPrompt, transient: true });
      stream.push({ type: "data-graph-ops", data: replaceCanvas, transient: true });
      await sleep(20);
    });

    const after = useWorkflowStore.getState();
    expect(after.nodes.map((node) => node.id)).not.toContain("prompt-ag1");
    const prompt = after.nodes.find((node) => node.id === "prompt-1");
    if (prompt) expect((prompt.data as { prompt?: string }).prompt).toBe("a mountain lake");
    expect(after.hasUnsavedChanges).toBe(false);

    // Then the turn is stopped, and the user is told why.
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(signal().aborted).toBe(true);
    expect(toastShow).toHaveBeenCalledWith("Stopped the agent: a different workflow was opened", "warning");

    stream.end();
  });

  it("applies the turn's edits while its canvas is still the one loaded", async () => {
    const { result, stream } = await startTurn();

    await act(async () => {
      stream.push({ type: "data-graph-ops", data: editPrompt, transient: true });
      stream.push({ type: "finish" });
      stream.end();
      await sleep(20);
    });

    const state = useWorkflowStore.getState();
    expect((state.nodes.find((node) => node.id === "prompt-1")?.data as { prompt?: string }).prompt).toBe("a dog");
    expect(state.hasUnsavedChanges).toBe(true);
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(toastShow).not.toHaveBeenCalled();
  });

  it("a turn sent after the switch runs normally", async () => {
    await act(() => useWorkflowStore.getState().loadWorkflow(workflow("wf-B", "B", "a mountain lake")));
    const { result, stream } = await startTurn();

    await act(async () => {
      stream.push({ type: "data-graph-ops", data: editPrompt, transient: true });
      stream.push({ type: "finish" });
      stream.end();
      await sleep(20);
    });

    expect(
      (useWorkflowStore.getState().nodes.find((node) => node.id === "prompt-1")?.data as { prompt?: string }).prompt,
    ).toBe("a dog");
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(toastShow).not.toHaveBeenCalled();
  });
});

describe("useAgentChat: status line", () => {
  beforeEach(async () => {
    useWorkflowStore.getState().clearWorkflow();
    await act(() => useWorkflowStore.getState().loadWorkflow(workflow("wf-A", "A", "a cat")));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("shows the opening line as soon as the turn is sent, before the server says anything", async () => {
    const { result, stream } = await startTurn();
    expect(result.current.statusLine).toEqual({ text: "Fallooning…", renderedParts: 0 });

    await act(async () => {
      stream.push({ type: "finish" });
      stream.end();
      await sleep(20);
    });
  });
});

describe("useAgentChat: provider keys", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the user's provider keys as headers, never in the body", async () => {
    const previous = useWorkflowStore.getState();
    const providerSettings = {
      providers: {
        ...previous.providerSettings.providers,
        openai: { ...previous.providerSettings.providers.openai, apiKey: "sk-panel-openai" },
        comfy: { ...previous.providerSettings.providers.comfy, apiKey: null },
      },
    } as typeof previous.providerSettings;
    useWorkflowStore.setState({ providerSettings, comfyCloudApiKey: "comfyui-cloud-key" });
    try {
      const { stream } = await startTurn();
      const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      const headers = new Headers(init.headers);
      expect(headers.get("X-OpenAI-API-Key")).toBe("sk-panel-openai");
      expect(headers.get("X-Comfy-Router-Key")).toBe("comfyui-cloud-key");
      expect(headers.get("Content-Type")).toBe("application/json");
      expect(String(init.body)).not.toContain("sk-panel-openai");
      expect(String(init.body)).not.toContain("comfyui-cloud-key");
      stream.end();
    } finally {
      useWorkflowStore.setState({ providerSettings: previous.providerSettings, comfyCloudApiKey: previous.comfyCloudApiKey });
    }
  });
});

describe("useAgentChat: messages sent while a turn runs are queued", () => {
  /** Every request gets its own stream; turn n is streams[n]. */
  function fakeTurns() {
    const streams: ReturnType<typeof controlledStream>[] = [];
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const stream = controlledStream();
        if (init.signal) stream.abortWith(init.signal);
        streams.push(stream);
        bodies.push(String(init.body));
        return stream.response;
      }),
    );
    return { streams, bodies };
  }

  function renderChat(harness: "claude" | "codex" = "claude") {
    return renderHook(
      ({ harness: current }) =>
        useAgentChat({ harness: current, getViewport: () => ({ x: 0, y: 0, width: 800, height: 600, zoom: 1 }) }),
      { initialProps: { harness } },
    );
  }

  /** Sends the first message and waits until its turn is streaming. */
  async function busyChat(harness: "claude" | "codex" = "claude") {
    const turns = fakeTurns();
    const hook = renderChat(harness);
    act(() => {
      hook.result.current.send("first");
    });
    await waitFor(() => expect(turns.streams).toHaveLength(1));
    turns.streams[0].push({ type: "start", messageId: "assistant-1" });
    await waitFor(() => expect(hook.result.current.busy).toBe(true));
    return { ...hook, ...turns };
  }

  async function finishTurn(stream: ReturnType<typeof controlledStream>) {
    await act(async () => {
      stream.push({ type: "finish" });
      stream.end();
      await sleep(20);
    });
  }

  beforeEach(async () => {
    toastShow.mockClear();
    useWorkflowStore.getState().clearWorkflow();
    await act(() => useWorkflowStore.getState().loadWorkflow(workflow("wf-A", "A", "a cat")));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("queues instead of sending, and still clears the composer", async () => {
    const { result, streams } = await busyChat();

    let accepted = false;
    act(() => {
      accepted = result.current.send("  then make it blue  ");
    });

    expect(accepted).toBe(true);
    expect(result.current.queued.map((entry) => entry.text)).toEqual(["then make it blue"]);
    await sleep(20);
    expect(streams).toHaveLength(1);
    expect(result.current.send("   ")).toBe(false);
    streams[0].end();
  });

  it("sends queued messages one turn at a time once each turn ends normally", async () => {
    const { result, streams, bodies } = await busyChat();
    act(() => {
      result.current.send("second");
    });
    act(() => {
      result.current.send("third");
    });

    await finishTurn(streams[0]);
    await waitFor(() => expect(streams).toHaveLength(2));
    expect(bodies[1]).toContain('"second"');
    expect(result.current.queued.map((entry) => entry.text)).toEqual(["third"]);

    // The second turn is running: the third waits for it.
    streams[1].push({ type: "start", messageId: "assistant-2" });
    await waitFor(() => expect(result.current.busy).toBe(true));
    await sleep(20);
    expect(streams).toHaveLength(2);

    await finishTurn(streams[1]);
    await waitFor(() => expect(streams).toHaveLength(3));
    expect(bodies[2]).toContain('"third"');
    expect(result.current.queued).toEqual([]);
    streams[2].end();
  });

  it("holds the queue after Stop until the user sends it", async () => {
    const { result, streams, bodies } = await busyChat();
    act(() => {
      result.current.send("second");
    });

    act(() => result.current.stop());
    await waitFor(() => expect(result.current.busy).toBe(false));
    await waitFor(() => expect(result.current.queueHeld).toBe(true));
    await sleep(20);
    expect(streams).toHaveLength(1);
    expect(result.current.queued.map((entry) => entry.text)).toEqual(["second"]);

    act(() => result.current.sendQueuedNow());
    await waitFor(() => expect(streams).toHaveLength(2));
    expect(bodies[1]).toContain('"second"');
    expect(result.current.queued).toEqual([]);
    expect(result.current.queueHeld).toBe(false);
    streams[1].end();
  });

  it("holds the queue after a failed turn", async () => {
    const turns = fakeTurns();
    // The first turn fails, answered only once the second message is queued.
    let fail!: () => void;
    vi.mocked(fetch).mockImplementationOnce(
      () => new Promise<Response>((resolve) => (fail = () => resolve(new Response("boom", { status: 500 })))),
    );
    const { result } = renderChat();
    act(() => {
      result.current.send("first");
    });
    await waitFor(() => expect(result.current.busy).toBe(true));
    act(() => {
      result.current.send("second");
    });
    act(() => fail());

    await waitFor(() => expect(result.current.status).toBe("error"));
    await waitFor(() => expect(result.current.queueHeld).toBe(true));
    await sleep(20);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);

    act(() => result.current.sendQueuedNow());
    await waitFor(() => expect(turns.streams).toHaveLength(1));
    expect(turns.bodies[0]).toContain('"second"');
    turns.streams[0].end();
  });

  it("takeQueued hands back the text and removeQueued drops a message", async () => {
    const { result, streams } = await busyChat();
    act(() => {
      result.current.send("second");
    });
    act(() => {
      result.current.send("third");
    });
    const [second, third] = result.current.queued;

    let taken: string | undefined;
    act(() => {
      taken = result.current.takeQueued(second.id);
    });
    expect(taken).toBe("second");
    act(() => result.current.removeQueued(third.id));
    expect(result.current.queued).toEqual([]);

    // Nothing is left to follow the turn.
    await finishTurn(streams[0]);
    await sleep(20);
    expect(streams).toHaveLength(1);
  });

  it("clears the queue on New chat", async () => {
    const { result, streams } = await busyChat();
    act(() => {
      result.current.send("second");
    });
    act(() => result.current.newChat());
    expect(result.current.queued).toEqual([]);
    await sleep(20);
    expect(streams).toHaveLength(1);
  });

  it("clears the queue when another conversation is opened", async () => {
    const { result } = await busyChat();
    act(() => {
      result.current.send("second");
    });
    act(() => result.current.stop());
    await waitFor(() => expect(result.current.queueHeld).toBe(true));

    act(() => result.current.openConversation({ id: "older", messages: [] }));
    expect(result.current.queued).toEqual([]);
    expect(result.current.queueHeld).toBe(false);
  });

  it("clears the queue when another workflow is opened", async () => {
    const { result, streams } = await busyChat();
    act(() => {
      result.current.send("second");
    });
    await act(() => useWorkflowStore.getState().loadWorkflow(workflow("wf-B", "B", "a mountain lake")));
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.queued).toEqual([]);
    expect(result.current.queueHeld).toBe(false);
    await sleep(20);
    expect(streams).toHaveLength(1);
  });

  it("clears the queue on a harness switch and says so", async () => {
    const { result, rerender } = await busyChat();
    act(() => {
      result.current.send("second");
    });
    act(() => result.current.stop());
    await waitFor(() => expect(result.current.queueHeld).toBe(true));

    rerender({ harness: "codex" });
    expect(result.current.queued).toEqual([]);
    expect(toastShow).toHaveBeenCalledWith("Cleared the queued message: switched to Codex", "info");
  });
});

describe("useAgentChat: queued messages", () => {
  beforeEach(async () => {
    useWorkflowStore.getState().clearWorkflow();
    await act(() => useWorkflowStore.getState().loadWorkflow(workflow("wf-A", "A", "a cat")));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("keeps a research turn's metadata when it waits in the queue", async () => {
    const streams: Array<ReturnType<typeof controlledStream>> = [];
    const bodies: Array<{ messages: Array<{ metadata?: unknown; parts: Array<{ text?: string }> }> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        const stream = controlledStream();
        streams.push(stream);
        return stream.response;
      }),
    );
    const { result } = renderHook(() =>
      useAgentChat({ harness: "claude", getViewport: () => ({ x: 0, y: 0, width: 800, height: 600, zoom: 1 }) }),
    );
    act(() => {
      result.current.send("make a fox workflow");
    });
    await waitFor(() => expect(streams).toHaveLength(1));
    streams[0].push({ type: "start", messageId: "assistant-1" });
    await waitFor(() => expect(result.current.busy).toBe(true));

    const research = { provider: "fal", modelId: "fal-ai/kling/i2v", name: "Kling I2V" };
    act(() => {
      result.current.send("Look up prompting tips for Kling I2V", { research });
    });
    expect(result.current.queued).toEqual([{ id: expect.any(String), text: "Look up prompting tips for Kling I2V", metadata: { research } }]);

    await act(async () => {
      streams[0].push({ type: "finish" });
      streams[0].end();
      await sleep(20);
    });
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1].messages.at(-1)).toMatchObject({ parts: [{ text: "Look up prompting tips for Kling I2V" }], metadata: { research } });
    streams[1].end();
  });
});

describe("useAgentChat: the turn's tab and save steps", () => {
  const graphOps = (batchId: string, fields: Partial<AgentGraphOpBatch> = {}): AgentGraphOpBatch => ({
    batchId,
    toolCallId: `call-${batchId}`,
    summary: `Edited (${batchId})`,
    ops: [{ op: "addNode", id: `prompt-${batchId}`, nodeType: "prompt", position: { x: 0, y: 0 }, data: { prompt: batchId } }],
    ...fields,
  });
  const step = (batchId: string, workspace: AgentGraphOpBatch["workspace"], tabId?: string): AgentGraphOpBatch => ({
    batchId,
    toolCallId: `call-${batchId}`,
    summary: batchId,
    ops: [],
    workspace,
    ...(tabId ? { tabId } : {}),
  });
  const nodeIds = () => useWorkflowStore.getState().nodes.map((node) => node.id);
  const push = (stream: ReturnType<typeof controlledStream>, batch: AgentGraphOpBatch) =>
    stream.push({ type: "data-graph-ops", data: batch, transient: true });
  let tabCounter = 0;
  const freshTabId = () => `tab-ag${Date.now().toString(36)}${(tabCounter += 1)}`;

  beforeEach(async () => {
    toastShow.mockClear();
    saveLiveWorkflow.mockReset();
    const store = useWorkflowStore.getState();
    useWorkflowStore.setState({ tabs: [{ id: store.activeTabId, snapshot: null }], isRunning: false, isSaving: false, batch: null });
    useWorkflowStore.getState().clearWorkflow();
    await act(() => useWorkflowStore.getState().loadWorkflow(workflow("wf-A", "A", "a cat")));
  });

  afterEach(() => {
    useWorkflowStore.setState({ isRunning: false, isSaving: false });
    vi.unstubAllGlobals();
  });

  it("applies batches in stream order, waiting for a save before the next", async () => {
    let finishSave!: (result: { ok: true; name: string; path: string }) => void;
    saveLiveWorkflow.mockImplementation(() => new Promise((resolve) => (finishSave = resolve)));
    const { stream } = await startTurn();
    const tabId = useWorkflowStore.getState().activeTabId;

    await act(async () => {
      push(stream, graphOps("one", { tabId }));
      push(stream, step("save", { op: "save", name: "Fox" }, tabId));
      push(stream, graphOps("two", { tabId }));
      await sleep(30);
    });
    expect(nodeIds()).toContain("prompt-one");
    expect(saveLiveWorkflow).toHaveBeenCalledWith("Fox");
    expect(nodeIds()).not.toContain("prompt-two");

    await act(async () => {
      finishSave({ ok: true, name: "Fox", path: "/lib/Fox" });
      await sleep(20);
    });
    expect(nodeIds()).toContain("prompt-two");
    expect(toastShow).toHaveBeenCalledWith("Saved Fox", "info");
    stream.end();
  });

  it("says why a save failed and carries on", async () => {
    saveLiveWorkflow.mockResolvedValue({ ok: false, reason: "Couldn't save: disk full" });
    const { result, stream } = await startTurn();
    await act(async () => {
      push(stream, step("save", { op: "save" }));
      push(stream, graphOps("after"));
      await sleep(30);
    });
    expect(toastShow).toHaveBeenCalledWith("Couldn't save: disk full", "warning");
    expect(nodeIds()).toContain("prompt-after");
    expect(result.current.busy).toBe(true);
    stream.end();
  });

  it("keeps the turn and the queue going across its own tab switch and new tab", async () => {
    const tabA = useWorkflowStore.getState().activeTabId;
    const tabB = useWorkflowStore.getState().newTab()!;
    useWorkflowStore.getState().switchTab(tabA);
    const { result, stream } = await startTurn();
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(body.workflow.tabId).toBe(tabA);
    expect(body.tabs.map((tab: { id: string }) => tab.id)).toEqual([tabA, tabB]);
    expect(Object.keys(body.parkedWorkflows)).toEqual([tabB]);

    act(() => {
      result.current.send("then make it blue");
    });
    const tabC = freshTabId();
    await act(async () => {
      push(stream, step("switch", { op: "switchTab", tabId: tabB }, tabB));
      push(stream, graphOps("in-b", { tabId: tabB }));
      push(stream, step("new", { op: "newTab", tabId: tabC, name: "Fresh" }, tabC));
      push(stream, graphOps("in-c", { tabId: tabC }));
      await sleep(30);
    });

    const state = useWorkflowStore.getState();
    expect(state.activeTabId).toBe(tabC);
    expect(state.workflowName).toBe("Fresh");
    expect(nodeIds()).toEqual(["prompt-in-c"]);
    expect(state.tabs.find((tab) => tab.id === tabB)?.snapshot?.nodes.map((node) => node.id)).toContain("prompt-in-b");
    expect(result.current.busy).toBe(true);
    expect(result.current.queued.map((entry) => entry.text)).toEqual(["then make it blue"]);
    expect(toastShow).not.toHaveBeenCalled();
    stream.end();
  });

  it("waits for a save to finish before switching tabs", async () => {
    const tabA = useWorkflowStore.getState().activeTabId;
    const tabB = useWorkflowStore.getState().newTab()!;
    useWorkflowStore.getState().switchTab(tabA);
    const { result, stream } = await startTurn();
    useWorkflowStore.setState({ isSaving: true });

    await act(async () => {
      push(stream, step("switch", { op: "switchTab", tabId: tabB }, tabB));
      await sleep(150);
    });
    expect(useWorkflowStore.getState().activeTabId).toBe(tabA);

    await act(async () => {
      useWorkflowStore.setState({ isSaving: false });
      await sleep(150);
    });
    expect(useWorkflowStore.getState().activeTabId).toBe(tabB);
    expect(result.current.busy).toBe(true);
    stream.end();
  });

  it("stops the turn when a switch is refused, and drops what follows", async () => {
    const tabA = useWorkflowStore.getState().activeTabId;
    const tabB = useWorkflowStore.getState().newTab()!;
    useWorkflowStore.getState().switchTab(tabA);
    const { result, stream, signal } = await startTurn();
    useWorkflowStore.setState({ isRunning: true });

    await act(async () => {
      push(stream, step("switch", { op: "switchTab", tabId: tabB }, tabB));
      push(stream, graphOps("in-b", { tabId: tabB }));
      await sleep(30);
    });

    expect(useWorkflowStore.getState().activeTabId).toBe(tabA);
    expect(toastShow).toHaveBeenCalledWith("Stopped the agent: it couldn't switch workflows (wait for the run to finish)", "warning");
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(signal().aborted).toBe(true);
    expect(nodeIds()).not.toContain("prompt-in-b");
    stream.end();
  });

  it("drops a batch meant for a tab that isn't live, and stops the turn", async () => {
    const { result, stream } = await startTurn();
    await act(async () => {
      push(stream, graphOps("elsewhere", { tabId: "tab-somewhere-else" }));
      await sleep(30);
    });
    expect(nodeIds()).not.toContain("prompt-elsewhere");
    expect(toastShow).toHaveBeenCalledWith("Stopped the agent: its changes were for a workflow that isn't the open tab", "warning");
    await waitFor(() => expect(result.current.busy).toBe(false));
    stream.end();
  });

  it("never starts a run, whatever a batch holds", async () => {
    const original = useWorkflowStore.getState().runBatch;
    const runBatch = vi.fn(async () => {});
    useWorkflowStore.setState({ runBatch });
    try {
      const { stream } = await startTurn();
      const run = { op: "run", scope: { kind: "all" }, runs: 1 } as unknown as AgentGraphOp;
      await act(async () => {
        push(stream, { batchId: "run", toolCallId: "call-run", summary: "Run workflow", ops: [run] });
        await sleep(30);
      });
      expect(runBatch).not.toHaveBeenCalled();
      expect(useWorkflowStore.getState().isRunning).toBe(false);
      stream.end();
    } finally {
      useWorkflowStore.setState({ runBatch: original });
    }
  });
});

describe("useAgentChat: steps still pending when the turn ends", () => {
  /** Every request gets its own stream and signal; turn n is streams[n]. */
  function fakeTurns() {
    const streams: ReturnType<typeof controlledStream>[] = [];
    const bodies: Array<{ workflow?: { tabId?: string } }> = [];
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const stream = controlledStream();
        if (init.signal) {
          stream.abortWith(init.signal);
          signals.push(init.signal);
        }
        streams.push(stream);
        bodies.push(JSON.parse(String(init.body)));
        return stream.response;
      }),
    );
    return { streams, bodies, signals };
  }

  async function busyChat() {
    const turns = fakeTurns();
    const hook = renderHook(() =>
      useAgentChat({ harness: "claude", getViewport: () => ({ x: 0, y: 0, width: 800, height: 600, zoom: 1 }) }),
    );
    act(() => {
      hook.result.current.send("first");
    });
    await waitFor(() => expect(turns.streams).toHaveLength(1));
    turns.streams[0].push({ type: "start", messageId: "assistant-1" });
    await waitFor(() => expect(hook.result.current.busy).toBe(true));
    return { ...hook, ...turns };
  }

  const push = (stream: ReturnType<typeof controlledStream>, batch: AgentGraphOpBatch) =>
    stream.push({ type: "data-graph-ops", data: batch, transient: true });
  const step = (batchId: string, workspace: AgentGraphOpBatch["workspace"], tabId?: string): AgentGraphOpBatch => ({
    batchId,
    toolCallId: `call-${batchId}`,
    summary: batchId,
    ops: [],
    workspace,
    ...(tabId ? { tabId } : {}),
  });
  const edit = (batchId: string, tabId?: string): AgentGraphOpBatch => ({
    batchId,
    toolCallId: `call-${batchId}`,
    summary: batchId,
    ops: [{ op: "addNode", id: `prompt-${batchId}`, nodeType: "prompt", position: { x: 0, y: 0 }, data: { prompt: batchId } }],
    ...(tabId ? { tabId } : {}),
  });
  const openTab = () => step("open", { op: "newTab", tabId: "tab-agopen" });
  const nodeIds = () => useWorkflowStore.getState().nodes.map((node) => node.id);
  /** Two tabs, A live. */
  function twoTabs() {
    const tabA = useWorkflowStore.getState().activeTabId;
    const tabB = useWorkflowStore.getState().newTab()!;
    useWorkflowStore.getState().switchTab(tabA);
    return { tabA, tabB };
  }

  beforeEach(async () => {
    toastShow.mockClear();
    saveLiveWorkflow.mockReset();
    const store = useWorkflowStore.getState();
    useWorkflowStore.setState({ tabs: [{ id: store.activeTabId, snapshot: null }], isRunning: false, isSaving: false, batch: null });
    useWorkflowStore.getState().clearWorkflow();
    await act(() => useWorkflowStore.getState().loadWorkflow(workflow("wf-A", "A", "a cat")));
  });

  afterEach(() => {
    useWorkflowStore.setState({ isRunning: false, isSaving: false });
    vi.unstubAllGlobals();
  });

  it.each([
    ["sends again", (chat: ReturnType<typeof useAgentChat>) => chat.send("and another")],
    ["starts a new chat", (chat: ReturnType<typeof useAgentChat>) => chat.newChat()],
  ])("never opens a tab asked for before Stop, even once the user %s", async (_what, next) => {
    let finishSave!: (result: { ok: true; name: string; path: string }) => void;
    saveLiveWorkflow.mockImplementation(() => new Promise((resolve) => (finishSave = resolve)));
    const tabA = useWorkflowStore.getState().activeTabId;
    const { result, streams } = await busyChat();
    await act(async () => {
      push(streams[0], step("save", { op: "save", name: "Fox" }));
      push(streams[0], openTab());
      await sleep(30);
    });

    act(() => result.current.stop());
    await waitFor(() => expect(result.current.busy).toBe(false));
    act(() => {
      next(result.current);
    });
    await act(async () => {
      finishSave({ ok: true, name: "Fox", path: "/lib/Fox" });
      await sleep(30);
    });

    expect(useWorkflowStore.getState().tabs.map((tab) => tab.id)).toEqual([tabA]);
    for (const stream of streams) stream.end();
  });

  it("keeps an ended turn's queued edits off a workflow loaded into the tab since, once a new turn begins", async () => {
    let finishSave!: (result: { ok: false; reason: string }) => void;
    saveLiveWorkflow.mockImplementation(() => new Promise((resolve) => (finishSave = resolve)));
    const { result, streams } = await busyChat();
    await act(async () => {
      push(streams[0], step("save", { op: "save", name: "Fox" }));
      push(streams[0], edit("dog"));
      streams[0].push({ type: "finish" });
      streams[0].end();
      await sleep(30);
    });
    await waitFor(() => expect(result.current.busy).toBe(false));
    // The user drops another workflow onto the same tab, then starts afresh.
    await act(() => useWorkflowStore.getState().loadWorkflow(workflow("wf-B", "B", "a mountain lake")));
    act(() => result.current.newChat());
    await act(async () => {
      finishSave({ ok: false, reason: "A different workflow was opened" });
      await sleep(30);
    });
    expect(nodeIds()).not.toContain("prompt-dog");
  });

  it("Stop also covers the last turn's tab step still queued behind its save, and lets the waiting turn go at once", async () => {
    let finishSave!: (result: { ok: true; name: string; path: string }) => void;
    saveLiveWorkflow.mockImplementation(() => new Promise((resolve) => (finishSave = resolve)));
    const tabA = useWorkflowStore.getState().activeTabId;
    const { result, streams } = await busyChat();
    act(() => {
      result.current.send("then make it blue");
    });
    await act(async () => {
      push(streams[0], step("save", { op: "save", name: "Fox" }));
      push(streams[0], openTab());
      streams[0].push({ type: "finish" });
      streams[0].end();
      await sleep(50);
    });
    // The queued message went, and waits for the save before its request is built.
    act(() => result.current.stop());
    await waitFor(() => expect(result.current.busy).toBe(false));
    await act(async () => {
      finishSave({ ok: true, name: "Fox", path: "/lib/Fox" });
      await sleep(30);
    });
    expect(useWorkflowStore.getState().tabs.map((tab) => tab.id)).toEqual([tabA]);
    for (const stream of streams) stream.end();
  });

  it("New chat after a turn ended drops the tab step it still had queued", async () => {
    let finishSave!: (result: { ok: true; name: string; path: string }) => void;
    saveLiveWorkflow.mockImplementation(() => new Promise((resolve) => (finishSave = resolve)));
    const tabA = useWorkflowStore.getState().activeTabId;
    const { result, streams } = await busyChat();
    await act(async () => {
      push(streams[0], step("save", { op: "save", name: "Fox" }));
      push(streams[0], openTab());
      streams[0].push({ type: "finish" });
      streams[0].end();
      await sleep(30);
    });
    await waitFor(() => expect(result.current.busy).toBe(false));
    act(() => result.current.newChat());
    await act(async () => {
      finishSave({ ok: true, name: "Fox", path: "/lib/Fox" });
      await sleep(30);
    });
    expect(useWorkflowStore.getState().tabs.map((tab) => tab.id)).toEqual([tabA]);
  });

  it("New chat mid-turn drops the old turn's remaining steps, a switch already waiting included", async () => {
    const { tabA, tabB } = twoTabs();
    const { result, streams } = await busyChat();
    useWorkflowStore.setState({ isSaving: true });
    await act(async () => {
      push(streams[0], step("switch", { op: "switchTab", tabId: tabB }, tabB));
      push(streams[0], edit("in-b", tabB));
      await sleep(30);
    });

    act(() => result.current.newChat());
    await act(async () => {
      useWorkflowStore.setState({ isSaving: false });
      await sleep(200);
    });

    const state = useWorkflowStore.getState();
    expect(state.activeTabId).toBe(tabA);
    expect(nodeIds()).not.toContain("prompt-in-b");
    expect(state.tabs.find((tab) => tab.id === tabB)?.snapshot?.nodes.map((node) => node.id)).not.toContain("prompt-in-b");
    expect(toastShow).not.toHaveBeenCalled();
    for (const stream of streams) stream.end();
  });

  it("sends the next turn once the last one's steps have landed, describing the tab they left live", async () => {
    const { tabB } = twoTabs();
    const { result, streams, bodies, signals } = await busyChat();
    useWorkflowStore.setState({ isSaving: true });
    act(() => {
      result.current.send("then make it blue");
    });
    await act(async () => {
      push(streams[0], step("switch", { op: "switchTab", tabId: tabB }, tabB));
      streams[0].push({ type: "finish" });
      streams[0].end();
      await sleep(50);
    });
    // The switch still waits for the save: the queued message waits with it.
    expect(streams).toHaveLength(1);

    await act(async () => {
      useWorkflowStore.setState({ isSaving: false });
      await sleep(200);
    });
    await waitFor(() => expect(streams).toHaveLength(2));
    expect(bodies[1].workflow?.tabId).toBe(tabB);

    await act(async () => {
      streams[1].push({ type: "start", messageId: "assistant-2" });
      push(streams[1], edit("blue", tabB));
      await sleep(30);
    });
    expect(nodeIds()).toContain("prompt-blue");
    expect(signals[1].aborted).toBe(false);
    expect(toastShow).not.toHaveBeenCalled();
    streams[1].end();
  });

  it("a step refused after its turn ended stops nothing but that turn", async () => {
    const { tabA, tabB } = twoTabs();
    const { result, streams, signals } = await busyChat();
    useWorkflowStore.setState({ isSaving: true });
    act(() => {
      result.current.send("then make it blue");
    });
    await act(async () => {
      push(streams[0], step("switch", { op: "switchTab", tabId: tabB }, tabB));
      streams[0].push({ type: "finish" });
      streams[0].end();
      await sleep(50);
    });

    // The tab closes while the switch waits: the switch is refused once the save ends.
    await act(async () => {
      useWorkflowStore.setState((state) => ({ tabs: state.tabs.filter((tab) => tab.id !== tabB), isSaving: false }));
      await sleep(200);
    });
    expect(toastShow).toHaveBeenCalledWith("Stopped the agent: it couldn't switch workflows (that workflow is no longer open)", "warning");
    expect(useWorkflowStore.getState().activeTabId).toBe(tabA);

    // The queued message's turn goes on.
    await waitFor(() => expect(streams).toHaveLength(2));
    expect(signals[1].aborted).toBe(false);
    expect(result.current.busy).toBe(true);
    streams[1].end();
  });

  it("names the tab its turn worked on, once the turn's steps have settled", async () => {
    const { tabA, tabB } = twoTabs();
    const { result, streams } = await busyChat();
    useWorkflowStore.setState({ isSaving: true });
    await act(async () => {
      push(streams[0], step("switch", { op: "switchTab", tabId: tabB }, tabB));
      streams[0].push({ type: "finish" });
      streams[0].end();
      await sleep(50);
    });
    expect(result.current.busy).toBe(false);

    let settled = false;
    void result.current.stepsSettled!().then(() => (settled = true));
    await act(() => sleep(30));
    expect(settled).toBe(false);
    expect(result.current.turnTabId!()).toBe(tabA);

    await act(async () => {
      useWorkflowStore.setState({ isSaving: false });
      await sleep(200);
    });
    expect(settled).toBe(true);
    expect(result.current.turnTabId!()).toBe(tabB);
  });

  it("keeps naming the turn's own tab when the user opens another one mid-turn", async () => {
    const { tabA, tabB } = twoTabs();
    const { result, streams } = await busyChat();
    act(() => {
      useWorkflowStore.getState().switchTab(tabB);
    });
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.turnTabId!()).toBe(tabA);
    streams[0].end();
  });
});
