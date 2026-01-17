import { create } from "zustand";
import {
  Connection,
  EdgeChange,
  NodeChange,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  XYPosition,
} from "@xyflow/react";
import {
  WorkflowNode,
  WorkflowEdge,
  NodeType,
  ImageInputNodeData,
  AnnotationNodeData,
  PromptNodeData,
  NanoBananaNodeData,
  GenerateVideoNodeData,
  LLMGenerateNodeData,
  SplitGridNodeData,
  MaskInpaintNodeData,
  ImageFilterNodeData,
  ColorPaletteNodeData,
  LoopNodeData,
  BatchVariationsNodeData,
  ConditionalBranchNodeData,
  WorkflowNodeData,
  ImageHistoryItem,
  NodeGroup,
  GroupColor,
  ProviderType,
  ProviderSettings,
  RecentModel,
} from "@/types";
import { useToast } from "@/components/Toast";
import { calculateGenerationCost } from "@/utils/costCalculator";
import { logger } from "@/utils/logger";
import { externalizeWorkflowImages, hydrateWorkflowImages } from "@/utils/imageStorage";
import { analyzeImage, colorMatches, ImageAnalysisResult } from "@/utils/imageAnalysis";
import {
  loadSaveConfigs,
  saveSaveConfig,
  loadWorkflowCostData,
  saveWorkflowCostData,
  getProviderSettings,
  saveProviderSettings,
  defaultProviderSettings,
  getRecentModels,
  saveRecentModels,
  MAX_RECENT_MODELS,
} from "./utils/localStorage";
import {
  createDefaultNodeData,
  defaultNodeDimensions,
  GROUP_COLORS,
  GROUP_COLOR_ORDER,
} from "./utils/nodeDefaults";
export type EdgeStyle = "angular" | "curved";

// Workflow file format
export interface WorkflowFile {
  version: 1;
  id?: string;  // Optional for backward compatibility with old/shared workflows
  name: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  edgeStyle: EdgeStyle;
  groups?: Record<string, NodeGroup>;  // Optional for backward compatibility
}

// Clipboard data structure for copy/paste
interface ClipboardData {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

// Undo/Redo history snapshot - captures the state that can be undone/redone
interface HistorySnapshot {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  groups: Record<string, NodeGroup>;
}

// Maximum number of undo/redo steps to keep in history
const MAX_HISTORY_SIZE = 50;

interface WorkflowStore {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  edgeStyle: EdgeStyle;
  clipboard: ClipboardData | null;
  groups: Record<string, NodeGroup>;

  // Settings
  setEdgeStyle: (style: EdgeStyle) => void;

  // Node operations
  addNode: (type: NodeType, position: XYPosition, initialData?: Partial<WorkflowNodeData>) => string;
  updateNodeData: (nodeId: string, data: Partial<WorkflowNodeData>) => void;
  removeNode: (nodeId: string) => void;
  onNodesChange: (changes: NodeChange<WorkflowNode>[]) => void;

  // Edge operations
  onEdgesChange: (changes: EdgeChange<WorkflowEdge>[]) => void;
  onConnect: (connection: Connection) => void;
  addEdgeWithType: (connection: Connection, edgeType: string) => void;
  removeEdge: (edgeId: string) => void;
  toggleEdgePause: (edgeId: string) => void;

  // Copy/Paste operations
  copySelectedNodes: () => void;
  pasteNodes: (offset?: XYPosition) => void;
  clearClipboard: () => void;

  // Group operations
  createGroup: (nodeIds: string[]) => string;
  deleteGroup: (groupId: string) => void;
  addNodesToGroup: (nodeIds: string[], groupId: string) => void;
  removeNodesFromGroup: (nodeIds: string[]) => void;
  updateGroup: (groupId: string, updates: Partial<NodeGroup>) => void;
  toggleGroupLock: (groupId: string) => void;
  moveGroupNodes: (groupId: string, delta: { x: number; y: number }) => void;
  setNodeGroupId: (nodeId: string, groupId: string | undefined) => void;

  // UI State
  openModalCount: number;
  isModalOpen: boolean;
  showQuickstart: boolean;
  incrementModalCount: () => void;
  decrementModalCount: () => void;
  setShowQuickstart: (show: boolean) => void;

  // Execution
  isRunning: boolean;
  currentNodeId: string | null;
  pausedAtNodeId: string | null;
  executeWorkflow: (startFromNodeId?: string) => Promise<void>;
  regenerateNode: (nodeId: string) => Promise<void>;
  stopWorkflow: () => void;

  // Save/Load
  saveWorkflow: (name?: string) => void;
  loadWorkflow: (workflow: WorkflowFile, workflowPath?: string) => Promise<void>;
  clearWorkflow: () => void;

  // Helpers
  getNodeById: (id: string) => WorkflowNode | undefined;
  getConnectedInputs: (nodeId: string) => { images: string[]; text: string | null; dynamicInputs: Record<string, string> };
  validateWorkflow: () => { valid: boolean; errors: string[] };

  // Global Image History
  globalImageHistory: ImageHistoryItem[];
  addToGlobalHistory: (item: Omit<ImageHistoryItem, "id">) => void;
  clearGlobalHistory: () => void;

  // Auto-save state
  workflowId: string | null;
  workflowName: string | null;
  saveDirectoryPath: string | null;
  generationsPath: string | null;
  lastSavedAt: number | null;
  hasUnsavedChanges: boolean;
  autoSaveEnabled: boolean;
  isSaving: boolean;
  useExternalImageStorage: boolean;  // Store images as separate files vs embedded base64

  // Auto-save actions
  setWorkflowMetadata: (id: string, name: string, path: string, generationsPath?: string | null) => void;
  setWorkflowName: (name: string) => void;
  setGenerationsPath: (path: string | null) => void;
  setAutoSaveEnabled: (enabled: boolean) => void;
  setUseExternalImageStorage: (enabled: boolean) => void;
  markAsUnsaved: () => void;
  saveToFile: () => Promise<boolean>;
  initializeAutoSave: () => void;
  cleanupAutoSave: () => void;

  // Cost tracking state
  incurredCost: number;

  // Cost tracking actions
  addIncurredCost: (cost: number) => void;
  resetIncurredCost: () => void;
  loadIncurredCost: (workflowId: string) => void;
  saveIncurredCost: () => void;

  // Provider settings state
  providerSettings: ProviderSettings;

  // Provider settings actions
  updateProviderSettings: (settings: ProviderSettings) => void;
  updateProviderApiKey: (providerId: ProviderType, apiKey: string | null) => void;
  toggleProvider: (providerId: ProviderType, enabled: boolean) => void;

  // Model search dialog state
  modelSearchOpen: boolean;
  modelSearchProvider: ProviderType | null;

  // Model search dialog actions
  setModelSearchOpen: (open: boolean, provider?: ProviderType | null) => void;

  // Recent models state
  recentModels: RecentModel[];

  // Recent models actions
  trackModelUsage: (model: { provider: ProviderType; modelId: string; displayName: string }) => void;

  // Undo/Redo state
  undoStack: HistorySnapshot[];
  redoStack: HistorySnapshot[];
  canUndo: boolean;
  canRedo: boolean;

  // Undo/Redo actions
  undo: () => void;
  redo: () => void;
  pushToUndoStack: () => void;
  clearHistory: () => void;
}

let nodeIdCounter = 0;
let groupIdCounter = 0;
let autoSaveIntervalId: ReturnType<typeof setInterval> | null = null;

// Re-export for backward compatibility
export { generateWorkflowId, saveGenerateImageDefaults, saveNanoBananaDefaults } from "./utils/localStorage";
export { GROUP_COLORS } from "./utils/nodeDefaults";

export const useWorkflowStore = create<WorkflowStore>((set, get) => ({
  nodes: [],
  edges: [],
  edgeStyle: "curved" as EdgeStyle,
  clipboard: null,
  groups: {},
  openModalCount: 0,
  isModalOpen: false,
  showQuickstart: true,
  isRunning: false,
  currentNodeId: null,
  pausedAtNodeId: null,
  globalImageHistory: [],

  // Auto-save initial state
  workflowId: null,
  workflowName: null,
  saveDirectoryPath: null,
  generationsPath: null,
  lastSavedAt: null,
  hasUnsavedChanges: false,
  autoSaveEnabled: true,
  isSaving: false,
  useExternalImageStorage: true,  // Default: store images as separate files

  // Cost tracking initial state
  incurredCost: 0,

  // Provider settings initial state
  providerSettings: getProviderSettings(),

  // Model search dialog initial state
  modelSearchOpen: false,
  modelSearchProvider: null,

  // Recent models initial state
  recentModels: getRecentModels(),

  // Undo/Redo initial state
  undoStack: [],
  redoStack: [],
  canUndo: false,
  canRedo: false,

  setEdgeStyle: (style: EdgeStyle) => {
    set({ edgeStyle: style });
  },

  incrementModalCount: () => {
    set((state) => {
      const newCount = state.openModalCount + 1;
      return { openModalCount: newCount, isModalOpen: newCount > 0 };
    });
  },

  decrementModalCount: () => {
    set((state) => {
      const newCount = Math.max(0, state.openModalCount - 1);
      return { openModalCount: newCount, isModalOpen: newCount > 0 };
    });
  },

  setShowQuickstart: (show: boolean) => {
    set({ showQuickstart: show });
  },

  addNode: (type: NodeType, position: XYPosition, initialData?: Partial<WorkflowNodeData>) => {
    // Push current state to undo stack before making changes
    get().pushToUndoStack();

    const id = `${type}-${++nodeIdCounter}`;

    const { width, height } = defaultNodeDimensions[type];

    // Merge default data with initialData if provided
    const defaultData = createDefaultNodeData(type);
    const nodeData = initialData
      ? ({ ...defaultData, ...initialData } as WorkflowNodeData)
      : defaultData;

    const newNode: WorkflowNode = {
      id,
      type,
      position,
      data: nodeData,
      style: { width, height },
    };

    set((state) => ({
      nodes: [...state.nodes, newNode],
      hasUnsavedChanges: true,
    }));

    return id;
  },

  updateNodeData: (nodeId: string, data: Partial<WorkflowNodeData>) => {
    set((state) => ({
      nodes: state.nodes.map((node) =>
        node.id === nodeId
          ? { ...node, data: { ...node.data, ...data } as WorkflowNodeData }
          : node
      ) as WorkflowNode[],
      hasUnsavedChanges: true,
    }));
  },

  removeNode: (nodeId: string) => {
    // Push current state to undo stack before making changes
    get().pushToUndoStack();

    set((state) => ({
      nodes: state.nodes.filter((node) => node.id !== nodeId),
      edges: state.edges.filter(
        (edge) => edge.source !== nodeId && edge.target !== nodeId
      ),
      hasUnsavedChanges: true,
    }));
  },

  onNodesChange: (changes: NodeChange<WorkflowNode>[]) => {
    // Only mark as unsaved for meaningful changes (not selection changes)
    const hasMeaningfulChange = changes.some(
      (c) => c.type !== "select" && c.type !== "dimensions"
    );

    // Push to undo stack before node removal (destructive change)
    const hasNodeRemoval = changes.some((c) => c.type === "remove");
    if (hasNodeRemoval) {
      get().pushToUndoStack();
    }

    set((state) => ({
      nodes: applyNodeChanges(changes, state.nodes),
      ...(hasMeaningfulChange ? { hasUnsavedChanges: true } : {}),
    }));
  },

  onEdgesChange: (changes: EdgeChange<WorkflowEdge>[]) => {
    // Only mark as unsaved for meaningful changes (not selection changes)
    const hasMeaningfulChange = changes.some((c) => c.type !== "select");

    // Push to undo stack before edge removal (destructive change)
    const hasEdgeRemoval = changes.some((c) => c.type === "remove");
    if (hasEdgeRemoval) {
      get().pushToUndoStack();
    }

    set((state) => ({
      edges: applyEdgeChanges(changes, state.edges),
      ...(hasMeaningfulChange ? { hasUnsavedChanges: true } : {}),
    }));
  },

  onConnect: (connection: Connection) => {
    // Push current state to undo stack before making changes
    get().pushToUndoStack();

    set((state) => ({
      edges: addEdge(
        {
          ...connection,
          id: `edge-${connection.source}-${connection.target}-${connection.sourceHandle || "default"}-${connection.targetHandle || "default"}`,
        },
        state.edges
      ),
      hasUnsavedChanges: true,
    }));
  },

  addEdgeWithType: (connection: Connection, edgeType: string) => {
    // Push current state to undo stack before making changes
    get().pushToUndoStack();

    set((state) => ({
      edges: addEdge(
        {
          ...connection,
          id: `edge-${connection.source}-${connection.target}-${connection.sourceHandle || "default"}-${connection.targetHandle || "default"}`,
          type: edgeType,
        },
        state.edges
      ),
      hasUnsavedChanges: true,
    }));
  },

  removeEdge: (edgeId: string) => {
    // Push current state to undo stack before making changes
    get().pushToUndoStack();

    set((state) => ({
      edges: state.edges.filter((edge) => edge.id !== edgeId),
      hasUnsavedChanges: true,
    }));
  },

  toggleEdgePause: (edgeId: string) => {
    // Push current state to undo stack before making changes
    get().pushToUndoStack();
    set((state) => ({
      edges: state.edges.map((edge) =>
        edge.id === edgeId
          ? { ...edge, data: { ...edge.data, hasPause: !edge.data?.hasPause } }
          : edge
      ),
      hasUnsavedChanges: true,
    }));
  },

  copySelectedNodes: () => {
    const { nodes, edges } = get();
    const selectedNodes = nodes.filter((node) => node.selected);

    if (selectedNodes.length === 0) return;

    const selectedNodeIds = new Set(selectedNodes.map((n) => n.id));

    // Copy edges that connect selected nodes to each other
    const connectedEdges = edges.filter(
      (edge) => selectedNodeIds.has(edge.source) && selectedNodeIds.has(edge.target)
    );

    // Deep clone the nodes and edges to avoid reference issues
    const clonedNodes = JSON.parse(JSON.stringify(selectedNodes)) as WorkflowNode[];
    const clonedEdges = JSON.parse(JSON.stringify(connectedEdges)) as WorkflowEdge[];

    set({ clipboard: { nodes: clonedNodes, edges: clonedEdges } });
  },

  pasteNodes: (offset: XYPosition = { x: 50, y: 50 }) => {
    const { clipboard, nodes, edges } = get();

    if (!clipboard || clipboard.nodes.length === 0) return;

    // Push current state to undo stack before making changes
    get().pushToUndoStack();

    // Create a mapping from old node IDs to new node IDs
    const idMapping = new Map<string, string>();

    // Generate new IDs for all pasted nodes
    clipboard.nodes.forEach((node) => {
      const newId = `${node.type}-${++nodeIdCounter}`;
      idMapping.set(node.id, newId);
    });

    // Create new nodes with updated IDs and offset positions
    const newNodes: WorkflowNode[] = clipboard.nodes.map((node) => ({
      ...node,
      id: idMapping.get(node.id)!,
      position: {
        x: node.position.x + offset.x,
        y: node.position.y + offset.y,
      },
      selected: true, // Select newly pasted nodes
      data: { ...node.data }, // Deep copy data
    }));

    // Create new edges with updated source/target IDs
    const newEdges: WorkflowEdge[] = clipboard.edges.map((edge) => ({
      ...edge,
      id: `edge-${idMapping.get(edge.source)}-${idMapping.get(edge.target)}-${edge.sourceHandle || "default"}-${edge.targetHandle || "default"}`,
      source: idMapping.get(edge.source)!,
      target: idMapping.get(edge.target)!,
    }));

    // Deselect existing nodes and add new ones
    const updatedNodes = nodes.map((node) => ({
      ...node,
      selected: false,
    }));

    set({
      nodes: [...updatedNodes, ...newNodes] as WorkflowNode[],
      edges: [...edges, ...newEdges],
      hasUnsavedChanges: true,
    });
  },

  clearClipboard: () => {
    set({ clipboard: null });
  },

  // Group operations
  createGroup: (nodeIds: string[]) => {
    const { nodes, groups } = get();

    if (nodeIds.length === 0) return "";

    // Push current state to undo stack before making changes
    get().pushToUndoStack();

    // Get the nodes to group
    const nodesToGroup = nodes.filter((n) => nodeIds.includes(n.id));
    if (nodesToGroup.length === 0) return "";

    // Calculate bounding box of selected nodes
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodesToGroup.forEach((node) => {
      // Use measured dimensions (actual rendered size) first, then style, then type-specific defaults
      const defaults = defaultNodeDimensions[node.type as NodeType] || { width: 300, height: 280 };
      const width = node.measured?.width || (node.style?.width as number) || defaults.width;
      const height = node.measured?.height || (node.style?.height as number) || defaults.height;

      minX = Math.min(minX, node.position.x);
      minY = Math.min(minY, node.position.y);
      maxX = Math.max(maxX, node.position.x + width);
      maxY = Math.max(maxY, node.position.y + height);
    });

    // Add padding around nodes
    const padding = 20;
    const headerHeight = 32; // Match HEADER_HEIGHT in GroupsOverlay

    // Find next available color
    const usedColors = new Set(Object.values(groups).map((g) => g.color));
    let color: GroupColor = "neutral";
    for (const c of GROUP_COLOR_ORDER) {
      if (!usedColors.has(c)) {
        color = c;
        break;
      }
    }

    // Generate ID and name
    const id = `group-${++groupIdCounter}`;
    const groupNumber = Object.keys(groups).length + 1;
    const name = `Group ${groupNumber}`;

    const newGroup: NodeGroup = {
      id,
      name,
      color,
      position: {
        x: minX - padding,
        y: minY - padding - headerHeight
      },
      size: {
        width: maxX - minX + padding * 2,
        height: maxY - minY + padding * 2 + headerHeight,
      },
    };

    // Update nodes with groupId and add group
    set((state) => ({
      nodes: state.nodes.map((node) =>
        nodeIds.includes(node.id) ? { ...node, groupId: id } : node
      ) as WorkflowNode[],
      groups: { ...state.groups, [id]: newGroup },
      hasUnsavedChanges: true,
    }));

    return id;
  },

  deleteGroup: (groupId: string) => {
    // Push current state to undo stack before making changes
    get().pushToUndoStack();

    set((state) => {
      const { [groupId]: _, ...remainingGroups } = state.groups;
      return {
        nodes: state.nodes.map((node) =>
          node.groupId === groupId ? { ...node, groupId: undefined } : node
        ) as WorkflowNode[],
        groups: remainingGroups,
        hasUnsavedChanges: true,
      };
    });
  },

  addNodesToGroup: (nodeIds: string[], groupId: string) => {
    // Push current state to undo stack before making changes
    get().pushToUndoStack();
    set((state) => ({
      nodes: state.nodes.map((node) =>
        nodeIds.includes(node.id) ? { ...node, groupId } : node
      ) as WorkflowNode[],
      hasUnsavedChanges: true,
    }));
  },

  removeNodesFromGroup: (nodeIds: string[]) => {
    // Push current state to undo stack before making changes
    get().pushToUndoStack();
    set((state) => ({
      nodes: state.nodes.map((node) =>
        nodeIds.includes(node.id) ? { ...node, groupId: undefined } : node
      ) as WorkflowNode[],
      hasUnsavedChanges: true,
    }));
  },

  updateGroup: (groupId: string, updates: Partial<NodeGroup>) => {
    set((state) => ({
      groups: {
        ...state.groups,
        [groupId]: { ...state.groups[groupId], ...updates },
      },
      hasUnsavedChanges: true,
    }));
  },

  toggleGroupLock: (groupId: string) => {
    // Push current state to undo stack before making changes
    get().pushToUndoStack();
    set((state) => ({
      groups: {
        ...state.groups,
        [groupId]: {
          ...state.groups[groupId],
          locked: !state.groups[groupId].locked,
        },
      },
      hasUnsavedChanges: true,
    }));
  },

  moveGroupNodes: (groupId: string, delta: { x: number; y: number }) => {
    set((state) => ({
      nodes: state.nodes.map((node) =>
        node.groupId === groupId
          ? {
              ...node,
              position: {
                x: node.position.x + delta.x,
                y: node.position.y + delta.y,
              },
            }
          : node
      ) as WorkflowNode[],
      hasUnsavedChanges: true,
    }));
  },

  setNodeGroupId: (nodeId: string, groupId: string | undefined) => {
    set((state) => ({
      nodes: state.nodes.map((node) =>
        node.id === nodeId ? { ...node, groupId } : node
      ) as WorkflowNode[],
      hasUnsavedChanges: true,
    }));
  },

  getNodeById: (id: string) => {
    return get().nodes.find((node) => node.id === id);
  },

  getConnectedInputs: (nodeId: string) => {
    const { edges, nodes } = get();
    const images: string[] = [];
    let text: string | null = null;
    const dynamicInputs: Record<string, string> = {};

    // Get the target node to check for inputSchema
    const targetNode = nodes.find((n) => n.id === nodeId);
    const inputSchema = (targetNode?.data as { inputSchema?: Array<{ name: string; type: string }> })?.inputSchema;

    // Build mapping from normalized handle IDs to schema names if schema exists
    // Handles use normalized IDs ("image", "image-0", "text", "text-0")
    // but API needs schema names ("image_url", "first_frame", "prompt", etc.)
    const handleToSchemaName: Record<string, string> = {};
    if (inputSchema && inputSchema.length > 0) {
      const imageInputs = inputSchema.filter(i => i.type === "image");
      const textInputs = inputSchema.filter(i => i.type === "text");

      // Map image handles to schema names
      // Always use indexed IDs (image-0, image-1) to match node component
      // Also map legacy ID ("image") for first input for backward compatibility
      imageInputs.forEach((input, index) => {
        handleToSchemaName[`image-${index}`] = input.name;
        if (index === 0) {
          handleToSchemaName["image"] = input.name;
        }
      });

      // Map text handles to schema names
      // Always use indexed IDs (text-0, text-1) to match node component
      // Also map legacy ID ("text") for first input for backward compatibility
      textInputs.forEach((input, index) => {
        handleToSchemaName[`text-${index}`] = input.name;
        if (index === 0) {
          handleToSchemaName["text"] = input.name;
        }
      });
    }

    // Helper to determine if a handle ID is an image type
    const isImageHandle = (handleId: string | null | undefined): boolean => {
      if (!handleId) return false;
      return handleId === "image" || handleId.startsWith("image-") || handleId.includes("frame");
    };

    // Helper to determine if a handle ID is a text type
    const isTextHandle = (handleId: string | null | undefined): boolean => {
      if (!handleId) return false;
      return handleId === "text" || handleId.startsWith("text-") || handleId.includes("prompt");
    };

    // Helper to extract output from source node
    // Note: For conditional branch nodes, we need the sourceHandle to determine which output (true/false)
    const getSourceOutput = (sourceNode: WorkflowNode, sourceHandle?: string | null): { type: "image" | "text" | "video"; value: string | null } => {
      if (sourceNode.type === "imageInput") {
        return { type: "image", value: (sourceNode.data as ImageInputNodeData).image };
      } else if (sourceNode.type === "annotation") {
        return { type: "image", value: (sourceNode.data as AnnotationNodeData).outputImage };
      } else if (sourceNode.type === "nanoBanana") {
        return { type: "image", value: (sourceNode.data as NanoBananaNodeData).outputImage };
      } else if (sourceNode.type === "maskInpaint") {
        return { type: "image", value: (sourceNode.data as MaskInpaintNodeData).outputImage };
      } else if (sourceNode.type === "imageFilter") {
        return { type: "image", value: (sourceNode.data as ImageFilterNodeData).outputImage };
      } else if (sourceNode.type === "colorPalette") {
        return { type: "image", value: (sourceNode.data as ColorPaletteNodeData).outputImage };
      } else if (sourceNode.type === "generateVideo") {
        // Return video type - generateVideo and output nodes handle this appropriately
        return { type: "video", value: (sourceNode.data as GenerateVideoNodeData).outputVideo };
      } else if (sourceNode.type === "prompt") {
        return { type: "text", value: (sourceNode.data as PromptNodeData).prompt };
      } else if (sourceNode.type === "llmGenerate") {
        return { type: "text", value: (sourceNode.data as LLMGenerateNodeData).outputText };
      } else if (sourceNode.type === "loop") {
        // Loop node can output image, text, or gallery (multiple images)
        const loopData = sourceNode.data as LoopNodeData;
        return { type: "image", value: loopData.currentImage };
      } else if (sourceNode.type === "batchVariations") {
        return { type: "image", value: (sourceNode.data as BatchVariationsNodeData).outputImage };
      } else if (sourceNode.type === "conditionalBranch") {
        // Conditional branch routes image based on evaluation result
        const branchData = sourceNode.data as ConditionalBranchNodeData;
        const evaluationResult = branchData.lastEvaluationResult;
        // Only return value if connected to the correct output handle
        // image-true outputs when result is true, image-false when result is false
        if (sourceHandle === "image-true" && evaluationResult === true) {
          return { type: "image", value: branchData.inputImage };
        } else if (sourceHandle === "image-false" && evaluationResult === false) {
          return { type: "image", value: branchData.inputImage };
        }
        // Return null if connected to wrong output for current evaluation
        return { type: "image", value: null };
      }
      return { type: "image", value: null };
    };

    edges
      .filter((edge) => edge.target === nodeId)
      .forEach((edge) => {
        const sourceNode = nodes.find((n) => n.id === edge.source);
        if (!sourceNode) return;

        const handleId = edge.targetHandle;
        const { value } = getSourceOutput(sourceNode, edge.sourceHandle);

        if (!value) return;

        // Map normalized handle ID to schema name for dynamicInputs
        // This allows API to receive schema-specific parameter names
        if (handleId && handleToSchemaName[handleId]) {
          dynamicInputs[handleToSchemaName[handleId]] = value;
        }

        // Also populate legacy arrays for backward compatibility
        if (isImageHandle(handleId) || !handleId) {
          images.push(value);
        } else if (isTextHandle(handleId)) {
          text = value;
        }
      });

    return { images, text, dynamicInputs };
  },

  validateWorkflow: () => {
    const { nodes, edges } = get();
    const errors: string[] = [];

    // Check if there are any nodes
    if (nodes.length === 0) {
      errors.push("Workflow is empty");
      return { valid: false, errors };
    }

    // Check each Nano Banana node has required inputs (text required, image optional)
    nodes
      .filter((n) => n.type === "nanoBanana")
      .forEach((node) => {
        const textConnected = edges.some(
          (e) => e.target === node.id && e.targetHandle === "text"
        );

        if (!textConnected) {
          errors.push(`Generate node "${node.id}" missing text input`);
        }
      });

    // Check annotation nodes have image input (either connected or manually loaded)
    nodes
      .filter((n) => n.type === "annotation")
      .forEach((node) => {
        const imageConnected = edges.some((e) => e.target === node.id);
        const hasManualImage = (node.data as AnnotationNodeData).sourceImage !== null;
        if (!imageConnected && !hasManualImage) {
          errors.push(`Annotation node "${node.id}" missing image input`);
        }
      });

    // Check output nodes have image input
    nodes
      .filter((n) => n.type === "output")
      .forEach((node) => {
        const imageConnected = edges.some((e) => e.target === node.id);
        if (!imageConnected) {
          errors.push(`Output node "${node.id}" missing image input`);
        }
      });

    return { valid: errors.length === 0, errors };
  },

  executeWorkflow: async (startFromNodeId?: string) => {
    const { nodes, edges, groups, updateNodeData, getConnectedInputs, isRunning } = get();

    if (isRunning) {
      logger.warn('workflow.start', 'Workflow already running, ignoring execution request');
      return;
    }

    // Start logging session
    await logger.startSession();

    const isResuming = startFromNodeId === get().pausedAtNodeId;
    set({ isRunning: true, pausedAtNodeId: null });

    logger.info('workflow.start', 'Workflow execution started', {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      startFromNodeId,
      isResuming,
    });

    // Topological sort
    const sorted: WorkflowNode[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (nodeId: string) => {
      if (visited.has(nodeId)) return;
      if (visiting.has(nodeId)) {
        logger.error('workflow.validation', 'Cycle detected in workflow', { nodeId });
        throw new Error("Cycle detected in workflow");
      }

      visiting.add(nodeId);

      // Visit all nodes that this node depends on
      edges
        .filter((e) => e.target === nodeId)
        .forEach((e) => visit(e.source));

      visiting.delete(nodeId);
      visited.add(nodeId);

      const node = nodes.find((n) => n.id === nodeId);
      if (node) sorted.push(node);
    };

    try {
      nodes.forEach((node) => visit(node.id));

      // If starting from a specific node, find its index and skip earlier nodes
      let startIndex = 0;
      if (startFromNodeId) {
        const nodeIndex = sorted.findIndex((n) => n.id === startFromNodeId);
        if (nodeIndex !== -1) {
          startIndex = nodeIndex;
        }
      }

      // Execute nodes in order, starting from startIndex
      for (let i = startIndex; i < sorted.length; i++) {
        const node = sorted[i];
        if (!get().isRunning) break;

        // Check for pause edges on incoming connections (skip if resuming from this exact node)
        const isResumingThisNode = isResuming && node.id === startFromNodeId;
        if (!isResumingThisNode) {
          const incomingEdges = edges.filter((e) => e.target === node.id);
          const pauseEdge = incomingEdges.find((e) => e.data?.hasPause);
          if (pauseEdge) {
            logger.info('workflow.end', 'Workflow paused at node', {
              nodeId: node.id,
              nodeType: node.type,
            });
            set({ pausedAtNodeId: node.id, isRunning: false, currentNodeId: null });
            useToast.getState().show("Workflow paused - click Run to continue", "warning");

            // Save logs to server (on pause)
            const session = logger.getCurrentSession();
            if (session) {
              session.endTime = new Date().toISOString();
              fetch('/api/logs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session }),
              }).catch((err) => {
                console.error('Failed to save log session:', err);
              });
            }

            await logger.endSession();
            return;
          }
        }

        // Check if node is in a locked group - if so, skip execution
        const nodeGroup = node.groupId ? groups[node.groupId] : null;
        if (nodeGroup?.locked) {
          logger.info('node.execution', `Skipping node in locked group`, {
            nodeId: node.id,
            nodeType: node.type,
            groupId: node.groupId,
            groupName: nodeGroup.name,
          });
          continue; // Skip to next node
        }

        set({ currentNodeId: node.id });

        logger.info('node.execution', `Executing ${node.type} node`, {
          nodeId: node.id,
          nodeType: node.type,
        });

        switch (node.type) {
          case "imageInput":
            // Nothing to execute, data is already set
            break;

          case "annotation": {
            // Get connected image and set as source (use first image)
            const { images } = getConnectedInputs(node.id);
            const image = images[0] || null;
            if (image) {
              updateNodeData(node.id, { sourceImage: image });
              // If no annotations, pass through the image
              const nodeData = node.data as AnnotationNodeData;
              if (!nodeData.outputImage) {
                updateNodeData(node.id, { outputImage: image });
              }
            }
            break;
          }

          case "prompt":
            // Nothing to execute, data is already set
            break;

          case "nanoBanana": {
            const { images, text, dynamicInputs } = getConnectedInputs(node.id);

            // For dynamic inputs, check if we have at least a prompt
            const promptText = text || dynamicInputs.prompt || null;
            if (!promptText) {
              logger.error('node.error', 'nanoBanana node missing text input', {
                nodeId: node.id,
              });
              updateNodeData(node.id, {
                status: "error",
                error: "Missing text input",
              });
              set({ isRunning: false, currentNodeId: null });
              await logger.endSession();
              return;
            }

            updateNodeData(node.id, {
              inputImages: images,
              inputPrompt: promptText,
              status: "loading",
              error: null,
            });

            try {
              // Get fresh node data from store (not stale data from sorted array)
              const freshNode = get().nodes.find((n) => n.id === node.id);
              const nodeData = (freshNode?.data || node.data) as NanoBananaNodeData;
              const providerSettingsState = get().providerSettings;

              const requestPayload = {
                images,
                prompt: promptText,
                aspectRatio: nodeData.aspectRatio,
                resolution: nodeData.resolution,
                model: nodeData.model,
                useGoogleSearch: nodeData.useGoogleSearch,
                selectedModel: nodeData.selectedModel,
                parameters: nodeData.parameters,
                dynamicInputs,  // Pass dynamic inputs for schema-mapped connections
              };

              // Build headers with API keys for providers
              const headers: Record<string, string> = {
                "Content-Type": "application/json",
              };
              const provider = nodeData.selectedModel?.provider || "gemini";
              if (provider === "gemini") {
                const geminiConfig = providerSettingsState.providers.gemini;
                if (geminiConfig?.apiKey) {
                  headers["X-Gemini-API-Key"] = geminiConfig.apiKey;
                }
              } else if (provider === "replicate") {
                const replicateConfig = providerSettingsState.providers.replicate;
                if (replicateConfig?.apiKey) {
                  headers["X-Replicate-API-Key"] = replicateConfig.apiKey;
                }
              } else if (provider === "fal") {
                const falConfig = providerSettingsState.providers.fal;
                if (falConfig?.apiKey) {
                  headers["X-Fal-API-Key"] = falConfig.apiKey;
                }
              }

              logger.info('node.execution', `Calling ${provider} API for image generation`, {
                nodeId: node.id,
                provider,
                model: nodeData.selectedModel?.modelId || nodeData.model,
                aspectRatio: nodeData.aspectRatio,
                resolution: nodeData.resolution,
                imageCount: images.length,
                prompt: promptText,
              });

              const response = await fetch("/api/generate", {
                method: "POST",
                headers,
                body: JSON.stringify(requestPayload),
              });

              if (!response.ok) {
                const errorText = await response.text();
                let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
                try {
                  const errorJson = JSON.parse(errorText);
                  errorMessage = errorJson.error || errorMessage;
                } catch {
                  if (errorText) errorMessage += ` - ${errorText.substring(0, 200)}`;
                }

                logger.error('api.error', `${provider} API request failed`, {
                  nodeId: node.id,
                  provider,
                  status: response.status,
                  statusText: response.statusText,
                  errorMessage,
                });

                updateNodeData(node.id, {
                  status: "error",
                  error: errorMessage,
                });
                set({ isRunning: false, currentNodeId: null });
                await logger.endSession();
                return;
              }

              const result = await response.json();

              if (result.success && result.image) {
                const timestamp = Date.now();
                const imageId = `${timestamp}`;

                // Save the newly generated image to global history
                get().addToGlobalHistory({
                  image: result.image,
                  timestamp,
                  prompt: promptText,
                  aspectRatio: nodeData.aspectRatio,
                  model: nodeData.model,
                });

                // Add to node's carousel history
                const newHistoryItem = {
                  id: imageId,
                  timestamp,
                  prompt: promptText,
                  aspectRatio: nodeData.aspectRatio,
                  model: nodeData.model,
                };
                const updatedHistory = [newHistoryItem, ...(nodeData.imageHistory || [])];

                updateNodeData(node.id, {
                  outputImage: result.image,
                  status: "complete",
                  error: null,
                  imageHistory: updatedHistory,
                  selectedHistoryIndex: 0,
                });

                // Track cost
                const generationCost = calculateGenerationCost(nodeData.model, nodeData.resolution);
                get().addIncurredCost(generationCost);

                // Auto-save to generations folder if configured
                const genPath = get().generationsPath;
                if (genPath) {
                  fetch("/api/save-generation", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      directoryPath: genPath,
                      image: result.image,
                      prompt: text,
                      imageId,
                    }),
                  }).catch((err) => {
                    console.error("Failed to save generation:", err);
                  });
                }
              } else {
                logger.error('api.error', `${provider} API generation failed`, {
                  nodeId: node.id,
                  provider,
                  error: result.error,
                });
                updateNodeData(node.id, {
                  status: "error",
                  error: result.error || "Generation failed",
                });
                set({ isRunning: false, currentNodeId: null });
                await logger.endSession();
                return;
              }
            } catch (error) {
              let errorMessage = "Generation failed";
              if (error instanceof DOMException && error.name === 'AbortError') {
                errorMessage = "Request timed out. Try reducing image sizes or using a simpler prompt.";
              } else if (error instanceof TypeError && error.message.includes('NetworkError')) {
                errorMessage = "Network error. Check your connection and try again.";
              } else if (error instanceof TypeError) {
                errorMessage = `Network error: ${error.message}`;
              } else if (error instanceof Error) {
                errorMessage = error.message;
              }

              const nodeData = node.data as NanoBananaNodeData;
              const errorProvider = nodeData.selectedModel?.provider || "gemini";
              logger.error('node.error', 'Generate node execution failed', {
                nodeId: node.id,
                provider: errorProvider,
                errorMessage,
              }, error instanceof Error ? error : undefined);

              updateNodeData(node.id, {
                status: "error",
                error: errorMessage,
              });
              set({ isRunning: false, currentNodeId: null });
              await logger.endSession();
              return;
            }
            break;
          }

          case "generateVideo": {
            const { images, text, dynamicInputs } = getConnectedInputs(node.id);

            // For dynamic inputs, check if we have at least a prompt
            const hasPrompt = text || dynamicInputs.prompt || dynamicInputs.negative_prompt;
            if (!hasPrompt && images.length === 0) {
              logger.error('node.error', 'generateVideo node missing inputs', {
                nodeId: node.id,
              });
              updateNodeData(node.id, {
                status: "error",
                error: "Missing required inputs",
              });
              set({ isRunning: false, currentNodeId: null });
              await logger.endSession();
              return;
            }

            // Get fresh node data from store (not stale data from sorted array)
            const freshVideoNode = get().nodes.find((n) => n.id === node.id);
            const nodeData = (freshVideoNode?.data || node.data) as GenerateVideoNodeData;

            if (!nodeData.selectedModel?.modelId) {
              logger.error('node.error', 'generateVideo node missing model selection', {
                nodeId: node.id,
              });
              updateNodeData(node.id, {
                status: "error",
                error: "No model selected",
              });
              set({ isRunning: false, currentNodeId: null });
              await logger.endSession();
              return;
            }

            updateNodeData(node.id, {
              inputImages: images,
              inputPrompt: text,
              status: "loading",
              error: null,
            });

            try {
              const providerSettingsState = get().providerSettings;

              const requestPayload = {
                images,
                prompt: text,
                selectedModel: nodeData.selectedModel,
                parameters: nodeData.parameters,
                dynamicInputs,  // Pass dynamic inputs for schema-mapped connections
                mediaType: "video" as const,  // Signal to API to use queue for long-running video generation
              };

              // Build headers with API keys for providers
              const headers: Record<string, string> = {
                "Content-Type": "application/json",
              };
              const provider = nodeData.selectedModel.provider;
              if (provider === "gemini") {
                const geminiConfig = providerSettingsState.providers.gemini;
                if (geminiConfig?.apiKey) {
                  headers["X-Gemini-API-Key"] = geminiConfig.apiKey;
                }
              } else if (provider === "replicate") {
                const replicateConfig = providerSettingsState.providers.replicate;
                if (replicateConfig?.apiKey) {
                  headers["X-Replicate-API-Key"] = replicateConfig.apiKey;
                }
              } else if (provider === "fal") {
                const falConfig = providerSettingsState.providers.fal;
                if (falConfig?.apiKey) {
                  headers["X-Fal-API-Key"] = falConfig.apiKey;
                }
              }
              logger.info('node.execution', `Calling ${provider} API for video generation`, {
                nodeId: node.id,
                provider,
                model: nodeData.selectedModel.modelId,
                imageCount: images.length,
                prompt: text,
              });

              const response = await fetch("/api/generate", {
                method: "POST",
                headers,
                body: JSON.stringify(requestPayload),
              });

              if (!response.ok) {
                const errorText = await response.text();
                let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
                try {
                  const errorJson = JSON.parse(errorText);
                  errorMessage = errorJson.error || errorMessage;
                } catch {
                  if (errorText) errorMessage += ` - ${errorText.substring(0, 200)}`;
                }

                logger.error('api.error', `${provider} API request failed`, {
                  nodeId: node.id,
                  provider,
                  status: response.status,
                  statusText: response.statusText,
                  errorMessage,
                });

                updateNodeData(node.id, {
                  status: "error",
                  error: errorMessage,
                });
                set({ isRunning: false, currentNodeId: null });
                await logger.endSession();
                return;
              }

              const result = await response.json();

              // Handle video response (video or videoUrl field)
              const videoData = result.video || result.videoUrl;
              if (result.success && videoData) {
                const timestamp = Date.now();
                const videoId = `${timestamp}`;

                // Add to node's video history
                const newHistoryItem = {
                  id: videoId,
                  timestamp,
                  prompt: text || '',
                  model: nodeData.selectedModel?.modelId || '',
                };
                const updatedHistory = [newHistoryItem, ...(nodeData.videoHistory || [])].slice(0, 50);

                updateNodeData(node.id, {
                  outputVideo: videoData,
                  status: "complete",
                  error: null,
                  videoHistory: updatedHistory,
                  selectedVideoHistoryIndex: 0,
                });

                // Auto-save video to generations folder if configured
                const genPath = get().generationsPath;
                if (genPath) {
                  fetch("/api/save-generation", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      directoryPath: genPath,
                      video: videoData,
                      prompt: text,
                      imageId: videoId,
                    }),
                  }).catch((err) => {
                    console.error("Failed to save video generation:", err);
                  });
                }
              } else if (result.success && result.image) {
                // Some models might return an image preview; treat as video for now
                const timestamp = Date.now();
                const videoId = `${timestamp}`;

                // Add to node's video history
                const newHistoryItem = {
                  id: videoId,
                  timestamp,
                  prompt: text || '',
                  model: nodeData.selectedModel?.modelId || '',
                };
                const updatedHistory = [newHistoryItem, ...(nodeData.videoHistory || [])].slice(0, 50);

                updateNodeData(node.id, {
                  outputVideo: result.image,
                  status: "complete",
                  error: null,
                  videoHistory: updatedHistory,
                  selectedVideoHistoryIndex: 0,
                });

                // Auto-save image preview to generations folder if configured
                const genPath = get().generationsPath;
                if (genPath) {
                  fetch("/api/save-generation", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      directoryPath: genPath,
                      image: result.image,
                      prompt: text,
                      imageId: videoId,
                    }),
                  }).catch((err) => {
                    console.error("Failed to save video generation:", err);
                  });
                }
              } else {
                logger.error('api.error', `${provider} API video generation failed`, {
                  nodeId: node.id,
                  provider,
                  error: result.error,
                });
                updateNodeData(node.id, {
                  status: "error",
                  error: result.error || "Video generation failed",
                });
                set({ isRunning: false, currentNodeId: null });
                await logger.endSession();
                return;
              }
            } catch (error) {
              let errorMessage = "Video generation failed";
              if (error instanceof DOMException && error.name === 'AbortError') {
                errorMessage = "Request timed out. Video generation may take longer.";
              } else if (error instanceof TypeError && error.message.includes('NetworkError')) {
                errorMessage = "Network error. Check your connection and try again.";
              } else if (error instanceof TypeError) {
                errorMessage = `Network error: ${error.message}`;
              } else if (error instanceof Error) {
                errorMessage = error.message;
              }

              logger.error('node.error', 'GenerateVideo node execution failed', {
                nodeId: node.id,
                provider: nodeData.selectedModel?.provider,
                errorMessage,
              }, error instanceof Error ? error : undefined);

              updateNodeData(node.id, {
                status: "error",
                error: errorMessage,
              });
              set({ isRunning: false, currentNodeId: null });
              await logger.endSession();
              return;
            }
            break;
          }

          case "llmGenerate": {
            const { images, text } = getConnectedInputs(node.id);

            if (!text) {
              logger.error('node.error', 'llmGenerate node missing text input', {
                nodeId: node.id,
              });
              updateNodeData(node.id, {
                status: "error",
                error: "Missing text input",
              });
              set({ isRunning: false, currentNodeId: null });
              await logger.endSession();
              return;
            }

            updateNodeData(node.id, {
              inputPrompt: text,
              inputImages: images,
              status: "loading",
              error: null,
            });

            try {
              const nodeData = node.data as LLMGenerateNodeData;
              const providerSettingsState = get().providerSettings;

              // Build headers with API keys for LLM providers
              const headers: Record<string, string> = {
                "Content-Type": "application/json",
              };
              if (nodeData.provider === "google") {
                const geminiConfig = providerSettingsState.providers.gemini;
                if (geminiConfig?.apiKey) {
                  headers["X-Gemini-API-Key"] = geminiConfig.apiKey;
                }
              } else if (nodeData.provider === "openai") {
                const openaiConfig = providerSettingsState.providers.openai;
                if (openaiConfig?.apiKey) {
                  headers["X-OpenAI-API-Key"] = openaiConfig.apiKey;
                }
              }

              logger.info('api.llm', 'Calling LLM API', {
                nodeId: node.id,
                provider: nodeData.provider,
                model: nodeData.model,
                temperature: nodeData.temperature,
                maxTokens: nodeData.maxTokens,
                hasImages: images.length > 0,
                prompt: text,
              });

              const response = await fetch("/api/llm", {
                method: "POST",
                headers,
                body: JSON.stringify({
                  prompt: text,
                  ...(images.length > 0 && { images }),
                  provider: nodeData.provider,
                  model: nodeData.model,
                  temperature: nodeData.temperature,
                  maxTokens: nodeData.maxTokens,
                }),
              });

              if (!response.ok) {
                const errorText = await response.text();
                let errorMessage = `HTTP ${response.status}`;
                try {
                  const errorJson = JSON.parse(errorText);
                  errorMessage = errorJson.error || errorMessage;
                } catch {
                  if (errorText) errorMessage += ` - ${errorText.substring(0, 200)}`;
                }
                logger.error('api.error', 'LLM API request failed', {
                  nodeId: node.id,
                  status: response.status,
                  errorMessage,
                });
                updateNodeData(node.id, {
                  status: "error",
                  error: errorMessage,
                });
                set({ isRunning: false, currentNodeId: null });
                await logger.endSession();
                return;
              }

              const result = await response.json();

              if (result.success && result.text) {
                updateNodeData(node.id, {
                  outputText: result.text,
                  status: "complete",
                  error: null,
                });
              } else {
                logger.error('api.error', 'LLM generation failed', {
                  nodeId: node.id,
                  error: result.error,
                });
                updateNodeData(node.id, {
                  status: "error",
                  error: result.error || "LLM generation failed",
                });
                set({ isRunning: false, currentNodeId: null });
                await logger.endSession();
                return;
              }
            } catch (error) {
              logger.error('node.error', 'llmGenerate node execution failed', {
                nodeId: node.id,
              }, error instanceof Error ? error : undefined);
              updateNodeData(node.id, {
                status: "error",
                error: error instanceof Error ? error.message : "LLM generation failed",
              });
              set({ isRunning: false, currentNodeId: null });
              await logger.endSession();
              return;
            }
            break;
          }

          case "splitGrid": {
            const { images } = getConnectedInputs(node.id);
            const sourceImage = images[0] || null;

            if (!sourceImage) {
              updateNodeData(node.id, {
                status: "error",
                error: "No input image connected",
              });
              set({ isRunning: false, currentNodeId: null });
              return;
            }

            const nodeData = node.data as SplitGridNodeData;

            if (!nodeData.isConfigured) {
              updateNodeData(node.id, {
                status: "error",
                error: "Node not configured - open settings first",
              });
              set({ isRunning: false, currentNodeId: null });
              return;
            }

            updateNodeData(node.id, {
              sourceImage,
              status: "loading",
              error: null,
            });

            try {
              // Import and use the grid splitter
              const { splitWithDimensions } = await import("@/utils/gridSplitter");
              const { images: splitImages } = await splitWithDimensions(
                sourceImage,
                nodeData.gridRows,
                nodeData.gridCols
              );

              // Populate child imageInput nodes with split images
              for (let index = 0; index < nodeData.childNodeIds.length; index++) {
                const childSet = nodeData.childNodeIds[index];
                if (splitImages[index]) {
                  // Create a promise to get image dimensions
                  await new Promise<void>((resolve) => {
                    const img = new Image();
                    img.onload = () => {
                      updateNodeData(childSet.imageInput, {
                        image: splitImages[index],
                        filename: `split-${Math.floor(index / nodeData.gridCols) + 1}-${(index % nodeData.gridCols) + 1}.png`,
                        dimensions: { width: img.width, height: img.height },
                      });
                      resolve();
                    };
                    img.onerror = () => resolve();
                    img.src = splitImages[index];
                  });
                }
              }

              updateNodeData(node.id, { status: "complete", error: null });
            } catch (error) {
              logger.error('node.error', 'splitGrid node execution failed', {
                nodeId: node.id,
              }, error instanceof Error ? error : undefined);
              updateNodeData(node.id, {
                status: "error",
                error: error instanceof Error ? error.message : "Failed to split image",
              });
              set({ isRunning: false, currentNodeId: null });
              await logger.endSession();
              return;
            }
            break;
          }

          case "maskInpaint": {
            const { images, text } = getConnectedInputs(node.id);
            const sourceImage = images[0] || null;
            const promptText = text || null;

            // Get node data for mask info
            const nodeData = node.data as MaskInpaintNodeData;

            if (!sourceImage) {
              logger.error('node.error', 'maskInpaint node missing source image', {
                nodeId: node.id,
              });
              updateNodeData(node.id, {
                status: "error",
                error: "No source image connected",
              });
              set({ isRunning: false, currentNodeId: null });
              await logger.endSession();
              return;
            }

            if (!nodeData.maskImage && nodeData.maskStrokes.length === 0) {
              logger.error('node.error', 'maskInpaint node missing mask', {
                nodeId: node.id,
              });
              updateNodeData(node.id, {
                status: "error",
                error: "No mask defined - paint a mask first",
              });
              set({ isRunning: false, currentNodeId: null });
              await logger.endSession();
              return;
            }

            if (!promptText) {
              logger.error('node.error', 'maskInpaint node missing prompt', {
                nodeId: node.id,
              });
              updateNodeData(node.id, {
                status: "error",
                error: "No prompt connected - describe what to generate",
              });
              set({ isRunning: false, currentNodeId: null });
              await logger.endSession();
              return;
            }

            updateNodeData(node.id, {
              sourceImage,
              inputPrompt: promptText,
              status: "loading",
              error: null,
            });

            try {
              const providerSettingsState = get().providerSettings;

              // Build headers with API keys
              const headers: Record<string, string> = {
                "Content-Type": "application/json",
              };
              const geminiConfig = providerSettingsState.providers.gemini;
              if (geminiConfig?.apiKey) {
                headers["X-Gemini-API-Key"] = geminiConfig.apiKey;
              }

              // Build inpainting prompt that instructs model to edit masked area
              // Gemini models support editing with masks via text instructions
              const inpaintPrompt = `Edit this image. In the white/bright areas of the mask image, ${promptText}. Keep all other areas unchanged.`;

              // Send source image and mask to the API
              // The mask is interpreted as: white = edit area, black = preserve
              const imagesToSend = nodeData.maskImage
                ? [sourceImage, nodeData.maskImage]
                : [sourceImage];

              logger.info('api.inpaint', 'Calling inpaint API', {
                nodeId: node.id,
                hasSourceImage: !!sourceImage,
                hasMask: !!nodeData.maskImage,
                maskStrokesCount: nodeData.maskStrokes.length,
                prompt: promptText,
              });

              const response = await fetch("/api/generate", {
                method: "POST",
                headers,
                body: JSON.stringify({
                  images: imagesToSend,
                  prompt: inpaintPrompt,
                  aspectRatio: "1:1", // Preserve aspect ratio for inpainting
                  model: "nano-banana-pro", // Use pro model for better inpainting
                }),
              });

              if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || "API call failed");
              }

              const result = await response.json();

              if (result.image) {
                // Add to node history
                const historyItem = {
                  id: `inpaint-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                  timestamp: Date.now(),
                  prompt: promptText,
                  aspectRatio: "1:1" as const,
                  model: "nano-banana-pro" as const,
                };

                const updatedHistory = [...(nodeData.imageHistory || []), historyItem];

                updateNodeData(node.id, {
                  outputImage: result.image,
                  status: "complete",
                  error: null,
                  imageHistory: updatedHistory,
                  selectedHistoryIndex: updatedHistory.length - 1,
                });

                // Track cost
                if (result.cost) {
                  get().addIncurredCost(result.cost);
                }

                logger.info('node.complete', 'maskInpaint generation successful', {
                  nodeId: node.id,
                  cost: result.cost,
                });
              } else {
                throw new Error("No image in response");
              }
            } catch (error) {
              logger.error('node.error', 'maskInpaint node execution failed', {
                nodeId: node.id,
              }, error instanceof Error ? error : undefined);
              updateNodeData(node.id, {
                status: "error",
                error: error instanceof Error ? error.message : "Inpainting failed",
              });
              set({ isRunning: false, currentNodeId: null });
              await logger.endSession();
              return;
            }
            break;
          }

          case "imageCompare": {
            // Get connected images for comparison by specific handle
            const connectedEdges = edges.filter(e => e.target === node.id);
            let imageAValue: string | null = null;
            let imageBValue: string | null = null;

            connectedEdges.forEach(edge => {
              const sourceNode = nodes.find(n => n.id === edge.source);
              if (!sourceNode) return;

              // Get output value from source node
              let value: string | null = null;
              if (sourceNode.type === "imageInput") {
                value = (sourceNode.data as ImageInputNodeData).image;
              } else if (sourceNode.type === "annotation") {
                value = (sourceNode.data as AnnotationNodeData).outputImage;
              } else if (sourceNode.type === "nanoBanana") {
                value = (sourceNode.data as NanoBananaNodeData).outputImage;
              } else if (sourceNode.type === "maskInpaint") {
                value = (sourceNode.data as MaskInpaintNodeData).outputImage;
              }

              if (value) {
                if (edge.targetHandle === "imageA") {
                  imageAValue = value;
                } else if (edge.targetHandle === "imageB") {
                  imageBValue = value;
                }
              }
            });

            updateNodeData(node.id, {
              imageA: imageAValue,
              imageB: imageBValue,
            });
            break;
          }

          case "colorPalette": {
            const { images } = getConnectedInputs(node.id);
            const sourceImage = images[0] || null;

            if (sourceImage) {
              updateNodeData(node.id, { sourceImage });
            }
            // Color extraction is handled by the node component itself
            // This just ensures the source image is passed through during execution
            break;
          }


          case "imageFilter": {
            // Get connected input image
            const { images } = getConnectedInputs(node.id);
            const sourceImage = images[0] || null;

            if (sourceImage) {
              // Update source image - filter application handled by component
              updateNodeData(node.id, { sourceImage });
            }
            break;
          }

          case "batchVariations": {
            const { images, text } = getConnectedInputs(node.id);

            if (!text) {
              logger.error('node.error', 'batchVariations node missing text input', {
                nodeId: node.id,
              });
              updateNodeData(node.id, {
                status: "error",
                error: "Missing text input (prompt required)",
              });
              set({ isRunning: false, currentNodeId: null });
              await logger.endSession();
              return;
            }

            const freshNode = get().nodes.find((n) => n.id === node.id);
            const nodeData = (freshNode?.data || node.data) as BatchVariationsNodeData;
            const variationCount = nodeData.variationCount;

            updateNodeData(node.id, {
              inputImage: images[0] || null,
              inputPrompt: text,
              status: "loading",
              error: null,
              generationProgress: 0,
              variations: [],
            });

            try {
              const providerSettingsState = get().providerSettings;
              const headers: Record<string, string> = {
                "Content-Type": "application/json",
              };
              const geminiConfig = providerSettingsState.providers.gemini;
              if (geminiConfig?.apiKey) {
                headers["X-Gemini-API-Key"] = geminiConfig.apiKey;
              }

              const variations: Array<{ id: string; image: string; timestamp: number; isFavorite: boolean }> = [];

              for (let i = 0; i < variationCount; i++) {
                const requestPayload = {
                  images: images.length > 0 ? images : [],
                  prompt: text,
                  aspectRatio: nodeData.aspectRatio,
                  resolution: nodeData.resolution,
                  model: nodeData.model,
                  useGoogleSearch: nodeData.useGoogleSearch,
                };

                logger.info('node.execution', `Generating variation ${i + 1}/${variationCount}`, {
                  nodeId: node.id,
                });

                const response = await fetch("/api/generate", {
                  method: "POST",
                  headers,
                  body: JSON.stringify(requestPayload),
                });

                if (!response.ok) {
                  const errorText = await response.text();
                  let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
                  try {
                    const errorJson = JSON.parse(errorText);
                    errorMessage = errorJson.error || errorMessage;
                  } catch {
                    if (errorText) errorMessage += ` - ${errorText.substring(0, 200)}`;
                  }
                  throw new Error(errorMessage);
                }

                const result = await response.json();

                if (result.success && result.image) {
                  variations.push({
                    id: crypto.randomUUID(),
                    image: result.image,
                    timestamp: Date.now(),
                    isFavorite: false,
                  });

                  // Update progress
                  const progress = Math.round(((i + 1) / variationCount) * 100);
                  updateNodeData(node.id, {
                    variations: [...variations],
                    generationProgress: progress,
                    outputImage: variations[0]?.image || null,
                  });
                } else {
                  throw new Error(result.error || `Variation ${i + 1} generation failed`);
                }
              }

              // Final update with all variations complete
              updateNodeData(node.id, {
                status: "complete",
                error: null,
                selectedVariationIndex: 0,
                outputImage: variations[0]?.image || null,
              });

              logger.info('node.execution', `Generated ${variations.length} variations successfully`, {
                nodeId: node.id,
              });
            } catch (error) {
              let errorMessage = "Batch variations generation failed";
              if (error instanceof Error) {
                errorMessage = error.message;
              }

              logger.error('node.error', 'BatchVariations node execution failed', {
                nodeId: node.id,
                errorMessage,
              }, error instanceof Error ? error : undefined);

              updateNodeData(node.id, {
                status: "error",
                error: errorMessage,
              });
              set({ isRunning: false, currentNodeId: null });
              await logger.endSession();
              return;
            }
            break;
          }

          case "conditionalBranch": {
            const { images } = getConnectedInputs(node.id);
            const inputImage = images[0] || null;

            if (!inputImage) {
              logger.error('node.error', 'conditionalBranch node missing image input', {
                nodeId: node.id,
              });
              updateNodeData(node.id, {
                status: "error",
                error: "Missing image input",
                lastEvaluationResult: null,
              });
              break;
            }

            updateNodeData(node.id, {
              inputImage,
              status: "loading",
              error: null,
            });

            try {
              // Analyze the image
              const analysisResults = await analyzeImage(inputImage);

              const freshNode = get().nodes.find((n) => n.id === node.id);
              const nodeData = (freshNode?.data || node.data) as ConditionalBranchNodeData;

              // Evaluate condition groups
              const evaluateCondition = (
                property: keyof ImageAnalysisResult,
                operator: string,
                value: string | number | boolean
              ): boolean => {
                const actualValue = analysisResults[property];

                switch (operator) {
                  case "equals":
                    return actualValue === value;
                  case "not_equals":
                    return actualValue !== value;
                  case "greater_than":
                    return typeof actualValue === "number" && actualValue > Number(value);
                  case "less_than":
                    return typeof actualValue === "number" && actualValue < Number(value);
                  case "greater_or_equal":
                    return typeof actualValue === "number" && actualValue >= Number(value);
                  case "less_or_equal":
                    return typeof actualValue === "number" && actualValue <= Number(value);
                  case "contains":
                    if (property === "dominant_color") {
                      return colorMatches(String(actualValue), String(value));
                    }
                    return String(actualValue).includes(String(value));
                  case "not_contains":
                    if (property === "dominant_color") {
                      return !colorMatches(String(actualValue), String(value));
                    }
                    return !String(actualValue).includes(String(value));
                  default:
                    return false;
                }
              };

              // Evaluate a single condition group (AND/OR logic within group)
              const evaluateGroup = (group: typeof nodeData.conditionGroups[0]): boolean => {
                if (group.conditions.length === 0) return true;

                if (group.logic === "AND") {
                  return group.conditions.every((c) =>
                    evaluateCondition(c.property, c.operator, c.value)
                  );
                } else {
                  return group.conditions.some((c) =>
                    evaluateCondition(c.property, c.operator, c.value)
                  );
                }
              };

              // Evaluate all groups with group-level logic
              let result: boolean;
              if (nodeData.conditionGroups.length === 0) {
                result = true;
              } else if (nodeData.groupLogic === "AND") {
                result = nodeData.conditionGroups.every(evaluateGroup);
              } else {
                result = nodeData.conditionGroups.some(evaluateGroup);
              }

              updateNodeData(node.id, {
                status: "complete",
                error: null,
                lastEvaluationResult: result,
                analysisResults,
              });

              logger.info('node.execution', `Conditional branch evaluated to ${result}`, {
                nodeId: node.id,
                result,
                analysisResults,
              });
            } catch (error) {
              let errorMessage = "Image analysis failed";
              if (error instanceof Error) {
                errorMessage = error.message;
              }

              logger.error('node.error', 'conditionalBranch node execution failed', {
                nodeId: node.id,
                errorMessage,
              }, error instanceof Error ? error : undefined);

              updateNodeData(node.id, {
                status: "error",
                error: errorMessage,
                lastEvaluationResult: null,
              });
            }
            break;
          }

          case "output": {
            const { images } = getConnectedInputs(node.id);
            const content = images[0] || null;
            if (content) {
              // Detect if content is video (data URL or URL extension)
              const isVideoContent =
                content.startsWith("data:video/") ||
                content.includes(".mp4") ||
                content.includes(".webm");

              if (isVideoContent) {
                updateNodeData(node.id, {
                  image: content,
                  video: content,
                  contentType: "video"
                });
              } else {
                updateNodeData(node.id, {
                  image: content,
                  video: null,
                  contentType: "image"
                });
              }
            }
            break;
          }
        }
      }

      logger.info('workflow.end', 'Workflow execution completed successfully');
      set({ isRunning: false, currentNodeId: null });

      // Save logs to server
      const session = logger.getCurrentSession();
      if (session) {
        session.endTime = new Date().toISOString();
        fetch('/api/logs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session }),
        }).catch((err) => {
          console.error('Failed to save log session:', err);
        });
      }

      await logger.endSession();
    } catch (error) {
      logger.error('workflow.error', 'Workflow execution failed', {}, error instanceof Error ? error : undefined);
      set({ isRunning: false, currentNodeId: null });

      // Save logs to server (even on error)
      const session = logger.getCurrentSession();
      if (session) {
        session.endTime = new Date().toISOString();
        fetch('/api/logs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session }),
        }).catch((err) => {
          console.error('Failed to save log session:', err);
        });
      }

      await logger.endSession();
    }
  },

  stopWorkflow: () => {
    set({ isRunning: false, currentNodeId: null });
  },

  regenerateNode: async (nodeId: string) => {
    const { nodes, updateNodeData, getConnectedInputs, isRunning } = get();

    if (isRunning) {
      logger.warn('node.execution', 'Cannot regenerate node, workflow already running', { nodeId });
      return;
    }

    const node = nodes.find((n) => n.id === nodeId);
    if (!node) {
      logger.warn('node.error', 'Node not found for regeneration', { nodeId });
      return;
    }

    await logger.startSession();
    logger.info('node.execution', 'Regenerating node', {
      nodeId,
      nodeType: node.type,
    });

    set({ isRunning: true, currentNodeId: nodeId });

    try {
      if (node.type === "nanoBanana") {
        // Get fresh node data from store
        const freshNode = get().nodes.find((n) => n.id === nodeId);
        const nodeData = (freshNode?.data || node.data) as NanoBananaNodeData;
        const providerSettingsState = get().providerSettings;
        const provider = nodeData.selectedModel?.provider || "gemini";

        // Always get fresh connected inputs first, fall back to stored inputs only if not connected
        const { images: connectedImages, text: connectedText, dynamicInputs } = getConnectedInputs(nodeId);
        const images = connectedImages.length > 0 ? connectedImages : nodeData.inputImages;
        const text = connectedText ?? nodeData.inputPrompt;

        if (!text) {
          logger.error('node.error', 'Generate node regeneration failed: missing text input', {
            nodeId,
            provider,
          });
          updateNodeData(nodeId, {
            status: "error",
            error: "Missing text input",
          });
          set({ isRunning: false, currentNodeId: null });
          await logger.endSession();
          return;
        }

        updateNodeData(nodeId, {
          status: "loading",
          error: null,
        });

        // Build headers with API keys for providers
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (provider === "gemini") {
          const geminiConfig = providerSettingsState.providers.gemini;
          if (geminiConfig?.apiKey) {
            headers["X-Gemini-API-Key"] = geminiConfig.apiKey;
          }
        } else if (provider === "replicate") {
          const replicateConfig = providerSettingsState.providers.replicate;
          if (replicateConfig?.apiKey) {
            headers["X-Replicate-API-Key"] = replicateConfig.apiKey;
          }
        } else if (provider === "fal") {
          const falConfig = providerSettingsState.providers.fal;
          if (falConfig?.apiKey) {
            headers["X-Fal-API-Key"] = falConfig.apiKey;
          }
        }

        logger.info('node.execution', `Calling ${provider} API for node regeneration`, {
          nodeId,
          provider,
          model: nodeData.selectedModel?.modelId || nodeData.model,
          aspectRatio: nodeData.aspectRatio,
          resolution: nodeData.resolution,
          imageCount: images.length,
          prompt: text,
        });

        const response = await fetch("/api/generate", {
          method: "POST",
          headers,
          body: JSON.stringify({
            images,
            prompt: text,
            aspectRatio: nodeData.aspectRatio,
            resolution: nodeData.resolution,
            model: nodeData.model,
            useGoogleSearch: nodeData.useGoogleSearch,
            selectedModel: nodeData.selectedModel,
            parameters: nodeData.parameters,
            dynamicInputs,  // Pass dynamic inputs for schema-mapped connections
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          let errorMessage = `HTTP ${response.status}`;
          try {
            const errorJson = JSON.parse(errorText);
            errorMessage = errorJson.error || errorMessage;
          } catch {
            if (errorText) errorMessage += ` - ${errorText.substring(0, 200)}`;
          }
          logger.error('api.error', `${provider} API regeneration failed`, {
            nodeId,
            provider,
            status: response.status,
            errorMessage,
          });
          updateNodeData(nodeId, { status: "error", error: errorMessage });
          set({ isRunning: false, currentNodeId: null });
          await logger.endSession();
          return;
        }

        const result = await response.json();
        if (result.success && result.image) {
          const timestamp = Date.now();
          const imageId = `${timestamp}`;

          // Save the newly generated image to global history
          get().addToGlobalHistory({
            image: result.image,
            timestamp,
            prompt: text,
            aspectRatio: nodeData.aspectRatio,
            model: nodeData.model,
          });

          // Add to node's carousel history
          const newHistoryItem = {
            id: imageId,
            timestamp,
            prompt: text,
            aspectRatio: nodeData.aspectRatio,
            model: nodeData.model,
          };
          const updatedHistory = [newHistoryItem, ...(nodeData.imageHistory || [])];

          updateNodeData(nodeId, {
            outputImage: result.image,
            status: "complete",
            error: null,
            imageHistory: updatedHistory,
            selectedHistoryIndex: 0,
          });

          // Track cost
          const generationCost = calculateGenerationCost(nodeData.model, nodeData.resolution);
          get().addIncurredCost(generationCost);

          // Auto-save to generations folder if configured
          const genPath = get().generationsPath;
          if (genPath) {
            fetch("/api/save-generation", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                directoryPath: genPath,
                image: result.image,
                prompt: text,
                imageId,
              }),
            }).catch((err) => {
              console.error("Failed to save generation:", err);
            });
          }
        } else {
          updateNodeData(nodeId, {
            status: "error",
            error: result.error || "Generation failed",
          });
        }
      } else if (node.type === "llmGenerate") {
        const nodeData = node.data as LLMGenerateNodeData;

        // Always get fresh connected inputs first, fall back to stored inputs only if not connected
        const inputs = getConnectedInputs(nodeId);
        const images = inputs.images.length > 0 ? inputs.images : nodeData.inputImages;
        const text = inputs.text ?? nodeData.inputPrompt;

        if (!text) {
          logger.error('node.error', 'llmGenerate regeneration failed: missing text input', {
            nodeId,
          });
          updateNodeData(nodeId, {
            status: "error",
            error: "Missing text input",
          });
          set({ isRunning: false, currentNodeId: null });
          await logger.endSession();
          return;
        }

        updateNodeData(nodeId, {
          inputImages: images,
          status: "loading",
          error: null,
        });

        const providerSettingsState = get().providerSettings;

        // Build headers with API keys for LLM providers
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (nodeData.provider === "google") {
          const geminiConfig = providerSettingsState.providers.gemini;
          if (geminiConfig?.apiKey) {
            headers["X-Gemini-API-Key"] = geminiConfig.apiKey;
          }
        } else if (nodeData.provider === "openai") {
          const openaiConfig = providerSettingsState.providers.openai;
          if (openaiConfig?.apiKey) {
            headers["X-OpenAI-API-Key"] = openaiConfig.apiKey;
          }
        }

        logger.info('api.llm', 'Calling LLM API for node regeneration', {
          nodeId,
          provider: nodeData.provider,
          model: nodeData.model,
          temperature: nodeData.temperature,
          maxTokens: nodeData.maxTokens,
          hasImages: images.length > 0,
          prompt: text,
        });

        const response = await fetch("/api/llm", {
          method: "POST",
          headers,
          body: JSON.stringify({
            prompt: text,
            ...(images.length > 0 && { images }),
            provider: nodeData.provider,
            model: nodeData.model,
            temperature: nodeData.temperature,
            maxTokens: nodeData.maxTokens,
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          let errorMessage = `HTTP ${response.status}`;
          try {
            const errorJson = JSON.parse(errorText);
            errorMessage = errorJson.error || errorMessage;
          } catch {
            if (errorText) errorMessage += ` - ${errorText.substring(0, 200)}`;
          }
          logger.error('api.error', 'LLM API regeneration failed', {
            nodeId,
            status: response.status,
            errorMessage,
          });
          updateNodeData(nodeId, { status: "error", error: errorMessage });
          set({ isRunning: false, currentNodeId: null });
          await logger.endSession();
          return;
        }

        const result = await response.json();
        if (result.success && result.text) {
          updateNodeData(nodeId, {
            outputText: result.text,
            status: "complete",
            error: null,
          });
        } else {
          logger.error('api.error', 'LLM regeneration failed', {
            nodeId,
            error: result.error,
          });
          updateNodeData(nodeId, {
            status: "error",
            error: result.error || "LLM generation failed",
          });
        }
      } else if (node.type === "generateVideo") {
        // Get fresh node data from store
        const freshVideoNode = get().nodes.find((n) => n.id === nodeId);
        const nodeData = (freshVideoNode?.data || node.data) as GenerateVideoNodeData;
        const providerSettingsState = get().providerSettings;

        // Get fresh connected inputs
        const { images: connectedImages, text: connectedText, dynamicInputs } = getConnectedInputs(nodeId);
        const images = connectedImages.length > 0 ? connectedImages : nodeData.inputImages;
        const text = connectedText ?? nodeData.inputPrompt;

        if (!text) {
          logger.error('node.error', 'generateVideo regeneration failed: missing text input', {
            nodeId,
          });
          updateNodeData(nodeId, {
            status: "error",
            error: "Missing text input",
          });
          set({ isRunning: false, currentNodeId: null });
          await logger.endSession();
          return;
        }

        if (!nodeData.selectedModel?.modelId) {
          logger.error('node.error', 'generateVideo regeneration failed: no model selected', {
            nodeId,
          });
          updateNodeData(nodeId, {
            status: "error",
            error: "No model selected",
          });
          set({ isRunning: false, currentNodeId: null });
          await logger.endSession();
          return;
        }

        updateNodeData(nodeId, {
          inputImages: images,
          status: "loading",
          error: null,
        });

        // Build headers with API keys for providers
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        const provider = nodeData.selectedModel.provider;
        if (provider === "gemini") {
          const geminiConfig = providerSettingsState.providers.gemini;
          if (geminiConfig?.apiKey) {
            headers["X-Gemini-API-Key"] = geminiConfig.apiKey;
          }
        } else if (provider === "replicate") {
          const replicateConfig = providerSettingsState.providers.replicate;
          if (replicateConfig?.apiKey) {
            headers["X-Replicate-API-Key"] = replicateConfig.apiKey;
          }
        } else if (provider === "fal") {
          const falConfig = providerSettingsState.providers.fal;
          if (falConfig?.apiKey) {
            headers["X-Fal-API-Key"] = falConfig.apiKey;
          }
        }
        logger.info('node.execution', `Calling ${provider} API for video regeneration`, {
          nodeId,
          provider,
          model: nodeData.selectedModel.modelId,
          imageCount: images.length,
          prompt: text,
        });

        const response = await fetch("/api/generate", {
          method: "POST",
          headers,
          body: JSON.stringify({
            images,
            prompt: text,
            selectedModel: nodeData.selectedModel,
            parameters: nodeData.parameters,
            dynamicInputs,
            mediaType: "video",  // Signal to API to use queue for long-running video generation
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          let errorMessage = `HTTP ${response.status}`;
          try {
            const errorJson = JSON.parse(errorText);
            errorMessage = errorJson.error || errorMessage;
          } catch {
            if (errorText) errorMessage += ` - ${errorText.substring(0, 200)}`;
          }
          logger.error('api.error', `${provider} API video regeneration failed`, {
            nodeId,
            provider,
            status: response.status,
            errorMessage,
          });
          updateNodeData(nodeId, { status: "error", error: errorMessage });
          set({ isRunning: false, currentNodeId: null });
          await logger.endSession();
          return;
        }

        const result = await response.json();
        const videoData = result.video || result.videoUrl;
        if (result.success && videoData) {
          const timestamp = Date.now();
          const videoId = `${timestamp}`;

          // Add to node's video history
          const newHistoryItem = {
            id: videoId,
            timestamp,
            prompt: text || '',
            model: nodeData.selectedModel?.modelId || '',
          };
          const updatedHistory = [newHistoryItem, ...(nodeData.videoHistory || [])].slice(0, 50);

          updateNodeData(nodeId, {
            outputVideo: videoData,
            status: "complete",
            error: null,
            videoHistory: updatedHistory,
            selectedVideoHistoryIndex: 0,
          });

          // Auto-save video to generations folder if configured
          const genPath = get().generationsPath;
          if (genPath) {
            fetch("/api/save-generation", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                directoryPath: genPath,
                video: videoData,
                prompt: text,
                imageId: videoId,
              }),
            }).catch((err) => {
              console.error("Failed to save video generation:", err);
            });
          }
        } else if (result.success && result.image) {
          const timestamp = Date.now();
          const videoId = `${timestamp}`;

          // Add to node's video history
          const newHistoryItem = {
            id: videoId,
            timestamp,
            prompt: text || '',
            model: nodeData.selectedModel?.modelId || '',
          };
          const updatedHistory = [newHistoryItem, ...(nodeData.videoHistory || [])].slice(0, 50);

          updateNodeData(nodeId, {
            outputVideo: result.image,
            status: "complete",
            error: null,
            videoHistory: updatedHistory,
            selectedVideoHistoryIndex: 0,
          });

          // Auto-save image preview to generations folder if configured
          const genPath = get().generationsPath;
          if (genPath) {
            fetch("/api/save-generation", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                directoryPath: genPath,
                image: result.image,
                prompt: text,
                imageId: videoId,
              }),
            }).catch((err) => {
              console.error("Failed to save video generation:", err);
            });
          }
        } else {
          logger.error('api.error', `${provider} API video regeneration failed`, {
            nodeId,
            provider,
            error: result.error,
          });
          updateNodeData(nodeId, {
            status: "error",
            error: result.error || "Video generation failed",
          });
        }
      } else if (node.type === "splitGrid") {
        const nodeData = node.data as SplitGridNodeData;

        // Get fresh connected inputs
        const inputs = getConnectedInputs(nodeId);
        const sourceImage = inputs.images[0] || null;

        if (!sourceImage) {
          logger.error('node.error', 'splitGrid regeneration failed: no input image', {
            nodeId,
          });
          updateNodeData(nodeId, {
            status: "error",
            error: "No input image connected",
          });
          set({ isRunning: false, currentNodeId: null });
          await logger.endSession();
          return;
        }

        if (!nodeData.isConfigured) {
          logger.error('node.error', 'splitGrid regeneration failed: not configured', {
            nodeId,
          });
          updateNodeData(nodeId, {
            status: "error",
            error: "Node not configured - open settings first",
          });
          set({ isRunning: false, currentNodeId: null });
          await logger.endSession();
          return;
        }

        updateNodeData(nodeId, {
          sourceImage,
          status: "loading",
          error: null,
        });

        logger.info('node.execution', 'Splitting grid manually', {
          nodeId,
          gridRows: nodeData.gridRows,
          gridCols: nodeData.gridCols,
          childCount: nodeData.childNodeIds.length,
        });

        try {
          // Import and use the grid splitter
          const { splitWithDimensions } = await import("@/utils/gridSplitter");
          const { images: splitImages } = await splitWithDimensions(
            sourceImage,
            nodeData.gridRows,
            nodeData.gridCols
          );

          // Populate child imageInput nodes with split images
          for (let index = 0; index < nodeData.childNodeIds.length; index++) {
            const childSet = nodeData.childNodeIds[index];
            if (splitImages[index]) {
              // Create a promise to get image dimensions
              await new Promise<void>((resolve) => {
                const img = new Image();
                img.onload = () => {
                  updateNodeData(childSet.imageInput, {
                    image: splitImages[index],
                    filename: `split-${Math.floor(index / nodeData.gridCols) + 1}-${(index % nodeData.gridCols) + 1}.png`,
                    dimensions: { width: img.width, height: img.height },
                  });
                  resolve();
                };
                img.onerror = () => resolve();
                img.src = splitImages[index];
              });
            }
          }

          logger.info('node.execution', 'Grid split completed successfully', {
            nodeId,
            splitCount: splitImages.length,
          });
          updateNodeData(nodeId, { status: "complete", error: null });
        } catch (error) {
          logger.error('node.error', 'splitGrid manual execution failed', {
            nodeId,
          }, error instanceof Error ? error : undefined);
          updateNodeData(nodeId, {
            status: "error",
            error: error instanceof Error ? error.message : "Failed to split image",
          });
          set({ isRunning: false, currentNodeId: null });
          await logger.endSession();
          return;
        }
      } else if (node.type === "maskInpaint") {
        const nodeData = node.data as MaskInpaintNodeData;
        const providerSettingsState = get().providerSettings;

        // Get fresh connected inputs
        const inputs = getConnectedInputs(nodeId);
        const sourceImage = inputs.images[0] || nodeData.sourceImage;
        const promptText = inputs.text || nodeData.inputPrompt;

        if (!sourceImage) {
          logger.error('node.error', 'maskInpaint regeneration failed: no source image', {
            nodeId,
          });
          updateNodeData(nodeId, {
            status: "error",
            error: "No source image connected",
          });
          set({ isRunning: false, currentNodeId: null });
          await logger.endSession();
          return;
        }

        if (!nodeData.maskImage && nodeData.maskStrokes.length === 0) {
          logger.error('node.error', 'maskInpaint regeneration failed: no mask', {
            nodeId,
          });
          updateNodeData(nodeId, {
            status: "error",
            error: "No mask defined - paint a mask first",
          });
          set({ isRunning: false, currentNodeId: null });
          await logger.endSession();
          return;
        }

        if (!promptText) {
          logger.error('node.error', 'maskInpaint regeneration failed: no prompt', {
            nodeId,
          });
          updateNodeData(nodeId, {
            status: "error",
            error: "No prompt connected - describe what to generate",
          });
          set({ isRunning: false, currentNodeId: null });
          await logger.endSession();
          return;
        }

        updateNodeData(nodeId, {
          sourceImage,
          inputPrompt: promptText,
          status: "loading",
          error: null,
        });

        try {
          // Build headers with API keys
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
          };
          const geminiConfig = providerSettingsState.providers.gemini;
          if (geminiConfig?.apiKey) {
            headers["X-Gemini-API-Key"] = geminiConfig.apiKey;
          }

          const inpaintPrompt = `Edit this image. In the white/bright areas of the mask image, ${promptText}. Keep all other areas unchanged.`;

          const imagesToSend = nodeData.maskImage
            ? [sourceImage, nodeData.maskImage]
            : [sourceImage];

          logger.info('api.inpaint', 'Calling inpaint API for regeneration', {
            nodeId,
            hasSourceImage: !!sourceImage,
            hasMask: !!nodeData.maskImage,
            prompt: promptText,
          });

          const response = await fetch("/api/generate", {
            method: "POST",
            headers,
            body: JSON.stringify({
              images: imagesToSend,
              prompt: inpaintPrompt,
              aspectRatio: "1:1",
              model: "nano-banana-pro",
            }),
          });

          if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || "API call failed");
          }

          const result = await response.json();

          if (result.image) {
            const historyItem = {
              id: `inpaint-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
              timestamp: Date.now(),
              prompt: promptText,
              aspectRatio: "1:1" as const,
              model: "nano-banana-pro" as const,
            };

            const updatedHistory = [...(nodeData.imageHistory || []), historyItem];

            updateNodeData(nodeId, {
              outputImage: result.image,
              status: "complete",
              error: null,
              imageHistory: updatedHistory,
              selectedHistoryIndex: updatedHistory.length - 1,
            });

            if (result.cost) {
              get().addIncurredCost(result.cost);
            }

            logger.info('node.complete', 'maskInpaint regeneration successful', {
              nodeId,
              cost: result.cost,
            });
          } else {
            throw new Error("No image in response");
          }
        } catch (error) {
          logger.error('node.error', 'maskInpaint regeneration failed', {
            nodeId,
          }, error instanceof Error ? error : undefined);
          updateNodeData(nodeId, {
            status: "error",
            error: error instanceof Error ? error.message : "Inpainting failed",
          });
          set({ isRunning: false, currentNodeId: null });
          await logger.endSession();
          return;
        }
      }

      logger.info('node.execution', 'Node regeneration completed successfully', { nodeId });
      set({ isRunning: false, currentNodeId: null });

      // Save logs to server
      const session = logger.getCurrentSession();
      if (session) {
        session.endTime = new Date().toISOString();
        fetch('/api/logs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session }),
        }).catch((err) => {
          console.error('Failed to save log session:', err);
        });
      }

      await logger.endSession();
    } catch (error) {
      logger.error('node.error', 'Node regeneration failed', {
        nodeId,
      }, error instanceof Error ? error : undefined);
      updateNodeData(nodeId, {
        status: "error",
        error: error instanceof Error ? error.message : "Regeneration failed",
      });
      set({ isRunning: false, currentNodeId: null });

      // Save logs to server (even on error)
      const session = logger.getCurrentSession();
      if (session) {
        session.endTime = new Date().toISOString();
        fetch('/api/logs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session }),
        }).catch((err) => {
          console.error('Failed to save log session:', err);
        });
      }

      await logger.endSession();
    }
  },

  saveWorkflow: (name?: string) => {
    const { nodes, edges, edgeStyle, groups } = get();

    const workflow: WorkflowFile = {
      version: 1,
      name: name || `workflow-${new Date().toISOString().slice(0, 10)}`,
      nodes,
      edges,
      edgeStyle,
      groups: Object.keys(groups).length > 0 ? groups : undefined,
    };

    const json = JSON.stringify(workflow, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = url;
    link.download = `${workflow.name}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  },

  loadWorkflow: async (workflow: WorkflowFile, workflowPath?: string) => {
    // Update nodeIdCounter to avoid ID collisions
    const maxNodeId = workflow.nodes.reduce((max, node) => {
      const match = node.id.match(/-(\d+)$/);
      if (match) {
        return Math.max(max, parseInt(match[1], 10));
      }
      return max;
    }, 0);
    nodeIdCounter = maxNodeId;

    // Update groupIdCounter to avoid ID collisions
    const maxGroupId = Object.keys(workflow.groups || {}).reduce((max, id) => {
      const match = id.match(/-(\d+)$/);
      if (match) {
        return Math.max(max, parseInt(match[1], 10));
      }
      return max;
    }, 0);
    groupIdCounter = maxGroupId;

    // Migrate legacy nanoBanana nodes: derive selectedModel from model field if missing
    workflow.nodes = workflow.nodes.map((node) => {
      if (node.type === "nanoBanana") {
        const data = node.data as NanoBananaNodeData;
        if (data.model && !data.selectedModel) {
          const displayName = data.model === "nano-banana" ? "Nano Banana" : "Nano Banana Pro";
          return {
            ...node,
            data: {
              ...data,
              selectedModel: {
                provider: "gemini" as ProviderType,
                modelId: data.model,
                displayName,
              },
            },
          };
        }
      }
      return node;
    }) as WorkflowNode[];

    // Look up saved config from localStorage (only if workflow has an ID)
    const configs = loadSaveConfigs();
    const savedConfig = workflow.id ? configs[workflow.id] : null;

    // Determine the workflow directory path (passed in or from saved config)
    const directoryPath = workflowPath || savedConfig?.directoryPath;

    // Hydrate images if we have a directory path and the workflow has image refs
    let hydratedWorkflow = workflow;
    if (directoryPath) {
      try {
        hydratedWorkflow = await hydrateWorkflowImages(workflow, directoryPath);
      } catch (error) {
        console.error("Failed to hydrate workflow images:", error);
        // Continue with original workflow if hydration fails
      }
    }

    // Load cost data for this workflow
    const costData = workflow.id ? loadWorkflowCostData(workflow.id) : null;

    set({
      nodes: hydratedWorkflow.nodes,
      edges: hydratedWorkflow.edges,
      edgeStyle: hydratedWorkflow.edgeStyle || "angular",
      groups: hydratedWorkflow.groups || {},
      isRunning: false,
      currentNodeId: null,
      // Restore workflow ID and paths from localStorage if available
      workflowId: workflow.id || null,
      workflowName: workflow.name,
      saveDirectoryPath: directoryPath || null,
      generationsPath: savedConfig?.generationsPath || null,
      lastSavedAt: savedConfig?.lastSavedAt || null,
      hasUnsavedChanges: false,
      // Restore cost data
      incurredCost: costData?.incurredCost || 0,
      // Clear undo/redo history when loading a new workflow
      undoStack: [],
      redoStack: [],
      canUndo: false,
      canRedo: false,
    });
  },

  clearWorkflow: () => {
    set({
      nodes: [],
      edges: [],
      groups: {},
      isRunning: false,
      currentNodeId: null,
      // Reset auto-save state when clearing workflow
      workflowId: null,
      workflowName: null,
      saveDirectoryPath: null,
      generationsPath: null,
      lastSavedAt: null,
      hasUnsavedChanges: false,
      // Reset cost tracking
      incurredCost: 0,
      // Clear undo/redo history when clearing workflow
      undoStack: [],
      redoStack: [],
      canUndo: false,
      canRedo: false,
    });
  },

  addToGlobalHistory: (item: Omit<ImageHistoryItem, "id">) => {
    const newItem: ImageHistoryItem = {
      ...item,
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    };

    set((state) => ({
      globalImageHistory: [newItem, ...state.globalImageHistory],
    }));
  },

  clearGlobalHistory: () => {
    set({ globalImageHistory: [] });
  },

  // Auto-save actions
  setWorkflowMetadata: (id: string, name: string, path: string, generationsPath?: string | null) => {
    // Auto-derive generationsPath: use provided value, fall back to existing, then auto-derive
    const currentGenPath = get().generationsPath;
    const derivedGenerationsPath = generationsPath ?? currentGenPath ?? `${path}/generations`;

    set({
      workflowId: id,
      workflowName: name,
      saveDirectoryPath: path,
      generationsPath: derivedGenerationsPath,
    });
  },

  setWorkflowName: (name: string) => {
    set({
      workflowName: name,
      hasUnsavedChanges: true,
    });
  },

  setGenerationsPath: (path: string | null) => {
    set({
      generationsPath: path,
    });
  },

  setAutoSaveEnabled: (enabled: boolean) => {
    set({ autoSaveEnabled: enabled });
  },

  setUseExternalImageStorage: (enabled: boolean) => {
    set({ useExternalImageStorage: enabled });
  },

  markAsUnsaved: () => {
    set({ hasUnsavedChanges: true });
  },

  saveToFile: async () => {
    const {
      nodes,
      edges,
      edgeStyle,
      groups,
      workflowId,
      workflowName,
      saveDirectoryPath,
      useExternalImageStorage,
    } = get();

    if (!workflowId || !workflowName || !saveDirectoryPath) {
      return false;
    }

    set({ isSaving: true });

    try {
      let workflow: WorkflowFile = {
        version: 1,
        id: workflowId,
        name: workflowName,
        nodes,
        edges,
        edgeStyle,
        groups: Object.keys(groups).length > 0 ? groups : undefined,
      };

      // If external image storage is enabled, externalize images before saving
      if (useExternalImageStorage) {
        workflow = await externalizeWorkflowImages(workflow, saveDirectoryPath);
      }

      const response = await fetch("/api/workflow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          directoryPath: saveDirectoryPath,
          filename: workflowName,
          workflow,
        }),
      });

      const result = await response.json();

      if (result.success) {
        const timestamp = Date.now();
        set({
          lastSavedAt: timestamp,
          hasUnsavedChanges: false,
          isSaving: false,
        });

        // Update localStorage
        saveSaveConfig({
          workflowId,
          name: workflowName,
          directoryPath: saveDirectoryPath,
          generationsPath: get().generationsPath,
          lastSavedAt: timestamp,
        });

        return true;
      } else {
        set({ isSaving: false });
        useToast.getState().show(`Auto-save failed: ${result.error}`, "error");
        return false;
      }
    } catch (error) {
      set({ isSaving: false });
      useToast
        .getState()
        .show(
          `Auto-save failed: ${error instanceof Error ? error.message : "Unknown error"}`,
          "error"
        );
      return false;
    }
  },

  initializeAutoSave: () => {
    if (autoSaveIntervalId) return;

    autoSaveIntervalId = setInterval(async () => {
      const state = get();
      if (
        state.autoSaveEnabled &&
        state.hasUnsavedChanges &&
        state.workflowId &&
        state.workflowName &&
        state.saveDirectoryPath &&
        !state.isSaving
      ) {
        await state.saveToFile();
      }
    }, 90 * 1000); // 90 seconds
  },

  cleanupAutoSave: () => {
    if (autoSaveIntervalId) {
      clearInterval(autoSaveIntervalId);
      autoSaveIntervalId = null;
    }
  },

  // Cost tracking actions
  addIncurredCost: (cost: number) => {
    set((state) => ({ incurredCost: state.incurredCost + cost }));
    get().saveIncurredCost();
  },

  resetIncurredCost: () => {
    set({ incurredCost: 0 });
    get().saveIncurredCost();
  },

  loadIncurredCost: (workflowId: string) => {
    const data = loadWorkflowCostData(workflowId);
    set({ incurredCost: data?.incurredCost || 0 });
  },

  saveIncurredCost: () => {
    const { workflowId, incurredCost } = get();
    if (!workflowId) return;
    saveWorkflowCostData({
      workflowId,
      incurredCost,
      lastUpdated: Date.now(),
    });
  },

  // Provider settings actions
  updateProviderSettings: (settings: ProviderSettings) => {
    set({ providerSettings: settings });
    saveProviderSettings(settings);
  },

  updateProviderApiKey: (providerId: ProviderType, apiKey: string | null) => {
    const { providerSettings } = get();
    const updated: ProviderSettings = {
      providers: {
        ...providerSettings.providers,
        [providerId]: {
          ...providerSettings.providers[providerId],
          apiKey,
        },
      },
    };
    set({ providerSettings: updated });
    saveProviderSettings(updated);
  },

  toggleProvider: (providerId: ProviderType, enabled: boolean) => {
    const { providerSettings } = get();
    const updated: ProviderSettings = {
      providers: {
        ...providerSettings.providers,
        [providerId]: {
          ...providerSettings.providers[providerId],
          enabled,
        },
      },
    };
    set({ providerSettings: updated });
    saveProviderSettings(updated);
  },

  // Model search dialog actions
  setModelSearchOpen: (open: boolean, provider?: ProviderType | null) => {
    set({
      modelSearchOpen: open,
      modelSearchProvider: provider ?? null,
    });
  },

  trackModelUsage: (model: { provider: ProviderType; modelId: string; displayName: string }) => {
    const current = get().recentModels;
    // Remove existing entry for same modelId if present
    const filtered = current.filter((m) => m.modelId !== model.modelId);
    // Prepend new entry with current timestamp
    const updated: RecentModel[] = [
      {
        provider: model.provider,
        modelId: model.modelId,
        displayName: model.displayName,
        timestamp: Date.now(),
      },
      ...filtered,
    ].slice(0, MAX_RECENT_MODELS);
    // Save to localStorage and update state
    saveRecentModels(updated);
    set({ recentModels: updated });
  },

  // Undo/Redo actions
  pushToUndoStack: () => {
    const { nodes, edges, groups, undoStack } = get();

    // Create a snapshot of the current state (deep clone to avoid reference issues)
    const snapshot: HistorySnapshot = {
      nodes: JSON.parse(JSON.stringify(nodes)),
      edges: JSON.parse(JSON.stringify(edges)),
      groups: JSON.parse(JSON.stringify(groups)),
    };

    // Add to undo stack, limiting size
    const newUndoStack = [snapshot, ...undoStack].slice(0, MAX_HISTORY_SIZE);

    set({
      undoStack: newUndoStack,
      redoStack: [], // Clear redo stack when new action is performed
      canUndo: true,
      canRedo: false,
    });
  },

  undo: () => {
    const { nodes, edges, groups, undoStack, redoStack } = get();

    if (undoStack.length === 0) return;

    // Save current state to redo stack before undoing
    const currentSnapshot: HistorySnapshot = {
      nodes: JSON.parse(JSON.stringify(nodes)),
      edges: JSON.parse(JSON.stringify(edges)),
      groups: JSON.parse(JSON.stringify(groups)),
    };

    // Get the previous state from undo stack
    const [previousState, ...remainingUndo] = undoStack;

    // Restore the previous state
    set({
      nodes: previousState.nodes,
      edges: previousState.edges,
      groups: previousState.groups,
      undoStack: remainingUndo,
      redoStack: [currentSnapshot, ...redoStack].slice(0, MAX_HISTORY_SIZE),
      canUndo: remainingUndo.length > 0,
      canRedo: true,
      hasUnsavedChanges: true,
    });
  },

  redo: () => {
    const { nodes, edges, groups, undoStack, redoStack } = get();

    if (redoStack.length === 0) return;

    // Save current state to undo stack before redoing
    const currentSnapshot: HistorySnapshot = {
      nodes: JSON.parse(JSON.stringify(nodes)),
      edges: JSON.parse(JSON.stringify(edges)),
      groups: JSON.parse(JSON.stringify(groups)),
    };

    // Get the next state from redo stack
    const [nextState, ...remainingRedo] = redoStack;

    // Restore the next state
    set({
      nodes: nextState.nodes,
      edges: nextState.edges,
      groups: nextState.groups,
      undoStack: [currentSnapshot, ...undoStack].slice(0, MAX_HISTORY_SIZE),
      redoStack: remainingRedo,
      canUndo: true,
      canRedo: remainingRedo.length > 0,
      hasUnsavedChanges: true,
    });
  },

  clearHistory: () => {
    set({
      undoStack: [],
      redoStack: [],
      canUndo: false,
      canRedo: false,
    });
  },
}));
