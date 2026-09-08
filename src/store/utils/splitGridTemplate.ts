/**
 * Split Grid Template Utilities
 *
 * Pure helpers for the split-grid node's per-cell template system.
 * A template describes the set of nodes created for every split image;
 * materialization instantiates it once per grid cell as real canvas nodes,
 * wrapped in a group.
 */

import type {
  NodeType,
  WorkflowNode,
  WorkflowEdge,
  WorkflowNodeData,
  NodeGroup,
  GroupColor,
  HandleType,
  SplitGridNodeData,
  SplitGridTemplate,
  SplitGridTemplateRouterConnection,
  SplitGridCell,
} from "@/types";
import { MODEL_DISPLAY_NAMES } from "@/types";
import { getNodeSize } from "@/utils/nodeDimensions";
import {
  createDefaultNodeData,
  createDefaultSplitGridTemplate,
  defaultNodeDimensions,
  SPLIT_GRID_BASE_NODE_ID,
} from "./nodeDefaults";

export { createDefaultSplitGridTemplate, SPLIT_GRID_BASE_NODE_ID };

/** Handle types the Router node can render (mirrors RouterNode ALL_HANDLE_TYPES). */
const ROUTER_HANDLE_TYPES = new Set<HandleType>([
  "image",
  "text",
  "video",
  "audio",
  "3d",
  "easeCurve",
]);

const STATIC_OUTPUT_HANDLES: Partial<Record<NodeType, readonly HandleType[]>> = {
  imageInput: ["image"],
  audioInput: ["audio"],
  videoInput: ["video"],
  annotation: ["image"],
  prompt: ["text"],
  array: ["text"],
  promptConstructor: ["text"],
  nanoBanana: ["image"],
  generateVideo: ["video"],
  generate3d: ["3d"],
  generateAudio: ["audio"],
  llmGenerate: ["text"],
  videoStitch: ["video"],
  easeCurve: ["video", "easeCurve"],
  videoTrim: ["video"],
  videoFrameGrab: ["image"],
  removeBackground: ["image"],
  imageResize: ["image"],
  gifEncoder: ["image"],
  router: ["image", "text", "video", "audio", "3d", "easeCurve"],
  glbViewer: ["image"],
};

/**
 * Terminal→router-port connections declared on the template (empty when the
 * downstream router port is unwired). The single source of truth consumers use
 * to decide whether a shared router should be materialized.
 *
 * Connections from untrusted templates are normalized here. Structurally
 * invalid entries, unsupported or mismatched handles, missing source outputs,
 * and duplicates are discarded before hashing or materialization.
 */
export function getRouterConnections(
  template: SplitGridTemplate
): SplitGridTemplateRouterConnection[] {
  const rawConnections: unknown = template.router;
  if (!Array.isArray(rawConnections) || rawConnections.length === 0) return [];

  const nodesById = new Map(
    (Array.isArray(template.nodes) ? template.nodes : []).map((node) => [node.id, node])
  );
  const uniqueConnections = new Map<string, SplitGridTemplateRouterConnection>();

  for (const value of rawConnections) {
    if (!value || typeof value !== "object") continue;
    const connection = value as Record<string, unknown>;
    const { source, sourceHandle, targetHandle } = connection;
    if (
      typeof source !== "string" ||
      typeof sourceHandle !== "string" ||
      typeof targetHandle !== "string" ||
      sourceHandle !== targetHandle ||
      !ROUTER_HANDLE_TYPES.has(targetHandle as HandleType)
    ) {
      continue;
    }

    const sourceNode = nodesById.get(source);
    const outputs = sourceNode ? STATIC_OUTPUT_HANDLES[sourceNode.type] ?? [] : [];
    if (!outputs.includes(sourceHandle as HandleType)) continue;

    const normalized = {
      source,
      sourceHandle,
      targetHandle,
    } satisfies SplitGridTemplateRouterConnection;
    uniqueConnections.set(`${source}\u0000${sourceHandle}`, normalized);
  }

  return [...uniqueConnections.values()].sort(compareRouterConnections);
}

/** Stable ordering for router connections so hashing/serialization is deterministic. */
function compareRouterConnections(
  a: SplitGridTemplateRouterConnection,
  b: SplitGridTemplateRouterConnection
): number {
  return (
    a.source.localeCompare(b.source) ||
    a.sourceHandle.localeCompare(b.sourceHandle) ||
    a.targetHandle.localeCompare(b.targetHandle)
  );
}

export const MIN_GRID_DIMENSION = 1;
export const MAX_GRID_DIMENSION = 16;

/**
 * Normalizes a grid dimension from untrusted data (AI-generated workflows,
 * hand-edited JSON, chat edit-operations) to a valid integer. Every consumer
 * of gridRows/gridCols must clamp identically, or staleness keys drift and
 * cells rebuild on every run.
 */
export function clampGridDimension(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return MIN_GRID_DIMENSION;
  return Math.min(MAX_GRID_DIMENSION, Math.max(MIN_GRID_DIMENSION, Math.round(num)));
}

/** Smallest allowed gap between adjacent grid boundaries, as a fraction. */
export const MIN_SLICE_GAP = 0.02;

/**
 * Validates interior grid-line offsets from untrusted data. Returns the offsets
 * only when they are the right length (count-1), each boundary leaves the
 * minimum slice gap, and all values are strictly inside (0,1).
 */
export function sanitizeGridOffsets(raw: unknown, count: number): number[] | null {
  if (!Array.isArray(raw) || raw.length !== count - 1) return null;
  const nums = raw.map(Number);
  for (let i = 0; i < nums.length; i++) {
    const v = nums[i];
    if (!Number.isFinite(v) || v <= 0 || v >= 1) return null;
    const previousBoundary = i > 0 ? nums[i - 1] : 0;
    if (v - previousBoundary < MIN_SLICE_GAP) return null;
  }
  if (nums.length > 0 && 1 - nums[nums.length - 1] < MIN_SLICE_GAP) return null;
  return nums;
}

/**
 * Interior boundary offsets for `count` slices: the sanitized custom offsets, or
 * evenly spaced (1/count … (count-1)/count) when none/invalid. Length count-1.
 */
export function resolveGridOffsets(count: number, raw: unknown): number[] {
  const clean = sanitizeGridOffsets(raw, count);
  if (clean) return clean;
  return Array.from({ length: Math.max(0, count - 1) }, (_, i) => (i + 1) / count);
}

/** Full boundary list [0, …interior, 1] for `count` slices. Length count+1. */
export function gridBoundaries(count: number, offsets: number[]): number[] {
  return [0, ...offsets, 1];
}

/** Per-slice size fractions (summing to 1) from interior offsets. Length count. */
export function gridFractions(count: number, offsets: number[]): number[] {
  const bounds = gridBoundaries(count, offsets);
  return Array.from({ length: count }, (_, i) => bounds[i + 1] - bounds[i]);
}

/**
 * The classic pre-template layout: image + prompt feeding a generate node.
 * Optional legacy generate settings become overrides on the generate node.
 */
export function createClassicSplitGridTemplate(
  defaultPrompt = "",
  generateSettings?: SplitGridNodeData["generateSettings"]
): SplitGridTemplate {
  const generateOverrides = generateSettings
    ? {
        ...generateSettings,
        selectedModel: {
          provider: "gemini",
          modelId: generateSettings.model,
          displayName: MODEL_DISPLAY_NAMES[generateSettings.model] || generateSettings.model,
        },
      }
    : undefined;
  return {
    baseNodeId: SPLIT_GRID_BASE_NODE_ID,
    nodes: [
      {
        id: SPLIT_GRID_BASE_NODE_ID,
        type: "imageInput",
        position: { x: 0, y: 0 },
      },
      {
        id: "cell-prompt",
        type: "prompt",
        position: { x: 0, y: 310 },
        data: defaultPrompt ? { prompt: defaultPrompt } : undefined,
      },
      {
        id: "cell-generate",
        type: "nanoBanana",
        position: { x: 340, y: 0 },
        data: generateOverrides,
      },
    ],
    edges: [
      {
        id: "cell-image-generate",
        source: SPLIT_GRID_BASE_NODE_ID,
        sourceHandle: "image",
        target: "cell-generate",
        targetHandle: "image",
      },
      {
        id: "cell-prompt-generate",
        source: "cell-prompt",
        sourceHandle: "text",
        target: "cell-generate",
        targetHandle: "text",
      },
    ],
  };
}

/**
 * Returns the node's template. Legacy saves that predate templates map onto
 * the classic image+prompt+generate layout (so the editor reflects what the
 * node actually built); anything else falls back to the image-only default.
 */
export function getSplitGridTemplate(data: SplitGridNodeData): SplitGridTemplate {
  // A template whose base node is missing would materialize cells that can
  // never be populated (and re-materialize on every run) — treat as invalid.
  if (
    data.template &&
    data.template.nodes.some((node) => node.id === data.template!.baseNodeId)
  ) {
    return data.template;
  }
  if (hasLegacyCellsOnly(data)) {
    return createClassicSplitGridTemplate(data.defaultPrompt, data.generateSettings);
  }
  return createDefaultSplitGridTemplate();
}

/**
 * Stable staleness key for a rows/cols/template configuration.
 */
export function computeMaterializedKey(
  rows: number,
  cols: number,
  template: SplitGridTemplate
): string {
  // Only fold the router in when present, so legacy/no-router templates hash to
  // the exact same string as before this feature and never spuriously rebuild.
  // Use the validated set so malformed entries don't drift the key.
  const connections = getRouterConnections(template);
  const router =
    connections.length > 0 ? [...connections].sort(compareRouterConnections) : null;
  return JSON.stringify({
    rows,
    cols,
    baseNodeId: template.baseNodeId,
    nodes: [...template.nodes].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...template.edges].sort((a, b) => a.id.localeCompare(b.id)),
    ...(router ? { router } : {}),
  });
}

/**
 * Returns materialized cells, mapping legacy childNodeIds onto the cell shape
 * for workflows saved before templates existed.
 */
export function getSplitGridCells(data: SplitGridNodeData): SplitGridCell[] {
  if (data.cells && data.cells.length > 0) return data.cells;
  if (Array.isArray(data.childNodeIds) && data.childNodeIds.length > 0) {
    return data.childNodeIds.map((child) => ({
      baseImageNodeId: child.imageInput,
      nodeIds: [child.imageInput, child.prompt, child.nanoBanana].filter(Boolean),
    }));
  }
  return [];
}

/**
 * True when the node tracks cells via the legacy childNodeIds field only.
 * Legacy cells are populated in place and never auto-rebuilt — until the user
 * saves a template, which upgrades the node to the cells-based flow.
 */
export function hasLegacyCellsOnly(data: SplitGridNodeData): boolean {
  return (
    (data.cells?.length ?? 0) === 0 &&
    Array.isArray(data.childNodeIds) &&
    data.childNodeIds.length > 0
  );
}

/**
 * True when the node's materialized cells no longer match its current
 * rows/cols/template configuration (or were never created).
 *
 * `ignoreLegacy` skips the legacy-cells guard: used when the user explicitly
 * saves a template, upgrading a legacy node to the cells-based flow.
 * `template` evaluates against a not-yet-saved template (editor apply).
 */
export function needsMaterialization(
  data: SplitGridNodeData,
  existingNodeIds: Set<string>,
  options?: {
    ignoreLegacy?: boolean;
    template?: SplitGridTemplate;
    existingRouterNodeIds?: Set<string>;
  }
): boolean {
  const rows = clampGridDimension(data.gridRows);
  const cols = clampGridDimension(data.gridCols);
  if (hasLegacyCellsOnly(data) && !options?.template) {
    if (options?.ignoreLegacy) return true;
    // Legacy cells populate in place while the grid still matches them;
    // a rows/cols change requires a rebuild or the slices would misalign
    return data.childNodeIds.length !== rows * cols;
  }
  const cells = data.cells ?? [];
  if (cells.length === 0) return true;
  const template = options?.template ?? getSplitGridTemplate(data);
  // A wired downstream router must exist. If it was manually deleted on the
  // canvas (or a save is missing it) the cells can still match, so rebuild to
  // restore the router and its terminal wiring.
  if (
    getRouterConnections(template).length > 0 &&
    (!data.routerNodeId ||
      !(options?.existingRouterNodeIds ?? existingNodeIds).has(data.routerNodeId))
  ) {
    return true;
  }
  const key = computeMaterializedKey(rows, cols, template);
  if (data.materializedKey !== key) return true;
  if (cells.length !== rows * cols) return true;
  // A partially deleted grid is intentional pruning; rebuild only when every
  // cell's base image node is gone
  return cells.every((cell) => !existingNodeIds.has(cell.baseImageNodeId));
}

export interface BuildCellInstancesOptions {
  splitNode: WorkflowNode;
  template: SplitGridTemplate;
  rows: number;
  cols: number;
  makeNodeId: (type: NodeType) => string;
  makeGroupId: () => string;
  groupColor: GroupColor;
  makeEdgeData: (connection: {
    source: string;
    sourceHandle: string;
    target: string;
    targetHandle: string;
  }) => Record<string, unknown>;
  /**
   * Real id of the shared downstream router. When set (and the template wires
   * one or more terminals to the router port), each cell's copy of every wired
   * terminal is connected into this single router. The router node itself is
   * created/reused by the store, not here.
   */
  routerNodeId?: string | null;
}

export interface CellInstancesResult {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  groups: Record<string, NodeGroup>;
  cells: SplitGridCell[];
  /** Per-cell terminal→router edges (empty when no router is wired). */
  routerEdges: WorkflowEdge[];
  /** Where to place the single shared router (right of the grid, centered); null when none. */
  routerPosition: { x: number; y: number } | null;
}

const CLUSTER_GAP = 60;
const SPLIT_NODE_MARGIN = 100;
const GROUP_PADDING = 20;
/** Horizontal gap between the rightmost cell group and the shared router. */
const ROUTER_GAP = 160;

function templateNodeDimensions(
  templateNode: Pick<SplitGridTemplate["nodes"][number], "type" | "size">
): { width: number; height: number } {
  return templateNode.size ?? defaultNodeDimensions[templateNode.type] ?? { width: 300, height: 280 };
}

/**
 * Instantiates the template once per grid cell, producing real nodes, edges
 * (intra-cell wiring + a reference edge from the split node to each cell's
 * base image node), and one group per cell.
 */
export function buildCellInstances(options: BuildCellInstancesOptions): CellInstancesResult {
  const { splitNode, template, rows, cols, makeNodeId, makeGroupId, groupColor, makeEdgeData } =
    options;
  // The shared router is only wired when the store supplies its id AND the
  // template designates at least one terminal for the port.
  const routerConnections = options.routerNodeId ? getRouterConnections(template) : [];
  const routerEnabled = Boolean(options.routerNodeId) && routerConnections.length > 0;

  // Template bounding box (normalizes arbitrary editor positions to offsets)
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const templateNode of template.nodes) {
    const { width, height } = templateNodeDimensions(templateNode);
    minX = Math.min(minX, templateNode.position.x);
    minY = Math.min(minY, templateNode.position.y);
    maxX = Math.max(maxX, templateNode.position.x + width);
    maxY = Math.max(maxY, templateNode.position.y + height);
  }
  const clusterWidth = maxX - minX;
  const clusterHeight = maxY - minY;

  const splitWidth =
    (splitNode.style?.width as number) ??
    splitNode.measured?.width ??
    templateNodeDimensions({ type: "splitGrid" }).width;
  const startX = splitNode.position.x + splitWidth + SPLIT_NODE_MARGIN;
  const startY = splitNode.position.y;

  const nodes: WorkflowNode[] = [];
  const edges: WorkflowEdge[] = [];
  const groups: Record<string, NodeGroup> = {};
  const cells: SplitGridCell[] = [];
  const routerEdges: WorkflowEdge[] = [];

  for (let index = 0; index < rows * cols; index++) {
    const row = Math.floor(index / cols);
    const col = index % cols;
    const originX = startX + col * (clusterWidth + GROUP_PADDING * 2 + CLUSTER_GAP);
    const originY = startY + row * (clusterHeight + GROUP_PADDING * 2 + CLUSTER_GAP);

    // Instantiate nodes
    const idMap = new Map<string, string>();
    const groupId = makeGroupId();
    for (const templateNode of template.nodes) {
      const nodeId = makeNodeId(templateNode.type);
      idMap.set(templateNode.id, nodeId);
      const { width, height } = templateNodeDimensions(templateNode);
      const defaultData = createDefaultNodeData(templateNode.type);
      const data = templateNode.data
        ? ({ ...defaultData, ...templateNode.data } as WorkflowNodeData)
        : defaultData;
      nodes.push({
        id: nodeId,
        type: templateNode.type,
        position: {
          x: originX + (templateNode.position.x - minX),
          y: originY + (templateNode.position.y - minY),
        },
        data,
        width,
        style: { width },
        // Initial layout hint only; React Flow replaces this with the full shell measurement.
        measured: { width, height },
        groupId,
      });
    }

    // Intra-cell edges
    for (const templateEdge of template.edges) {
      const source = idMap.get(templateEdge.source);
      const target = idMap.get(templateEdge.target);
      if (!source || !target) continue;
      const connection = {
        source,
        sourceHandle: templateEdge.sourceHandle,
        target,
        targetHandle: templateEdge.targetHandle,
      };
      edges.push({
        id: `edge-${source}-${target}-${templateEdge.sourceHandle}-${templateEdge.targetHandle}`,
        ...connection,
        data: makeEdgeData(connection),
      } as WorkflowEdge);
    }

    // Reference edge from the split node to this cell's base image node
    const baseImageNodeId = idMap.get(template.baseNodeId);
    if (baseImageNodeId) {
      const referenceConnection = {
        source: splitNode.id,
        sourceHandle: "reference",
        target: baseImageNodeId,
        targetHandle: "reference",
      };
      edges.push({
        id: `edge-${splitNode.id}-${baseImageNodeId}-reference-reference`,
        ...referenceConnection,
        type: "reference",
        data: makeEdgeData(referenceConnection),
      } as WorkflowEdge);
    }

    // Wire this cell's copy of each designated terminal into the single shared
    // router (all cells fan into one router; targetHandle is the typed router
    // input so RouterNode derives the correct handle).
    if (routerEnabled) {
      for (const conn of routerConnections) {
        const terminalRealId = idMap.get(conn.source);
        if (!terminalRealId) continue;
        const routerConnection = {
          source: terminalRealId,
          sourceHandle: conn.sourceHandle,
          target: options.routerNodeId!,
          targetHandle: conn.targetHandle,
        };
        routerEdges.push({
          id: `edge-${terminalRealId}-${options.routerNodeId}-${conn.sourceHandle}-${conn.targetHandle}`,
          ...routerConnection,
          data: makeEdgeData(routerConnection),
        } as WorkflowEdge);
      }
    }

    // Group wrapping the cell
    groups[groupId] = {
      id: groupId,
      name: `Cell ${row + 1}-${col + 1}`,
      color: groupColor,
      position: { x: originX - GROUP_PADDING, y: originY - GROUP_PADDING },
      size: {
        width: clusterWidth + GROUP_PADDING * 2,
        height: clusterHeight + GROUP_PADDING * 2,
      },
    };

    cells.push({
      baseImageNodeId: baseImageNodeId ?? "",
      nodeIds: template.nodes.map((templateNode) => idMap.get(templateNode.id)!),
      groupId,
    });
  }

  // Place the single shared router to the right of the whole grid, vertically
  // centered on the cell groups (whose bounds already include GROUP_PADDING).
  let routerPosition: { x: number; y: number } | null = null;
  const groupFrames = Object.values(groups);
  if (routerEnabled && groupFrames.length > 0) {
    let gridMaxX = -Infinity;
    let gridMinY = Infinity;
    let gridMaxY = -Infinity;
    for (const group of groupFrames) {
      gridMaxX = Math.max(gridMaxX, group.position.x + group.size.width);
      gridMinY = Math.min(gridMinY, group.position.y);
      gridMaxY = Math.max(gridMaxY, group.position.y + group.size.height);
    }
    const routerHeight = defaultNodeDimensions.router.height;
    routerPosition = {
      x: gridMaxX + ROUTER_GAP,
      y: (gridMinY + gridMaxY) / 2 - routerHeight / 2,
    };
  }

  return { nodes, edges, groups, cells, routerEdges, routerPosition };
}

/**
 * Keep generated cells readable when content (including detached controls) changes size.
 * Only measurement changes trigger this: dragging a node remains a user edit.
 * Preserve existing gaps and horizontal placement, then fit the group frames
 * and move lower cell groups out of the way. Never re-create nodes or wiring.
 */
export function fitSplitGridCellMeasurements(
  previousNodes: WorkflowNode[],
  nodes: WorkflowNode[],
  groups: Record<string, NodeGroup>,
  changedIds: Set<string>
): { nodes: WorkflowNode[]; groups: Record<string, NodeGroup> } {
  const previousById = new Map(previousNodes.map((node) => [node.id, node]));
  const nextById = new Map(nodes.map((node) => [node.id, node]));
  let nextGroups = groups;
  const overlapsX = (x: number, width: number, otherX: number, otherWidth: number) =>
    x < otherX + otherWidth && otherX < x + width;

  for (const split of nodes) {
    if (split.type !== "splitGrid") continue;
    const cells = getSplitGridCells(split.data as SplitGridNodeData);
    if (!cells.some((cell) => cell.nodeIds.some((id) => changedIds.has(id)))) continue;
    const cellGroupIds = new Set(cells.map((cell) => cell.groupId).filter((id): id is string => Boolean(id)));
    const frames = Object.values(groups)
      .filter((group) => cellGroupIds.has(group.id))
      .sort((a, b) => a.position.y - b.position.y);

    for (const frame of frames) {
      // Include user-added members so fitting cannot leave them outside the frame.
      const members = nodes.filter((node) => node.groupId === frame.id)
        .sort((a, b) => a.position.y - b.position.y);
      if (members.length === 0) continue;
      const fitted: WorkflowNode[] = [];
      for (const member of members) {
        const previous = previousById.get(member.id) ?? member;
        let y = -Infinity;
        for (const upper of fitted) {
          const oldUpper = previousById.get(upper.id) ?? upper;
          const oldSize = getNodeSize(oldUpper);
          const oldGap = previous.position.y - (oldUpper.position.y + oldSize.height);
          if (previous.position.y <= oldUpper.position.y ||
              !overlapsX(member.position.x, getNodeSize(member).width, upper.position.x, getNodeSize(upper).width)) continue;
          // Preserve deliberate overlapping layouts unless the upper node grew.
          const grew = getNodeSize(upper).height > oldSize.height || upper.position.y > oldUpper.position.y;
          if (oldGap < 0 && !grew) continue;
          y = Math.max(y, upper.position.y + getNodeSize(upper).height + (oldGap < 0 ? 32 : oldGap));
        }
        if (!Number.isFinite(y)) y = member.position.y;
        const next = y === member.position.y ? member : { ...member, position: { ...member.position, y } };
        nextById.set(member.id, next);
        fitted.push(next);
      }

      const right = Math.max(...fitted.map((node) => node.position.x + getNodeSize(node).width));
      const bottom = Math.max(...fitted.map((node) => node.position.y + getNodeSize(node).height));
      const width = Math.max(frame.size.width, right - frame.position.x + GROUP_PADDING);
      const oldBottom = Math.max(...members.map((node) => {
        const previous = previousById.get(node.id) ?? node;
        return previous.position.y + getNodeSize(previous).height;
      }));
      const bottomPadding = Math.max(GROUP_PADDING, frame.position.y + frame.size.height - oldBottom);
      const height = bottom - frame.position.y + bottomPadding;
      if (width !== frame.size.width || height !== frame.size.height) {
        if (nextGroups === groups) nextGroups = { ...groups };
        nextGroups[frame.id] = { ...frame, size: { width, height } };
      }
    }

    // A taller cell must not cover the next row. Keep the user's existing
    // spacing between rows, and leave unrelated workflow groups alone.
    for (let index = 0; index < frames.length; index++) {
      const original = frames[index];
      let frame = nextGroups[original.id];
      let y = -Infinity;
      for (const oldUpper of frames.slice(0, index)) {
        const upper = nextGroups[oldUpper.id];
        const oldGap = original.position.y - (oldUpper.position.y + oldUpper.size.height);
        if (oldGap < 0 || !overlapsX(frame.position.x, frame.size.width, upper.position.x, upper.size.width)) continue;
        y = Math.max(y, upper.position.y + upper.size.height + oldGap);
      }
      if (!Number.isFinite(y)) y = frame.position.y;
      const dy = y - frame.position.y;
      if (dy === 0) continue;
      if (nextGroups === groups) nextGroups = { ...groups };
      frame = { ...frame, position: { ...frame.position, y } };
      nextGroups[frame.id] = frame;
      for (const member of nodes) {
        if (member.groupId !== frame.id) continue;
        const next = nextById.get(member.id)!;
        nextById.set(member.id, { ...next, position: { ...next.position, y: next.position.y + dy } });
      }
    }
  }
  return { nodes: nodes.map((node) => nextById.get(node.id)!), groups: nextGroups };
}
