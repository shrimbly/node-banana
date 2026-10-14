/**
 * What a node's painted image depends on, as one string.
 *
 * Two nodes with the same key paint the same pixels, so the key decides both
 * when a painted image is stale (the painter repaints a node whose key
 * changed) and what the disk cache stores it under. It covers the node's
 * type, width and data, the connections on its sockets (a connected socket
 * looks different), and the keys of the nodes feeding it (an Output node
 * shows its source's image, and a node can show what its source derives
 * from further upstream, so a change anywhere upstream reaches it). Selection and position are not in it: moving or
 * selecting a node never repaints it.
 *
 * Hashing is memoised per data object, so a keystroke in one node hashes
 * only that node's data; long strings (inline media) are hashed once and
 * remembered.
 */
import type { WorkflowEdge, WorkflowNode } from "@/types";
import { storeNodeSize } from "./graph";

/** Bump when the painter's output changes for the same inputs (sheet styling, margins). */
export const PAINT_FORMAT = 4;

/** cyrb53: a fast 53-bit string hash. */
export function hashString(text: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Two independent 53-bit hashes, as base-36 text. */
function strongHash(text: string): string {
  return `${hashString(text, 1).toString(36)}${hashString(text, 2).toString(36)}`;
}

const LONG_STRING = 4096;
const longStrings = new Map<string, string>();
const MAX_LONG_STRINGS = 512;

function hashLong(text: string): string {
  let hash = longStrings.get(text);
  if (hash == null) {
    hash = `#${text.length}:${strongHash(text)}`;
    if (longStrings.size >= MAX_LONG_STRINGS) longStrings.delete(longStrings.keys().next().value!);
    longStrings.set(text, hash);
  }
  return hash;
}

/**
 * A node's file refs (`imageRef`, `inputImageRefs`, …) name the file its
 * media was saved as; they never change what it shows. Left out, so a save
 * that records them does not repaint every node holding media.
 */
const FILE_REF = /Refs?$/;

/** JSON with sorted keys and long strings replaced by their hash; `top` drops a node data object's file refs. */
function stableText(value: unknown, top = false): string {
  if (typeof value === "string") return value.length > LONG_STRING ? JSON.stringify(hashLong(value)) : JSON.stringify(value);
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableText(item)).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const item = (value as Record<string, unknown>)[key];
    if (item === undefined || typeof item === "function" || (top && FILE_REF.test(key))) continue;
    parts.push(`${JSON.stringify(key)}:${stableText(item)}`);
  }
  return `{${parts.join(",")}}`;
}

const dataHashes = new WeakMap<object, string>();

/** A hash of a node's data, remembered for as long as the data object lives. */
export function hashData(data: unknown): string {
  if (data === null || typeof data !== "object") return strongHash(stableText(data));
  let hash = dataHashes.get(data);
  if (hash == null) {
    hash = strongHash(stableText(data, true));
    dataHashes.set(data, hash);
  }
  return hash;
}

export interface PaintKeyContext {
  /** Nodes by id. */
  nodeById: (id: string) => WorkflowNode | undefined;
  /** The edges touching a node. */
  edgesOf: (id: string) => readonly WorkflowEdge[];
  /** Anything outside the graph that changes how every node looks (app version, scale). */
  salt: string;
  /** The key of a node feeding this one; without it, its data stands in. */
  upstreamKey?: (id: string) => string;
}

/** The key a node's painted image is kept under (without its tier). */
export function paintKey(node: WorkflowNode, context: PaintKeyContext): string {
  const { w } = storeNodeSize(node);
  const sockets: string[] = [];
  const upstream: string[] = [];
  for (const edge of context.edgesOf(node.id)) {
    if (edge.target === node.id) {
      sockets.push(`in:${edge.targetHandle ?? ""}<${edge.sourceHandle ?? ""}:${edge.type ?? ""}`);
      const source = context.nodeById(edge.source);
      if (source && source.id !== node.id) upstream.push(`${source.type}:${context.upstreamKey ? context.upstreamKey(source.id) : hashData(source.data)}`);
    }
    if (edge.source === node.id) sockets.push(`out:${edge.sourceHandle ?? ""}`);
  }
  sockets.sort();
  upstream.sort();
  return strongHash(`${PAINT_FORMAT}|${context.salt}|${node.type}|${w}|${hashData(node.data)}|${sockets.join(",")}|${upstream.join(",")}`);
}

/**
 * Keys that take in everything upstream: each node's key includes the keys
 * of the nodes feeding it. Memoised for the life of the returned function
 * (one graph state); a cycle is cut where it closes.
 */
export function upstreamPaintKeys(context: PaintKeyContext, known?: (id: string) => string | undefined): (id: string) => string | undefined {
  const keys = new Map<string, string>();
  const keyed: PaintKeyContext = { ...context, upstreamKey: (id) => keys.get(id) ?? known?.(id) ?? "cycle" };
  return (id) => {
    if (keys.has(id)) return keys.get(id);
    // Depth first without recursion, so a long chain cannot overflow the stack.
    const stack: { id: string; expanded: boolean }[] = [{ id, expanded: false }];
    const onStack = new Set<string>([id]);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const node = context.nodeById(top.id);
      if (!node) {
        stack.pop();
        onStack.delete(top.id);
        continue;
      }
      if (!top.expanded) {
        top.expanded = true;
        for (const edge of context.edgesOf(top.id)) {
          const source = edge.source;
          if (edge.target !== top.id || source === top.id || keys.has(source) || onStack.has(source) || known?.(source) != null) continue;
          stack.push({ id: source, expanded: false });
          onStack.add(source);
        }
        continue;
      }
      stack.pop();
      onStack.delete(top.id);
      if (!keys.has(top.id)) keys.set(top.id, paintKey(node, keyed));
    }
    return keys.get(id);
  };
}

/** Edge lists by node id, for a PaintKeyContext. */
export function edgesByNode(edges: readonly WorkflowEdge[]): Map<string, WorkflowEdge[]> {
  const byNode = new Map<string, WorkflowEdge[]>();
  for (const edge of edges) {
    for (const id of edge.source === edge.target ? [edge.source] : [edge.source, edge.target]) {
      const list = byNode.get(id);
      if (list) list.push(edge);
      else byNode.set(id, [edge]);
    }
  }
  return byNode;
}

/**
 * Node types whose component reads the store's `isRunning` (any run in
 * progress): during a run they draw the running outline, and some disable
 * buttons. Kept in step with the components by a test.
 */
export const READS_RUN_IN_PROGRESS = new Set([
  "easeCurve", "generate3d", "generateAudio", "generateVideo", "gifEncoder", "imageResize", "llmGenerate",
  "nanoBanana", "output", "removeBackground", "splitGrid", "videoFrameGrab", "videoStitch", "videoTrim",
]);

export interface RunState {
  isRunning: boolean;
  currentNodeIds: readonly string[];
}

/**
 * What of the run a node's picture shows, outside its data: whether this
 * node is one the run is on (every node's outline shows it), and whether a
 * run is in progress at all (for the types above). Kept out of the keys
 * nodes downstream take in, so a run starting does not reach through them.
 */
export function runMark(node: WorkflowNode, run: RunState): string {
  return `${run.currentNodeIds.includes(node.id) ? "n" : ""}${run.isRunning && READS_RUN_IN_PROGRESS.has(node.type) ? "r" : ""}`;
}

/** A node's key with its run mark. */
export function withRunMark(key: string, mark: string): string {
  return mark ? `${key}~${mark}` : key;
}
