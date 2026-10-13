"use client";

/**
 * What the painter's sheet and the live layer share: real node components
 * in a real <ReactFlow> (the nodes need its context: useReactFlow, Handle,
 * useUpdateNodeInternals, useStore, useNodeId), each in its own error
 * boundary, with their floating headers.
 */
import { memo, type ComponentType } from "react";
import type { Node, NodeTypes, ReactFlowState } from "@xyflow/react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import type { HeaderActions } from "@/components/nodes/FloatingNodeHeaders";
import type { WorkflowNode } from "@/types";
import type { HandleAnchor } from "@/lib/gpuCanvas/graph";

/** Flow units above a node that its painted image takes in, for the floating header. */
export const HEADER = 30;
/** Margin on the other sides, for the node's shadow. */
export const PAD = 8;

export const noop = () => {};

export const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Wraps each node type in an error boundary, so one broken node paints as its fallback card. */
export function boundedNodeTypes(raw: NodeTypes): NodeTypes {
  return Object.fromEntries(
    Object.entries(raw).map(([type, Component]) => {
      const Node = Component as ComponentType<Record<string, unknown>>;
      const Bounded = memo((props: Record<string, unknown>) => (
        <ErrorBoundary label={type}>
          <Node {...props} />
        </ErrorBoundary>
      ));
      Bounded.displayName = `GpuCanvasNode(${type})`;
      return [type, Bounded];
    })
  ) as NodeTypes;
}

/** A store node as the sheet or live layer's React Flow takes it, at a position. */
export function flowNode(node: WorkflowNode, x: number, y: number, width: number, selected = false): Node {
  return { id: node.id, type: node.type, position: { x, y }, data: node.data as Record<string, unknown>, style: { width }, width, selected } as Node;
}

export type HeaderProps = HeaderActions & { hints?: Record<string, string> };

/** Waits until the elements' sizes are the same two frames running (or the deadline passes). */
export async function settleSizes(elements: (() => HTMLElement | null)[], until: number, cancelled: () => boolean = () => false) {
  const sizes = () => elements.map((get) => {
    const element = get();
    return element ? `${element.offsetWidth}x${element.offsetHeight}` : "";
  }).join(",");
  let previous = sizes();
  for (;;) {
    await nextFrame();
    await nextFrame();
    if (cancelled()) return;
    const current = sizes();
    if (current === previous || performance.now() > until) return;
    previous = current;
  }
}

/** Resolves once an image has loaded (and decoded) or failed. */
function loaded(img: HTMLImageElement): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      img.removeEventListener("load", done);
      img.removeEventListener("error", done);
      resolve();
    };
    img.addEventListener("load", done);
    img.addEventListener("error", done);
    if (img.complete) done();
  }).then(() => img.decode().catch(noop));
}

/** Waits for React Flow to measure the nodes (it hides a node until then), then for every image in `root` to decode. */
export async function settleNodes(root: HTMLElement, ids: readonly string[], until: number, cancelled: () => boolean = () => false): Promise<{ decodeMs: number; unloaded: Set<string> }> {
  const element = (id: string) => root.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
  for (;;) {
    const pending = ids.filter((id) => {
      const node = element(id);
      return !node || node.style.visibility === "hidden" || !node.offsetHeight;
    });
    if (!pending.length || performance.now() > until || cancelled()) break;
    await nextFrame();
  }
  const started = performance.now();
  // An image's source can arrive or change after the first render (a
  // thumbnail swapped in, a reference resolved), and its card resizes once
  // it has loaded: so wait for the images, then the sizes, until a pass
  // finds every image loaded and nothing changed.
  let decodeMs = 0;
  let seen = "";
  for (;;) {
    const images = [...root.querySelectorAll("img")];
    // A broken image is complete with no width: it is not waited for again.
    const loading = images.filter((img) => img.getAttribute("src") && !(img.complete && (img.naturalWidth || seen)));
    const signature = images.map((img) => img.currentSrc || img.getAttribute("src") || "").join("\n");
    if (!loading.length && signature === seen) break;
    seen = signature;
    // Bounded: an image that never loads (lazy, or a stalled request) holds the batch only until the deadline.
    let allLoaded = false;
    void Promise.all(loading.map(loaded)).then(() => { allLoaded = true; });
    while (!allLoaded && performance.now() < until && !cancelled()) await nextFrame();
    decodeMs = performance.now() - started;
    if (cancelled()) break;
    await settleSizes(ids.map((id) => () => element(id)), until, cancelled);
    if (performance.now() > until || cancelled()) break;
  }
  // Nodes with an image still loading at the deadline: painted as they are, but not for keeps.
  const unloaded = new Set<string>();
  for (const img of root.querySelectorAll("img")) {
    if (!img.getAttribute("src") || img.complete) continue;
    const id = img.closest(".react-flow__node")?.getAttribute("data-id");
    if (id) unloaded.add(id);
  }
  return { decodeMs, unloaded };
}

/** Each handle's anchor (where an edge meets it), relative to its node, as React Flow measured it. */
export function handleAnchors(state: ReactFlowState, id: string): Map<string, HandleAnchor> | undefined {
  const bounds = state.nodeLookup.get(id)?.internals.handleBounds;
  if (!bounds) return undefined;
  const anchors = new Map<string, HandleAnchor>();
  for (const kind of ["source", "target"] as const) {
    for (const handle of bounds[kind] ?? []) {
      const { x, y, width, height, position } = handle;
      const anchor = position === "right" ? { x: x + width, y: y + height / 2, position }
        : position === "left" ? { x, y: y + height / 2, position }
        : position === "top" ? { x: x + width / 2, y, position }
        : { x: x + width / 2, y: y + height, position };
      anchors.set(`${kind}:${handle.id ?? ""}`, anchor);
    }
  }
  return anchors;
}

/** The node's media card (the box a marquee must hold), relative to the node, in flow units; null without one. */
export function mediaCardBox(root: HTMLElement, id: string): { x: number; y: number; w: number; h: number } | null {
  const node = root.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
  const card = node?.querySelector<HTMLElement>("[data-media-card]");
  if (!node || !card || !node.offsetWidth) return null;
  const a = node.getBoundingClientRect(), b = card.getBoundingClientRect();
  const scale = a.width / node.offsetWidth || 1;
  return { x: (b.left - a.left) / scale, y: (b.top - a.top) / scale, w: b.width / scale, h: b.height / scale };
}
