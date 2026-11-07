import type { WorkflowNode } from "@/types";

/**
 * Which nodes a store change touched.
 *
 * The store replaces a node object whenever anything about it changes (its
 * data, position, size or selection) and keeps the same object otherwise,
 * so "changed" means "a different object under the same id". The GPU
 * canvas repaints only these; anything else that needs per-node changes can
 * listen too.
 */
export interface NodeChanges {
  /** Ids present before and after whose node object was replaced. */
  updated: ReadonlySet<string>;
  added: ReadonlySet<string>;
  removed: ReadonlySet<string>;
  previous: readonly WorkflowNode[];
  nodes: readonly WorkflowNode[];
}

export type NodeChangeListener = (changes: NodeChanges) => void;

/**
 * Each array's id → index map. Built once per node array, and carried to
 * the next array when an edit replaces nodes in place, so a lookup on the
 * typing path never scans the graph.
 */
const indexes = new WeakMap<readonly WorkflowNode[], Map<string, number>>();

export function nodeIndex(nodes: readonly WorkflowNode[]): Map<string, number> {
  let index = indexes.get(nodes);
  if (!index) {
    index = new Map();
    for (let i = 0; i < nodes.length; i++) index.set(nodes[i].id, i);
    indexes.set(nodes, index);
  }
  return index;
}

export function indexOfNode(nodes: readonly WorkflowNode[], id: string): number {
  return nodeIndex(nodes).get(id) ?? -1;
}

/**
 * The edit that produced the current array, when an action knows it: the
 * listener then reports those ids without comparing the whole graph.
 */
let known: { from: readonly WorkflowNode[]; to: readonly WorkflowNode[]; ids: readonly string[] } | null = null;

/**
 * `nodes` with the node at each index replaced, in a new array that keeps
 * every other node object (and the id index, since no id moved). Records the
 * edit so change listeners need not diff.
 */
export function replaceNodesAt(nodes: readonly WorkflowNode[], replacements: ReadonlyMap<number, WorkflowNode>): WorkflowNode[] {
  const next = nodes.slice();
  const ids: string[] = [];
  for (const [i, node] of replacements) {
    next[i] = node;
    ids.push(node.id);
  }
  const index = indexes.get(nodes);
  if (index) indexes.set(next, index);
  known = { from: nodes, to: next, ids };
  return next;
}

/** Compares two node arrays by id and object identity. */
export function diffNodes(previous: readonly WorkflowNode[], nodes: readonly WorkflowNode[]): NodeChanges {
  // Every listener of one store change asks about the same pair; compare once
  if (lastDiff && lastDiff.previous === previous && lastDiff.nodes === nodes) return lastDiff;
  return (lastDiff = compareNodes(previous, nodes));
}

let lastDiff: NodeChanges | null = null;

function compareNodes(previous: readonly WorkflowNode[], nodes: readonly WorkflowNode[]): NodeChanges {
  const updated = new Set<string>();
  const added = new Set<string>();
  const removed = new Set<string>();
  if (known && known.from === previous && known.to === nodes) {
    for (const id of known.ids) updated.add(id);
    return { updated, added, removed, previous, nodes };
  }
  const before = nodeIndex(previous);
  const seen = new Set<string>();
  for (const node of nodes) {
    seen.add(node.id);
    const i = before.get(node.id);
    if (i === undefined) added.add(node.id);
    else if (previous[i] !== node) updated.add(node.id);
  }
  for (const node of previous) if (!seen.has(node.id)) removed.add(node.id);
  return { updated, added, removed, previous, nodes };
}

interface NodesStore {
  subscribe: (listener: (state: { nodes: WorkflowNode[] }, previous: { nodes: WorkflowNode[] }) => void) => () => void;
}

/**
 * Calls `listener` after every store change that replaced the node array,
 * with the nodes it touched. A change that touched none (the same objects in
 * a new array) is not reported.
 */
export function subscribeToNodeChanges(store: NodesStore, listener: NodeChangeListener): () => void {
  return store.subscribe((state, previous) => {
    if (state.nodes === previous.nodes) return;
    const changes = diffNodes(previous.nodes, state.nodes);
    if (changes.updated.size || changes.added.size || changes.removed.size) listener(changes);
  });
}
