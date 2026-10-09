/**
 * Browser side: replays the agent's resolved graph operations on the live
 * store's nodes, edges and groups.
 *
 * Pure. Ids, handles, positions and group boxes were decided on the server;
 * this only has to cope with the canvas having moved on since the snapshot
 * (the user deleted a node or a group mid-turn, …): such ops are skipped and
 * reported, never thrown.
 */

import type { NodeType, WorkflowNode, WorkflowNodeData } from "@/types";
import type { GroupColor, NodeGroup, WorkflowEdge } from "@/types/workflow";
import { GROUP_COLOR_ORDER } from "@/store/utils/nodeDefaults";
import type { AgentGraphOp } from "../types";

export interface ApplyGraphOpsDeps {
  /** The store's createDefaultNodeData (sticky user defaults apply in the browser). */
  createDefaultNodeData: (type: NodeType) => WorkflowNodeData;
  /** The store's defaultNodeDimensions: only the width is used, as in addNode. */
  defaultNodeDimensions: Record<NodeType, { width: number; height?: number }>;
  now?: () => number;
}

export interface ApplyGraphOpsState {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** The live groups. Omitted: none are known (group ops can only reach groups the batch creates). */
  groups?: Record<string, NodeGroup>;
}

export interface ApplyGraphOpsResult {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** The groups after the batch (the same object when no op touched them). */
  groups: Record<string, NodeGroup>;
  /** A clearCanvas op ran (it drops every group, as the canvas does). */
  clearedCanvas: boolean;
  applied: number;
  /** Ops that could not apply against the live canvas (e.g. the user deleted the node meanwhile), with reasons. */
  skipped: string[];
}

/** Pure: applies resolved agent ops to live store nodes, edges and groups. */
export function applyGraphOps(
  state: ApplyGraphOpsState,
  ops: AgentGraphOp[],
  deps: ApplyGraphOpsDeps,
): ApplyGraphOpsResult {
  let nodes = [...state.nodes];
  let edges = [...state.edges];
  let groups: Record<string, NodeGroup> = state.groups ?? {};
  let groupsCopied = false;
  /** Copy-on-write: the input's groups are never mutated. */
  const writableGroups = () => {
    if (!groupsCopied) {
      groups = { ...groups };
      groupsCopied = true;
    }
    return groups;
  };
  let clearedCanvas = false;
  let applied = 0;
  const skipped: string[] = [];
  const now = deps.now ?? Date.now;
  // Strictly increasing timestamps keep edge order (array fan-out, galleries).
  let clock = now();
  const nextTimestamp = () => clock++;

  const indexOfNode = (id: string) => nodes.findIndex((n) => n.id === id);

  for (const op of ops ?? []) {
    switch (op?.op) {
      case "clearCanvas":
        nodes = [];
        edges = [];
        groups = {};
        groupsCopied = true;
        clearedCanvas = true;
        applied++;
        break;

      case "addNode": {
        if (indexOfNode(op.id) !== -1) {
          skipped.push(`addNode ${op.id}: a node with this id already exists`);
          break;
        }
        const size = deps.defaultNodeDimensions[op.nodeType];
        if (!size) {
          skipped.push(`addNode ${op.id}: unknown node type "${op.nodeType}"`);
          break;
        }
        const defaults = deps.createDefaultNodeData(op.nodeType);
        const groupId = op.groupId;
        // Width-driven geometry, as the store's addNode and migrateNodeGeometry
        // write it: the width in both places React Flow reads it, and no
        // height or measurement (the node shell derives height from content).
        const node: WorkflowNode = {
          id: op.id,
          type: op.nodeType,
          position: { x: op.position.x, y: op.position.y },
          data: { ...defaults, ...(op.data ?? {}) } as WorkflowNodeData,
          width: size.width,
          style: { width: size.width },
          ...(typeof groupId === "string" && groupId ? { groupId } : {}),
        };
        nodes.push(node);
        applied++;
        break;
      }

      case "updateNode": {
        const index = indexOfNode(op.id);
        if (index === -1) {
          skipped.push(`updateNode ${op.id}: the node is no longer on the canvas`);
          break;
        }
        const node = nodes[index];
        nodes[index] = { ...node, data: { ...node.data, ...(op.data ?? {}) } as WorkflowNodeData };
        applied++;
        break;
      }

      case "removeNode": {
        const index = indexOfNode(op.id);
        if (index === -1) {
          // Already gone: the end state is what the agent wanted.
          break;
        }
        nodes.splice(index, 1);
        edges = edges.filter((e) => e.source !== op.id && e.target !== op.id);
        applied++;
        break;
      }

      case "moveNode": {
        const index = indexOfNode(op.id);
        if (index === -1) {
          skipped.push(`moveNode ${op.id}: the node is no longer on the canvas`);
          break;
        }
        const moved: WorkflowNode = { ...nodes[index], position: { x: op.position.x, y: op.position.y } };
        const groupId = op.groupId;
        if (typeof groupId === "string" && groupId) moved.groupId = groupId;
        else if (groupId === null) delete moved.groupId;
        nodes[index] = moved;
        applied++;
        break;
      }

      case "addEdge": {
        if (edges.some((e) => e.id === op.id)) break; // already there (same id = same endpoints and handles)
        const missing = [op.source, op.target].filter((id) => indexOfNode(id) === -1);
        if (missing.length > 0) {
          skipped.push(`addEdge ${op.source} → ${op.target}: ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} no longer on the canvas`);
          break;
        }
        edges.push({
          id: op.id,
          source: op.source,
          sourceHandle: op.sourceHandle,
          target: op.target,
          targetHandle: op.targetHandle,
          data: { ...(op.data ?? {}), createdAt: nextTimestamp() },
        });
        applied++;
        break;
      }

      case "removeEdge": {
        const before = edges.length;
        edges = edges.filter((e) => e.id !== op.id);
        if (edges.length !== before) applied++;
        break;
      }

      case "addGroup": {
        if (groups[op.id]) {
          skipped.push(`addGroup ${op.id}: a group with this id already exists`);
          break;
        }
        if (!validBox(op.position, op.size)) {
          skipped.push(`addGroup ${op.id}: its box is not a valid position and size`);
          break;
        }
        const wanted = new Set(Array.isArray(op.nodeIds) ? op.nodeIds : []);
        const present = nodes.filter((n) => wanted.has(n.id)).map((n) => n.id);
        if (present.length === 0) {
          skipped.push(`addGroup ${op.id}: none of its nodes are on the canvas any more`);
          break;
        }
        const gone = [...wanted].filter((id) => !present.includes(id));
        if (gone.length > 0) {
          skipped.push(`addGroup ${op.id}: ${gone.join(", ")} ${gone.length > 1 ? "are" : "is"} no longer on the canvas (grouped the rest)`);
        }
        writableGroups()[op.id] = {
          id: op.id,
          name: typeof op.name === "string" && op.name ? op.name : op.id,
          color: groupColor(op.color) ?? "neutral",
          position: { x: op.position.x, y: op.position.y },
          size: { width: op.size.width, height: op.size.height },
        };
        const joining = new Set(present);
        nodes = nodes.map((n) => (joining.has(n.id) ? { ...n, groupId: op.id } : n));
        applied++;
        break;
      }

      case "updateGroup": {
        const group = groups[op.id];
        if (!group) {
          skipped.push(`updateGroup ${op.id}: the group is no longer on the canvas`);
          break;
        }
        const next: NodeGroup = { ...group };
        if (typeof op.name === "string" && op.name) next.name = op.name;
        const color = groupColor(op.color);
        if (color) next.color = color;
        if (op.position && op.size && validBox(op.position, op.size)) {
          next.position = { x: op.position.x, y: op.position.y };
          next.size = { width: op.size.width, height: op.size.height };
        } else if (op.position && validBox(op.position, group.size)) {
          next.position = { x: op.position.x, y: op.position.y };
        } else if (op.size && validBox(group.position, op.size)) {
          next.size = { width: op.size.width, height: op.size.height };
        }
        writableGroups()[op.id] = next;
        applied++;
        break;
      }

      case "removeGroup": {
        // Already gone: the end state is what the agent wanted.
        if (!groups[op.id]) break;
        delete writableGroups()[op.id];
        nodes = nodes.map((n) => {
          if (n.groupId !== op.id) return n;
          const { groupId: _dropped, ...rest } = n;
          return rest as WorkflowNode;
        });
        applied++;
        break;
      }

      case "setNodeGroup": {
        const index = indexOfNode(op.id);
        if (index === -1) {
          skipped.push(`setNodeGroup ${op.id}: the node is no longer on the canvas`);
          break;
        }
        if (typeof op.groupId === "string" && op.groupId) {
          if (!groups[op.groupId]) {
            skipped.push(`setNodeGroup ${op.id}: group ${op.groupId} is no longer on the canvas`);
            break;
          }
          nodes[index] = { ...nodes[index], groupId: op.groupId };
        } else {
          const { groupId: _dropped, ...rest } = nodes[index];
          nodes[index] = rest as WorkflowNode;
        }
        applied++;
        break;
      }

      default:
        skipped.push(`unknown operation ${JSON.stringify((op as { op?: unknown })?.op)}`);
    }
  }

  return { nodes, edges, groups, clearedCanvas, applied, skipped };
}

function groupColor(value: unknown): GroupColor | undefined {
  return GROUP_COLOR_ORDER.find((color) => color === value);
}

function validBox(position: { x: number; y: number } | undefined, size: { width: number; height: number } | undefined): boolean {
  const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  return !!position && !!size && finite(position.x) && finite(position.y) && finite(size.width) && finite(size.height) && size.width > 0 && size.height > 0;
}
