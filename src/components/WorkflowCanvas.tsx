"use client";

import { useCallback, useRef, useState, useEffect, DragEvent, useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  NodeTypes,
  EdgeTypes,
  Connection,
  Edge,
  useReactFlow,
  OnConnectEnd,
  Node,
  OnSelectionChangeParams,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { useWorkflowStore, WorkflowFile } from "@/store/workflowStore";
import { useToast } from "@/components/Toast";
import dynamic from "next/dynamic";
import {
  ImageInputNode,
  AudioInputNode,
  AnnotationNode,
  PromptNode,
  ArrayNode,
  PromptConstructorNode,
  GenerateImageNode,
  GenerateVideoNode,
  Generate3DNode,
  GenerateAudioNode,
  LLMGenerateNode,
  SplitGridNode,
  OutputNode,
  OutputGalleryNode,
  ImageCompareNode,
  VideoStitchNode,
  EaseCurveNode,
  VideoTrimNode,
  VideoFrameGrabNode,
} from "./nodes";

// Lazy-load GLBViewerNode to avoid bundling three.js for users who don't use 3D nodes
const GLBViewerNode = dynamic(() => import("./nodes/GLBViewerNode").then(mod => ({ default: mod.GLBViewerNode })), { ssr: false });
import { EditableEdge, ReferenceEdge } from "./edges";
import { ConnectionDropMenu, MenuAction } from "./ConnectionDropMenu";
import { MultiSelectToolbar } from "./MultiSelectToolbar";
import { EdgeToolbar } from "./EdgeToolbar";
import { GlobalImageHistory } from "./GlobalImageHistory";
import { GroupBackgroundsPortal, GroupControlsOverlay } from "./GroupsOverlay";
import { NodeType, NanoBananaNodeData } from "@/types";
import { defaultNodeDimensions } from "@/store/utils/nodeDefaults";
import { detectAndSplitGrid } from "@/utils/gridSplitter";
import { logger } from "@/utils/logger";
import { WelcomeModal } from "./quickstart";
import { ProjectSetupModal } from "./ProjectSetupModal";
import { ChatPanel } from "./ChatPanel";
import { EditOperation } from "@/lib/chat/editOperations";
import { stripBinaryData } from "@/lib/chat/contextBuilder";

const nodeTypes: NodeTypes = {
  imageInput: ImageInputNode,
  audioInput: AudioInputNode,
  annotation: AnnotationNode,
  prompt: PromptNode,
  array: ArrayNode,
  promptConstructor: PromptConstructorNode,
  nanoBanana: GenerateImageNode,
  generateVideo: GenerateVideoNode,
  generate3d: Generate3DNode,
  generateAudio: GenerateAudioNode,
  llmGenerate: LLMGenerateNode,
  splitGrid: SplitGridNode,
  output: OutputNode,
  outputGallery: OutputGalleryNode,
  imageCompare: ImageCompareNode,
  videoStitch: VideoStitchNode,
  easeCurve: EaseCurveNode,
  videoTrim: VideoTrimNode,
  videoFrameGrab: VideoFrameGrabNode,
  glbViewer: GLBViewerNode,
};

const edgeTypes: EdgeTypes = {
  editable: EditableEdge,
  reference: ReferenceEdge,
};

// Connection validation rules
// - Image handles (green) can only connect to image handles
// - Text handles (blue) can only connect to text handles
// - Video handles can only connect to generateVideo or output nodes
// Helper to determine handle type from handle ID
// For dynamic handles, we use naming convention: image inputs contain "image", text inputs are "prompt" or "negative_prompt"
const getHandleType = (handleId: string | null | undefined): "image" | "text" | "video" | "audio" | "3d" | "easeCurve" | null => {
  if (!handleId) return null;
  // EaseCurve handles (must check before other types)
  if (handleId === "easeCurve") return "easeCurve";
  // 3D handles
  if (handleId === "3d") return "3d";
  // Standard handles
  if (handleId === "video") return "video";
  if (handleId === "audio" || handleId.startsWith("audio")) return "audio";
  if (handleId === "image" || handleId === "text") return handleId;
  // Dynamic handles - check naming patterns (including indexed: text-0, image-0)
  if (handleId.includes("video")) return "video";
  if (handleId.startsWith("image-") || handleId.includes("image") || handleId.includes("frame")) return "image";
  if (handleId.startsWith("text-") || handleId === "prompt" || handleId === "negative_prompt" || handleId.includes("prompt")) return "text";
  return null;
};

// Define which handles each node type has
const getNodeHandles = (nodeType: string): { inputs: string[]; outputs: string[] } => {
  switch (nodeType) {
    case "imageInput":
      return { inputs: ["reference"], outputs: ["image"] };
    case "audioInput":
      return { inputs: ["audio"], outputs: ["audio"] };
    case "annotation":
      return { inputs: ["image"], outputs: ["image"] };
    case "prompt":
      return { inputs: ["text"], outputs: ["text"] };
    case "array":
      return { inputs: ["text"], outputs: ["text"] };
    case "promptConstructor":
      return { inputs: ["text"], outputs: ["text"] };
    case "nanoBanana":
      return { inputs: ["image", "text"], outputs: ["image"] };
    case "generateVideo":
      return { inputs: ["image", "text"], outputs: ["video"] };
    case "generate3d":
      return { inputs: ["image", "text"], outputs: ["3d"] };
    case "generateAudio":
      return { inputs: ["text"], outputs: ["audio"] };
    case "llmGenerate":
      return { inputs: ["text", "image"], outputs: ["text"] };
    case "splitGrid":
      return { inputs: ["image"], outputs: ["reference"] };
    case "output":
      return { inputs: ["image", "video", "audio"], outputs: [] };
    case "outputGallery":
      return { inputs: ["image"], outputs: [] };
    case "imageCompare":
      return { inputs: ["image"], outputs: [] };
    case "videoStitch":
      return { inputs: ["video", "audio"], outputs: ["video"] };
    case "easeCurve":
      return { inputs: ["video", "easeCurve"], outputs: ["video", "easeCurve"] };
    case "videoTrim":
      return { inputs: ["video"], outputs: ["video"] };
    case "videoFrameGrab":
      return { inputs: ["video"], outputs: ["image"] };
    case "glbViewer":
      return { inputs: ["3d"], outputs: ["image"] };
    default:
      return { inputs: [], outputs: [] };
  }
};

interface ConnectionDropState {
  position: { x: number; y: number };
  flowPosition: { x: number; y: number };
  handleType: "image" | "text" | "video" | "audio" | "3d" | "easeCurve" | null;
  connectionType: "source" | "target";
  sourceNodeId: string | null;
  sourceHandleId: string | null;
}

// Detect if running on macOS for platform-specific trackpad behavior
const isMacOS = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);

// Detect if a wheel event is from a mouse (vs trackpad)
const isMouseWheel = (event: WheelEvent): boolean => {
  // Mouse scroll wheel typically uses deltaMode 1 (lines) or has large discrete deltas
  // Trackpad uses deltaMode 0 (pixels) with smaller, smoother deltas
  if (event.deltaMode === 1) return true; // DOM_DELTA_LINE = mouse

  // Fallback: large delta values suggest mouse wheel
  const threshold = 50;
  return Math.abs(event.deltaY) >= threshold &&
         Math.abs(event.deltaY) % 40 === 0; // Mouse deltas often in multiples
};

// Check if an element can scroll and has room to scroll in the given direction
const canElementScroll = (element: HTMLElement, deltaX: number, deltaY: number): boolean => {
  const style = window.getComputedStyle(element);
  const overflowY = style.overflowY;
  const overflowX = style.overflowX;

  const canScrollY = overflowY === 'auto' || overflowY === 'scroll';
  const canScrollX = overflowX === 'auto' || overflowX === 'scroll';

  // Check if there's room to scroll in the delta direction
  if (canScrollY && deltaY !== 0) {
    const hasVerticalScroll = element.scrollHeight > element.clientHeight;
    if (hasVerticalScroll) {
      // Check if we can scroll further in the delta direction
      if (deltaY > 0 && element.scrollTop < element.scrollHeight - element.clientHeight) {
        return true; // Can scroll down
      }
      if (deltaY < 0 && element.scrollTop > 0) {
        return true; // Can scroll up
      }
    }
  }

  if (canScrollX && deltaX !== 0) {
    const hasHorizontalScroll = element.scrollWidth > element.clientWidth;
    if (hasHorizontalScroll) {
      if (deltaX > 0 && element.scrollLeft < element.scrollWidth - element.clientWidth) {
        return true; // Can scroll right
      }
      if (deltaX < 0 && element.scrollLeft > 0) {
        return true; // Can scroll left
      }
    }
  }

  return false;
};

// Find if the target element or any ancestor is scrollable
const findScrollableAncestor = (target: HTMLElement, deltaX: number, deltaY: number): HTMLElement | null => {
  let current: HTMLElement | null = target;

  while (current && !current.classList.contains('react-flow')) {
    // Check for nowheel class (React Flow convention for elements that should handle their own scroll)
    if (current.classList.contains('nowheel') || current.tagName === 'TEXTAREA') {
      if (canElementScroll(current, deltaX, deltaY)) {
        return current;
      }
    }
    current = current.parentElement;
  }

  return null;
};

export function WorkflowCanvas() {
  const { nodes, edges, groups, selectedGroupId, setSelectedGroupId, deleteSelection, onNodesChange, onEdgesChange, onConnect, addNode, updateNodeData, loadWorkflow, getNodeById, addToGlobalHistory, setNodeGroupId, executeWorkflow, isModalOpen, showQuickstart, setShowQuickstart, navigationTarget, setNavigationTarget, captureSnapshot, applyEditOperations, setWorkflowMetadata, canvasNavigationSettings, setShortcutsDialogOpen, undo, redo, canUndo, canRedo, _pushHistorySnapshot: pushHistorySnapshot } =
    useWorkflowStore();
  const { screenToFlowPosition, getViewport, zoomIn, zoomOut, setViewport, setCenter } = useReactFlow();
  const { show: showToast } = useToast();
  const [isDragOver, setIsDragOver] = useState(false);
  const [dropType, setDropType] = useState<"image" | "audio" | "workflow" | "node" | null>(null);
  const [connectionDrop, setConnectionDrop] = useState<ConnectionDropState | null>(null);
  const [isSplitting, setIsSplitting] = useState(false);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [isBuildingWorkflow, setIsBuildingWorkflow] = useState(false);
  const [showNewProjectSetup, setShowNewProjectSetup] = useState(false);
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const lastUndoRedoAtRef = useRef(0);

  // Detect if canvas is empty for showing quickstart
  const isCanvasEmpty = nodes.length === 0;

  // Handle comment navigation - center viewport on target node
  useEffect(() => {
    if (navigationTarget) {
      const targetNode = nodes.find((n) => n.id === navigationTarget.nodeId);
      if (targetNode) {
        // Calculate center of node
        const nodeWidth = (targetNode.style?.width as number) || 300;
        const nodeHeight = (targetNode.style?.height as number) || 280;
        const centerX = targetNode.position.x + nodeWidth / 2;
        const centerY = targetNode.position.y + nodeHeight / 2;

        // Navigate to node center with animation, zoomed out to 0.7 for better context
        setCenter(centerX, centerY, { duration: 300, zoom: 0.7 });
      }
      // Clear navigation target after navigating
      setNavigationTarget(null);
    }
  }, [navigationTarget, nodes, setCenter, setNavigationTarget]);

  // Just pass regular nodes to React Flow - groups are rendered separately
  const allNodes = useMemo(() => {
    return nodes;
  }, [nodes]);


  // Check if a node was dropped into a group and add it to that group
  const handleNodeDragStop = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      // Skip if it's a group node
      if (node.id.startsWith("group-")) return;

      const defaults = defaultNodeDimensions[node.type as NodeType] || { width: 300, height: 280 };
      const nodeWidth = node.measured?.width || (node.style?.width as number) || defaults.width;
      const nodeHeight = node.measured?.height || (node.style?.height as number) || defaults.height;
      const nodeCenterX = node.position.x + nodeWidth / 2;
      const nodeCenterY = node.position.y + nodeHeight / 2;

      // Check if node center is inside any group
      let targetGroupId: string | undefined;

      for (const group of Object.values(groups)) {
        const inBoundsX = nodeCenterX >= group.position.x && nodeCenterX <= group.position.x + group.size.width;
        const inBoundsY = nodeCenterY >= group.position.y && nodeCenterY <= group.position.y + group.size.height;

        if (inBoundsX && inBoundsY) {
          targetGroupId = group.id;
          break;
        }
      }

      // Get current groupId of the node
      const currentNode = nodes.find((n) => n.id === node.id);
      const currentGroupId = currentNode?.groupId;

      // Update groupId if it changed
      if (targetGroupId !== currentGroupId) {
        setNodeGroupId(node.id, targetGroupId);
      }
    },
    [groups, nodes, setNodeGroupId]
  );

  // Connection validation - checks if a connection is valid based on handle types and node types
  // Defined inside component to have access to nodes array for video validation
  const isValidConnection = useCallback(
    (connection: Connection | Edge): boolean => {
      const sourceType = getHandleType(connection.sourceHandle);
      const targetType = getHandleType(connection.targetHandle);

      // If we can't determine types, allow the connection
      if (!sourceType || !targetType) return true;

      // EaseCurve connections: only between easeCurve nodes
      if (sourceType === "easeCurve" || targetType === "easeCurve") {
        if (sourceType !== "easeCurve" || targetType !== "easeCurve") return false;
        const targetNode = nodes.find((n) => n.id === connection.target);
        return targetNode?.type === "easeCurve";
      }

      // Video connections have special rules
      if (sourceType === "video") {
        // Video source can ONLY connect to:
        // 1. generateVideo nodes (for video-to-video)
        // 2. videoStitch nodes (for concatenation)
        // 3. output nodes (for display)
        const targetNode = nodes.find((n) => n.id === connection.target);
        if (!targetNode) return false;

        const targetNodeType = targetNode.type;
        if (targetNodeType === "generateVideo" || targetNodeType === "videoStitch" || targetNodeType === "easeCurve" || targetNodeType === "videoTrim" || targetNodeType === "videoFrameGrab" || targetNodeType === "output") {
          // For output node, we allow video even though its handle is typed as "image"
          // because output node can display both images and videos
          return true;
        }
        // Video cannot connect to other node types
        return false;
      }

      // 3D connections: 3d handles can only connect to matching 3d handles
      if (sourceType === "3d" || targetType === "3d") {
        return sourceType === "3d" && targetType === "3d";
      }

      // Audio connections: audio handles connect to audio handles, plus output node
      if (sourceType === "audio" || targetType === "audio") {
        if (sourceType === "audio") {
          const targetNode = nodes.find((n) => n.id === connection.target);
          if (targetNode?.type === "output") return true;
        }
        return sourceType === "audio" && targetType === "audio";
      }

      // Standard type matching for image and text
      // Image handles connect to image handles, text handles connect to text handles
      return sourceType === targetType;
    },
    [nodes]
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!isValidConnection(connection)) return;

      // For imageCompare nodes, redirect to the second handle if the first is occupied
      const resolveImageCompareHandle = (conn: Connection, batchUsed?: Set<string>): Connection => {
        const targetNode = nodes.find((n) => n.id === conn.target);
        if (targetNode?.type === "imageCompare" && conn.targetHandle === "image") {
          const imageOccupied = edges.some(
            (e) => e.target === conn.target && e.targetHandle === "image"
          ) || batchUsed?.has("image");
          if (imageOccupied) {
            return { ...conn, targetHandle: "image-1" };
          }
        }
        return conn;
      };

      // Get all selected nodes
      const selectedNodes = nodes.filter((node) => node.selected);
      const sourceNode = nodes.find((node) => node.id === connection.source);

      // If the source node is selected and there are multiple selected nodes,
      // connect all selected nodes that have the same source handle type
      if (sourceNode?.selected && selectedNodes.length > 1 && connection.sourceHandle) {
        const batchUsed = new Set<string>();

        selectedNodes.forEach((node) => {
          // Skip if this is already the connection source
          if (node.id === connection.source) {
            let resolved = resolveImageCompareHandle(connection, batchUsed);
            // Resolve videoStitch handles for batch connections
            const tgtNode = nodes.find((n) => n.id === resolved.target);
            if (tgtNode?.type === "videoStitch" && resolved.targetHandle?.startsWith("video-")) {
              for (let i = 0; i < 50; i++) {
                const candidateHandle = `video-${i}`;
                const isOccupied = edges.some(
                  (e) => e.target === resolved.target && e.targetHandle === candidateHandle
                ) || batchUsed.has(candidateHandle);
                if (!isOccupied) {
                  resolved = { ...resolved, targetHandle: candidateHandle };
                  batchUsed.add(candidateHandle);
                  break;
                }
              }
            }
            if (resolved.targetHandle) batchUsed.add(resolved.targetHandle);
            onConnect(resolved);
            return;
          }

          // Check if this node actually has the same output handle type
          const nodeHandles = getNodeHandles(node.type || "");
          if (!nodeHandles.outputs.includes(connection.sourceHandle as string)) {
            // This node doesn't have the same output handle type, skip it
            return;
          }

          // Create connection from this selected node to the same target
          let multiConnection: Connection = {
            source: node.id,
            sourceHandle: connection.sourceHandle,
            target: connection.target,
            targetHandle: connection.targetHandle,
          };

          // Resolve videoStitch handle for batch connections
          const targetNode = nodes.find((n) => n.id === multiConnection.target);
          if (targetNode?.type === "videoStitch" && multiConnection.targetHandle?.startsWith("video-")) {
            for (let i = 0; i < 50; i++) {
              const candidateHandle = `video-${i}`;
              const isOccupied = edges.some(
                (e) => e.target === multiConnection.target && e.targetHandle === candidateHandle
              ) || batchUsed.has(candidateHandle);
              if (!isOccupied) {
                multiConnection = { ...multiConnection, targetHandle: candidateHandle };
                batchUsed.add(candidateHandle);
                break;
              }
            }
          }

          const resolved = resolveImageCompareHandle(multiConnection, batchUsed);
          if (resolved.targetHandle) batchUsed.add(resolved.targetHandle);
          if (isValidConnection(resolved)) {
            onConnect(resolved);
          }
        });
      } else {
        // Single connection
        onConnect(resolveImageCompareHandle(connection));
      }
    },
    [onConnect, nodes, edges]
  );

  // Handle connection dropped on empty space or on a node
  const handleConnectEnd: OnConnectEnd = useCallback(
    (event, connectionState) => {
      // If connection was completed normally, nothing to do
      if (connectionState.isValid || !connectionState.fromNode) {
        return;
      }

      const { clientX, clientY } = event as MouseEvent;
      const fromHandleId = connectionState.fromHandle?.id || null;
      const fromHandleType = getHandleType(fromHandleId); // Use getHandleType for dynamic handles
      const isFromSource = connectionState.fromHandle?.type === "source";

      // Helper to find a compatible handle on a node by type
      const findCompatibleHandle = (
        node: Node,
        handleType: "image" | "text" | "video" | "audio" | "3d" | "easeCurve",
        needInput: boolean,
        batchUsed?: Set<string>
      ): string | null => {
        // Check for dynamic inputSchema first
        const nodeData = node.data as { inputSchema?: Array<{ name: string; type: string }> };
        if (nodeData.inputSchema && nodeData.inputSchema.length > 0) {
          if (needInput) {
            // Find input handles matching the type
            const matchingInputs = nodeData.inputSchema.filter(i => i.type === handleType);
            const numHandles = matchingInputs.length;
            if (numHandles > 0) {
              // Find the first unoccupied indexed handle by checking existing edges and batchUsed
              for (let i = 0; i < numHandles; i++) {
                const candidateHandle = `${handleType}-${i}`;
                const isOccupied = edges.some(
                  (edge) => edge.target === node.id && edge.targetHandle === candidateHandle
                ) || batchUsed?.has(candidateHandle);
                if (!isOccupied) {
                  return candidateHandle;
                }
              }
              // All handles are occupied
              return null;
            }
          }
          // Output handle - check for video, 3d, or image type
          if (handleType === "video") return "video";
          if (handleType === "3d") return "3d";
          return handleType === "image" ? "image" : null;
        }

        // VideoStitch has dynamic indexed video input handles (video-0, video-1, ...)
        if (node.type === "videoStitch" && needInput && handleType === "video") {
          for (let i = 0; i < 50; i++) {
            const candidateHandle = `video-${i}`;
            const isOccupied = edges.some(
              (edge) => edge.target === node.id && edge.targetHandle === candidateHandle
            ) || batchUsed?.has(candidateHandle);
            if (!isOccupied) return candidateHandle;
          }
          return null;
        }

        // Fall back to static handles
        const staticHandles = getNodeHandles(node.type || "");
        const handleList = needInput ? staticHandles.inputs : staticHandles.outputs;

        // First try exact match
        if (handleList.includes(handleType)) return handleType;

        // For video output connecting to output node, allow "image" input (output node accepts both)
        if (handleType === "video" && needInput && node.type === "output") {
          return "image";
        }

        // For audio output connecting to output node, use the "audio" input handle
        if (handleType === "audio" && needInput && node.type === "output") {
          return "audio";
        }

        // Then check each handle's type
        for (const h of handleList) {
          if (getHandleType(h) === handleType) return h;
        }

        return null;
      };

      // Check if we dropped on a node by looking for node elements under the cursor
      const elementsUnderCursor = document.elementsFromPoint(clientX, clientY);
      const nodeElement = elementsUnderCursor.find((el) => {
        // React Flow nodes have data-id attribute
        return el.closest(".react-flow__node");
      });

      if (nodeElement) {
        const nodeWrapper = nodeElement.closest(".react-flow__node") as HTMLElement;
        const targetNodeId = nodeWrapper?.dataset.id;

        if (targetNodeId && targetNodeId !== connectionState.fromNode.id && fromHandleType) {
          const targetNode = nodes.find((n) => n.id === targetNodeId);

          if (targetNode) {
            // Find a compatible handle on the target node
            const compatibleHandle = findCompatibleHandle(
              targetNode,
              fromHandleType,
              isFromSource // need input if dragging from output
            );

            if (compatibleHandle) {
              // Create the connection
              const connection: Connection = isFromSource
                ? {
                    source: connectionState.fromNode.id,
                    sourceHandle: fromHandleId,
                    target: targetNodeId,
                    targetHandle: compatibleHandle,
                  }
                : {
                    source: targetNodeId,
                    sourceHandle: compatibleHandle,
                    target: connectionState.fromNode.id,
                    targetHandle: fromHandleId,
                  };

              if (isValidConnection(connection)) {
                handleConnect(connection);
                return; // Connection made, don't show menu
              }
            }
          }
        }
      }

      // No node under cursor or no compatible handle - show the drop menu
      const flowPos = screenToFlowPosition({ x: clientX, y: clientY });

      setConnectionDrop({
        position: { x: clientX, y: clientY },
        flowPosition: flowPos,
        handleType: fromHandleType,
        connectionType: isFromSource ? "source" : "target",
        sourceNodeId: connectionState.fromNode.id,
        sourceHandleId: fromHandleId,
      });
    },
    [screenToFlowPosition, nodes, edges, handleConnect]
  );

  // Handle the splitGrid action - uses automated grid detection
  const handleSplitGridAction = useCallback(
    async (sourceNodeId: string, flowPosition: { x: number; y: number }) => {
      const sourceNode = getNodeById(sourceNodeId);
      if (!sourceNode) return;

      // Get the output image from the source node
      let sourceImage: string | null = null;
      if (sourceNode.type === "nanoBanana") {
        sourceImage = (sourceNode.data as NanoBananaNodeData).outputImage;
      } else if (sourceNode.type === "imageInput") {
        sourceImage = (sourceNode.data as { image: string | null }).image;
      } else if (sourceNode.type === "annotation") {
        sourceImage = (sourceNode.data as { outputImage: string | null }).outputImage;
      }

      if (!sourceImage) {
        alert("No image available to split. Generate or load an image first.");
        return;
      }

      const sourceNodeData = sourceNode.type === "nanoBanana" ? sourceNode.data as NanoBananaNodeData : null;
      setIsSplitting(true);

      try {
        const { grid, images } = await detectAndSplitGrid(sourceImage);

        if (images.length === 0) {
          alert("Could not detect grid in image.");
          setIsSplitting(false);
          return;
        }

        // Calculate layout for the new nodes
        const nodeWidth = 300;
        const nodeHeight = 280;
        const gap = 20;

        // Add split images to global history
        images.forEach((imageData: string, index: number) => {
          const row = Math.floor(index / grid.cols);
          const col = index % grid.cols;
          addToGlobalHistory({
            image: imageData,
            timestamp: Date.now() + index,
            prompt: `Split ${row + 1}-${col + 1} from ${grid.rows}x${grid.cols} grid`,
            aspectRatio: sourceNodeData?.aspectRatio || "1:1",
            model: sourceNodeData?.model || "nano-banana",
          });
        });

        // Create ImageInput nodes arranged in a grid matching the layout
        images.forEach((imageData: string, index: number) => {
          const row = Math.floor(index / grid.cols);
          const col = index % grid.cols;

          const nodeId = addNode("imageInput", {
            x: flowPosition.x + col * (nodeWidth + gap),
            y: flowPosition.y + row * (nodeHeight + gap),
          });

          // Get dimensions from the split image
          const img = new Image();
          img.onload = () => {
            updateNodeData(nodeId, {
              image: imageData,
              filename: `split-${row + 1}-${col + 1}.png`,
              dimensions: { width: img.width, height: img.height },
            });
          };
          img.src = imageData;
        });

      } catch (error) {
        console.error("[SplitGrid] Error:", error);
        alert("Failed to split image grid: " + (error instanceof Error ? error.message : "Unknown error"));
      } finally {
        setIsSplitting(false);
      }
    },
    [getNodeById, addNode, updateNodeData, addToGlobalHistory]
  );

  // Helper to get image from a node
  const getImageFromNode = useCallback((nodeId: string): string | null => {
    const node = getNodeById(nodeId);
    if (!node) return null;

    switch (node.type) {
      case "imageInput":
        return (node.data as { image: string | null }).image;
      case "annotation":
        return (node.data as { outputImage: string | null }).outputImage;
      case "nanoBanana":
        return (node.data as { outputImage: string | null }).outputImage;
      default:
        return null;
    }
  }, [getNodeById]);

  // Handle workflow generation from chat conversation
  const handleBuildWorkflow = useCallback(async (description: string) => {
    setIsBuildingWorkflow(true);
    try {
      const response = await fetch("/api/quickstart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description,
          contentLevel: "full",
        }),
      });

      const data = await response.json();

      if (data.success && data.workflow) {
        captureSnapshot(); // Capture BEFORE loading new workflow
        await loadWorkflow(data.workflow, undefined, { preserveSnapshot: true });
        setIsChatOpen(false);
        showToast("Workflow generated successfully", "success");
      } else {
        showToast(data.error || "Failed to generate workflow", "error");
      }
    } catch (error) {
      console.error("Error generating workflow:", error);
      showToast("Failed to generate workflow. Please try again.", "error");
    } finally {
      setIsBuildingWorkflow(false);
    }
  }, [loadWorkflow, showToast, captureSnapshot]);

  // Create lightweight workflow state for chat (strip base64 images)
  const chatWorkflowState = useMemo(() => {
    const strippedNodes = stripBinaryData(nodes);
    return {
      nodes: strippedNodes.map(n => ({
        id: n.id,
        type: n.type,
        position: n.position,
        data: n.data,
      })),
      edges: edges.map(e => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle || undefined,
        targetHandle: e.targetHandle || undefined,
      })),
    };
  }, [nodes, edges]);

  // Compute selected node IDs for chat context scoping
  const selectedNodeIds = useMemo(() => nodes.filter(n => n.selected).map(n => n.id), [nodes]);

  // Handle applying edit operations from chat
  const handleApplyEdits = useCallback((operations: EditOperation[]) => {
    captureSnapshot(); // Snapshot before AI edits
    const result = applyEditOperations(operations);
    if (result.applied > 0) {
      showToast(`Applied ${result.applied} edit(s)`, "success");
    }
    if (result.skipped.length > 0) {
      console.warn('Skipped operations:', result.skipped);
    }
    return result;
  }, [captureSnapshot, applyEditOperations, showToast]);

  // Handle node selection from drop menu
  const handleMenuSelect = useCallback(
    (selection: { type: NodeType | MenuAction; isAction: boolean }) => {
      if (!connectionDrop) return;

      const { flowPosition, sourceNodeId, sourceHandleId, connectionType, handleType } = connectionDrop;

      // Handle actions differently from node creation
      if (selection.isAction) {
        if (selection.type === "splitGridImmediate" && sourceNodeId) {
          handleSplitGridAction(sourceNodeId, flowPosition);
        }
        setConnectionDrop(null);
        return;
      }

      // Regular node creation
      const nodeType = selection.type as NodeType;

      // Create the new node at the drop position
      const newNodeId = addNode(nodeType, flowPosition);

      // If creating an annotation node from an image source, populate it with the source image
      if (nodeType === "annotation" && connectionType === "source" && handleType === "image" && sourceNodeId) {
        const sourceImage = getImageFromNode(sourceNodeId);
        if (sourceImage) {
          updateNodeData(newNodeId, { sourceImage, outputImage: sourceImage });
        }
      }

      // Determine the correct handle IDs for the new node based on its type
      let targetHandleId: string | null = null;
      let sourceHandleIdForNewNode: string | null = null;

      // Map handle type to the correct handle ID based on node type
      // Note: New nodes start with default handles (image, text) before a model is selected
      if (handleType === "image") {
        if (nodeType === "annotation" || nodeType === "output" || nodeType === "splitGrid" || nodeType === "outputGallery" || nodeType === "imageCompare") {
          targetHandleId = "image";
          // annotation also has an image output
          if (nodeType === "annotation") {
            sourceHandleIdForNewNode = "image";
          }
        } else if (nodeType === "nanoBanana" || nodeType === "generateVideo") {
          targetHandleId = "image";
        } else if (nodeType === "imageInput") {
          sourceHandleIdForNewNode = "image";
        }
      } else if (handleType === "text") {
        if (nodeType === "nanoBanana" || nodeType === "generateVideo" || nodeType === "generateAudio" || nodeType === "llmGenerate") {
          targetHandleId = "text";
          // llmGenerate also has a text output
          if (nodeType === "llmGenerate") {
            sourceHandleIdForNewNode = "text";
          }
        } else if (nodeType === "prompt" || nodeType === "promptConstructor" || nodeType === "array") {
          // prompt, promptConstructor, and array can receive and output text
          targetHandleId = "text";
          sourceHandleIdForNewNode = "text";
        }
      } else if (handleType === "video") {
        if (nodeType === "videoStitch") {
          // VideoStitch has dynamic video-N inputs and a video output
          targetHandleId = "video-0";
          sourceHandleIdForNewNode = "video";
        } else if (nodeType === "easeCurve") {
          // EaseCurve accepts video input and outputs video
          targetHandleId = "video";
          sourceHandleIdForNewNode = "video";
        } else if (nodeType === "videoTrim") {
          // VideoTrim accepts video input and outputs video
          targetHandleId = "video";
          sourceHandleIdForNewNode = "video";
        } else if (nodeType === "videoFrameGrab") {
          // VideoFrameGrab accepts video input and outputs image
          targetHandleId = "video";
          sourceHandleIdForNewNode = "image";
        } else if (nodeType === "generateVideo") {
          // GenerateVideo outputs video
          sourceHandleIdForNewNode = "video";
        } else if (nodeType === "output") {
          // Output accepts video on its image handle (it detects video content type)
          targetHandleId = "image";
        }
      } else if (handleType === "audio") {
        if (nodeType === "audioInput") {
          // Audio node: accepts audio input and outputs audio
          targetHandleId = "audio";
          sourceHandleIdForNewNode = "audio";
        } else if (nodeType === "generateAudio") {
          // GenerateAudio outputs audio (no audio input to wire to)
          sourceHandleIdForNewNode = "audio";
        } else if (nodeType === "videoStitch") {
          // VideoStitch accepts audio
          targetHandleId = "audio";
        } else if (nodeType === "output") {
          // Output accepts audio on its audio handle
          targetHandleId = "audio";
        }
      } else if (handleType === "3d") {
        if (nodeType === "glbViewer") {
          targetHandleId = "3d";
        } else if (nodeType === "nanoBanana") {
          sourceHandleIdForNewNode = "3d";
        }
      } else if (handleType === "easeCurve") {
        if (nodeType === "easeCurve") {
          targetHandleId = "easeCurve";
          sourceHandleIdForNewNode = "easeCurve";
        }
      }

      // Get all selected nodes to connect them all to the new node
      const selectedNodes = nodes.filter((node) => node.selected);
      const sourceNode = nodes.find((node) => node.id === sourceNodeId);

      // If the source node is selected and there are multiple selected nodes,
      // connect all selected nodes to the new node
      if (sourceNode?.selected && selectedNodes.length > 1 && sourceHandleId) {
        const batchUsed = new Set<string>();

        selectedNodes.forEach((node) => {
          if (connectionType === "source" && targetHandleId) {
            // For imageCompare, alternate between image and image-1
            let resolvedTargetHandle = targetHandleId;
            if (nodeType === "imageCompare" && targetHandleId === "image" && batchUsed.has("image")) {
              resolvedTargetHandle = "image-1";
            }
            // For videoStitch, find next available video-N handle
            if (nodeType === "videoStitch" && targetHandleId.startsWith("video-")) {
              for (let i = 0; i < 50; i++) {
                const candidateHandle = `video-${i}`;
                if (!batchUsed.has(candidateHandle)) {
                  resolvedTargetHandle = candidateHandle;
                  break;
                }
              }
            }
            batchUsed.add(resolvedTargetHandle);

            // Dragging from source (output), connect selected nodes to new node's input
            const connection: Connection = {
              source: node.id,
              sourceHandle: sourceHandleId,
              target: newNodeId,
              targetHandle: resolvedTargetHandle,
            };
            if (isValidConnection(connection)) {
              onConnect(connection);
            }
          } else if (connectionType === "target" && sourceHandleIdForNewNode) {
            // Dragging from target (input), connect from new node's output to selected nodes
            const connection: Connection = {
              source: newNodeId,
              sourceHandle: sourceHandleIdForNewNode,
              target: node.id,
              targetHandle: sourceHandleId,
            };
            if (isValidConnection(connection)) {
              onConnect(connection);
            }
          }
        });
      } else {
        // Single node connection (original behavior)
        if (connectionType === "source" && sourceNodeId && sourceHandleId && targetHandleId) {
          // Dragging from source (output), connect to new node's input
          const connection: Connection = {
            source: sourceNodeId,
            sourceHandle: sourceHandleId,
            target: newNodeId,
            targetHandle: targetHandleId,
          };
          onConnect(connection);
        } else if (connectionType === "target" && sourceNodeId && sourceHandleId && sourceHandleIdForNewNode) {
          // Dragging from target (input), connect from new node's output
          const connection: Connection = {
            source: newNodeId,
            sourceHandle: sourceHandleIdForNewNode,
            target: sourceNodeId,
            targetHandle: sourceHandleId,
          };
          onConnect(connection);
        }
      }

      setConnectionDrop(null);
    },
    [connectionDrop, addNode, onConnect, nodes, handleSplitGridAction, getImageFromNode, updateNodeData]
  );

  const handleCloseDropMenu = useCallback(() => {
    setConnectionDrop(null);
  }, []);

  const handleBeforeDelete = useCallback(() => {
    if (!isModalOpen) {
      pushHistorySnapshot();
    }
    return true;
  }, [isModalOpen, pushHistorySnapshot]);

  // Get copy/paste functions and clipboard from store
  const { copySelectedNodes, pasteNodes, duplicateSelectedNodes, clearClipboard, clipboard } = useWorkflowStore();

  // Add non-passive wheel listener to handle zoom/pan and prevent browser navigation
  // This replaces the onWheel prop which is passive by default and can't preventDefault
  useEffect(() => {
    const wrapper = reactFlowWrapper.current;
    if (!wrapper) return;

    const handleWheelNonPassive = (event: WheelEvent) => {
      // Skip if modal is open
      if (isModalOpen) return;

      // Check if scrolling over a scrollable element
      const target = event.target as HTMLElement;
      const scrollableElement = findScrollableAncestor(target, event.deltaX, event.deltaY);
      if (scrollableElement) return;

      const { zoomMode } = canvasNavigationSettings;

      // Check if zoom should be triggered based on settings
      const shouldZoom =
        zoomMode === "scroll" ||
        (zoomMode === "altScroll" && event.altKey) ||
        (zoomMode === "ctrlScroll" && (event.ctrlKey || event.metaKey));

      // Pinch gesture (ctrlKey + trackpad) always zooms regardless of settings
      if (event.ctrlKey && !event.altKey) {
        event.preventDefault();
        if (event.deltaY < 0) zoomIn();
        else zoomOut();
        return;
      }

      // On macOS, differentiate trackpad from mouse
      if (isMacOS) {
        if (isMouseWheel(event)) {
          // Mouse wheel → zoom if settings allow
          if (shouldZoom) {
            event.preventDefault();
            if (event.deltaY < 0) zoomIn();
            else zoomOut();
          }
        } else {
          // Trackpad scroll
          if (shouldZoom) {
            // Zoom
            event.preventDefault();
            if (event.deltaY < 0) zoomIn();
            else zoomOut();
          } else {
            // Pan (also prevent horizontal swipe navigation)
            event.preventDefault();
            const viewport = getViewport();
            setViewport({
              x: viewport.x - event.deltaX,
              y: viewport.y - event.deltaY,
              zoom: viewport.zoom,
            });
          }
        }
        return;
      }

      // Non-macOS
      if (shouldZoom) {
        event.preventDefault();
        if (event.deltaY < 0) zoomIn();
        else zoomOut();
      }
    };

    wrapper.addEventListener('wheel', handleWheelNonPassive, { passive: false });
    return () => {
      wrapper.removeEventListener('wheel', handleWheelNonPassive);
    };
  }, [isModalOpen, zoomIn, zoomOut, getViewport, setViewport, canvasNavigationSettings]);

  // Keyboard shortcuts for copy/paste and stacking selected nodes
  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    // Ignore if user is typing in an input field
    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement
    ) {
      return;
    }

    // Let modal-specific keyboard handlers (e.g. Annotation modal) own undo/redo.
    if (isModalOpen) {
      return;
    }

    // Handle keyboard shortcuts dialog (? key)
    if (event.key === "?" && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      setShortcutsDialogOpen(true);
      return;
    }

    // Handle workflow execution (Ctrl/Cmd + Enter)
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      executeWorkflow();
      return;
    }

    // Undo / Redo
    if ((event.ctrlKey || event.metaKey) && (event.key === "z" || event.key === "Z")) {
      event.preventDefault();
      if (event.repeat) return;
      const now = Date.now();
      if (now - lastUndoRedoAtRef.current < 120) return;
      lastUndoRedoAtRef.current = now;
      if (event.shiftKey) {
        if (canRedo) redo();
      } else {
        if (canUndo) undo();
      }
      return;
    }

    if ((event.ctrlKey || event.metaKey) && (event.key === "y" || event.key === "Y")) {
      event.preventDefault();
      if (event.repeat) return;
      const now = Date.now();
      if (now - lastUndoRedoAtRef.current < 120) return;
      lastUndoRedoAtRef.current = now;
      if (canRedo) redo();
      return;
    }

    // Handle copy (Ctrl/Cmd + C)
    if ((event.ctrlKey || event.metaKey) && event.key === "c") {
      event.preventDefault();
      copySelectedNodes();
      return;
    }

    // Handle duplicate (Ctrl/Cmd + D)
    if ((event.ctrlKey || event.metaKey) && (event.key === "d" || event.key === "D")) {
      event.preventDefault();
      duplicateSelectedNodes({ selectedGroupId });
      return;
    }

    // Delete selected group (group + contained nodes + connected edges)
    if (event.key === "Delete" || event.key === "Backspace") {
      const selectedNodes = nodes.filter((node) => node.selected);
      const selectedNodeIds = selectedNodes.map((node) => node.id);

      const selectedGroupIds = new Set<string>();
      if (selectedGroupId) selectedGroupIds.add(selectedGroupId);

      if (selectedNodes.length > 0) {
        const candidateGroupIds = Array.from(
          new Set(selectedNodes.map((node) => node.groupId).filter((groupId): groupId is string => !!groupId))
        );

        for (const groupId of candidateGroupIds) {
          const groupNodes = nodes.filter((node) => node.groupId === groupId);
          const selectedSet = new Set(selectedNodeIds);
          const isEntireGroupSelected =
            groupNodes.length > 0 && groupNodes.every((node) => selectedSet.has(node.id));
          if (isEntireGroupSelected) {
            selectedGroupIds.add(groupId);
          }
        }
      }

      if (selectedGroupIds.size > 0 || selectedNodeIds.length > 0) {
        event.preventDefault();
        deleteSelection(selectedNodeIds, Array.from(selectedGroupIds));
        return;
      }
    }

      // Helper to get viewport center position in flow coordinates
      const getViewportCenter = () => {
        const viewport = getViewport();
        const centerX = (-viewport.x + window.innerWidth / 2) / viewport.zoom;
        const centerY = (-viewport.y + window.innerHeight / 2) / viewport.zoom;
        return { centerX, centerY };
      };

      // Handle node creation hotkeys (Shift + key)
      if (event.shiftKey && !event.ctrlKey && !event.metaKey) {
        const key = event.key.toLowerCase();
        let nodeType: NodeType | null = null;

        switch (key) {
          case "p":
            nodeType = "prompt";
            break;
          case "r":
            nodeType = "array";
            break;
          case "i":
            nodeType = "imageInput";
            break;
          case "g":
            nodeType = "nanoBanana";
            break;
          case "v":
            nodeType = "generateVideo";
            break;
          case "l":
            nodeType = "llmGenerate";
            break;
          case "a":
            nodeType = "annotation";
            break;
          case "t":
            nodeType = "generateAudio";
            break;
        }

        if (nodeType) {
          event.preventDefault();
          const { centerX, centerY } = getViewportCenter();
          // Offset by half the default node dimensions to center it
          const defaultDimensions: Record<NodeType, { width: number; height: number }> = {
            imageInput: { width: 300, height: 280 },
            audioInput: { width: 300, height: 200 },
            annotation: { width: 300, height: 280 },
            prompt: { width: 320, height: 220 },
            array: { width: 360, height: 360 },
            promptConstructor: { width: 340, height: 280 },
            nanoBanana: { width: 300, height: 300 },
            generateVideo: { width: 300, height: 300 },
            generate3d: { width: 300, height: 300 },
            generateAudio: { width: 300, height: 280 },
            llmGenerate: { width: 320, height: 360 },
            splitGrid: { width: 300, height: 320 },
            output: { width: 320, height: 320 },
            outputGallery: { width: 320, height: 360 },
            imageCompare: { width: 400, height: 360 },
            videoStitch: { width: 400, height: 280 },
            easeCurve: { width: 340, height: 480 },
            videoTrim: { width: 360, height: 360 },
            videoFrameGrab: { width: 320, height: 320 },
            glbViewer: { width: 360, height: 380 },
          };
          const dims = defaultDimensions[nodeType];
          addNode(nodeType, { x: centerX - dims.width / 2, y: centerY - dims.height / 2 });
          return;
        }
      }

      // Handle paste (Ctrl/Cmd + V)
      if ((event.ctrlKey || event.metaKey) && event.key === "v") {
        event.preventDefault();

        // If we have nodes in the internal clipboard, prioritize pasting those
        if (clipboard && clipboard.nodes.length > 0) {
          pasteNodes();
          clearClipboard(); // Clear so next paste uses system clipboard
          return;
        }

        // Check system clipboard for images first, then text
        navigator.clipboard.read().then(async (items) => {
          for (const item of items) {
            // Check for image
            const imageType = item.types.find(type => type.startsWith('image/'));
            if (imageType) {
              const blob = await item.getType(imageType);
              const reader = new FileReader();
              reader.onload = (e) => {
                const dataUrl = e.target?.result as string;

                const img = new Image();
                img.onload = () => {
                  // Check if an imageInput node is selected - if so, update it instead of creating new
                  const selectedImageInputNode = nodes.find(
                    (node) => node.selected && node.type === "imageInput"
                  );

                  if (selectedImageInputNode) {
                    // Update the selected imageInput node with the pasted image
                    updateNodeData(selectedImageInputNode.id, {
                      image: dataUrl,
                      imageRef: undefined,
                      filename: `pasted-${Date.now()}.png`,
                      dimensions: { width: img.width, height: img.height },
                    });
                  } else {
                    // No imageInput node selected - create a new one at viewport center
                    const viewport = getViewport();
                    const centerX = (-viewport.x + window.innerWidth / 2) / viewport.zoom;
                    const centerY = (-viewport.y + window.innerHeight / 2) / viewport.zoom;

                    // ImageInput node default dimensions: 300x280
                    const nodeId = addNode("imageInput", { x: centerX - 150, y: centerY - 140 });
                    updateNodeData(nodeId, {
                      image: dataUrl,
                      filename: `pasted-${Date.now()}.png`,
                      dimensions: { width: img.width, height: img.height },
                    });
                  }
                };
                img.src = dataUrl;
              };
              reader.readAsDataURL(blob);
              return; // Exit after handling image
            }

            // Check for text
            if (item.types.includes('text/plain')) {
              const blob = await item.getType('text/plain');
              const text = await blob.text();
              if (text.trim()) {
                const viewport = getViewport();
                const centerX = (-viewport.x + window.innerWidth / 2) / viewport.zoom;
                const centerY = (-viewport.y + window.innerHeight / 2) / viewport.zoom;
                // Prompt node default dimensions: 320x220
                const nodeId = addNode("prompt", { x: centerX - 160, y: centerY - 110 });
                updateNodeData(nodeId, { prompt: text });
                return; // Exit after handling text
              }
            }
          }
        }).catch(() => {
          // Clipboard API failed - nothing to paste
        });
        return;
      }

      const selectedNodes = nodes.filter((node) => node.selected);
      if (selectedNodes.length < 2) return;

      const STACK_GAP = 20;

      if (event.key === "v" || event.key === "V") {
        // Stack vertically - sort by current y position to maintain relative order
        const sortedNodes = [...selectedNodes].sort((a, b) => a.position.y - b.position.y);

        // Use the leftmost x position as the alignment point
        const alignX = Math.min(...sortedNodes.map((n) => n.position.x));

        let currentY = sortedNodes[0].position.y;

        sortedNodes.forEach((node) => {
          const nodeHeight = (node.style?.height as number) || (node.measured?.height) || 200;

          onNodesChange([
            {
              type: "position",
              id: node.id,
              position: { x: alignX, y: currentY },
            },
          ]);

          currentY += nodeHeight + STACK_GAP;
        });
      } else if (event.key === "h" || event.key === "H") {
        // Stack horizontally - sort by current x position to maintain relative order
        const sortedNodes = [...selectedNodes].sort((a, b) => a.position.x - b.position.x);

        // Use the topmost y position as the alignment point
        const alignY = Math.min(...sortedNodes.map((n) => n.position.y));

        let currentX = sortedNodes[0].position.x;

        sortedNodes.forEach((node) => {
          const nodeWidth = (node.style?.width as number) || (node.measured?.width) || 220;

          onNodesChange([
            {
              type: "position",
              id: node.id,
              position: { x: currentX, y: alignY },
            },
          ]);

          currentX += nodeWidth + STACK_GAP;
        });
      } else if (event.key === "g" || event.key === "G") {
        // Arrange as grid
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
          ...sortedNodes.map((n) => (n.style?.width as number) || (n.measured?.width) || 220)
        );
        const maxHeight = Math.max(
          ...sortedNodes.map((n) => (n.style?.height as number) || (n.measured?.height) || 200)
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
      }
  }, [isModalOpen, selectedGroupId, deleteSelection, nodes, onNodesChange, copySelectedNodes, pasteNodes, duplicateSelectedNodes, clearClipboard, clipboard, getViewport, addNode, updateNodeData, executeWorkflow, setShortcutsDialogOpen, undo, redo, canUndo, canRedo]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);


  // Fix for React Flow selection bug where nodes with undefined bounds get incorrectly selected.
  // Uses statistical outlier detection to identify and deselect nodes that are clearly
  // outside the actual selection area.
  const handleSelectionChange = useCallback(({ nodes: selectedNodes }: OnSelectionChangeParams) => {
    if (selectedNodes.length <= 1) return;

    // Get positions of all selected nodes
    const positions = selectedNodes.map(n => ({
      id: n.id,
      x: n.position.x,
      y: n.position.y,
    }));

    // Calculate IQR-based bounds for outlier detection
    const sortedX = [...positions].sort((a, b) => a.x - b.x);
    const sortedY = [...positions].sort((a, b) => a.y - b.y);

    const q1X = sortedX[Math.floor(sortedX.length * 0.25)].x;
    const q3X = sortedX[Math.floor(sortedX.length * 0.75)].x;
    const q1Y = sortedY[Math.floor(sortedY.length * 0.25)].y;
    const q3Y = sortedY[Math.floor(sortedY.length * 0.75)].y;
    const iqrX = q3X - q1X;
    const iqrY = q3Y - q1Y;

    // Outlier threshold: 3x IQR from quartiles
    const minX = q1X - iqrX * 3;
    const maxX = q3X + iqrX * 3;
    const minY = q1Y - iqrY * 3;
    const maxY = q3Y + iqrY * 3;

    // Find and deselect outliers
    const outliers = positions.filter(p =>
      p.x < minX || p.x > maxX || p.y < minY || p.y > maxY
    );

    if (outliers.length > 0) {
      onNodesChange(
        outliers.map(o => ({
          type: 'select' as const,
          id: o.id,
          selected: false,
        }))
      );
    }
  }, [onNodesChange]);

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";

    // Check if dragging a node type from the action bar
    const hasNodeType = Array.from(event.dataTransfer.types).includes("application/node-type");
    if (hasNodeType) {
      setIsDragOver(true);
      setDropType("node");
      return;
    }

    // Check if dragging a history image
    const hasHistoryImage = Array.from(event.dataTransfer.types).includes("application/history-image");
    if (hasHistoryImage) {
      setIsDragOver(true);
      setDropType("image");
      return;
    }

    // Check if dragging files that are images or JSON
    const items = Array.from(event.dataTransfer.items);
    const hasImageFile = items.some(
      (item) => item.kind === "file" && item.type.startsWith("image/")
    );
    const hasJsonFile = items.some(
      (item) => item.kind === "file" && item.type === "application/json"
    );

    const hasAudioFile = items.some(
      (item) => item.kind === "file" && item.type.startsWith("audio/")
    );

    if (hasJsonFile) {
      setIsDragOver(true);
      setDropType("workflow");
    } else if (hasAudioFile) {
      setIsDragOver(true);
      setDropType("audio");
    } else if (hasImageFile) {
      setIsDragOver(true);
      setDropType("image");
    }
  }, []);

  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragOver(false);
    setDropType(null);
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDragOver(false);
      setDropType(null);

      // Check for node type drop from action bar
      const nodeType = event.dataTransfer.getData("application/node-type") as NodeType;
      if (nodeType) {
        const position = screenToFlowPosition({
          x: event.clientX,
          y: event.clientY,
        });
        addNode(nodeType, position);
        return;
      }

      // Check for history image drop
      const historyImageData = event.dataTransfer.getData("application/history-image");
      if (historyImageData) {
        try {
          const { image, prompt } = JSON.parse(historyImageData);
          const position = screenToFlowPosition({
            x: event.clientX,
            y: event.clientY,
          });

          // Create ImageInput node with the history image
          const nodeId = addNode("imageInput", position);

          // Get image dimensions and update node
          const img = new Image();
          img.onload = () => {
            updateNodeData(nodeId, {
              image: image,
              filename: `history-${Date.now()}.png`,
              dimensions: { width: img.width, height: img.height },
            });
          };
          img.src = image;
          return;
        } catch (err) {
          console.error("Failed to parse history image data:", err);
        }
      }

      const allFiles = Array.from(event.dataTransfer.files);

      // Check for JSON workflow files first
      const jsonFiles = allFiles.filter((file) => file.type === "application/json" || file.name.endsWith(".json"));
      if (jsonFiles.length > 0) {
        const file = jsonFiles[0];
        const reader = new FileReader();
        reader.onload = async (e) => {
          try {
            const workflow = JSON.parse(e.target?.result as string) as WorkflowFile;
            if (workflow.version && workflow.nodes && workflow.edges) {
              await loadWorkflow(workflow);
            } else {
              alert("Invalid workflow file format");
            }
          } catch {
            alert("Failed to parse workflow file");
          }
        };
        reader.readAsText(file);
        return;
      }

      // Handle audio files
      const audioFiles = allFiles.filter((file) => file.type.startsWith("audio/"));
      if (audioFiles.length > 0) {
        const position = screenToFlowPosition({
          x: event.clientX,
          y: event.clientY,
        });
        audioFiles.forEach((file, index) => {
          const reader = new FileReader();
          reader.onload = (e) => {
            const dataUrl = e.target?.result as string;
            const nodeId = addNode("audioInput", {
              x: position.x + index * 240,
              y: position.y,
            });
            updateNodeData(nodeId, {
              audioFile: dataUrl,
              filename: file.name,
              format: file.type,
            });
          };
          reader.readAsDataURL(file);
        });
        return;
      }

      // Handle image files
      const imageFiles = allFiles.filter((file) => file.type.startsWith("image/"));
      if (imageFiles.length === 0) return;

      // Get the drop position in flow coordinates
      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      // Create a node for each dropped image
      imageFiles.forEach((file, index) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          const dataUrl = e.target?.result as string;

          // Create image to get dimensions
          const img = new Image();
          img.onload = () => {
            // Add the node at the drop position (offset for multiple files)
            const nodeId = addNode("imageInput", {
              x: position.x + index * 240,
              y: position.y,
            });

            // Update the node with the image data
            updateNodeData(nodeId, {
              image: dataUrl,
              filename: file.name,
              dimensions: { width: img.width, height: img.height },
            });
          };
          img.src = dataUrl;
        };
        reader.readAsDataURL(file);
      });
    },
    [screenToFlowPosition, addNode, updateNodeData, loadWorkflow]
  );

  return (
    <div
      ref={reactFlowWrapper}
      className={`flex-1 bg-canvas-bg relative ${isDragOver ? "ring-2 ring-inset ring-blue-500" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drop overlay indicator */}
      {isDragOver && (
        <div className="absolute inset-0 bg-blue-500/10 z-50 pointer-events-none flex items-center justify-center">
          <div className="bg-neutral-800 border border-neutral-600 rounded-lg px-6 py-4 shadow-xl">
            <p className="text-neutral-200 text-sm font-medium">
              {dropType === "workflow"
                ? "Drop to load workflow"
                : dropType === "node"
                ? "Drop to create node"
                : dropType === "audio"
                ? "Drop audio to create node"
                : "Drop image to create node"}
            </p>
          </div>
        </div>
      )}

      {/* Splitting indicator */}
      {isSplitting && (
        <div className="absolute inset-0 bg-black/50 z-50 flex items-center justify-center">
          <div className="bg-neutral-800 border border-neutral-600 rounded-lg px-6 py-4 shadow-xl flex items-center gap-3">
            <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-neutral-200 text-sm font-medium">Splitting image grid...</p>
          </div>
        </div>
      )}

      {/* Welcome Modal */}
      {isCanvasEmpty && showQuickstart && (
        <WelcomeModal
          onWorkflowGenerated={async (workflow) => {
            await loadWorkflow(workflow);
            setShowQuickstart(false);
          }}
          onClose={() => setShowQuickstart(false)}
          onNewProject={() => {
            setShowQuickstart(false);
            setShowNewProjectSetup(true);
          }}
        />
      )}

      {/* New Project Setup Modal */}
      {showNewProjectSetup && (
        <ProjectSetupModal
          isOpen={showNewProjectSetup}
          mode="new"
          onSave={(id, name, directoryPath) => {
            setWorkflowMetadata(id, name, directoryPath);
            setShowNewProjectSetup(false);
          }}
          onClose={() => {
            setShowNewProjectSetup(false);
            setShowQuickstart(true);
          }}
        />
      )}

      <ReactFlow
        nodes={allNodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={handleConnect}
        onConnectEnd={handleConnectEnd}
        onNodeDragStop={handleNodeDragStop}
        onPaneClick={() => setSelectedGroupId(null)}
        onNodeClick={() => setSelectedGroupId(null)}
        onSelectionChange={handleSelectionChange}
        onBeforeDelete={handleBeforeDelete}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        isValidConnection={isValidConnection}
        fitView
        deleteKeyCode={null}
        multiSelectionKeyCode="Shift"
        selectionOnDrag={
          canvasNavigationSettings.selectionMode === "altDrag" || canvasNavigationSettings.selectionMode === "shiftDrag"
            ? false
            : canvasNavigationSettings.panMode === "always"
            ? false
            : isMacOS && !isModalOpen
        }
        selectionKeyCode={
          isModalOpen ? null
            : canvasNavigationSettings.selectionMode === "altDrag" ? "Alt"
            : canvasNavigationSettings.selectionMode === "shiftDrag" ? "Shift"
            : "Shift"
        }
        panOnDrag={
          isModalOpen
            ? false
            : canvasNavigationSettings.panMode === "always"
            ? true
            : canvasNavigationSettings.panMode === "middleMouse"
            ? [2]
            : !isMacOS
        }
        selectNodesOnDrag={false}
        nodeDragThreshold={5}
        zoomOnScroll={false}
        zoomOnPinch={!isModalOpen}
        minZoom={0.1}
        maxZoom={4}
        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
        panActivationKeyCode={
          isModalOpen
            ? null
            : canvasNavigationSettings.panMode === "space"
            ? "Space"
            : null
        }
        nodesDraggable={!isModalOpen}
        nodesConnectable={!isModalOpen}
        elementsSelectable={!isModalOpen}
        className="bg-neutral-900"
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{
          type: "editable",
          animated: false,
        }}
      >
        <GroupBackgroundsPortal />
        <GroupControlsOverlay />
        <Background color="#404040" gap={20} size={1} />
        <Controls className="bg-neutral-800 border border-neutral-700 rounded-lg shadow-lg [&>button]:bg-neutral-800 [&>button]:border-neutral-700 [&>button]:fill-neutral-300 [&>button:hover]:bg-neutral-700 [&>button:hover]:fill-neutral-100" />
        <MiniMap
          className="bg-neutral-800 border border-neutral-700 rounded-lg shadow-lg"
          maskColor="rgba(0, 0, 0, 0.6)"
          nodeColor={(node) => {
            switch (node.type) {
              case "imageInput":
                return "#3b82f6";
              case "audioInput":
                return "#a78bfa";
              case "annotation":
                return "#8b5cf6";
              case "prompt":
                return "#f97316";
              case "array":
                return "#a3e635";
              case "promptConstructor":
                return "#f472b6";
              case "nanoBanana":
                return "#22c55e";
              case "generateVideo":
                return "#9333ea";
              case "generate3d":
                return "#fb923c";
              case "generateAudio":
                return "#d946ef"; // fuchsia-500 (audio/TTS)
              case "llmGenerate":
                return "#06b6d4";
              case "splitGrid":
                return "#f59e0b";
              case "output":
                return "#ef4444";
              case "outputGallery":
                return "#ec4899";
              case "imageCompare":
                return "#14b8a6";
              case "videoStitch":
                return "#f97316";
              case "easeCurve":
                return "#bef264"; // lime-300 (easy-peasy-ease)
              case "videoTrim":
                return "#60a5fa"; // blue-400 (trim/cut)
              case "videoFrameGrab":
                return "#38bdf8"; // sky-400 (image from video)
              case "glbViewer":
                return "#0ea5e9"; // sky-500 (3D viewport)
              default:
                return "#94a3b8";
            }
          }}
        />
      </ReactFlow>

      {/* Connection drop menu */}
      {connectionDrop && connectionDrop.handleType && (
        <ConnectionDropMenu
          position={connectionDrop.position}
          handleType={connectionDrop.handleType}
          connectionType={connectionDrop.connectionType}
          onSelect={handleMenuSelect}
          onClose={handleCloseDropMenu}
        />
      )}

      {/* Multi-select toolbar */}
      <MultiSelectToolbar />

      {/* Edge toolbar */}
      <EdgeToolbar />

      {/* Global image history */}
      <GlobalImageHistory />

      {/* Chat toggle button - hidden for now */}

      {/* Chat panel */}
      <ChatPanel
        isOpen={isChatOpen}
        onClose={() => setIsChatOpen(false)}
        onBuildWorkflow={handleBuildWorkflow}
        isBuildingWorkflow={isBuildingWorkflow}
        onApplyEdits={handleApplyEdits}
        workflowState={chatWorkflowState}
        selectedNodeIds={selectedNodeIds}
      />
    </div>
  );
}
