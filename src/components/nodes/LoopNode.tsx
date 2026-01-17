"use client";

import { useCallback, useState } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useWorkflowStore } from "@/store/workflowStore";
import { LoopNodeData } from "@/types";

type LoopNodeType = Node<LoopNodeData, "loop">;

export function LoopNode({ id, data, selected }: NodeProps<LoopNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const isRunning = useWorkflowStore((state) => state.isRunning);
  const [showGallery, setShowGallery] = useState(false);

  const handleIterationCountChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = Math.max(1, Math.min(50, parseInt(e.target.value) || 1));
      updateNodeData(id, { iterationCount: value });
    },
    [id, updateNodeData]
  );

  const handleModeChange = useCallback(
    (mode: "count" | "until") => {
      updateNodeData(id, { loopMode: mode });
    },
    [id, updateNodeData]
  );

  const handleGallerySelect = useCallback(
    (index: number) => {
      updateNodeData(id, { selectedGalleryIndex: index });
    },
    [id, updateNodeData]
  );

  const hasGalleryImages = nodeData.galleryImages.length > 0;
  const progressPercent =
    nodeData.isLooping && nodeData.iterationCount > 0
      ? Math.round((nodeData.currentIteration / nodeData.iterationCount) * 100)
      : 0;

  return (
    <BaseNode
      id={id}
      title="Loop"
      customTitle={nodeData.customTitle}
      comment={nodeData.comment}
      onCustomTitleChange={(title) =>
        updateNodeData(id, { customTitle: title || undefined })
      }
      onCommentChange={(comment) =>
        updateNodeData(id, { comment: comment || undefined })
      }
      selected={selected}
      hasError={nodeData.status === "error"}
      isExecuting={nodeData.isLooping}
    >
      {/* Input handles - left side */}
      <Handle
        type="target"
        position={Position.Left}
        id="image"
        data-handletype="image"
        style={{ top: "30%" }}
        title="Input image (for collection mode or initial image)"
      />
      <Handle
        type="target"
        position={Position.Left}
        id="text"
        data-handletype="text"
        style={{ top: "50%" }}
        title="Input text/prompt template (use {index} for iteration number)"
      />
      <Handle
        type="target"
        position={Position.Left}
        id="feedback"
        data-handletype="image"
        style={{ top: "70%" }}
        title="Feedback from iteration (connects back from subgraph output)"
        className="!bg-purple-500"
      />

      {/* Output handles - right side */}
      <Handle
        type="source"
        position={Position.Right}
        id="image"
        data-handletype="image"
        style={{ top: "30%" }}
        title="Current iteration image"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="text"
        data-handletype="text"
        style={{ top: "50%" }}
        title="Current iteration text (with {index} replaced)"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="gallery"
        data-handletype="image"
        style={{ top: "70%" }}
        title="Gallery output (accumulated images)"
        className="!bg-amber-500"
      />

      <div className="flex-1 flex flex-col min-h-0 gap-2">
        {/* Mode selector */}
        <div className="flex gap-1">
          <button
            onClick={() => handleModeChange("count")}
            disabled={nodeData.isLooping}
            className={`flex-1 px-2 py-1 text-[10px] rounded transition-colors ${
              nodeData.loopMode === "count"
                ? "bg-blue-600 text-white"
                : "bg-neutral-700 text-neutral-300 hover:bg-neutral-600"
            } disabled:opacity-50`}
          >
            Count (N times)
          </button>
          <button
            onClick={() => handleModeChange("until")}
            disabled={nodeData.isLooping}
            className={`flex-1 px-2 py-1 text-[10px] rounded transition-colors ${
              nodeData.loopMode === "until"
                ? "bg-blue-600 text-white"
                : "bg-neutral-700 text-neutral-300 hover:bg-neutral-600"
            } disabled:opacity-50`}
          >
            Until Condition
          </button>
        </div>

        {/* Iteration count (only for count mode) */}
        {nodeData.loopMode === "count" && (
          <div className="flex items-center gap-2">
            <label className="text-[10px] text-neutral-400 whitespace-nowrap">
              Iterations:
            </label>
            <input
              type="number"
              min={1}
              max={50}
              value={nodeData.iterationCount}
              onChange={handleIterationCountChange}
              disabled={nodeData.isLooping}
              className="nodrag nopan flex-1 px-2 py-1 text-xs bg-neutral-900/50 border border-neutral-700 rounded text-neutral-100 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
            />
          </div>
        )}

        {/* Until mode info */}
        {nodeData.loopMode === "until" && (
          <div className="text-[10px] text-neutral-400">
            <span>Loops until feedback condition is met</span>
          </div>
        )}

        {/* Progress indicator */}
        {nodeData.isLooping && (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[10px]">
              <span className="text-blue-400">
                Iteration {nodeData.currentIteration + 1} /{" "}
                {nodeData.loopMode === "count"
                  ? nodeData.iterationCount
                  : "?"}
              </span>
              <span className="text-neutral-400">{progressPercent}%</span>
            </div>
            <div className="h-1 bg-neutral-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 transition-all duration-300"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>
        )}

        {/* Gallery preview */}
        {hasGalleryImages && (
          <div className="flex-1 min-h-0">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] text-neutral-400">
                Gallery ({nodeData.galleryImages.length})
              </span>
              <button
                onClick={() => setShowGallery(!showGallery)}
                className="text-[10px] text-blue-400 hover:text-blue-300"
              >
                {showGallery ? "Hide" : "Show"}
              </button>
            </div>

            {showGallery ? (
              <div className="grid grid-cols-3 gap-1 max-h-32 overflow-y-auto">
                {nodeData.galleryImages.map((img, idx) => (
                  <button
                    key={idx}
                    onClick={() => handleGallerySelect(idx)}
                    className={`relative aspect-square rounded overflow-hidden border-2 transition-colors ${
                      idx === nodeData.selectedGalleryIndex
                        ? "border-blue-500"
                        : "border-transparent hover:border-neutral-600"
                    }`}
                  >
                    <img
                      src={img}
                      alt={`Iteration ${idx + 1}`}
                      className="w-full h-full object-cover"
                    />
                    <span className="absolute bottom-0 left-0 right-0 bg-black/60 text-[8px] text-white text-center">
                      {idx + 1}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="relative aspect-video rounded overflow-hidden border border-neutral-700">
                <img
                  src={nodeData.galleryImages[nodeData.selectedGalleryIndex]}
                  alt={`Selected: ${nodeData.selectedGalleryIndex + 1}`}
                  className="w-full h-full object-contain"
                />
                <span className="absolute top-1 left-1 bg-black/60 px-1 text-[8px] text-white rounded">
                  {nodeData.selectedGalleryIndex + 1} /{" "}
                  {nodeData.galleryImages.length}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Empty state */}
        {!hasGalleryImages && !nodeData.isLooping && (
          <div className="flex-1 min-h-[60px] border border-dashed border-neutral-600 rounded flex flex-col items-center justify-center">
            <svg
              className="w-5 h-5 text-neutral-500"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"
              />
            </svg>
            <span className="text-neutral-500 text-[10px] mt-1">
              Ready to loop
            </span>
          </div>
        )}

        {/* Error display */}
        {nodeData.status === "error" && nodeData.error && (
          <div className="text-[10px] text-red-400 truncate" title={nodeData.error}>
            {nodeData.error}
          </div>
        )}

        {/* Hint text */}
        <div className="text-[9px] text-neutral-500 leading-tight">
          {nodeData.loopMode === "count" ? (
            <>Use {"{"}<span className="text-blue-400">index</span>{"}"} in prompts for iteration number</>
          ) : (
            <>Loops until feedback signals completion</>
          )}
        </div>
      </div>
    </BaseNode>
  );
}
