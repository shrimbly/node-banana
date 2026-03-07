"use client";

import React, { useCallback, useState, useEffect, useMemo, useRef } from "react";
import { Handle, Position, NodeProps, Node, useReactFlow, useUpdateNodeInternals } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useCommentNavigation } from "@/hooks/useCommentNavigation";
import { ModelParameters } from "./ModelParameters";
import { useWorkflowStore, useProviderApiKeys } from "@/store/workflowStore";
import { deduplicatedFetch } from "@/utils/deduplicatedFetch";
import { GenerateVideoNodeData, ProviderType, SelectedModel, ModelInputDef } from "@/types";
import { ProviderModel, ModelCapability } from "@/lib/providers/types";
import { ModelSearchDialog } from "@/components/modals/ModelSearchDialog";
import { useToast } from "@/components/Toast";
import { getVideoDimensions, calculateNodeSizePreservingHeight } from "@/utils/nodeDimensions";
import { ProviderBadge } from "./ProviderBadge";
import { useVideoBlobUrl } from "@/hooks/useVideoBlobUrl";
import { isVeoModel, getVeoMetadata } from "@/utils/veoUtils";

// Video generation capabilities
const VIDEO_CAPABILITIES: ModelCapability[] = ["text-to-video", "image-to-video"];

// Hardcoded Veo parameter options (matches getGeminiVideoSchema in models/[modelId]/route.ts)
const VEO_ASPECT_RATIOS = ["16:9", "9:16"] as const;
const VEO_DURATIONS = ["4", "6", "8"] as const;
const VEO_RESOLUTIONS = ["720p", "1080p", "4k"] as const;

/**
 * Builds a hardcoded input schema for Veo models.
 * @param modelId - The model ID to build the schema for.
 * @returns Array of input definitions or undefined if not a Veo model.
 */
function buildVeoInputSchema(modelId: string): ModelInputDef[] | undefined {
  const metadata = getVeoMetadata(modelId);
  if (!metadata.isVeo) return undefined;
  
  const schema: ModelInputDef[] = [];
  
  // Only include image for Image-to-Video models
  if (metadata.isI2V) {
    schema.push({ 
      name: metadata.imageParamName, 
      type: "image", 
      required: true, 
      label: "Image",
      description: "Starting image frame for video" 
    });
  }
  
  // Prompt and Neg Prompt are always included for Veo
  schema.push({ 
    name: "prompt", 
    type: "text", 
    required: true, 
    label: "Prompt",
    description: "Text description of the video to generate"
  });
  
  schema.push({ 
    name: "negative_prompt", 
    type: "text", 
    required: false, 
    label: "Neg. Prompt",
    description: "Things to avoid in the generated video"
  });
  
  return schema;
}

type GenerateVideoNodeType = Node<GenerateVideoNodeData, "generateVideo">;

/**
 * GenerateVideoNode component for AI video generation.
 * Supports Google Veo and other external video models.
 * @param props - Node properties from React Flow.
 * @returns React component for the video generation node.
 */
export function GenerateVideoNode({ id, data, selected }: NodeProps<GenerateVideoNodeType>) {
  const nodeData = data;
  const commentNavigation = useCommentNavigation(id);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const updateNodeInternals = useUpdateNodeInternals();
  // Use stable selector for API keys to prevent unnecessary re-fetches
  const { geminiApiKey, replicateApiKey, falApiKey, kieApiKey, replicateEnabled, kieEnabled } = useProviderApiKeys();
  const generationsPath = useWorkflowStore((state) => state.generationsPath);
  const [externalModels, setExternalModels] = useState<ProviderModel[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [modelsFetchError, setModelsFetchError] = useState<string | null>(null);
  const [isBrowseDialogOpen, setIsBrowseDialogOpen] = useState(false);
  const [isLoadingCarouselVideo, setIsLoadingCarouselVideo] = useState(false);
  const videoBlobUrl = useVideoBlobUrl(nodeData.outputVideo ?? null);

  const currentProvider: ProviderType = nodeData.selectedModel?.provider || "fal";

  // Get enabled providers
  const enabledProviders = useMemo(() => {
    const providers: { id: ProviderType; name: string }[] = [];
    // Gemini available when API key is configured (settings or env var)
    if (geminiApiKey) {
      providers.push({ id: "gemini", name: "Gemini" });
    }
    // fal.ai is always available (works without key but rate limited)
    providers.push({ id: "fal", name: "fal.ai" });
    // Add Replicate if configured
    if (replicateEnabled && replicateApiKey) {
      providers.push({ id: "replicate", name: "Replicate" });
    }
    // Add Kie.ai if configured
    if (kieEnabled && kieApiKey) {
      providers.push({ id: "kie", name: "Kie.ai" });
    }
    return providers;
  }, [geminiApiKey, replicateEnabled, replicateApiKey, kieEnabled, kieApiKey]);

  // Fetch models from external providers when provider changes
  /**
   * Fetches available video models from the selected provider.
   * @returns A promise resolving when models are loaded.
   */
  const fetchModels = useCallback(async () => {
    setIsLoadingModels(true);
    setModelsFetchError(null);
    try {
      const capabilities = VIDEO_CAPABILITIES.join(",");
      const headers: HeadersInit = {};
      if (geminiApiKey) {
        headers["X-Gemini-API-Key"] = geminiApiKey;
      }
      if (replicateApiKey) {
        headers["X-Replicate-Key"] = replicateApiKey;
      }
      if (falApiKey) {
        headers["X-Fal-Key"] = falApiKey;
      }
      if (kieApiKey) {
        headers["X-Kie-Key"] = kieApiKey;
      }
      const response = await deduplicatedFetch(`/api/models?provider=${currentProvider}&capabilities=${capabilities}`, { headers });
      if (response.ok) {
        const data = await response.json();
        setExternalModels(data.models || []);
        setModelsFetchError(null);
      } else {
        const errorData = await response.json().catch(() => ({}));
        const errorMsg = errorData.error || `Failed to load models (${response.status})`;
        setExternalModels([]);
        setModelsFetchError(
          currentProvider === "replicate" && response.status === 401
            ? "Invalid Replicate API key. Check your settings."
            : errorMsg
        );
      }
    } catch (error) {
      console.error("Failed to fetch video models:", error);
      setExternalModels([]);
      setModelsFetchError("Failed to load models. Check your connection.");
    } finally {
      setIsLoadingModels(false);
    }
  }, [currentProvider, geminiApiKey, replicateApiKey, falApiKey, kieApiKey]);

  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  // Handle provider change
  const handleProviderChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const provider = e.target.value as ProviderType;
      // Set placeholder for the provider
      const newSelectedModel: SelectedModel = {
        provider,
        modelId: "",
        displayName: "Select model...",
      };
      // Clear parameters and schema when switching providers
      updateNodeData(id, { selectedModel: newSelectedModel, parameters: {}, inputSchema: undefined });
    },
    [id, updateNodeData]
  );

  // Handle model change
  const handleModelChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const modelId = e.target.value;
      const model = externalModels.find(m => m.id === modelId);
      if (model) {
        const newSelectedModel: SelectedModel = {
          provider: currentProvider,
          modelId: model.id,
          displayName: model.name,
        };
        // Clear parameters when changing models (different models have different schemas)
        // Set inputSchema immediately for Veo models so handles render in the same update
        updateNodeData(id, {
          selectedModel: newSelectedModel,
          parameters: {},
          inputSchema: buildVeoInputSchema(model.id),
        });
      }
    },
    [id, currentProvider, externalModels, updateNodeData]
  );

  const handleClearVideo = useCallback(() => {
    updateNodeData(id, { outputVideo: null, status: "idle", error: null });
  }, [id, updateNodeData]);

  const handleParametersChange = useCallback(
    (parameters: Record<string, unknown>) => {
      updateNodeData(id, { parameters });
    },
    [id, updateNodeData]
  );

  // Update a single key in the parameters bag (used by hardcoded Veo controls)
  /**
   * Updates a specific parameter for Veo models.
   * @param key - The parameter key to update.
   * @param value - The new value for the parameter.
   */
  const updateVeoParam = useCallback(
    (key: string, value: unknown) => {
      const current = nodeData.parameters || {};
      // Remove the key if value is empty string (clear optional fields)
      if (value === "") {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { [key]: _, ...rest } = current;
        updateNodeData(id, { parameters: rest });
      } else {
        updateNodeData(id, { parameters: { ...current, [key]: value } });
      }
    },
    [id, nodeData.parameters, updateNodeData]
  );

  // Handle inputs loaded from schema
  const handleInputsLoaded = useCallback(
    (inputs: ModelInputDef[]) => {
      updateNodeData(id, { inputSchema: inputs });
    },
    [id, updateNodeData]
  );

  // Handle parameters expand/collapse - resize node height
  const { setNodes } = useReactFlow();
  const handleParametersExpandChange = useCallback(
    (expanded: boolean, parameterCount: number) => {
      // Each parameter row is ~24px, plus some padding
      const parameterHeight = expanded ? Math.max(parameterCount * 28 + 16, 60) : 0;
      const baseHeight = 300; // Default node height
      const newHeight = baseHeight + parameterHeight;

      setNodes((nodes) =>
        nodes.map((node) =>
          node.id === id
            ? { ...node, style: { ...node.style, height: newHeight } }
            : node
        )
      );

      // Recompute React Flow hitboxes immediately after height change
      requestAnimationFrame(() => updateNodeInternals(id));
    },
    [id, setNodes, updateNodeInternals]
  );
  
  // Migrate existing/legacy Veo nodes to use the new stable schema automatically
  useEffect(() => {
    const modelId = nodeData.selectedModel?.modelId;
    if (isVeoModel(modelId)) {
      const stableSchema = buildVeoInputSchema(modelId!);
      // Use JSON comparison to avoid infinite update loops
      const currentSchemaJson = JSON.stringify(nodeData.inputSchema);
      const stableSchemaJson = JSON.stringify(stableSchema);
      
      if (currentSchemaJson !== stableSchemaJson) {
        updateNodeData(id, { inputSchema: stableSchema });
      }
    }
  }, [id, nodeData.selectedModel?.modelId, nodeData.inputSchema, updateNodeData]);

  // Update React Flow internals when schema changes so handles are correctly positioned
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, nodeData.inputSchema, updateNodeInternals]);

  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const isRunning = useWorkflowStore((state) => state.isRunning);

  /**
   * Triggers the regeneration of the current node's video.
   */
  const handleRegenerate = useCallback(() => {
    regenerateNode(id);
  }, [id, regenerateNode]);

  // Load video by ID from generations folder
  /**
   * Loads a video by its unique ID from the local generations path.
   * @param videoId - The ID of the video/generation to load.
   * @returns A promise resolving to the video data or null if not found.
   */
  const loadVideoById = useCallback(async (videoId: string) => {
    if (!generationsPath) {
      console.error("Generations path not configured");
      return null;
    }

    try {
      const response = await fetch("/api/load-generation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          directoryPath: generationsPath,
          imageId: videoId,
        }),
      });

      const result = await response.json();
      if (!result.success) {
        // Missing videos are expected when refs point to deleted/moved files
        console.log(`Video not found: ${videoId}`);
        return null;
      }
      return result.video || result.image;
    } catch (error) {
      console.warn("Error loading video:", error);
      return null;
    }
  }, [generationsPath]);

  // Carousel navigation handlers
  const handleCarouselPrevious = useCallback(async () => {
    const history = nodeData.videoHistory || [];
    if (history.length === 0 || isLoadingCarouselVideo) return;

    const currentIndex = nodeData.selectedVideoHistoryIndex || 0;
    const newIndex = currentIndex === 0 ? history.length - 1 : currentIndex - 1;
    const videoItem = history[newIndex];

    setIsLoadingCarouselVideo(true);
    const video = await loadVideoById(videoItem.id);
    setIsLoadingCarouselVideo(false);

    if (video) {
      updateNodeData(id, {
        outputVideo: video,
        selectedVideoHistoryIndex: newIndex,
      });
    }
  }, [id, nodeData.videoHistory, nodeData.selectedVideoHistoryIndex, isLoadingCarouselVideo, loadVideoById, updateNodeData]);

  const handleCarouselNext = useCallback(async () => {
    const history = nodeData.videoHistory || [];
    if (history.length === 0 || isLoadingCarouselVideo) return;

    const currentIndex = nodeData.selectedVideoHistoryIndex || 0;
    const newIndex = (currentIndex + 1) % history.length;
    const videoItem = history[newIndex];

    setIsLoadingCarouselVideo(true);
    const video = await loadVideoById(videoItem.id);
    setIsLoadingCarouselVideo(false);

    if (video) {
      updateNodeData(id, {
        outputVideo: video,
        selectedVideoHistoryIndex: newIndex,
      });
    }
  }, [id, nodeData.videoHistory, nodeData.selectedVideoHistoryIndex, isLoadingCarouselVideo, loadVideoById, updateNodeData]);

  // Handle model selection from browse dialog
  /**
   * Handles model selection from the external browse dialog.
   * @param model - The chosen provider model.
   */
  const handleBrowseModelSelect = useCallback((model: ProviderModel) => {
    const newSelectedModel: SelectedModel = {
      provider: model.provider,
      modelId: model.id,
      displayName: model.name,
    };
    // Set inputSchema immediately for Veo models so handles render in the same update
    updateNodeData(id, {
      selectedModel: newSelectedModel,
      parameters: {},
      inputSchema: buildVeoInputSchema(model.id),
    });
    setIsBrowseDialogOpen(false);
  }, [id, updateNodeData]);

  // Dynamic title based on selected model - just the model name
  const displayTitle = useMemo(() => {
    if (nodeData.selectedModel?.displayName && nodeData.selectedModel.modelId) {
      return nodeData.selectedModel.displayName;
    }
    return "Select model...";
  }, [nodeData.selectedModel?.displayName, nodeData.selectedModel?.modelId]);

  // Provider badge as title prefix
  const titlePrefix = useMemo(() => (
    <ProviderBadge provider={currentProvider} />
  ), [currentProvider]);

  // Header action element - browse button
  const headerAction = useMemo(() => (
    <button
      onClick={() => setIsBrowseDialogOpen(true)}
      className="nodrag nopan text-[10px] py-0.5 px-1.5 bg-neutral-700 hover:bg-neutral-600 border border-neutral-600 rounded text-neutral-300 transition-colors"
    >
      Browse
    </button>
  ), []);

  const hasCarouselVideos = (nodeData.videoHistory || []).length > 1;

  // Track previous status to detect error transitions
  const prevStatusRef = useRef(nodeData.status);

  // Show toast when error occurs
  useEffect(() => {
    if (nodeData.status === "error" && prevStatusRef.current !== "error" && nodeData.error) {
      useToast.getState().show("Video generation failed", "error", true, nodeData.error);
    }
    prevStatusRef.current = nodeData.status;
  }, [nodeData.status, nodeData.error]);

  // Auto-resize node when output video changes
  const prevOutputVideoRef = useRef<string | null>(null);
  useEffect(() => {
    // Only resize when outputVideo transitions from null/different to a new value
    if (!nodeData.outputVideo || nodeData.outputVideo === prevOutputVideoRef.current) {
      prevOutputVideoRef.current = nodeData.outputVideo ?? null;
      return;
    }
    prevOutputVideoRef.current = nodeData.outputVideo;

    // Use requestAnimationFrame to avoid React Flow update conflicts
    requestAnimationFrame(() => {
      getVideoDimensions(nodeData.outputVideo!).then((dims) => {
        if (!dims) return;

        const aspectRatio = dims.width / dims.height;

        setNodes((nodes) =>
          nodes.map((node) => {
            if (node.id !== id) return node;

            // Preserve user's manually set height if present
            const currentHeight = typeof node.style?.height === 'number'
              ? node.style.height
              : undefined;

            const newSize = calculateNodeSizePreservingHeight(aspectRatio, currentHeight);

            return { ...node, style: { ...node.style, width: newSize.width, height: newSize.height } };
          })
        );

        // Recompute React Flow hitboxes immediately after auto-resize
        requestAnimationFrame(() => updateNodeInternals(id));
      });
    });
  }, [id, nodeData.outputVideo, setNodes, updateNodeInternals]);

  return (
    <>
    <BaseNode
      id={id}
      title={displayTitle}
      customTitle={nodeData.customTitle}
      comment={nodeData.comment}
      onCustomTitleChange={(title) => updateNodeData(id, { customTitle: title || undefined })}
      onCommentChange={(comment) => updateNodeData(id, { comment: comment || undefined })}
      onRun={handleRegenerate}
      selected={selected}
      isExecuting={isRunning}
      hasError={nodeData.status === "error"}
      headerAction={headerAction}
      titlePrefix={titlePrefix}
      commentNavigation={commentNavigation ?? undefined}
      handles={
        <>
          {/* Dynamic input handles based on model schema */}
          {nodeData.inputSchema && nodeData.inputSchema.length > 0 ? (
            (() => {
              const imageInputs = nodeData.inputSchema!.filter(i => i.type === "image");
              const textInputs = nodeData.inputSchema!.filter(i => i.type === "text");
              const hasImageInput = imageInputs.length > 0;
              const hasTextInput = textInputs.length > 0;

              const handles: Array<{
                id: string;
                type: "image" | "text";
                label: string;
                schemaName: string | null;
                description: string | null;
                isPlaceholder: boolean;
              }> = [];

              if (hasImageInput) {
                imageInputs.forEach((input, index) => {
                  handles.push({
                    id: index === 0 ? "image" : `image-${index}`,
                    type: "image",
                    label: input.label,
                    schemaName: input.name,
                    description: input.description || null,
                    isPlaceholder: false,
                  });
                });
              }

              if (hasTextInput) {
                textInputs.forEach((input, index) => {
                  handles.push({
                    id: index === 0 ? "text" : `text-${index}`,
                    type: "text",
                    label: input.label,
                    schemaName: input.name,
                    description: input.description || null,
                    isPlaceholder: false,
                  });
                });
              }

              const imageHandles = handles.filter(h => h.type === "image");
              const textHandles = handles.filter(h => h.type === "text");
              const totalSlots = imageHandles.length + textHandles.length + 1;

              return handles.map((handle) => {
                const isImage = handle.type === "image";
                const typeIndex = isImage
                  ? imageHandles.findIndex(h => h.id === handle.id)
                  : textHandles.findIndex(h => h.id === handle.id);
                const adjustedIndex = isImage ? typeIndex : imageHandles.length + 1 + typeIndex;
                const topPercent = ((adjustedIndex + 1) / (totalSlots + 1)) * 100;

                // Hide handles that are placeholders (not supported by current model)
                const isHidden = handle.isPlaceholder;

                return (
                  <React.Fragment key={handle.id}>
                    <Handle
                      type="target"
                      position={Position.Left}
                      id={handle.id}
                      style={{
                        top: `${topPercent}%`,
                        opacity: isHidden ? 0 : 1,
                        pointerEvents: isHidden ? "none" : "auto",
                      }}
                      data-handletype={handle.type}
                      data-schema-name={handle.schemaName || undefined}
                      isConnectable={!isHidden}
                      title={handle.description || handle.label}
                    />
                    {!isHidden && (
                      <div
                        className="absolute text-[10px] font-medium whitespace-nowrap pointer-events-none text-right"
                        style={{
                          right: `calc(100% + 8px)`,
                          top: `calc(${topPercent}% - 18px)`,
                          color: isImage ? "var(--handle-color-image)" : "var(--handle-color-text)",
                        }}
                      >
                        {handle.label}
                      </div>
                    )}
                  </React.Fragment>
                );
              });
            })()
          ) : (
            <>
              <Handle type="target" position={Position.Left} id="image" style={{ top: "35%", pointerEvents: "auto" }} data-handletype="image" isConnectable={true} />
              <div className="absolute text-[10px] font-medium whitespace-nowrap pointer-events-none text-right" style={{ right: `calc(100% + 8px)`, top: "calc(35% - 18px)", color: "var(--handle-color-image)" }}>Image</div>
              <Handle type="target" position={Position.Left} id="text" style={{ top: "65%", pointerEvents: "auto" }} data-handletype="text" isConnectable={true} />
              <div className="absolute text-[10px] font-medium whitespace-nowrap pointer-events-none text-right" style={{ right: `calc(100% + 8px)`, top: "calc(65% - 18px)", color: "var(--handle-color-text)" }}>Prompt</div>
            </>
          )}

          {/* Video output handle */}
          <Handle type="source" position={Position.Right} id="video" style={{ top: "50%", pointerEvents: "auto" }} data-handletype="video" />
          <div className="absolute text-[10px] font-medium whitespace-nowrap pointer-events-none" style={{ left: `calc(100% + 8px)`, top: "calc(50% - 18px)", color: "var(--handle-color-video, var(--handle-color-image))" }}>Video</div>
        </>
      }
    >

      <div className="flex-1 flex flex-col min-h-0 gap-2">
        {/* Preview area */}
        {nodeData.outputVideo ? (
          <>
          <div className="relative w-full flex-1 min-h-0">
            <video
              key={nodeData.videoHistory?.[nodeData.selectedVideoHistoryIndex || 0]?.id}
              src={videoBlobUrl ?? undefined}
              controls
              autoPlay
              loop
              muted
              className="w-full h-full object-contain rounded"
              playsInline
            />
            {/* Loading overlay for generation */}
            {nodeData.status === "loading" && (
              <div className="absolute inset-0 bg-neutral-900/70 rounded flex items-center justify-center">
                <svg
                  className="w-6 h-6 animate-spin text-white"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="3"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
              </div>
            )}
            {/* Error overlay when generation failed */}
            {nodeData.status === "error" && (
              <div className="absolute inset-0 bg-red-900/40 rounded flex flex-col items-center justify-center gap-1">
                <svg
                  className="w-6 h-6 text-white"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="text-white text-xs font-medium">Generation failed</span>
                <span className="text-white/70 text-[10px]">See toast for details</span>
              </div>
            )}
            {/* Loading overlay for carousel navigation */}
            {isLoadingCarouselVideo && (
              <div className="absolute inset-0 bg-neutral-900/50 rounded flex items-center justify-center">
                <svg
                  className="w-4 h-4 animate-spin text-white"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="3"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
              </div>
            )}
            <div className="absolute top-1 right-1">
              <button
                onClick={handleClearVideo}
                className="w-5 h-5 bg-neutral-900/80 hover:bg-red-600/80 rounded flex items-center justify-center text-neutral-400 hover:text-white transition-colors"
                title="Clear video"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          {/* Carousel controls - only show if there are multiple videos */}
          {hasCarouselVideos && (
            <div className="flex items-center justify-center gap-2 shrink-0">
              <button
                onClick={handleCarouselPrevious}
                disabled={isLoadingCarouselVideo}
                className="w-5 h-5 rounded bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center text-neutral-400 hover:text-white transition-colors"
                title="Previous video"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <span className="text-[10px] text-neutral-400 min-w-[32px] text-center">
                {(nodeData.selectedVideoHistoryIndex || 0) + 1} / {(nodeData.videoHistory || []).length}
              </span>
              <button
                onClick={handleCarouselNext}
                disabled={isLoadingCarouselVideo}
                className="w-5 h-5 rounded bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center text-neutral-400 hover:text-white transition-colors"
                title="Next video"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          )}
        </>
        ) : (
          <div className="w-full flex-1 min-h-[112px] border border-dashed border-neutral-600 rounded flex flex-col items-center justify-center">
            {nodeData.status === "loading" ? (
              <svg
                className="w-4 h-4 animate-spin text-neutral-400"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="3"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
            ) : nodeData.status === "error" ? (
              <span className="text-[10px] text-red-400 text-center px-2">
                {nodeData.error || "Failed"}
              </span>
            ) : (
              <span className="text-neutral-500 text-[10px]">
                Run to generate
              </span>
            )}
          </div>
        )}

        {/* Model-specific parameters */}
        {nodeData.selectedModel?.modelId && isVeoModel(nodeData.selectedModel.modelId) ? (
          // Hardcoded Veo parameters (matching GenerateImageNode pattern for Gemini models)
          <div className="flex flex-col gap-1.5 shrink-0">
            {/* Aspect ratio + Duration row */}
            <div className="flex gap-1.5">
              <select
                value={(nodeData.parameters?.aspectRatio as string) || "16:9"}
                onChange={(e) => updateVeoParam("aspectRatio", e.target.value)}
                className="flex-1 text-[10px] py-1 px-1.5 border border-neutral-700 rounded bg-neutral-900/50 focus:outline-none focus:ring-1 focus:ring-neutral-600 text-neutral-300"
              >
                {VEO_ASPECT_RATIOS.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
              <select
                value={(nodeData.parameters?.durationSeconds as string) || "8"}
                onChange={(e) => updateVeoParam("durationSeconds", e.target.value)}
                className="w-12 text-[10px] py-1 px-1.5 border border-neutral-700 rounded bg-neutral-900/50 focus:outline-none focus:ring-1 focus:ring-neutral-600 text-neutral-300"
              >
                {VEO_DURATIONS.map((d) => (
                  <option key={d} value={d}>{d}s</option>
                ))}
              </select>
              <select
                value={(nodeData.parameters?.resolution as string) || "720p"}
                onChange={(e) => updateVeoParam("resolution", e.target.value)}
                className="w-14 text-[10px] py-1 px-1.5 border border-neutral-700 rounded bg-neutral-900/50 focus:outline-none focus:ring-1 focus:ring-neutral-600 text-neutral-300"
              >
                {VEO_RESOLUTIONS.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
            {/* Seed */}
            <input
              type="number"
              placeholder="Seed (optional)"
              value={(nodeData.parameters?.seed as string) ?? ""}
              onChange={(e) => updateVeoParam("seed", e.target.value === "" ? "" : Number(e.target.value))}
              min={0}
              className="w-full text-[10px] py-1 px-1.5 border border-neutral-700 rounded bg-neutral-900/50 focus:outline-none focus:ring-1 focus:ring-neutral-600 text-neutral-300 placeholder:text-neutral-600"
            />
          </div>
        ) : nodeData.selectedModel?.modelId ? (
          <ModelParameters
            modelId={nodeData.selectedModel.modelId}
            provider={currentProvider}
            parameters={nodeData.parameters || {}}
            onParametersChange={handleParametersChange}
            onExpandChange={handleParametersExpandChange}
            onInputsLoaded={handleInputsLoaded}
          />
        ) : null}
      </div>
    </BaseNode>

    {/* Model browser dialog */}
    {isBrowseDialogOpen && (
      <ModelSearchDialog
        isOpen={isBrowseDialogOpen}
        onClose={() => setIsBrowseDialogOpen(false)}
        onModelSelected={handleBrowseModelSelect}
        initialCapabilityFilter="video"
      />
    )}
    </>
  );
}
