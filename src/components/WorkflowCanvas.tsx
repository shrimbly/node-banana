"use client";

import { useCallback, useRef, useState, useEffect, DragEvent, useMemo, type ComponentType } from "react";
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
  ViewportPortal,
  useStore,
  useUpdateNodeInternals,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { useWorkflowStore, WorkflowFile } from "@/store/workflowStore";
import { useShallow } from "zustand/shallow";
import { useToast } from "@/components/Toast";
import dynamic from "next/dynamic";
import {
  ImageInputNode,
  AudioInputNode,
  VideoInputNode,
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
  RemoveBackgroundNode,
  ImageResizeNode,
  GifEncoderNode,
  RouterNode,
  SwitchNode,
  ConditionalSwitchNode,
  ComfyAppNode,
} from "./nodes";

// Lazy-load GLBViewerNode to avoid bundling three.js for users who don't use 3D nodes
const GLBViewerNode = dynamic(() => import("./nodes/GLBViewerNode").then(mod => ({ default: mod.GLBViewerNode })), { ssr: false });
import { EditableEdge, ReferenceEdge, SharedEdgeGradients } from "./edges";
import { ConnectionDropMenu, MenuAction } from "./ConnectionDropMenu";
import { HandleMenu, type HandleMenuTarget } from "./HandleMenu";
import { NodeSearchMenu } from "./NodeSearchMenu";
import { MultiSelectToolbar } from "./MultiSelectToolbar";
import { GlobalImageHistory } from "./GlobalImageHistory";
import { GroupBackgroundsPortal, GroupControlsOverlay } from "./GroupsOverlay";
import { NodeType, NanoBananaNodeData, HandleType, PromptNodeData, LLMGenerateNodeData, PromptConstructorNodeData, AvailableVariable, WorkflowNodeData } from "@/types";
import { isComfyWorkflow, isNodeBananaWorkflow } from "@/lib/comfy/detect";
import { getSavedComfyNode, seedFromSavedComfyNode } from "@/lib/comfy/library";
import { appInputHandles } from "@/lib/comfy/nodeSchema";
import { ComfyWordmark } from "./icons/ComfyWordmark";
import { defaultNodeDimensions } from "@/store/utils/nodeDefaults";
import { FloatingNodeHeader } from "./nodes/FloatingNodeHeader";
import { ControlPanel } from "./nodes/ControlPanel";
import { detectAndSplitGrid } from "@/utils/gridSplitter";
import { logger } from "@/utils/logger";
import { WelcomeModal } from "./quickstart";
import { ProjectSetupModal } from "./ProjectSetupModal";
import { ChatPanel } from "./ChatPanel";
import { EditOperation } from "@/lib/chat/editOperations";
import { stripBinaryData } from "@/lib/chat/contextBuilder";
import { PromptEditorModal } from "./modals/PromptEditorModal";
import { PromptConstructorEditorModal } from "./modals/PromptConstructorEditorModal";
import { resolveTextSourcesThroughRouters } from "@/store/utils/connectedInputs";
import { wouldCreateCycle } from "@/store/utils/executionUtils";
import { parseVarTags } from "@/utils/parseVarTags";
import { ErrorBoundary } from "./ErrorBoundary";
import { ModelSearchDialog } from "./modals/ModelSearchDialog";
import { LLMFallbackPopover } from "./nodes/LLMFallbackPopover";
import { browseRegistry } from "@/utils/browseRegistry";
import { useInlineParameters } from "@/hooks/useInlineParameters";
import { useWheelPanZoom } from "@/hooks/useWheelPanZoom";
import { selectCanvasOverview, setCanvasPanningClass } from "@/utils/canvasPerformance";
import { SplitGridTemplateModal } from "./splitgrid/SplitGridTemplateModal";
import { createPortal } from "react-dom";
import { useAnnotationStore } from "@/store/annotationStore";
import { TutorialOverlay } from "./onboarding/TutorialOverlay";
import { useFTUXStore } from "@/store/ftuxStore";

const rawNodeTypes: NodeTypes = {
  imageInput: ImageInputNode,
  audioInput: AudioInputNode,
  videoInput: VideoInputNode,
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
  removeBackground: RemoveBackgroundNode,
  imageResize: ImageResizeNode,
  gifEncoder: GifEncoderNode,
  router: RouterNode,
  switch: SwitchNode,
  conditionalSwitch: ConditionalSwitchNode,
  glbViewer: GLBViewerNode,
  comfyApp: ComfyAppNode,
};

// Wrap every node component in a per-node error boundary so a single
// throwing node (e.g. malformed data from a loaded workflow) renders a small
// fallback card instead of unmounting the entire canvas/app.
const withNodeErrorBoundary = (
  type: string,
  NodeComponent: ComponentType<Record<string, unknown>>
): ComponentType<Record<string, unknown>> => {
  const Wrapped = (props: Record<string, unknown>) => (
    <ErrorBoundary label={type}>
      <NodeComponent {...props} />
    </ErrorBoundary>
  );
  Wrapped.displayName = `NodeErrorBoundary(${type})`;
  return Wrapped;
};

const nodeTypes: NodeTypes = Object.fromEntries(
  Object.entries(rawNodeTypes).map(([type, NodeComponent]) => [
    type,
    withNodeErrorBoundary(
      type,
      NodeComponent as ComponentType<Record<string, unknown>>
    ),
  ])
) as NodeTypes;

const edgeTypes: EdgeTypes = {
  editable: EditableEdge,
  reference: ReferenceEdge,
};

const OVERVIEW_EDGES: Edge[] = [];
/** Pointer travel (px) under which a handle press counts as a click, not a drag. */
const HANDLE_CLICK_SLOP = 4;
const MINIMAP_GEOMETRY = {
  width: 200,
  height: 150,
  margin: 15,
  controlInset: 8,
  controlSize: 28,
} as const;

const MINIMAP_CLOSE_POSITION = {
  right: MINIMAP_GEOMETRY.margin + MINIMAP_GEOMETRY.controlInset,
  bottom:
    MINIMAP_GEOMETRY.margin +
    MINIMAP_GEOMETRY.height -
    MINIMAP_GEOMETRY.controlInset -
    MINIMAP_GEOMETRY.controlSize,
} as const;

function getMiniMapNodeColor(node: Node): string {
  switch (node.type) {
    case "imageInput": return "#3b82f6";
    case "audioInput": return "#a78bfa";
    case "videoInput": return "#c084fc";
    case "annotation": return "#8b5cf6";
    case "prompt": return "#f97316";
    case "array": return "#a3e635";
    case "promptConstructor": return "#f472b6";
    case "nanoBanana": return "#22c55e";
    case "generateVideo": return "#9333ea";
    case "generate3d": return "#fb923c";
    case "generateAudio": return "#d946ef";
    case "llmGenerate": return "#06b6d4";
    case "splitGrid": return "#f59e0b";
    case "output": return "#ef4444";
    case "outputGallery": return "#ec4899";
    case "imageCompare": return "#14b8a6";
    case "videoStitch": return "#f97316";
    case "easeCurve": return "#bef264";
    case "videoTrim": return "#60a5fa";
    case "videoFrameGrab": return "#38bdf8";
    case "removeBackground": return "#2dd4bf";
    case "imageResize": return "#0d9488";
    case "gifEncoder": return "#f472b6";
    case "router": return "#6b7280";
    case "switch": return "#8b5cf6";
    case "conditionalSwitch": return "#06b6d4";
    case "glbViewer": return "#0ea5e9";
    case "comfyApp": return "#7dd3fc";
    default: return "#94a3b8";
  }
}

// Connection validation rules
// - Image handles (green) can only connect to image handles
// - Text handles (blue) can only connect to text handles
// - Video handles can only connect to generateVideo or output nodes
// Helper to determine handle type from handle ID
// For dynamic handles, we use naming convention: image inputs contain "image", text inputs are "prompt" or "negative_prompt"
const getHandleType = (handleId: string | null | undefined): "image" | "text" | "video" | "audio" | "3d" | "easeCurve" | null => {
  if (!handleId) return null;
  // Generic Router handles — return null to allow any type connection
  if (handleId === "generic-input" || handleId === "generic-output") return null;
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

/**
 * The type of a Comfy app node's *output* handle.
 *
 * Their ids are the ComfyUI graph node ids the outputs came from, so unlike
 * every other node's handles they carry no type in the name. The attached
 * app contract is the only place that mapping exists.
 */
const getComfyOutputHandleType = (
  node: Node | undefined,
  handleId: string | null | undefined,
): "image" | "text" | "video" | "audio" | "3d" | null => {
  if (node?.type !== "comfyApp" || !handleId) return null;
  const app = (node.data as { app?: { outputs?: Array<{ id: string; type: string }> } }).app;
  const output = app?.outputs?.find((o) => o.id === handleId);
  if (!output) return null;
  return output.type as "image" | "text" | "video" | "audio" | "3d";
};

/** Whether a Comfy app node actually renders the given target handle. */
const comfyDeclaresInput = (node: Node, handleId: string | null | undefined): boolean => {
  if (!handleId) return false;
  const schema = (node.data as { inputSchema?: Array<{ type: string }> }).inputSchema ?? [];
  // Handles are `${type}-${indexWithinType}`, assigned in schema order.
  const counters: Record<string, number> = {};
  return schema.some((input) => {
    const index = counters[input.type] ?? 0;
    counters[input.type] = index + 1;
    return `${input.type}-${index}` === handleId;
  });
};

// Define which handles each node type has
const getNodeHandles = (nodeType: string): { inputs: string[]; outputs: string[] } => {
  switch (nodeType) {
    case "imageInput":
      return { inputs: ["reference"], outputs: ["image"] };
    case "audioInput":
      return { inputs: ["audio"], outputs: ["audio"] };
    case "videoInput":
      return { inputs: ["video"], outputs: ["video"] };
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
      return { inputs: ["image", "video", "text", "audio"], outputs: ["video"] };
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
      return { inputs: ["image", "video"], outputs: [] };
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
    case "removeBackground":
    case "imageResize":
      return { inputs: ["image"], outputs: ["image"] };
    case "gifEncoder":
      return { inputs: ["image"], outputs: ["image"] };
    case "router":
      return { inputs: ["image", "text", "video", "audio", "3d", "easeCurve", "generic-input"], outputs: ["image", "text", "video", "audio", "3d", "easeCurve", "generic-output"] };
    case "switch":
      // Switch has one input handle (generic-input when disconnected, typed when connected)
      // Output handles are dynamic based on switches array, all matching inputType
      return { inputs: ["generic-input"], outputs: [] }; // Outputs handled dynamically in SwitchNode
    case "conditionalSwitch":
      // Conditional Switch has one text input and dynamic rule outputs + default
      return { inputs: ["text"], outputs: [] }; // Outputs handled dynamically in ConditionalSwitchNode
    case "glbViewer":
      return { inputs: ["3d"], outputs: ["image"] };
    case "comfyApp":
      // Handles come from the attached ComfyUI workflow's contract, so the
      // static list is the superset every app could expose. The real per-node
      // set is read from `inputSchema` / `app.outputs` at connection time.
      return { inputs: ["image", "text", "video", "audio"], outputs: ["image", "text", "video", "audio", "3d"] };
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

/** Shared ref so child components (BaseNode) can check panning state without re-rendering */
export const isPanningRef = { current: false };
/** Shared ref so child components (BaseNode) can skip hover updates during node drags */
export const isDraggingNodeRef = { current: false };

export function WorkflowCanvas() {
  const { nodes, edges, groups, isModalOpen, showQuickstart, navigationTarget, canvasNavigationSettings, dimmedNodeIds, skippedNodeIds } =
    useWorkflowStore(useShallow((state) => ({
      nodes: state.nodes,
      edges: state.edges,
      groups: state.groups,
      isModalOpen: state.isModalOpen,
      showQuickstart: state.showQuickstart,
      navigationTarget: state.navigationTarget,
      canvasNavigationSettings: state.canvasNavigationSettings,
      dimmedNodeIds: state.dimmedNodeIds,
      skippedNodeIds: state.skippedNodeIds,
    })));
  const onNodesChange = useWorkflowStore((state) => state.onNodesChange);
  const onEdgesChange = useWorkflowStore((state) => state.onEdgesChange);
  const reconnectEdge = useWorkflowStore((state) => state.reconnectEdge);
  const onConnect = useWorkflowStore((state) => state.onConnect);
  const addNode = useWorkflowStore((state) => state.addNode);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const loadWorkflow = useWorkflowStore((state) => state.loadWorkflow);
  const getNodeById = useWorkflowStore((state) => state.getNodeById);
  const addToGlobalHistory = useWorkflowStore((state) => state.addToGlobalHistory);
  const setNodeGroupId = useWorkflowStore((state) => state.setNodeGroupId);
  const executeWorkflow = useWorkflowStore((state) => state.executeWorkflow);
  const setShowQuickstart = useWorkflowStore((state) => state.setShowQuickstart);
  const setNavigationTarget = useWorkflowStore((state) => state.setNavigationTarget);
  const captureSnapshot = useWorkflowStore((state) => state.captureSnapshot);
  const applyEditOperations = useWorkflowStore((state) => state.applyEditOperations);
  const setWorkflowMetadata = useWorkflowStore((state) => state.setWorkflowMetadata);
  const setShortcutsDialogOpen = useWorkflowStore((state) => state.setShortcutsDialogOpen);
  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const clearWorkflow = useWorkflowStore((state) => state.clearWorkflow);
  const setHoveredNodeId = useWorkflowStore((state) => state.setHoveredNodeId);
  const openAnnotationModal = useAnnotationStore((state) => state.openModal);
  const { screenToFlowPosition, getViewport, setCenter } = useReactFlow();
  const isCanvasOverview = useStore(selectCanvasOverview);
  const { show: showToast } = useToast();
  const [isDragOver, setIsDragOver] = useState(false);
  const [dropType, setDropType] = useState<"image" | "audio" | "workflow" | "node" | null>(null);
  const [connectionDrop, setConnectionDrop] = useState<ConnectionDropState | null>(null);
  // Searchable "add node" menu shown on double-clicking the empty canvas.
  const [nodeSearchMenu, setNodeSearchMenu] = useState<
    { position: { x: number; y: number }; flowPosition: { x: number; y: number } } | null
  >(null);
  const [isSplitting, setIsSplitting] = useState(false);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [isMinimapVisible, setIsMinimapVisible] = useState(true);
  const [isBuildingWorkflow, setIsBuildingWorkflow] = useState(false);
  const [showNewProjectSetup, setShowNewProjectSetup] = useState(false);
  const [expandingNode, setExpandingNode] = useState<{ id: string; type: string } | null>(null);

  // Fallback model picker state
  const [fallbackDialogState, setFallbackDialogState] = useState<
    | { nodeId: string; capability: "image" | "video" | "3d" | "audio" }
    | null
  >(null);
  const [llmFallbackState, setLlmFallbackState] = useState<{ nodeId: string } | null>(null);
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const handlePointerDownRef = useRef<{ x: number; y: number } | null>(null);
  const tutorialViewportSet = useRef(false);

  // FTUX tutorial state (client-side only to avoid SSR hydration issues)
  const [tutorialActive, setTutorialActive] = useState(false);
  const [lockedFeatures, setLockedFeatures] = useState(false);

  useEffect(() => {
    // Subscribe to FTUX store on client-side only
    const unsubscribe = useFTUXStore.subscribe((state) => {
      setTutorialActive(state.tutorialActive);
      setLockedFeatures(state.lockedFeatures);
    });

    // Initialize with current state
    const currentState = useFTUXStore.getState();
    setTutorialActive(currentState.tutorialActive);
    setLockedFeatures(currentState.lockedFeatures);

    return unsubscribe;
  }, []);

  useEffect(() => {
    const wrapper = reactFlowWrapper.current;
    return () => {
      document.documentElement.classList.remove("canvas-interacting");
      if (wrapper) setCanvasPanningClass(false, wrapper);
      isPanningRef.current = false;
      isDraggingNodeRef.current = false;
    };
  }, []);

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

  // Set default viewport when tutorial starts and first node is added
  useEffect(() => {
    if (tutorialActive && nodes.length > 0 && !tutorialViewportSet.current) {
      tutorialViewportSet.current = true;
      // Use setTimeout to ensure React Flow and node content are fully initialized
      // Longer delay needed when nodes have pre-loaded image data
      const timeoutId = setTimeout(() => {
        // Center on the first node at zoom 0.7
        const currentNodes = useWorkflowStore.getState().nodes;
        const firstNode = currentNodes[0];
        if (firstNode) {
          const nodeWidth = (firstNode.style?.width as number) || 300;
          const nodeHeight = (firstNode.style?.height as number) || 280;
          const centerX = firstNode.position.x + nodeWidth / 2;
          const centerY = firstNode.position.y + nodeHeight / 2;
          // Use setCenter with explicit zoom to ensure 0.7 zoom level
          setCenter(centerX, centerY, { duration: 500, zoom: 0.7 });
        }
      }, 600);

      return () => clearTimeout(timeoutId);
    }
    // Reset the ref when tutorial ends
    if (!tutorialActive) {
      tutorialViewportSet.current = false;
    }
  }, [tutorialActive, nodes.length, setCenter]);

  // Zoom out when demonstration step starts to show full workflow tree
  useEffect(() => {
    if (!tutorialActive) return;

    const ftuxState = useFTUXStore.getState();
    const currentStep = ftuxState.tutorialSteps[ftuxState.currentTutorialStep];

    if (currentStep?.id === "demonstrate-downstream" && nodes.length > 0) {
      // Zoom out immediately (not after delay) so users can see nodes being added
      const generateNode = nodes.find((n) => n.type === "nanoBanana");
      if (generateNode) {
        // Center on the middle of the workflow tree with generous zoom
        const centerX = generateNode.position.x + 700; // Center of the new wider layout
        const centerY = generateNode.position.y;
        setCenter(centerX, centerY, { duration: 800, zoom: 0.35 }); // Zoom to 0.35 for better overview
      }
    }
  }, [tutorialActive, nodes, setCenter]);

  // Apply dimming className to nodes downstream of disabled Switch outputs or skipped by optional inputs
  const allNodes = useMemo(() => {
    return nodes.map((node) => {
      // Never dim Switch or ConditionalSwitch nodes themselves
      if (node.type === "switch" || node.type === "conditionalSwitch") return node;

      const isDimmed = dimmedNodeIds.has(node.id);
      const isSkipped = skippedNodeIds.has(node.id);
      const extraClasses = [
        isDimmed ? "switch-dimmed" : "",
        isSkipped ? "node-skipped" : "",
      ].filter(Boolean).join(" ");

      // Preserve existing className if any, add/remove dimmed/skipped classes
      const baseClass = (node.className || "").replace(/\bswitch-dimmed\b/g, "").replace(/\bnode-skipped\b/g, "").trim();
      const newClass = extraClasses ? `${baseClass} ${extraClasses}`.trim() : baseClass;

      // Only create new node object if className changed
      if (node.className === newClass) return node;
      return { ...node, className: newClass };
    });
  }, [nodes, dimmedNodeIds, skippedNodeIds]);

  // Switching workflows can leave React Flow holding handle positions measured
  // on the previous workflow's nodes (same ids, different layout), so edges
  // land in the wrong place until something resizes a node. Re-measure every
  // node once the new DOM and viewport are up.
  const updateNodeInternals = useUpdateNodeInternals();
  const workflowLoadCount = useWorkflowStore((state) => state.workflowLoadCount);
  const nodeIdsRef = useRef<string[]>([]);
  nodeIdsRef.current = allNodes.map((n) => n.id);
  useEffect(() => {
    if (!workflowLoadCount) return;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => updateNodeInternals(nodeIdsRef.current));
    });
    return () => cancelAnimationFrame(frame);
  }, [workflowLoadCount, updateNodeInternals]);

  // Node title mapping for FloatingNodeHeaders
  const NODE_TITLES: Record<string, string> = {
    imageInput: 'Image Input',
    audioInput: 'Audio Input',
    videoInput: 'Video Input',
    annotation: 'Annotation',
    prompt: 'Prompt',
    array: 'Array',
    promptConstructor: 'Prompt Constructor',
    nanoBanana: 'Generate Image',
    generateVideo: 'Generate Video',
    generate3d: 'Generate 3D',
    generateAudio: 'Generate Audio',
    llmGenerate: 'LLM Generate',
    splitGrid: 'Split Grid',
    output: 'Output',
    outputGallery: 'Output Gallery',
    imageCompare: 'Image Compare',
    videoStitch: 'Video Stitch',
    easeCurve: 'Ease Curve',
    videoTrim: 'Video Trim',
    videoFrameGrab: 'Frame Grab',
    removeBackground: 'Remove Background',
    imageResize: 'Image Resize',
    gifEncoder: 'GIF Encoder',
    router: 'Router',
    switch: 'Switch',
    conditionalSwitch: 'Conditional Switch',
    glbViewer: '3D Viewer',
    comfyApp: 'ComfyUI App',
  };

  // Helper to get node title (used for FloatingNodeHeader)
  const getNodeTitle = useCallback((node: Node) => {
    // For generate nodes, check for selectedModel display name
    if (node.type === "nanoBanana" || node.type === "generateVideo" || node.type === "generate3d" || node.type === "generateAudio") {
      const model = (node.data as any)?.selectedModel;
      if (model?.displayName) return model.displayName;
    }

    // For LLM nodes, check for selectedLLMModel or selectedModel
    if (node.type === "llmGenerate") {
      const model = (node.data as any)?.selectedLLMModel || (node.data as any)?.selectedModel;
      if (model?.displayName) return model.displayName;
      if (model?.name) return model.name;
    }

    // A Comfy node is titled by the workflow it runs; the wordmark beside it
    // already says what kind of node it is. Unattached, the mark stands alone.
    if (node.type === "comfyApp") {
      return ((node.data as any)?.app?.name as string) || "";
    }

    return NODE_TITLES[node.type || ""] || "Node";
  }, []);


  // Wire comment/title change callbacks for FloatingNodeHeaders
  const handleCustomTitleChange = useCallback((nodeId: string, title: string) => {
    updateNodeData(nodeId, { customTitle: title || undefined });
  }, [updateNodeData]);

  const handleCommentChange = useCallback((nodeId: string, comment: string) => {
    updateNodeData(nodeId, { comment: comment || undefined });
  }, [updateNodeData]);

  // Stable callback for running a node from its header
  const handleRunNode = useCallback((nodeId: string) => {
    regenerateNode(nodeId);
  }, [regenerateNode]);

  // Inline parameters mode (for showing Browse in header)
  const { inlineParametersEnabled } = useInlineParameters();

  // Stable callback for expanding a node from its header
  const handleExpandNode = useCallback((nodeId: string, nodeType: string) => {
    if (nodeType === 'annotation') {
      const node = getNodeById(nodeId);
      if (!node) return;
      const imageToEdit = (node.data as any)?.outputImage || (node.data as any)?.image;
      if (!imageToEdit) return;
      openAnnotationModal(nodeId, imageToEdit, (node.data as any)?.annotations);
    } else {
      setExpandingNode({ id: nodeId, type: nodeType });
    }
  }, [getNodeById, openAnnotationModal]);


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
      // Switch input: accept any type (generic-input handle)
      const targetNode = nodes.find((n) => n.id === connection.target);
      const sourceNode = nodes.find((n) => n.id === connection.source);

      // A Comfy app's output handles are named after graph nodes ("9"), which
      // no naming convention can decode — read their type from the attached
      // workflow's contract instead.
      const sourceType =
        getComfyOutputHandleType(sourceNode, connection.sourceHandle) ??
        getHandleType(connection.sourceHandle);
      const targetType = getHandleType(connection.targetHandle);

      // Both ends of a Comfy app edge must name a handle its attached workflow
      // actually declares. Untyped ids fall through the checks below to
      // "allow", which would commit an edge React Flow can never draw.
      if (targetNode?.type === "comfyApp" && !comfyDeclaresInput(targetNode, connection.targetHandle)) {
        return false;
      }
      if (sourceNode?.type === "comfyApp" && !sourceType) return false;
      if (targetNode?.type === "switch" && connection.targetHandle === "generic-input") return true;

      // Switch output: the type is determined by inputType stored in node data
      if (sourceNode?.type === "switch") {
        const switchData = sourceNode.data as { inputType?: string | null };
        if (switchData.inputType && targetType) {
          return switchData.inputType === targetType;
        }
        // If inputType not set yet, allow connection (will be resolved)
        return true;
      }

      // Conditional Switch: text input only, text outputs only
      if (targetNode?.type === "conditionalSwitch") {
        return sourceType === "text";
      }
      if (sourceNode?.type === "conditionalSwitch") {
        return targetType === "text";
      }

      // If we can't determine types, allow the connection
      if (!sourceType || !targetType) return true;

      // EaseCurve connections: only between easeCurve nodes (or router)
      if (sourceType === "easeCurve" || targetType === "easeCurve") {
        const targetNode = nodes.find((n) => n.id === connection.target);
        const sourceNode = nodes.find((n) => n.id === connection.source);
        if (targetNode?.type === "router" || sourceNode?.type === "router") return true;
        if (sourceType !== "easeCurve" || targetType !== "easeCurve") return false;
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
        if (targetNodeType === "generateVideo" || targetNodeType === "videoStitch" || targetNodeType === "easeCurve" || targetNodeType === "videoTrim" || targetNodeType === "videoFrameGrab" || targetNodeType === "videoInput" || targetNodeType === "output" || targetNodeType === "outputGallery" || targetNodeType === "router" || targetNodeType === "comfyApp") {
          // For output node, we allow video even though its handle is typed as "image"
          // because output node can display both images and videos
          return true;
        }
        // Video cannot connect to other node types
        return false;
      }

      // 3D connections: 3d handles can only connect to matching 3d handles (or router)
      if (sourceType === "3d" || targetType === "3d") {
        // Allow 3d connections to router nodes
        const sourceNode = nodes.find((n) => n.id === connection.source);
        const targetNode = nodes.find((n) => n.id === connection.target);
        if (sourceNode?.type === "router" || targetNode?.type === "router") return true;
        return sourceType === "3d" && targetType === "3d";
      }

      // Audio connections: audio handles connect to audio handles, plus output node (or router)
      if (sourceType === "audio" || targetType === "audio") {
        if (sourceType === "audio") {
          const targetNode = nodes.find((n) => n.id === connection.target);
          if (targetNode?.type === "output" || targetNode?.type === "router") return true;
        }
        // A Comfy app needs no clause of its own here: audio-to-audio is what
        // the fallthrough already allows it, and the early return above covers
        // the only ends that take audio on a differently-typed handle.
        return sourceType === "audio" && targetType === "audio";
      }

      // Standard type matching for image and text
      // Image handles connect to image handles, text handles connect to text handles
      return sourceType === targetType;
    },
    [nodes]
  );

  // Drag an edge end onto another handle. Generic router/switch handles are
  // resolved only on first connection, so a re-plug onto one is left alone.
  const handleReconnect = useCallback(
    (oldEdge: Edge, connection: Connection) => {
      if (!isValidConnection(connection)) return;
      if (connection.targetHandle === "generic-input" || connection.sourceHandle === "generic-output") return;
      reconnectEdge(oldEdge.id, connection);
    },
    [isValidConnection, reconnectEdge]
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

      // For Router nodes, resolve generic handles to typed handles
      const resolveRouterHandle = (conn: Connection): Connection => {
        const targetNode = nodes.find((n) => n.id === conn.target);
        if (targetNode?.type !== "router") return conn;

        // If targeting a generic handle, transform to typed handle
        if (conn.targetHandle === "generic-input") {
          const sourceType = getHandleType(conn.sourceHandle);
          if (sourceType) {
            return { ...conn, targetHandle: sourceType };
          }
        }
        return conn;
      };

      // For Router source nodes, resolve generic output handles to typed handles
      const resolveRouterSourceHandle = (conn: Connection): Connection => {
        const sourceNode = nodes.find((n) => n.id === conn.source);
        if (sourceNode?.type !== "router") return conn;
        if (conn.sourceHandle === "generic-output") {
          const targetType = getHandleType(conn.targetHandle);
          if (targetType) {
            return { ...conn, sourceHandle: targetType };
          }
        }
        return conn;
      };

      // For Switch nodes, resolve generic-input to the source's handle type and update inputType
      const resolveSwitchHandle = (conn: Connection): Connection => {
        const targetNode = nodes.find((n) => n.id === conn.target);
        if (targetNode?.type !== "switch") return conn;

        // If targeting the generic-input handle, resolve to the source handle type
        if (conn.targetHandle === "generic-input") {
          const sourceType = getHandleType(conn.sourceHandle);
          if (sourceType) {
            // Update the Switch node's inputType in data so output handles render
            updateNodeData(conn.target, { inputType: sourceType as HandleType });
            return { ...conn, targetHandle: sourceType };
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
            resolved = resolveRouterHandle(resolved);
            resolved = resolveRouterSourceHandle(resolved);
            resolved = resolveSwitchHandle(resolved);
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
            // Check for cycle and mark as loop edge if detected
            if (wouldCreateCycle(resolved.source!, resolved.target!, edges)) {
              onConnect(resolved, { isLoop: true, loopCount: 3 });
            } else {
              onConnect(resolved);
            }
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

          let resolved = resolveImageCompareHandle(multiConnection, batchUsed);
          resolved = resolveRouterHandle(resolved);
          resolved = resolveRouterSourceHandle(resolved);
          resolved = resolveSwitchHandle(resolved);
          if (resolved.targetHandle) batchUsed.add(resolved.targetHandle);
          if (isValidConnection(resolved)) {
            // Check for cycle and mark as loop edge if detected
            if (wouldCreateCycle(resolved.source!, resolved.target!, edges)) {
              onConnect(resolved, { isLoop: true, loopCount: 3 });
            } else {
              onConnect(resolved);
            }
          }
        });
      } else {
        // Single connection
        let resolved = resolveImageCompareHandle(connection);
        resolved = resolveRouterHandle(resolved);
        resolved = resolveRouterSourceHandle(resolved);
        resolved = resolveSwitchHandle(resolved);
        // Check for cycle and mark as loop edge if detected
        if (wouldCreateCycle(resolved.source!, resolved.target!, edges)) {
          onConnect(resolved, { isLoop: true, loopCount: 3 });
        } else {
          onConnect(resolved);
        }
      }
    },
    [onConnect, nodes, edges]
  );

  // Handle connection dropped on empty space or on a node
  const handleConnectEnd: OnConnectEnd = useCallback(
    (event, connectionState) => {
      // A click on the handle (no drag) opens the handle menu instead
      const down = handlePointerDownRef.current;
      if (down && "clientX" in event && Math.hypot(event.clientX - down.x, event.clientY - down.y) <= HANDLE_CLICK_SLOP) {
        return;
      }

      // If connection was completed normally, nothing to do
      if (connectionState.isValid || !connectionState.fromNode) {
        return;
      }

      const { clientX, clientY } = event as MouseEvent;
      const fromHandleId = connectionState.fromHandle?.id || null;
      let fromHandleType = getHandleType(fromHandleId); // Use getHandleType for dynamic handles
      const isFromSource = connectionState.fromHandle?.type === "source";

      // Switch output handles have dynamic IDs — resolve type from node's inputType
      if (!fromHandleType && connectionState.fromNode.type === "switch") {
        const switchData = connectionState.fromNode.data as { inputType?: string | null };
        if (switchData.inputType) {
          fromHandleType = switchData.inputType as "image" | "text" | "video" | "audio" | "3d" | "easeCurve";
        }
      }

      // ConditionalSwitch output handles have dynamic IDs (rule-xxx, default) — always text type
      if (!fromHandleType && connectionState.fromNode.type === "conditionalSwitch") {
        fromHandleType = "text";
      }

      // Comfy app output handles are named after ComfyUI graph nodes ("9"), so
      // no naming convention decodes them — read the type off the attached
      // workflow's contract.
      if (!fromHandleType && connectionState.fromNode.type === "comfyApp") {
        fromHandleType = getComfyOutputHandleType(connectionState.fromNode, fromHandleId);
      }

      // Helper to find a compatible handle on a node by type
      const findCompatibleHandle = (
        node: Node,
        handleType: "image" | "text" | "video" | "audio" | "3d" | "easeCurve",
        needInput: boolean,
        batchUsed?: Set<string>
      ): string | null => {
        // Check for dynamic inputSchema first
        const nodeData = node.data as { inputSchema?: Array<{ name: string; type: string }> };

        // A Comfy app's handles come entirely from its attached workflow, and
        // its outputs are declared independently of its inputs — a text-to-image
        // app with nothing to connect has an empty `inputSchema` and a perfectly
        // good image output. Resolved before the schema check for that reason:
        // dragging onto such a node used to find nothing and drop the wire.
        if (node.type === "comfyApp") {
          if (needInput) {
            const matching = (nodeData.inputSchema ?? []).filter((i) => i.type === handleType);
            for (let i = 0; i < matching.length; i += 1) {
              const candidateHandle = `${handleType}-${i}`;
              const isOccupied =
                edges.some(
                  (edge) => edge.target === node.id && edge.targetHandle === candidateHandle
                ) || batchUsed?.has(candidateHandle);
              if (!isOccupied) return candidateHandle;
            }
            return null;
          }
          // Output handle ids are ComfyUI node ids, so no naming convention
          // decodes them — and the static list below is a superset kept for
          // connection *validation*, not a set of handles this node renders.
          const app = (node.data as { app?: { outputs?: Array<{ id: string; type: string }> } })
            .app;
          return app?.outputs?.find((o) => o.type === handleType)?.id ?? null;
        }

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
            // The node's schema declares no input of this type. Falling through
            // to the output branch below would hand back an OUTPUT handle as
            // the connection target, so stop here instead.
            return null;
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

        // GifEncoder has dynamic indexed image input handles (image-0, image-1, ...)
        if (node.type === "gifEncoder" && needInput && handleType === "image") {
          for (let i = 0; i < 50; i++) {
            const candidateHandle = `image-${i}`;
            const isOccupied = edges.some(
              (edge) => edge.target === node.id && edge.targetHandle === candidateHandle
            ) || batchUsed?.has(candidateHandle);
            if (!isOccupied) return candidateHandle;
          }
          return null;
        }

        // Router accepts any type — use typed handle if exists, otherwise generic
        if (node.type === "router" && needInput) {
          // Router accepts any type — use typed handle if that type is already active
          return handleType;
        }
        if (node.type === "router" && !needInput) {
          return handleType;
        }

        // Switch accepts any type on input, outputs match inputType
        if (node.type === "switch" && needInput) {
          return "generic-input";
        }
        if (node.type === "switch" && !needInput) {
          const switchData = node.data as { switches?: Array<{ id: string; enabled: boolean }> };
          // Return first enabled switch output handle ID
          if (switchData.switches && switchData.switches.length > 0) {
            const firstEnabled = switchData.switches.find(s => s.enabled);
            if (firstEnabled) return firstEnabled.id;
          }
          return null;
        }

        // Conditional Switch: text input, dynamic rule outputs
        if (node.type === "conditionalSwitch" && handleType === "text") {
          if (needInput) {
            return "text";
          } else {
            // Return first rule ID from node data
            const condData = node.data as { rules?: Array<{ id: string }> };
            if (condData.rules && condData.rules.length > 0) {
              return condData.rules[0].id;
            }
            return "default";
          }
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

      // Tutorial tracking
      if (tutorialActive) {
        useFTUXStore.getState().setConnectionMenuShown(true);
      }
    },
    [screenToFlowPosition, nodes, edges, handleConnect, tutorialActive]
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
      case "removeBackground":
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

  // Create lightweight workflow state for chat (strip base64 images).
  // Keep a ref to the raw nodes/edges and expose the stripped payload lazily via
  // getters, so the expensive stripBinaryData/remap only runs when the value is
  // actually read (at chat send time, when ChatPanel serializes it) rather than
  // on every drag frame or execution-status tick.
  const chatWorkflowRawRef = useRef({ nodes, edges });
  chatWorkflowRawRef.current = { nodes, edges };
  const chatWorkflowState = useMemo(() => ({
    get nodes() {
      const strippedNodes = stripBinaryData(chatWorkflowRawRef.current.nodes);
      return strippedNodes.map(n => ({
        id: n.id,
        type: n.type,
        position: n.position,
        data: n.data,
      }));
    },
    get edges() {
      return chatWorkflowRawRef.current.edges.map(e => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle || undefined,
        targetHandle: e.targetHandle || undefined,
      }));
    },
  }), []);

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
    (selection: { type: NodeType | MenuAction; isAction: boolean; savedNodeId?: string }) => {
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

      // A saved Comfy node is created with its workflow already on it, which is
      // what gives it handles for the dropped wire to land on.
      const saved = selection.savedNodeId ? getSavedComfyNode(selection.savedNodeId) : null;

      // Create the new node at the drop position (empty - tutorial will populate after connection)
      const newNodeId = addNode(
        nodeType,
        flowPosition,
        saved ? seedFromSavedComfyNode(saved) : undefined
      );

      // Tutorial tracking
      if (tutorialActive && nodeType === "nanoBanana") {
        useFTUXStore.getState().setNanoBananaAddedFromMenu(true);
      }

      // A fresh Comfy app node has no handles until a workflow is attached, so
      // the dropped connection has nothing to land on. Open the import dialog
      // straight away rather than leaving an empty node and a lost wire.
      if (nodeType === "comfyApp" && !saved) {
        updateNodeData(newNodeId, { _autoOpenImport: true });
      }

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

      // Router accepts and outputs all types — use the connection's handle type
      if (saved) {
        // Its handles come from the workflow's own contract, so the wire is
        // matched against that rather than against a table of node types.
        targetHandleId =
          appInputHandles(saved.app).find((input) => input.type === handleType)?.handleId ?? null;
        sourceHandleIdForNewNode =
          saved.app.outputs.find((output) => output.type === handleType)?.id ?? null;
      } else if (nodeType === "router") {
        if (handleType) {
          targetHandleId = handleType;
          sourceHandleIdForNewNode = handleType;
        }
      } else if (nodeType === "switch") {
        // Switch input: use the actual type so the edge stores the correct handle type
        // (onConnect bypasses resolveSwitchHandle, so we must resolve here)
        targetHandleId = handleType || "generic-input";
        if (handleType) {
          updateNodeData(newNodeId, { inputType: handleType as HandleType });
        }
        // Switch outputs use dynamic handle IDs (switch entry IDs)
        sourceHandleIdForNewNode = null;
      } else if (nodeType === "conditionalSwitch") {
        // Conditional Switch: text input and dynamic rule outputs
        targetHandleId = "text";
        // Source handle is the first rule ID or "default"
        const nodeDataCheck = nodes.find(n => n.id === newNodeId);
        if (nodeDataCheck && nodeDataCheck.data) {
          const condData = nodeDataCheck.data as { rules?: Array<{ id: string }> };
          sourceHandleIdForNewNode = condData.rules && condData.rules.length > 0 ? condData.rules[0].id : "default";
        } else {
          sourceHandleIdForNewNode = "default";
        }
      } else if (handleType === "image") {
        if (nodeType === "annotation" || nodeType === "output" || nodeType === "splitGrid" || nodeType === "outputGallery" || nodeType === "imageCompare" || nodeType === "removeBackground") {
          targetHandleId = "image";
          // annotation and removeBackground also have an image output
          if (nodeType === "annotation" || nodeType === "removeBackground") {
            sourceHandleIdForNewNode = "image";
          }
        } else if (nodeType === "nanoBanana" || nodeType === "generateVideo") {
          targetHandleId = "image";
        } else if (nodeType === "imageResize") {
          targetHandleId = "image";
          sourceHandleIdForNewNode = "image";
        } else if (nodeType === "gifEncoder") {
          targetHandleId = "image-0";
          sourceHandleIdForNewNode = "image";
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
        if (nodeType === "videoInput") {
          // VideoInput accepts video input and outputs video
          targetHandleId = "video";
          sourceHandleIdForNewNode = "video";
        } else if (nodeType === "videoStitch") {
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
        } else if (nodeType === "generateVideo") {
          // GenerateVideo accepts audio input and outputs video
          targetHandleId = "audio";
          sourceHandleIdForNewNode = "video";
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
    [connectionDrop, addNode, onConnect, nodes, handleSplitGridAction, getImageFromNode, updateNodeData, tutorialActive]
  );

  const handleCloseDropMenu = useCallback(() => {
    setConnectionDrop(null);
  }, []);

  // Open the searchable "add node" menu at a screen position (double-click or
  // right-click on the empty canvas).
  const openNodeSearchMenu = useCallback(
    (clientX: number, clientY: number) => {
      if (isModalOpen || tutorialActive) return;
      setConnectionDrop(null);
      setNodeSearchMenu({
        position: { x: clientX, y: clientY },
        flowPosition: screenToFlowPosition({ x: clientX, y: clientY }),
      });
    },
    [isModalOpen, tutorialActive, screenToFlowPosition]
  );

  // Double-clicking the empty canvas opens the node search menu.
  const handlePaneDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      // Only react to double-clicks on the empty pane, not on a node/edge/control.
      const target = event.target as HTMLElement;
      if (!target.classList?.contains("react-flow__pane")) return;
      event.preventDefault();
      openNodeSearchMenu(event.clientX, event.clientY);
    },
    [openNodeSearchMenu]
  );

  // Right-clicking the empty canvas opens the node search menu (instead of the
  // browser context menu).
  const handlePaneContextMenu = useCallback(
    (event: React.MouseEvent | MouseEvent) => {
      event.preventDefault();
      openNodeSearchMenu(event.clientX, event.clientY);
    },
    [openNodeSearchMenu]
  );

  const handleNodeSearchSelect = useCallback(
    (type: NodeType, savedNodeId?: string) => {
      if (nodeSearchMenu) {
        const saved = savedNodeId ? getSavedComfyNode(savedNodeId) : null;
        addNode(
          type,
          nodeSearchMenu.flowPosition,
          saved ? seedFromSavedComfyNode(saved) : undefined
        );
      }
      setNodeSearchMenu(null);
    },
    [nodeSearchMenu, addNode]
  );

  const handleCloseNodeSearch = useCallback(() => {
    setNodeSearchMenu(null);
  }, []);

  // Get copy/paste functions and clipboard from store
  const copySelectedNodes = useWorkflowStore((state) => state.copySelectedNodes);
  const pasteNodes = useWorkflowStore((state) => state.pasteNodes);
  const clearClipboard = useWorkflowStore((state) => state.clearClipboard);
  const clipboard = useWorkflowStore((state) => state.clipboard);
  const undo = useWorkflowStore((state) => state.undo);
  const redo = useWorkflowStore((state) => state.redo);

  // Wheel-based pan/zoom, honoring the user's navigation settings. Disabled
  // while a modal is open (the modal's mini canvas drives its own).
  useWheelPanZoom(reactFlowWrapper, canvasNavigationSettings, !isModalOpen);

  // Keyboard shortcuts for copy/paste and stacking selected nodes
  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    // Ignore if user is typing in an input field (including the edge label
    // field, which lives in React Flow's label layer)
    const active = document.activeElement;
    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement ||
      (event.target instanceof HTMLElement && event.target.isContentEditable) ||
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      (active instanceof HTMLElement && active.isContentEditable)
    ) {
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
      // Resume-from-pause is handled inside executeWorkflow when no explicit
      // start node is given.
      executeWorkflow();
      return;
    }

    // Handle copy (Ctrl/Cmd + C)
    if ((event.ctrlKey || event.metaKey) && event.key === "c") {
      event.preventDefault();
      copySelectedNodes();
      return;
    }

    // Handle undo (Ctrl/Cmd + Z) and redo (Ctrl/Cmd + Shift + Z)
    // Normalize key to lowercase — Shift makes event.key uppercase ("Z" instead of "z")
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) {
        redo();
      } else {
        undo();
      }
      return;
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
            nodeType = "router";
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
          case "y":
            nodeType = "videoInput";
            break;
          case "c":
            nodeType = "comfyApp";
            break;
        }

        if (nodeType) {
          event.preventDefault();
          const { centerX, centerY } = getViewportCenter();
          // Offset by half the default node dimensions to center it
          const dims = defaultNodeDimensions[nodeType];
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

        const changes = sortedNodes.map((node) => {
          const nodeHeight = (node.style?.height as number) || (node.measured?.height) || 200;

          const change = {
            type: "position" as const,
            id: node.id,
            position: { x: alignX, y: currentY },
          };

          currentY += nodeHeight + STACK_GAP;
          return change;
        });

        onNodesChange(changes);
      } else if (event.key === "h" || event.key === "H") {
        // Stack horizontally - sort by current x position to maintain relative order
        const sortedNodes = [...selectedNodes].sort((a, b) => a.position.x - b.position.x);

        // Use the topmost y position as the alignment point
        const alignY = Math.min(...sortedNodes.map((n) => n.position.y));

        let currentX = sortedNodes[0].position.x;

        const changes = sortedNodes.map((node) => {
          const nodeWidth = (node.style?.width as number) || (node.measured?.width) || 220;

          const change = {
            type: "position" as const,
            id: node.id,
            position: { x: currentX, y: alignY },
          };

          currentX += nodeWidth + STACK_GAP;
          return change;
        });

        onNodesChange(changes);
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
        const changes = sortedNodes.map((node, index) => {
          const col = index % cols;
          const row = Math.floor(index / cols);

          return {
            type: "position" as const,
            id: node.id,
            position: {
              x: startX + col * (maxWidth + STACK_GAP),
              y: startY + row * (maxHeight + STACK_GAP),
            },
          };
        });

        onNodesChange(changes);
      }
  }, [nodes, onNodesChange, copySelectedNodes, pasteNodes, clearClipboard, clipboard, getViewport, addNode, updateNodeData, executeWorkflow, setShortcutsDialogOpen, undo, redo]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // A single click on a handle opens its menu; a drag still starts a
  // connection. The pointer-down position tells the two apart.
  const [handleMenu, setHandleMenu] = useState<HandleMenuTarget | null>(null);
  const closeHandleMenu = useCallback(() => setHandleMenu(null), []);
  useEffect(() => {
    const wrapper = reactFlowWrapper.current;
    if (!wrapper) return;
    const handleOf = (target: EventTarget | null) =>
      target instanceof Element ? target.closest<HTMLElement>(".react-flow__handle") : null;
    const onDown = (event: PointerEvent) => {
      handlePointerDownRef.current = handleOf(event.target) ? { x: event.clientX, y: event.clientY } : null;
    };
    const onClick = (event: MouseEvent) => {
      const handle = handleOf(event.target);
      const down = handlePointerDownRef.current;
      if (!handle || !down) return;
      if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > HANDLE_CLICK_SLOP) return;
      const nodeId = handle.dataset.nodeid;
      if (!nodeId) return;
      const rect = handle.getBoundingClientRect();
      setHandleMenu({
        nodeId,
        handleId: handle.dataset.handleid ?? null,
        type: handle.classList.contains("source") ? "source" : "target",
        position: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
      });
    };
    wrapper.addEventListener("pointerdown", onDown, true);
    wrapper.addEventListener("click", onClick);
    return () => {
      wrapper.removeEventListener("pointerdown", onDown, true);
      wrapper.removeEventListener("click", onClick);
    };
  }, []);

  // Which handle is under the pointer: hidden connections on it ghost back.
  // One delegated listener on the wrapper instead of a handler per handle.
  const setHoveredHandle = useWorkflowStore((state) => state.setHoveredHandle);
  const setExpandedStubGroup = useWorkflowStore((state) => state.setExpandedStubGroup);
  useEffect(() => {
    const wrapper = reactFlowWrapper.current;
    if (!wrapper || !setHoveredHandle) return;
    const handleOf = (target: EventTarget | null) =>
      target instanceof Element ? target.closest<HTMLElement>(".react-flow__handle") : null;
    const onOver = (event: MouseEvent) => {
      const handle = handleOf(event.target);
      if (!handle) return;
      const nodeId = handle.dataset.nodeid;
      if (!nodeId) return;
      setHoveredHandle({
        nodeId,
        handleId: handle.dataset.handleid ?? null,
        type: handle.classList.contains("source") ? "source" : "target",
      });
    };
    const onOut = (event: MouseEvent) => {
      const handle = handleOf(event.target);
      if (!handle) return;
      const next = event.relatedTarget instanceof Element ? event.relatedTarget.closest(".react-flow__handle") : null;
      if (next !== handle) setHoveredHandle(null);
    };
    wrapper.addEventListener("mouseover", onOver);
    wrapper.addEventListener("mouseout", onOut);
    return () => {
      wrapper.removeEventListener("mouseover", onOver);
      wrapper.removeEventListener("mouseout", onOut);
    };
  }, [setHoveredHandle]);


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
        // Captured now: the reader resolves after the drop event is recycled.
        const dropPosition = screenToFlowPosition({ x: event.clientX, y: event.clientY });
        const reader = new FileReader();
        reader.onload = async (e) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(e.target?.result as string);
          } catch {
            alert("Failed to parse workflow file");
            return;
          }
          if (isNodeBananaWorkflow(parsed)) {
            // Reported the same way the parse failure above is: without this the
            // rejection is unhandled and the canvas simply does not change.
            try {
              await loadWorkflow(parsed as WorkflowFile);
            } catch (err) {
              console.error("Failed to load workflow:", err);
              alert("Failed to load workflow file");
            }
            return;
          }
          // A ComfyUI workflow becomes a node rather than replacing the canvas.
          // The node reads it and opens the import dialog, so the inputs and
          // outputs it will expose are still confirmed before it is usable.
          if (isComfyWorkflow(parsed)) {
            const nodeId = addNode("comfyApp", dropPosition);
            updateNodeData(nodeId, {
              _pendingWorkflow: { workflow: parsed, filename: file.name },
            });
            return;
          }
          alert("Invalid workflow file format");
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
      className={`flex-1 bg-canvas-bg relative ${
        isCanvasOverview ? "canvas-overview" : ""
      } ${isDragOver ? "ring-2 ring-inset ring-blue-500" : ""}`}
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
      {showQuickstart && (
        <WelcomeModal
          onWorkflowGenerated={async (workflow, directoryPath) => {
            await loadWorkflow(workflow, directoryPath);
            setShowQuickstart(false);
          }}
          onClose={() => setShowQuickstart(false)}
          onNewProject={() => {
            clearWorkflow();
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
        edges={isCanvasOverview ? OVERVIEW_EDGES : edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={handleConnect}
        onConnectEnd={handleConnectEnd}
        onReconnect={handleReconnect}
        onPaneClick={() => setExpandedStubGroup?.(null)}
        onMoveStart={() => { isPanningRef.current = true; setHoveredNodeId(null); document.documentElement.classList.add("canvas-interacting"); if (reactFlowWrapper.current) setCanvasPanningClass(true, reactFlowWrapper.current); }}
        onMoveEnd={() => { isPanningRef.current = false; document.documentElement.classList.remove("canvas-interacting"); if (reactFlowWrapper.current) setCanvasPanningClass(false, reactFlowWrapper.current); }}
        onNodeDragStart={() => { isDraggingNodeRef.current = true; document.documentElement.classList.add("canvas-interacting"); }}
        onNodeDragStop={(event, node) => { isDraggingNodeRef.current = false; document.documentElement.classList.remove("canvas-interacting"); handleNodeDragStop(event, node); }}
        onSelectionChange={handleSelectionChange}
        onDoubleClick={handlePaneDoubleClick}
        onPaneContextMenu={handlePaneContextMenu}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        isValidConnection={isValidConnection}
        connectOnClick={false}
        elevateEdgesOnSelect
        fitView
        deleteKeyCode={isModalOpen ? null : ["Backspace", "Delete"]}
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
          tutorialActive
            ? false
            : isModalOpen
            ? false
            : canvasNavigationSettings.panMode === "always"
            ? true
            : canvasNavigationSettings.panMode === "middleMouse"
            ? [2]
            : !isMacOS
        }
        selectNodesOnDrag={false}
        nodeDragThreshold={5}
        nodeClickDistance={5}
        zoomOnScroll={tutorialActive ? false : false}
        zoomOnPinch={tutorialActive ? false : !isModalOpen}
        zoomOnDoubleClick={false}
        minZoom={0.1}
        maxZoom={4}
        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
        panActivationKeyCode={
          tutorialActive
            ? null
            : isModalOpen
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
        <SharedEdgeGradients />
        <GroupBackgroundsPortal />
        <GroupControlsOverlay />
        <Background
          color="#404040"
          gap={20}
          size={1}
          className={tutorialActive && lockedFeatures ? "opacity-30 pointer-events-none" : ""}
        />
        <Controls className={`bg-neutral-800 border border-neutral-700 rounded-lg shadow-lg [&>button]:bg-neutral-800 [&>button]:border-neutral-700 [&>button]:fill-neutral-300 [&>button:hover]:bg-neutral-700 [&>button:hover]:fill-neutral-100 ${tutorialActive && lockedFeatures ? "opacity-30 pointer-events-none" : ""}`} />
        {isMinimapVisible ? (
          <>
            <MiniMap
              className={`bg-neutral-800 border border-neutral-700 rounded-lg shadow-lg ${tutorialActive && lockedFeatures ? "opacity-30 pointer-events-none" : ""}`}
              style={{
                width: MINIMAP_GEOMETRY.width,
                height: MINIMAP_GEOMETRY.height,
                margin: MINIMAP_GEOMETRY.margin,
              }}
              maskColor="rgba(0, 0, 0, 0.6)"
              pannable
              zoomable
              nodeColor={getMiniMapNodeColor}
            />
            <button
              type="button"
              aria-label="Hide minimap"
              title="Hide minimap"
              disabled={tutorialActive && lockedFeatures}
              onClick={() => setIsMinimapVisible(false)}
              style={MINIMAP_CLOSE_POSITION}
              className="nodrag nopan nowheel absolute z-[6] flex h-7 w-7 items-center justify-center rounded-md border border-neutral-600/80 bg-neutral-950/85 text-neutral-400 shadow-sm backdrop-blur-sm transition-colors hover:border-neutral-500 hover:bg-neutral-800 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed"
            >
              <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="none">
                <path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
              </svg>
            </button>
          </>
        ) : (
          <button
            type="button"
            aria-label="Show minimap"
            title="Show minimap"
            disabled={tutorialActive && lockedFeatures}
            onClick={() => setIsMinimapVisible(true)}
            style={{ right: MINIMAP_GEOMETRY.margin, bottom: MINIMAP_GEOMETRY.margin }}
            className={`nodrag nopan nowheel absolute z-[5] flex h-10 w-10 items-center justify-center rounded-lg border border-neutral-700 bg-neutral-800 text-neutral-400 shadow-lg transition-colors hover:border-neutral-600 hover:bg-neutral-700 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed ${tutorialActive && lockedFeatures ? "opacity-30 pointer-events-none" : ""}`}
          >
            <svg aria-hidden="true" viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none">
              <rect x="2.5" y="3.5" width="15" height="13" rx="2" stroke="currentColor" strokeWidth="1.5" />
              <path d="M5.5 7h2v2h-2zM9 7h2v2H9zM12.5 7h2v2h-2zM5.5 10.5h2v2h-2zM9 10.5h5.5v2H9z" fill="currentColor" />
            </svg>
          </button>
        )}
        <ViewportPortal>
          {allNodes.map((node) => {
            // Groups don't get floating headers
            if (node.type === "group" as any) return null;

            const defaultWidth = defaultNodeDimensions[node.type as NodeType]?.width ?? 250;
            const headerWidth = node.measured?.width || (node.style?.width as number) || defaultWidth;

            // Browse button for generate nodes in inline-parameters mode
            const showBrowse = inlineParametersEnabled && (
              node.type === "nanoBanana" || node.type === "generateVideo" ||
              node.type === "generate3d" || node.type === "generateAudio"
            );
            const browseAction = showBrowse ? (
              <button
                onClick={() => browseRegistry.open(node.id)}
                className="nodrag nopan text-[10px] py-0.5 px-1.5 bg-neutral-700 hover:bg-neutral-600 border border-neutral-600 rounded text-neutral-300 transition-colors"
              >
                Browse
              </button>
            ) : undefined;

            // Optional toggle for input nodes
            const isInputNode = node.type === "imageInput" || node.type === "audioInput" || node.type === "prompt";
            const isOptional = !!(node.data as any)?.isOptional;
            const optionalToggle = isInputNode ? (
              <button
                onClick={() => updateNodeData(node.id, { isOptional: !isOptional })}
                className={`nodrag nopan text-[10px] py-0.5 px-1.5 rounded transition-colors ${
                  isOptional
                    ? "bg-amber-600/80 hover:bg-amber-500/80 text-white border border-amber-500/50"
                    : "bg-neutral-700 hover:bg-neutral-600 border border-neutral-600 text-neutral-400"
                }`}
                title={isOptional ? "This input is optional — empty inputs will be skipped" : "Mark as optional — empty inputs will skip this branch"}
              >
                {isOptional ? "Optional" : "Required"}
              </button>
            ) : undefined;

            // Fallback shield button for generation nodes
            const isGenerationNode =
              node.type === "nanoBanana" ||
              node.type === "generateVideo" ||
              node.type === "generate3d" ||
              node.type === "generateAudio" ||
              node.type === "llmGenerate";
            const fbData = node.data as any;
            const hasFallback = !!fbData?.fallbackModel;
            const fallbackName = fbData?.fallbackModel?.displayName;
            const capabilityForNodeType = (t: string | undefined) => {
              if (t === "nanoBanana") return "image" as const;
              if (t === "generateVideo") return "video" as const;
              if (t === "generate3d") return "3d" as const;
              if (t === "generateAudio") return "audio" as const;
              return null;
            };
            const fallbackButton = isGenerationNode ? (
              <div className="relative shrink-0">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (node.type === "llmGenerate") {
                      setLlmFallbackState({ nodeId: node.id });
                    } else {
                      const cap = capabilityForNodeType(node.type);
                      if (cap) setFallbackDialogState({ nodeId: node.id, capability: cap });
                    }
                  }}
                  className={`nodrag nopan p-0.5 rounded transition-colors border flex items-center ${
                    hasFallback
                      ? "text-blue-400 border-blue-600/60 hover:text-blue-200"
                      : "text-neutral-500 border-neutral-600 hover:text-neutral-200"
                  }`}
                  title={hasFallback ? `Fallback: ${fallbackName}` : "Set fallback model (runs if primary fails)"}
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 12a8 8 0 0 1 16 0M12 4v8M8 12Q9 7 12 4M16 12Q15 7 12 4M4 12l8 8M20 12l-8 8M11 20h2" />
                  </svg>
                </button>
                {hasFallback && (
                  <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-blue-400 ring-1 ring-neutral-900 pointer-events-none" />
                )}
              </div>
            ) : undefined;

            return (
              <FloatingNodeHeader
                key={`header-${node.id}`}
                id={node.id}
                type={node.type as NodeType}
                isInLockedGroup={!!(node.data as any)?.isInLockedGroup}
                isExecuting={!!(node.data as any)?.isExecuting}
                focusedCommentNodeId={(node.data as any)?.focusedCommentNodeId}
                position={node.position}
                width={headerWidth}
                selected={!!node.selected}
                title={getNodeTitle(node)}
                titleLogo={
                  node.type === "comfyApp" ? (
                    <ComfyWordmark className="h-3 w-auto shrink-0" />
                  ) : undefined
                }
                customTitle={node.data?.customTitle}
                comment={node.data?.comment}
                provider={(node.data as any)?.selectedModel?.provider}
                headerAction={(browseAction || fallbackButton) ? (
                  <>
                    {browseAction}
                    {fallbackButton}
                  </>
                ) : undefined}
                headerButtons={optionalToggle}
                onCustomTitleChange={handleCustomTitleChange}
                onCommentChange={handleCommentChange}
                onRunNode={handleRunNode}
                onExpandNode={handleExpandNode}
              />
            );
          })}
        </ViewportPortal>
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

      {/* Handle menu (single click on a handle) */}
      {handleMenu && <HandleMenu target={handleMenu} onClose={closeHandleMenu} />}

      {/* Node search menu (double-click empty canvas) */}
      {nodeSearchMenu && (
        <NodeSearchMenu
          position={nodeSearchMenu.position}
          onSelect={handleNodeSearchSelect}
          onClose={handleCloseNodeSearch}
        />
      )}

      {/* Multi-select toolbar */}
      <MultiSelectToolbar />

      {/* Edge toolbar */}

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

      {/* Control panel - renders on right side when a configurable node is selected */}
      <ControlPanel />

      {/* Expansion modals - rendered via portal when expand button is clicked */}
      {expandingNode && expandingNode.type === 'prompt' && (() => {
        const node = getNodeById(expandingNode.id);
        if (!node) return null;
        return createPortal(
          <PromptEditorModal
            isOpen={true}
            initialPrompt={(node.data as any)?.prompt || ''}
            onSubmit={(prompt) => {
              updateNodeData(expandingNode.id, { prompt });
              setExpandingNode(null);
            }}
            onClose={() => setExpandingNode(null)}
          />,
          document.body
        );
      })()}

      {expandingNode && expandingNode.type === 'promptConstructor' && (() => {
        const node = getNodeById(expandingNode.id);
        if (!node) return null;

        // Compute available variables from connected text nodes (same logic as PromptConstructorNode)
        const directTextNodes = edges
          .filter((e) => e.target === expandingNode.id && e.targetHandle === "text")
          .map((e) => nodes.find((n) => n.id === e.source))
          .filter((n): n is typeof nodes[0] => n !== undefined);
        const connectedTextNodes = resolveTextSourcesThroughRouters(directTextNodes, nodes, edges);

        const vars: AvailableVariable[] = [];
        const usedNames = new Set<string>();

        connectedTextNodes.forEach((cn) => {
          if (cn.type === "prompt") {
            const promptData = cn.data as PromptNodeData;
            if (promptData.variableName) {
              vars.push({ name: promptData.variableName, value: promptData.prompt || "", nodeId: cn.id });
              usedNames.add(promptData.variableName);
            }
          }
        });

        connectedTextNodes.forEach((cn) => {
          let text: string | null = null;
          if (cn.type === "prompt") text = (cn.data as PromptNodeData).prompt || null;
          else if (cn.type === "llmGenerate") text = (cn.data as LLMGenerateNodeData).outputText || null;
          else if (cn.type === "promptConstructor") {
            const pcData = cn.data as PromptConstructorNodeData;
            text = pcData.outputText ?? pcData.template ?? null;
          }
          if (text) {
            parseVarTags(text).forEach(({ name, value }) => {
              if (!usedNames.has(name)) {
                vars.push({ name, value, nodeId: `${cn.id}-var-${name}` });
                usedNames.add(name);
              }
            });
          }
        });

        return createPortal(
          <PromptConstructorEditorModal
            isOpen={true}
            initialTemplate={(node.data as PromptConstructorNodeData)?.template || ''}
            availableVariables={vars}
            onSubmit={(template) => {
              updateNodeData(expandingNode.id, { template });
              setExpandingNode(null);
            }}
            onClose={() => setExpandingNode(null)}
          />,
          document.body
        );
      })()}

      {expandingNode && expandingNode.type === 'splitGrid' && (() => {
        const node = getNodeById(expandingNode.id);
        if (!node) return null;
        return (
          <SplitGridTemplateModal
            nodeId={expandingNode.id}
            nodeData={node.data as any}
            onClose={() => setExpandingNode(null)}
          />
        );
      })()}

      {/* Fallback model picker dialog (image/video/audio/3d) */}
      {fallbackDialogState && (
        <ModelSearchDialog
          isOpen
          onClose={() => setFallbackDialogState(null)}
          title="Select fallback model"
          initialCapabilityFilter={fallbackDialogState.capability}
          showClearOption
          onClearSelection={() => {
            updateNodeData(fallbackDialogState.nodeId, { fallbackModel: undefined, fallbackParameters: undefined });
            setFallbackDialogState(null);
          }}
          onModelSelected={(model) => {
            updateNodeData(fallbackDialogState.nodeId, {
              fallbackModel: {
                provider: model.provider,
                modelId: model.id,
                displayName: model.name,
                capabilities: model.capabilities,
              },
              fallbackParameters: {},
            });
            setFallbackDialogState(null);
          }}
        />
      )}

      {/* LLM fallback popover */}
      {llmFallbackState && (
        <LLMFallbackPopover
          nodeId={llmFallbackState.nodeId}
          onClose={() => setLlmFallbackState(null)}
        />
      )}

      {/* AnnotationModal is globally managed by annotationStore and mounted
          once at the app root (src/app/page.tsx) to avoid duplicate keydown
          listeners firing shortcuts twice. */}

      {/* Tutorial overlay */}
      <TutorialOverlay />
    </div>
  );
}
