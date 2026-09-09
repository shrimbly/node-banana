import { describe, it, expect, vi, beforeEach } from "vitest";
import { act } from "@testing-library/react";
import { useWorkflowStore } from "../workflowStore";
import type { GenerateVideoNodeData, WorkflowNode } from "@/types";
import type { ProviderModel } from "@/lib/providers/types";

vi.mock("@/components/Toast", () => ({
  useToast: { getState: () => ({ show: vi.fn() }) },
}));

vi.mock("@/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    startSession: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined),
    getCurrentSession: vi.fn().mockReturnValue(null),
  },
}));

const model: ProviderModel = {
  id: "kling/v3",
  name: "Kling 3",
  provider: "kie",
  capabilities: ["image-to-video"],
} as ProviderModel;

function videoNode(id: string): WorkflowNode {
  return {
    id,
    type: "generateVideo",
    position: { x: 0, y: 0 },
    data: {
      selectedModel: { provider: "fal", modelId: "old/model", displayName: "Old" },
      parameters: { duration: 5, seed: 7 },
      status: "idle",
      error: null,
    },
  } as unknown as WorkflowNode;
}

function promptNode(id: string): WorkflowNode {
  return { id, type: "prompt", position: { x: 0, y: 0 }, data: { prompt: "keep me" } } as unknown as WorkflowNode;
}

describe("applyModelToNodes", () => {
  beforeEach(() => {
    useWorkflowStore.setState({
      nodes: [videoNode("v1"), videoNode("v2"), videoNode("v3"), promptNode("p1")],
      edges: [],
      hasUnsavedChanges: false,
    });
  });

  it("puts the model on every listed generator and resets their parameters", () => {
    act(() => useWorkflowStore.getState().applyModelToNodes(["v1", "v2", "v3"], model));

    for (const id of ["v1", "v2", "v3"]) {
      const data = useWorkflowStore.getState().nodes.find((n) => n.id === id)!.data as GenerateVideoNodeData;
      expect(data.selectedModel).toEqual({ provider: "kie", modelId: "kling/v3", displayName: "Kling 3" });
      expect(data.parameters).toEqual({});
    }
    expect(useWorkflowStore.getState().hasUnsavedChanges).toBe(true);
  });

  it("leaves nodes outside the selection, and non-generators inside it, alone", () => {
    act(() => useWorkflowStore.getState().applyModelToNodes(["v1", "p1"], model));

    const nodes = useWorkflowStore.getState().nodes;
    expect((nodes.find((n) => n.id === "v2")!.data as GenerateVideoNodeData).selectedModel?.modelId).toBe("old/model");
    expect((nodes.find((n) => n.id === "p1")!.data as { prompt: string }).prompt).toBe("keep me");
    expect((nodes.find((n) => n.id === "v1")!.data as GenerateVideoNodeData).selectedModel?.modelId).toBe("kling/v3");
  });

  it("is one undo step for the whole selection", () => {
    act(() => useWorkflowStore.getState().applyModelToNodes(["v1", "v2"], model));
    act(() => useWorkflowStore.getState().undo());

    const nodes = useWorkflowStore.getState().nodes;
    for (const id of ["v1", "v2"]) {
      expect((nodes.find((n) => n.id === id)!.data as GenerateVideoNodeData).selectedModel?.modelId).toBe("old/model");
    }
  });

  it("does nothing, not even an undo step, when nothing in the selection is a generator", () => {
    act(() => useWorkflowStore.getState().applyModelToNodes(["p1"], model));
    expect(useWorkflowStore.getState().hasUnsavedChanges).toBe(false);
  });
});
