"use client";

import React, { useCallback, useState, useEffect, useRef } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useCommentNavigation } from "@/hooks/useCommentNavigation";
import { useWorkflowStore } from "@/store/workflowStore";
import { PanoViewerNodeData } from "@/types";
import { defaultNodeDimensions } from "@/store/utils/nodeDefaults";

type PanoViewerNodeType = Node<PanoViewerNodeData, "panoViewer">;

/**
 * Panorama Viewer node.
 *
 * Opens an equirectangular panorama in a standalone viewer window.
 * The viewer provides a draggable rectangle overlay for capturing
 * perspective snapshots with camera metadata (yaw, pitch, FOV, etc.).
 *
 * Each capture creates a PanoCrop node to the right of this node,
 * holding both the perspective image and its metadata.
 *
 * Input: image (left) — equirectangular panorama
 */
export function PanoViewerNode({ id, data, selected }: NodeProps<PanoViewerNodeType>) {
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
      if (event.data?.type !== "pano-crop-capture") return;
      if (event.data.nodeId !== id) return;

      const { image, metadata, width, height } = event.data;

      // Create a PanoCrop node to the right of this node
      const currentNode = nodes.find((n) => n.id === id);
      const nodeX = currentNode?.position?.x ?? 0;
      const nodeY = currentNode?.position?.y ?? 0;
      const nodeDims = defaultNodeDimensions.panoViewer;

      const offsetX = nodeDims.width + 40;
      const offsetY = captureCount * (defaultNodeDimensions.panoCrop.height + 20);

      addNode("panoCrop", {
        x: nodeX + offsetX,
        y: nodeY + offsetY,
      });

      // Update the new panoCrop node with captured data
      setTimeout(() => {
        const latestNodes = useWorkflowStore.getState().nodes;
        const newNode = latestNodes[latestNodes.length - 1];
        if (newNode && newNode.type === "panoCrop") {
          updateNodeData(newNode.id, {
            image,
            metadata: JSON.stringify(metadata),
            filename: `pano-crop-${Date.now()}.png`,
            dimensions: width && height ? { width, height } : null,
          });
        }
      }, 50);

      setCaptureCount((c) => c + 1);
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [id, nodes, addNode, updateNodeData, captureCount]);

  // ─── Check if viewer window is still open ───────────────────
  useEffect(() => {
    if (!nodeData.viewerOpen) return;

    const interval = setInterval(() => {
      if (viewerWindowRef.current?.closed) {
        viewerWindowRef.current = null;
        updateNodeData(id, { viewerOpen: false });
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [id, nodeData.viewerOpen, updateNodeData]);

  // ─── Handlers ──────────────────────────────────────────────

  const handleRun = useCallback(() => {
    regenerateNode(id);
  }, [id, regenerateNode]);

  const handleOpenViewer = useCallback(() => {
    if (!nodeData.panoUrl) return;

    const params = new URLSearchParams({
      name: "Panorama Viewer",
      nodeId: id,
    });

    // For data URLs (large base64 from PanoEditor), use sessionStorage
    // to avoid exceeding browser URL length limits
    if (nodeData.panoUrl.startsWith("data:")) {
      const storageKey = `pano-data-${id}-${Date.now()}`;
      sessionStorage.setItem(storageKey, nodeData.panoUrl);
      params.set("storageKey", storageKey);
    } else {
      params.set("url", nodeData.panoUrl);
    }

    const viewerUrl = `/viewer/pano?${params.toString()}`;
    const w = window.open(viewerUrl, `pano-viewer-${id}`, "width=1280,height=720");
    viewerWindowRef.current = w;
    updateNodeData(id, { viewerOpen: true });
  }, [id, nodeData.panoUrl, updateNodeData]);

  // ─── Render ─────────────────────────────────────────────────

  const hasPano = !!nodeData.panoUrl;

  return (
    <BaseNode
      id={id}
      selected={selected}
      title="Pano Viewer"
      commentNavigation={commentNavigation || undefined}
      onRun={handleRun}
      isExecuting={isRunning}
    >
      {/* Input Handle — equirectangular panorama */}
      <Handle
        type="target"
        position={Position.Left}
        id="image"
        style={{ top: "50%" }}
        className="!w-3 !h-3 !bg-violet-500 !border-violet-700"
      />

      <div className="p-3 space-y-3">
        {/* Header */}
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-pink-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <circle cx="12" cy="12" r="10" />
            <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
          <span className="text-xs font-medium text-neutral-300">Pano Viewer</span>
          {nodeData.viewerOpen && (
            <span className="text-[9px] text-pink-400 ml-auto flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-pink-400 animate-pulse" />
              Viewer open
            </span>
          )}
        </div>

        {/* Content area */}
        {!hasPano ? (
          <div className="rounded-lg border-2 border-dashed border-neutral-700 bg-neutral-900 min-h-[80px] flex flex-col items-center justify-center">
            <svg
              className="w-8 h-8 text-neutral-600 mb-1"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
            <p className="text-[10px] text-neutral-500 text-center px-2">
              Connect a panorama source
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {/* Panorama thumbnail */}
            <div className="bg-neutral-900 rounded-lg overflow-hidden">
              <img
                src={nodeData.panoUrl!}
                alt="Panorama"
                className="w-full h-auto object-cover max-h-[80px]"
              />
            </div>

            {/* Open Viewer button */}
            <button
              onClick={handleOpenViewer}
              className="w-full bg-pink-600 hover:bg-pink-500 text-white text-xs font-medium py-1.5 px-3 rounded transition-colors flex items-center justify-center gap-1.5"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
              {nodeData.viewerOpen ? "Focus Viewer" : "Open Viewer"}
            </button>
          </div>
        )}

        {/* Handle labels */}
        <div className="absolute left-5 text-[9px] text-neutral-600" style={{ top: "50%", transform: "translateY(-50%)" }}>
          pano
        </div>
      </div>
    </BaseNode>
  );
}
