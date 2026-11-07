"use client";

import React, { useCallback, useState, useEffect, useMemo } from "react";
import { NodeProps, Node } from "@xyflow/react";
import { NodeShell } from "./NodeShell";
import { ModelParameters } from "./ModelParameters";
import { useSchemaDerived } from "./schemaDerived";
import { useWorkflowStore, saveNanoBananaDefaults, useProviderApiKeys } from "@/store/workflowStore";
import { deduplicatedFetch } from "@/utils/deduplicatedFetch";
import { NanoBananaNodeData, AspectRatio, Resolution, MODEL_DISPLAY_NAMES, ProviderType, SelectedModel, GEMINI_IMAGE_MODELS, ModelType, geminiImageOptions } from "@/types";
import { ProviderModel, ModelCapability } from "@/lib/providers/types";
import { ModelSearchDialog } from "@/components/modals/ModelSearchDialog";
import { modelSelectionData } from "@/store/utils/modelSelection";
import { ProviderBadge } from "./ProviderBadge";
import { SettingsTabBar } from "./SettingsTabBar";
import { browseRegistry } from "@/utils/browseRegistry";
import { useAdaptiveImageSrc } from "@/hooks/useAdaptiveImageSrc";
import { downloadMedia } from "@/utils/downloadMedia";
import { useLoadGenerationById } from "@/hooks/useLoadGenerationById";
import { useGenerationCarousel } from "@/hooks/useGenerationCarousel";
import { useErrorToast } from "@/hooks/useErrorToast";
import { parseAspectRatio } from "@/utils/nodeDimensions";
import { calculateGenerationCost, formatCost } from "@/utils/costCalculator";
import {
  CarouselControls,
  RunBatchChip,
  CheckboxField,
  ControlsCard,
  EmptyState,
  ErrorMessage,
  ErrorOverlay,
  PendingTaskNotice,
  LoadingOverlay,
  SelectField,
  Spinner,
  SummaryValues,
  type SocketSpec,
} from "./ui";
import { Download, X } from "lucide-react";
import { useHoldLive, useIsPaintedNode, useUpdateNodeData, useNodeUiState } from "./paintMode";

const INPUT_SOCKETS: SocketSpec[] = [
  { id: "image", type: "image", label: "Image" },
  { id: "text", type: "text", label: "Prompt", dataTutorial: "generate-text-input-handle" },
];
const OUTPUT_SOCKETS: SocketSpec[] = [{ id: "image", type: "image", label: "Image" }];

// Image generation capabilities
const IMAGE_CAPABILITIES: ModelCapability[] = ["text-to-image", "image-to-image"];

type NanoBananaNodeType = Node<NanoBananaNodeData, "nanoBanana">;

export function GenerateImageNode({ id, data, selected }: NodeProps<NanoBananaNodeType>) {
  const nodeData = data;
  const adaptiveOutputImage = useAdaptiveImageSrc(data.outputImage, id);
  const updateNodeData = useUpdateNodeData();
  // Use stable selector for API keys to prevent unnecessary re-fetches
  const { replicateApiKey, falApiKey, kieApiKey, openaiApiKey, comfyApiKey, comfyEnabled, replicateEnabled, kieEnabled, openaiEnabled } = useProviderApiKeys();
  const [externalModels, setExternalModels] = useState<ProviderModel[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [modelsFetchError, setModelsFetchError] = useState<string | null>(null);
  const [isBrowseDialogOpen, setIsBrowseDialogOpen] = useState(false);
  useHoldLive(isBrowseDialogOpen);
  const painted = useIsPaintedNode();
  const [settingsTab, setSettingsTab] = useNodeUiState<"primary" | "fallback">(id, "settingsTab", "primary");

  useEffect(() => {
    if (!nodeData.fallbackModel && settingsTab === "fallback") {
      setSettingsTab("primary");
    }
  }, [nodeData.fallbackModel, settingsTab]);

  // The clip follows the generated image's real proportions once it has
  // loaded; until then (and with no image) it follows the configured ratio.
  const [loadedAspect, setLoadedAspect] = useState<{ src: string; aspect: number } | null>(null);
  // Comfy Router models can declare several image inputs (a mask, a garment);
  // the first uses the fixed "image" socket and the rest get their own
  // (`image-N` maps to the Nth image input in connectedInputs). Other
  // providers keep the node's static image and prompt sockets.
  const inputSockets = useMemo<SocketSpec[]>(() => {
    if (nodeData.selectedModel?.provider !== "comfy") return INPUT_SOCKETS;
    const images = (nodeData.inputSchema ?? []).filter((input) => input.type === "image");
    if (images.length === 0) return INPUT_SOCKETS;
    return [
      ...images.map((input, index): SocketSpec => ({
        id: index === 0 ? "image" : `image-${index}`,
        type: "image",
        label: input.label,
        schemaName: input.name,
        title: input.description || input.label,
      })),
      INPUT_SOCKETS[1],
    ];
  }, [nodeData.inputSchema, nodeData.selectedModel?.provider]);

  // Register browse callback for floating header button
  useEffect(() => {
    // A painted copy would replace the live node's handler, then remove it as it unmounts.
    if (painted) return;
    browseRegistry.register(id, () => setIsBrowseDialogOpen(true));
    return () => { browseRegistry.unregister(id); };
  }, [id, painted]);

  // Get the current selected provider (default to gemini)
  const currentProvider: ProviderType = nodeData.selectedModel?.provider || "gemini";

  // Get enabled providers
  const enabledProviders = useMemo(() => {
    const providers: { id: ProviderType; name: string }[] = [];
    // Gemini is always available
    providers.push({ id: "gemini", name: "Gemini" });
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
    // Add OpenAI if configured
    if (openaiEnabled && openaiApiKey) {
      providers.push({ id: "openai", name: "OpenAI" });
    }
    // Add ComfyUI (Comfy Router) if a key is available (its own or the Comfy Cloud key)
    if (comfyEnabled && comfyApiKey) {
      providers.push({ id: "comfy", name: "ComfyUI" });
    }
    return providers;
  }, [replicateEnabled, replicateApiKey, kieEnabled, kieApiKey, openaiEnabled, openaiApiKey, comfyEnabled, comfyApiKey]);

  // Migrate legacy data: derive selectedModel from model field if missing
  useEffect(() => {
    if (nodeData.model && !nodeData.selectedModel) {
      const displayName = MODEL_DISPLAY_NAMES[nodeData.model] || nodeData.model;
      const newSelectedModel: SelectedModel = {
        provider: "gemini",
        modelId: nodeData.model,
        displayName,
      };
      updateNodeData(id, { selectedModel: newSelectedModel });
    }
  }, [id, nodeData.model, nodeData.selectedModel, updateNodeData]);

  // Fetch models from external providers when provider changes
  const fetchModels = useCallback(async () => {
    if (currentProvider === "gemini") {
      setExternalModels([]);
      setModelsFetchError(null);
      return;
    }

    setIsLoadingModels(true);
    setModelsFetchError(null);
    try {
      const capabilities = IMAGE_CAPABILITIES.join(",");
      const headers: HeadersInit = {};
      if (replicateApiKey) {
        headers["X-Replicate-Key"] = replicateApiKey;
      }
      if (falApiKey) {
        headers["X-Fal-Key"] = falApiKey;
      }
      if (kieApiKey) {
        headers["X-Kie-Key"] = kieApiKey;
      }
      if (openaiApiKey) {
        headers["X-OpenAI-API-Key"] = openaiApiKey;
      }
      if (comfyApiKey) {
        headers["X-Comfy-Router-Key"] = comfyApiKey;
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
      console.error("Failed to fetch models:", error);
      setExternalModels([]);
      setModelsFetchError("Failed to load models. Check your connection.");
    } finally {
      setIsLoadingModels(false);
    }
  }, [currentProvider, replicateApiKey, falApiKey, kieApiKey, openaiApiKey, comfyApiKey]);

  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  // Inline parameters: compute collapse state and toggle handler
  const isParamsExpanded = nodeData.parametersExpanded ?? true; // default expanded

  const handleToggleParams = useCallback(() => {
    updateNodeData(id, { parametersExpanded: !isParamsExpanded });
  }, [id, isParamsExpanded, updateNodeData]);

  const handleAspectRatioChange = useCallback(
    (value: string) => {
      const aspectRatio = value as AspectRatio;
      updateNodeData(id, { aspectRatio });
      saveNanoBananaDefaults({ aspectRatio });
    },
    [id, updateNodeData]
  );

  const handleResolutionChange = useCallback(
    (value: string) => {
      const resolution = value as Resolution;
      updateNodeData(id, { resolution });
      saveNanoBananaDefaults({ resolution });
    },
    [id, updateNodeData]
  );

  const handleModelChange = useCallback(
    (value: string) => {
      const model = value as ModelType;
      updateNodeData(id, { model });
      saveNanoBananaDefaults({ model });

      // Also update selectedModel for consistency
      const newSelectedModel: SelectedModel = {
        provider: "gemini",
        modelId: model,
        displayName: GEMINI_IMAGE_MODELS.find(m => m.value === model)?.label || model,
      };
      updateNodeData(id, { selectedModel: newSelectedModel });
    },
    [id, updateNodeData]
  );

  const handleGoogleSearchToggle = useCallback(
    (useGoogleSearch: boolean) => {
      updateNodeData(id, { useGoogleSearch });
      saveNanoBananaDefaults({ useGoogleSearch });
    },
    [id, updateNodeData]
  );

  const handleImageSearchToggle = useCallback(
    (useImageSearch: boolean) => {
      updateNodeData(id, { useImageSearch });
      saveNanoBananaDefaults({ useImageSearch });
    },
    [id, updateNodeData]
  );

  const handleParametersChange = useCallback(
    (parameters: Record<string, unknown>) => {
      updateNodeData(id, { parameters });
    },
    [id, updateNodeData]
  );

  // The schema's inputs (sockets) and defaults, stored from a painted copy too (schemaDerived.ts).
  const schemaDerived = useSchemaDerived(id, nodeData);

  const handleClearImage = useCallback(() => {
    updateNodeData(id, { outputImage: null, status: "idle", error: null });
  }, [id, updateNodeData]);

  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const isRunning = useWorkflowStore((state) => state.isRunning);
  const resumeGeneration = useWorkflowStore((state) => state.resumeGeneration);
  // A provider request the node stopped waiting on, offered to pick up again
  const pendingTask = nodeData.status === "loading" ? undefined : nodeData.pendingTask;

  const handleRegenerate = useCallback(() => {
    regenerateNode(id);
  }, [id, regenerateNode]);

  const loadImageById = useLoadGenerationById("image", "Image");

  const {
    isLoading: isLoadingCarouselImage,
    handlePrevious: handleCarouselPrevious,
    handleNext: handleCarouselNext,
  } = useGenerationCarousel({
    nodeId: id,
    history: nodeData.imageHistory,
    currentIndex: nodeData.selectedHistoryIndex,
    loadFn: loadImageById,
    buildUpdate: (image, newIndex) => ({
      outputImage: image,
      selectedHistoryIndex: newIndex,
      status: "idle",
      error: null,
    }),
  });

  // Handle model selection from browse dialog
  const handleBrowseModelSelect = useCallback((model: ProviderModel) => {
    updateNodeData(id, modelSelectionData("nanoBanana", model));
    setIsBrowseDialogOpen(false);
  }, [id, updateNodeData]);

  const isGeminiProvider = currentProvider === "gemini";

  // Dynamic title based on selected model - just the model name
  const displayTitle = useMemo(() => {
    if (nodeData.selectedModel?.displayName && nodeData.selectedModel.modelId) {
      return nodeData.selectedModel.displayName;
    }
    // Fallback for legacy data or no model selected
    if (nodeData.model) {
      return GEMINI_IMAGE_MODELS.find(m => m.value === nodeData.model)?.label || nodeData.model;
    }
    return "Select model...";
  }, [nodeData.selectedModel?.displayName, nodeData.selectedModel?.modelId, nodeData.model]);

  // Use selectedModel.modelId for Gemini models, fallback to legacy model field
  const currentModelId = isGeminiProvider ? (nodeData.selectedModel?.modelId || nodeData.model) : null;
  const modelOptions = geminiImageOptions(currentModelId);
  const supportsResolution = modelOptions.resolutions.length > 0;
  const hasCarouselImages = (nodeData.imageHistory || []).length > 1;

  // Show toast when generation fails
  useErrorToast(nodeData.status, nodeData.error, "Generation failed");

  const selectedHistoryItem = (nodeData.imageHistory || [])[nodeData.selectedHistoryIndex || 0];
  const openaiSize = nodeData.selectedModel?.provider === "openai" && typeof nodeData.parameters?.size === "string" && nodeData.parameters.size !== "auto"
    ? nodeData.parameters.size : undefined;
  const configuredAspect = parseAspectRatio(
    (nodeData.outputImage && (selectedHistoryItem?.generation?.size || selectedHistoryItem?.aspectRatio)) || openaiSize || nodeData.aspectRatio || "1:1"
  );
  const mediaAspect =
    nodeData.outputImage && loadedAspect?.src === nodeData.outputImage ? loadedAspect.aspect : configuredAspect;

  const estimatedCost = useMemo(() => {
    if (!isGeminiProvider || !currentModelId) return null;
    try {
      return formatCost(calculateGenerationCost(currentModelId as ModelType, nodeData.resolution || "2K"));
    } catch {
      return null;
    }
  }, [isGeminiProvider, currentModelId, nodeData.resolution]);

  const summaryValues = isGeminiProvider
    ? [nodeData.aspectRatio || "1:1", supportsResolution ? nodeData.resolution || "2K" : null]
    : [];

  const hasSettings = Boolean(
    (isGeminiProvider && currentModelId) || (!isGeminiProvider && nodeData.selectedModel?.modelId) || nodeData.fallbackModel
  );

  const settings = hasSettings ? (
    <>
      {nodeData.fallbackModel && (
        <SettingsTabBar
          activeTab={settingsTab}
          onTabChange={setSettingsTab}
          primaryLabel={nodeData.selectedModel?.displayName || "Primary"}
          fallbackLabel={nodeData.fallbackModel.displayName}
        />
      )}

      {settingsTab === "primary" && isGeminiProvider && currentModelId && (
        <>
          <SelectField
            label="Model"
            value={currentModelId}
            options={GEMINI_IMAGE_MODELS.map((m) => ({ value: m.value, label: m.label }))}
            onChange={handleModelChange}
            data-tutorial="generate-model-selector"
          />
          <SelectField
            label="Aspect ratio"
            value={nodeData.aspectRatio || "1:1"}
            options={modelOptions.aspectRatios}
            onChange={handleAspectRatioChange}
          />
          {supportsResolution && (
            <SelectField
              label="Resolution"
              value={nodeData.resolution || "2K"}
              options={modelOptions.resolutions}
              onChange={handleResolutionChange}
            />
          )}
          {modelOptions.googleSearch && (
            <CheckboxField label="Google Search" checked={nodeData.useGoogleSearch || false} onChange={handleGoogleSearchToggle} />
          )}
          {modelOptions.imageSearch && (
            <CheckboxField label="Image Search" checked={nodeData.useImageSearch || false} onChange={handleImageSearchToggle} />
          )}
        </>
      )}

      {settingsTab === "primary" && !isGeminiProvider && nodeData.selectedModel?.modelId && (
        <ModelParameters
          modelId={nodeData.selectedModel.modelId}
          provider={currentProvider}
          parameters={nodeData.parameters || {}}
          onParametersChange={handleParametersChange}
          onInputsLoaded={schemaDerived.inputsLoaded}
          onDefaults={schemaDerived.defaults}
        />
      )}

      {settingsTab === "fallback" && nodeData.fallbackModel && (
        <ModelParameters
          modelId={nodeData.fallbackModel.modelId}
          provider={nodeData.fallbackModel.provider}
          parameters={nodeData.fallbackParameters || {}}
          onParametersChange={(p) => updateNodeData(id, { fallbackParameters: p })}
          slot="fallback"
          onDefaults={schemaDerived.fallbackDefaults}
        />
      )}
    </>
  ) : undefined;

  return (
    <>
    <NodeShell
      id={id}
      selected={selected}
      isExecuting={isRunning}
      hasError={nodeData.status === "error" && !pendingTask}
      dataTutorial="generate-image-node"
      media={{ kind: "aspect", aspect: mediaAspect }}
      inputs={inputSockets}
      outputs={OUTPUT_SOCKETS}
      mediaClassName="group"
      gap={
        hasCarouselImages ? (
          <CarouselControls
            index={nodeData.selectedHistoryIndex || 0}
            count={(nodeData.imageHistory || []).length}
            onPrev={handleCarouselPrevious}
            onNext={handleCarouselNext}
            loading={isLoadingCarouselImage}
            noun="image"
          />
        ) : undefined
      }
      controls={
        <ControlsCard
          id={id}
          summary={{
            icon: <ProviderBadge provider={currentProvider} />,
            title: displayTitle,
            values: <SummaryValues items={summaryValues} />,
          }}
          expanded={isParamsExpanded}
          onToggle={handleToggleParams}
        >
          {settings}
        </ControlsCard>
      }
    >
      <div className="absolute inset-0" data-tutorial="generate-output-area">
        {nodeData.outputImage ? (
          <>
            <img
              src={adaptiveOutputImage ?? undefined}
              alt="Generated"
              className="absolute inset-0 w-full h-full object-cover"
              onLoad={(e) => {
                const img = e.currentTarget;
                if (img.naturalWidth > 0 && img.naturalHeight > 0 && nodeData.outputImage) {
                  setLoadedAspect({ src: nodeData.outputImage, aspect: img.naturalWidth / img.naturalHeight });
                }
              }}
            />
            {nodeData.__usedFallback && (
              <div
                className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-emerald-900/70 text-emerald-300 text-[9px] font-medium pointer-events-auto z-10"
                title={`Primary failed: ${nodeData.__primaryError ?? "unknown"}\nUsed fallback: ${nodeData.__fallbackModelUsed ?? ""}`}
              >
                Fallback used
              </div>
            )}
            {nodeData.status === "loading" && <LoadingOverlay />}
            {nodeData.status === "error" && !pendingTask && <ErrorOverlay />}
            {isLoadingCarouselImage && <LoadingOverlay size={16} dim="light" />}
            <RunBatchChip batch={selectedHistoryItem?.batch} timestamp={selectedHistoryItem?.timestamp} />
            {pendingTask && <PendingTaskNotice task={pendingTask} onPickUp={() => resumeGeneration(id)} disabled={isRunning} />}
            <div className="absolute top-1 right-1 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
              <button
                onClick={() => downloadMedia(nodeData.outputImage!, "image").catch(() => {})}
                className="w-5 h-5 bg-neutral-900/80 hover:bg-neutral-700 rounded flex items-center justify-center text-neutral-400 hover:text-white transition-colors"
                title="Download image"
              >
                <Download size={12} strokeWidth={2} />
              </button>
              <button
                onClick={handleClearImage}
                className="w-5 h-5 bg-neutral-900/80 hover:bg-red-600/80 rounded flex items-center justify-center text-neutral-400 hover:text-white transition-colors"
                title="Clear image"
              >
                <X size={12} strokeWidth={2} />
              </button>
            </div>
          </>
        ) : pendingTask ? (
          <PendingTaskNotice task={pendingTask} onPickUp={() => resumeGeneration(id)} disabled={isRunning} />
        ) : nodeData.status === "loading" ? (
          <div className="absolute inset-0 flex items-center justify-center bg-neutral-900/40">
            <Spinner className="text-neutral-400" />
          </div>
        ) : nodeData.status === "error" ? (
          <ErrorMessage message={nodeData.error || "Failed"} />
        ) : (
          <EmptyState message="Run to generate" hint="Connect inputs and run" meta={estimatedCost ? `~${estimatedCost}` : undefined} />
        )}
      </div>
    </NodeShell>

    {/* Model browse dialog */}
    {isBrowseDialogOpen && (
      <ModelSearchDialog
        isOpen={isBrowseDialogOpen}
        onClose={() => setIsBrowseDialogOpen(false)}
        onModelSelected={handleBrowseModelSelect}
        initialCapabilityFilter="image"
      />
    )}
    </>
  );
}

/**
 * @deprecated Use `GenerateImageNode` instead. This alias is kept for backward compatibility
 * with existing workflows but will be removed in a future version.
 */
export { GenerateImageNode as NanoBananaNode };
