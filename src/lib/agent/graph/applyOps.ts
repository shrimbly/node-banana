/**
 * Browser side: replays the agent's resolved graph operations on the live
 * store's nodes and edges.
 *
 * Pure. Ids, handles and positions were decided on the server; this only has
 * to cope with the canvas having moved on since the snapshot (the user deleted
 * a node mid-turn, …): such ops are skipped and reported, never thrown.
 */

import type { NodeType, WorkflowNode, WorkflowNodeData } from "@/types";
import type { WorkflowEdge } from "@/types/workflow";
import type { AgentGraphOp } from "../types";

export interface ApplyGraphOpsDeps {
  /** The store's createDefaultNodeData (sticky user defaults apply in the browser). */
  createDefaultNodeData: (type: NodeType) => WorkflowNodeData;
  /** The store's defaultNodeDimensions: only the width is used, as in addNode. */
  defaultNodeDimensions: Record<NodeType, { width: number; height?: number }>;
  now?: () => number;
}

export interface ApplyGraphOpsResult {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** A clearCanvas op ran: the caller must also drop groups. */
  clearedCanvas: boolean;
  applied: number;
  /** Ops that could not apply against the live canvas (e.g. the user deleted the node meanwhile), with reasons. */
  skipped: string[];
}

/** Pure: applies resolved agent ops to live store nodes/edges. */
export function applyGraphOps(
  state: { nodes: WorkflowNode[]; edges: WorkflowEdge[] },
  ops: AgentGraphOp[],
  deps: ApplyGraphOpsDeps,
): ApplyGraphOpsResult {
  let nodes = [...state.nodes];
  let edges = [...state.edges];
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

      default:
        skipped.push(`unknown operation ${JSON.stringify((op as { op?: unknown })?.op)}`);
    }
  }

  return { nodes, edges, clearedCanvas, applied, skipped };
}
