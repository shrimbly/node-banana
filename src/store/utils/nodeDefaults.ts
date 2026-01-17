import {
  NodeType,
  ImageInputNodeData,
  AnnotationNodeData,
  PromptNodeData,
  NanoBananaNodeData,
  GenerateVideoNodeData,
  LLMGenerateNodeData,
  SplitGridNodeData,
  MaskInpaintNodeData,
  ImageCompareNodeData,
  ImageFilterNodeData,
  ColorPaletteNodeData,
  LoopNodeData,
  BatchVariationsNodeData,
  ConditionalBranchNodeData,
  OutputNodeData,
  WorkflowNodeData,
  GroupColor,
  SelectedModel,
} from "@/types";
import { loadGenerateImageDefaults } from "./localStorage";

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
  imageCompare: { width: 400, height: 350 },
  maskInpaint: { width: 320, height: 380 },
  imageFilter: { width: 320, height: 420 },
  colorPalette: { width: 300, height: 280 },
  loop: { width: 340, height: 400 },
  batchVariations: { width: 400, height: 480 },
  conditionalBranch: { width: 360, height: 420 },
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
      const defaults = loadGenerateImageDefaults();
      const modelDisplayName = defaults.model === "nano-banana" ? "Nano Banana" : "Nano Banana Pro";
      const defaultSelectedModel: SelectedModel = {
        provider: "gemini",
        modelId: defaults.model,
        displayName: modelDisplayName,
      };
      return {
        inputImages: [],
        inputPrompt: null,
        outputImage: null,
        aspectRatio: defaults.aspectRatio,
        resolution: defaults.resolution,
        model: defaults.model,
        selectedModel: defaultSelectedModel,
        useGoogleSearch: defaults.useGoogleSearch,
        status: "idle",
        error: null,
        imageHistory: [],
        selectedHistoryIndex: 0,
      } as NanoBananaNodeData;
    }
    case "generateVideo":
      return {
        inputImages: [],
        inputPrompt: null,
        outputVideo: null,
        selectedModel: undefined,
        status: "idle",
        error: null,
        videoHistory: [],
        selectedVideoHistoryIndex: 0,
      } as GenerateVideoNodeData;
    case "llmGenerate":
      return {
        inputPrompt: null,
        inputImages: [],
        outputText: null,
        provider: "google",
        model: "gemini-3-flash-preview",
        temperature: 0.7,
        maxTokens: 8192,
        status: "idle",
        error: null,
      } as LLMGenerateNodeData;
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
    case "imageCompare":
      return {
        imageA: null,
        imageB: null,
        sliderPosition: 50,
        zoomLevel: 1,
        panPosition: { x: 0, y: 0 },
        syncZoom: true,
      } as ImageCompareNodeData;
    case "maskInpaint":
      return {
        sourceImage: null,
        maskStrokes: [],
        maskImage: null,
        outputImage: null,
        inputPrompt: null,
        brushSize: 30,
        maskFeather: 5,
        maskExpansion: 0,
        status: "idle",
        error: null,
        imageHistory: [],
        selectedHistoryIndex: 0,
      } as MaskInpaintNodeData;
    case "imageFilter":
      return {
        sourceImage: null,
        outputImage: null,
        filterSettings: {
          brightness: 0,
          contrast: 0,
          saturation: 0,
          hueRotate: 0,
          blur: 0,
          sharpen: 0,
          opacity: 100,
          invert: 0,
          grayscale: 0,
        },
        activePreset: "none",
        status: "idle",
        error: null,
      } as ImageFilterNodeData;
    case "colorPalette":
      return {
        sourceImage: null,
        targetImage: null,
        outputImage: null,
        extractedPalette: [],
        colorCount: 8,
        mode: "extract",
        mappingMethod: "closest",
        status: "idle",
        error: null,
      } as ColorPaletteNodeData;
    case "loop":
      return {
        iterationCount: 3,
        loopMode: "count",
        inputImages: [],
        inputText: null,
        currentIteration: 0,
        isLooping: false,
        iterationResults: [],
        currentImage: null,
        currentText: null,
        galleryImages: [],
        selectedGalleryIndex: 0,
        status: "idle",
        error: null,
      } as LoopNodeData;
    case "batchVariations": {
      const defaults = loadGenerateImageDefaults();
      return {
        inputImage: null,
        inputPrompt: null,
        variationCount: 4,
        variations: [],
        selectedVariationIndex: 0,
        outputImage: null,
        aspectRatio: defaults.aspectRatio,
        resolution: defaults.resolution,
        model: defaults.model,
        useGoogleSearch: defaults.useGoogleSearch,
        generationProgress: 0,
        status: "idle",
        error: null,
      } as BatchVariationsNodeData;
    }
    case "conditionalBranch":
      return {
        inputImage: null,
        conditionGroups: [
          {
            id: crypto.randomUUID(),
            logic: "AND",
            conditions: [
              {
                id: crypto.randomUUID(),
                property: "width",
                operator: "greater_than",
                value: 512,
              },
            ],
          },
        ],
        groupLogic: "AND",
        lastEvaluationResult: null,
        analysisResults: null,
        status: "idle",
        error: null,
      } as ConditionalBranchNodeData;
    case "output":
      return {
        image: null,
      } as OutputNodeData;
  }
};
