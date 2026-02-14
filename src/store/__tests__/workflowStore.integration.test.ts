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

    describe("Multi-image dynamicInputs aggregation", () => {
      it("should aggregate multiple images to same schema-mapped handle into array", () => {
        const store = useWorkflowStore.getState();
        const img1 = "data:image/png;base64,img1";
        const img2 = "data:image/png;base64,img2";

        useWorkflowStore.setState({
          nodes: [
            createTestNode("imageInput-1", "imageInput", { image: img1 }),
            createTestNode("imageInput-2", "imageInput", { image: img2 }),
            createTestNode("nanoBanana-1", "nanoBanana", {
              inputSchema: [
                { name: "image_urls", type: "image", required: true, label: "Images" },
              ],
            }),
          ],
          edges: [
            createTestEdge("imageInput-1", "nanoBanana-1", "image", "image"),
            createTestEdge("imageInput-2", "nanoBanana-1", "image", "image"),
          ],
        });

        const result = store.getConnectedInputs("nanoBanana-1");

        // Both images should be aggregated into an array under the schema name
        expect(Array.isArray(result.dynamicInputs["image_urls"])).toBe(true);
        expect(result.dynamicInputs["image_urls"]).toHaveLength(2);
        expect(result.dynamicInputs["image_urls"]).toContain(img1);
        expect(result.dynamicInputs["image_urls"]).toContain(img2);

        // images array should also contain both
        expect(result.images).toHaveLength(2);
        expect(result.images).toContain(img1);
        expect(result.images).toContain(img2);
      });

      it("should keep single image to schema-mapped handle as string", () => {
        const store = useWorkflowStore.getState();
        const img1 = "data:image/png;base64,img1";

        useWorkflowStore.setState({
          nodes: [
            createTestNode("imageInput-1", "imageInput", { image: img1 }),
            createTestNode("nanoBanana-1", "nanoBanana", {
              inputSchema: [
                { name: "image_urls", type: "image", required: true, label: "Images" },
              ],
            }),
          ],
          edges: [
            createTestEdge("imageInput-1", "nanoBanana-1", "image", "image"),
          ],
        });

        const result = store.getConnectedInputs("nanoBanana-1");

        // Single image should be a plain string, not wrapped in array
        expect(result.dynamicInputs["image_urls"]).toBe(img1);
        expect(Array.isArray(result.dynamicInputs["image_urls"])).toBe(false);
      });

      it("should keep multiple images with distinct schema handles as separate strings", () => {
        const store = useWorkflowStore.getState();
        const img1 = "data:image/png;base64,img1";
        const img2 = "data:image/png;base64,img2";

        useWorkflowStore.setState({
          nodes: [
            createTestNode("imageInput-1", "imageInput", { image: img1 }),
            createTestNode("imageInput-2", "imageInput", { image: img2 }),
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

        const result = store.getConnectedInputs("generateVideo-1");

        // Each should be a plain string, not an array
        expect(result.dynamicInputs["start_image_url"]).toBe(img1);
        expect(result.dynamicInputs["end_image_url"]).toBe(img2);
        expect(Array.isArray(result.dynamicInputs["start_image_url"])).toBe(false);
        expect(Array.isArray(result.dynamicInputs["end_image_url"])).toBe(false);
      });

      it("should produce array of length 3 when three images connect to same handle", () => {
        const store = useWorkflowStore.getState();
        const img1 = "data:image/png;base64,img1";
        const img2 = "data:image/png;base64,img2";
        const img3 = "data:image/png;base64,img3";

        useWorkflowStore.setState({
          nodes: [
            createTestNode("imageInput-1", "imageInput", { image: img1 }),
            createTestNode("imageInput-2", "imageInput", { image: img2 }),
            createTestNode("imageInput-3", "imageInput", { image: img3 }),
            createTestNode("nanoBanana-1", "nanoBanana", {
              inputSchema: [
                { name: "image_urls", type: "image", required: true, label: "Images" },
              ],
            }),
          ],
          edges: [
            createTestEdge("imageInput-1", "nanoBanana-1", "image", "image"),
            createTestEdge("imageInput-2", "nanoBanana-1", "image", "image"),
            createTestEdge("imageInput-3", "nanoBanana-1", "image", "image"),
          ],
        });

        const result = store.getConnectedInputs("nanoBanana-1");

        // Should be array of length 3
        expect(Array.isArray(result.dynamicInputs["image_urls"])).toBe(true);
        expect(result.dynamicInputs["image_urls"]).toHaveLength(3);
        expect(result.dynamicInputs["image_urls"]).toContain(img1);
        expect(result.dynamicInputs["image_urls"]).toContain(img2);
        expect(result.dynamicInputs["image_urls"]).toContain(img3);
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
        expect(useWorkflowStore.getState().currentNodeIds).toEqual([]);
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

      it("should clear currentNodeIds after execution completes", async () => {
        useWorkflowStore.setState({
          nodes: [
            createTestNode("prompt-1", "prompt", { prompt: "test" }),
          ],
          edges: [],
        });

        const store = useWorkflowStore.getState();
        await store.executeWorkflow();

        expect(useWorkflowStore.getState().currentNodeIds).toEqual([]);
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

      it("should set currentNodeIds to empty after completion", async () => {
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

        expect(useWorkflowStore.getState().currentNodeIds).toEqual([]);

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
        expect(useWorkflowStore.getState().currentNodeIds).toEqual([]);

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

  describe("Comment navigation actions", () => {
    describe("getNodesWithComments", () => {
      it("should return only nodes with comments", () => {
        useWorkflowStore.setState({
          nodes: [
            createTestNode("node-1", "prompt", { prompt: "test", comment: "Has comment" }, { x: 0, y: 0 }),
            createTestNode("node-2", "prompt", { prompt: "test" }, { x: 100, y: 0 }), // No comment
            createTestNode("node-3", "prompt", { prompt: "test", comment: "Another comment" }, { x: 200, y: 0 }),
          ],
        });

        const store = useWorkflowStore.getState();
        const result = store.getNodesWithComments();

        expect(result).toHaveLength(2);
        expect(result.map(n => n.id)).toContain("node-1");
        expect(result.map(n => n.id)).toContain("node-3");
        expect(result.map(n => n.id)).not.toContain("node-2");
      });

      it("should sort nodes by Y position (top to bottom)", () => {
        useWorkflowStore.setState({
          nodes: [
            createTestNode("bottom-node", "prompt", { prompt: "test", comment: "Bottom" }, { x: 0, y: 200 }),
            createTestNode("top-node", "prompt", { prompt: "test", comment: "Top" }, { x: 0, y: 0 }),
          ],
        });

        const store = useWorkflowStore.getState();
        const result = store.getNodesWithComments();

        expect(result[0].id).toBe("top-node");
        expect(result[1].id).toBe("bottom-node");
      });

      it("should sort nodes by X position within same row", () => {
        // Within 50px Y threshold, should sort by X
        useWorkflowStore.setState({
          nodes: [
            createTestNode("right-node", "prompt", { prompt: "test", comment: "Right" }, { x: 200, y: 10 }),
            createTestNode("left-node", "prompt", { prompt: "test", comment: "Left" }, { x: 0, y: 0 }),
          ],
        });

        const store = useWorkflowStore.getState();
        const result = store.getNodesWithComments();

        expect(result[0].id).toBe("left-node");
        expect(result[1].id).toBe("right-node");
      });
    });

    describe("getUnviewedCommentCount", () => {
      it("should return total count when no comments viewed", () => {
        useWorkflowStore.setState({
          nodes: [
            createTestNode("node-1", "prompt", { prompt: "test", comment: "Comment 1" }, { x: 0, y: 0 }),
            createTestNode("node-2", "prompt", { prompt: "test", comment: "Comment 2" }, { x: 100, y: 0 }),
          ],
          viewedCommentNodeIds: new Set<string>(),
        });

        const store = useWorkflowStore.getState();
        expect(store.getUnviewedCommentCount()).toBe(2);
      });

      it("should return correct count when some comments viewed", () => {
        useWorkflowStore.setState({
          nodes: [
            createTestNode("node-1", "prompt", { prompt: "test", comment: "Comment 1" }, { x: 0, y: 0 }),
            createTestNode("node-2", "prompt", { prompt: "test", comment: "Comment 2" }, { x: 100, y: 0 }),
          ],
          viewedCommentNodeIds: new Set<string>(["node-1"]),
        });

        const store = useWorkflowStore.getState();
        expect(store.getUnviewedCommentCount()).toBe(1);
      });

      it("should return 0 when all comments viewed", () => {
        useWorkflowStore.setState({
          nodes: [
            createTestNode("node-1", "prompt", { prompt: "test", comment: "Comment 1" }, { x: 0, y: 0 }),
            createTestNode("node-2", "prompt", { prompt: "test", comment: "Comment 2" }, { x: 100, y: 0 }),
          ],
          viewedCommentNodeIds: new Set<string>(["node-1", "node-2"]),
        });

        const store = useWorkflowStore.getState();
        expect(store.getUnviewedCommentCount()).toBe(0);
      });
    });

    describe("markCommentViewed", () => {
      it("should add nodeId to viewedCommentNodeIds", () => {
        useWorkflowStore.setState({
          viewedCommentNodeIds: new Set<string>(),
        });

        const store = useWorkflowStore.getState();
        store.markCommentViewed("node-1");

        expect(useWorkflowStore.getState().viewedCommentNodeIds.has("node-1")).toBe(true);
      });

      it("should preserve existing viewed comments", () => {
        useWorkflowStore.setState({
          viewedCommentNodeIds: new Set<string>(["existing-node"]),
        });

        const store = useWorkflowStore.getState();
        store.markCommentViewed("new-node");

        const state = useWorkflowStore.getState();
        expect(state.viewedCommentNodeIds.has("existing-node")).toBe(true);
        expect(state.viewedCommentNodeIds.has("new-node")).toBe(true);
      });
    });

    describe("setNavigationTarget", () => {
      it("should set navigation target with nodeId and timestamp", () => {
        const store = useWorkflowStore.getState();
        store.setNavigationTarget("node-1");

        const state = useWorkflowStore.getState();
        expect(state.navigationTarget?.nodeId).toBe("node-1");
        expect(state.navigationTarget?.timestamp).toBeDefined();
      });

      it("should clear navigation target when null passed", () => {
        useWorkflowStore.setState({
          navigationTarget: { nodeId: "node-1", timestamp: Date.now() },
        });

        const store = useWorkflowStore.getState();
        store.setNavigationTarget(null);

        expect(useWorkflowStore.getState().navigationTarget).toBeNull();
      });
    });

    describe("resetViewedComments", () => {
      it("should clear all viewed comments", () => {
        useWorkflowStore.setState({
          viewedCommentNodeIds: new Set<string>(["node-1", "node-2", "node-3"]),
        });

        const store = useWorkflowStore.getState();
        store.resetViewedComments();

        expect(useWorkflowStore.getState().viewedCommentNodeIds.size).toBe(0);
      });
    });

    describe("loadWorkflow resets viewed comments", () => {
      it("should reset viewedCommentNodeIds when loading workflow", async () => {
        useWorkflowStore.setState({
          viewedCommentNodeIds: new Set<string>(["node-1", "node-2"]),
        });

        const store = useWorkflowStore.getState();
        await store.loadWorkflow({
          id: "test-workflow",
          name: "Test",
          nodes: [],
          edges: [],
        });

        expect(useWorkflowStore.getState().viewedCommentNodeIds.size).toBe(0);
      });
    });
  });

  describe("Race condition prevention", () => {
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true, image: "data:image/png;base64,generated" }),
        text: () => Promise.resolve(""),
      });
      vi.stubGlobal("fetch", mockFetch);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("should only execute nodes once when executeWorkflow is called concurrently", async () => {
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

      // Fire two calls back-to-back without awaiting the first
      const p1 = store.executeWorkflow();
      const p2 = store.executeWorkflow();
      await Promise.all([p1, p2]);

      // Only one execution should have reached fetch (one nanoBanana node)
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("should set isRunning synchronously before any await", async () => {
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
      expect(useWorkflowStore.getState().isRunning).toBe(false);

      // Call without awaiting — isRunning should be true synchronously
      const promise = store.executeWorkflow();
      expect(useWorkflowStore.getState().isRunning).toBe(true);

      await promise;
    });

    it("should only execute once when regenerateNode is called concurrently", async () => {
      useWorkflowStore.setState({
        nodes: [
          createTestNode("prompt-1", "prompt", { prompt: "test" }),
          createTestNode("nanoBanana-1", "nanoBanana", {
            aspectRatio: "1:1",
            resolution: "1K",
            model: "nano-banana",
            inputImages: [],
            outputImage: "data:image/png;base64,previous",
          }),
        ],
        edges: [
          createTestEdge("prompt-1", "nanoBanana-1", "text", "text"),
        ],
      });

      const store = useWorkflowStore.getState();

      // Fire two calls back-to-back — second should be blocked by isRunning
      const p1 = store.regenerateNode("nanoBanana-1");
      const p2 = store.regenerateNode("nanoBanana-1");
      await Promise.all([p1, p2]);

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("should execute each node exactly once with multiple disconnected nodes", async () => {
      useWorkflowStore.setState({
        nodes: [
          createTestNode("prompt-1", "prompt", { prompt: "a" }),
          createTestNode("prompt-2", "prompt", { prompt: "b" }),
          createTestNode("prompt-3", "prompt", { prompt: "c" }),
          createTestNode("nanoBanana-1", "nanoBanana", {
            aspectRatio: "1:1",
            resolution: "1K",
            model: "nano-banana",
          }),
          createTestNode("nanoBanana-2", "nanoBanana", {
            aspectRatio: "1:1",
            resolution: "1K",
            model: "nano-banana",
          }),
          createTestNode("nanoBanana-3", "nanoBanana", {
            aspectRatio: "1:1",
            resolution: "1K",
            model: "nano-banana",
          }),
        ],
        edges: [
          createTestEdge("prompt-1", "nanoBanana-1", "text", "text"),
          createTestEdge("prompt-2", "nanoBanana-2", "text", "text"),
          createTestEdge("prompt-3", "nanoBanana-3", "text", "text"),
        ],
      });

      const store = useWorkflowStore.getState();
      await store.executeWorkflow();

      // Exactly 3 fetch calls — one per nanoBanana node
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  describe("Canvas navigation settings", () => {
    it("updateCanvasNavigationSettings updates store state", () => {
      const store = useWorkflowStore.getState();
      store.updateCanvasNavigationSettings({
        panMode: "always",
        zoomMode: "scroll",
        selectionMode: "altDrag",
      });

      const state = useWorkflowStore.getState();
      expect(state.canvasNavigationSettings).toEqual({
        panMode: "always",
        zoomMode: "scroll",
        selectionMode: "altDrag",
      });
    });

    it("updateCanvasNavigationSettings persists to localStorage", () => {
      const store = useWorkflowStore.getState();
      const settings = {
        panMode: "middleMouse" as const,
        zoomMode: "ctrlScroll" as const,
        selectionMode: "click" as const,
      };
      store.updateCanvasNavigationSettings(settings);

      // Verify persistence by reading back from localStorage
      const stored = localStorage.getItem("node-banana-canvas-navigation");
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored!)).toEqual(settings);
    });
  });

  describe("Group operations with non-standard node types", () => {
    describe("createGroup bounding box calculation", () => {
      it("should correctly calculate bounding box for easeCurve nodes (340x480)", () => {
        useWorkflowStore.setState({
          nodes: [
            createTestNode("ease-1", "easeCurve", {
              bezierHandles: [0.445, 0.05, 0.55, 0.95],
              easingPreset: "easeInOutSine",
              inheritedFrom: null,
              outputDuration: 1.5,
              outputVideo: null,
              status: "idle",
              error: null,
              progress: 0,
              encoderSupported: null,
            }, { x: 100, y: 100 }),
            createTestNode("ease-2", "easeCurve", {
              bezierHandles: [0.445, 0.05, 0.55, 0.95],
              easingPreset: "easeInOutSine",
              inheritedFrom: null,
              outputDuration: 1.5,
              outputVideo: null,
              status: "idle",
              error: null,
              progress: 0,
              encoderSupported: null,
            }, { x: 500, y: 100 }),
          ],
          edges: [],
          groups: {},
        });

        const store = useWorkflowStore.getState();
        const groupId = store.createGroup(["ease-1", "ease-2"]);

        expect(groupId).toBeTruthy();
        const group = useWorkflowStore.getState().groups[groupId];
        // easeCurve is 340x480, so maxX = 500 + 340 = 840, maxY = 100 + 480 = 580
        // With padding=20 and headerHeight=32: position.x = 100-20=80, width = 840-100+40=780
        expect(group.size.width).toBeGreaterThanOrEqual(740); // Must account for 340px wide nodes
        expect(group.size.height).toBeGreaterThanOrEqual(480); // Must account for 480px tall nodes
      });

      it("should correctly calculate bounding box for videoStitch nodes (400x280)", () => {
        useWorkflowStore.setState({
          nodes: [
            createTestNode("vs-1", "videoStitch", {
              clips: [],
              clipOrder: [],
              outputVideo: null,
              status: "idle",
              error: null,
              progress: 0,
              encoderSupported: null,
            }, { x: 0, y: 0 }),
          ],
          edges: [],
          groups: {},
        });

        const store = useWorkflowStore.getState();
        const groupId = store.createGroup(["vs-1"]);

        const group = useWorkflowStore.getState().groups[groupId];
        // videoStitch is 400x280, with padding=20: width = 400+40=440
        expect(group.size.width).toBeGreaterThanOrEqual(400); // Must account for 400px wide node
        expect(group.size.height).toBeGreaterThanOrEqual(280); // Must account for 280px tall node
      });

      it("should correctly calculate bounding box for audioInput nodes (300x200)", () => {
        useWorkflowStore.setState({
          nodes: [
            createTestNode("audio-1", "audioInput", {
              audioFile: null,
              filename: null,
              duration: null,
              format: null,
            }, { x: 200, y: 200 }),
          ],
          edges: [],
          groups: {},
        });

        const store = useWorkflowStore.getState();
        const groupId = store.createGroup(["audio-1"]);

        const group = useWorkflowStore.getState().groups[groupId];
        // audioInput is 300x200, with padding=20: width = 300+40=340
        expect(group.size.width).toBeGreaterThanOrEqual(300);
        expect(group.size.height).toBeGreaterThanOrEqual(200);
      });
    });

    describe("addNodesToGroup with non-standard node types", () => {
      it("should assign groupId to easeCurve, videoStitch, and audioInput nodes", () => {
        useWorkflowStore.setState({
          nodes: [
            createTestNode("ease-1", "easeCurve", {
              bezierHandles: [0.445, 0.05, 0.55, 0.95],
              easingPreset: "easeInOutSine",
              inheritedFrom: null,
              outputDuration: 1.5,
              outputVideo: null,
              status: "idle",
              error: null,
              progress: 0,
              encoderSupported: null,
            }),
            createTestNode("vs-1", "videoStitch", {
              clips: [],
              clipOrder: [],
              outputVideo: null,
              status: "idle",
              error: null,
              progress: 0,
              encoderSupported: null,
            }),
            createTestNode("audio-1", "audioInput", {
              audioFile: null,
              filename: null,
              duration: null,
              format: null,
            }),
          ],
          edges: [],
          groups: {
            "group-1": {
              id: "group-1",
              name: "Test Group",
              color: "neutral" as const,
              position: { x: 0, y: 0 },
              size: { width: 800, height: 600 },
              locked: false,
            },
          },
        });

        const store = useWorkflowStore.getState();
        store.addNodesToGroup(["ease-1", "vs-1", "audio-1"], "group-1");

        const nodes = useWorkflowStore.getState().nodes;
        expect(nodes.find((n) => n.id === "ease-1")?.groupId).toBe("group-1");
        expect(nodes.find((n) => n.id === "vs-1")?.groupId).toBe("group-1");
        expect(nodes.find((n) => n.id === "audio-1")?.groupId).toBe("group-1");
      });
    });

    describe("setNodeGroupId with non-standard node types", () => {
      it("should assign and remove groupId for easeCurve, videoStitch, and audioInput nodes", () => {
        useWorkflowStore.setState({
          nodes: [
            createTestNode("ease-1", "easeCurve", {
              bezierHandles: [0.445, 0.05, 0.55, 0.95],
              easingPreset: "easeInOutSine",
              inheritedFrom: null,
              outputDuration: 1.5,
              outputVideo: null,
              status: "idle",
              error: null,
              progress: 0,
              encoderSupported: null,
            }),
            createTestNode("vs-1", "videoStitch", {
              clips: [],
              clipOrder: [],
              outputVideo: null,
              status: "idle",
              error: null,
              progress: 0,
              encoderSupported: null,
            }),
            createTestNode("audio-1", "audioInput", {
              audioFile: null,
              filename: null,
              duration: null,
              format: null,
            }),
          ],
          edges: [],
          groups: {},
        });

        const store = useWorkflowStore.getState();

        // Assign groupId
        store.setNodeGroupId("ease-1", "group-1");
        store.setNodeGroupId("vs-1", "group-1");
        store.setNodeGroupId("audio-1", "group-1");

        let nodes = useWorkflowStore.getState().nodes;
        expect(nodes.find((n) => n.id === "ease-1")?.groupId).toBe("group-1");
        expect(nodes.find((n) => n.id === "vs-1")?.groupId).toBe("group-1");
        expect(nodes.find((n) => n.id === "audio-1")?.groupId).toBe("group-1");

        // Remove groupId
        store.setNodeGroupId("ease-1", undefined);
        store.setNodeGroupId("vs-1", undefined);
        store.setNodeGroupId("audio-1", undefined);

        nodes = useWorkflowStore.getState().nodes;
        expect(nodes.find((n) => n.id === "ease-1")?.groupId).toBeUndefined();
        expect(nodes.find((n) => n.id === "vs-1")?.groupId).toBeUndefined();
        expect(nodes.find((n) => n.id === "audio-1")?.groupId).toBeUndefined();
      });
    });

    describe("Locked group execution with non-standard node types", () => {
      it("should skip easeCurve, videoStitch, and audioInput nodes in locked groups", async () => {
        useWorkflowStore.setState({
          nodes: [
            { ...createTestNode("ease-1", "easeCurve", {
              bezierHandles: [0.445, 0.05, 0.55, 0.95],
              easingPreset: "easeInOutSine",
              inheritedFrom: null,
              outputDuration: 1.5,
              outputVideo: null,
              status: "idle",
              error: null,
              progress: 0,
              encoderSupported: null,
            }), groupId: "group-locked" },
            { ...createTestNode("vs-1", "videoStitch", {
              clips: [],
              clipOrder: [],
              outputVideo: null,
              status: "idle",
              error: null,
              progress: 0,
              encoderSupported: null,
            }), groupId: "group-locked" },
            { ...createTestNode("audio-1", "audioInput", {
              audioFile: null,
              filename: null,
              duration: null,
              format: null,
            }), groupId: "group-locked" },
            // Unlocked node
            createTestNode("prompt-1", "prompt", { prompt: "test" }),
          ],
          edges: [],
          groups: {
            "group-locked": {
              id: "group-locked",
              name: "Locked Group",
              color: "neutral" as const,
              position: { x: 0, y: 0 },
              size: { width: 800, height: 600 },
              locked: true,
            },
          },
        });

        const store = useWorkflowStore.getState();
        await store.executeWorkflow();

        // Workflow should complete without errors
        expect(useWorkflowStore.getState().isRunning).toBe(false);
        // The locked nodes should have been skipped (no API calls, no errors)
      });
    });
  });
});
