"use client";

import React, { useCallback, useState, useEffect, useMemo } from "react";
import { NodeProps, Node } from "@xyflow/react";
import { NodeShell } from "./NodeShell";
import { ModelParameters } from "./ModelParameters";
import { useSchemaDerived } from "./schemaDerived";
import { useWorkflowStore, useProviderApiKeys } from "@/store/workflowStore";
import { deduplicatedFetch } from "@/utils/deduplicatedFetch";
import { GenerateVideoNodeData, ProviderType } from "@/types";
import { ProviderModel, ModelCapability } from "@/lib/providers/types";
import { ModelSearchDialog } from "@/components/modals/ModelSearchDialog";
import { modelSelectionData } from "@/store/utils/modelSelection";
import { ProviderBadge } from "./ProviderBadge";
import { useVideoBlobUrl } from "@/hooks/useVideoBlobUrl";
import { useVideoAutoplay } from "@/hooks/useVideoAutoplay";
import { SettingsTabBar } from "./SettingsTabBar";
import { browseRegistry } from "@/utils/browseRegistry";
import { downloadMedia } from "@/utils/downloadMedia";
import { useLoadGenerationById } from "@/hooks/useLoadGenerationById";
import { useGenerationCarousel } from "@/hooks/useGenerationCarousel";
import { useErrorToast } from "@/hooks/useErrorToast";
import {
  CarouselControls,
  RunBatchChip,
  ControlsCard,
  EmptyState,
  ErrorMessage,
  ErrorOverlay,
  PendingTaskNotice,
  LoadingOverlay,
  ScrubRow,
  Spinner,
  schemaSockets,
  type SocketSpec,
} from "./ui";
import { Download, X } from "lucide-react";
import { useHoldLive, useIsPaintedNode, useUpdateNodeData, useNodeUiState } from "./paintMode";

// Video generation capabilities
const VIDEO_CAPABILITIES: ModelCapability[] = ["text-to-video", "image-to-video", "audio-to-video", "video-to-video"];

const OUTPUT_SOCKETS: SocketSpec[] = [{ id: "video", type: "video", label: "Video" }];

type GenerateVideoNodeType = Node<GenerateVideoNodeData, "generateVideo">;

export function GenerateVideoNode({ id, data, selected }: NodeProps<GenerateVideoNodeType>) {
  const nodeData = data;
  const updateNodeData = useUpdateNodeData();
  // Use stable selector for API keys to prevent unnecessary re-fetches
  const { geminiApiKey, replicateApiKey, falApiKey, kieApiKey, comfyApiKey } = useProviderApiKeys();
  const [, setExternalModels] = useState<ProviderModel[]>([]);
  const [, setIsLoadingModels] = useState(false);
  const [, setModelsFetchError] = useState<string | null>(null);
  const [isBrowseDialogOpen, setIsBrowseDialogOpen] = useState(false);
  useHoldLive(isBrowseDialogOpen);
  const painted = useIsPaintedNode();
  const [settingsTab, setSettingsTab] = useNodeUiState<"primary" | "fallback">(id, "settingsTab", "primary");
  // The clip follows the video's real proportions once its metadata arrives.
  const [loadedAspect, setLoadedAspect] = useState<{ src: string; aspect: number } | null>(null);

  useEffect(() => {
    if (!nodeData.fallbackModel && settingsTab === "fallback") {
      setSettingsTab("primary");
    }
  }, [nodeData.fallbackModel, settingsTab]);

  const videoBlobUrl = useVideoBlobUrl(nodeData.outputVideo ?? null);
  const videoAutoplayRef = useVideoAutoplay(id, videoBlobUrl);

  // Register browse callback for floating header button
  useEffect(() => {
    // A painted copy would replace the live node's handler, then remove it as it unmounts.
    if (painted) return;
    browseRegistry.register(id, () => setIsBrowseDialogOpen(true));
    return () => { browseRegistry.unregister(id); };
  }, [id, painted]);

  const currentProvider: ProviderType = nodeData.selectedModel?.provider || "fal";

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
      console.error("Failed to fetch video models:", error);
      setExternalModels([]);
      setModelsFetchError("Failed to load models. Check your connection.");
    } finally {
      setIsLoadingModels(false);
    }
  }, [currentProvider, geminiApiKey, replicateApiKey, falApiKey, kieApiKey, comfyApiKey]);

  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  const isParamsExpanded = nodeData.parametersExpanded ?? true; // default expanded

  const handleToggleParams = useCallback(() => {
    updateNodeData(id, { parametersExpanded: !isParamsExpanded });
  }, [id, isParamsExpanded, updateNodeData]);

  const handleClearVideo = useCallback(() => {
    updateNodeData(id, { outputVideo: null, status: "idle", error: null });
  }, [id, updateNodeData]);

  const handleParametersChange = useCallback(
    (parameters: Record<string, unknown>) => {
      updateNodeData(id, { parameters });
    },
    [id, updateNodeData]
  );

  // The schema's inputs (sockets) and defaults, stored from a painted copy too (schemaDerived.ts).
  const schemaDerived = useSchemaDerived(id, nodeData);

  const isRunning = useWorkflowStore((state) => state.isRunning);
  const resumeGeneration = useWorkflowStore((state) => state.resumeGeneration);
  // A provider request the node stopped waiting on, offered to pick up again
  const pendingTask = nodeData.status === "loading" ? undefined : nodeData.pendingTask;

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
  });

  // Handle model selection from browse dialog
  const handleBrowseModelSelect = useCallback((model: ProviderModel) => {
    // A Veo model brings its input schema so the handles render in the same update
    updateNodeData(id, modelSelectionData("generateVideo", model));
    setIsBrowseDialogOpen(false);
  }, [id, updateNodeData]);

  // Dynamic title based on selected model - just the model name
  const displayTitle = useMemo(() => {
    if (nodeData.selectedModel?.displayName && nodeData.selectedModel.modelId) {
      return nodeData.selectedModel.displayName;
    }
    return "Select model...";
  }, [nodeData.selectedModel?.displayName, nodeData.selectedModel?.modelId]);

  const hasCarouselVideos = (nodeData.videoHistory || []).length > 1;

  // Show toast when generation fails
  useErrorToast(nodeData.status, nodeData.error, "Video generation failed");

  const inputSockets = useMemo(
    () => schemaSockets(nodeData.inputSchema, { videoPlaceholder: true }),
    [nodeData.inputSchema]
  );

  const mediaAspect =
    nodeData.outputVideo && loadedAspect?.src === nodeData.outputVideo ? loadedAspect.aspect : 16 / 9;

  const hasSettings = Boolean(nodeData.selectedModel?.modelId || nodeData.fallbackModel);

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

      {/* Primary tab: external provider parameters. Stays mounted while
          collapsed so the schema fetch (which defines the sockets) still runs. */}
      {settingsTab === "primary" && nodeData.selectedModel?.modelId && (
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

  const historyNav = hasCarouselVideos ? (
    <CarouselControls
      index={nodeData.selectedVideoHistoryIndex || 0}
      count={(nodeData.videoHistory || []).length}
      onPrev={handleCarouselPrevious}
      onNext={handleCarouselNext}
      loading={isLoadingCarouselVideo}
      noun="video"
      compact
    />
  ) : null;

  return (
    <>
    <NodeShell
      id={id}
      selected={selected}
      isExecuting={isRunning}
      hasError={nodeData.status === "error" && !pendingTask}
      media={{ kind: "aspect", aspect: mediaAspect }}
      inputs={inputSockets}
      outputs={OUTPUT_SOCKETS}
      mediaClassName="group"
      gap={
        nodeData.outputVideo ? (
          <ScrubRow videoRef={videoAutoplayRef} src={videoBlobUrl} className="w-full" trailing={historyNav} />
        ) : (
          historyNav ?? undefined
        )
      }
      controls={
        <ControlsCard
          id={id}
          summary={{ icon: <ProviderBadge provider={currentProvider} />, title: displayTitle }}
          expanded={isParamsExpanded}
          onToggle={handleToggleParams}
        >
          {settings}
        </ControlsCard>
      }
    >
      {nodeData.outputVideo ? (
        <>
          <video
            ref={videoAutoplayRef}
            src={videoBlobUrl ?? undefined}
            loop
            muted
            playsInline
            className="absolute inset-0 w-full h-full object-cover"
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              if (v.videoWidth > 0 && v.videoHeight > 0 && nodeData.outputVideo) {
                setLoadedAspect({ src: nodeData.outputVideo, aspect: v.videoWidth / v.videoHeight });
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
          {isLoadingCarouselVideo && <LoadingOverlay size={16} dim="light" />}
          <RunBatchChip
            batch={nodeData.videoHistory?.[nodeData.selectedVideoHistoryIndex || 0]?.batch}
            timestamp={nodeData.videoHistory?.[nodeData.selectedVideoHistoryIndex || 0]?.timestamp}
          />
          {pendingTask && <PendingTaskNotice task={pendingTask} onPickUp={() => resumeGeneration(id)} disabled={isRunning} />}
          <div className="absolute top-1 right-1 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
            <button
              onClick={() => downloadMedia(nodeData.outputVideo!, "video").catch(() => {})}
              className="w-5 h-5 bg-neutral-900/80 hover:bg-neutral-700 rounded flex items-center justify-center text-neutral-400 hover:text-white transition-colors"
              title="Download video"
            >
              <Download size={12} strokeWidth={2} />
            </button>
            <button
              onClick={handleClearVideo}
              className="w-5 h-5 bg-neutral-900/80 hover:bg-red-600/80 rounded flex items-center justify-center text-neutral-400 hover:text-white transition-colors"
              title="Clear video"
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
        <EmptyState message="Run to generate" hint="Connect inputs and run" />
      )}
    </NodeShell>

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
