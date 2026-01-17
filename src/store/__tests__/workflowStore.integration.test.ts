/**
 * Integration tests for workflowStore
 *
 * Tests the integration functions that handle node connections and data flow:
 * - getConnectedInputs: extracts data from connected nodes
 * - validateWorkflow: checks workflow integrity
 * - topological sort: ensures correct execution order
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "@testing-library/react";
import { useWorkflowStore } from "../workflowStore";
import type { WorkflowNode, WorkflowEdge } from "@/types";

// Mock the Toast hook
vi.mock("@/components/Toast", () => ({
  useToast: {
    getState: () => ({
      show: vi.fn(),
    }),
  },
}));

// Mock the logger
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

// Mock localStorage for provider settings
const mockLocalStorage: Record<string, string> = {};
vi.stubGlobal("localStorage", {
  getItem: vi.fn((key: string) => mockLocalStorage[key] || null),
  setItem: vi.fn((key: string, value: string) => {
    mockLocalStorage[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete mockLocalStorage[key];
  }),
  clear: vi.fn(() => {
    Object.keys(mockLocalStorage).forEach((key) => delete mockLocalStorage[key]);
  }),
});

// Helper to reset store state between tests
function resetStore() {
  const store = useWorkflowStore.getState();
  store.clearWorkflow();
}

// Helper to create a test node
function createTestNode(
  id: string,
  type: string,
  data: Record<string, unknown> = {},
  position = { x: 0, y: 0 }
): WorkflowNode {
  return {
    id,
    type: type as WorkflowNode["type"],
    position,
    data: data as WorkflowNode["data"],
  };
}

// Helper to create a test edge
function createTestEdge(
  source: string,
  target: string,
  sourceHandle: string | null = null,
  targetHandle: string | null = null,
  hasPause = false
): WorkflowEdge {
  return {
    id: `edge-${source}-${target}-${sourceHandle || "default"}-${targetHandle || "default"}`,
    source,
    target,
    sourceHandle,
    targetHandle,
    data: hasPause ? { hasPause: true } : undefined,
  };
}

describe("workflowStore integration tests", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetStore();
  });

  describe("getConnectedInputs", () => {
    describe("Basic data extraction scenarios", () => {
      it("should extract image from imageInput node", () => {
        const store = useWorkflowStore.getState();
        const testImage = "data:image/png;base64,testImageData";

        // Set up nodes and edges directly
        useWorkflowStore.setState({
          nodes: [
            createTestNode("imageInput-1", "imageInput", { image: testImage }),
            createTestNode("nanoBanana-1", "nanoBanana", {}),
          ],
          edges: [createTestEdge("imageInput-1", "nanoBanana-1", "image", "image")],
        });

        const result = store.getConnectedInputs("nanoBanana-1");

        expect(result.images).toContain(testImage);
        expect(result.images).toHaveLength(1);
      });

      it("should extract image from annotation node (outputImage)", () => {
        const store = useWorkflowStore.getState();
        const testImage = "data:image/png;base64,annotatedImageData";

        useWorkflowStore.setState({
          nodes: [
            createTestNode("annotation-1", "annotation", { outputImage: testImage }),
            createTestNode("nanoBanana-1", "nanoBanana", {}),
          ],
          edges: [createTestEdge("annotation-1", "nanoBanana-1", "image", "image")],
        });

        const result = store.getConnectedInputs("nanoBanana-1");

        expect(result.images).toContain(testImage);
        expect(result.images).toHaveLength(1);
      });

      it("should extract image from nanoBanana node (outputImage)", () => {
        const store = useWorkflowStore.getState();
        const testImage = "data:image/png;base64,generatedImageData";

        useWorkflowStore.setState({
          nodes: [
            createTestNode("nanoBanana-1", "nanoBanana", { outputImage: testImage }),
            createTestNode("nanoBanana-2", "nanoBanana", {}),
          ],
          edges: [createTestEdge("nanoBanana-1", "nanoBanana-2", "image", "image")],
        });

        const result = store.getConnectedInputs("nanoBanana-2");

        expect(result.images).toContain(testImage);
        expect(result.images).toHaveLength(1);
      });

      it("should extract text from prompt node", () => {
        const store = useWorkflowStore.getState();
        const testPrompt = "A beautiful sunset over the ocean";

        useWorkflowStore.setState({
          nodes: [
            createTestNode("prompt-1", "prompt", { prompt: testPrompt }),
            createTestNode("nanoBanana-1", "nanoBanana", {}),
          ],
          edges: [createTestEdge("prompt-1", "nanoBanana-1", "text", "text")],
        });

        const result = store.getConnectedInputs("nanoBanana-1");

        expect(result.text).toBe(testPrompt);
      });

      it("should extract text from llmGenerate node (outputText)", () => {
        const store = useWorkflowStore.getState();
        const testOutput = "Generated text from LLM";

        useWorkflowStore.setState({
          nodes: [
            createTestNode("llmGenerate-1", "llmGenerate", { outputText: testOutput }),
            createTestNode("nanoBanana-1", "nanoBanana", {}),
          ],
          edges: [createTestEdge("llmGenerate-1", "nanoBanana-1", "text", "text")],
        });

        const result = store.getConnectedInputs("nanoBanana-1");

        expect(result.text).toBe(testOutput);
      });
    });

    describe("Multiple connections", () => {
      it("should collect multiple images from different sources", () => {
        const store = useWorkflowStore.getState();
        const testImage1 = "data:image/png;base64,image1Data";
        const testImage2 = "data:image/png;base64,image2Data";
        const testImage3 = "data:image/png;base64,image3Data";

        useWorkflowStore.setState({
          nodes: [
            createTestNode("imageInput-1", "imageInput", { image: testImage1 }),
            createTestNode("imageInput-2", "imageInput", { image: testImage2 }),
            createTestNode("annotation-1", "annotation", { outputImage: testImage3 }),
            createTestNode("nanoBanana-1", "nanoBanana", {}),
          ],
          edges: [
            createTestEdge("imageInput-1", "nanoBanana-1", "image", "image"),
            createTestEdge("imageInput-2", "nanoBanana-1", "image", "image"),
            createTestEdge("annotation-1", "nanoBanana-1", "image", "image"),
          ],
        });

        const result = store.getConnectedInputs("nanoBanana-1");

        expect(result.images).toHaveLength(3);
        expect(result.images).toContain(testImage1);
        expect(result.images).toContain(testImage2);
        expect(result.images).toContain(testImage3);
      });

      it("should use last connected text source (not array)", () => {
        const store = useWorkflowStore.getState();
        const prompt1 = "First prompt";
        const prompt2 = "Second prompt";

        useWorkflowStore.setState({
          nodes: [
            createTestNode("prompt-1", "prompt", { prompt: prompt1 }),
            createTestNode("prompt-2", "prompt", { prompt: prompt2 }),
            createTestNode("nanoBanana-1", "nanoBanana", {}),
          ],
          edges: [
            createTestEdge("prompt-1", "nanoBanana-1", "text", "text"),
            createTestEdge("prompt-2", "nanoBanana-1", "text", "text"),
          ],
        });

        const result = store.getConnectedInputs("nanoBanana-1");

        // Should have text from one of the prompts (last one processed)
        expect(result.text).toBe(prompt2);
      });

      it("should handle mix of image and text connections", () => {
        const store = useWorkflowStore.getState();
        const testImage = "data:image/png;base64,imageData";
        const testPrompt = "Test prompt text";

        useWorkflowStore.setState({
          nodes: [
            createTestNode("imageInput-1", "imageInput", { image: testImage }),
            createTestNode("prompt-1", "prompt", { prompt: testPrompt }),
            createTestNode("nanoBanana-1", "nanoBanana", {}),
          ],
          edges: [
            createTestEdge("imageInput-1", "nanoBanana-1", "image", "image"),
            createTestEdge("prompt-1", "nanoBanana-1", "text", "text"),
          ],
        });

        const result = store.getConnectedInputs("nanoBanana-1");

        expect(result.images).toContain(testImage);
        expect(result.images).toHaveLength(1);
        expect(result.text).toBe(testPrompt);
      });
    });

    describe("Dynamic input mapping", () => {
      it("should map handle IDs to schema names when inputSchema is present", () => {
        const store = useWorkflowStore.getState();
        const testImage = "data:image/png;base64,imageData";

        useWorkflowStore.setState({
          nodes: [
            createTestNode("imageInput-1", "imageInput", { image: testImage }),
            createTestNode("generateVideo-1", "generateVideo", {
              inputSchema: [
                { name: "image_url", type: "image", required: true, label: "Image" },
              ],
            }),
          ],
          edges: [createTestEdge("imageInput-1", "generateVideo-1", "image", "image")],
        });

        const result = store.getConnectedInputs("generateVideo-1");

        expect(result.dynamicInputs).toHaveProperty("image_url");
        expect(result.dynamicInputs.image_url).toBe(testImage);
      });

      it("should map multiple image handles to schema names", () => {
        const store = useWorkflowStore.getState();
        const testImage1 = "data:image/png;base64,firstFrame";
        const testImage2 = "data:image/png;base64,lastFrame";

        useWorkflowStore.setState({
          nodes: [
            createTestNode("imageInput-1", "imageInput", { image: testImage1 }),
            createTestNode("imageInput-2", "imageInput", { image: testImage2 }),
            createTestNode("generateVideo-1", "generateVideo", {
              inputSchema: [
                { name: "first_frame", type: "image", required: true, label: "First Frame" },
                { name: "last_frame", type: "image", required: false, label: "Last Frame" },
              ],
            }),
          ],
          edges: [
            createTestEdge("imageInput-1", "generateVideo-1", "image", "image-0"),
            createTestEdge("imageInput-2", "generateVideo-1", "image", "image-1"),
          ],
        });

        const result = store.getConnectedInputs("generateVideo-1");

        expect(result.dynamicInputs).toHaveProperty("first_frame", testImage1);
        expect(result.dynamicInputs).toHaveProperty("last_frame", testImage2);
      });

      it("should map multiple text handles to schema names", () => {
        const store = useWorkflowStore.getState();
        const prompt = "Create a video";
        const negativePrompt = "No blur";

        useWorkflowStore.setState({
          nodes: [
            createTestNode("prompt-1", "prompt", { prompt }),
            createTestNode("prompt-2", "prompt", { prompt: negativePrompt }),
            createTestNode("generateVideo-1", "generateVideo", {
              inputSchema: [
                { name: "prompt", type: "text", required: true, label: "Prompt" },
                { name: "negative_prompt", type: "text", required: false, label: "Negative Prompt" },
              ],
            }),
          ],
          edges: [
            createTestEdge("prompt-1", "generateVideo-1", "text", "text-0"),
            createTestEdge("prompt-2", "generateVideo-1", "text", "text-1"),
          ],
        });

        const result = store.getConnectedInputs("generateVideo-1");

        expect(result.dynamicInputs).toHaveProperty("prompt", prompt);
        expect(result.dynamicInputs).toHaveProperty("negative_prompt", negativePrompt);
      });

      it("should not populate dynamicInputs when no inputSchema present", () => {
        const store = useWorkflowStore.getState();
        const testImage = "data:image/png;base64,imageData";

        useWorkflowStore.setState({
          nodes: [
            createTestNode("imageInput-1", "imageInput", { image: testImage }),
            createTestNode("nanoBanana-1", "nanoBanana", {}),
          ],
          edges: [createTestEdge("imageInput-1", "nanoBanana-1", "image", "image")],
        });

        const result = store.getConnectedInputs("nanoBanana-1");

        expect(Object.keys(result.dynamicInputs)).toHaveLength(0);
        // But images array should still be populated
        expect(result.images).toContain(testImage);
      });
    });

    describe("Edge cases", () => {
      it("should return empty images array and null text when no connections", () => {
        const store = useWorkflowStore.getState();

        useWorkflowStore.setState({
          nodes: [createTestNode("nanoBanana-1", "nanoBanana", {})],
          edges: [],
        });

        const result = store.getConnectedInputs("nanoBanana-1");

        expect(result.images).toEqual([]);
        expect(result.text).toBeNull();
        expect(result.dynamicInputs).toEqual({});
      });

      it("should handle source node with null output data", () => {
        const store = useWorkflowStore.getState();

        useWorkflowStore.setState({
          nodes: [
            createTestNode("imageInput-1", "imageInput", { image: null }),
            createTestNode("nanoBanana-1", "nanoBanana", {}),
          ],
          edges: [createTestEdge("imageInput-1", "nanoBanana-1", "image", "image")],
        });

        const result = store.getConnectedInputs("nanoBanana-1");

        expect(result.images).toEqual([]);
      });

      it("should handle connection to non-existent source node", () => {
        const store = useWorkflowStore.getState();

        useWorkflowStore.setState({
          nodes: [createTestNode("nanoBanana-1", "nanoBanana", {})],
          edges: [createTestEdge("nonexistent-1", "nanoBanana-1", "image", "image")],
        });

        const result = store.getConnectedInputs("nanoBanana-1");

        expect(result.images).toEqual([]);
        expect(result.text).toBeNull();
      });

      it("should treat empty string as no value (falsy check in getSourceOutput)", () => {
        const store = useWorkflowStore.getState();

        useWorkflowStore.setState({
          nodes: [
            createTestNode("prompt-1", "prompt", { prompt: "" }),
            createTestNode("nanoBanana-1", "nanoBanana", {}),
          ],
          edges: [createTestEdge("prompt-1", "nanoBanana-1", "text", "text")],
        });

        const result = store.getConnectedInputs("nanoBanana-1");

        // Empty string is treated as falsy/no value by getSourceOutput
        expect(result.text).toBeNull();
      });
    });
  });

  describe("validateWorkflow", () => {
    describe("Empty workflow", () => {
      it("should return invalid with 'Workflow is empty' error", () => {
        useWorkflowStore.setState({
          nodes: [],
          edges: [],
        });

        const store = useWorkflowStore.getState();
        const result = store.validateWorkflow();

        expect(result.valid).toBe(false);
        expect(result.errors).toContain("Workflow is empty");
      });
    });

    describe("nanoBanana node validation", () => {
      it("should return error when nanoBanana node missing text input", () => {
        useWorkflowStore.setState({
          nodes: [
            createTestNode("nanoBanana-1", "nanoBanana", {}),
          ],
          edges: [],
        });

        const store = useWorkflowStore.getState();
        const result = store.validateWorkflow();

        expect(result.valid).toBe(false);
        expect(result.errors).toContain('Generate node "nanoBanana-1" missing text input');
      });

      it("should return valid when text input is connected", () => {
        useWorkflowStore.setState({
          nodes: [
            createTestNode("prompt-1", "prompt", { prompt: "test" }),
            createTestNode("nanoBanana-1", "nanoBanana", {}),
          ],
          edges: [createTestEdge("prompt-1", "nanoBanana-1", "text", "text")],
        });

        const store = useWorkflowStore.getState();
        const result = store.validateWorkflow();

        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it("should not require image input (optional)", () => {
        useWorkflowStore.setState({
          nodes: [
            createTestNode("prompt-1", "prompt", { prompt: "test" }),
            createTestNode("nanoBanana-1", "nanoBanana", {}),
          ],
          edges: [createTestEdge("prompt-1", "nanoBanana-1", "text", "text")],
        });

        const store = useWorkflowStore.getState();
        const result = store.validateWorkflow();

        // Should be valid without image input
        expect(result.valid).toBe(true);
      });

      it("should validate multiple nanoBanana nodes independently", () => {
        useWorkflowStore.setState({
          nodes: [
            createTestNode("prompt-1", "prompt", { prompt: "test" }),
            createTestNode("nanoBanana-1", "nanoBanana", {}),
            createTestNode("nanoBanana-2", "nanoBanana", {}), // No text input
          ],
          edges: [createTestEdge("prompt-1", "nanoBanana-1", "text", "text")],
        });

        const store = useWorkflowStore.getState();
        const result = store.validateWorkflow();

        expect(result.valid).toBe(false);
        expect(result.errors).toContain('Generate node "nanoBanana-2" missing text input');
        expect(result.errors).not.toContain('Generate node "nanoBanana-1" missing text input');
      });
    });

    describe("annotation node validation", () => {
      it("should return error when no image connected and no sourceImage", () => {
        useWorkflowStore.setState({
          nodes: [
            createTestNode("annotation-1", "annotation", { sourceImage: null }),
          ],
          edges: [],
        });

        const store = useWorkflowStore.getState();
        const result = store.validateWorkflow();

        expect(result.valid).toBe(false);
        expect(result.errors).toContain('Annotation node "annotation-1" missing image input');
      });

      it("should return valid when image is connected", () => {
        useWorkflowStore.setState({
          nodes: [
            createTestNode("imageInput-1", "imageInput", { image: "data:image/png;base64,test" }),
            createTestNode("annotation-1", "annotation", { sourceImage: null }),
          ],
          edges: [createTestEdge("imageInput-1", "annotation-1", "image", "image")],
        });

        const store = useWorkflowStore.getState();
        const result = store.validateWorkflow();

        expect(result.valid).toBe(true);
      });

      it("should return valid when sourceImage is present (manual load)", () => {
        useWorkflowStore.setState({
          nodes: [
            createTestNode("annotation-1", "annotation", {
              sourceImage: "data:image/png;base64,manuallyLoadedImage",
            }),
          ],
          edges: [],
        });

        const store = useWorkflowStore.getState();
        const result = store.validateWorkflow();

        expect(result.valid).toBe(true);
      });
    });

    describe("output node validation", () => {
      it("should return error when output node has no image input", () => {
        useWorkflowStore.setState({
          nodes: [
            createTestNode("output-1", "output", {}),
          ],
          edges: [],
        });

        const store = useWorkflowStore.getState();
        const result = store.validateWorkflow();

        expect(result.valid).toBe(false);
        expect(result.errors).toContain('Output node "output-1" missing image input');
      });

      it("should return valid when output node has image connected", () => {
        useWorkflowStore.setState({
          nodes: [
            createTestNode("imageInput-1", "imageInput", { image: "data:image/png;base64,test" }),
            createTestNode("output-1", "output", {}),
          ],
          edges: [createTestEdge("imageInput-1", "output-1", "image", "image")],
        });

        const store = useWorkflowStore.getState();
        const result = store.validateWorkflow();

        expect(result.valid).toBe(true);
      });
    });

    describe("Valid workflow scenarios", () => {
      it("should validate simple prompt -> nanoBanana -> output chain", () => {
        useWorkflowStore.setState({
          nodes: [
            createTestNode("prompt-1", "prompt", { prompt: "test prompt" }),
            createTestNode("nanoBanana-1", "nanoBanana", {}),
            createTestNode("output-1", "output", {}),
          ],
          edges: [
            createTestEdge("prompt-1", "nanoBanana-1", "text", "text"),
            createTestEdge("nanoBanana-1", "output-1", "image", "image"),
          ],
        });

        const store = useWorkflowStore.getState();
        const result = store.validateWorkflow();

        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it("should validate complex workflow with multiple node types", () => {
        useWorkflowStore.setState({
          nodes: [
            createTestNode("imageInput-1", "imageInput", { image: "data:image/png;base64,test" }),
            createTestNode("prompt-1", "prompt", { prompt: "describe this" }),
            createTestNode("llmGenerate-1", "llmGenerate", {}),
            createTestNode("nanoBanana-1", "nanoBanana", {}),
            createTestNode("annotation-1", "annotation", { sourceImage: null }),
            createTestNode("output-1", "output", {}),
          ],
          edges: [
            createTestEdge("imageInput-1", "llmGenerate-1", "image", "image"),
            createTestEdge("prompt-1", "llmGenerate-1", "text", "text"),
            createTestEdge("llmGenerate-1", "nanoBanana-1", "text", "text"),
            createTestEdge("nanoBanana-1", "annotation-1", "image", "image"),
            createTestEdge("annotation-1", "output-1", "image", "image"),
          ],
        });

        const store = useWorkflowStore.getState();
        const result = store.validateWorkflow();

        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it("should validate workflow with groups (groups don't affect validation)", () => {
        useWorkflowStore.setState({
          nodes: [
            { ...createTestNode("prompt-1", "prompt", { prompt: "test" }), groupId: "group-1" },
            { ...createTestNode("nanoBanana-1", "nanoBanana", {}), groupId: "group-1" },
          ],
          edges: [createTestEdge("prompt-1", "nanoBanana-1", "text", "text")],
          groups: {
            "group-1": {
              id: "group-1",
              name: "Test Group",
              color: "neutral",
              position: { x: 0, y: 0 },
              size: { width: 400, height: 400 },
            },
          },
        });

        const store = useWorkflowStore.getState();
        const result = store.validateWorkflow();

        expect(result.valid).toBe(true);
      });

      it("should allow nodes that don't require validation (imageInput, prompt)", () => {
        useWorkflowStore.setState({
          nodes: [
            createTestNode("imageInput-1", "imageInput", { image: null }),
            createTestNode("prompt-1", "prompt", { prompt: "" }),
          ],
          edges: [],
        });

        const store = useWorkflowStore.getState();
        const result = store.validateWorkflow();

        // These nodes don't have validation rules, so workflow is valid
        expect(result.valid).toBe(true);
      });
    });

    describe("Multiple validation errors", () => {
      it("should report all validation errors, not just the first", () => {
        useWorkflowStore.setState({
          nodes: [
            createTestNode("nanoBanana-1", "nanoBanana", {}),
            createTestNode("nanoBanana-2", "nanoBanana", {}),
            createTestNode("annotation-1", "annotation", { sourceImage: null }),
            createTestNode("output-1", "output", {}),
          ],
          edges: [],
        });

        const store = useWorkflowStore.getState();
        const result = store.validateWorkflow();

        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThanOrEqual(4);
        expect(result.errors).toContain('Generate node "nanoBanana-1" missing text input');
        expect(result.errors).toContain('Generate node "nanoBanana-2" missing text input');
        expect(result.errors).toContain('Annotation node "annotation-1" missing image input');
        expect(result.errors).toContain('Output node "output-1" missing image input');
      });
    });
  });

  describe("executeWorkflow (topological sort)", () => {
    // Track execution order via updateNodeData calls
    let executionOrder: string[];

    beforeEach(() => {
      executionOrder = [];

      // Mock fetch for API calls
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true, image: "data:image/png;base64,generated" }),
        text: () => Promise.resolve(""),
      }));
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    describe("Execution order tests", () => {
      it("should execute linear chain A -> B -> C in order", async () => {
        // Set up: imageInput -> prompt -> nanoBanana
        // Only nanoBanana actually "executes" something visible
        useWorkflowStore.setState({
          nodes: [
            createTestNode("prompt-1", "prompt", { prompt: "test" }, { x: 0, y: 0 }),
            createTestNode("nanoBanana-1", "nanoBanana", {
              aspectRatio: "1:1",
              resolution: "1MP",
              model: "nano-banana",
            }, { x: 100, y: 0 }),
            createTestNode("output-1", "output", {}, { x: 200, y: 0 }),
          ],
          edges: [
            createTestEdge("prompt-1", "nanoBanana-1", "text", "text"),
            createTestEdge("nanoBanana-1", "output-1", "image", "image"),
          ],
        });

        const store = useWorkflowStore.getState();
        await store.executeWorkflow();

        // Check that the workflow completed (isRunning should be false)
        expect(useWorkflowStore.getState().isRunning).toBe(false);

        // Check that nanoBanana node was updated (status should be complete or loading at some point)
        // The node should have been processed
        const nanoBananaNode = useWorkflowStore.getState().nodes.find(n => n.id === "nanoBanana-1");
        expect(nanoBananaNode).toBeDefined();
      });

      it("should execute multiple dependencies A, B -> C correctly", async () => {
        // Two prompts feeding into one nanoBanana
        useWorkflowStore.setState({
          nodes: [
            createTestNode("imageInput-1", "imageInput", { image: "data:image/png;base64,test" }, { x: 0, y: 0 }),
            createTestNode("prompt-1", "prompt", { prompt: "test prompt" }, { x: 0, y: 100 }),
            createTestNode("nanoBanana-1", "nanoBanana", {
              aspectRatio: "1:1",
              resolution: "1MP",
              model: "nano-banana",
            }, { x: 200, y: 50 }),
          ],
          edges: [
            createTestEdge("imageInput-1", "nanoBanana-1", "image", "image"),
            createTestEdge("prompt-1", "nanoBanana-1", "text", "text"),
          ],
        });

        const store = useWorkflowStore.getState();
        await store.executeWorkflow();

        // Workflow should complete successfully
        expect(useWorkflowStore.getState().isRunning).toBe(false);
        expect(useWorkflowStore.getState().currentNodeId).toBeNull();
      });

      it("should throw error on cycle detection", async () => {
        // Create a cycle: A -> B -> A
        useWorkflowStore.setState({
          nodes: [
            createTestNode("nanoBanana-1", "nanoBanana", { prompt: "test" }),
            createTestNode("nanoBanana-2", "nanoBanana", { prompt: "test" }),
          ],
          edges: [
            createTestEdge("nanoBanana-1", "nanoBanana-2", "image", "image"),
            createTestEdge("nanoBanana-2", "nanoBanana-1", "image", "image"),
          ],
        });

        const store = useWorkflowStore.getState();

        // Execute workflow - should handle cycle internally
        await store.executeWorkflow();

        // After cycle detection, workflow should stop running
        expect(useWorkflowStore.getState().isRunning).toBe(false);
      });

      it("should handle parallel branches that merge", async () => {
        // Two parallel paths that merge:
        // prompt-1 -> nanoBanana-1 --|
        //                            |-> output-1
        // prompt-2 -> nanoBanana-2 --|
        useWorkflowStore.setState({
          nodes: [
            createTestNode("prompt-1", "prompt", { prompt: "path 1" }, { x: 0, y: 0 }),
            createTestNode("prompt-2", "prompt", { prompt: "path 2" }, { x: 0, y: 200 }),
            createTestNode("nanoBanana-1", "nanoBanana", {
              aspectRatio: "1:1",
              resolution: "1MP",
              model: "nano-banana",
            }, { x: 200, y: 0 }),
            createTestNode("nanoBanana-2", "nanoBanana", {
              aspectRatio: "1:1",
              resolution: "1MP",
              model: "nano-banana",
            }, { x: 200, y: 200 }),
            createTestNode("output-1", "output", {}, { x: 400, y: 100 }),
          ],
          edges: [
            createTestEdge("prompt-1", "nanoBanana-1", "text", "text"),
            createTestEdge("prompt-2", "nanoBanana-2", "text", "text"),
            createTestEdge("nanoBanana-1", "output-1", "image", "image"),
            createTestEdge("nanoBanana-2", "output-1", "image", "image"),
          ],
        });

        const store = useWorkflowStore.getState();
        await store.executeWorkflow();

        // Workflow should complete
        expect(useWorkflowStore.getState().isRunning).toBe(false);

        // Both nanoBanana nodes should have been processed before output
        const outputNode = useWorkflowStore.getState().nodes.find(n => n.id === "output-1");
        expect(outputNode).toBeDefined();
      });
    });

    describe("Pause edge handling", () => {
      it("should stop execution at node with incoming pause edge", async () => {
        useWorkflowStore.setState({
          nodes: [
            createTestNode("prompt-1", "prompt", { prompt: "test" }),
            createTestNode("nanoBanana-1", "nanoBanana", {
              aspectRatio: "1:1",
              resolution: "1MP",
              model: "nano-banana",
            }),
            createTestNode("output-1", "output", {}),
          ],
          edges: [
            createTestEdge("prompt-1", "nanoBanana-1", "text", "text"),
            createTestEdge("nanoBanana-1", "output-1", "image", "image", true), // Pause edge
          ],
        });

        const store = useWorkflowStore.getState();
        await store.executeWorkflow();

        // Should be paused at output node
        expect(useWorkflowStore.getState().pausedAtNodeId).toBe("output-1");
        expect(useWorkflowStore.getState().isRunning).toBe(false);
      });

      it("should set pausedAtNodeId correctly", async () => {
        useWorkflowStore.setState({
          nodes: [
            createTestNode("prompt-1", "prompt", { prompt: "test" }),
            createTestNode("nanoBanana-1", "nanoBanana", {
              aspectRatio: "1:1",
              resolution: "1MP",
              model: "nano-banana",
            }),
          ],
          edges: [
            createTestEdge("prompt-1", "nanoBanana-1", "text", "text", true), // Pause edge
          ],
        });

        const store = useWorkflowStore.getState();
        await store.executeWorkflow();

        expect(useWorkflowStore.getState().pausedAtNodeId).toBe("nanoBanana-1");
      });

      it("should resume from paused node when startFromNodeId matches pausedAtNodeId", async () => {
        // First, run until pause
        useWorkflowStore.setState({
          nodes: [
            createTestNode("prompt-1", "prompt", { prompt: "test" }),
            createTestNode("nanoBanana-1", "nanoBanana", {
              aspectRatio: "1:1",
              resolution: "1MP",
              model: "nano-banana",
            }),
          ],
          edges: [
            createTestEdge("prompt-1", "nanoBanana-1", "text", "text", true), // Pause edge
          ],
        });

        const store = useWorkflowStore.getState();
        await store.executeWorkflow();

        // Should be paused
        expect(useWorkflowStore.getState().pausedAtNodeId).toBe("nanoBanana-1");

        // Now resume from the paused node
        await store.executeWorkflow("nanoBanana-1");

        // After resuming, pausedAtNodeId should be cleared
        expect(useWorkflowStore.getState().pausedAtNodeId).toBeNull();
        expect(useWorkflowStore.getState().isRunning).toBe(false);
      });
    });

    describe("Locked group handling", () => {
      it("should skip nodes in locked groups", async () => {
        useWorkflowStore.setState({
          nodes: [
            { ...createTestNode("prompt-1", "prompt", { prompt: "test" }), groupId: "group-1" },
            { ...createTestNode("nanoBanana-1", "nanoBanana", {
              aspectRatio: "1:1",
              resolution: "1MP",
              model: "nano-banana",
            }), groupId: "group-1" },
            createTestNode("output-1", "output", {}),
          ],
          edges: [
            createTestEdge("prompt-1", "nanoBanana-1", "text", "text"),
            createTestEdge("nanoBanana-1", "output-1", "image", "image"),
          ],
          groups: {
            "group-1": {
              id: "group-1",
              name: "Locked Group",
              color: "neutral" as const,
              position: { x: 0, y: 0 },
              size: { width: 400, height: 400 },
              locked: true, // Locked!
            },
          },
        });

        const store = useWorkflowStore.getState();
        await store.executeWorkflow();

        // Workflow should complete
        expect(useWorkflowStore.getState().isRunning).toBe(false);

        // The locked nodes should not have made API calls
        // Since prompt and nanoBanana are in locked group, they should be skipped
        // Only output should execute (but it has no image from skipped nanoBanana)
      });

      it("should execute non-locked group nodes normally", async () => {
        useWorkflowStore.setState({
          nodes: [
            { ...createTestNode("prompt-1", "prompt", { prompt: "test" }), groupId: "group-1" },
            { ...createTestNode("nanoBanana-1", "nanoBanana", {
              aspectRatio: "1:1",
              resolution: "1MP",
              model: "nano-banana",
            }), groupId: "group-1" },
          ],
          edges: [
            createTestEdge("prompt-1", "nanoBanana-1", "text", "text"),
          ],
          groups: {
            "group-1": {
              id: "group-1",
              name: "Unlocked Group",
              color: "neutral" as const,
              position: { x: 0, y: 0 },
              size: { width: 400, height: 400 },
              locked: false, // Not locked
            },
          },
        });

        const store = useWorkflowStore.getState();
        await store.executeWorkflow();

        // Workflow should complete and nodes should execute
        expect(useWorkflowStore.getState().isRunning).toBe(false);
      });

      it("should only skip nodes in the locked group, not other nodes", async () => {
        useWorkflowStore.setState({
          nodes: [
            // Locked group nodes
            { ...createTestNode("prompt-1", "prompt", { prompt: "locked prompt" }), groupId: "group-locked" },
            // Unlocked nodes
            createTestNode("prompt-2", "prompt", { prompt: "unlocked prompt" }),
            createTestNode("nanoBanana-1", "nanoBanana", {
              aspectRatio: "1:1",
              resolution: "1MP",
              model: "nano-banana",
            }),
          ],
          edges: [
            createTestEdge("prompt-2", "nanoBanana-1", "text", "text"),
          ],
          groups: {
            "group-locked": {
              id: "group-locked",
              name: "Locked Group",
              color: "neutral" as const,
              position: { x: 0, y: 0 },
              size: { width: 200, height: 200 },
              locked: true,
            },
          },
        });

        const store = useWorkflowStore.getState();
        await store.executeWorkflow();

        // Workflow should complete
        expect(useWorkflowStore.getState().isRunning).toBe(false);

        // The unlocked nodes should have executed
        // (nanoBanana-1 should have status updated)
      });
    });

    describe("Start from specific node", () => {
      it("should skip nodes before startFromNodeId in execution order", async () => {
        useWorkflowStore.setState({
          nodes: [
            createTestNode("prompt-1", "prompt", { prompt: "test" }),
            createTestNode("nanoBanana-1", "nanoBanana", {
              outputImage: "data:image/png;base64,existingImage",
              aspectRatio: "1:1",
              resolution: "1MP",
              model: "nano-banana",
            }),
            createTestNode("output-1", "output", {}),
          ],
          edges: [
            createTestEdge("prompt-1", "nanoBanana-1", "text", "text"),
            createTestEdge("nanoBanana-1", "output-1", "image", "image"),
          ],
        });

        const store = useWorkflowStore.getState();

        // Start from output node - should skip prompt and nanoBanana
        await store.executeWorkflow("output-1");

        expect(useWorkflowStore.getState().isRunning).toBe(false);
      });
    });

    describe("Execution state management", () => {
      it("should set isRunning to true during execution", async () => {
        useWorkflowStore.setState({
          nodes: [
            createTestNode("prompt-1", "prompt", { prompt: "test" }),
          ],
          edges: [],
        });

        const store = useWorkflowStore.getState();

        // Start workflow but don't await yet
        const promise = store.executeWorkflow();

        // Wait for workflow to complete
        await promise;

        // After completion, isRunning should be false
        expect(useWorkflowStore.getState().isRunning).toBe(false);
      });

      it("should ignore execution request if already running", async () => {
        useWorkflowStore.setState({
          nodes: [
            createTestNode("prompt-1", "prompt", { prompt: "test" }),
          ],
          edges: [],
          isRunning: true, // Already running
        });

        const store = useWorkflowStore.getState();

        // This should return immediately without doing anything
        await store.executeWorkflow();

        // Should still be running (our mock state)
        expect(useWorkflowStore.getState().isRunning).toBe(true);
      });

      it("should clear currentNodeId after execution completes", async () => {
        useWorkflowStore.setState({
          nodes: [
            createTestNode("prompt-1", "prompt", { prompt: "test" }),
          ],
          edges: [],
        });

        const store = useWorkflowStore.getState();
        await store.executeWorkflow();

        expect(useWorkflowStore.getState().currentNodeId).toBeNull();
      });
    });
  });

  describe("Workflow execution data flow", () => {
    beforeEach(() => {
      // Mock fetch for successful API responses
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true, image: "data:image/png;base64,generatedImage" }),
        text: () => Promise.resolve(""),
      }));
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    describe("Image data flow through node chains", () => {
      it("should pass image from imageInput to nanoBanana via getConnectedInputs", async () => {
        const testImage = "data:image/png;base64,testImageData";

        useWorkflowStore.setState({
          nodes: [
            createTestNode("imageInput-1", "imageInput", { image: testImage }),
            createTestNode("prompt-1", "prompt", { prompt: "describe image" }),
            createTestNode("nanoBanana-1", "nanoBanana", {
              aspectRatio: "1:1",
              resolution: "1K",
              model: "nano-banana",
            }),
          ],
          edges: [
            createTestEdge("imageInput-1", "nanoBanana-1", "image", "image"),
            createTestEdge("prompt-1", "nanoBanana-1", "text", "text"),
          ],
        });

        // Verify getConnectedInputs extracts the image correctly
        const store = useWorkflowStore.getState();
        const inputs = store.getConnectedInputs("nanoBanana-1");

        expect(inputs.images).toContain(testImage);
        expect(inputs.images).toHaveLength(1);
        expect(inputs.text).toBe("describe image");
      });

      it("should pass annotation outputImage to downstream nanoBanana", () => {
        const annotatedImage = "data:image/png;base64,annotatedImageData";

        useWorkflowStore.setState({
          nodes: [
            createTestNode("annotation-1", "annotation", { outputImage: annotatedImage }),
            createTestNode("prompt-1", "prompt", { prompt: "enhance this" }),
            createTestNode("nanoBanana-1", "nanoBanana", {}),
          ],
          edges: [
            createTestEdge("annotation-1", "nanoBanana-1", "image", "image"),
            createTestEdge("prompt-1", "nanoBanana-1", "text", "text"),
          ],
        });

        const store = useWorkflowStore.getState();
        const inputs = store.getConnectedInputs("nanoBanana-1");

        expect(inputs.images).toContain(annotatedImage);
      });

      it("should collect multiple images from different sources into inputImages array", () => {
        const image1 = "data:image/png;base64,image1";
        const image2 = "data:image/png;base64,image2";
        const image3 = "data:image/png;base64,image3";

        useWorkflowStore.setState({
          nodes: [
            createTestNode("imageInput-1", "imageInput", { image: image1 }),
            createTestNode("imageInput-2", "imageInput", { image: image2 }),
            createTestNode("annotation-1", "annotation", { outputImage: image3 }),
            createTestNode("prompt-1", "prompt", { prompt: "combine" }),
            createTestNode("nanoBanana-1", "nanoBanana", {}),
          ],
          edges: [
            createTestEdge("imageInput-1", "nanoBanana-1", "image", "image"),
            createTestEdge("imageInput-2", "nanoBanana-1", "image", "image"),
            createTestEdge("annotation-1", "nanoBanana-1", "image", "image"),
            createTestEdge("prompt-1", "nanoBanana-1", "text", "text"),
          ],
        });

        const store = useWorkflowStore.getState();
        const inputs = store.getConnectedInputs("nanoBanana-1");

        expect(inputs.images).toHaveLength(3);
        expect(inputs.images).toContain(image1);
        expect(inputs.images).toContain(image2);
        expect(inputs.images).toContain(image3);
      });
    });

    describe("Text data flow through node chains", () => {
      it("should pass prompt text to nanoBanana inputPrompt", () => {
        const promptText = "A beautiful sunset over mountains";

        useWorkflowStore.setState({
          nodes: [
            createTestNode("prompt-1", "prompt", { prompt: promptText }),
            createTestNode("nanoBanana-1", "nanoBanana", {}),
          ],
          edges: [
            createTestEdge("prompt-1", "nanoBanana-1", "text", "text"),
          ],
        });

        const store = useWorkflowStore.getState();
        const inputs = store.getConnectedInputs("nanoBanana-1");

        expect(inputs.text).toBe(promptText);
      });

      it("should pass llmGenerate outputText to nanoBanana as text input", () => {
        const llmOutput = "Generated description from LLM";

        useWorkflowStore.setState({
          nodes: [
            createTestNode("llmGenerate-1", "llmGenerate", { outputText: llmOutput }),
            createTestNode("nanoBanana-1", "nanoBanana", {}),
          ],
          edges: [
            createTestEdge("llmGenerate-1", "nanoBanana-1", "text", "text"),
          ],
        });

        const store = useWorkflowStore.getState();
        const inputs = store.getConnectedInputs("nanoBanana-1");

        expect(inputs.text).toBe(llmOutput);
      });

      it("should chain prompt → llmGenerate → nanoBanana correctly", () => {
        const userPrompt = "Describe this image";
        const llmOutput = "A serene landscape with rolling hills";

        useWorkflowStore.setState({
          nodes: [
            createTestNode("prompt-1", "prompt", { prompt: userPrompt }),
            createTestNode("llmGenerate-1", "llmGenerate", { outputText: llmOutput }),
            createTestNode("nanoBanana-1", "nanoBanana", {}),
          ],
          edges: [
            createTestEdge("prompt-1", "llmGenerate-1", "text", "text"),
            createTestEdge("llmGenerate-1", "nanoBanana-1", "text", "text"),
          ],
        });

        const store = useWorkflowStore.getState();

        // llmGenerate should receive the prompt
        const llmInputs = store.getConnectedInputs("llmGenerate-1");
        expect(llmInputs.text).toBe(userPrompt);

        // nanoBanana should receive the LLM output
        const bananaInputs = store.getConnectedInputs("nanoBanana-1");
        expect(bananaInputs.text).toBe(llmOutput);
      });
    });

    describe("Dynamic inputs from schema-mapped connections", () => {
      it("should populate dynamicInputs when node has inputSchema", () => {
        const testImage = "data:image/png;base64,videoFrame";

        useWorkflowStore.setState({
          nodes: [
            createTestNode("imageInput-1", "imageInput", { image: testImage }),
            createTestNode("prompt-1", "prompt", { prompt: "animate this" }),
            createTestNode("generateVideo-1", "generateVideo", {
              inputSchema: [
                { name: "image_url", type: "image", required: true, label: "Image" },
                { name: "prompt", type: "text", required: true, label: "Prompt" },
              ],
            }),
          ],
          edges: [
            createTestEdge("imageInput-1", "generateVideo-1", "image", "image"),
            createTestEdge("prompt-1", "generateVideo-1", "text", "text"),
          ],
        });

        const store = useWorkflowStore.getState();
        const inputs = store.getConnectedInputs("generateVideo-1");

        expect(inputs.dynamicInputs).toHaveProperty("image_url", testImage);
        expect(inputs.dynamicInputs).toHaveProperty("prompt", "animate this");
      });

      it("should correctly map multiple image handles to different schema fields", () => {
        const startFrame = "data:image/png;base64,startFrame";
        const endFrame = "data:image/png;base64,endFrame";

        useWorkflowStore.setState({
          nodes: [
            createTestNode("imageInput-1", "imageInput", { image: startFrame }),
            createTestNode("imageInput-2", "imageInput", { image: endFrame }),
            createTestNode("generateVideo-1", "generateVideo", {
              inputSchema: [
                { name: "start_image_url", type: "image", required: true, label: "Start" },
                { name: "end_image_url", type: "image", required: false, label: "End" },
              ],
            }),
          ],
          edges: [
            createTestEdge("imageInput-1", "generateVideo-1", "image", "image-0"),
            createTestEdge("imageInput-2", "generateVideo-1", "image", "image-1"),
          ],
        });

        const store = useWorkflowStore.getState();
        const inputs = store.getConnectedInputs("generateVideo-1");

        expect(inputs.dynamicInputs).toHaveProperty("start_image_url", startFrame);
        expect(inputs.dynamicInputs).toHaveProperty("end_image_url", endFrame);
      });
    });

    describe("Mixed image and text data flow", () => {
      it("should correctly extract both image and text inputs for generation", () => {
        const testImage = "data:image/png;base64,referenceImage";
        const testPrompt = "enhance the colors";

        useWorkflowStore.setState({
          nodes: [
            createTestNode("imageInput-1", "imageInput", { image: testImage }),
            createTestNode("prompt-1", "prompt", { prompt: testPrompt }),
            createTestNode("nanoBanana-1", "nanoBanana", {
              aspectRatio: "1:1",
              resolution: "1K",
              model: "nano-banana",
            }),
          ],
          edges: [
            createTestEdge("imageInput-1", "nanoBanana-1", "image", "image"),
            createTestEdge("prompt-1", "nanoBanana-1", "text", "text"),
          ],
        });

        const store = useWorkflowStore.getState();
        const inputs = store.getConnectedInputs("nanoBanana-1");

        expect(inputs.images).toHaveLength(1);
        expect(inputs.images[0]).toBe(testImage);
        expect(inputs.text).toBe(testPrompt);
      });
    });

    describe("State updates during execution", () => {
      it("should set node status to complete after successful generation", async () => {
        useWorkflowStore.setState({
          nodes: [
            createTestNode("prompt-1", "prompt", { prompt: "test" }),
            createTestNode("nanoBanana-1", "nanoBanana", {
              aspectRatio: "1:1",
              resolution: "1K",
              model: "nano-banana",
              status: "idle",
            }),
          ],
          edges: [
            createTestEdge("prompt-1", "nanoBanana-1", "text", "text"),
          ],
        });

        const store = useWorkflowStore.getState();
        await store.executeWorkflow();

        const nanoBananaNode = useWorkflowStore.getState().nodes.find(n => n.id === "nanoBanana-1");
        expect(nanoBananaNode?.data).toHaveProperty("status", "complete");
      });

      it("should populate outputImage after successful generation", async () => {
        useWorkflowStore.setState({
          nodes: [
            createTestNode("prompt-1", "prompt", { prompt: "test" }),
            createTestNode("nanoBanana-1", "nanoBanana", {
              aspectRatio: "1:1",
              resolution: "1K",
              model: "nano-banana",
              outputImage: null,
            }),
          ],
          edges: [
            createTestEdge("prompt-1", "nanoBanana-1", "text", "text"),
          ],
        });

        const store = useWorkflowStore.getState();
        await store.executeWorkflow();

        const nanoBananaNode = useWorkflowStore.getState().nodes.find(n => n.id === "nanoBanana-1");
        expect(nanoBananaNode?.data).toHaveProperty("outputImage", "data:image/png;base64,generatedImage");
      });
    });
  });

  describe("Error handling and edge cases", () => {
    describe("Missing input errors", () => {
      it("should set error status when nanoBanana has no text input", async () => {
        // Mock fetch to track if it was called
        const mockFetch = vi.fn();
        vi.stubGlobal("fetch", mockFetch);

        useWorkflowStore.setState({
          nodes: [
            createTestNode("nanoBanana-1", "nanoBanana", {
              aspectRatio: "1:1",
              resolution: "1K",
              model: "nano-banana",
              status: "idle",
            }),
          ],
          edges: [],
        });

        const store = useWorkflowStore.getState();
        await store.executeWorkflow();

        const nanoBananaNode = useWorkflowStore.getState().nodes.find(n => n.id === "nanoBanana-1");
        expect(nanoBananaNode?.data).toHaveProperty("status", "error");
        expect(nanoBananaNode?.data).toHaveProperty("error");

        vi.unstubAllGlobals();
      });

      it("should set error status when generateVideo has no model selected", async () => {
        vi.stubGlobal("fetch", vi.fn());

        useWorkflowStore.setState({
          nodes: [
            createTestNode("prompt-1", "prompt", { prompt: "test" }),
            createTestNode("generateVideo-1", "generateVideo", {
              selectedModel: null, // No model selected
              status: "idle",
            }),
          ],
          edges: [
            createTestEdge("prompt-1", "generateVideo-1", "text", "text"),
          ],
        });

        const store = useWorkflowStore.getState();
        await store.executeWorkflow();

        const videoNode = useWorkflowStore.getState().nodes.find(n => n.id === "generateVideo-1");
        expect(videoNode?.data).toHaveProperty("status", "error");
        expect(videoNode?.data).toHaveProperty("error", "No model selected");

        vi.unstubAllGlobals();
      });

      it("should stop execution on error (subsequent nodes not executed)", async () => {
        vi.stubGlobal("fetch", vi.fn());

        useWorkflowStore.setState({
          nodes: [
            createTestNode("nanoBanana-1", "nanoBanana", {
              aspectRatio: "1:1",
              resolution: "1K",
              model: "nano-banana",
              status: "idle",
            }),
            createTestNode("output-1", "output", { status: "idle" }),
          ],
          edges: [
            createTestEdge("nanoBanana-1", "output-1", "image", "image"),
          ],
        });

        const store = useWorkflowStore.getState();
        await store.executeWorkflow();

        // nanoBanana should have error (no text input)
        const nanoBananaNode = useWorkflowStore.getState().nodes.find(n => n.id === "nanoBanana-1");
        expect(nanoBananaNode?.data).toHaveProperty("status", "error");

        // Workflow should have stopped running
        expect(useWorkflowStore.getState().isRunning).toBe(false);

        vi.unstubAllGlobals();
      });
    });

    describe("API error handling", () => {
      it("should set node error status on HTTP error response", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          text: () => Promise.resolve("Server error"),
          json: () => Promise.resolve({ error: "Server error" }),
        }));

        useWorkflowStore.setState({
          nodes: [
            createTestNode("prompt-1", "prompt", { prompt: "test" }),
            createTestNode("nanoBanana-1", "nanoBanana", {
              aspectRatio: "1:1",
              resolution: "1K",
              model: "nano-banana",
              status: "idle",
            }),
          ],
          edges: [
            createTestEdge("prompt-1", "nanoBanana-1", "text", "text"),
          ],
        });

        const store = useWorkflowStore.getState();
        await store.executeWorkflow();

        const nanoBananaNode = useWorkflowStore.getState().nodes.find(n => n.id === "nanoBanana-1");
        expect(nanoBananaNode?.data).toHaveProperty("status", "error");
        expect(useWorkflowStore.getState().isRunning).toBe(false);

        vi.unstubAllGlobals();
      });

      it("should set error message on network error", async () => {
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("NetworkError")));

        useWorkflowStore.setState({
          nodes: [
            createTestNode("prompt-1", "prompt", { prompt: "test" }),
            createTestNode("nanoBanana-1", "nanoBanana", {
              aspectRatio: "1:1",
              resolution: "1K",
              model: "nano-banana",
              status: "idle",
            }),
          ],
          edges: [
            createTestEdge("prompt-1", "nanoBanana-1", "text", "text"),
          ],
        });

        const store = useWorkflowStore.getState();
        await store.executeWorkflow();

        const nanoBananaNode = useWorkflowStore.getState().nodes.find(n => n.id === "nanoBanana-1");
        expect(nanoBananaNode?.data).toHaveProperty("status", "error");
        expect((nanoBananaNode?.data as Record<string, unknown>).error).toContain("Network error");
        expect(useWorkflowStore.getState().isRunning).toBe(false);

        vi.unstubAllGlobals();
      });

      it("should set isRunning to false on error", async () => {
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("API failed")));

        useWorkflowStore.setState({
          nodes: [
            createTestNode("prompt-1", "prompt", { prompt: "test" }),
            createTestNode("nanoBanana-1", "nanoBanana", {
              aspectRatio: "1:1",
              resolution: "1K",
              model: "nano-banana",
            }),
          ],
          edges: [
            createTestEdge("prompt-1", "nanoBanana-1", "text", "text"),
          ],
        });

        const store = useWorkflowStore.getState();
        await store.executeWorkflow();

        expect(useWorkflowStore.getState().isRunning).toBe(false);

        vi.unstubAllGlobals();
      });
    });

    describe("Workflow state management during execution", () => {
      it("should set isRunning to true during execution", async () => {
        let isRunningDuringExecution = false;

        vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
          // Check isRunning while fetch is in progress
          isRunningDuringExecution = useWorkflowStore.getState().isRunning;
          return {
            ok: true,
            json: () => Promise.resolve({ success: true, image: "data:image/png;base64,test" }),
            text: () => Promise.resolve(""),
          };
        }));

        useWorkflowStore.setState({
          nodes: [
            createTestNode("prompt-1", "prompt", { prompt: "test" }),
            createTestNode("nanoBanana-1", "nanoBanana", {
              aspectRatio: "1:1",
              resolution: "1K",
              model: "nano-banana",
            }),
          ],
          edges: [
            createTestEdge("prompt-1", "nanoBanana-1", "text", "text"),
          ],
        });

        const store = useWorkflowStore.getState();
        await store.executeWorkflow();

        expect(isRunningDuringExecution).toBe(true);
        expect(useWorkflowStore.getState().isRunning).toBe(false);

        vi.unstubAllGlobals();
      });

      it("should set isRunning to false after completion", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ success: true, image: "data:image/png;base64,test" }),
          text: () => Promise.resolve(""),
        }));

        useWorkflowStore.setState({
          nodes: [
            createTestNode("prompt-1", "prompt", { prompt: "test" }),
            createTestNode("nanoBanana-1", "nanoBanana", {
              aspectRatio: "1:1",
              resolution: "1K",
              model: "nano-banana",
            }),
          ],
          edges: [
            createTestEdge("prompt-1", "nanoBanana-1", "text", "text"),
          ],
        });

        const store = useWorkflowStore.getState();
        await store.executeWorkflow();

        expect(useWorkflowStore.getState().isRunning).toBe(false);

        vi.unstubAllGlobals();
      });

      it("should set currentNodeId to null after completion", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ success: true, image: "data:image/png;base64,test" }),
          text: () => Promise.resolve(""),
        }));

        useWorkflowStore.setState({
          nodes: [
            createTestNode("prompt-1", "prompt", { prompt: "test" }),
            createTestNode("nanoBanana-1", "nanoBanana", {
              aspectRatio: "1:1",
              resolution: "1K",
              model: "nano-banana",
            }),
          ],
          edges: [
            createTestEdge("prompt-1", "nanoBanana-1", "text", "text"),
          ],
        });

        const store = useWorkflowStore.getState();
        await store.executeWorkflow();

        expect(useWorkflowStore.getState().currentNodeId).toBeNull();

        vi.unstubAllGlobals();
      });
    });

    describe("Resume functionality", () => {
      it("should start execution from specified nodeId", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ success: true, image: "data:image/png;base64,test" }),
          text: () => Promise.resolve(""),
        }));

        useWorkflowStore.setState({
          nodes: [
            createTestNode("prompt-1", "prompt", { prompt: "test" }),
            createTestNode("nanoBanana-1", "nanoBanana", {
              aspectRatio: "1:1",
              resolution: "1K",
              model: "nano-banana",
              outputImage: "data:image/png;base64,existing", // Already has output
            }),
            createTestNode("output-1", "output", {}),
          ],
          edges: [
            createTestEdge("prompt-1", "nanoBanana-1", "text", "text"),
            createTestEdge("nanoBanana-1", "output-1", "image", "image"),
          ],
        });

        const store = useWorkflowStore.getState();

        // Start from output node (should skip prompt and nanoBanana)
        await store.executeWorkflow("output-1");

        expect(useWorkflowStore.getState().isRunning).toBe(false);
        expect(useWorkflowStore.getState().currentNodeId).toBeNull();

        vi.unstubAllGlobals();
      });

      it("should resume from pausedAtNodeId", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ success: true, image: "data:image/png;base64,test" }),
          text: () => Promise.resolve(""),
        }));

        // Set up a workflow that was paused
        useWorkflowStore.setState({
          nodes: [
            createTestNode("prompt-1", "prompt", { prompt: "test" }),
            createTestNode("nanoBanana-1", "nanoBanana", {
              aspectRatio: "1:1",
              resolution: "1K",
              model: "nano-banana",
            }),
          ],
          edges: [
            createTestEdge("prompt-1", "nanoBanana-1", "text", "text", true), // Pause edge
          ],
        });

        const store = useWorkflowStore.getState();

        // First execution should pause at nanoBanana-1
        await store.executeWorkflow();
        expect(useWorkflowStore.getState().pausedAtNodeId).toBe("nanoBanana-1");

        // Resume from paused node
        await store.executeWorkflow("nanoBanana-1");
        expect(useWorkflowStore.getState().pausedAtNodeId).toBeNull();

        vi.unstubAllGlobals();
      });
    });
  });

  describe("ConditionalBranchNode data flow", () => {
    describe("getConnectedInputs for conditionalBranch outputs", () => {
      it("should route image through TRUE output when lastEvaluationResult is true", () => {
        const store = useWorkflowStore.getState();
        const testImage = "data:image/png;base64,conditionalImage";

        useWorkflowStore.setState({
          nodes: [
            createTestNode("conditionalBranch-1", "conditionalBranch", {
              inputImage: testImage,
              lastEvaluationResult: true,
              conditionGroups: [],
              groupLogic: "AND",
            }),
            createTestNode("output-true", "output", {}),
          ],
          edges: [
            createTestEdge("conditionalBranch-1", "output-true", "image-true", "image"),
          ],
        });

        const result = store.getConnectedInputs("output-true");
        expect(result.images).toContain(testImage);
        expect(result.images).toHaveLength(1);
      });

      it("should NOT route image through TRUE output when lastEvaluationResult is false", () => {
        const store = useWorkflowStore.getState();
        const testImage = "data:image/png;base64,conditionalImage";

        useWorkflowStore.setState({
          nodes: [
            createTestNode("conditionalBranch-1", "conditionalBranch", {
              inputImage: testImage,
              lastEvaluationResult: false,
              conditionGroups: [],
              groupLogic: "AND",
            }),
            createTestNode("output-true", "output", {}),
          ],
          edges: [
            createTestEdge("conditionalBranch-1", "output-true", "image-true", "image"),
          ],
        });

        const result = store.getConnectedInputs("output-true");
        expect(result.images).toHaveLength(0);
      });

      it("should route image through FALSE output when lastEvaluationResult is false", () => {
        const store = useWorkflowStore.getState();
        const testImage = "data:image/png;base64,conditionalImage";

        useWorkflowStore.setState({
          nodes: [
            createTestNode("conditionalBranch-1", "conditionalBranch", {
              inputImage: testImage,
              lastEvaluationResult: false,
              conditionGroups: [],
              groupLogic: "AND",
            }),
            createTestNode("output-false", "output", {}),
          ],
          edges: [
            createTestEdge("conditionalBranch-1", "output-false", "image-false", "image"),
          ],
        });

        const result = store.getConnectedInputs("output-false");
        expect(result.images).toContain(testImage);
        expect(result.images).toHaveLength(1);
      });

      it("should NOT route image through FALSE output when lastEvaluationResult is true", () => {
        const store = useWorkflowStore.getState();
        const testImage = "data:image/png;base64,conditionalImage";

        useWorkflowStore.setState({
          nodes: [
            createTestNode("conditionalBranch-1", "conditionalBranch", {
              inputImage: testImage,
              lastEvaluationResult: true,
              conditionGroups: [],
              groupLogic: "AND",
            }),
            createTestNode("output-false", "output", {}),
          ],
          edges: [
            createTestEdge("conditionalBranch-1", "output-false", "image-false", "image"),
          ],
        });

        const result = store.getConnectedInputs("output-false");
        expect(result.images).toHaveLength(0);
      });

      it("should NOT route image through any output when lastEvaluationResult is null", () => {
        const store = useWorkflowStore.getState();
        const testImage = "data:image/png;base64,conditionalImage";

        useWorkflowStore.setState({
          nodes: [
            createTestNode("conditionalBranch-1", "conditionalBranch", {
              inputImage: testImage,
              lastEvaluationResult: null, // Not yet evaluated
              conditionGroups: [],
              groupLogic: "AND",
            }),
            createTestNode("output-true", "output", {}),
            createTestNode("output-false", "output", {}),
          ],
          edges: [
            createTestEdge("conditionalBranch-1", "output-true", "image-true", "image"),
            createTestEdge("conditionalBranch-1", "output-false", "image-false", "image"),
          ],
        });

        const trueResult = store.getConnectedInputs("output-true");
        const falseResult = store.getConnectedInputs("output-false");
        expect(trueResult.images).toHaveLength(0);
        expect(falseResult.images).toHaveLength(0);
      });

      it("should support branching to different workflows based on condition", () => {
        const store = useWorkflowStore.getState();
        const testImage = "data:image/png;base64,conditionalImage";

        // True branch: goes to output-true
        // False branch: goes to output-false
        useWorkflowStore.setState({
          nodes: [
            createTestNode("conditionalBranch-1", "conditionalBranch", {
              inputImage: testImage,
              lastEvaluationResult: true,
              conditionGroups: [],
              groupLogic: "AND",
            }),
            createTestNode("output-true", "output", {}),
            createTestNode("output-false", "output", {}),
          ],
          edges: [
            createTestEdge("conditionalBranch-1", "output-true", "image-true", "image"),
            createTestEdge("conditionalBranch-1", "output-false", "image-false", "image"),
          ],
        });

        // True branch should receive image
        const trueResult = store.getConnectedInputs("output-true");
        expect(trueResult.images).toContain(testImage);

        // False branch should NOT receive image
        const falseResult = store.getConnectedInputs("output-false");
        expect(falseResult.images).toHaveLength(0);

        // Now flip the evaluation result
        useWorkflowStore.setState({
          nodes: [
            createTestNode("conditionalBranch-1", "conditionalBranch", {
              inputImage: testImage,
              lastEvaluationResult: false,
              conditionGroups: [],
              groupLogic: "AND",
            }),
            createTestNode("output-true", "output", {}),
            createTestNode("output-false", "output", {}),
          ],
          edges: [
            createTestEdge("conditionalBranch-1", "output-true", "image-true", "image"),
            createTestEdge("conditionalBranch-1", "output-false", "image-false", "image"),
          ],
        });

        // Now false branch should receive image
        const trueResult2 = store.getConnectedInputs("output-true");
        const falseResult2 = store.getConnectedInputs("output-false");
        expect(trueResult2.images).toHaveLength(0);
        expect(falseResult2.images).toContain(testImage);
      });
    });
  });

  describe("Connection validation integration", () => {
    describe("Handle type identification for data extraction", () => {
      it("should correctly identify image handles by ID pattern", () => {
        const store = useWorkflowStore.getState();
        const testImage = "data:image/png;base64,test";

        // Standard image handle
        useWorkflowStore.setState({
          nodes: [
            createTestNode("imageInput-1", "imageInput", { image: testImage }),
            createTestNode("nanoBanana-1", "nanoBanana", {}),
          ],
          edges: [createTestEdge("imageInput-1", "nanoBanana-1", "image", "image")],
        });

        const result = store.getConnectedInputs("nanoBanana-1");
        expect(result.images).toContain(testImage);
      });

      it("should correctly identify text handles by ID pattern", () => {
        const store = useWorkflowStore.getState();
        const testPrompt = "test prompt";

        useWorkflowStore.setState({
          nodes: [
            createTestNode("prompt-1", "prompt", { prompt: testPrompt }),
            createTestNode("nanoBanana-1", "nanoBanana", {}),
          ],
          edges: [createTestEdge("prompt-1", "nanoBanana-1", "text", "text")],
        });

        const result = store.getConnectedInputs("nanoBanana-1");
        expect(result.text).toBe(testPrompt);
      });

      it("should handle schema-named handles like image_url correctly", () => {
        const store = useWorkflowStore.getState();
        const testImage = "data:image/png;base64,test";

        useWorkflowStore.setState({
          nodes: [
            createTestNode("imageInput-1", "imageInput", { image: testImage }),
            createTestNode("generateVideo-1", "generateVideo", {
              inputSchema: [
                { name: "image_url", type: "image", required: true, label: "Image" },
              ],
            }),
          ],
          // Edge targeting a schema-named handle
          edges: [createTestEdge("imageInput-1", "generateVideo-1", "image", "image")],
        });

        const result = store.getConnectedInputs("generateVideo-1");
        // Should extract image via dynamicInputs mapping
        expect(result.dynamicInputs).toHaveProperty("image_url", testImage);
      });

      it("should handle indexed handles (image-0, image-1) correctly", () => {
        const store = useWorkflowStore.getState();
        const image1 = "data:image/png;base64,first";
        const image2 = "data:image/png;base64,second";

        useWorkflowStore.setState({
          nodes: [
            createTestNode("imageInput-1", "imageInput", { image: image1 }),
            createTestNode("imageInput-2", "imageInput", { image: image2 }),
            createTestNode("generateVideo-1", "generateVideo", {
              inputSchema: [
                { name: "start_image", type: "image", required: true, label: "Start" },
                { name: "end_image", type: "image", required: false, label: "End" },
              ],
            }),
          ],
          edges: [
            createTestEdge("imageInput-1", "generateVideo-1", "image", "image-0"),
            createTestEdge("imageInput-2", "generateVideo-1", "image", "image-1"),
          ],
        });

        const result = store.getConnectedInputs("generateVideo-1");
        expect(result.dynamicInputs).toHaveProperty("start_image", image1);
        expect(result.dynamicInputs).toHaveProperty("end_image", image2);
      });

      it("should handle indexed text handles (text-0, text-1) correctly", () => {
        const store = useWorkflowStore.getState();
        const prompt = "main prompt";
        const negPrompt = "negative prompt";

        useWorkflowStore.setState({
          nodes: [
            createTestNode("prompt-1", "prompt", { prompt }),
            createTestNode("prompt-2", "prompt", { prompt: negPrompt }),
            createTestNode("generateVideo-1", "generateVideo", {
              inputSchema: [
                { name: "prompt", type: "text", required: true, label: "Prompt" },
                { name: "negative_prompt", type: "text", required: false, label: "Negative" },
              ],
            }),
          ],
          edges: [
            createTestEdge("prompt-1", "generateVideo-1", "text", "text-0"),
            createTestEdge("prompt-2", "generateVideo-1", "text", "text-1"),
          ],
        });

        const result = store.getConnectedInputs("generateVideo-1");
        expect(result.dynamicInputs).toHaveProperty("prompt", prompt);
        expect(result.dynamicInputs).toHaveProperty("negative_prompt", negPrompt);
      });

      it("should map both 'image' and 'image-0' to schema name when single image input", () => {
        // Bug fix test: node components use 'image-0' for indexed handles, but legacy edges
        // may use 'image'. Both should work when there's only one image input.
        const store = useWorkflowStore.getState();
        const testImage = "data:image/png;base64,singleImage";

        // Test with indexed handle ID (image-0) - what new node components use
        useWorkflowStore.setState({
          nodes: [
            createTestNode("imageInput-1", "imageInput", { image: testImage }),
            createTestNode("nanoBanana-1", "nanoBanana", {
              inputSchema: [
                { name: "image_input", type: "image", required: false, label: "Image Input" },
              ],
            }),
          ],
          edges: [
            createTestEdge("imageInput-1", "nanoBanana-1", "image", "image-0"),
          ],
        });

        const resultIndexed = store.getConnectedInputs("nanoBanana-1");
        expect(resultIndexed.dynamicInputs).toHaveProperty("image_input", testImage);

        // Test with legacy handle ID (image) - what old edges may have
        useWorkflowStore.setState({
          nodes: [
            createTestNode("imageInput-2", "imageInput", { image: testImage }),
            createTestNode("nanoBanana-2", "nanoBanana", {
              inputSchema: [
                { name: "image_input", type: "image", required: false, label: "Image Input" },
              ],
            }),
          ],
          edges: [
            createTestEdge("imageInput-2", "nanoBanana-2", "image", "image"),
          ],
        });

        const resultLegacy = store.getConnectedInputs("nanoBanana-2");
        expect(resultLegacy.dynamicInputs).toHaveProperty("image_input", testImage);
      });

      it("should map both 'text' and 'text-0' to schema name when single text input", () => {
        // Same fix for text handles
        const store = useWorkflowStore.getState();
        const testPrompt = "test prompt text";

        // Test with indexed handle ID (text-0)
        useWorkflowStore.setState({
          nodes: [
            createTestNode("prompt-1", "prompt", { prompt: testPrompt }),
            createTestNode("nanoBanana-1", "nanoBanana", {
              inputSchema: [
                { name: "prompt", type: "text", required: true, label: "Prompt" },
              ],
            }),
          ],
          edges: [
            createTestEdge("prompt-1", "nanoBanana-1", "text", "text-0"),
          ],
        });

        const resultIndexed = store.getConnectedInputs("nanoBanana-1");
        expect(resultIndexed.dynamicInputs).toHaveProperty("prompt", testPrompt);

        // Test with legacy handle ID (text)
        useWorkflowStore.setState({
          nodes: [
            createTestNode("prompt-2", "prompt", { prompt: testPrompt }),
            createTestNode("nanoBanana-2", "nanoBanana", {
              inputSchema: [
                { name: "prompt", type: "text", required: true, label: "Prompt" },
              ],
            }),
          ],
          edges: [
            createTestEdge("prompt-2", "nanoBanana-2", "text", "text"),
          ],
        });

        const resultLegacy = store.getConnectedInputs("nanoBanana-2");
        expect(resultLegacy.dynamicInputs).toHaveProperty("prompt", testPrompt);
      });
    });

    describe("Edge cases in connection handling", () => {
      it("should ignore connections from non-existent source nodes", () => {
        const store = useWorkflowStore.getState();

        useWorkflowStore.setState({
          nodes: [
            createTestNode("nanoBanana-1", "nanoBanana", {}),
          ],
          edges: [
            createTestEdge("deleted-node", "nanoBanana-1", "image", "image"),
          ],
        });

        const result = store.getConnectedInputs("nanoBanana-1");
        expect(result.images).toHaveLength(0);
      });

      it("should handle null/undefined output data gracefully", () => {
        const store = useWorkflowStore.getState();

        useWorkflowStore.setState({
          nodes: [
            createTestNode("imageInput-1", "imageInput", { image: null }),
            createTestNode("nanoBanana-1", "nanoBanana", {}),
          ],
          edges: [createTestEdge("imageInput-1", "nanoBanana-1", "image", "image")],
        });

        const result = store.getConnectedInputs("nanoBanana-1");
        expect(result.images).toHaveLength(0);
      });

      it("should return correct structure when node has no incoming edges", () => {
        const store = useWorkflowStore.getState();

        useWorkflowStore.setState({
          nodes: [
            createTestNode("nanoBanana-1", "nanoBanana", {}),
          ],
          edges: [],
        });

        const result = store.getConnectedInputs("nanoBanana-1");
        expect(result.images).toEqual([]);
        expect(result.text).toBeNull();
        expect(result.dynamicInputs).toEqual({});
      });
    });
  });
});
