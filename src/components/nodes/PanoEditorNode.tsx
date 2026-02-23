"use client";

import React, { useCallback } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useCommentNavigation } from "@/hooks/useCommentNavigation";
import { useWorkflowStore } from "@/store/workflowStore";
import { PanoEditorNodeData } from "@/types";

type PanoEditorNodeType = Node<PanoEditorNodeData, "panoEditor">;

/**
 * Panorama Editor node.
 *
 * Composites an edited perspective image back onto an equirectangular
 * panorama using the crop metadata from the Panorama Viewer.
 *
 * Input: image-0 (left, 25%) — original equirectangular panorama
 * Input: image-1 (left, 50%) — edited perspective image
 * Input: text   (left, 75%) — JSON metadata (PanoCropMetadata)
 * Output: image (right, 50%) — composited equirectangular panorama
 */
export function PanoEditorNode({ id, data, selected }: NodeProps<PanoEditorNodeType>) {
  const nodeData = data;
  const commentNavigation = useCommentNavigation(id);
  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const isRunning = useWorkflowStore((state) => state.isRunning);

  const handleRun = useCallback(() => {
    regenerateNode(id);
  }, [id, regenerateNode]);

  const statusColor = {
    idle: "text-neutral-500",
    loading: "text-amber-400",
    complete: "text-emerald-400",
    error: "text-red-400",
  }[nodeData.status || "idle"];

  const statusLabel = {
    idle: "Ready",
    loading: "Compositing...",
    complete: "Complete",
    error: "Error",
  }[nodeData.status || "idle"];

  return (
    <BaseNode
      id={id}
      selected={selected}
      title="Pano Editor"
      commentNavigation={commentNavigation || undefined}
      onRun={handleRun}
      isExecuting={isRunning}
    >
      {/* Input Handle — original panorama */}
      <Handle
        type="target"
        position={Position.Left}
        id="image-0"
        style={{ top: "25%" }}
        className="!w-3 !h-3 !bg-violet-500 !border-violet-700"
      />

      {/* Input Handle — edited perspective image */}
      <Handle
        type="target"
        position={Position.Left}
        id="image-1"
        style={{ top: "50%" }}
        className="!w-3 !h-3 !bg-violet-500 !border-violet-700"
      />

      {/* Input Handle — metadata JSON */}
      <Handle
        type="target"
        position={Position.Left}
        id="text"
        style={{ top: "75%" }}
        className="!w-3 !h-3 !bg-amber-500 !border-amber-700"
      />

      {/* Output Handle — composited panorama */}
      <Handle
        type="source"
        position={Position.Right}
        id="image"
        style={{ top: "50%" }}
        className="!w-3 !h-3 !bg-violet-500 !border-violet-700"
      />

      <div className="p-3 space-y-3">
        {/* Header */}
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-orange-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="12" cy="12" r="3" />
            <path d="M3 12h6M15 12h6M12 3v6M12 15v6" />
          </svg>
          <span className="text-xs font-medium text-neutral-300">Pano Editor</span>
          <span className={`text-[9px] ml-auto ${statusColor}`}>
            {nodeData.status === "loading" && (
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse inline-block mr-1" />
            )}
            {statusLabel}
          </span>
        </div>

        {/* Input labels */}
        <div className="space-y-1 text-[10px] text-neutral-500">
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-violet-500/50 shrink-0" />
            <span>Panorama</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-violet-500/50 shrink-0" />
            <span>Edited image</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-amber-500/50 shrink-0" />
            <span>Metadata (JSON)</span>
          </div>
        </div>

        {/* Output preview */}
        {nodeData.outputImage && (
          <div className="bg-neutral-900 rounded-lg overflow-hidden">
            <img
              src={nodeData.outputImage}
              alt="Composited panorama"
              className="w-full h-auto object-cover"
            />
            <p className="text-[9px] text-neutral-500 px-2 py-1">
              Composited output
            </p>
          </div>
        )}

        {/* Error message */}
        {nodeData.error && (
          <div className="text-[10px] text-red-400 bg-red-500/10 rounded px-2 py-1">
            {nodeData.error}
          </div>
        )}

        {/* Handle labels */}
        <div className="absolute left-5 text-[9px] text-neutral-600" style={{ top: "25%", transform: "translateY(-50%)" }}>
          pano
        </div>
        <div className="absolute left-5 text-[9px] text-neutral-600" style={{ top: "50%", transform: "translateY(-50%)" }}>
          edit
        </div>
        <div className="absolute left-5 text-[9px] text-neutral-600" style={{ top: "75%", transform: "translateY(-50%)" }}>
          meta
        </div>
        <div className="absolute right-5 text-[9px] text-neutral-600" style={{ top: "50%", transform: "translateY(-50%)" }}>
          image
        </div>
      </div>
    </BaseNode>
  );
}
