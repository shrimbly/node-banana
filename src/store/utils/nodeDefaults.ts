import {
  NodeType,
  ImageInputNodeData,
  AudioInputNodeData,
  AnnotationNodeData,
  PromptNodeData,
  ArrayNodeData,
  PromptConstructorNodeData,
  NanoBananaNodeData,
  GenerateVideoNodeData,
  Generate3DNodeData,
  WorldLabsPanoNodeData,
  WorldLabsWorldNodeData,
  GenerateAudioNodeData,
  LLMGenerateNodeData,
  SplitGridNodeData,
  OutputNodeData,
  OutputGalleryNodeData,
  ImageCompareNodeData,
  EaseCurveNodeData,
  VideoTrimNodeData,
  VideoFrameGrabNodeData,
  GLBViewerNodeData,
  SpzViewerNodeData,
  PanoCropNodeData,
  PanoViewerNodeData,
  PanoEditorNodeData,
  MaskPainterNodeData,
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
  audioInput: { width: 300, height: 200 },
  annotation: { width: 300, height: 280 },
  prompt: { width: 320, height: 220 },
  array: { width: 360, height: 360 },
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
  glbViewer: { width: 360, height: 380 },
  spzViewer: { width: 300, height: 280 },
  worldLabsPano: { width: 320, height: 380 },
  worldLabsWorld: { width: 320, height: 360 },
  panoCrop: { width: 300, height: 280 },
  panoViewer: { width: 300, height: 280 },
  panoEditor: { width: 300, height: 300 },
  maskPainter: { width: 260, height: 300 },
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
        lastGenerationCost: null,
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
        lastGenerationCost: null,
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
        lastGenerationCost: null,
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
        lastGenerationCost: null,
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
    case "glbViewer":
      return {
        glbUrl: null,
        filename: null,
        capturedImage: null,
      } as GLBViewerNodeData;
    case "spzViewer":
      return {
        spzUrl: null,
        filename: null,
        capturedImage: null,
        viewerOpen: false,
      } as SpzViewerNodeData;
    case "worldLabsPano":
      return {
        worldName: "Untitled World",
        model: "Marble 0.1-mini",
        seed: null,
        inputImages: [],
        inputPrompt: null,
        operationId: null,
        worldId: null,
        status: "idle",
        error: null,
        progress: null,
        panoUrl: null,
        thumbnailUrl: null,
        caption: null,
        imageAzimuths: {},
      } as WorldLabsPanoNodeData;
    case "worldLabsWorld":
      return {
        worldName: "Untitled World",
        model: "Marble 0.1-plus",
        seed: null,
        inputImages: [],
        inputPrompt: null,
        operationId: null,
        worldId: null,
        status: "idle",
        error: null,
        progress: null,
        spzUrls: null,
        panoUrl: null,
        thumbnailUrl: null,
        marbleViewerUrl: null,
        caption: null,
        viewerWindowOpen: false,
      } as WorldLabsWorldNodeData;
    case "panoCrop":
      return {
        image: null,
        metadata: null,
        filename: null,
        dimensions: null,
      } as PanoCropNodeData;
    case "panoViewer":
      return {
        panoUrl: null,
        viewerOpen: false,
      } as PanoViewerNodeData;
    case "panoEditor":
      return {
        outputImage: null,
        status: "idle",
        error: null,
      } as PanoEditorNodeData;
    case "maskPainter":
      return {
        sourceImage: null,
        strokes: [],
        outputMask: null,
        brushSize: 30,
        blurRadius: 0,
        invertMask: false,
      } as MaskPainterNodeData;
  }
};
