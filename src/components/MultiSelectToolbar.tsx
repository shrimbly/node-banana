"use client";

import { MenuDivider, MenuIconButton, MenuSurface } from "@/components/ui/Menu";
import { useReactFlow } from "@xyflow/react";
import { useShallow } from "zustand/shallow";
import { useWorkflowStore } from "@/store/workflowStore";
import { memo, useMemo, useCallback, useState } from "react";
import JSZip from "jszip";
import type {
  ImageInputNodeData,
  AnnotationNodeData,
  NanoBananaNodeData,
  OutputNodeData,
} from "@/types";
import { getNodeSize } from "@/utils/nodeDimensions";

const STACK_GAP = 20;
type Arrangement = "horizontal" | "vertical" | "grid";

// Memoised: rendered by the canvas, which re-renders on every drag frame
export const MultiSelectToolbar = memo(function MultiSelectToolbar() {
  // Only the selection: a drag of anything else must not re-render the toolbar
  const selectedNodes = useWorkflowStore(useShallow((state) => state.nodes.filter((node) => node.selected)));
  const onNodesChange = useWorkflowStore((state) => state.onNodesChange);
  const createGroup = useWorkflowStore((state) => state.createGroup);
  const removeNodesFromGroup = useWorkflowStore((state) => state.removeNodesFromGroup);
  const { getViewport } = useReactFlow();
  const selectionKey = JSON.stringify(selectedNodes.map((node) => node.id).sort());
  const [arrangement, setArrangement] = useState<{
    selectionKey: string;
    mode: Arrangement;
    nodes: typeof selectedNodes;
    position: { x: number; y: number };
    gap: number;
  } | null>(null);

  // Clear the spacing control when the selection changes, including deselection.
  if (arrangement && arrangement.selectionKey !== selectionKey) {
    setArrangement(null);
  }
  const activeArrangement = arrangement?.selectionKey === selectionKey ? arrangement : null;

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
      const nodeWidth = getNodeSize(node).width;
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

  const handleStackHorizontally = (gap: number, nodes = selectedNodes) => {
    if (selectedNodes.length < 2) return;

    // Sort by current x position to maintain relative order
    const sortedNodes = [...nodes].sort((a, b) => a.position.x - b.position.x);

    // Use the topmost y position as the alignment point
    const alignY = Math.min(...sortedNodes.map((n) => n.position.y));

    let currentX = sortedNodes[0].position.x;

    const changes = sortedNodes.map((node) => {
      const nodeWidth = getNodeSize(node).width;

      const change = {
        type: "position" as const,
        id: node.id,
        position: { x: currentX, y: alignY },
      };

      currentX += nodeWidth + gap;
      return change;
    });

    onNodesChange(changes);
  };

  const handleStackVertically = (gap: number, nodes = selectedNodes) => {
    if (selectedNodes.length < 2) return;

    // Sort by current y position to maintain relative order
    const sortedNodes = [...nodes].sort((a, b) => a.position.y - b.position.y);

    // Use the leftmost x position as the alignment point
    const alignX = Math.min(...sortedNodes.map((n) => n.position.x));

    let currentY = sortedNodes[0].position.y;

    const changes = sortedNodes.map((node) => {
      const nodeHeight = getNodeSize(node).height;

      const change = {
        type: "position" as const,
        id: node.id,
        position: { x: alignX, y: currentY },
      };

      currentY += nodeHeight + gap;
      return change;
    });

    onNodesChange(changes);
  };

  const handleArrangeAsGrid = (gap: number, nodes = selectedNodes) => {
    if (selectedNodes.length < 2) return;

    // Calculate optimal grid dimensions (as square as possible)
    const count = nodes.length;
    const cols = Math.ceil(Math.sqrt(count));

    // Sort nodes by their current position (top-to-bottom, left-to-right)
    const sortedNodes = [...nodes].sort((a, b) => {
      const rowA = Math.floor(a.position.y / 100);
      const rowB = Math.floor(b.position.y / 100);
      if (rowA !== rowB) return rowA - rowB;
      return a.position.x - b.position.x;
    });

    // Find the starting position (top-left of bounding box)
    const startX = Math.min(...sortedNodes.map((n) => n.position.x));
    const startY = Math.min(...sortedNodes.map((n) => n.position.y));

    // Get max node dimensions for consistent spacing
    const maxWidth = Math.max(...sortedNodes.map((n) => getNodeSize(n).width));
    const maxHeight = Math.max(...sortedNodes.map((n) => getNodeSize(n).height));

    // Position each node in the grid
    const changes = sortedNodes.map((node, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);

      return {
        type: "position" as const,
        id: node.id,
        position: {
          x: startX + col * (maxWidth + gap),
          y: startY + row * (maxHeight + gap),
        },
      };
    });

    onNodesChange(changes);
  };

  const applyArrangement = (mode: Arrangement, gap: number, nodes = selectedNodes) => {
    if (mode === "horizontal") handleStackHorizontally(gap, nodes);
    else if (mode === "vertical") handleStackVertically(gap, nodes);
    else handleArrangeAsGrid(gap, nodes);
  };

  const chooseArrangement = (mode: Arrangement) => {
    if (!toolbarPosition) return;
    const gap = activeArrangement?.gap ?? STACK_GAP;
    setArrangement({
      selectionKey, mode, nodes: selectedNodes, gap,
      position: activeArrangement?.position ?? toolbarPosition,
    });
    applyArrangement(mode, gap);
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
    <MenuSurface
      variant="bar"
      className="nodrag nopan"
      style={{
        left: activeArrangement?.position.x ?? toolbarPosition.x,
        top: activeArrangement?.position.y ?? toolbarPosition.y,
        transform: "translateX(-50%)",
      }}
    >
      <MenuIconButton
        onClick={() => chooseArrangement("horizontal")}
        aria-pressed={activeArrangement?.mode === "horizontal"}
        title="Stack horizontally"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 4h4v16H6zM14 4h4v16h-4z" />
        </svg>
      </MenuIconButton>
      <MenuIconButton
        onClick={() => chooseArrangement("vertical")}
        aria-pressed={activeArrangement?.mode === "vertical"}
        title="Stack vertically (V)"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16v4H4zM4 14h16v4H4z" />
        </svg>
      </MenuIconButton>
      <MenuIconButton
        onClick={() => chooseArrangement("grid")}
        aria-pressed={activeArrangement?.mode === "grid"}
        title="Arrange as grid (G)"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
        </svg>
      </MenuIconButton>

      {/* Separator */}
      <MenuDivider variant="bar" className="mx-0.5" />

      {/* Group/Ungroup buttons */}
      {someInGroup ? (
        <MenuIconButton
          onClick={handleUngroup}
            title="Remove from group"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" />
          </svg>
        </MenuIconButton>
      ) : (
        <MenuIconButton
          onClick={handleCreateGroup}
            title="Create group"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 7.125C2.25 6.504 2.754 6 3.375 6h6c.621 0 1.125.504 1.125 1.125v3.75c0 .621-.504 1.125-1.125 1.125h-6a1.125 1.125 0 01-1.125-1.125v-3.75zM14.25 8.625c0-.621.504-1.125 1.125-1.125h5.25c.621 0 1.125.504 1.125 1.125v8.25c0 .621-.504 1.125-1.125 1.125h-5.25a1.125 1.125 0 01-1.125-1.125v-8.25zM3.75 16.125c0-.621.504-1.125 1.125-1.125h5.25c.621 0 1.125.504 1.125 1.125v2.25c0 .621-.504 1.125-1.125 1.125h-5.25a1.125 1.125 0 01-1.125-1.125v-2.25z" />
          </svg>
        </MenuIconButton>
      )}

      {/* Separator */}
      <MenuDivider variant="bar" className="mx-0.5" />

      {/* Download images button */}
      <MenuIconButton
        onClick={handleDownloadImages}
        title="Download images as ZIP"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
        </svg>
      </MenuIconButton>
      {activeArrangement && (
        <MenuSurface
          variant="bar"
          floating={false}
          className="absolute top-full left-1/2 mt-1.5 -translate-x-1/2 w-[200px] gap-2 px-2.5 py-1.5"
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <span className="text-[10px] text-neutral-400">Gap</span>
          <input
            type="range"
            aria-label="Node spacing"
            aria-valuetext={`${activeArrangement.gap} pixels`}
            min={0}
            max={200}
            step={1}
            value={activeArrangement.gap}
            className="nodrag nopan min-w-0 flex-1 h-4 accent-neutral-300 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection rounded"
            onChange={(event) => {
              const gap = Number(event.target.value);
              setArrangement({ ...activeArrangement, gap });
              applyArrangement(activeArrangement.mode, gap, activeArrangement.nodes);
            }}
          />
          <span className="w-9 text-right text-[10px] text-neutral-400 tabular-nums">
            {activeArrangement.gap}px
          </span>
        </MenuSurface>
      )}
    </MenuSurface>
  );
});
