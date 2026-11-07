"use client";

import React, { useCallback, useState, useEffect, useMemo } from "react";
import { NodeProps, Node } from "@xyflow/react";
import { NodeShell } from "./NodeShell";
import { ModelParameters } from "./ModelParameters";
import { useSchemaDerived } from "./schemaDerived";
import { useWorkflowStore } from "@/store/workflowStore";
import { Generate3DNodeData, ProviderType } from "@/types";
import { ProviderModel } from "@/lib/providers/types";
import { ModelSearchDialog } from "@/components/modals/ModelSearchDialog";
import { modelSelectionData } from "@/store/utils/modelSelection";
import { useToast } from "@/components/Toast";
import { ProviderBadge } from "./ProviderBadge";
import { SettingsTabBar } from "./SettingsTabBar";
import { browseRegistry } from "@/utils/browseRegistry";
import { useErrorToast } from "@/hooks/useErrorToast";
import {
  ControlsCard,
  EmptyState,
  ErrorMessage,
  ErrorOverlay,
  PendingTaskNotice,
  LoadingOverlay,
  Spinner,
  schemaSockets,
  type SocketSpec,
} from "./ui";
import { Box, Folder, X } from "lucide-react";
import { useHoldLive, useIsPaintedNode, useUpdateNodeData, useNodeUiState } from "./paintMode";

const OUTPUT_SOCKETS: SocketSpec[] = [{ id: "3d", type: "3d", label: "3D" }];
const MEDIA_HEIGHT = 112;

type Generate3DNodeType = Node<Generate3DNodeData, "generate3d">;

export function Generate3DNode({ id, data, selected }: NodeProps<Generate3DNodeType>) {
  const nodeData = data;
  const updateNodeData = useUpdateNodeData();
  const [isBrowseDialogOpen, setIsBrowseDialogOpen] = useState(false);
  useHoldLive(isBrowseDialogOpen);
  const painted = useIsPaintedNode();
  const [settingsTab, setSettingsTab] = useNodeUiState<"primary" | "fallback">(id, "settingsTab", "primary");

  useEffect(() => {
    if (!nodeData.fallbackModel && settingsTab === "fallback") {
      setSettingsTab("primary");
    }
  }, [nodeData.fallbackModel, settingsTab]);

  // Register browse callback for floating header button
  useEffect(() => {
    // A painted copy would replace the live node's handler, then remove it as it unmounts.
    if (painted) return;
    browseRegistry.register(id, () => setIsBrowseDialogOpen(true));
    return () => { browseRegistry.unregister(id); };
  }, [id, painted]);

  // Get the current selected provider (default to fal since most 3D models are there)
  const currentProvider: ProviderType = nodeData.selectedModel?.provider || "fal";

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

  // Handle model selection from browse dialog
  const handleBrowseModelSelect = useCallback((model: ProviderModel) => {
    updateNodeData(id, modelSelectionData("generate3d", model));
    setIsBrowseDialogOpen(false);
  }, [id, updateNodeData]);

  // Dynamic title based on selected model
  const displayTitle = useMemo(() => {
    if (nodeData.selectedModel?.displayName && nodeData.selectedModel.modelId) {
      return nodeData.selectedModel.displayName;
    }
    return "Select 3D model...";
  }, [nodeData.selectedModel?.displayName, nodeData.selectedModel?.modelId]);

  const isParamsExpanded = nodeData.parametersExpanded ?? true; // default expanded

  const handleToggleParams = useCallback(() => {
    updateNodeData(id, { parametersExpanded: !isParamsExpanded });
  }, [id, isParamsExpanded, updateNodeData]);

  // Show toast when generation fails
  useErrorToast(nodeData.status, nodeData.error, "3D generation failed");

  const handleClear3D = useCallback(() => {
    updateNodeData(id, { output3dUrl: null, savedFilename: null, savedFilePath: null, status: "idle", error: null });
  }, [id, updateNodeData]);

  const inputSockets = useMemo(
    () => schemaSockets(nodeData.inputSchema, { types: ["image", "text"] }),
    [nodeData.inputSchema]
  );

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
      media={{ kind: "fixed", height: MEDIA_HEIGHT }}
      inputs={inputSockets}
      outputs={OUTPUT_SOCKETS}
      mediaClassName="group"
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
      {nodeData.output3dUrl ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-neutral-900/40 px-3">
          {nodeData.__usedFallback && (
            <div
              className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-emerald-900/70 text-emerald-300 text-[9px] font-medium pointer-events-auto z-10"
              title={`Primary failed: ${nodeData.__primaryError ?? "unknown"}\nUsed fallback: ${nodeData.__fallbackModelUsed ?? ""}`}
            >
              Fallback used
            </div>
          )}
          <Box size={32} strokeWidth={1.5} className="text-orange-400" />
          <span className="text-[11px] text-orange-400 font-medium">3D Model Generated</span>
          {nodeData.savedFilename ? (
            <button
              onClick={async (e) => {
                e.stopPropagation();
                if (!nodeData.savedFilePath) {
                  useToast.getState().show("No file path available", "error");
                  return;
                }
                try {
                  const res = await fetch("/api/open-file", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    // The project folder lets the route reveal a model saved there, wherever it is.
                    body: JSON.stringify({
                      filePath: nodeData.savedFilePath,
                      projectPath: useWorkflowStore.getState().saveDirectoryPath,
                    }),
                  });
                  if (!res.ok) {
                    const detail = await res.text().catch(() => `Status ${res.status}`);
                    useToast.getState().show("Failed to open file", "error", true, detail);
                  }
                } catch (err) {
                  console.error("Failed to open file location:", err);
                  useToast.getState().show("Failed to open file location", "error");
                }
              }}
              className="nodrag nopan text-[10px] text-neutral-400 hover:text-orange-300 truncate max-w-full cursor-pointer transition-colors flex items-center gap-1"
              title={`Open in explorer: ${nodeData.savedFilePath}`}
            >
              <Folder size={12} strokeWidth={2} className="shrink-0" />
              {nodeData.savedFilename}
            </button>
          ) : (
            <span className="text-[10px] text-neutral-500 truncate max-w-full">Connect to 3D Viewer</span>
          )}
          {nodeData.status === "loading" && <LoadingOverlay />}
          {nodeData.status === "error" && !pendingTask && <ErrorOverlay />}
          {pendingTask && <PendingTaskNotice task={pendingTask} onPickUp={() => resumeGeneration(id)} disabled={isRunning} compact />}
          <div className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
            <button
              onClick={handleClear3D}
              className="w-5 h-5 bg-neutral-900/80 hover:bg-red-600/80 rounded flex items-center justify-center text-neutral-400 hover:text-white transition-colors"
              title="Clear 3D model"
            >
              <X size={12} strokeWidth={2} />
            </button>
          </div>
        </div>
      ) : pendingTask ? (
        <PendingTaskNotice task={pendingTask} onPickUp={() => resumeGeneration(id)} disabled={isRunning} compact />
      ) : nodeData.status === "loading" ? (
        <div className="absolute inset-0 flex items-center justify-center bg-neutral-900/40">
          <Spinner className="text-neutral-400" />
        </div>
      ) : nodeData.status === "error" ? (
        <ErrorMessage message={nodeData.error || "Failed"} />
      ) : (
        <EmptyState message="Run to generate" />
      )}
    </NodeShell>

    {/* Model browser dialog */}
    {isBrowseDialogOpen && (
      <ModelSearchDialog
        isOpen={isBrowseDialogOpen}
        onClose={() => setIsBrowseDialogOpen(false)}
        onModelSelected={handleBrowseModelSelect}
        initialCapabilityFilter="3d"
      />
    )}
    </>
  );
}
