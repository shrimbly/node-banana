import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("video generation recovery", () => {
  let storage: Record<string, string>;

  beforeEach(() => {
    vi.resetModules();
    storage = {};
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => storage[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        storage[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        delete storage[key];
      }),
      clear: vi.fn(() => {
        storage = {};
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reattaches a completed broker run to its saved workflow node", async () => {
    const { GENERATION_RUNS_STORAGE_KEY, loadGenerationRuns } = await import(
      "../utils/generationRuns"
    );
    storage[GENERATION_RUNS_STORAGE_KEY] = JSON.stringify([
      {
        version: 1,
        runId: "recovery-run-1",
        workflowId: "workflow-recovery",
        nodeId: "video-1",
        nodeType: "generateVideo",
        provider: "fal",
        modelId: "fal-ai/video",
        modelName: "Fal Video",
        mediaType: "video",
        prompt: "Recovered prompt",
        status: "running",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.startsWith("/api/generate/run?")) {
          return Response.json({
            state: "completed",
            responseStatus: 200,
            result: { success: true, videoUrl: "https://cdn.example/recovered.mp4" },
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      })
    );

    const { useWorkflowStore } = await import("../workflowStore");
    await useWorkflowStore.getState().loadWorkflow({
      version: 1,
      id: "workflow-recovery",
      name: "Recovery",
      edgeStyle: "angular",
      edges: [],
      nodes: [
        {
          id: "video-1",
          type: "generateVideo",
          position: { x: 0, y: 0 },
          data: {
            inputImages: [],
            inputPrompt: "Recovered prompt",
            outputVideo: null,
            selectedModel: {
              provider: "fal",
              modelId: "fal-ai/video",
              displayName: "Fal Video",
            },
            status: "loading",
            error: null,
            videoHistory: [],
            selectedVideoHistoryIndex: 0,
          },
        },
      ],
    });

    await vi.waitFor(() => {
      const node = useWorkflowStore.getState().nodes[0];
      expect(node.data).toMatchObject({
        status: "complete",
        outputVideo: "https://cdn.example/recovered.mp4",
        activeRunId: null,
      });
      expect((node.data as { videoHistory: Array<{ runId?: string }> }).videoHistory[0].runId)
        .toBe("recovery-run-1");
    });
  });

  it("restores a failed run that was not saved before reload", async () => {
    const { GENERATION_RUNS_STORAGE_KEY } = await import("../utils/generationRuns");
    storage[GENERATION_RUNS_STORAGE_KEY] = JSON.stringify([
      {
        version: 1,
        runId: "failed-recovery-run",
        workflowId: "workflow-recovery",
        nodeId: "video-1",
        nodeType: "generateVideo",
        provider: "fal",
        modelId: "fal-ai/video",
        modelName: "Fal Video",
        mediaType: "video",
        prompt: "Prompt that failed",
        status: "failed",
        error: "Provider timed out",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { useWorkflowStore } = await import("../workflowStore");
    await useWorkflowStore.getState().loadWorkflow({
      version: 1,
      id: "workflow-recovery",
      name: "Recovery",
      edgeStyle: "angular",
      edges: [],
      nodes: [
        {
          id: "video-1",
          type: "generateVideo",
          position: { x: 0, y: 0 },
          data: {
            inputImages: [],
            inputPrompt: "Prompt that failed",
            outputVideo: null,
            selectedModel: {
              provider: "fal",
              modelId: "fal-ai/video",
              displayName: "Fal Video",
            },
            status: "idle",
            error: null,
            videoHistory: [],
            selectedVideoHistoryIndex: 0,
          },
        },
      ],
    });

    const data = useWorkflowStore.getState().nodes[0].data as {
      status: string;
      error: string | null;
      videoHistory: Array<{
        runId?: string;
        prompt: string;
        model: string;
        error?: string;
      }>;
    };
    expect(data).toMatchObject({
      status: "error",
      error: "Provider timed out",
    });
    expect(data.videoHistory).toEqual([
      expect.objectContaining({
        runId: "failed-recovery-run",
        prompt: "Prompt that failed",
        model: "fal-ai/video",
        error: "Provider timed out",
      }),
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not let an older recovery failure overwrite a newer run", async () => {
    const { GENERATION_RUNS_STORAGE_KEY, loadGenerationRuns } = await import(
      "../utils/generationRuns"
    );
    storage[GENERATION_RUNS_STORAGE_KEY] = JSON.stringify([
      {
        version: 1,
        runId: "stale-run-a",
        workflowId: "workflow-recovery",
        nodeId: "video-1",
        nodeType: "generateVideo",
        provider: "fal",
        modelId: "fal-ai/video",
        modelName: "Fal Video",
        mediaType: "video",
        prompt: "Old prompt",
        status: "running",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);

    let rejectRecovery: ((error: Error) => void) | undefined;
    const recovery = new Promise<never>((_, reject) => {
      rejectRecovery = reject;
    });
    vi.doMock("../execution", async () => {
      const actual = await vi.importActual<typeof import("../execution")>(
        "../execution"
      );
      return {
        ...actual,
        pollLocalGenerationRun: vi.fn(() => recovery),
      };
    });

    try {
      const { useWorkflowStore } = await import("../workflowStore");
      await useWorkflowStore.getState().loadWorkflow({
        version: 1,
        id: "workflow-recovery",
        name: "Recovery",
        edgeStyle: "angular",
        edges: [],
        nodes: [
          {
            id: "video-1",
            type: "generateVideo",
            position: { x: 0, y: 0 },
            data: {
              inputImages: [],
              inputPrompt: "Old prompt",
              outputVideo: null,
              selectedModel: {
                provider: "fal",
                modelId: "fal-ai/video",
                displayName: "Fal Video",
              },
              status: "loading",
              error: null,
              videoHistory: [],
              selectedVideoHistoryIndex: 0,
            },
          },
        ],
      });

      useWorkflowStore.getState().updateNodeData("video-1", {
        activeRunId: "newer-run-b",
        runStatus: "running",
        status: "loading",
        error: null,
      });
      rejectRecovery?.(new Error("Old recovery lost contact"));

      await vi.waitFor(() => {
        expect(loadGenerationRuns()).toEqual([
          expect.objectContaining({
            runId: "stale-run-a",
            status: "failed",
            error: "Old recovery lost contact",
          }),
        ]);
        const data = useWorkflowStore.getState().nodes[0].data as {
          activeRunId?: string | null;
          status: string;
          error: string | null;
          videoHistory: unknown[];
        };
        expect(data).toMatchObject({
          activeRunId: "newer-run-b",
          status: "loading",
          error: null,
          videoHistory: [],
        });
      });
    } finally {
      vi.doUnmock("../execution");
    }
  });
});
