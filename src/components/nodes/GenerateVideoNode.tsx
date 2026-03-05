"use client";

import React, { useCallback, useState, useEffect, useMemo, useRef } from "react";
import { Handle, Position, NodeProps, Node, useReactFlow } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
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
import { getModelPageUrl, getProviderDisplayName } from "@/utils/providerUrls";

// Video generation capabilities
const VIDEO_CAPABILITIES: ModelCapability[] = ["text-to-video", "image-to-video"];

/** Returns true for Gemini-native Veo video models */
function isVeoModel(modelId: string | undefined): boolean {
  if (!modelId) return false;
  return modelId.startsWith("veo-");
}

/** Build the hardcoded inputSchema for a Veo model, or undefined for non-Veo */
function buildVeoInputSchema(modelId: string): ModelInputDef[] | undefined {
  if (!isVeoModel(modelId)) return undefined;
  const isI2V = modelId.includes("image-to-video");
  const inputs: ModelInputDef[] = [
    { name: "prompt", type: "text", required: true, label: "Prompt" },
    { name: "negative_prompt", type: "text", required: false, label: "Neg. Prompt" },
  ];
  if (isI2V) {
    inputs.unshift({ name: "image", type: "image", required: true, label: "Image" });
  }
  return inputs;
}

type GenerateVideoNodeType = Node<GenerateVideoNodeData, "generateVideo">;

export function GenerateVideoNode({ id, data, selected }: NodeProps<GenerateVideoNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
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
    },
    [id, setNodes]
  );

  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const isRunning = useWorkflowStore((state) => state.isRunning);

  const handleRegenerate = useCallback(() => {
    regenerateNode(id);
  }, [id, regenerateNode]);

  // Load video by ID from generations folder
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

  // Compute model page URL for external link
  const modelPageUrl = useMemo(() => {
    if (!nodeData.selectedModel?.modelId) return null;
    return getModelPageUrl(currentProvider, nodeData.selectedModel.modelId);
  }, [currentProvider, nodeData.selectedModel?.modelId]);

  // Header action element - external link + browse button
  const headerAction = useMemo(() => (
    <>
      {modelPageUrl && nodeData.selectedModel?.modelId && (
        <a
          href={modelPageUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="nodrag nopan text-neutral-500 hover:text-neutral-300 transition-colors"
          title={`View on ${getProviderDisplayName(currentProvider)}`}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </a>
      )}
      <button
        onClick={() => setIsBrowseDialogOpen(true)}
        className="nodrag nopan text-[10px] py-0.5 px-1.5 bg-neutral-700 hover:bg-neutral-600 border border-neutral-600 rounded text-neutral-300 transition-colors"
      >
        Browse
      </button>
    </>
  ), [modelPageUrl, nodeData.selectedModel?.modelId, currentProvider]);

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
      });
    });
  }, [id, nodeData.outputVideo, setNodes]);

  return (
    <>
    <BaseNode
      id={id}
      selected={selected}
      isExecuting={isRunning}
      hasError={nodeData.status === "error"}
      fullBleed
    >
      {/* Dynamic input handles based on model schema */}
      {nodeData.inputSchema && nodeData.inputSchema.length > 0 ? (
        // Render handles from schema, sorted by type (images first, text second)
        // IMPORTANT: Always render "image" and "text" handles to maintain connection
        // compatibility. Schema may only have text inputs (text-to-video models) but
        // we still need the image handle to preserve connections made before model selection.
        (() => {
          const imageInputs = nodeData.inputSchema!.filter(i => i.type === "image");
          const textInputs = nodeData.inputSchema!.filter(i => i.type === "text");

          // Always include at least one image and one text handle for connection stability
          const hasImageInput = imageInputs.length > 0;
          const hasTextInput = textInputs.length > 0;

          // Build the handles array: schema inputs + fallback defaults if missing
          const handles: Array<{
            id: string;
            type: "image" | "text";
            label: string;
            schemaName: string | null;
            description: string | null;
            isPlaceholder: boolean;
          }> = [];

          // Add image handles from schema, or a placeholder if none exist
          if (hasImageInput) {
            imageInputs.forEach((input, index) => {
              handles.push({
                // Always use indexed IDs for schema inputs for consistency
                id: `image-${index}`,
                type: "image",
                label: input.label,
                schemaName: input.name,
                description: input.description || null,
                isPlaceholder: false,
              });
            });
          } else {
            // No image inputs in schema - add placeholder to preserve connections
            handles.push({
              id: "image",
              type: "image",
              label: "Image",
              schemaName: null,
              description: "Not used by this model",
              isPlaceholder: true,
            });
          }

          // Add text handles from schema, or a placeholder if none exist
          if (hasTextInput) {
            textInputs.forEach((input, index) => {
              handles.push({
                // Always use indexed IDs for schema inputs for consistency
                id: `text-${index}`,
                type: "text",
                label: input.label,
                schemaName: input.name,
                description: input.description || null,
                isPlaceholder: false,
              });
            });
          } else {
            // No text inputs in schema - add placeholder to preserve connections
            handles.push({
              id: "text",
              type: "text",
              label: "Prompt",
              schemaName: null,
              description: "Not used by this model",
              isPlaceholder: true,
            });
          }

          // Calculate positions
          const imageHandles = handles.filter(h => h.type === "image");
          const textHandles = handles.filter(h => h.type === "text");
          const totalSlots = imageHandles.length + textHandles.length + 1; // +1 for gap

          const renderedHandles = handles.map((handle, index) => {
            // Position: images first, then gap, then text
            const isImage = handle.type === "image";
            const typeIndex = isImage
              ? imageHandles.findIndex(h => h.id === handle.id)
              : textHandles.findIndex(h => h.id === handle.id);
            const adjustedIndex = isImage ? typeIndex : imageHandles.length + 1 + typeIndex;
            const topPercent = ((adjustedIndex + 1) / (totalSlots + 1)) * 100;

            return (
              <React.Fragment key={handle.id}>
                <Handle
                  type="target"
                  position={Position.Left}
                  id={handle.id}
                  style={{
                    top: `${topPercent}%`,
                    opacity: handle.isPlaceholder ? 0.3 : 1,
                    zIndex: 10,
                  }}
                  data-handletype={handle.type}
                  data-schema-name={handle.schemaName || undefined}
                  isConnectable={true}
                  title={handle.description || handle.label}
                />
                {/* Handle label - positioned outside node, above the connector */}
                <div
                  className="absolute text-[10px] font-medium whitespace-nowrap pointer-events-none text-right"
                  style={{
                    right: `calc(100% + 8px)`,
                    top: `calc(${topPercent}% - 18px)`,
                    color: isImage ? "var(--handle-color-image)" : "var(--handle-color-text)",
                    opacity: handle.isPlaceholder ? 0.3 : 1,
                    zIndex: 10,
                  }}
                >
                  {handle.label}
                </div>
              </React.Fragment>
            );
          });

          // Add hidden backward-compatibility handles for edges using non-indexed IDs
          // This ensures edges created with "image"/"text" still work when schema uses "image-0"/"text-0"
          // Note: No data-handletype to avoid being counted in tests - these are purely for edge routing
          return (
            <>
              {renderedHandles}
              {hasImageInput && (
                <Handle
                  type="target"
                  position={Position.Left}
                  id="image"
                  style={{ top: "35%", opacity: 0, pointerEvents: "none" }}
                  isConnectable={false}
                />
              )}
              {hasTextInput && (
                <Handle
                  type="target"
                  position={Position.Left}
                  id="text"
                  style={{ top: "65%", opacity: 0, pointerEvents: "none" }}
                  isConnectable={false}
                />
              )}
            </>
          );
        })()
      ) : (
        // Default handles when no schema
        <>
          <Handle
            type="target"
            position={Position.Left}
            id="image"
            style={{ top: "35%", zIndex: 10 }}
            data-handletype="image"
            isConnectable={true}
          />
          {/* Default image label */}
          <div
            className="absolute text-[10px] font-medium whitespace-nowrap pointer-events-none text-right"
            style={{
              right: `calc(100% + 8px)`,
              top: "calc(35% - 18px)",
              color: "var(--handle-color-image)",
              zIndex: 10,
            }}
          >
            Image
          </div>
          <Handle
            type="target"
            position={Position.Left}
            id="text"
            style={{ top: "65%", zIndex: 10 }}
            data-handletype="text"
          />
          {/* Default text label */}
          <div
            className="absolute text-[10px] font-medium whitespace-nowrap pointer-events-none text-right"
            style={{
              right: `calc(100% + 8px)`,
              top: "calc(65% - 18px)",
              color: "var(--handle-color-text)",
              zIndex: 10,
            }}
          >
            Prompt
          </div>
        </>
      )}
      {/* Video output */}
      <Handle
        type="source"
        position={Position.Right}
        id="video"
        data-handletype="video"
        style={{ zIndex: 10 }}
      />
      {/* Output label */}
      <div
        className="absolute text-[10px] font-medium whitespace-nowrap pointer-events-none"
        style={{
          left: `calc(100% + 8px)`,
          top: "calc(50% - 18px)",
          color: "var(--handle-color-image)",
          zIndex: 10,
        }}
      >
        Video
      </div>

      <div className="relative w-full h-full min-h-0 overflow-hidden rounded-lg">
        {/* Preview area */}
        {nodeData.outputVideo ? (
          <>
            <video
              key={nodeData.videoHistory?.[nodeData.selectedVideoHistoryIndex || 0]?.id}
              src={videoBlobUrl ?? undefined}
              controls
              autoPlay
              loop
              muted
              className="w-full h-full object-cover"
              playsInline
            />
            {/* Loading overlay for generation */}
            {nodeData.status === "loading" && (
              <div className="absolute inset-0 bg-neutral-900/70 flex items-center justify-center">
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
              <div className="absolute inset-0 bg-red-900/40 flex flex-col items-center justify-center gap-1">
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
              <div className="absolute inset-0 bg-neutral-900/50 flex items-center justify-center">
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
            {/* Clear button */}
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

            {/* Carousel controls - overlaid on video bottom */}
            {hasCarouselVideos && (
              <div className="absolute bottom-0 left-0 right-0 flex items-center justify-center gap-2 py-1.5 bg-neutral-900/60 backdrop-blur-sm">
                <button
                  onClick={handleCarouselPrevious}
                  disabled={isLoadingCarouselVideo}
                  className="w-5 h-5 rounded hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center text-white/70 hover:text-white transition-colors"
                  title="Previous video"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
                <span className="text-[10px] text-white/70 min-w-[32px] text-center">
                  {(nodeData.selectedVideoHistoryIndex || 0) + 1} / {(nodeData.videoHistory || []).length}
                </span>
                <button
                  onClick={handleCarouselNext}
                  disabled={isLoadingCarouselVideo}
                  className="w-5 h-5 rounded hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center text-white/70 hover:text-white transition-colors"
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
          <div className="w-full h-full min-h-[112px] bg-neutral-900/40 flex flex-col items-center justify-center">
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
      </div>
    </BaseNode>

    {/* Hidden ModelParameters — only for schema-loading side effect (dynamic handles) */}
    {nodeData.selectedModel?.modelId && !isVeoModel(nodeData.selectedModel.modelId) && (
      <div className="hidden">
        <ModelParameters
          modelId={nodeData.selectedModel.modelId}
          provider={currentProvider}
          parameters={nodeData.parameters || {}}
          onParametersChange={handleParametersChange}
          onExpandChange={handleParametersExpandChange}
          onInputsLoaded={handleInputsLoaded}
        />
      </div>
    )}

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
