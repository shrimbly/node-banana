/**
 * Execution Utilities
 *
 * Pure utility functions used by the workflow execution engine.
 * Extracted from workflowStore.ts for testability and reuse.
 */

import { WorkflowNode, WorkflowEdge, WorkflowNodeData } from "@/types";
import { getSourceOutput } from "./connectedInputs";

// Concurrency settings
export const CONCURRENCY_SETTINGS_KEY = "node-banana-concurrency-limit";
export const DEFAULT_MAX_CONCURRENT_CALLS = 3;

/**
 * Load concurrency setting from localStorage
 */
export const loadConcurrencySetting = (): number => {
  if (typeof window === "undefined") return DEFAULT_MAX_CONCURRENT_CALLS;
  const stored = localStorage.getItem(CONCURRENCY_SETTINGS_KEY);
  if (stored) {
    const parsed = parseInt(stored, 10);
    if (!isNaN(parsed) && parsed >= 1 && parsed <= 10) {
      return parsed;
    }
  }
  return DEFAULT_MAX_CONCURRENT_CALLS;
};

/**
 * Save concurrency setting to localStorage
 */
export const saveConcurrencySetting = (value: number): void => {
  if (typeof window === "undefined") return;
  localStorage.setItem(CONCURRENCY_SETTINGS_KEY, String(value));
};

/**
 * Level grouping for parallel execution
 */
export interface LevelGroup {
  level: number;
  nodeIds: string[];
}

/**
 * Groups nodes by dependency level using Kahn's algorithm variant.
 * Nodes at the same level can be executed in parallel.
 * Level 0 = nodes with no incoming edges (roots)
 * Level N = nodes whose dependencies are all at levels < N
 */
export function groupNodesByLevel(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[]
): LevelGroup[] {
  // Calculate in-degree for each node
  const inDegree = new Map<string, number>();
  const adjList = new Map<string, string[]>();

  nodes.forEach((n) => {
    inDegree.set(n.id, 0);
    adjList.set(n.id, []);
  });

  edges.forEach((e) => {
    inDegree.set(e.target, (inDegree.get(e.target) || 0) + 1);
    adjList.get(e.source)?.push(e.target);
  });

  // BFS with level tracking (Kahn's algorithm variant)
  const levels: LevelGroup[] = [];
  let currentLevel = nodes
    .filter((n) => inDegree.get(n.id) === 0)
    .map((n) => n.id);

  let levelNum = 0;
  while (currentLevel.length > 0) {
    levels.push({ level: levelNum, nodeIds: [...currentLevel] });

    const nextLevel: string[] = [];
    for (const nodeId of currentLevel) {
      for (const child of adjList.get(nodeId) || []) {
        if (!inDegree.has(child)) continue; // skip orphan edge targets
        const newDegree = inDegree.get(child)! - 1;
        inDegree.set(child, newDegree);
        if (newDegree === 0) {
          nextLevel.push(child);
        }
      }
    }

    currentLevel = nextLevel;
    levelNum++;
  }

  return levels;
}

/**
 * Chunk an array into smaller arrays of specified size
 */
export function chunk<T>(array: T[], size: number): T[][] {
  if (!Number.isFinite(size) || size < 1) {
    throw new Error("Invalid chunk size: must be a positive integer");
  }
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/**
 * Dependency-aware concurrent scheduler for level-grouped nodes.
 *
 * Replaces the old level-barrier + fixed-chunk scheduling. A node starts as soon
 * as its direct upstreams (within the run set) have finished AND a concurrency
 * slot is free — so independent branches no longer wait on a whole prior level,
 * and a free slot immediately picks up the next ready node instead of waiting for
 * the slowest node in a fixed batch. Data-flow correctness is preserved because
 * readiness is gated on each node's actual upstream edges.
 *
 * Semantics preserved from the previous implementation:
 * - runs the nodes in `levels` from `startLevel` onward (a subset partition is fine)
 * - cooperative stop: stops launching new nodes when `signal` aborts or `isRunning()`
 *   becomes false (e.g. a pause edge), letting in-flight nodes settle
 * - fail-fast: the first non-abort error aborts the run and rejects this call
 * - a run-set that (anomalously) contains a dependency cycle still executes every
 *   node, matching the old "every node in every level runs" behavior
 */
export interface ConcurrentScheduleContext {
  levels: LevelGroup[];
  startLevel: number;
  /** Edges used to derive readiness; caller passes the already-filtered set (e.g. forward-only). */
  edges: Array<{ source: string; target: string }>;
  maxConcurrent: number;
  signal: AbortSignal;
  isRunning: () => boolean;
  getNode: (id: string) => WorkflowNode | undefined;
  setCurrentNodeIds: (ids: string[]) => void;
  runNode: (node: WorkflowNode, signal: AbortSignal) => Promise<void>;
  onNodeError?: (node: WorkflowNode, error: unknown) => void;
  abort: () => void;
}

export async function runNodesWithConcurrency(
  ctx: ConcurrentScheduleContext
): Promise<void> {
  const {
    levels, startLevel, edges, maxConcurrent, signal,
    isRunning, getNode, setCurrentNodeIds, runNode, onNodeError, abort,
  } = ctx;

  // Flatten the run set in level order (dedup keeps first occurrence).
  const order: string[] = [];
  const runSet = new Set<string>();
  for (let i = Math.max(0, startLevel); i < levels.length; i++) {
    for (const id of levels[i].nodeIds) {
      if (!runSet.has(id)) { runSet.add(id); order.push(id); }
    }
  }
  if (order.length === 0) return;

  const orderIndex = new Map<string, number>();
  order.forEach((id, i) => orderIndex.set(id, i));

  // In-degree + dependents restricted to the run set.
  const indeg = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const id of order) { indeg.set(id, 0); dependents.set(id, []); }
  for (const e of edges) {
    if (e.source !== e.target && runSet.has(e.source) && runSet.has(e.target)) {
      indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
      dependents.get(e.source)!.push(e.target);
    }
  }

  const ready: string[] = order.filter((id) => (indeg.get(id) ?? 0) === 0);
  const running = new Set<string>();
  const completed = new Set<string>();
  const inFlight = new Set<Promise<void>>();
  let firstError: unknown = null;

  const stopRequested = () => signal.aborted || !isRunning() || firstError !== null;

  const releaseDependents = (id: string) => {
    for (const t of dependents.get(id) ?? []) {
      const d = (indeg.get(t) ?? 1) - 1;
      indeg.set(t, d);
      if (d === 0) ready.push(t);
    }
  };

  const launch = (id: string): Promise<void> => {
    running.add(id);
    setCurrentNodeIds([...running]);
    const node = getNode(id);
    if (!node) {
      // Node was deleted mid-run: treat as a completed no-op and release dependents.
      running.delete(id);
      completed.add(id);
      releaseDependents(id);
      setCurrentNodeIds([...running]);
      return Promise.resolve();
    }
    return runNode(node, signal).then(
      () => {
        running.delete(id);
        completed.add(id);
        releaseDependents(id);
        setCurrentNodeIds([...running]);
      },
      (err) => {
        running.delete(id);
        completed.add(id);
        setCurrentNodeIds([...running]);
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          if (firstError === null) firstError = err;
          onNodeError?.(node, err);
          abort();
        }
      }
    );
  };

  while (true) {
    while (!stopRequested() && running.size < maxConcurrent && ready.length > 0) {
      ready.sort((a, b) => (orderIndex.get(a) ?? 0) - (orderIndex.get(b) ?? 0));
      const id = ready.shift()!;
      if (completed.has(id) || running.has(id)) continue;
      const tracked = launch(id).finally(() => { inFlight.delete(tracked); });
      inFlight.add(tracked);
    }

    if (inFlight.size === 0) {
      // Nothing in flight. If un-run nodes remain and we weren't asked to stop,
      // flush them (guards against a dependency cycle stranding nodes).
      if (!stopRequested() && completed.size < order.length) {
        for (const id of order) {
          if (!completed.has(id) && !running.has(id) && !ready.includes(id)) ready.push(id);
        }
        if (ready.length > 0) continue;
      }
      break;
    }

    await Promise.race(inFlight);
    if (stopRequested()) {
      await Promise.allSettled(inFlight);
      break;
    }
  }

  if (firstError !== null) throw firstError;
}

/**
 * Revoke a blob URL if the value is one, to free the underlying memory.
 */
export function revokeBlobUrl(url: string | null | undefined): void {
  if (url && url.startsWith('blob:')) {
    try { URL.revokeObjectURL(url); } catch { /* ignore */ }
  }
}

/**
 * Clear all imageRefs from nodes (used when saving to a different directory)
 */
export function clearNodeImageRefs(nodes: WorkflowNode[]): WorkflowNode[] {
  return nodes.map(node => {
    const data = { ...node.data } as Record<string, unknown>;

    // Clear all ref fields regardless of node type (match any key ending in Ref or Refs)
    // Keep live media URLs intact: Save As must still read their blobs to write
    // them into the new directory, and the canvas continues to display them.
    for (const key of Object.keys(data)) {
      if (/Refs?$/.test(key)) {
        delete data[key];
      }
    }

    return { ...node, data: data as WorkflowNodeData } as WorkflowNode;
  });
}

/**
 * Check if adding an edge from sourceId to targetId would create a cycle.
 * Uses iterative DFS to check if targetId can reach sourceId through existing edges.
 */
export function wouldCreateCycle(
  sourceId: string,
  targetId: string,
  edges: WorkflowEdge[]
): boolean {
  // Self-loop check
  if (sourceId === targetId) return true;

  // Build adjacency list (edge.source → edge.target)
  const adjList = new Map<string, string[]>();
  edges.forEach((edge) => {
    if (!adjList.has(edge.source)) {
      adjList.set(edge.source, []);
    }
    adjList.get(edge.source)!.push(edge.target);
  });

  // DFS from targetId to see if we can reach sourceId
  const visited = new Set<string>();
  const stack = [targetId];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === sourceId) return true;
    if (visited.has(current)) continue;

    visited.add(current);
    const neighbors = adjList.get(current) || [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        stack.push(neighbor);
      }
    }
  }

  return false;
}

/**
 * Find all nodes that are part of a loop body.
 * Returns the intersection of nodes reachable forward from loopTarget
 * and nodes reachable backward from loopSource.
 */
export function findLoopSubgraph(
  loopSource: string,
  loopTarget: string,
  forwardEdges: WorkflowEdge[]
): string[] {
  // Build adjacency lists
  const forward = new Map<string, string[]>();
  const backward = new Map<string, string[]>();

  forwardEdges.forEach((edge) => {
    if (!forward.has(edge.source)) {
      forward.set(edge.source, []);
    }
    forward.get(edge.source)!.push(edge.target);

    if (!backward.has(edge.target)) {
      backward.set(edge.target, []);
    }
    backward.get(edge.target)!.push(edge.source);
  });

  // BFS forward from loopTarget
  const forwardReachable = new Set<string>();
  const forwardQueue = [loopTarget];
  while (forwardQueue.length > 0) {
    const current = forwardQueue.shift()!;
    if (forwardReachable.has(current)) continue;
    forwardReachable.add(current);

    const neighbors = forward.get(current) || [];
    for (const neighbor of neighbors) {
      if (!forwardReachable.has(neighbor)) {
        forwardQueue.push(neighbor);
      }
    }
  }

  // BFS backward from loopSource
  const backwardReachable = new Set<string>();
  const backwardQueue = [loopSource];
  while (backwardQueue.length > 0) {
    const current = backwardQueue.shift()!;
    if (backwardReachable.has(current)) continue;
    backwardReachable.add(current);

    const neighbors = backward.get(current) || [];
    for (const neighbor of neighbors) {
      if (!backwardReachable.has(neighbor)) {
        backwardQueue.push(neighbor);
      }
    }
  }

  // Return intersection
  const intersection = Array.from(forwardReachable).filter((node) =>
    backwardReachable.has(node)
  );
  return intersection;
}

/**
 * Copy output data from source node to target node input field.
 * Used for loop edges to transfer data from loop end back to loop start.
 */
export function copyLoopOutput(
  sourceNode: WorkflowNode,
  sourceHandle: string | null,
  targetNode: WorkflowNode,
  targetHandle: string | null,
  updateNodeData: (nodeId: string, data: Partial<WorkflowNodeData>) => void
): void {
  const { type, value } = getSourceOutput(sourceNode, sourceHandle);

  // If value is null, do nothing
  if (value === null) return;

  // Map output type to target input field based on node type
  if (type === "image" && targetNode.type === "imageInput") {
    updateNodeData(targetNode.id, { image: value });
  } else if (type === "video" && targetNode.type === "videoInput") {
    updateNodeData(targetNode.id, { video: value });
  } else if (type === "text" && targetNode.type === "prompt") {
    updateNodeData(targetNode.id, { prompt: value });
  } else if (type === "audio" && targetNode.type === "audioInput") {
    updateNodeData(targetNode.id, { audioFile: value });
  } else {
    console.warn(`[copyLoopOutput] Unrecognized target: type="${type}" → node.type="${targetNode.type}"`);
  }
}
