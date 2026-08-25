"use client";

import React, { useCallback, useState, useEffect, useMemo } from "react";
import { Handle, Position, NodeProps, Node, useReactFlow } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { ModelParameters } from "./ModelParameters";
import { useWorkflowStore, useProviderApiKeys } from "@/store/workflowStore";
import { deduplicatedFetch } from "@/utils/deduplicatedFetch";
import { GenerateVideoNodeData, ProviderType, SelectedModel, ModelInputDef, RequiredModelParameter } from "@/types";
import { ProviderModel, ModelCapability } from "@/lib/providers/types";
import { ModelSearchDialog } from "@/components/modals/ModelSearchDialog";
import { getVideoDimensions } from "@/utils/nodeDimensions";
import { ProviderBadge } from "./ProviderBadge";
import { useVideoBlobUrl } from "@/hooks/useVideoBlobUrl";
import { useVideoAutoplay } from "@/hooks/useVideoAutoplay";
import { useInlineParameters } from "@/hooks/useInlineParameters";
import { InlineParameterPanel } from "./InlineParameterPanel";
import { SettingsTabBar } from "./SettingsTabBar";
import { browseRegistry } from "@/utils/browseRegistry";
import { downloadMedia } from "@/utils/downloadMedia";
import { useShowHandleLabels } from "@/hooks/useShowHandleLabels";
import { HandleLabel } from "./HandleLabel";
import { useLoadGenerationById } from "@/hooks/useLoadGenerationById";
import { useGenerationCarousel } from "@/hooks/useGenerationCarousel";
import { useAutoResizeOnMedia } from "@/hooks/useAutoResizeOnMedia";
import { GenerationCostBadge } from "./GenerationCostBadge";

// Video generation capabilities
const VIDEO_CAPABILITIES: ModelCapability[] = ["text-to-video", "image-to-video", "audio-to-video"];

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
  const [externalModels, setExternalModels] = useState<ProviderModel[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [modelsFetchError, setModelsFetchError] = useState<string | null>(null);
  const [isBrowseDialogOpen, setIsBrowseDialogOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"primary" | "fallback">("primary");

  useEffect(() => {
    if (!nodeData.fallbackModel && settingsTab === "fallback") {
      setSettingsTab("primary");
    }
  }, [nodeData.fallbackModel, settingsTab]);

  const videoBlobUrl = useVideoBlobUrl(nodeData.outputVideo ?? null);
  const videoAutoplayRef = useVideoAutoplay(id, selected);

  // Inline parameters infrastructure
  const { inlineParametersEnabled } = useInlineParameters();
  const showLabels = useShowHandleLabels(selected);

  // Register browse callback for floating header button
  useEffect(() => {
    browseRegistry.register(id, () => setIsBrowseDialogOpen(true));
    return () => { browseRegistry.unregister(id); };
  }, [id]);

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

  // Inline parameters: compute collapse state and toggle handler
  const isParamsExpanded = nodeData.parametersExpanded ?? true; // default expanded

  const handleToggleParams = useCallback(() => {
    updateNodeData(id, { parametersExpanded: !isParamsExpanded });
  }, [id, isParamsExpanded, updateNodeData]);

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
      updateNodeData(id, { selectedModel: newSelectedModel, parameters: {}, inputSchema: undefined, requiredModelParameters: [] });
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
          requiredModelParameters: [],
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

  const handleRequiredParametersLoaded = useCallback(
    (requiredModelParameters: RequiredModelParameter[]) => {
      updateNodeData(id, { requiredModelParameters });
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
  const loadVideoById = useLoadGenerationById("video", "Video");

  // Carousel navigation handlers
  const {
    isLoading: isLoadingCarouselVideo,
    handlePrevious: handleCarouselPrevious,
    handleNext: handleCarouselNext,
  } = useGenerationCarousel({
    nodeId: id,
    history: nodeData.videoHistory,
    currentIndex: nodeData.selectedVideoHistoryIndex,
    loadFn: loadVideoById,
    buildUpdate: (video, newIndex) => ({
      outputVideo: video,
      selectedVideoHistoryIndex: newIndex,
      status: "idle",
      error: null,
    }),
    // Failed attempts have no stored video; selecting one shows its own error.
    isUnloadable: (item) => Boolean(item.error),
    buildUnloadableUpdate: (item, newIndex) => ({
      outputVideo: null,
      selectedVideoHistoryIndex: newIndex,
      status: "idle",
      error: item.error,
    }),
  });

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
      requiredModelParameters: [],
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

  const hasCarouselVideos = (nodeData.videoHistory || []).length > 1;
  const activeHistoryItem = nodeData.videoHistory?.[nodeData.selectedVideoHistoryIndex || 0];
  const activeGenerationCost = activeHistoryItem?.generationCost;
  // A failure belongs to the attempt that produced it. When history exists the
  // selected entry decides what is shown, so earlier successes stay clean and
  // only the failed attempt carries its message.
  const activeEntryFailed = Boolean(activeHistoryItem?.error);
  const failureMessage = activeHistoryItem
    ? activeHistoryItem.error ?? null
    : nodeData.status === "error"
      ? nodeData.error || "Generation failed"
      : null;
  const showGenerationCost =
    activeGenerationCost?.provider === "fal" &&
    nodeData.status !== "loading" &&
    !activeEntryFailed;

  // Auto-resize node when output video changes
  useAutoResizeOnMedia(id, nodeData.outputVideo, getVideoDimensions);

  return (
    <>
    <BaseNode
      id={id}
      selected={selected}
      isExecuting={isRunning}
      hasError={nodeData.status === "error"}
      fullBleed
      settingsExpanded={inlineParametersEnabled && isParamsExpanded}
      aspectFitMedia={nodeData.outputVideo}
      settingsPanel={inlineParametersEnabled ? (
        <InlineParameterPanel
          expanded={isParamsExpanded}
          onToggle={handleToggleParams}
          nodeId={id}
        >
          {/* Tab bar for primary/fallback settings */}
          {nodeData.fallbackModel && (
            <SettingsTabBar
              activeTab={settingsTab}
              onTabChange={setSettingsTab}
              primaryLabel={nodeData.selectedModel?.displayName || "Primary"}
              fallbackLabel={nodeData.fallbackModel.displayName}
            />
          )}

          {/* Primary tab: external provider parameters */}
          {settingsTab === "primary" && nodeData.selectedModel?.modelId && (
            <ModelParameters
              modelId={nodeData.selectedModel.modelId}
              provider={currentProvider}
              parameters={nodeData.parameters || {}}
              onParametersChange={handleParametersChange}
              onInputsLoaded={handleInputsLoaded}
              onRequiredParametersLoaded={handleRequiredParametersLoaded}
            />
          )}

          {/* Fallback tab: fallback model parameters */}
          {settingsTab === "fallback" && nodeData.fallbackModel && (
            <ModelParameters
              modelId={nodeData.fallbackModel.modelId}
              provider={nodeData.fallbackModel.provider}
              parameters={nodeData.fallbackParameters || {}}
              onParametersChange={(p) => updateNodeData(id, { fallbackParameters: p })}
            />
          )}
        </InlineParameterPanel>
      ) : undefined}
    >
      {/* Dynamic input handles based on model schema */}
      {nodeData.inputSchema && nodeData.inputSchema.length > 0 ? (
        // Render handles from schema, sorted by type (images first, text second)
        // IMPORTANT: Always render "image" and "text" handles to maintain connection
        // compatibility. Schema may only have text inputs (text-to-video models) but
        // we still need the image handle to preserve connections made before model selection.
        (() => {
          const imageInputs = nodeData.inputSchema!.filter(i => i.type === "image");
          const videoInputs = nodeData.inputSchema!.filter(i => i.type === "video");
          const audioInputs = nodeData.inputSchema!.filter(i => i.type === "audio");
          const textInputs = nodeData.inputSchema!.filter(i => i.type === "text");

          // Always include at least one image and one text handle for connection stability
          const hasImageInput = imageInputs.length > 0;
          const hasVideoInput = videoInputs.length > 0;
          const hasAudioInput = audioInputs.length > 0;
          const hasTextInput = textInputs.length > 0;

          // Build the handles array: schema inputs + fallback defaults if missing
          const handles: Array<{
            id: string;
            type: "image" | "text" | "audio" | "video";
            label: string;
            schemaName: string | null;
            description: string | null;
            isPlaceholder: boolean;
          }> = [];

          // Add image handles from schema, or a placeholder if none exist
          if (hasImageInput) {
            imageInputs.forEach((input, index) => {
              handles.push({
                id: `image-${index}`,
                type: "image",
                label: input.label,
                schemaName: input.name,
                description: input.description || null,
                isPlaceholder: false,
              });
            });
          } else {
            handles.push({
              id: "image",
              type: "image",
              label: "Image",
              schemaName: null,
              description: "Not used by this model",
              isPlaceholder: true,
            });
          }

          // Add video handles from schema, or a placeholder if none exist, so a
          // video source can always be attached (e.g. before model selection).
          if (hasVideoInput) {
            videoInputs.forEach((input, index) => {
              handles.push({
                id: `video-${index}`,
                type: "video",
                label: input.label,
                schemaName: input.name,
                description: input.description || null,
                isPlaceholder: false,
              });
            });
          } else {
            handles.push({
              id: "video",
              type: "video",
              label: "Video",
              schemaName: null,
              description: "Not used by this model",
              isPlaceholder: true,
            });
          }

          // Add audio handles from schema (no placeholder — audio is not a default input)
          if (hasAudioInput) {
            audioInputs.forEach((input, index) => {
              handles.push({
                id: `audio-${index}`,
                type: "audio",
                label: input.label,
                schemaName: input.name,
                description: input.description || null,
                isPlaceholder: false,
              });
            });
          }

          // Add text handles from schema, or a placeholder if none exist
          if (hasTextInput) {
            textInputs.forEach((input, index) => {
              handles.push({
                id: `text-${index}`,
                type: "text",
                label: input.label,
                schemaName: input.name,
                description: input.description || null,
                isPlaceholder: false,
              });
            });
          } else {
            handles.push({
              id: "text",
              type: "text",
              label: "Prompt",
              schemaName: null,
              description: "Not used by this model",
              isPlaceholder: true,
            });
          }

          // Calculate positions: group by type order (image, video, audio, text)
          // with a one-slot gap between adjacent non-empty groups.
          const orderedGroups = [
            { type: "image", handles: handles.filter(h => h.type === "image") },
            { type: "video", handles: handles.filter(h => h.type === "video") },
            { type: "audio", handles: handles.filter(h => h.type === "audio") },
            { type: "text", handles: handles.filter(h => h.type === "text") },
          ].filter(g => g.handles.length > 0);

          const groupCount = orderedGroups.length;
          const totalSlots =
            orderedGroups.reduce((sum, g) => sum + g.handles.length, 0) +
            Math.max(0, groupCount - 1); // gaps between groups

          // Assign each handle a slot index, inserting a gap between groups
          const slotById = new Map<string, number>();
          let slotCursor = 0;
          orderedGroups.forEach((group, groupIndex) => {
            if (groupIndex > 0) slotCursor += 1; // gap before this group
            group.handles.forEach((h) => {
              slotById.set(h.id, slotCursor);
              slotCursor += 1;
            });
          });

          const getHandleColor = (type: string) => {
            if (type === "image") return "var(--handle-color-image)";
            if (type === "video") return "var(--handle-color-video)";
            if (type === "audio") return "var(--handle-color-audio)";
            return "var(--handle-color-text)";
          };

          const renderedHandles = handles.map((handle) => {
            const adjustedIndex = slotById.get(handle.id) ?? 0;
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
                <HandleLabel label={handle.label} side="target" color={getHandleColor(handle.type)} top={`calc(${topPercent}% - 18px)`} visible={showLabels} opacity={handle.isPlaceholder ? 0.3 : 1} />
              </React.Fragment>
            );
          });

          // Add hidden backward-compatibility handles for edges using non-indexed IDs
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
              {hasVideoInput && (
                <Handle
                  type="target"
                  position={Position.Left}
                  id="video"
                  style={{ top: "42%", opacity: 0, pointerEvents: "none" }}
                  isConnectable={false}
                />
              )}
              {hasAudioInput && (
                <Handle
                  type="target"
                  position={Position.Left}
                  id="audio"
                  style={{ top: "50%", opacity: 0, pointerEvents: "none" }}
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
          <HandleLabel label="Image" side="target" color="var(--handle-color-image)" top="calc(35% - 18px)" visible={showLabels} />
          <Handle
            type="target"
            position={Position.Left}
            id="video"
            style={{ top: "50%", zIndex: 10 }}
            data-handletype="video"
            isConnectable={true}
          />
          {/* Default video label */}
          <HandleLabel label="Video" side="target" color="var(--handle-color-video)" top="calc(50% - 18px)" visible={showLabels} />
          <Handle
            type="target"
            position={Position.Left}
            id="text"
            style={{ top: "65%", zIndex: 10 }}
            data-handletype="text"
          />
          {/* Default text label */}
          <HandleLabel label="Prompt" side="target" color="var(--handle-color-text)" top="calc(65% - 18px)" visible={showLabels} />
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
      <HandleLabel label="Video" side="source" color="var(--handle-color-video)" visible={showLabels} />

      <div className="relative w-full h-full min-h-0 overflow-hidden rounded-lg">
        {/* Preview area */}
        {nodeData.outputVideo || activeEntryFailed ? (
          <>
            {nodeData.outputVideo ? (
              <video
                ref={videoAutoplayRef}
                key={activeHistoryItem?.id}
                src={videoBlobUrl ?? undefined}
                controls
                loop
                muted
                className="w-full h-full object-cover"
                playsInline
              />
            ) : (
              <div className="w-full h-full bg-neutral-900/40" />
            )}
            {(showGenerationCost || nodeData.__usedFallback) && (
              <div className="absolute top-1 left-1 z-10 flex flex-col items-start gap-1">
                {showGenerationCost && activeGenerationCost && (
                  <GenerationCostBadge receipt={activeGenerationCost} />
                )}
                {nodeData.__usedFallback && (
                  <div
                    className="px-1.5 py-0.5 rounded bg-emerald-900/70 text-emerald-300 text-[9px] font-medium pointer-events-auto"
                    title={`Primary failed: ${nodeData.__primaryError ?? "unknown"}\nUsed fallback: ${nodeData.__fallbackModelUsed ?? ""}`}
                  >
                    Fallback used
                  </div>
                )}
              </div>
            )}
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
            {activeEntryFailed && (
              <div className="absolute inset-0 bg-red-900/40 flex flex-col items-center justify-center gap-1 px-3">
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
                {failureMessage && (
                  <span
                    className="text-white/70 text-[10px] text-center line-clamp-3"
                    title={failureMessage}
                  >
                    {failureMessage}
                  </span>
                )}
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
            {/* Download + Clear buttons */}
            <div className="absolute top-1 right-1 flex items-center gap-0.5">
              {nodeData.outputVideo && (
                <button
                  onClick={() => downloadMedia(nodeData.outputVideo!, "video").catch(() => {})}
                  className="w-5 h-5 bg-neutral-900/80 hover:bg-neutral-700 rounded flex items-center justify-center text-neutral-400 hover:text-white transition-colors"
                  title="Download video"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                </button>
              )}
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
              <div className="absolute bottom-0 left-0 right-0 flex items-center justify-center gap-2 py-1.5 bg-neutral-900/80">
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

    {/* Hidden ModelParameters — only for schema-loading side effect (dynamic handles) when inline disabled */}
    {!inlineParametersEnabled && nodeData.selectedModel?.modelId && (
      <div className="hidden">
        <ModelParameters
          modelId={nodeData.selectedModel.modelId}
          provider={currentProvider}
          parameters={nodeData.parameters || {}}
          onParametersChange={handleParametersChange}
          onExpandChange={handleParametersExpandChange}
          onInputsLoaded={handleInputsLoaded}
          onRequiredParametersLoaded={handleRequiredParametersLoaded}
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
