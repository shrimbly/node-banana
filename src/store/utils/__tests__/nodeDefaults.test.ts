import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createDefaultNodeData,
  defaultNodeDimensions,
  GROUP_COLORS,
  GROUP_COLOR_ORDER,
} from "../nodeDefaults";

// Mock localStorage for loadGenerateImageDefaults
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
  writable: true,
});

describe("nodeDefaults utilities", () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  describe("defaultNodeDimensions", () => {
    it("has all expected node types", () => {
      const expectedTypes = [
        "imageInput",
        "annotation",
        "prompt",
        "nanoBanana",
        "generateVideo",
        "llmGenerate",
        "splitGrid",
        "output",
      ];

      expectedTypes.forEach((type) => {
        expect(defaultNodeDimensions[type as keyof typeof defaultNodeDimensions]).toBeDefined();
      });
    });

    it("has width and height for each node type", () => {
      Object.values(defaultNodeDimensions).forEach((dims) => {
        expect(dims).toHaveProperty("width");
        expect(dims).toHaveProperty("height");
        expect(typeof dims.width).toBe("number");
        expect(typeof dims.height).toBe("number");
        expect(dims.width).toBeGreaterThan(0);
        expect(dims.height).toBeGreaterThan(0);
      });
    });
  });

  describe("GROUP_COLORS", () => {
    it("has all expected color keys", () => {
      const expectedColors = ["neutral", "blue", "green", "purple", "orange", "red"];

      expectedColors.forEach((color) => {
        expect(GROUP_COLORS[color as keyof typeof GROUP_COLORS]).toBeDefined();
      });
    });

    it("has valid hex color values", () => {
      Object.values(GROUP_COLORS).forEach((color) => {
        expect(color).toMatch(/^#[0-9a-fA-F]{6}$/);
      });
    });
  });

  describe("GROUP_COLOR_ORDER", () => {
    it("has all colors from GROUP_COLORS", () => {
      GROUP_COLOR_ORDER.forEach((color) => {
        expect(GROUP_COLORS[color]).toBeDefined();
      });
    });

    it("has same length as GROUP_COLORS", () => {
      expect(GROUP_COLOR_ORDER.length).toBe(Object.keys(GROUP_COLORS).length);
    });

    it("starts with neutral", () => {
      expect(GROUP_COLOR_ORDER[0]).toBe("neutral");
    });
  });

  describe("createDefaultNodeData", () => {
    it("creates correct structure for imageInput", () => {
      const data = createDefaultNodeData("imageInput");

      expect(data).toHaveProperty("image", null);
      expect(data).toHaveProperty("filename", null);
      expect(data).toHaveProperty("dimensions", null);
    });

    it("creates correct structure for annotation", () => {
      const data = createDefaultNodeData("annotation");

      expect(data).toHaveProperty("sourceImage", null);
      expect(data).toHaveProperty("annotations");
      expect(Array.isArray((data as any).annotations)).toBe(true);
      expect(data).toHaveProperty("outputImage", null);
    });

    it("creates correct structure for prompt", () => {
      const data = createDefaultNodeData("prompt");

      expect(data).toHaveProperty("prompt", "");
    });

    it("creates correct structure for nanoBanana", () => {
      const data = createDefaultNodeData("nanoBanana");

      expect(data).toHaveProperty("inputImages");
      expect(data).toHaveProperty("inputPrompt", null);
      expect(data).toHaveProperty("outputImage", null);
      expect(data).toHaveProperty("aspectRatio");
      expect(data).toHaveProperty("resolution");
      expect(data).toHaveProperty("model");
      expect(data).toHaveProperty("selectedModel");
      expect(data).toHaveProperty("useGoogleSearch");
      expect(data).toHaveProperty("status", "idle");
      expect(data).toHaveProperty("error", null);
      expect(data).toHaveProperty("imageHistory");
      expect(data).toHaveProperty("selectedHistoryIndex", 0);
    });

    it("creates correct structure for generateVideo", () => {
      const data = createDefaultNodeData("generateVideo");

      expect(data).toHaveProperty("inputImages");
      expect(data).toHaveProperty("inputPrompt", null);
      expect(data).toHaveProperty("outputVideo", null);
      expect(data).toHaveProperty("selectedModel");
      expect(data).toHaveProperty("status", "idle");
      expect(data).toHaveProperty("error", null);
      expect(data).toHaveProperty("videoHistory");
      expect(data).toHaveProperty("selectedVideoHistoryIndex", 0);
    });

    it("creates correct structure for llmGenerate", () => {
      const data = createDefaultNodeData("llmGenerate");

      expect(data).toHaveProperty("inputPrompt", null);
      expect(data).toHaveProperty("inputImages");
      expect(data).toHaveProperty("outputText", null);
      expect(data).toHaveProperty("provider", "google");
      expect(data).toHaveProperty("model");
      expect(data).toHaveProperty("temperature");
      expect(data).toHaveProperty("maxTokens");
      expect(data).toHaveProperty("status", "idle");
      expect(data).toHaveProperty("error", null);
    });

    it("creates correct structure for splitGrid", () => {
      const data = createDefaultNodeData("splitGrid");

      expect(data).toHaveProperty("sourceImage", null);
      expect(data).toHaveProperty("targetCount", 6);
      expect(data).toHaveProperty("defaultPrompt", "");
      expect(data).toHaveProperty("generateSettings");
      expect(data).toHaveProperty("childNodeIds");
      expect(data).toHaveProperty("gridRows", 2);
      expect(data).toHaveProperty("gridCols", 3);
      expect(data).toHaveProperty("isConfigured", false);
      expect(data).toHaveProperty("status", "idle");
      expect(data).toHaveProperty("error", null);
    });

    it("creates correct structure for output", () => {
      const data = createDefaultNodeData("output");

      expect(data).toHaveProperty("image", null);
    });

    it("creates correct structure for conditionalBranch", () => {
      const data = createDefaultNodeData("conditionalBranch");

      // Core properties
      expect(data).toHaveProperty("inputImage", null);
      expect(data).toHaveProperty("groupLogic", "AND");
      expect(data).toHaveProperty("lastEvaluationResult", null);
      expect(data).toHaveProperty("analysisResults", null);
      expect(data).toHaveProperty("status", "idle");
      expect(data).toHaveProperty("error", null);

      // Condition groups structure
      expect(data).toHaveProperty("conditionGroups");
      expect(Array.isArray((data as any).conditionGroups)).toBe(true);
      expect((data as any).conditionGroups.length).toBe(1);

      // First condition group structure
      const firstGroup = (data as any).conditionGroups[0];
      expect(firstGroup).toHaveProperty("id");
      expect(firstGroup).toHaveProperty("logic", "AND");
      expect(firstGroup).toHaveProperty("conditions");
      expect(Array.isArray(firstGroup.conditions)).toBe(true);
      expect(firstGroup.conditions.length).toBe(1);

      // First condition structure
      const firstCondition = firstGroup.conditions[0];
      expect(firstCondition).toHaveProperty("id");
      expect(firstCondition).toHaveProperty("property", "width");
      expect(firstCondition).toHaveProperty("operator", "greater_than");
      expect(firstCondition).toHaveProperty("value", 512);
    });

    it("uses stored defaults for nanoBanana when available", () => {
      const customSettings = {
        aspectRatio: "16:9",
        resolution: "2K",
        model: "nano-banana",
        useGoogleSearch: true,
      };
      localStorageMock.setItem(
        "node-banana-nanoBanana-defaults",
        JSON.stringify(customSettings)
      );

      const data = createDefaultNodeData("nanoBanana");

      expect((data as any).aspectRatio).toBe("16:9");
      expect((data as any).resolution).toBe("2K");
      expect((data as any).model).toBe("nano-banana");
      expect((data as any).useGoogleSearch).toBe(true);
    });
  });
});
