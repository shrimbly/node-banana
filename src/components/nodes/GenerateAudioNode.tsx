"use client";

import React, { useCallback, useState, useEffect, useMemo } from "react";
import { NodeProps, Node } from "@xyflow/react";
import { NodeShell } from "./NodeShell";
import { ProviderBadge } from "./ProviderBadge";
import { ModelParameters } from "./ModelParameters";
import { useWorkflowStore } from "@/store/workflowStore";
import { GenerateAudioNodeData, ProviderType, SelectedModel, ModelInputDef } from "@/types";
import { ProviderModel } from "@/lib/providers/types";
import { ModelSearchDialog } from "@/components/modals/ModelSearchDialog";
import { useAudioVisualization } from "@/hooks/useAudioVisualization";
import { useAudioPlayback } from "@/hooks/useAudioPlayback";
import { SettingsTabBar } from "./SettingsTabBar";
import { browseRegistry } from "@/utils/browseRegistry";
import { downloadMedia } from "@/utils/downloadMedia";
import { useLoadGenerationById } from "@/hooks/useLoadGenerationById";
import { useGenerationCarousel } from "@/hooks/useGenerationCarousel";
import {
  CarouselControls,
  ControlsCard,
  EmptyState,
  ErrorMessage,
  Spinner,
  type SocketSpec,
} from "./ui";

const OUTPUT_SOCKETS: SocketSpec[] = [{ id: "audio", type: "audio", label: "Audio" }];
const DEFAULT_INPUTS: SocketSpec[] = [{ id: "text", type: "text", label: "Prompt" }];
const MEDIA_HEIGHT = 96;

type GenerateAudioNodeType = Node<GenerateAudioNodeData, "generateAudio">;

export function GenerateAudioNode({ id, data, selected }: NodeProps<GenerateAudioNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const [isBrowseDialogOpen, setIsBrowseDialogOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"primary" | "fallback">("primary");

  useEffect(() => {
    if (!nodeData.fallbackModel && settingsTab === "fallback") {
      setSettingsTab("primary");
    }
  }, [nodeData.fallbackModel, settingsTab]);

  // Register browse callback for floating header button
  useEffect(() => {
    browseRegistry.register(id, () => setIsBrowseDialogOpen(true));
    return () => { browseRegistry.unregister(id); };
  }, [id]);

  // Get the current selected provider (default to fal)
  const currentProvider: ProviderType = nodeData.selectedModel?.provider || "fal";

  // Convert base64 data URL to Blob for visualization
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const { waveformData, isLoading: isLoadingWaveform } = useAudioVisualization(audioBlob);

  useEffect(() => {
    if (nodeData.outputAudio) {
      fetch(nodeData.outputAudio)
        .then((r) => r.blob())
        .then(setAudioBlob)
        .catch(() => setAudioBlob(null));
    } else {
      setAudioBlob(null);
    }
  }, [nodeData.outputAudio]);

  const {
    audioRef,
    canvasRef,
    waveformContainerRef,
    isPlaying,
    currentTime,
    handlePlayPause,
    handleSeek,
    formatTime,
  } = useAudioPlayback({
    audioSrc: nodeData.outputAudio ?? null,
    waveformData,
    isLoadingWaveform,
  });

  const handleClearAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setAudioBlob(null);
    updateNodeData(id, { outputAudio: null, status: "idle", error: null, duration: null, format: null });
  }, [id, updateNodeData, audioRef]);

  const handleParametersChange = useCallback(
    (parameters: Record<string, unknown>) => {
      updateNodeData(id, { parameters });
    },
    [id, updateNodeData]
  );

  const handleInputsLoaded = useCallback(
    (inputs: ModelInputDef[]) => {
      updateNodeData(id, { inputSchema: inputs });
    },
    [id, updateNodeData]
  );

  const isRunning = useWorkflowStore((state) => state.isRunning);

  // Load audio by ID from generations folder
  const loadAudioById = useLoadGenerationById("audio", "Audio");

  // Carousel navigation handlers
  const {
    isLoading: isLoadingCarouselAudio,
    handlePrevious: handleCarouselPrevious,
    handleNext: handleCarouselNext,
  } = useGenerationCarousel({
    nodeId: id,
    history: nodeData.audioHistory,
    currentIndex: nodeData.selectedAudioHistoryIndex,
    loadFn: loadAudioById,
    buildUpdate: (audio, newIndex) => ({
      outputAudio: audio,
      selectedAudioHistoryIndex: newIndex,
      status: "idle",
      error: null,
    }),
  });

  const handleBrowseModelSelect = useCallback((model: ProviderModel) => {
    const newSelectedModel: SelectedModel = {
      provider: model.provider,
      modelId: model.id,
      displayName: model.name,
    };
    updateNodeData(id, { selectedModel: newSelectedModel, parameters: {} });
    setIsBrowseDialogOpen(false);
  }, [id, updateNodeData]);

  const displayTitle = useMemo(() => {
    if (nodeData.selectedModel?.displayName && nodeData.selectedModel.modelId) {
      return nodeData.selectedModel.displayName;
    }
    return "Generate Audio";
  }, [nodeData.selectedModel?.displayName, nodeData.selectedModel?.modelId]);

  const isParamsExpanded = nodeData.parametersExpanded ?? true; // default expanded

  const handleToggleParams = useCallback(() => {
    updateNodeData(id, { parametersExpanded: !isParamsExpanded });
  }, [id, isParamsExpanded, updateNodeData]);

  // Sockets follow the model's input schema; the handle id is the schema name.
  const inputSockets = useMemo<SocketSpec[]>(() => {
    if (!nodeData.inputSchema || nodeData.inputSchema.length === 0) return DEFAULT_INPUTS;
    return nodeData.inputSchema.map((input) => ({
      id: input.name,
      type: input.type === "image" ? "image" : input.type === "audio" ? "audio" : "text",
      label: input.label,
      title: input.label,
      schemaName: input.name,
    }));
  }, [nodeData.inputSchema]);

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
      {settingsTab === "primary" && nodeData.selectedModel?.modelId && (
        <ModelParameters
          provider={currentProvider}
          modelId={nodeData.selectedModel.modelId}
          parameters={nodeData.parameters || {}}
          onParametersChange={handleParametersChange}
          onInputsLoaded={handleInputsLoaded}
        />
      )}
      {settingsTab === "fallback" && nodeData.fallbackModel && (
        <ModelParameters
          modelId={nodeData.fallbackModel.modelId}
          provider={nodeData.fallbackModel.provider}
          parameters={nodeData.fallbackParameters || {}}
          onParametersChange={(p) => updateNodeData(id, { fallbackParameters: p })}
        />
      )}
    </>
  ) : undefined;

  const duration = audioRef.current?.duration;
  const hasDuration = !!duration && isFinite(duration);
  const historyCount = nodeData.audioHistory?.length || 0;

  const transport = nodeData.outputAudio ? (
    <div className="nodrag nopan flex items-center gap-1.5 w-full h-full px-1">
      <button
        onClick={handlePlayPause}
        className="w-5 h-5 rounded-[6px] squircle flex items-center justify-center text-neutral-300 hover:text-white hover:bg-white/10 transition-colors shrink-0"
        title={isPlaying ? "Pause" : "Play"}
        aria-label={isPlaying ? "Pause" : "Play"}
      >
        {isPlaying ? (
          <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
            <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
          </svg>
        ) : (
          <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </button>
      <div className="flex-1 min-w-0 h-1 bg-neutral-700 rounded-full overflow-hidden relative">
        {hasDuration && (
          <div className="h-full bg-violet-500 transition-all" style={{ width: `${(currentTime / duration) * 100}%` }} />
        )}
      </div>
      <span className="text-node text-neutral-400 tabular-nums shrink-0">{formatTime(currentTime)}</span>
      {historyCount > 1 && (
        <CarouselControls
          index={nodeData.selectedAudioHistoryIndex || 0}
          count={historyCount}
          onPrev={handleCarouselPrevious}
          onNext={handleCarouselNext}
          loading={isLoadingCarouselAudio}
          noun="audio"
          compact
        />
      )}
    </div>
  ) : undefined;

  return (
    <>
      <NodeShell
        id={id}
        selected={selected}
        isExecuting={isRunning}
        hasError={nodeData.status === "error"}
        media={{ kind: "fixed", height: MEDIA_HEIGHT }}
        inputs={inputSockets}
        outputs={OUTPUT_SOCKETS}
        mediaClassName="group"
        gap={transport}
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
        {nodeData.outputAudio ? (
          <>
            {nodeData.__usedFallback && (
              <div
                className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-emerald-900/70 text-emerald-300 text-[9px] font-medium pointer-events-auto z-10"
                title={`Primary failed: ${nodeData.__primaryError ?? "unknown"}\nUsed fallback: ${nodeData.__fallbackModelUsed ?? ""}`}
              >
                Fallback used
              </div>
            )}
            {isLoadingWaveform ? (
              <div className="absolute inset-0 flex items-center justify-center bg-neutral-900/50">
                <span className="text-node text-neutral-500">Loading waveform...</span>
              </div>
            ) : waveformData ? (
              <div
                ref={waveformContainerRef}
                className="absolute inset-0 bg-neutral-900/50 cursor-pointer"
                onClick={handleSeek}
              >
                <canvas ref={canvasRef} className="w-full h-full" />
              </div>
            ) : (
              <div className="absolute inset-0 flex items-center justify-center bg-neutral-900/50">
                <span className="text-node text-neutral-500">Processing...</span>
              </div>
            )}
            {nodeData.status === "loading" && (
              <div className="absolute inset-0 bg-neutral-900/70 flex items-center justify-center gap-2">
                <Spinner className="text-white" />
                <span className="text-xs text-neutral-200">Generating audio...</span>
              </div>
            )}
            <div className="absolute top-1 right-1 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
              <button
                onClick={() => downloadMedia(nodeData.outputAudio!, "audio").catch(() => {})}
                className="w-5 h-5 bg-neutral-900/80 hover:bg-neutral-700 rounded flex items-center justify-center text-neutral-400 hover:text-white transition-colors"
                title="Download audio"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
              </button>
              <button
                onClick={handleClearAudio}
                className="w-5 h-5 bg-neutral-900/80 hover:bg-red-600/80 rounded flex items-center justify-center text-neutral-400 hover:text-white transition-colors"
                title="Clear audio"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </>
        ) : nodeData.status === "loading" ? (
          <div className="absolute inset-0 flex items-center justify-center gap-2 bg-neutral-900/40">
            <Spinner className="text-neutral-400" />
            <span className="text-xs text-neutral-400">Generating audio...</span>
          </div>
        ) : nodeData.status === "error" ? (
          <ErrorMessage message={nodeData.error || "Failed"} />
        ) : (
          <EmptyState message="Run to generate" />
        )}
      </NodeShell>

      {/* Browse dialog */}
      {isBrowseDialogOpen && (
        <ModelSearchDialog
          isOpen={isBrowseDialogOpen}
          onClose={() => setIsBrowseDialogOpen(false)}
          onModelSelected={handleBrowseModelSelect}
          initialProvider={currentProvider}
          initialCapabilityFilter="audio"
        />
      )}
    </>
  );
}
