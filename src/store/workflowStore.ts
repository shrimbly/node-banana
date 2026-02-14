import { create } from "zustand";
import { useShallow } from "zustand/shallow";
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
  NanoBananaNodeData,
  OutputGalleryNodeData,
  WorkflowNodeData,
  ImageHistoryItem,
  NodeGroup,
  GroupColor,
  ProviderType,
  ProviderSettings,
  RecentModel,
  CanvasNavigationSettings,
} from "@/types";
import { useToast } from "@/components/Toast";
import { logger } from "@/utils/logger";
import { externalizeWorkflowImages, hydrateWorkflowImages } from "@/utils/imageStorage";
import { EditOperation, applyEditOperations as executeEditOps } from "@/lib/chat/editOperations";
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
  generateWorkflowId,
  getCanvasNavigationSettings,
  saveCanvasNavigationSettings,
} from "./utils/localStorage";
import {
  createDefaultNodeData,
  defaultNodeDimensions,
  GROUP_COLORS,
  GROUP_COLOR_ORDER,
} from "./utils/nodeDefaults";
import {
  CONCURRENCY_SETTINGS_KEY,
  loadConcurrencySetting,
  saveConcurrencySetting,
  groupNodesByLevel,
  chunk,
  clearNodeImageRefs,
} from "./utils/executionUtils";
import { getConnectedInputsPure, validateWorkflowPure } from "./utils/connectedInputs";
import {
  executeAnnotation,
  executePrompt,
  executePromptConstructor,
  executeOutput,
  executeOutputGallery,
  executeImageCompare,
  executeNanoBanana,
  executeGenerateVideo,
  executeLlmGenerate,
  executeSplitGrid,
  executeVideoStitch,
  executeEaseCurve,
  executeGlbViewer,
} from "./execution";
import type { NodeExecutionContext } from "./execution";
export type { LevelGroup } from "./utils/executionUtils";
export { CONCURRENCY_SETTINGS_KEY } from "./utils/executionUtils";

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
  currentNodeIds: string[];  // Changed from currentNodeId for parallel execution
  pausedAtNodeId: string | null;
  maxConcurrentCalls: number;  // Configurable concurrency limit (1-10)
  _abortController: AbortController | null;  // Internal: for cancellation
  _buildExecutionContext: (node: WorkflowNode, signal?: AbortSignal) => NodeExecutionContext;
  executeWorkflow: (startFromNodeId?: string) => Promise<void>;
  regenerateNode: (nodeId: string) => Promise<void>;
  stopWorkflow: () => void;
  setMaxConcurrentCalls: (value: number) => void;

  // Save/Load
  saveWorkflow: (name?: string) => void;
  loadWorkflow: (workflow: WorkflowFile, workflowPath?: string, options?: { preserveSnapshot?: boolean }) => Promise<void>;
  clearWorkflow: () => void;

  // Helpers
  getNodeById: (id: string) => WorkflowNode | undefined;
  getConnectedInputs: (nodeId: string) => { images: string[]; videos: string[]; audio: string[]; model3d: string | null; text: string | null; dynamicInputs: Record<string, string | string[]>; easeCurve: { bezierHandles: [number, number, number, number]; easingPreset: string | null } | null };
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
  imageRefBasePath: string | null;  // Directory from which current imageRefs are valid

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

  // Keyboard shortcuts dialog state
  shortcutsDialogOpen: boolean;
  setShortcutsDialogOpen: (open: boolean) => void;

  // Model search dialog actions
  setModelSearchOpen: (open: boolean, provider?: ProviderType | null) => void;

  // Recent models state
  recentModels: RecentModel[];

  // Recent models actions
  trackModelUsage: (model: { provider: ProviderType; modelId: string; displayName: string }) => void;

  // Comment navigation state
  viewedCommentNodeIds: Set<string>;
  navigationTarget: { nodeId: string; timestamp: number } | null;
  focusedCommentNodeId: string | null;

  // Comment navigation actions
  getNodesWithComments: () => WorkflowNode[];
  getUnviewedCommentCount: () => number;
  markCommentViewed: (nodeId: string) => void;
  setNavigationTarget: (nodeId: string | null) => void;
  setFocusedCommentNodeId: (nodeId: string | null) => void;
  resetViewedComments: () => void;

  // AI change snapshot state
  previousWorkflowSnapshot: {
    nodes: WorkflowNode[];
    edges: WorkflowEdge[];
    groups: Record<string, NodeGroup>;
    edgeStyle: EdgeStyle;
  } | null;
  manualChangeCount: number;

  // AI change snapshot actions
  captureSnapshot: () => void;
  revertToSnapshot: () => void;
  clearSnapshot: () => void;
  incrementManualChangeCount: () => void;
  applyEditOperations: (operations: EditOperation[]) => { applied: number; skipped: string[] };

  // Canvas navigation settings state
  canvasNavigationSettings: CanvasNavigationSettings;

  // Canvas navigation settings actions
  updateCanvasNavigationSettings: (settings: CanvasNavigationSettings) => void;
}

let nodeIdCounter = 0;
let groupIdCounter = 0;
let autoSaveIntervalId: ReturnType<typeof setInterval> | null = null;

// Track pending save-generation syncs to ensure IDs are resolved before workflow save
const pendingImageSyncs = new Map<string, Promise<void>>();

// Wait for all pending image syncs to complete (with timeout to prevent infinite hangs)
async function waitForPendingImageSyncs(timeout: number = 60000): Promise<void> {
  if (pendingImageSyncs.size === 0) return;

  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<void>((resolve) => {
    timeoutId = setTimeout(() => {
      console.warn(`Pending image syncs timed out after ${timeout}ms, continuing with save`);
      resolve();
    }, timeout);
  });

  try {
    await Promise.race([
      Promise.all(pendingImageSyncs.values()),
      timeoutPromise,
    ]);
  } finally {
    clearTimeout(timeoutId!);
  }
}


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
  currentNodeIds: [],  // Changed from currentNodeId for parallel execution
  pausedAtNodeId: null,
  maxConcurrentCalls: loadConcurrencySetting(),  // Default 3, configurable 1-10
  _abortController: null,  // Internal: for cancellation
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
  imageRefBasePath: null,  // Directory from which current imageRefs are valid

  // Cost tracking initial state
  incurredCost: 0,

  // Provider settings initial state
  providerSettings: getProviderSettings(),

  // Model search dialog initial state
  modelSearchOpen: false,
  modelSearchProvider: null,

  // Keyboard shortcuts dialog initial state
  shortcutsDialogOpen: false,

  // Recent models initial state
  recentModels: getRecentModels(),

  // Comment navigation initial state
  viewedCommentNodeIds: new Set<string>(),
  navigationTarget: null,
  focusedCommentNodeId: null,

  // AI change snapshot initial state
  previousWorkflowSnapshot: null,
  manualChangeCount: 0,

  // Canvas navigation settings initial state
  canvasNavigationSettings: getCanvasNavigationSettings(),

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

    get().incrementManualChangeCount();

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
    set((state) => ({
      nodes: state.nodes.filter((node) => node.id !== nodeId),
      edges: state.edges.filter(
        (edge) => edge.source !== nodeId && edge.target !== nodeId
      ),
      hasUnsavedChanges: true,
    }));
    get().incrementManualChangeCount();
  },

  onNodesChange: (changes: NodeChange<WorkflowNode>[]) => {
    // Only mark as unsaved for meaningful changes (not selection changes)
    const hasMeaningfulChange = changes.some(
      (c) => c.type !== "select" && c.type !== "dimensions"
    );
    // Track manual changes only for remove operations (not position/selection/dimensions)
    const hasRemoveChange = changes.some((c) => c.type === "remove");

    set((state) => ({
      nodes: applyNodeChanges(changes, state.nodes),
      ...(hasMeaningfulChange ? { hasUnsavedChanges: true } : {}),
    }));

    if (hasRemoveChange) {
      get().incrementManualChangeCount();
    }
  },

  onEdgesChange: (changes: EdgeChange<WorkflowEdge>[]) => {
    // Only mark as unsaved for meaningful changes (not selection changes)
    const hasMeaningfulChange = changes.some((c) => c.type !== "select");
    // Track manual changes only for remove operations (not selection)
    const hasRemoveChange = changes.some((c) => c.type === "remove");

    set((state) => ({
      edges: applyEdgeChanges(changes, state.edges),
      ...(hasMeaningfulChange ? { hasUnsavedChanges: true } : {}),
    }));

    if (hasRemoveChange) {
      get().incrementManualChangeCount();
    }
  },

  onConnect: (connection: Connection) => {
    set((state) => ({
      edges: addEdge(
        {
          ...connection,
          id: `edge-${connection.source}-${connection.target}-${connection.sourceHandle || "default"}-${connection.targetHandle || "default"}`,
          data: { createdAt: Date.now() },
        },
        state.edges
      ),
      hasUnsavedChanges: true,
    }));
    get().incrementManualChangeCount();
  },

  addEdgeWithType: (connection: Connection, edgeType: string) => {
    set((state) => ({
      edges: addEdge(
        {
          ...connection,
          id: `edge-${connection.source}-${connection.target}-${connection.sourceHandle || "default"}-${connection.targetHandle || "default"}`,
          type: edgeType,
          data: { createdAt: Date.now() },
        },
        state.edges
      ),
      hasUnsavedChanges: true,
    }));
  },

  removeEdge: (edgeId: string) => {
    set((state) => ({
      edges: state.edges.filter((edge) => edge.id !== edgeId),
      hasUnsavedChanges: true,
    }));
    get().incrementManualChangeCount();
  },

  toggleEdgePause: (edgeId: string) => {
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
    set((state) => ({
      nodes: state.nodes.map((node) =>
        nodeIds.includes(node.id) ? { ...node, groupId } : node
      ) as WorkflowNode[],
      hasUnsavedChanges: true,
    }));
  },

  removeNodesFromGroup: (nodeIds: string[]) => {
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
    return getConnectedInputsPure(nodeId, nodes, edges);
  },

  validateWorkflow: () => {
    const { nodes, edges } = get();
    return validateWorkflowPure(nodes, edges);
  },

  _buildExecutionContext: (node: WorkflowNode, signal?: AbortSignal): NodeExecutionContext => ({
    node,
    getConnectedInputs: get().getConnectedInputs,
    updateNodeData: get().updateNodeData,
    getFreshNode: (id: string) => get().nodes.find((n) => n.id === id),
    getEdges: () => get().edges,
    getNodes: () => get().nodes,
    signal,
    providerSettings: get().providerSettings,
    addIncurredCost: (cost: number) => get().addIncurredCost(cost),
    addToGlobalHistory: (item) => get().addToGlobalHistory(item),
    generationsPath: get().generationsPath,
    saveDirectoryPath: get().saveDirectoryPath,
    trackSaveGeneration: (key: string, promise: Promise<void>) => {
      pendingImageSyncs.set(key, promise);
      promise.finally(() => pendingImageSyncs.delete(key));
    },
    appendOutputGalleryImage: (targetId: string, image: string) => {
      set((state) => ({
        nodes: state.nodes.map((n) =>
          n.id === targetId && n.type === "outputGallery"
            ? { ...n, data: { ...n.data, images: [image, ...((n.data as OutputGalleryNodeData).images || [])] } as WorkflowNodeData }
            : n
        ) as WorkflowNode[],
        hasUnsavedChanges: true,
      }));
    },
    get: get as () => unknown,
  }),

  executeWorkflow: async (startFromNodeId?: string) => {
    const { nodes, edges, groups, isRunning, maxConcurrentCalls } = get();

    if (isRunning) {
      logger.warn('workflow.start', 'Workflow already running, ignoring execution request');
      return;
    }

    // Create AbortController for this execution run
    const abortController = new AbortController();
    const isResuming = startFromNodeId === get().pausedAtNodeId;
    set({ isRunning: true, pausedAtNodeId: null, currentNodeIds: [], _abortController: abortController });

    // Start logging session
    await logger.startSession();

    logger.info('workflow.start', 'Workflow execution started', {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      startFromNodeId,
      isResuming,
      maxConcurrentCalls,
    });

    // Group nodes by level for parallel execution
    const levels = groupNodesByLevel(nodes, edges);

    // Find starting level if startFromNodeId specified
    let startLevel = 0;
    if (startFromNodeId) {
      const foundLevel = levels.findIndex((l) => l.nodeIds.includes(startFromNodeId));
      if (foundLevel !== -1) startLevel = foundLevel;
    }

    // Helper to execute a single node - returns true if successful, throws on error
    const executeSingleNode = async (node: WorkflowNode, signal: AbortSignal): Promise<void> => {
      // Check for abort before starting
      if (signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

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
          set({ pausedAtNodeId: node.id });
          useToast.getState().show("Workflow paused - click Run to continue", "warning");

          // Signal to stop the entire workflow — outer loop handles isRunning/session cleanup
          abortController.abort();
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
        return; // Skip this node but continue with others
      }

      logger.info('node.execution', `Executing ${node.type} node`, {
        nodeId: node.id,
        nodeType: node.type,
      });

      const executionCtx = get()._buildExecutionContext(node, signal);

      switch (node.type) {
          case "imageInput":
          case "audioInput":
            // Data source nodes - no execution needed
            break;
          case "glbViewer":
            await executeGlbViewer(executionCtx);
            break;
          case "annotation":
            await executeAnnotation(executionCtx);
            break;
          case "prompt":
            await executePrompt(executionCtx);
            break;
          case "promptConstructor":
            await executePromptConstructor(executionCtx);
            break;
          case "nanoBanana":
            await executeNanoBanana(executionCtx);
            break;
          case "generateVideo":
            await executeGenerateVideo(executionCtx);
            break;
          case "llmGenerate":
            await executeLlmGenerate(executionCtx);
            break;
          case "splitGrid":
            await executeSplitGrid(executionCtx);
            break;
          case "output":
            await executeOutput(executionCtx);
            break;
          case "outputGallery":
            await executeOutputGallery(executionCtx);
            break;
          case "imageCompare":
            await executeImageCompare(executionCtx);
            break;
          case "videoStitch":
            await executeVideoStitch(executionCtx);
            break;
          case "easeCurve":
            await executeEaseCurve(executionCtx);
            break;
        }
    }; // End of executeSingleNode helper

    try {
      // Execute levels sequentially, but nodes within each level in parallel
      for (let levelIdx = startLevel; levelIdx < levels.length; levelIdx++) {
        // Check if execution was stopped
        if (abortController.signal.aborted || !get().isRunning) break;

        const level = levels[levelIdx];
        const levelNodes = level.nodeIds
          .map((id) => nodes.find((n) => n.id === id))
          .filter((n): n is WorkflowNode => n !== undefined);

        if (levelNodes.length === 0) continue;

        // Execute nodes in batches respecting concurrency limit
        const batches = chunk(levelNodes, maxConcurrentCalls);

        for (const batch of batches) {
          if (abortController.signal.aborted || !get().isRunning) break;

          // Update currentNodeIds to show which nodes are executing
          const batchIds = batch.map((n) => n.id);
          set({ currentNodeIds: batchIds });

          logger.info('node.execution', `Executing level ${levelIdx} batch`, {
            level: levelIdx,
            nodeCount: batch.length,
            nodeIds: batchIds,
          });

          // Execute batch in parallel
          const results = await Promise.allSettled(
            batch.map((node) => executeSingleNode(node, abortController.signal))
          );

          // Check for failures (fail-fast behavior)
          const failed = results.find(
            (r): r is PromiseRejectedResult =>
              r.status === 'rejected' &&
              !(r.reason instanceof DOMException && r.reason.name === 'AbortError')
          );

          if (failed) {
            // Log the failure and abort remaining executions
            logger.error('workflow.error', 'Node execution failed in parallel batch', {
              level: levelIdx,
              error: failed.reason instanceof Error ? failed.reason.message : String(failed.reason),
            });
            abortController.abort();
            throw failed.reason;
          }
        }
      }

      // Check if we completed or were aborted
      if (!abortController.signal.aborted && get().isRunning) {
        logger.info('workflow.end', 'Workflow execution completed successfully');
      }

      set({ isRunning: false, currentNodeIds: [], _abortController: null });

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
      // Handle AbortError gracefully (user cancelled)
      if (error instanceof DOMException && error.name === 'AbortError') {
        logger.info('workflow.end', 'Workflow execution cancelled by user');
      } else {
        logger.error('workflow.error', 'Workflow execution failed', {}, error instanceof Error ? error : undefined);
        // Show error toast for the failed node
        useToast.getState().show(
          `Workflow failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          "error"
        );
      }
      set({ isRunning: false, currentNodeIds: [], _abortController: null });

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
    // Abort any in-flight requests
    const controller = get()._abortController;
    if (controller) {
      controller.abort("user-cancelled");
    }
    set({ isRunning: false, currentNodeIds: [], _abortController: null });
  },

  setMaxConcurrentCalls: (value: number) => {
    const clamped = Math.max(1, Math.min(10, value));
    saveConcurrencySetting(clamped);
    set({ maxConcurrentCalls: clamped });
  },

  regenerateNode: async (nodeId: string) => {
    const { nodes, updateNodeData, isRunning } = get();

    if (isRunning) {
      logger.warn('node.execution', 'Cannot regenerate node, workflow already running', { nodeId });
      return;
    }

    const node = nodes.find((n) => n.id === nodeId);
    if (!node) {
      logger.warn('node.error', 'Node not found for regeneration', { nodeId });
      return;
    }

    set({ isRunning: true, currentNodeIds: [nodeId] });

    await logger.startSession();
    logger.info('node.execution', 'Regenerating node', {
      nodeId,
      nodeType: node.type,
    });

    try {
      const executionCtx = get()._buildExecutionContext(node);

      const regenOptions = { useStoredFallback: true };

      if (node.type === "nanoBanana") {
        await executeNanoBanana(executionCtx, regenOptions);
      } else if (node.type === "llmGenerate") {
        await executeLlmGenerate(executionCtx, regenOptions);
      } else if (node.type === "generateVideo") {
        await executeGenerateVideo(executionCtx, regenOptions);
      } else if (node.type === "splitGrid") {
        await executeSplitGrid(executionCtx);
      } else if (node.type === "videoStitch") {
        await executeVideoStitch(executionCtx);
        set({ isRunning: false, currentNodeIds: [] });
        await logger.endSession();
        return;
      } else if (node.type === "easeCurve") {
        await executeEaseCurve(executionCtx);
        set({ isRunning: false, currentNodeIds: [] });
        await logger.endSession();
        return;
      }

      // After regeneration, execute directly connected downstream consumer nodes
      // (e.g. glbViewer needs to fetch+load 3D model from upstream nanoBanana)
      const { edges: currentEdges } = get();
      const downstreamEdges = currentEdges.filter(e => e.source === nodeId);
      for (const edge of downstreamEdges) {
        const targetNode = get().nodes.find(n => n.id === edge.target);
        if (!targetNode) continue;
        const targetCtx = get()._buildExecutionContext(targetNode);
        switch (targetNode.type) {
          case "glbViewer":
            await executeGlbViewer(targetCtx);
            break;
          case "output":
            await executeOutput(targetCtx);
            break;
          case "outputGallery":
            await executeOutputGallery(targetCtx);
            break;
          case "imageCompare":
            await executeImageCompare(targetCtx);
            break;
        }
      }

      logger.info('node.execution', 'Node regeneration completed successfully', { nodeId });
      set({ isRunning: false, currentNodeIds: [] });

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
      set({ isRunning: false, currentNodeIds: [] });

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
      // Strip selected property - selection is transient UI state and should not be persisted
      nodes: nodes.map(({ selected, ...rest }) => rest),
      edges,
      edgeStyle,
      groups: groups && Object.keys(groups).length > 0 ? groups : undefined,
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

  loadWorkflow: async (workflow: WorkflowFile, workflowPath?: string, options?: { preserveSnapshot?: boolean }) => {
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
      // Clear selected state - selection should not be persisted across sessions
      // Also validate position to ensure coordinates are finite numbers
      nodes: hydratedWorkflow.nodes.map(node => ({
        ...node,
        selected: false,
        position: {
          x: isFinite(node.position?.x) ? node.position.x : 0,
          y: isFinite(node.position?.y) ? node.position.y : 0,
        },
      })),
      edges: hydratedWorkflow.edges,
      edgeStyle: hydratedWorkflow.edgeStyle || "angular",
      groups: hydratedWorkflow.groups || {},
      isRunning: false,
      currentNodeIds: [],
      // Restore workflow ID and paths from localStorage if available
      workflowId: workflow.id || null,
      workflowName: workflow.name,
      saveDirectoryPath: directoryPath || null,
      generationsPath: savedConfig?.generationsPath || null,
      lastSavedAt: savedConfig?.lastSavedAt || null,
      hasUnsavedChanges: false,
      // Restore cost data
      incurredCost: costData?.incurredCost || 0,
      // Track where imageRefs are valid from
      imageRefBasePath: directoryPath || null,
      // Restore image storage setting (default to true for backwards compatibility)
      useExternalImageStorage: savedConfig?.useExternalImageStorage ?? true,
      // Reset viewed comments when loading new workflow
      viewedCommentNodeIds: new Set<string>(),
    });

    // Clear snapshot unless explicitly preserving (e.g., AI workflow generation)
    if (!options?.preserveSnapshot) {
      get().clearSnapshot();
    }
  },

  clearWorkflow: () => {
    set({
      nodes: [],
      edges: [],
      groups: {},
      isRunning: false,
      currentNodeIds: [],
      // Reset auto-save state when clearing workflow
      workflowId: null,
      workflowName: null,
      saveDirectoryPath: null,
      generationsPath: null,
      lastSavedAt: null,
      hasUnsavedChanges: false,
      // Reset cost tracking
      incurredCost: 0,
      // Reset imageRef tracking
      imageRefBasePath: null,
      // Reset viewed comments when clearing workflow
      viewedCommentNodeIds: new Set<string>(),
    });
    get().clearSnapshot();
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
    let {
      nodes,
      edges,
      edgeStyle,
      groups,
      workflowId,
      workflowName,
      saveDirectoryPath,
      useExternalImageStorage,
      imageRefBasePath,
    } = get();

    if (!workflowId || !workflowName || !saveDirectoryPath) {
      return false;
    }

    set({ isSaving: true });

    try {
      // Wait for any pending image/video saves to complete so their IDs are synced
      // This prevents saving workflows with temporary IDs that don't match saved files
      await waitForPendingImageSyncs();

      // Re-fetch nodes after waiting, as imageHistory IDs may have been updated
      let currentNodes = get().nodes;

      // Check if any nodes have existing image refs
      // This helps detect "save to new directory" when imageRefBasePath wasn't set
      // (e.g., workflow loaded from file dialog without directory context)
      const hasExistingRefs = currentNodes.some(node => {
        const data = node.data as Record<string, unknown>;
        return data.imageRef || data.outputImageRef || data.sourceImageRef || data.inputImageRefs;
      });

      // If saving to a different directory than where refs point, clear refs
      // so images will be re-saved to the new location
      const isNewDirectory = useExternalImageStorage && (
        // Case 1: Known different directory
        (imageRefBasePath !== null && imageRefBasePath !== saveDirectoryPath) ||
        // Case 2: Has refs but unknown where they came from - treat as new directory to be safe
        (imageRefBasePath === null && hasExistingRefs)
      );

      if (isNewDirectory) {
        // Generate new workflow ID for the duplicate - prevents localStorage collision
        // This ensures the new project has independent config and preserves the original
        const newWorkflowId = generateWorkflowId();
        workflowId = newWorkflowId;

        // Clear refs so images get saved to new location
        currentNodes = clearNodeImageRefs(currentNodes);
        set({
          nodes: currentNodes,
          workflowId: newWorkflowId,
        });
      }

      let workflow: WorkflowFile = {
        version: 1,
        id: workflowId,
        name: workflowName,
        nodes: currentNodes,
        edges,
        edgeStyle,
        groups: groups && Object.keys(groups).length > 0 ? groups : undefined,
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

        // If we externalized images, update store nodes with the refs
        // This prevents duplicate images on subsequent saves
        if (useExternalImageStorage && workflow.nodes !== currentNodes) {
          // Merge refs from externalized nodes into current nodes (keeping image data)
          const nodesWithRefs = currentNodes.map((node, index) => {
            const externalizedNode = workflow.nodes[index];
            if (!externalizedNode || node.id !== externalizedNode.id) {
              return node; // Safety check - nodes should match
            }

            // Copy refs from externalized node while keeping current image data
            // Use type assertion to access ref fields that may exist on various node types
            const mergedData = { ...node.data } as Record<string, unknown>;
            const extData = externalizedNode.data as Record<string, unknown>;

            // Copy ref fields based on node type
            if (extData.imageRef && typeof extData.imageRef === 'string') {
              mergedData.imageRef = extData.imageRef;
            }
            if (extData.sourceImageRef && typeof extData.sourceImageRef === 'string') {
              mergedData.sourceImageRef = extData.sourceImageRef;
            }
            if (extData.outputImageRef && typeof extData.outputImageRef === 'string') {
              mergedData.outputImageRef = extData.outputImageRef;
            }
            if (extData.inputImageRefs && Array.isArray(extData.inputImageRefs)) {
              mergedData.inputImageRefs = extData.inputImageRefs;
            }

            return { ...node, data: mergedData as WorkflowNodeData } as WorkflowNode;
          });

          set({
            nodes: nodesWithRefs,
            lastSavedAt: timestamp,
            hasUnsavedChanges: false,
            // Update imageRefBasePath to reflect new save location
            imageRefBasePath: saveDirectoryPath,
          });
        } else {
          set({
            lastSavedAt: timestamp,
            hasUnsavedChanges: false,
            // Update imageRefBasePath to reflect save location
            imageRefBasePath: useExternalImageStorage ? saveDirectoryPath : null,
          });
        }

        // Update localStorage
        saveSaveConfig({
          workflowId,
          name: workflowName,
          directoryPath: saveDirectoryPath,
          generationsPath: get().generationsPath,
          lastSavedAt: timestamp,
          useExternalImageStorage,
        });

        return true;
      } else {
        useToast.getState().show(`Auto-save failed: ${result.error}`, "error");
        return false;
      }
    } catch (error) {
      useToast
        .getState()
        .show(
          `Auto-save failed: ${error instanceof Error ? error.message : "Unknown error"}`,
          "error"
        );
      return false;
    } finally {
      set({ isSaving: false });
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

  // Keyboard shortcuts dialog actions
  setShortcutsDialogOpen: (open: boolean) => {
    set({ shortcutsDialogOpen: open });
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

  // Comment navigation actions
  getNodesWithComments: () => {
    const { nodes } = get();
    // Filter nodes that have comments
    const nodesWithComments = nodes.filter((node) => {
      const data = node.data as { comment?: string };
      return data.comment && data.comment.trim().length > 0;
    });

    // Sort by position: top-to-bottom (Y), then left-to-right (X)
    // Use 50px threshold for row grouping
    const ROW_THRESHOLD = 50;
    return nodesWithComments.sort((a, b) => {
      // Check if nodes are in the same "row" (within threshold)
      const yDiff = a.position.y - b.position.y;
      if (Math.abs(yDiff) <= ROW_THRESHOLD) {
        // Same row, sort by X position
        return a.position.x - b.position.x;
      }
      // Different rows, sort by Y position
      return yDiff;
    });
  },

  getUnviewedCommentCount: () => {
    const { viewedCommentNodeIds } = get();
    const nodesWithComments = get().getNodesWithComments();
    return nodesWithComments.filter((node) => !viewedCommentNodeIds.has(node.id)).length;
  },

  markCommentViewed: (nodeId: string) => {
    set((state) => {
      const newViewedSet = new Set(state.viewedCommentNodeIds);
      newViewedSet.add(nodeId);
      return { viewedCommentNodeIds: newViewedSet };
    });
  },

  setNavigationTarget: (nodeId: string | null) => {
    if (nodeId === null) {
      set({ navigationTarget: null });
    } else {
      // Use timestamp to ensure each navigation triggers a new effect even if same node
      set({ navigationTarget: { nodeId, timestamp: Date.now() } });
      // Also focus the comment tooltip on the target node
      set({ focusedCommentNodeId: nodeId });
    }
  },

  setFocusedCommentNodeId: (nodeId: string | null) => {
    set({ focusedCommentNodeId: nodeId });
  },

  resetViewedComments: () => {
    set({ viewedCommentNodeIds: new Set<string>() });
  },

  // AI change snapshot actions
  captureSnapshot: () => {
    const state = get();
    // Deep copy the current workflow state to avoid reference sharing
    const snapshot = {
      nodes: JSON.parse(JSON.stringify(state.nodes)),
      edges: JSON.parse(JSON.stringify(state.edges)),
      groups: JSON.parse(JSON.stringify(state.groups)),
      edgeStyle: state.edgeStyle,
    };
    set({
      previousWorkflowSnapshot: snapshot,
      manualChangeCount: 0,
    });
  },

  revertToSnapshot: () => {
    const state = get();
    if (state.previousWorkflowSnapshot) {
      set({
        nodes: state.previousWorkflowSnapshot.nodes,
        edges: state.previousWorkflowSnapshot.edges,
        groups: state.previousWorkflowSnapshot.groups,
        edgeStyle: state.previousWorkflowSnapshot.edgeStyle,
        previousWorkflowSnapshot: null,
        manualChangeCount: 0,
        hasUnsavedChanges: true,
      });
    }
  },

  clearSnapshot: () => {
    set({
      previousWorkflowSnapshot: null,
      manualChangeCount: 0,
    });
  },

  incrementManualChangeCount: () => {
    const state = get();
    const newCount = state.manualChangeCount + 1;

    // Automatically clear snapshot after 3 manual changes
    if (newCount >= 3) {
      set({
        previousWorkflowSnapshot: null,
        manualChangeCount: 0,
      });
    } else {
      set({ manualChangeCount: newCount });
    }
  },

  applyEditOperations: (operations) => {
    const state = get();
    const result = executeEditOps(operations, {
      nodes: state.nodes,
      edges: state.edges,
    });

    set({
      nodes: result.nodes,
      edges: result.edges,
      hasUnsavedChanges: true,
    });

    return { applied: result.applied, skipped: result.skipped };
  },

  // Canvas navigation settings actions
  updateCanvasNavigationSettings: (settings: CanvasNavigationSettings) => {
    set({ canvasNavigationSettings: settings });
    saveCanvasNavigationSettings(settings);
  },
}));

/**
 * Stable hook for provider API keys.
 *
 * Returns individual primitive values for each provider's API key.
 * Uses shallow equality comparison to prevent re-renders when the
 * providerSettings object reference changes but the actual key values
 * don't change.
 *
 * This prevents unnecessary re-fetches of /api/models when multiple
 * node instances subscribe to provider settings.
 */
export function useProviderApiKeys() {
  return useWorkflowStore(
    useShallow((state) => ({
      replicateApiKey: state.providerSettings.providers.replicate?.apiKey ?? null,
      falApiKey: state.providerSettings.providers.fal?.apiKey ?? null,
      kieApiKey: state.providerSettings.providers.kie?.apiKey ?? null,
      wavespeedApiKey: state.providerSettings.providers.wavespeed?.apiKey ?? null,
      // Provider enabled states (for conditional UI)
      replicateEnabled: state.providerSettings.providers.replicate?.enabled ?? false,
      kieEnabled: state.providerSettings.providers.kie?.enabled ?? false,
    }))
  );
}
