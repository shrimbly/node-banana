"use client";

import { useCallback, useState, useEffect } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useWorkflowStore } from "@/store/workflowStore";
import { SplitGridNodeData } from "@/types";
import { SplitGridSettingsModal } from "../SplitGridSettingsModal";

type SplitGridNodeType = Node<SplitGridNodeData, "splitGrid">;

export function SplitGridNode({ id, data, selected }: NodeProps<SplitGridNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const isRunning = useWorkflowStore((state) => state.isRunning);
  const [showSettings, setShowSettings] = useState(false);

  // Show settings modal on first creation (when not configured)
  useEffect(() => {
    if (!nodeData.isConfigured && nodeData.childNodeIds.length === 0) {
      setShowSettings(true);
    }
  }, [nodeData.isConfigured, nodeData.childNodeIds.length]);

  const handleOpenSettings = useCallback(() => {
    setShowSettings(true);
  }, []);

  const handleCloseSettings = useCallback(() => {
    setShowSettings(false);
  }, []);

  const handleSplit = useCallback(() => {
    regenerateNode(id);
  }, [id, regenerateNode]);

  return (
    <BaseNode
      id={id}
      title="Split Grid"
      customTitle={nodeData.customTitle}
      comment={nodeData.comment}
      onCustomTitleChange={(title) => updateNodeData(id, { customTitle: title || undefined })}
      onCommentChange={(comment) => updateNodeData(id, { comment: comment || undefined })}
      selected={selected}
      hasError={nodeData.status === "error"}
    >
      {/* Image input handle */}
      <Handle
        type="target"
        position={Position.Left}
        id="image"
        data-handletype="image"
      />

      {/* Reference output handle for visual links to child nodes */}
      <Handle
        type="source"
        position={Position.Right}
        id="reference"
        data-handletype="reference"
        className="!bg-gray-500"
      />

      <div className="flex-1 flex flex-col min-h-0 gap-2">
        {/* Preview/Status area */}
        {nodeData.sourceImage ? (
          <div className="relative w-full flex-1 min-h-0">
            <img
              src={nodeData.sourceImage}
              alt="Source grid"
              className="w-full h-full object-contain rounded"
            />
            {/* Grid overlay visualization */}
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                display: "grid",
                gridTemplateColumns: `repeat(${nodeData.gridCols}, 1fr)`,
                gridTemplateRows: `repeat(${nodeData.gridRows}, 1fr)`,
              }}
            >
              {Array.from({ length: nodeData.targetCount }).map((_, i) => (
                <div
                  key={i}
                  className="border border-blue-400/50"
                />
              ))}
            </div>
            {/* Loading overlay */}
            {nodeData.status === "loading" && (
              <div className="absolute inset-0 bg-neutral-900/70 rounded flex items-center justify-center">
                <svg className="w-6 h-6 animate-spin text-white" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
              </div>
            )}
          </div>
        ) : (
          <div className="w-full flex-1 min-h-[112px] border border-dashed border-neutral-600 rounded flex flex-col items-center justify-center">
            {nodeData.status === "error" ? (
              <span className="text-[10px] text-red-400 text-center px-2">
                {nodeData.error || "Error"}
              </span>
            ) : nodeData.status === "loading" ? (
              <svg className="w-4 h-4 animate-spin text-neutral-400" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            ) : (
              <>
                <svg className="w-5 h-5 text-neutral-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
                </svg>
                <span className="text-neutral-500 text-[10px] mt-1">
                  Connect image
                </span>
              </>
            )}
          </div>
        )}

        {/* Config summary */}
        <div className="flex items-center justify-between text-[10px] text-neutral-400 shrink-0">
          <span>{nodeData.gridRows}x{nodeData.gridCols} grid ({nodeData.targetCount} images)</span>
          <button
            onClick={handleOpenSettings}
            className="text-blue-400 hover:text-blue-300 transition-colors"
          >
            Settings
          </button>
        </div>

        {/* Child node count / status */}
        <div className="flex items-center justify-between shrink-0">
          {nodeData.isConfigured ? (
            <div className="text-[10px] text-neutral-500">
              {nodeData.childNodeIds.length} generate sets created
            </div>
          ) : (
            <div className="text-[10px] text-amber-400">
              Not configured - click Settings
            </div>
          )}

          {/* Split button */}
          <button
            onClick={handleSplit}
            disabled={isRunning || !nodeData.isConfigured}
            className="px-2 py-0.5 text-[10px] border border-white hover:bg-white hover:text-neutral-900 disabled:border-neutral-600 disabled:text-neutral-600 disabled:cursor-not-allowed text-white rounded transition-colors"
            title={!nodeData.isConfigured ? "Configure node first" : "Split grid"}
          >
            Split
          </button>
        </div>
      </div>

      {/* Settings Modal */}
      {showSettings && (
        <SplitGridSettingsModal
          nodeId={id}
          nodeData={nodeData}
          onClose={handleCloseSettings}
        />
      )}
    </BaseNode>
  );
}
