/**
 * Helpers for driving the agent tools against store-shaped state, the way the
 * browser does: snapshot → tools → ops → applyGraphOps → next snapshot.
 */

import type { NodeType, WorkflowNode } from "@/types";
import type { NodeGroup, WorkflowEdge } from "@/types/workflow";
import { createDefaultNodeData, defaultNodeDimensions } from "@/store/utils/nodeDefaults";
import type { AgentToolResult, AgentToolRuntime, AgentWorkflowSnapshot } from "../../types";
import { applyGraphOps } from "../../graph/applyOps";
import { buildAgentSnapshot } from "../../graph/snapshot";
import { createAgentToolRuntime } from "../runtime";

export interface StoreState {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** The store's groups; omitted means none. */
  groups?: Record<string, NodeGroup>;
}

export function emptySnapshot(overrides: Partial<AgentWorkflowSnapshot> = {}): AgentWorkflowSnapshot {
  return { nodes: [], edges: [], groups: [], selectedNodeIds: [], ...overrides };
}

/** Deterministic ids for switch outputs / rules. */
export function sequentialIds(prefix = "id"): () => string {
  let n = 0;
  return () => `${prefix}${(n++).toString().padStart(7 - prefix.length, "0")}`;
}

/**
 * A store-shaped node, as `addNode` creates it: width only, in both places
 * React Flow reads it. Pass `measured` in `extra` for a node the canvas has
 * rendered (its height comes from content).
 */
export function storeNode(
  id: string,
  type: NodeType,
  position: { x: number; y: number },
  data: Record<string, unknown> = {},
  extra: Partial<WorkflowNode> = {},
): WorkflowNode {
  const { width } = defaultNodeDimensions[type];
  return {
    id,
    type,
    position,
    data: { ...createDefaultNodeData(type), ...data } as WorkflowNode["data"],
    width,
    style: { width },
    ...extra,
  } as WorkflowNode;
}

export function storeEdge(source: string, sourceHandle: string, target: string, targetHandle: string, data: Record<string, unknown> = {}): WorkflowEdge {
  return {
    id: `edge-${source}-${target}-${sourceHandle}-${targetHandle}`,
    source,
    sourceHandle,
    target,
    targetHandle,
    data: { createdAt: 1, ...data },
  };
}

export function snapshotOf(state: StoreState, extra: { viewport?: AgentWorkflowSnapshot["viewport"]; workflowName?: string } = {}): AgentWorkflowSnapshot {
  return buildAgentSnapshot({ nodes: state.nodes, edges: state.edges, groups: state.groups ?? {}, ...extra });
}

export function runtimeFor(state: StoreState, extra: { viewport?: AgentWorkflowSnapshot["viewport"] } = {}): AgentToolRuntime {
  return createAgentToolRuntime(snapshotOf(state, extra), { randomId: sequentialIds() });
}

/**
 * Applies a tool result's ops to store state like `applyAgentGraphOps` does,
 * including removing a group whose nodes the batch deleted.
 */
export function applyResult(state: StoreState, result: AgentToolResult): Required<StoreState> & { skipped: string[] } {
  let clock = 1000;
  const applied = applyGraphOps({ ...state, groups: state.groups ?? {} }, result.ops, {
    createDefaultNodeData: (type) => createDefaultNodeData(type),
    defaultNodeDimensions,
    now: () => clock++,
  });
  const remaining = new Set(applied.nodes.map((n) => n.id));
  const groups = { ...applied.groups };
  for (const node of state.nodes) {
    if (node.groupId && !remaining.has(node.id) && !applied.nodes.some((n) => n.groupId === node.groupId)) delete groups[node.groupId];
  }
  return { nodes: applied.nodes, edges: applied.edges, groups, skipped: applied.skipped };
}

export async function call(runtime: AgentToolRuntime, name: string, args: unknown): Promise<AgentToolResult> {
  return runtime.execute(name, args);
}

export function edgeKeys(edges: ReadonlyArray<{ source: string; sourceHandle?: string | null; target: string; targetHandle?: string | null }>): string[] {
  return edges.map((e) => `${e.source}.${e.sourceHandle} -> ${e.target}.${e.targetHandle}`).sort();
}
