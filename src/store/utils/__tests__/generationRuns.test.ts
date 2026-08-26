import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GENERATION_RUNS_STORAGE_KEY,
  getGenerationRunsForWorkflow,
  loadGenerationRuns,
  removeGenerationRun,
  updateGenerationRun,
  upsertGenerationRun,
} from "../generationRuns";
import type { PersistedGenerationRun } from "@/types";

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    clear: vi.fn(() => {
      store = {};
    }),
  };
})();

Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  configurable: true,
});

function makeRun(overrides: Partial<PersistedGenerationRun> = {}): PersistedGenerationRun {
  return {
    version: 1,
    runId: "run-1",
    workflowId: "workflow-1",
    nodeId: "video-1",
    nodeType: "generateVideo",
    provider: "fal",
    modelId: "fal/video",
    modelName: "Fal Video",
    mediaType: "video",
    prompt: "hello",
    status: "running",
    createdAt: 100,
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("generation run persistence", () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it("upserts and filters runs by workflow", () => {
    const workflowRun = makeRun();
    upsertGenerationRun(workflowRun);
    upsertGenerationRun(makeRun({ runId: "run-2", workflowId: "workflow-2" }));

    expect(getGenerationRunsForWorkflow("workflow-1")).toEqual([workflowRun]);
  });

  it("updates provider polling metadata without losing the node binding", () => {
    upsertGenerationRun(makeRun());
    updateGenerationRun("run-1", {
      status: "provider-polling",
      providerTaskId: "provider-task-1",
      pollProvider: "fal",
    });

    expect(loadGenerationRuns()[0]).toMatchObject({
      runId: "run-1",
      workflowId: "workflow-1",
      nodeId: "video-1",
      status: "provider-polling",
      providerTaskId: "provider-task-1",
    });
  });

  it("removes an acknowledged run", () => {
    upsertGenerationRun(makeRun());
    removeGenerationRun("run-1");

    expect(localStorageMock.getItem(GENERATION_RUNS_STORAGE_KEY)).toBe("[]");
  });

  it("ignores malformed storage", () => {
    localStorageMock.setItem(GENERATION_RUNS_STORAGE_KEY, "not-json");
    expect(loadGenerationRuns()).toEqual([]);
  });
});
