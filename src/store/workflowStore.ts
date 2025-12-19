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
  LLMGenerateNodeData,
  OutputNodeData,
  WorkflowNodeData,
  ImageHistoryItem,
  WorkflowSaveConfig,
  NodeGroup,
  GroupColor,
} from "@/types";
import { useToast } from "@/components/Toast";

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
  addNode: (type: NodeType, position: XYPosition) => string;
  updateNodeData: (nodeId: string, data: Partial<WorkflowNodeData>) => void;
  removeNode: (nodeId: string) => void;
  onNodesChange: (changes: NodeChange<WorkflowNode>[]) => void;

  // Edge operations
  onEdgesChange: (changes: EdgeChange<WorkflowEdge>[]) => void;
  onConnect: (connection: Connection) => void;
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
  moveGroupNodes: (groupId: string, delta: { x: number; y: number }) => void;
  setNodeGroupId: (nodeId: string, groupId: string | undefined) => void;

  // Execution
  isRunning: boolean;
  currentNodeId: string | null;
  pausedAtNodeId: string | null;
  executeWorkflow: (startFromNodeId?: string) => Promise<void>;
  regenerateNode: (nodeId: string) => Promise<void>;
  stopWorkflow: () => void;

  // Save/Load
  saveWorkflow: (name?: string) => void;
  loadWorkflow: (workflow: WorkflowFile) => void;
  clearWorkflow: () => void;

  // Helpers
  getNodeById: (id: string) => WorkflowNode | undefined;
  getConnectedInputs: (nodeId: string) => { images: string[]; text: string | null };
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

  // Auto-save actions
  setWorkflowMetadata: (id: string, name: string, path: string, generationsPath: string | null) => void;
  setWorkflowName: (name: string) => void;
  setGenerationsPath: (path: string | null) => void;
  setAutoSaveEnabled: (enabled: boolean) => void;
  markAsUnsaved: () => void;
  saveToFile: () => Promise<boolean>;
  initializeAutoSave: () => void;
  cleanupAutoSave: () => void;
}

const createDefaultNodeData = (type: NodeType): WorkflowNodeData => {
  switch (type) {
    case "imageInput":
      return {
        image: null,
        filename: null,
        dimensions: null,
      } as ImageInputNodeData;
    case "annotation":
      return {
        sourceImage: null,
        annotations: [],
        outputImage: null,
      } as AnnotationNodeData;
    case "prompt":
      return {
        prompt: "",
      } as PromptNodeData;
    case "nanoBanana":
      return {
        inputImages: [],
        inputPrompt: null,
        outputImage: null,
        aspectRatio: "1:1",
        resolution: "1K",
        model: "nano-banana-pro",
        useGoogleSearch: false,
        size: "1024x1024",
        gptImageSize: "1024x1024",
        gptImageQuality: "medium",
        status: "idle",
        error: null,
      } as NanoBananaNodeData;
    case "llmGenerate":
      return {
        inputPrompt: null,
        outputText: null,
        provider: "google",
        model: "gemini-2.5-flash",
        temperature: 0.7,
        maxTokens: 1024,
        status: "idle",
        error: null,
      } as LLMGenerateNodeData;
    case "output":
      return {
        image: null,
      } as OutputNodeData;
  }
};

let nodeIdCounter = 0;
let groupIdCounter = 0;
let autoSaveIntervalId: ReturnType<typeof setInterval> | null = null;

// Group color palette (dark mode tints)
export const GROUP_COLORS: Record<GroupColor, string> = {
  neutral: "#262626",
  blue: "#1e3a5f",
  green: "#1a3d2e",
  purple: "#2d2458",
  orange: "#3d2a1a",
  red: "#3d1a1a",
};

const GROUP_COLOR_ORDER: GroupColor[] = [
  "neutral", "blue", "green", "purple", "orange", "red"
];

// localStorage helpers for auto-save configs
const STORAGE_KEY = "node-banana-workflow-configs";

const generateWorkflowId = () =>
  `wf_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

const loadSaveConfigs = (): Record<string, WorkflowSaveConfig> => {
  if (typeof window === "undefined") return {};
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored ? JSON.parse(stored) : {};
};

const saveSaveConfig = (config: WorkflowSaveConfig) => {
  if (typeof window === "undefined") return;
  const configs = loadSaveConfigs();
  configs[config.workflowId] = config;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(configs));
};

export { generateWorkflowId };

export const useWorkflowStore = create<WorkflowStore>((set, get) => ({
  nodes: [],
  edges: [],
  edgeStyle: "curved" as EdgeStyle,
  clipboard: null,
  groups: {},
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

  setEdgeStyle: (style: EdgeStyle) => {
    set({ edgeStyle: style });
  },

  addNode: (type: NodeType, position: XYPosition) => {
    const id = `${type}-${++nodeIdCounter}`;

    // Default dimensions based on node type
    const defaultDimensions: Record<NodeType, { width: number; height: number }> = {
      imageInput: { width: 300, height: 280 },
      annotation: { width: 300, height: 280 },
      prompt: { width: 320, height: 220 },
      nanoBanana: { width: 300, height: 300 },
      llmGenerate: { width: 320, height: 360 },
      output: { width: 320, height: 320 },
    };

    const { width, height } = defaultDimensions[type];

    const newNode: WorkflowNode = {
      id,
      type,
      position,
      data: createDefaultNodeData(type),
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
    set((state) => ({
      nodes: applyNodeChanges(changes, state.nodes),
      ...(hasMeaningfulChange ? { hasUnsavedChanges: true } : {}),
    }));
  },

  onEdgesChange: (changes: EdgeChange<WorkflowEdge>[]) => {
    // Only mark as unsaved for meaningful changes (not selection changes)
    const hasMeaningfulChange = changes.some((c) => c.type !== "select");
    set((state) => ({
      edges: applyEdgeChanges(changes, state.edges),
      ...(hasMeaningfulChange ? { hasUnsavedChanges: true } : {}),
    }));
  },

  onConnect: (connection: Connection) => {
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

  removeEdge: (edgeId: string) => {
    set((state) => ({
      edges: state.edges.filter((edge) => edge.id !== edgeId),
      hasUnsavedChanges: true,
    }));
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

    // Default dimensions per node type
    const defaultNodeDimensions: Record<string, { width: number; height: number }> = {
      imageInput: { width: 300, height: 280 },
      annotation: { width: 300, height: 280 },
      prompt: { width: 320, height: 220 },
      nanoBanana: { width: 300, height: 300 },
      llmGenerate: { width: 320, height: 360 },
      output: { width: 320, height: 320 },
    };

    // Calculate bounding box of selected nodes
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodesToGroup.forEach((node) => {
      // Use measured dimensions (actual rendered size) first, then style, then type-specific defaults
      const defaults = defaultNodeDimensions[node.type] || { width: 300, height: 280 };
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

    edges
      .filter((edge) => edge.target === nodeId)
      .forEach((edge) => {
        const sourceNode = nodes.find((n) => n.id === edge.source);
        if (!sourceNode) return;

        const handleId = edge.targetHandle;

        if (handleId === "image" || !handleId) {
          // Get image from source node - collect all connected images
          if (sourceNode.type === "imageInput") {
            const sourceImage = (sourceNode.data as ImageInputNodeData).image;
            if (sourceImage) images.push(sourceImage);
          } else if (sourceNode.type === "annotation") {
            const sourceImage = (sourceNode.data as AnnotationNodeData).outputImage;
            if (sourceImage) images.push(sourceImage);
          } else if (sourceNode.type === "nanoBanana") {
            const sourceImage = (sourceNode.data as NanoBananaNodeData).outputImage;
            if (sourceImage) images.push(sourceImage);
          }
        }

        if (handleId === "text") {
          if (sourceNode.type === "prompt") {
            text = (sourceNode.data as PromptNodeData).prompt;
          } else if (sourceNode.type === "llmGenerate") {
            text = (sourceNode.data as LLMGenerateNodeData).outputText;
          }
        }
      });

    return { images, text };
  },

  validateWorkflow: () => {
    const { nodes, edges } = get();
    const errors: string[] = [];

    // Check if there are any nodes
    if (nodes.length === 0) {
      errors.push("Workflow is empty");
      return { valid: false, errors };
    }

    // Check each Nano Banana node has required inputs
    nodes
      .filter((n) => n.type === "nanoBanana")
      .forEach((node) => {
        const imageConnected = edges.some(
          (e) => e.target === node.id && e.targetHandle === "image"
        );
        const textConnected = edges.some(
          (e) => e.target === node.id && e.targetHandle === "text"
        );

        if (!imageConnected) {
          errors.push(`Generate node "${node.id}" missing image input`);
        }
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
    const { nodes, edges, updateNodeData, getConnectedInputs, isRunning } = get();

    if (isRunning) {
      return;
    }

    const isResuming = startFromNodeId === get().pausedAtNodeId;
    set({ isRunning: true, pausedAtNodeId: null });

    // Topological sort
    const sorted: WorkflowNode[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (nodeId: string) => {
      if (visited.has(nodeId)) return;
      if (visiting.has(nodeId)) {
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
            set({ pausedAtNodeId: node.id, isRunning: false, currentNodeId: null });
            useToast.getState().show("Workflow paused - click Run to continue", "warning");
            return;
          }
        }

        set({ currentNodeId: node.id });

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
            const { images, text } = getConnectedInputs(node.id);

            if (images.length === 0 || !text) {
              updateNodeData(node.id, {
                status: "error",
                error: "Missing image or text input",
              });
              set({ isRunning: false, currentNodeId: null });
              return;
            }

            updateNodeData(node.id, {
              inputImages: images,
              inputPrompt: text,
              status: "loading",
              error: null,
            });

            try {
              const nodeData = node.data as NanoBananaNodeData;

              const requestPayload = {
                images,
                prompt: text,
                aspectRatio: nodeData.aspectRatio,
                resolution: nodeData.resolution,
                model: nodeData.model,
                useGoogleSearch: nodeData.useGoogleSearch,
                size: nodeData.size,
                gptImageSize: nodeData.gptImageSize,
                gptImageQuality: nodeData.gptImageQuality,
              };

              const response = await fetch("/api/generate", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
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

                updateNodeData(node.id, {
                  status: "error",
                  error: errorMessage,
                });
                set({ isRunning: false, currentNodeId: null });
                return;
              }

              const result = await response.json();

              if (result.success && result.image) {
                // Save the newly generated image to global history
                get().addToGlobalHistory({
                  image: result.image,
                  timestamp: Date.now(),
                  prompt: text,
                  aspectRatio: nodeData.aspectRatio,
                  model: nodeData.model,
                });
                updateNodeData(node.id, {
                  outputImage: result.image,
                  status: "complete",
                  error: null,
                });

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
                    }),
                  }).catch((err) => {
                    console.error("Failed to save generation:", err);
                  });
                }
              } else {
                updateNodeData(node.id, {
                  status: "error",
                  error: result.error || "Generation failed",
                });
                set({ isRunning: false, currentNodeId: null });
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

              updateNodeData(node.id, {
                status: "error",
                error: errorMessage,
              });
              set({ isRunning: false, currentNodeId: null });
              return;
            }
            break;
          }

          case "llmGenerate": {
            const { text } = getConnectedInputs(node.id);

            if (!text) {
              updateNodeData(node.id, {
                status: "error",
                error: "Missing text input",
              });
              set({ isRunning: false, currentNodeId: null });
              return;
            }

            updateNodeData(node.id, {
              inputPrompt: text,
              status: "loading",
              error: null,
            });

            try {
              const nodeData = node.data as LLMGenerateNodeData;
              const response = await fetch("/api/llm", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  prompt: text,
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
                updateNodeData(node.id, {
                  status: "error",
                  error: errorMessage,
                });
                set({ isRunning: false, currentNodeId: null });
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
                updateNodeData(node.id, {
                  status: "error",
                  error: result.error || "LLM generation failed",
                });
                set({ isRunning: false, currentNodeId: null });
                return;
              }
            } catch (error) {
              updateNodeData(node.id, {
                status: "error",
                error: error instanceof Error ? error.message : "LLM generation failed",
              });
              set({ isRunning: false, currentNodeId: null });
              return;
            }
            break;
          }

          case "output": {
            const { images } = getConnectedInputs(node.id);
            const image = images[0] || null;
            if (image) {
              updateNodeData(node.id, { image });
            }
            break;
          }
        }
      }

      set({ isRunning: false, currentNodeId: null });
    } catch {
      set({ isRunning: false, currentNodeId: null });
    }
  },

  stopWorkflow: () => {
    set({ isRunning: false, currentNodeId: null });
  },

  regenerateNode: async (nodeId: string) => {
    const { nodes, updateNodeData, getConnectedInputs, isRunning } = get();

    if (isRunning) {
      return;
    }

    const node = nodes.find((n) => n.id === nodeId);
    if (!node) {
      return;
    }

    set({ isRunning: true, currentNodeId: nodeId });

    try {
      if (node.type === "nanoBanana") {
        const nodeData = node.data as NanoBananaNodeData;

        // Always get fresh connected inputs first, fall back to stored inputs only if not connected
        const inputs = getConnectedInputs(nodeId);
        let images = inputs.images.length > 0 ? inputs.images : nodeData.inputImages;
        let text = inputs.text ?? nodeData.inputPrompt;

        if (!images || images.length === 0 || !text) {
          updateNodeData(nodeId, {
            status: "error",
            error: "Missing image or text input",
          });
          set({ isRunning: false, currentNodeId: null });
          return;
        }

        updateNodeData(nodeId, {
          status: "loading",
          error: null,
        });

        const response = await fetch("/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            images,
            prompt: text,
            aspectRatio: nodeData.aspectRatio,
            resolution: nodeData.resolution,
            model: nodeData.model,
            useGoogleSearch: nodeData.useGoogleSearch,
            size: nodeData.size,
            gptImageSize: nodeData.gptImageSize,
            gptImageQuality: nodeData.gptImageQuality,
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
          updateNodeData(nodeId, { status: "error", error: errorMessage });
          set({ isRunning: false, currentNodeId: null });
          return;
        }

        const result = await response.json();
        if (result.success && result.image) {
          // Save the newly generated image to global history
          get().addToGlobalHistory({
            image: result.image,
            timestamp: Date.now(),
            prompt: text,
            aspectRatio: nodeData.aspectRatio,
            model: nodeData.model,
          });
          updateNodeData(nodeId, {
            outputImage: result.image,
            status: "complete",
            error: null,
          });

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

        // Always get fresh connected input first, fall back to stored input only if not connected
        const inputs = getConnectedInputs(nodeId);
        const text = inputs.text ?? nodeData.inputPrompt;

        if (!text) {
          updateNodeData(nodeId, {
            status: "error",
            error: "Missing text input",
          });
          set({ isRunning: false, currentNodeId: null });
          return;
        }

        updateNodeData(nodeId, {
          status: "loading",
          error: null,
        });

        const response = await fetch("/api/llm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: text,
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
          updateNodeData(nodeId, { status: "error", error: errorMessage });
          set({ isRunning: false, currentNodeId: null });
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
          updateNodeData(nodeId, {
            status: "error",
            error: result.error || "LLM generation failed",
          });
        }
      }

      set({ isRunning: false, currentNodeId: null });
    } catch (error) {
      updateNodeData(nodeId, {
        status: "error",
        error: error instanceof Error ? error.message : "Regeneration failed",
      });
      set({ isRunning: false, currentNodeId: null });
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

  loadWorkflow: (workflow: WorkflowFile) => {
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

    // Look up saved config from localStorage (only if workflow has an ID)
    const configs = loadSaveConfigs();
    const savedConfig = workflow.id ? configs[workflow.id] : null;

    set({
      nodes: workflow.nodes,
      edges: workflow.edges,
      edgeStyle: workflow.edgeStyle || "angular",
      groups: workflow.groups || {},
      isRunning: false,
      currentNodeId: null,
      // Restore workflow ID and paths from localStorage if available
      workflowId: workflow.id || null,
      workflowName: workflow.name,
      saveDirectoryPath: savedConfig?.directoryPath || null,
      generationsPath: savedConfig?.generationsPath || null,
      lastSavedAt: savedConfig?.lastSavedAt || null,
      hasUnsavedChanges: false,
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
  setWorkflowMetadata: (id: string, name: string, path: string, generationsPath: string | null) => {
    set({
      workflowId: id,
      workflowName: name,
      saveDirectoryPath: path,
      generationsPath: generationsPath,
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
    } = get();

    if (!workflowId || !workflowName || !saveDirectoryPath) {
      return false;
    }

    set({ isSaving: true });

    try {
      const workflow: WorkflowFile = {
        version: 1,
        id: workflowId,
        name: workflowName,
        nodes,
        edges,
        edgeStyle,
        groups: Object.keys(groups).length > 0 ? groups : undefined,
      };

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
}));
