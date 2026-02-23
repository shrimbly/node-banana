"use client";

import React, { useCallback, useMemo } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useCommentNavigation } from "@/hooks/useCommentNavigation";
import { useWorkflowStore } from "@/store/workflowStore";
import { WorldLabsPanoNodeData } from "@/types";

type WorldLabsPanoNodeType = Node<WorldLabsPanoNodeData, "worldLabsPano">;

/** Azimuth presets for multi-image generation */
const AZIMUTH_OPTIONS = [
  { label: "Front", value: 0 },
  { label: "Right", value: 90 },
  { label: "Back", value: 180 },
  { label: "Left", value: 270 },
] as const;

/** Default azimuths by index */
const DEFAULT_AZIMUTHS = [0, 90, 180, 270];

/**
 * WorldLabs Panorama Generator node.
 *
 * Quick panorama preview step. Generates equirectangular panoramas
 * using the WorldLabs Marble API (defaults to Marble 0.1-mini for speed).
 *
 * Inputs: image (left 35%), text (left 65%)
 * Outputs: image (right 35%) — the panorama, text (right 65%) — generated caption
 */
export function WorldLabsPanoNode({ id, data, selected }: NodeProps<WorldLabsPanoNodeType>) {
  const nodeData = data;
  const commentNavigation = useCommentNavigation(id);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const edges = useWorkflowStore((state) => state.edges);
  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const isRunning = useWorkflowStore((state) => state.isRunning);

  // Count connected image edges
  const connectedImageCount = useMemo(() => {
    return edges.filter(
      (e) => e.target === id && e.targetHandle === "image"
    ).length;
  }, [edges, id]);

  const showAzimuthControls = connectedImageCount >= 2;

  // ─── Handlers ────────────────────────────────────────────────

  const handleWorldNameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      updateNodeData(id, { worldName: e.target.value });
    },
    [id, updateNodeData]
  );

  const handleModelChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      updateNodeData(id, {
        model: e.target.value as WorldLabsPanoNodeData["model"],
      });
    },
    [id, updateNodeData]
  );

  const handleSeedChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value.trim();
      updateNodeData(id, {
        seed: val === "" ? null : parseInt(val, 10) || null,
      });
    },
    [id, updateNodeData]
  );

  const handleAzimuthChange = useCallback(
    (index: number, value: number) => {
      updateNodeData(id, {
        imageAzimuths: {
          ...nodeData.imageAzimuths,
          [index]: value,
        },
      });
    },
    [id, nodeData.imageAzimuths, updateNodeData]
  );

  const handleRegenerate = useCallback(() => {
    regenerateNode(id);
  }, [id, regenerateNode]);

  // ─── Status Rendering ────────────────────────────────────────

  const isLoading = nodeData.status === "loading";
  const isComplete = nodeData.status === "complete";
  const isError = nodeData.status === "error";

  const previewUrl = nodeData.panoUrl || nodeData.thumbnailUrl;

  return (
    <BaseNode
      id={id}
      selected={selected}
      title="Panorama Generator"
      commentNavigation={commentNavigation || undefined}
      onRun={handleRegenerate}
      isExecuting={isRunning}
    >
      {/* Input Handles */}
      <Handle
        type="target"
        position={Position.Left}
        id="image"
        style={{ top: "35%" }}
        className="!w-3 !h-3 !bg-violet-500 !border-violet-700"
      />
      <Handle
        type="target"
        position={Position.Left}
        id="text"
        style={{ top: "65%" }}
        className="!w-3 !h-3 !bg-amber-500 !border-amber-700"
      />

      {/* Output Handle — panorama image */}
      <Handle
        type="source"
        position={Position.Right}
        id="image"
        style={{ top: "35%" }}
        className="!w-3 !h-3 !bg-violet-500 !border-violet-700"
      />

      {/* Output Handle — generated caption text */}
      <Handle
        type="source"
        position={Position.Right}
        id="text"
        style={{ top: "65%" }}
        className="!w-3 !h-3 !bg-amber-500 !border-amber-700"
      />

      <div className="p-3 space-y-3">
        {/* Header */}
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-indigo-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <circle cx="12" cy="12" r="10" />
            <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
          <span className="text-xs font-medium text-neutral-300">Panorama</span>
        </div>

        {/* World Name */}
        <div>
          <label className="text-[10px] text-neutral-500 block mb-1">World Name</label>
          <input
            type="text"
            value={nodeData.worldName}
            onChange={handleWorldNameChange}
            className="w-full bg-neutral-800 text-neutral-200 text-xs rounded px-2 py-1.5 border border-neutral-700 focus:border-indigo-500 focus:outline-none"
            placeholder="My World"
          />
        </div>

        {/* Model Selection */}
        <div>
          <label className="text-[10px] text-neutral-500 block mb-1">Model</label>
          <select
            value={nodeData.model}
            onChange={handleModelChange}
            className="w-full bg-neutral-800 text-neutral-200 text-xs rounded px-2 py-1.5 border border-neutral-700 focus:border-indigo-500 focus:outline-none appearance-none"
          >
            <option value="Marble 0.1-mini">Marble 0.1 Mini (fast)</option>
            <option value="Marble 0.1-plus">Marble 0.1 Plus</option>
          </select>
        </div>

        {/* Seed (Optional) */}
        <div>
          <label className="text-[10px] text-neutral-500 block mb-1">Seed (optional)</label>
          <input
            type="number"
            value={nodeData.seed ?? ""}
            onChange={handleSeedChange}
            className="w-full bg-neutral-800 text-neutral-200 text-xs rounded px-2 py-1.5 border border-neutral-700 focus:border-indigo-500 focus:outline-none"
            placeholder="Random"
          />
        </div>

        {/* Azimuth Controls (shown when 2+ images connected) */}
        {showAzimuthControls && (
          <div>
            <label className="text-[10px] text-neutral-500 block mb-1.5">
              Image Azimuths ({connectedImageCount} images)
            </label>
            <div className="space-y-1">
              {Array.from({ length: connectedImageCount }, (_, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-[10px] text-neutral-600 w-10 shrink-0">
                    Img {i + 1}
                  </span>
                  <select
                    value={nodeData.imageAzimuths[i] ?? DEFAULT_AZIMUTHS[i % DEFAULT_AZIMUTHS.length]}
                    onChange={(e) => handleAzimuthChange(i, Number(e.target.value))}
                    className="flex-1 bg-neutral-800 text-neutral-200 text-[11px] rounded px-1.5 py-1 border border-neutral-700 focus:border-indigo-500 focus:outline-none appearance-none"
                  >
                    {AZIMUTH_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label} ({opt.value}°)
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Status / Preview Area */}
        <div className="bg-neutral-900 rounded-lg overflow-hidden min-h-[80px] flex items-center justify-center">
          {nodeData.status === "idle" && (
            <div className="text-center p-3">
              <svg className="w-8 h-8 text-neutral-700 mx-auto mb-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                <circle cx="12" cy="12" r="10" />
                <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
              <p className="text-[10px] text-neutral-600">Connect prompt or image and run</p>
            </div>
          )}

          {isLoading && (
            <div className="text-center p-3">
              <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto mb-2" />
              <p className="text-xs text-indigo-400">{nodeData.progress || "Generating..."}</p>
            </div>
          )}

          {isError && (
            <div className="text-center p-3">
              <p className="text-xs text-red-400 break-words">{nodeData.error}</p>
            </div>
          )}

          {isComplete && previewUrl && (
            <div className="w-full">
              <img
                src={previewUrl}
                alt={nodeData.worldName}
                className="w-full h-auto object-cover"
              />
              {nodeData.caption && (
                <p className="text-[10px] text-neutral-500 p-2 line-clamp-2">{nodeData.caption}</p>
              )}
            </div>
          )}

          {isComplete && !previewUrl && (
            <div className="text-center p-3">
              <p className="text-xs text-green-400">Panorama generated</p>
            </div>
          )}
        </div>

        {/* Handle labels */}
        <div className="absolute left-5 text-[9px] text-neutral-600" style={{ top: "35%", transform: "translateY(-50%)" }}>
          image
        </div>
        <div className="absolute left-5 text-[9px] text-neutral-600" style={{ top: "65%", transform: "translateY(-50%)" }}>
          text
        </div>
        <div className="absolute right-5 text-[9px] text-neutral-600" style={{ top: "35%", transform: "translateY(-50%)" }}>
          image
        </div>
        <div className="absolute right-5 text-[9px] text-neutral-600" style={{ top: "65%", transform: "translateY(-50%)" }}>
          text
        </div>
      </div>
    </BaseNode>
  );
}
