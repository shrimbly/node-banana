"use client";

import React, { useCallback, useState, useEffect, useMemo, useRef } from "react";
import { Handle, Position, NodeProps, Node, useReactFlow } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useCommentNavigation } from "@/hooks/useCommentNavigation";
import { ModelParameters } from "./ModelParameters";
import { useWorkflowStore, useProviderApiKeys } from "@/store/workflowStore";
import { Generate3DNodeData, ProviderType, SelectedModel, ModelInputDef } from "@/types";
import { ProviderModel, ModelCapability } from "@/lib/providers/types";
import { ModelSearchDialog } from "@/components/modals/ModelSearchDialog";
import { useToast } from "@/components/Toast";
import { ProviderBadge } from "./ProviderBadge";

function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
  return Promise.resolve();
}

// 3D generation capabilities
const THREE_D_CAPABILITIES: ModelCapability[] = ["text-to-3d", "image-to-3d"];

type Generate3DNodeType = Node<Generate3DNodeData, "generate3d">;

export function Generate3DNode({ id, data, selected }: NodeProps<Generate3DNodeType>) {
  const nodeData = data;
  const commentNavigation = useCommentNavigation(id);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const { replicateApiKey, falApiKey, kieApiKey } = useProviderApiKeys();
  const [isBrowseDialogOpen, setIsBrowseDialogOpen] = useState(false);

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

  // Handle parameters expand/collapse - resize node height
  const { setNodes } = useReactFlow();
  const handleParametersExpandChange = useCallback(
    (expanded: boolean, parameterCount: number) => {
      const parameterHeight = expanded ? Math.max(parameterCount * 28 + 16, 60) : 0;
      const baseHeight = 300;
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

  // Handle model selection from browse dialog
  const handleBrowseModelSelect = useCallback((model: ProviderModel) => {
    const newSelectedModel: SelectedModel = {
      provider: model.provider,
      modelId: model.id,
      displayName: model.name,
      ...(model.pricing && {
        pricing: {
          type: model.pricing.type,
          amount: model.pricing.amount,
        },
      }),
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

  // Track previous status to detect error transitions
  const prevStatusRef = useRef(nodeData.status);

  // Show toast when error occurs
  useEffect(() => {
    if (nodeData.status === "error" && prevStatusRef.current !== "error" && nodeData.error) {
      useToast.getState().show("3D generation failed", "error", true, nodeData.error);
    }
    prevStatusRef.current = nodeData.status;
  }, [nodeData.status, nodeData.error]);

  const handleClear3D = useCallback(() => {
    updateNodeData(id, { output3dUrl: null, savedFilename: null, savedFilePath: null, status: "idle", error: null });
  }, [id, updateNodeData]);

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
      lastCost={nodeData.lastGenerationCost}
    >
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
            imageInputs.forEach((input) => {
              handles.push({
                // Use schema name in handle ID for direct mapping in connectedInputs
                id: `image-${input.name}`,
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

          if (hasTextInput) {
            textInputs.forEach((input) => {
              handles.push({
                // Use schema name in handle ID for direct mapping in connectedInputs
                id: `text-${input.name}`,
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

          const imageHandles = handles.filter(h => h.type === "image");
          const textHandles = handles.filter(h => h.type === "text");
          const totalSlots = imageHandles.length + textHandles.length + 1;

          const renderedHandles = handles.map((handle) => {
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
                  }}
                  data-handletype={handle.type}
                  data-schema-name={handle.schemaName || undefined}
                  isConnectable={true}
                  title={handle.description || handle.label}
                />
                <div
                  className="absolute text-[10px] font-medium whitespace-nowrap pointer-events-none text-right"
                  style={{
                    right: `calc(100% + 8px)`,
                    top: `calc(${topPercent}% - 18px)`,
                    color: isImage ? "var(--handle-color-image)" : "var(--handle-color-text)",
                    opacity: handle.isPlaceholder ? 0.3 : 1,
                  }}
                >
                  {handle.label}
                </div>
              </React.Fragment>
            );
          });

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
            style={{ top: "35%" }}
            data-handletype="image"
            isConnectable={true}
          />
          <div
            className="absolute text-[10px] font-medium whitespace-nowrap pointer-events-none text-right"
            style={{
              right: `calc(100% + 8px)`,
              top: "calc(35% - 18px)",
              color: "var(--handle-color-image)",
            }}
          >
            Image
          </div>
          <Handle
            type="target"
            position={Position.Left}
            id="text"
            style={{ top: "65%" }}
            data-handletype="text"
          />
          <div
            className="absolute text-[10px] font-medium whitespace-nowrap pointer-events-none text-right"
            style={{
              right: `calc(100% + 8px)`,
              top: "calc(65% - 18px)",
              color: "var(--handle-color-text)",
            }}
          >
            Prompt
          </div>
        </>
      )}

      {/* 3D output handle */}
      <Handle
        type="source"
        position={Position.Right}
        id="3d"
        data-handletype="3d"
      />
      {/* Output label */}
      <div
        className="absolute text-[10px] font-medium whitespace-nowrap pointer-events-none"
        style={{
          left: `calc(100% + 8px)`,
          top: "calc(50% - 18px)",
          color: "var(--handle-color-3d)",
        }}
      >
        3D
      </div>

      <div className="flex-1 flex flex-col min-h-0 gap-2">
        {/* Preview area */}
        {nodeData.output3dUrl ? (
          <div className="relative w-full flex-1 min-h-[80px] flex flex-col items-center justify-center gap-2 bg-neutral-800 rounded border border-neutral-700 p-3">
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
                title={`Copy path: ${nodeData.savedFilePath}`}
              >
                <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
                {nodeData.savedFilename}
              </button>
            ) : (
              <span className="text-[10px] text-neutral-500 truncate max-w-full">Connect to 3D Viewer</span>
            )}
            {/* Loading overlay for re-generation */}
            {nodeData.status === "loading" && (
              <div className="absolute inset-0 bg-neutral-900/70 rounded flex items-center justify-center">
                <svg
                  className="w-6 h-6 animate-spin text-white"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
              </div>
            )}
            {/* Error overlay */}
            {nodeData.status === "error" && (
              <div className="absolute inset-0 bg-red-900/40 rounded flex flex-col items-center justify-center gap-1">
                <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="text-white text-xs font-medium">Generation failed</span>
                <span className="text-white/70 text-[10px]">See toast for details</span>
              </div>
            )}
            <div className="absolute top-1 right-1">
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
        ) : (
          <div className="w-full flex-1 min-h-[112px] border border-dashed border-neutral-600 rounded flex flex-col items-center justify-center">
            {nodeData.status === "loading" ? (
              <svg
                className="w-4 h-4 animate-spin text-neutral-400"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
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
        {nodeData.selectedModel?.modelId && (
          <ModelParameters
            modelId={nodeData.selectedModel.modelId}
            provider={currentProvider}
            parameters={nodeData.parameters || {}}
            onParametersChange={handleParametersChange}
            onExpandChange={handleParametersExpandChange}
            onInputsLoaded={handleInputsLoaded}
            inputNames={nodeData.inputSchema?.map(i => i.name)}
          />
        )}
      </div>
    </BaseNode>

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
