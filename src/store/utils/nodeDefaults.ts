import {
  NodeType,
  ModelType,
  ImageInputNodeData,
  AudioInputNodeData,
  AnnotationNodeData,
  PromptNodeData,
  ArrayNodeData,
  PromptConstructorNodeData,
  NanoBananaNodeData,
  GenerateVideoNodeData,
  Generate3DNodeData,
  GenerateAudioNodeData,
  LLMGenerateNodeData,
  SplitGridNodeData,
  OutputNodeData,
  OutputGalleryNodeData,
  ImageCompareNodeData,
  EaseCurveNodeData,
  VideoTrimNodeData,
  VideoFrameGrabNodeData,
  RouterNodeData,
  SwitchNodeData,
  ConditionalSwitchNodeData,
  GLBViewerNodeData,
  InpaintNodeData,
  WorkflowNodeData,
  GroupColor,
  SelectedModel,
  MODEL_DISPLAY_NAMES,
} from "@/types";
import { loadGenerateImageDefaults, loadNodeDefaults } from "./localStorage";

/**
 * Default dimensions for each node type.
 * Used in addNode and createGroup for consistent sizing.
 */
export const defaultNodeDimensions: Record<NodeType, { width: number; height: number }> = {
  imageInput: { width: 300, height: 280 },
  audioInput: { width: 300, height: 200 },
  annotation: { width: 300, height: 280 },
  prompt: { width: 320, height: 220 },
  array: { width: 340, height: 260 },
  promptConstructor: { width: 340, height: 280 },
  nanoBanana: { width: 300, height: 300 },
  generateVideo: { width: 300, height: 300 },
  generate3d: { width: 300, height: 300 },
  generateAudio: { width: 300, height: 280 },
  llmGenerate: { width: 320, height: 360 },
  splitGrid: { width: 300, height: 320 },
  output: { width: 320, height: 320 },
  outputGallery: { width: 320, height: 360 },
  imageCompare: { width: 400, height: 360 },
  videoStitch: { width: 400, height: 280 },
  easeCurve: { width: 340, height: 480 },
  videoTrim: { width: 360, height: 360 },
  videoFrameGrab: { width: 320, height: 320 },
  router: { width: 200, height: 80 },
  switch: { width: 220, height: 120 },
  conditionalSwitch: { width: 260, height: 180 },
  glbViewer: { width: 360, height: 380 },
  inpaint: { width: 320, height: 340 },
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
    case "audioInput":
      return {
        audioFile: null,
        filename: null,
        duration: null,
        format: null,
      } as AudioInputNodeData;
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
    case "array":
      return {
        inputText: null,
        splitMode: "delimiter",
        delimiter: "*",
        regexPattern: "",
        trimItems: true,
        removeEmpty: true,
        selectedOutputIndex: null,
        outputItems: [],
        outputText: "[]",
        error: null,
      } as ArrayNodeData;
    case "promptConstructor":
      return {
        template: "",
        outputText: null,
        outputParts: null,
        unresolvedVars: [],
      } as PromptConstructorNodeData;
    case "nanoBanana": {
      const nodeDefaults = loadNodeDefaults();
      const legacyDefaults = loadGenerateImageDefaults();

      // Determine selectedModel: prefer new nodeDefaults, fallback to legacy
      let selectedModel: SelectedModel;
      if (nodeDefaults.generateImage?.selectedModel) {
        selectedModel = nodeDefaults.generateImage.selectedModel;
      } else {
        const modelDisplayName = MODEL_DISPLAY_NAMES[legacyDefaults.model as ModelType] || legacyDefaults.model;
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
      const useImageSearch = nodeDefaults.generateImage?.useImageSearch ?? legacyDefaults.useImageSearch;

      return {
        inputImages: [],
        inputPrompt: null,
        outputImage: null,
        aspectRatio,
        resolution,
        model: legacyDefaults.model, // Keep legacy model field for backward compat
        selectedModel,
        useGoogleSearch,
        useImageSearch,
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
    case "generate3d": {
      const nodeDefaults = loadNodeDefaults();
      return {
        inputImages: [],
        inputPrompt: null,
        output3dUrl: null,
        savedFilename: null,
        savedFilePath: null,
        selectedModel: nodeDefaults.generate3d?.selectedModel,
        status: "idle",
        error: null,
      } as Generate3DNodeData;
    }
    case "generateAudio": {
      const nodeDefaults = loadNodeDefaults();
      return {
        inputPrompt: null,
        outputAudio: null,
        selectedModel: nodeDefaults.generateAudio?.selectedModel,
        status: "idle",
        error: null,
        audioHistory: [],
        selectedAudioHistoryIndex: 0,
        duration: null,
        format: null,
      } as GenerateAudioNodeData;
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
          useImageSearch: false,
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
        outputFilename: "",
      } as OutputNodeData;
    case "outputGallery":
      return {
        images: [],
      } as OutputGalleryNodeData;
    case "imageCompare":
      return {
        imageA: null,
        imageB: null,
      } as ImageCompareNodeData;
    case "videoStitch":
      return {
        clips: [],
        clipOrder: [],
        outputVideo: null,
        loopCount: 1,
        status: "idle",
        error: null,
        progress: 0,
        encoderSupported: null,
      };
    case "easeCurve":
      return {
        bezierHandles: [0.445, 0.05, 0.55, 0.95], // easeInOutSine preset
        easingPreset: "easeInOutSine",
        inheritedFrom: null,
        outputDuration: 1.5,
        outputVideo: null,
        status: "idle",
        error: null,
        progress: 0,
        encoderSupported: null,
      } as EaseCurveNodeData;
    case "videoTrim":
      return {
        startTime: 0,
        endTime: 0,
        duration: null,
        outputVideo: null,
        status: "idle",
        error: null,
        progress: 0,
        encoderSupported: null,
      } as VideoTrimNodeData;
    case "videoFrameGrab":
      return {
        framePosition: "first",
        outputImage: null,
        status: "idle",
        error: null,
      } as VideoFrameGrabNodeData;
    case "router":
      return {} as RouterNodeData;
    case "switch":
      return {
        inputType: null,
        switches: [
          { id: Math.random().toString(36).slice(2, 9), name: "Output 1", enabled: true }
        ]
      } as SwitchNodeData;
    case "conditionalSwitch":
      return {
        incomingText: null,
        rules: [
          {
            id: "rule-" + Math.random().toString(36).slice(2, 9),
            value: "",
            mode: "contains",
            label: "Rule 1",
            isMatched: false,
          }
        ]
      } as ConditionalSwitchNodeData;
    case "glbViewer":
      return {
        glbUrl: null,
        filename: null,
        capturedImage: null,
      } as GLBViewerNodeData;
    case "inpaint":
      return {
        inputImage: null,
        maskImage: null,
        inputPrompt: null,
        outputImage: null,
        inpaintProvider: "gemini",
        maskBrushSize: 40,
        status: "idle",
        error: null,
        imageHistory: [],
        selectedHistoryIndex: 0,
      } as InpaintNodeData;
  }
};
