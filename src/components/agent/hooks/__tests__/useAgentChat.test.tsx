/**
 * useAgentChat against the real workflow store: a turn's canvas edits belong to
 * the canvas it was sent from. The chat route is faked at fetch with a UI
 * message stream the test feeds chunk by chunk.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const toastShow = vi.hoisted(() => vi.fn());
vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show: toastShow }) } }));
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
import type { AgentGraphOpBatch } from "@/lib/agent/types";

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
