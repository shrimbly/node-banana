"use client";

import { useReactFlow } from "@xyflow/react";
import { useWorkflowStore } from "@/store/workflowStore";
import { useMemo, useCallback } from "react";
import JSZip from "jszip";
import type {
  ImageInputNodeData,
  AnnotationNodeData,
  NanoBananaNodeData,
  OutputNodeData,
} from "@/types";

const STACK_GAP = 20;

export function MultiSelectToolbar() {
  const { nodes, onNodesChange, createGroup, removeNodesFromGroup } = useWorkflowStore();
  const { getViewport } = useReactFlow();

  const selectedNodes = useMemo(
    () => nodes.filter((node) => node.selected),
    [nodes]
  );

  // Check if any selected nodes are in a group
  const selectedNodeGroups = useMemo(() => {
    const groupIds = new Set(selectedNodes.map((n) => n.groupId).filter(Boolean));
    return [...groupIds];
  }, [selectedNodes]);

  const someInGroup = selectedNodeGroups.length > 0;

  // Calculate toolbar position (centered above selected nodes)
  const toolbarPosition = useMemo(() => {
    if (selectedNodes.length < 2) return null;

    const viewport = getViewport();

    // Find bounding box of selected nodes
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;

    selectedNodes.forEach((node) => {
      const nodeWidth = (node.style?.width as number) || node.measured?.width || 220;
      minX = Math.min(minX, node.position.x);
      minY = Math.min(minY, node.position.y);
      maxX = Math.max(maxX, node.position.x + nodeWidth);
    });

    // Convert flow coordinates to screen coordinates
    const centerX = (minX + maxX) / 2;
    const screenX = centerX * viewport.zoom + viewport.x;
    const screenY = minY * viewport.zoom + viewport.y - 50; // 50px above the top

    return { x: screenX, y: screenY };
  }, [selectedNodes, getViewport]);

  const handleStackHorizontally = () => {
    if (selectedNodes.length < 2) return;

    // Sort by current x position to maintain relative order
    const sortedNodes = [...selectedNodes].sort((a, b) => a.position.x - b.position.x);

    // Use the topmost y position as the alignment point
    const alignY = Math.min(...sortedNodes.map((n) => n.position.y));

    let currentX = sortedNodes[0].position.x;

    sortedNodes.forEach((node) => {
      const nodeWidth = (node.style?.width as number) || node.measured?.width || 220;

      onNodesChange([
        {
          type: "position",
          id: node.id,
          position: { x: currentX, y: alignY },
        },
      ]);

      currentX += nodeWidth + STACK_GAP;
    });
  };

  const handleStackVertically = () => {
    if (selectedNodes.length < 2) return;

    // Sort by current y position to maintain relative order
    const sortedNodes = [...selectedNodes].sort((a, b) => a.position.y - b.position.y);

    // Use the leftmost x position as the alignment point
    const alignX = Math.min(...sortedNodes.map((n) => n.position.x));

    let currentY = sortedNodes[0].position.y;

    sortedNodes.forEach((node) => {
      const nodeHeight = (node.style?.height as number) || node.measured?.height || 200;

      onNodesChange([
        {
          type: "position",
          id: node.id,
          position: { x: alignX, y: currentY },
        },
      ]);

      currentY += nodeHeight + STACK_GAP;
    });
  };

  const handleArrangeAsGrid = () => {
    if (selectedNodes.length < 2) return;

    // Calculate optimal grid dimensions (as square as possible)
    const count = selectedNodes.length;
    const cols = Math.ceil(Math.sqrt(count));

    // Sort nodes by their current position (top-to-bottom, left-to-right)
    const sortedNodes = [...selectedNodes].sort((a, b) => {
      const rowA = Math.floor(a.position.y / 100);
      const rowB = Math.floor(b.position.y / 100);
      if (rowA !== rowB) return rowA - rowB;
      return a.position.x - b.position.x;
    });

    // Find the starting position (top-left of bounding box)
    const startX = Math.min(...sortedNodes.map((n) => n.position.x));
    const startY = Math.min(...sortedNodes.map((n) => n.position.y));

    // Get max node dimensions for consistent spacing
    const maxWidth = Math.max(
      ...sortedNodes.map((n) => (n.style?.width as number) || n.measured?.width || 220)
    );
    const maxHeight = Math.max(
      ...sortedNodes.map((n) => (n.style?.height as number) || n.measured?.height || 200)
    );

    // Position each node in the grid
    sortedNodes.forEach((node, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);

      onNodesChange([
        {
          type: "position",
          id: node.id,
          position: {
            x: startX + col * (maxWidth + STACK_GAP),
            y: startY + row * (maxHeight + STACK_GAP),
          },
        },
      ]);
    });
  };

  const handleCreateGroup = () => {
    const nodeIds = selectedNodes.map((n) => n.id);
    createGroup(nodeIds);
  };

  const handleUngroup = () => {
    const nodeIds = selectedNodes.map((n) => n.id);
    removeNodesFromGroup(nodeIds);
  };

  const handleDownloadImages = useCallback(async () => {
    // Extract images from selected nodes based on node type
    const images: { data: string; name: string }[] = [];

    selectedNodes.forEach((node, index) => {
      let imageData: string | null = null;

      switch (node.type) {
        case "imageInput":
          imageData = (node.data as ImageInputNodeData).image;
          break;
        case "annotation":
          imageData = (node.data as AnnotationNodeData).outputImage;
          break;
        case "nanoBanana":
          imageData = (node.data as NanoBananaNodeData).outputImage;
          break;
        case "output":
          imageData = (node.data as OutputNodeData).image;
          break;
      }

      if (imageData) {
        images.push({
          data: imageData,
          name: `image-${index + 1}.png`,
        });
      }
    });

    if (images.length === 0) return;

    // Create ZIP file
    const zip = new JSZip();
    images.forEach(({ data, name }) => {
      // Remove data URL prefix to get raw base64
      const base64Data = data.replace(/^data:image\/\w+;base64,/, "");
      zip.file(name, base64Data, { base64: true });
    });

    // Generate and download
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `images-${Date.now()}.zip`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [selectedNodes]);

  if (!toolbarPosition || selectedNodes.length < 2) return null;

  return (
    <div
      className="fixed z-[100] flex items-center gap-1 bg-neutral-800 border border-neutral-600 rounded-lg shadow-xl p-1"
      style={{
        left: toolbarPosition.x,
        top: toolbarPosition.y,
        transform: "translateX(-50%)",
      }}
    >
      <button
        onClick={handleStackHorizontally}
        className="p-1.5 rounded hover:bg-neutral-700 text-neutral-400 hover:text-neutral-100 transition-colors"
        title="Stack horizontally (H)"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 4h4v16H6zM14 4h4v16h-4z" />
        </svg>
      </button>
      <button
        onClick={handleStackVertically}
        className="p-1.5 rounded hover:bg-neutral-700 text-neutral-400 hover:text-neutral-100 transition-colors"
        title="Stack vertically (V)"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16v4H4zM4 14h16v4H4z" />
        </svg>
      </button>
      <button
        onClick={handleArrangeAsGrid}
        className="p-1.5 rounded hover:bg-neutral-700 text-neutral-400 hover:text-neutral-100 transition-colors"
        title="Arrange as grid (G)"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
        </svg>
      </button>

      {/* Separator */}
      <div className="w-px h-4 bg-neutral-600 mx-0.5" />

      {/* Group/Ungroup buttons */}
      {someInGroup ? (
        <button
          onClick={handleUngroup}
          className="p-1.5 rounded hover:bg-neutral-700 text-neutral-400 hover:text-neutral-100 transition-colors"
          title="Remove from group"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" />
          </svg>
        </button>
      ) : (
        <button
          onClick={handleCreateGroup}
          className="p-1.5 rounded hover:bg-neutral-700 text-neutral-400 hover:text-neutral-100 transition-colors"
          title="Create group"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 7.125C2.25 6.504 2.754 6 3.375 6h6c.621 0 1.125.504 1.125 1.125v3.75c0 .621-.504 1.125-1.125 1.125h-6a1.125 1.125 0 01-1.125-1.125v-3.75zM14.25 8.625c0-.621.504-1.125 1.125-1.125h5.25c.621 0 1.125.504 1.125 1.125v8.25c0 .621-.504 1.125-1.125 1.125h-5.25a1.125 1.125 0 01-1.125-1.125v-8.25zM3.75 16.125c0-.621.504-1.125 1.125-1.125h5.25c.621 0 1.125.504 1.125 1.125v2.25c0 .621-.504 1.125-1.125 1.125h-5.25a1.125 1.125 0 01-1.125-1.125v-2.25z" />
          </svg>
        </button>
      )}

      {/* Separator */}
      <div className="w-px h-4 bg-neutral-600 mx-0.5" />

      {/* Download images button */}
      <button
        onClick={handleDownloadImages}
        className="p-1.5 rounded hover:bg-neutral-700 text-neutral-400 hover:text-neutral-100 transition-colors"
        title="Download images as ZIP"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
        </svg>
      </button>
    </div>
  );
}
