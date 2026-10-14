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
import { NODE_HEADER, type HandleAnchor } from "@/lib/gpuCanvas/graph";
import { SOCKET_W } from "@/components/nodes/ui/tokens";

/** Flow units above a node that its painted image takes in, for the floating header. */
export const HEADER = NODE_HEADER;
/** Margin below the node, for its shadow. */
export const PAD = 8;
/**
 * Margin left and right: a socket's swell bulges past the card's border (its
 * box sits SOCKET_W - 3 outside), and a selected or running socket's ring
 * strokes up to 2.5 beyond that.
 */
export const PAD_X = SOCKET_W - 3 + 5;

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

/** A store node as the sheet or live layer's React Flow takes it, at a position (with the classes classic gives it, if any). */
export function flowNode(node: WorkflowNode, x: number, y: number, width: number, selected = false, className?: string): Node {
  return { id: node.id, type: node.type, position: { x, y }, data: node.data as Record<string, unknown>, style: { width }, width, selected, ...(className ? { className } : {}) } as Node;
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

/** A video with a source whose first frame is still to come (one set not to preload never shows one). */
function videoLoading(video: HTMLVideoElement): boolean {
  return !!(video.currentSrc || video.getAttribute("src")) && !video.error && video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA && video.preload !== "none";
}

function videoLoaded(video: HTMLVideoElement): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      video.removeEventListener("loadeddata", done);
      video.removeEventListener("error", done);
      resolve();
    };
    video.addEventListener("loadeddata", done);
    video.addEventListener("error", done);
    if (!videoLoading(video)) done();
  });
}

/**
 * Waits for React Flow to measure the nodes (it hides a node until then),
 * then for every image in those nodes (and their floating headers) to decode
 * and every video to show its first frame (a picture of a video is of that
 * frame). Media in other nodes of `root` never holds them.
 */
export async function settleNodes(root: HTMLElement, ids: readonly string[], until: number, cancelled: () => boolean = () => false): Promise<{ decodeMs: number; unloaded: Set<string> }> {
  const element = (id: string) => root.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
  // The settled nodes' own elements: each node and its floating header.
  const scope = ids.length ? ids.flatMap((id) => [`.react-flow__node[data-id="${CSS.escape(id)}"]`, `[data-node-header="${CSS.escape(id)}"]`]).join(", ") : null;
  const within = <K extends keyof HTMLElementTagNameMap>(selector: K): HTMLElementTagNameMap[K][] =>
    scope ? [...root.querySelectorAll(scope)].flatMap((part) => [...part.querySelectorAll(selector)]) : [];
  const pendingMarks = () => scope ? [...root.querySelectorAll(scope)].flatMap((part) => [...part.querySelectorAll("[data-paint-pending]")]) : [];
  for (;;) {
    const pending = ids.filter((id) => {
      const node = element(id);
      return !node || node.style.visibility === "hidden" || !node.offsetHeight;
    });
    if (!pending.length || performance.now() > until || cancelled()) break;
    await nextFrame();
  }
  // What a node still fetches before it shows its fields (a model's settings) marks itself pending.
  while (pendingMarks().length && performance.now() < until && !cancelled()) await nextFrame();
  const started = performance.now();
  // An image's source can arrive or change after the first render (a
  // thumbnail swapped in, a reference resolved), and its card resizes once
  // it has loaded: so wait for the images, then the sizes, until a pass
  // finds every image loaded and nothing changed.
  let decodeMs = 0;
  let seen = "";
  for (;;) {
    const images = within("img");
    // A broken image is complete with no width: it is not waited for again.
    const loading = images.filter((img) => img.getAttribute("src") && !(img.complete && (img.naturalWidth || seen)));
    const videos = within("video");
    const loadingVideos = videos.filter(videoLoading);
    const signature = [...images.map((img) => img.currentSrc || img.getAttribute("src") || ""), ...videos.map((v) => v.currentSrc || v.getAttribute("src") || "")].join("\n");
    if (!loading.length && !loadingVideos.length && signature === seen) break;
    seen = signature;
    // Bounded: an image that never loads (lazy, or a stalled request) holds the batch only until the deadline.
    let allLoaded = false;
    void Promise.all([...loading.map(loaded), ...loadingVideos.map(videoLoaded)]).then(() => { allLoaded = true; });
    while (!allLoaded && performance.now() < until && !cancelled()) await nextFrame();
    decodeMs = performance.now() - started;
    if (cancelled()) break;
    await settleSizes(ids.map((id) => () => element(id)), until, cancelled);
    if (performance.now() > until || cancelled()) break;
  }
  // Nodes with an image still loading at the deadline: painted as they are, but not for keeps.
  const unloaded = new Set<string>();
  const owner = (el: Element) => {
    const part = el.closest(".react-flow__node, [data-node-header]");
    return part?.getAttribute("data-id") ?? part?.getAttribute("data-node-header");
  };
  for (const img of within("img")) {
    if (!img.getAttribute("src") || img.complete) continue;
    const id = owner(img);
    if (id) unloaded.add(id);
  }
  for (const video of within("video")) {
    if (!videoLoading(video)) continue;
    const id = owner(video);
    if (id) unloaded.add(id);
  }
  for (const mark of pendingMarks()) {
    const id = owner(mark);
    if (id) unloaded.add(id);
  }
  return { decodeMs, unloaded };
}

/**
 * Each handle's anchor (where an edge meets it) and box, relative to its node, as React Flow measured them.
 * With the element the node renders in, also whether a connection may start or end on each (a hidden
 * legacy socket takes neither), read from the handle's classes as React Flow's own checks read them.
 */
export function handleAnchors(state: ReactFlowState, id: string, root?: ParentNode): Map<string, HandleAnchor> | undefined {
  const bounds = state.nodeLookup.get(id)?.internals.handleBounds;
  if (!bounds) return undefined;
  const elements = new Map<string, Element>();
  for (const element of root?.querySelectorAll(`.react-flow__handle[data-nodeid="${CSS.escape(id)}"]`) ?? []) {
    elements.set(`${element.classList.contains("source") ? "source" : "target"}:${element.getAttribute("data-handleid") ?? ""}`, element);
  }
  const anchors = new Map<string, HandleAnchor>();
  for (const kind of ["source", "target"] as const) {
    for (const handle of bounds[kind] ?? []) {
      const { x, y, width, height, position } = handle;
      const key = `${kind}:${handle.id ?? ""}`;
      const anchor: HandleAnchor = position === "right" ? { x: x + width, y: y + height / 2, position }
        : position === "left" ? { x, y: y + height / 2, position }
        : position === "top" ? { x: x + width / 2, y, position }
        : { x: x + width / 2, y: y + height, position };
      anchor.box = { x, y, w: width, h: height };
      const classes = elements.get(key)?.classList;
      if (classes) {
        // A live node's sockets leave starting a connection to the editor (Socket's isConnectableStart): they still start one.
        const live = !!elements.get(key)?.closest("[data-gpu-canvas-live]");
        anchor.connectableStart = classes.contains("connectable") && (classes.contains("connectablestart") || live);
        anchor.connectableEnd = classes.contains("connectable") && classes.contains("connectableend");
      }
      anchors.set(key, anchor);
    }
  }
  return anchors;
}

/** An element of the node, relative to the node, in flow units; null without one. */
function boxIn(root: HTMLElement, id: string, selector: string): { x: number; y: number; w: number; h: number; nodeW: number } | null {
  const node = root.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
  const card = node?.querySelector<HTMLElement>(selector);
  if (!node || !card || !node.offsetWidth) return null;
  const a = node.getBoundingClientRect(), b = card.getBoundingClientRect();
  const scale = a.width / node.offsetWidth || 1;
  return { x: (b.left - a.left) / scale, y: (b.top - a.top) / scale, w: b.width / scale, h: b.height / scale, nodeW: node.offsetWidth };
}

/** The node's media card (the box a marquee must hold), relative to the node, in flow units; null without one. */
export function mediaCardBox(root: HTMLElement, id: string): { x: number; y: number; w: number; h: number } | null {
  const box = boxIn(root, id, "[data-media-card]");
  return box && { x: box.x, y: box.y, w: box.w, h: box.h };
}

/** An inner area of a node that takes the wheel on classic (findScrollableAncestor): its box within the node, in flow units, and whether it is `.nowheel`. */
export type ScrollArea = { x: number; y: number; w: number; h: number; nowheel: boolean };

/**
 * The node's textareas and `.nowheel` areas that hold more than they show, so a wheel over them scrolls them on
 * classic rather than moving the canvas; relative to the node, in flow units.
 */
export function scrollAreaBoxes(root: HTMLElement, id: string): ScrollArea[] {
  const node = root.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
  if (!node || !node.offsetWidth) return [];
  const a = node.getBoundingClientRect(), scale = a.width / node.offsetWidth || 1;
  const areas: ScrollArea[] = [];
  for (const element of node.querySelectorAll<HTMLElement>("textarea, .nowheel")) {
    const style = window.getComputedStyle(element);
    const scrolls = (overflow: string) => overflow === "auto" || overflow === "scroll";
    const y = scrolls(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
    const x = scrolls(style.overflowX) && element.scrollWidth > element.clientWidth + 1;
    if (!x && !y) continue;
    const b = element.getBoundingClientRect();
    areas.push({ x: (b.left - a.left) / scale, y: (b.top - a.top) / scale, w: b.width / scale, h: b.height / scale, nowheel: element.classList.contains("nowheel") });
  }
  return areas;
}

/** The node's controls card when it reaches past the node's sides (SceneNode.overhang), in flow units; else null. */
export function controlsOverhangBox(root: HTMLElement, id: string): { x: number; y: number; w: number; h: number } | null {
  const box = boxIn(root, id, "[data-controls-card]");
  return box && (box.x < -0.5 || box.x + box.w > box.nodeW + 0.5) ? { x: box.x, y: box.y, w: box.w, h: box.h } : null;
}
