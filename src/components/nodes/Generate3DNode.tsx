"use client";

import React, { useCallback, useState, useEffect, useMemo } from "react";
import { NodeProps, Node } from "@xyflow/react";
import { NodeShell } from "./NodeShell";
import { ModelParameters } from "./ModelParameters";
import { useWorkflowStore } from "@/store/workflowStore";
import { Generate3DNodeData, ProviderType, SelectedModel, ModelInputDef } from "@/types";
import { ProviderModel } from "@/lib/providers/types";
import { ModelSearchDialog } from "@/components/modals/ModelSearchDialog";
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
  LoadingOverlay,
  Spinner,
  schemaSockets,
  type SocketSpec,
} from "./ui";

const OUTPUT_SOCKETS: SocketSpec[] = [{ id: "3d", type: "3d", label: "3D" }];
const MEDIA_HEIGHT = 112;

type Generate3DNodeType = Node<Generate3DNodeData, "generate3d">;

export function Generate3DNode({ id, data, selected }: NodeProps<Generate3DNodeType>) {
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

  // Get the current selected provider (default to fal since most 3D models are there)
  const currentProvider: ProviderType = nodeData.selectedModel?.provider || "fal";

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

  const isRunning = useWorkflowStore((state) => state.isRunning);

  // Handle model selection from browse dialog
  const handleBrowseModelSelect = useCallback((model: ProviderModel) => {
    const newSelectedModel: SelectedModel = {
      provider: model.provider,
      modelId: model.id,
      displayName: model.name,
    };
    updateNodeData(id, { selectedModel: newSelectedModel, parameters: {} });
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
          <svg className="w-8 h-8 text-orange-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 7.5l-2.25-1.313M21 7.5v2.25m0-2.25l-2.25 1.313M3 7.5l2.25-1.313M3 7.5l2.25 1.313M3 7.5v2.25m9 3l2.25-1.313M12 12.75l-2.25-1.313M12 12.75V15m0 6.75l2.25-1.313M12 21.75V19.5m0 2.25l-2.25-1.313m0-16.875L12 2.25l2.25 1.313M21 14.25v2.25l-2.25 1.313m-13.5 0L3 16.5v-2.25" />
          </svg>
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
                    body: JSON.stringify({ filePath: nodeData.savedFilePath }),
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
              <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
              {nodeData.savedFilename}
            </button>
          ) : (
            <span className="text-[10px] text-neutral-500 truncate max-w-full">Connect to 3D Viewer</span>
          )}
          {nodeData.status === "loading" && <LoadingOverlay />}
          {nodeData.status === "error" && <ErrorOverlay />}
          <div className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
            <button
              onClick={handleClear3D}
              className="w-5 h-5 bg-neutral-900/80 hover:bg-red-600/80 rounded flex items-center justify-center text-neutral-400 hover:text-white transition-colors"
              title="Clear 3D model"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
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
