"use client";

import React, { useCallback, useState, useEffect, useRef } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useCommentNavigation } from "@/hooks/useCommentNavigation";
import { useWorkflowStore } from "@/store/workflowStore";
import { SpzViewerNodeData } from "@/types";
import { defaultNodeDimensions } from "@/store/utils/nodeDefaults";

type SpzViewerNodeType = Node<SpzViewerNodeData, "spzViewer">;

/** Accepted file extensions */
const ACCEPTED_EXTENSIONS = [".spz", ".ply"];

/**
 * SPZ Viewer node.
 *
 * Lightweight node that opens the external standalone 3D viewer window.
 * Accepts SPZ/PLY URLs from upstream nodes (via "3d" handle) or
 * drag-and-drop of local .spz/.ply files.
 * Captures screenshots from the viewer via postMessage.
 *
 * Input: 3d (left)
 * Output: image (right) — captured screenshots
 */
export function SpzViewerNode({ id, data, selected }: NodeProps<SpzViewerNodeType>) {
  const nodeData = data;
  const commentNavigation = useCommentNavigation(id);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const addNode = useWorkflowStore((state) => state.addNode);
  const nodes = useWorkflowStore((state) => state.nodes);
  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const isRunning = useWorkflowStore((state) => state.isRunning);

  const viewerWindowRef = useRef<Window | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [captureCount, setCaptureCount] = useState(0);

  // ─── Viewer window postMessage listener ─────────────────────
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type !== "worldlabs-capture") return;
      // Use node ID as worldId for routing
      if (event.data.worldId !== id) return;

      const { image, filename, width, height } = event.data;

      // Store captured image in this node
      updateNodeData(id, { capturedImage: image });

      // Also create an ImageInput node to the right with the capture
      const currentNode = nodes.find((n) => n.id === id);
      const nodeX = currentNode?.position?.x ?? 0;
      const nodeY = currentNode?.position?.y ?? 0;
      const nodeDims = defaultNodeDimensions.spzViewer;

      const offsetX = nodeDims.width + 40;
      const offsetY = captureCount * (defaultNodeDimensions.imageInput.height + 20);

      addNode("imageInput", {
        x: nodeX + offsetX,
        y: nodeY + offsetY,
      });

      // Update the new node with captured image data
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

  // ─── Blob URL cleanup on unmount ────────────────────────────
  const blobUrlRef = useRef<string | null>(null);
  useEffect(() => {
    // Track blob URLs for cleanup
    if (nodeData.spzUrl?.startsWith("blob:")) {
      blobUrlRef.current = nodeData.spzUrl;
    }
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
      }
    };
  }, [nodeData.spzUrl]);

  // ─── Handlers ──────────────────────────────────────────────

  const handleRun = useCallback(() => {
    regenerateNode(id);
  }, [id, regenerateNode]);

  const handleOpenViewer = useCallback(() => {
    if (!nodeData.spzUrl) return;

    const params = new URLSearchParams({
      url: nodeData.spzUrl,
      name: nodeData.filename || "SPZ Viewer",
      worldId: id, // Use node ID for postMessage routing
    });

    const viewerUrl = `/viewer?${params.toString()}`;
    const w = window.open(viewerUrl, `spz-viewer-${id}`, "width=1280,height=720");
    viewerWindowRef.current = w;
    updateNodeData(id, { viewerOpen: true });
  }, [id, nodeData.spzUrl, nodeData.filename, updateNodeData]);

  const isAcceptedFile = useCallback((filename: string) => {
    const lower = filename.toLowerCase();
    return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
  }, []);

  const processFile = useCallback(
    (file: File) => {
      if (!isAcceptedFile(file.name)) {
        return;
      }

      // Revoke previous blob URL
      if (nodeData.spzUrl?.startsWith("blob:")) {
        URL.revokeObjectURL(nodeData.spzUrl);
      }

      const url = URL.createObjectURL(file);
      updateNodeData(id, {
        spzUrl: url,
        filename: file.name,
        capturedImage: null,
      });
    },
    [id, nodeData.spzUrl, updateNodeData, isAcceptedFile]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      const file = e.dataTransfer.files?.[0];
      if (!file) return;
      processFile(file);
    },
    [processFile]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      processFile(file);
    },
    [processFile]
  );

  const handleRemove = useCallback(() => {
    if (nodeData.spzUrl?.startsWith("blob:")) {
      URL.revokeObjectURL(nodeData.spzUrl);
    }
    // Close viewer window if open
    if (viewerWindowRef.current && !viewerWindowRef.current.closed) {
      viewerWindowRef.current.close();
    }
    updateNodeData(id, {
      spzUrl: null,
      filename: null,
      capturedImage: null,
      viewerOpen: false,
    });
  }, [id, nodeData.spzUrl, updateNodeData]);

  // ─── Render ─────────────────────────────────────────────────

  const hasFile = !!nodeData.spzUrl;

  return (
    <BaseNode
      id={id}
      selected={selected}
      title="SPZ Viewer"
      commentNavigation={commentNavigation || undefined}
      onRun={handleRun}
      isExecuting={isRunning}
    >
      {/* Input Handle — 3D data */}
      <Handle
        type="target"
        position={Position.Left}
        id="3d"
        style={{ top: "50%" }}
        className="!w-3 !h-3 !bg-emerald-500 !border-emerald-700"
      />

      {/* Output Handle — captured image */}
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
          <svg className="w-4 h-4 text-emerald-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <circle cx="12" cy="12" r="10" />
            <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
          <span className="text-xs font-medium text-neutral-300">SPZ Viewer</span>
          {nodeData.viewerOpen && (
            <span className="text-[9px] text-emerald-400 ml-auto flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Viewer open
            </span>
          )}
        </div>

        {/* Drop Zone / File Info */}
        {!hasFile ? (
          <div
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            className={`rounded-lg border-2 border-dashed transition-colors min-h-[80px] flex flex-col items-center justify-center cursor-pointer ${
              isDragging
                ? "border-emerald-500 bg-emerald-500/10"
                : "border-neutral-700 hover:border-neutral-600 bg-neutral-900"
            }`}
          >
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
              Drop <code className="text-emerald-400">.spz</code> or{" "}
              <code className="text-emerald-400">.ply</code> file
              <br />
              or connect 3D input
            </p>
            <label className="mt-2 text-[10px] text-emerald-500 hover:text-emerald-400 cursor-pointer transition-colors">
              Browse
              <input
                type="file"
                accept=".spz,.ply"
                onChange={handleFileSelect}
                className="hidden"
              />
            </label>
          </div>
        ) : (
          <div className="space-y-2">
            {/* File info */}
            <div className="flex items-center gap-2 bg-neutral-900 rounded-lg px-2 py-1.5">
              <svg className="w-3.5 h-3.5 text-emerald-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <span className="text-xs text-neutral-300 truncate flex-1">
                {nodeData.filename}
              </span>
              <button
                onClick={handleRemove}
                className="text-neutral-500 hover:text-red-400 transition-colors shrink-0"
                title="Remove file"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Open Viewer button */}
            <button
              onClick={handleOpenViewer}
              className="w-full bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium py-1.5 px-3 rounded transition-colors flex items-center justify-center gap-1.5"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
              {nodeData.viewerOpen ? "Focus Viewer" : "Open Viewer"}
            </button>

            {/* Drag-and-drop overlay for replacing file */}
            <div
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              className="w-full"
            >
              {isDragging && (
                <div className="rounded-lg border-2 border-dashed border-emerald-500 bg-emerald-500/10 py-2 text-center">
                  <p className="text-[10px] text-emerald-400">Drop to replace</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Capture preview */}
        {nodeData.capturedImage && (
          <div className="bg-neutral-900 rounded-lg overflow-hidden">
            <img
              src={nodeData.capturedImage}
              alt="Captured view"
              className="w-full h-auto object-cover"
            />
            <p className="text-[9px] text-neutral-500 px-2 py-1">
              Latest capture
            </p>
          </div>
        )}

        {/* Handle labels */}
        <div className="absolute left-5 text-[9px] text-neutral-600" style={{ top: "50%", transform: "translateY(-50%)" }}>
          3d
        </div>
        <div className="absolute right-5 text-[9px] text-neutral-600" style={{ top: "50%", transform: "translateY(-50%)" }}>
          image
        </div>
      </div>
    </BaseNode>
  );
}
