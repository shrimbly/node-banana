"use client";

import React, { useCallback, useState, useEffect, useRef } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useCommentNavigation } from "@/hooks/useCommentNavigation";
import { useWorkflowStore } from "@/store/workflowStore";
import { WorldLabsWorldNodeData } from "@/types";
import { defaultNodeDimensions } from "@/store/utils/nodeDefaults";

type WorldLabsWorldNodeType = Node<WorldLabsWorldNodeData, "worldLabsWorld">;

/**
 * WorldLabs World Generator node.
 *
 * Generates full 3D Gaussian Splat worlds from a 2:1 panorama image.
 * Defaults to Marble 0.1-plus for production quality.
 * Opens the standalone Spark.js viewer for cinematic framing and capture.
 *
 * Input: image (left 50%) — expects a 2:1 equirectangular panorama
 * Outputs: 3d (right 30%) — SPZ data, image (right 70%) — panorama/thumbnail
 */
export function WorldLabsWorldNode({ id, data, selected }: NodeProps<WorldLabsWorldNodeType>) {
  const nodeData = data;
  const commentNavigation = useCommentNavigation(id);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const addNode = useWorkflowStore((state) => state.addNode);
  const nodes = useWorkflowStore((state) => state.nodes);
  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const isRunning = useWorkflowStore((state) => state.isRunning);
  const viewerWindowRef = useRef<Window | null>(null);
  const [captureCount, setCaptureCount] = useState(0);

  // ─── Viewer window postMessage listener ─────────────────────
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type !== "worldlabs-capture") return;
      if (event.data.worldId !== nodeData.worldId) return;

      const { image, filename, width, height } = event.data;

      // Find current node position
      const currentNode = nodes.find((n) => n.id === id);
      const nodeX = currentNode?.position?.x ?? 0;
      const nodeY = currentNode?.position?.y ?? 0;
      const nodeDims = defaultNodeDimensions.worldLabsWorld;

      // Position new ImageInput node to the right, stacked per capture
      const offsetX = nodeDims.width + 40;
      const offsetY = captureCount * (defaultNodeDimensions.imageInput.height + 20);

      addNode("imageInput", {
        x: nodeX + offsetX,
        y: nodeY + offsetY,
      });

      // Get the last added node and update its data
      setTimeout(() => {
        const latestNodes = useWorkflowStore.getState().nodes;
        const newNode = latestNodes[latestNodes.length - 1];
        if (newNode && newNode.type === "imageInput") {
          updateNodeData(newNode.id, {
            image,
            filename: `${filename}.png`,
            dimensions: width && height ? { width, height } : null,
          });
        }
      }, 50);

      setCaptureCount((c) => c + 1);
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [id, nodeData.worldId, nodes, addNode, updateNodeData, captureCount]);

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
        model: e.target.value as WorldLabsWorldNodeData["model"],
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

  const handleRegenerate = useCallback(() => {
    regenerateNode(id);
  }, [id, regenerateNode]);

  const handleOpenViewer = useCallback(() => {
    if (!nodeData.worldId || !nodeData.spzUrls) return;

    const spzUrl =
      nodeData.spzUrls["500k"] ||
      nodeData.spzUrls.full_res ||
      nodeData.spzUrls["100k"];

    if (!spzUrl) return;

    const params = new URLSearchParams({
      url: spzUrl,
      name: nodeData.worldName || "Untitled World",
      worldId: nodeData.worldId,
    });

    const viewerUrl = `/viewer?${params.toString()}`;
    const w = window.open(viewerUrl, `worldlabs-viewer-${nodeData.worldId}`, "width=1280,height=720");
    viewerWindowRef.current = w;
    updateNodeData(id, { viewerWindowOpen: true });
  }, [id, nodeData.worldId, nodeData.worldName, nodeData.spzUrls, updateNodeData]);

  const handleOpenMarbleViewer = useCallback(() => {
    if (nodeData.marbleViewerUrl) {
      window.open(nodeData.marbleViewerUrl, "_blank");
    }
  }, [nodeData.marbleViewerUrl]);

  // ─── Status Rendering ────────────────────────────────────────

  const isLoading = nodeData.status === "loading";
  const isComplete = nodeData.status === "complete";
  const isError = nodeData.status === "error";

  const previewUrl = nodeData.panoUrl || nodeData.thumbnailUrl;

  return (
    <BaseNode
      id={id}
      selected={selected}
      title="World Generator"
      commentNavigation={commentNavigation || undefined}
      onRun={handleRegenerate}
      isExecuting={isRunning}
    >
      {/* Input Handle — panorama image */}
      <Handle
        type="target"
        position={Position.Left}
        id="image"
        style={{ top: "50%" }}
        className="!w-3 !h-3 !bg-violet-500 !border-violet-700"
      />

      {/* Output Handle — 3D SPZ data */}
      <Handle
        type="source"
        position={Position.Right}
        id="3d"
        style={{ top: "30%" }}
        className="!w-3 !h-3 !bg-emerald-500 !border-emerald-700"
      />

      {/* Output Handle — panorama/thumbnail image */}
      <Handle
        type="source"
        position={Position.Right}
        id="image"
        style={{ top: "70%" }}
        className="!w-3 !h-3 !bg-violet-500 !border-violet-700"
      />

      <div className="p-3 space-y-3">
        {/* Header */}
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-indigo-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <circle cx="12" cy="12" r="10" />
            <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
          <span className="text-xs font-medium text-neutral-300">World Generator</span>
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
            <option value="Marble 0.1-plus">Marble 0.1 Plus</option>
            <option value="Marble 0.1-mini">Marble 0.1 Mini</option>
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

        {/* Status / Preview Area */}
        <div className="bg-neutral-900 rounded-lg overflow-hidden min-h-[80px] flex items-center justify-center">
          {nodeData.status === "idle" && (
            <div className="text-center p-3">
              <svg className="w-8 h-8 text-neutral-700 mx-auto mb-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                <circle cx="12" cy="12" r="10" />
                <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
              <p className="text-[10px] text-neutral-600">Connect panorama image and run</p>
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
              <p className="text-xs text-green-400">World generated</p>
              <p className="text-[10px] text-neutral-500 mt-1">ID: {nodeData.worldId}</p>
            </div>
          )}
        </div>

        {/* Viewer Button */}
        {isComplete && nodeData.spzUrls && (
          <button
            onClick={handleOpenViewer}
            className="w-full bg-violet-600 hover:bg-violet-500 text-white text-xs font-medium py-1.5 px-3 rounded transition-colors flex items-center justify-center gap-1"
          >
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
            Viewer
          </button>
        )}

        {/* Marble Viewer link */}
        {isComplete && nodeData.marbleViewerUrl && (
          <button
            onClick={handleOpenMarbleViewer}
            className="w-full text-[10px] text-neutral-500 hover:text-indigo-400 transition-colors flex items-center justify-center gap-1"
          >
            Open in Marble Viewer
            <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </button>
        )}

        {/* Handle labels */}
        <div className="absolute left-5 text-[9px] text-neutral-600" style={{ top: "50%", transform: "translateY(-50%)" }}>
          image
        </div>
        <div className="absolute right-5 text-[9px] text-neutral-600" style={{ top: "30%", transform: "translateY(-50%)" }}>
          3d
        </div>
        <div className="absolute right-5 text-[9px] text-neutral-600" style={{ top: "70%", transform: "translateY(-50%)" }}>
          image
        </div>
      </div>
    </BaseNode>
  );
}
