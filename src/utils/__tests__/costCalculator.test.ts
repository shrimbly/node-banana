import { describe, it, expect } from "vitest";
import { hasNonGeminiProviders, calculatePredictedCost } from "@/utils/costCalculator";
import { WorkflowNode } from "@/types";

describe("hasNonGeminiProviders", () => {
  it("should return false for empty nodes array", () => {
    expect(hasNonGeminiProviders([])).toBe(false);
  });

  it("should return false for non-generation nodes only", () => {
    const nodes: WorkflowNode[] = [
      {
        id: "1",
        type: "prompt",
        position: { x: 0, y: 0 },
        data: { prompt: "test" },
      },
      {
        id: "2",
        type: "imageInput",
        position: { x: 0, y: 0 },
        data: {},
      },
    ];
    expect(hasNonGeminiProviders(nodes)).toBe(false);
  });

  it("should return false for nanoBanana node with no selectedModel (legacy Gemini)", () => {
    const nodes: WorkflowNode[] = [
      {
        id: "1",
        type: "nanoBanana",
        position: { x: 0, y: 0 },
        data: { model: "nano-banana", resolution: "1K" },
      },
    ];
    expect(hasNonGeminiProviders(nodes)).toBe(false);
  });

  it("should return false for nanoBanana node with gemini selectedModel", () => {
    const nodes: WorkflowNode[] = [
      {
        id: "1",
        type: "nanoBanana",
        position: { x: 0, y: 0 },
        data: {
          model: "nano-banana-pro",
          resolution: "1K",
          selectedModel: {
            provider: "gemini",
            modelId: "nano-banana-pro",
            displayName: "Nano Banana Pro",
          },
        },
      },
    ];
    expect(hasNonGeminiProviders(nodes)).toBe(false);
  });

  it("should return true for nanoBanana node with fal provider", () => {
    const nodes: WorkflowNode[] = [
      {
        id: "1",
        type: "nanoBanana",
        position: { x: 0, y: 0 },
        data: {
          model: "nano-banana",
          resolution: "1K",
          selectedModel: {
            provider: "fal",
            modelId: "fal-ai/flux",
            displayName: "Flux",
          },
        },
      },
    ];
    expect(hasNonGeminiProviders(nodes)).toBe(true);
  });

  it("should return true for nanoBanana node with replicate provider", () => {
    const nodes: WorkflowNode[] = [
      {
        id: "1",
        type: "nanoBanana",
        position: { x: 0, y: 0 },
        data: {
          model: "nano-banana",
          resolution: "1K",
          selectedModel: {
            provider: "replicate",
            modelId: "some-model",
            displayName: "Some Model",
          },
        },
      },
    ];
    expect(hasNonGeminiProviders(nodes)).toBe(true);
  });

  it("should return true for nanoBanana node with kie provider", () => {
    const nodes: WorkflowNode[] = [
      {
        id: "1",
        type: "nanoBanana",
        position: { x: 0, y: 0 },
        data: {
          model: "nano-banana",
          resolution: "1K",
          selectedModel: {
            provider: "kie",
            modelId: "kie-model",
            displayName: "Kie Model",
          },
        },
      },
    ];
    expect(hasNonGeminiProviders(nodes)).toBe(true);
  });

  it("should return true for nanoBanana node with wavespeed provider", () => {
    const nodes: WorkflowNode[] = [
      {
        id: "1",
        type: "nanoBanana",
        position: { x: 0, y: 0 },
        data: {
          model: "nano-banana",
          resolution: "1K",
          selectedModel: {
            provider: "wavespeed",
            modelId: "ws-model",
            displayName: "WaveSpeed Model",
          },
        },
      },
    ];
    expect(hasNonGeminiProviders(nodes)).toBe(true);
  });

  it("should return true for generateVideo node with non-Gemini provider", () => {
    const nodes: WorkflowNode[] = [
      {
        id: "1",
        type: "generateVideo",
        position: { x: 0, y: 0 },
        data: {
          selectedModel: {
            provider: "kie",
            modelId: "kling-video",
            displayName: "Kling Video",
          },
          status: "idle",
        },
      },
    ];
    expect(hasNonGeminiProviders(nodes)).toBe(true);
  });

  it("should return false for generateVideo node with no selectedModel", () => {
    const nodes: WorkflowNode[] = [
      {
        id: "1",
        type: "generateVideo",
        position: { x: 0, y: 0 },
        data: { status: "idle" },
      },
    ];
    expect(hasNonGeminiProviders(nodes)).toBe(false);
  });

  it("should return true for generate3d node with non-Gemini provider", () => {
    const nodes: WorkflowNode[] = [
      {
        id: "1",
        type: "generate3d",
        position: { x: 0, y: 0 },
        data: {
          selectedModel: {
            provider: "fal",
            modelId: "fal-3d",
            displayName: "Fal 3D",
          },
          status: "idle",
        },
      },
    ];
    expect(hasNonGeminiProviders(nodes)).toBe(true);
  });

  it("should return false for generate3d node with no selectedModel", () => {
    const nodes: WorkflowNode[] = [
      {
        id: "1",
        type: "generate3d",
        position: { x: 0, y: 0 },
        data: { status: "idle" },
      },
    ];
    expect(hasNonGeminiProviders(nodes)).toBe(false);
  });

  it("should return true when mixed Gemini and non-Gemini nodes exist", () => {
    const nodes: WorkflowNode[] = [
      {
        id: "1",
        type: "nanoBanana",
        position: { x: 0, y: 0 },
        data: {
          model: "nano-banana",
          resolution: "1K",
          selectedModel: {
            provider: "gemini",
            modelId: "nano-banana",
            displayName: "Nano Banana",
          },
        },
      },
      {
        id: "2",
        type: "nanoBanana",
        position: { x: 100, y: 0 },
        data: {
          model: "nano-banana",
          resolution: "1K",
          selectedModel: {
            provider: "fal",
            modelId: "fal-ai/flux",
            displayName: "Flux",
          },
        },
      },
    ];
    expect(hasNonGeminiProviders(nodes)).toBe(true);
  });
});

describe("calculatePredictedCost - splitGrid nodes", () => {
  // splitGrid cell templates are materialized into real nodes on the canvas,
  // so generate nodes inside cells are counted directly. The splitGrid node
  // itself must not contribute any cost line.
  const splitGridNode: WorkflowNode = {
    id: "split-1",
    type: "splitGrid",
    position: { x: 0, y: 0 },
    data: {
      sourceImage: null,
      gridRows: 2,
      gridCols: 2,
      // Legacy (deprecated) fields must not influence the estimate either
      targetCount: 4,
      defaultPrompt: "",
      generateSettings: {
        aspectRatio: "1:1",
        resolution: "1K",
        model: "nano-banana",
        useGoogleSearch: false,
        useImageSearch: false,
      },
      childNodeIds: [],
      isConfigured: true,
    },
  } as WorkflowNode;

  it("should not count splitGrid nodes toward the estimate", () => {
    const result = calculatePredictedCost([splitGridNode]);

    expect(result.totalCost).toBe(0);
    expect(result.nodeCount).toBe(0);
    expect(result.breakdown).toEqual([]);
    expect(result.unknownPricingCount).toBe(0);
  });

  it("should only count non-splitGrid generation nodes in a mixed workflow", () => {
    const nodes: WorkflowNode[] = [
      splitGridNode,
      {
        id: "gen-1",
        type: "nanoBanana",
        position: { x: 100, y: 0 },
        data: { model: "nano-banana", resolution: "1K" },
      },
    ];

    const result = calculatePredictedCost(nodes);

    // Only the nanoBanana node: $0.039 (no legacy 4-cell splitGrid estimate)
    expect(result.totalCost).toBeCloseTo(0.039);
    expect(result.nodeCount).toBe(1);
    expect(result.breakdown).toHaveLength(1);
    expect(result.breakdown[0].modelId).toBe("nano-banana");
  });
});

describe("calculatePredictedCost - nano-banana-2-lite", () => {
  it("should price nano-banana-2-lite at flat $0.034 per image", () => {
    const nodes: WorkflowNode[] = [
      {
        id: "1",
        type: "nanoBanana",
        position: { x: 0, y: 0 },
        data: { model: "nano-banana-2-lite", resolution: "1K" },
      },
    ] as WorkflowNode[];

    const result = calculatePredictedCost(nodes);

    expect(result.totalCost).toBeCloseTo(0.034);
    expect(result.breakdown).toHaveLength(1);
    expect(result.breakdown[0].modelId).toBe("nano-banana-2-lite");
    expect(result.breakdown[0].unitCost).toBeCloseTo(0.034);
    expect(result.unknownPricingCount).toBe(0);
  });

  it("should charge flat 1K pricing for nano-banana-2-lite regardless of stored resolution", () => {
    const nodes: WorkflowNode[] = [
      {
        id: "1",
        type: "nanoBanana",
        position: { x: 0, y: 0 },
        data: { model: "nano-banana-2-lite", resolution: "4K" },
      },
    ] as WorkflowNode[];

    const result = calculatePredictedCost(nodes);

    // nano-banana-2-lite is 1K only: flat $0.034 even if a stale resolution is set
    expect(result.totalCost).toBeCloseTo(0.034);
  });
});

describe("GPT Image 2.5 predictions", () => {
  it("reports unknown price instead of inheriting the node's legacy Gemini model price", () => {
    const result = calculatePredictedCost([{
      id: "openai", type: "nanoBanana", position: { x: 0, y: 0 },
      data: { model: "nano-banana-pro", selectedModel: { provider: "openai", modelId: "gpt-image-2.5-flare", displayName: "GPT Image 2.5 Flare" } },
    }] as WorkflowNode[]);
    expect(result.unknownPricingCount).toBe(1);
    expect(result.breakdown[0].unitCost).toBeNull();
  });
});
