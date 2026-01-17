import {
  NodeType,
  ImageInputNodeData,
  AnnotationNodeData,
  PromptNodeData,
  NanoBananaNodeData,
  GenerateVideoNodeData,
  LLMGenerateNodeData,
  SplitGridNodeData,
  OutputNodeData,
  WorkflowNodeData,
  GroupColor,
  SelectedModel,
} from "@/types";
import { loadGenerateImageDefaults, loadNodeDefaults } from "./localStorage";

/**
 * Default dimensions for each node type.
 * Used in addNode and createGroup for consistent sizing.
 */
export const defaultNodeDimensions: Record<NodeType, { width: number; height: number }> = {
  imageInput: { width: 300, height: 280 },
  annotation: { width: 300, height: 280 },
  prompt: { width: 320, height: 220 },
  nanoBanana: { width: 300, height: 300 },
  generateVideo: { width: 300, height: 300 },
  llmGenerate: { width: 320, height: 360 },
  splitGrid: { width: 300, height: 320 },
  output: { width: 320, height: 320 },
};

/**
 * Group color palette (dark mode tints).
 */
export const GROUP_COLORS: Record<GroupColor, string> = {
  neutral: "#262626",
  blue: "#1e3a5f",
  green: "#1a3d2e",
  purple: "#2d2458",
  orange: "#3d2a1a",
  red: "#3d1a1a",
};

/**
 * Order in which group colors are assigned.
 */
export const GROUP_COLOR_ORDER: GroupColor[] = [
  "neutral", "blue", "green", "purple", "orange", "red"
];

/**
 * Creates default data for a node based on its type.
 */
export const createDefaultNodeData = (type: NodeType): WorkflowNodeData => {
  switch (type) {
    case "imageInput":
      return {
        image: null,
        filename: null,
        dimensions: null,
      } as ImageInputNodeData;
    case "annotation":
      return {
        sourceImage: null,
        annotations: [],
        outputImage: null,
      } as AnnotationNodeData;
    case "prompt":
      return {
        prompt: "",
      } as PromptNodeData;
    case "nanoBanana": {
      const nodeDefaults = loadNodeDefaults();
      const legacyDefaults = loadGenerateImageDefaults();

      // Determine selectedModel: prefer new nodeDefaults, fallback to legacy
      let selectedModel: SelectedModel;
      if (nodeDefaults.generateImage?.selectedModel) {
        selectedModel = nodeDefaults.generateImage.selectedModel;
      } else {
        const modelDisplayName = legacyDefaults.model === "nano-banana" ? "Nano Banana" : "Nano Banana Pro";
        selectedModel = {
          provider: "gemini",
          modelId: legacyDefaults.model,
          displayName: modelDisplayName,
        };
      }

      // Merge settings: new nodeDefaults override legacy defaults
      const aspectRatio = nodeDefaults.generateImage?.aspectRatio ?? legacyDefaults.aspectRatio;
      const resolution = nodeDefaults.generateImage?.resolution ?? legacyDefaults.resolution;
      const useGoogleSearch = nodeDefaults.generateImage?.useGoogleSearch ?? legacyDefaults.useGoogleSearch;

      return {
        inputImages: [],
        inputPrompt: null,
        outputImage: null,
        aspectRatio,
        resolution,
        model: legacyDefaults.model, // Keep legacy model field for backward compat
        selectedModel,
        useGoogleSearch,
        status: "idle",
        error: null,
        imageHistory: [],
        selectedHistoryIndex: 0,
      } as NanoBananaNodeData;
    }
    case "generateVideo": {
      const nodeDefaults = loadNodeDefaults();
      return {
        inputImages: [],
        inputPrompt: null,
        outputVideo: null,
        selectedModel: nodeDefaults.generateVideo?.selectedModel,
        status: "idle",
        error: null,
        videoHistory: [],
        selectedVideoHistoryIndex: 0,
      } as GenerateVideoNodeData;
    }
    case "llmGenerate": {
      const nodeDefaults = loadNodeDefaults();
      const llmDefaults = nodeDefaults.llm;
      return {
        inputPrompt: null,
        inputImages: [],
        outputText: null,
        provider: llmDefaults?.provider ?? "google",
        model: llmDefaults?.model ?? "gemini-3-flash-preview",
        temperature: llmDefaults?.temperature ?? 0.7,
        maxTokens: llmDefaults?.maxTokens ?? 8192,
        status: "idle",
        error: null,
      } as LLMGenerateNodeData;
    }
    case "splitGrid":
      return {
        sourceImage: null,
        targetCount: 6,
        defaultPrompt: "",
        generateSettings: {
          aspectRatio: "1:1",
          resolution: "1K",
          model: "nano-banana-pro",
          useGoogleSearch: false,
        },
        childNodeIds: [],
        gridRows: 2,
        gridCols: 3,
        isConfigured: false,
        status: "idle",
        error: null,
      } as SplitGridNodeData;
    case "output":
      return {
        image: null,
      } as OutputNodeData;
  }
};
