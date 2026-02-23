"use client";

import React from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useCommentNavigation } from "@/hooks/useCommentNavigation";
import { PanoCropNodeData } from "@/types";

type PanoCropNodeType = Node<PanoCropNodeData, "panoCrop">;

/**
 * Panorama Crop node.
 *
 * Holds a perspective snapshot extracted from an equirectangular panorama,
 * along with its camera metadata. Created automatically by the PanoViewer
 * node when the user captures a crop region.
 *
 * Output: image (right, 35%) — perspective snapshot
 * Output: text  (right, 65%) — JSON-serialized PanoCropMetadata
 */
export function PanoCropNode({ id, data, selected }: NodeProps<PanoCropNodeType>) {
  const nodeData = data;
  const commentNavigation = useCommentNavigation(id);

  return (
    <BaseNode
      id={id}
      selected={selected}
      title="Pano Crop"
      commentNavigation={commentNavigation || undefined}
    >
      {/* Output Handle — perspective snapshot */}
      <Handle
        type="source"
        position={Position.Right}
        id="image"
        style={{ top: "35%" }}
        className="!w-3 !h-3 !bg-violet-500 !border-violet-700"
      />

      {/* Output Handle — crop metadata JSON */}
      <Handle
        type="source"
        position={Position.Right}
        id="text"
        style={{ top: "65%" }}
        className="!w-3 !h-3 !bg-amber-500 !border-amber-700"
      />

      <div className="p-3 space-y-2">
        {/* Header */}
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-pink-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M9 3v18M3 9h18" />
          </svg>
          <span className="text-xs font-medium text-neutral-300">Pano Crop</span>
          {nodeData.dimensions && (
            <span className="text-[9px] text-neutral-500 ml-auto">
              {nodeData.dimensions.width}×{nodeData.dimensions.height}
            </span>
          )}
        </div>

        {/* Image preview */}
        {nodeData.image ? (
          <div className="bg-neutral-900 rounded-lg overflow-hidden">
            <img
              src={nodeData.image}
              alt={nodeData.filename || "Pano crop"}
              className="w-full h-auto object-cover"
            />
          </div>
        ) : (
          <div className="rounded-lg border-2 border-dashed border-neutral-700 bg-neutral-900 min-h-[60px] flex items-center justify-center">
            <p className="text-[10px] text-neutral-500">No capture yet</p>
          </div>
        )}

        {/* Handle labels */}
        <div className="absolute right-5 text-[9px] text-neutral-600" style={{ top: "35%", transform: "translateY(-50%)" }}>
          image
        </div>
        <div className="absolute right-5 text-[9px] text-neutral-600" style={{ top: "65%", transform: "translateY(-50%)" }}>
          meta
        </div>
      </div>
    </BaseNode>
  );
}
