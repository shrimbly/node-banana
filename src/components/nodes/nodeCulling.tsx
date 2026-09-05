"use client";

import { useCallback, useDeferredValue, useLayoutEffect, useSyncExternalStore } from "react";
import { useStore, useStoreApi, type ReactFlowState } from "@xyflow/react";

/**
 * Which nodes are rendered. A node more than a viewport away from the view
 * is replaced by a placeholder of its measured size that carries its handles
 * at their measured positions, so React Flow, the edges and the layout see
 * the same node while React stops working on it.
 *
 * A node keeps its component while anything could be lost by unmounting it:
 * while it is selected or dragging, while it holds the focused element (an
 * edit in a field commits on blur, and blur cannot come from a node that
 * never unmounts), and always for the types whose mount is expensive or
 * holds state the store does not have.
 */

/** Node types that are never culled. */
const ALWAYS_MOUNTED = new Set([
  "glbViewer",
  "annotation",
  "videoInput",
  "generateVideo",
  "videoStitch",
  "videoTrim",
  "videoFrameGrab",
  "gifEncoder",
  "comfyApp",
]);

/**
 * The mounted area is the view plus a full viewport on every side, snapped
 * to this grid, so a pan re-evaluates it every few hundred pixels rather
 * than every frame.
 */
export const CULL_STEP = 500;

/** The mounted area in flow coordinates: [minX, minY, maxX, maxY]. */
export function mountedArea(transform: readonly number[], width: number, height: number): [number, number, number, number] {
  const [x, y, zoom] = transform;
  const left = -x / zoom;
  const top = -y / zoom;
  const w = width / zoom;
  const h = height / zoom;
  const snap = (v: number) => Math.floor(v / CULL_STEP) * CULL_STEP;
  return [snap(left - w), snap(top - h), snap(left + 2 * w) + CULL_STEP, snap(top + 2 * h) + CULL_STEP];
}

/** The mounted area as a string, so a store selector can return it unchanged. */
export const selectMountedArea = (s: ReactFlowState): string => mountedArea(s.transform, s.width, s.height).join(" ");

// The node that holds the focused element, kept by two document listeners
// that are attached while anything subscribes.
let focusedNodeId: string | null = null;
const focusListeners = new Set<() => void>();

function nodeIdOf(target: EventTarget | null): string | null {
  return target instanceof Element ? target.closest(".react-flow__node")?.getAttribute("data-id") ?? null : null;
}

function setFocusedNode(id: string | null) {
  if (id === focusedNodeId) return;
  focusedNodeId = id;
  for (const listener of focusListeners) listener();
}

const onFocusIn = (e: FocusEvent) => setFocusedNode(nodeIdOf(e.target));
const onFocusOut = (e: FocusEvent) => setFocusedNode(nodeIdOf(e.relatedTarget));

function subscribeFocus(listener: () => void) {
  if (focusListeners.size === 0) {
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    setFocusedNode(nodeIdOf(document.activeElement));
  }
  focusListeners.add(listener);
  return () => {
    focusListeners.delete(listener);
    if (focusListeners.size === 0) {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    }
  };
}

/** True while the node contains the focused element. */
export function useNodeHasFocus(id: string): boolean {
  return useSyncExternalStore(
    subscribeFocus,
    () => focusedNodeId === id,
    () => false
  );
}

// The exact border box of each node wrapper, in CSS pixels. React Flow
// measures nodes in whole pixels, but its resize observer compares exact
// sizes, so a placeholder built from the whole-pixel size would register as
// a resize, and React Flow re-reads the handles and re-renders the edges on
// every resize. One observer keeps the exact size for the placeholder.
const exactSizes = new Map<string, { width: number; height: number }>();
let sizeObserver: ResizeObserver | null = null;
const observedIds = new WeakMap<Element, string>();

function observeExactSize(element: Element, id: string) {
  if (typeof ResizeObserver === "undefined") return () => {};
  sizeObserver ??= new ResizeObserver((entries) => {
    for (const entry of entries) {
      const id = observedIds.get(entry.target);
      const box = entry.borderBoxSize?.[0];
      if (id && box) exactSizes.set(id, { width: box.inlineSize, height: box.blockSize });
    }
  });
  observedIds.set(element, id);
  sizeObserver.observe(element);
  return () => sizeObserver?.unobserve(element);
}

/** The exact size recorded for a node, when its wrapper has been observed. */
export function exactNodeSize(id: string): { width: number; height: number } | undefined {
  return exactSizes.get(id);
}

/** True while the node's component is rendered rather than its placeholder. */
export function useNodeMounted(id: string, type: string, selected: boolean, dragging: boolean): boolean {
  const inArea = useStore(
    useCallback(
      (s: ReactFlowState) => {
        const node = s.nodeLookup.get(id);
        // A node is rendered until it, and the canvas, are measured
        if (!node || !s.width || !s.height) return true;
        const width = node.measured.width ?? node.width ?? 0;
        const height = node.measured.height ?? node.height ?? 0;
        if (!width || !height) return true;
        const [minX, minY, maxX, maxY] = mountedArea(s.transform, s.width, s.height);
        const { x, y } = node.internals.positionAbsolute;
        return x + width >= minX && x <= maxX && y + height >= minY && y <= maxY;
      },
      [id]
    )
  );
  // Mounting is deferred so a zoom out, which brings many nodes into the
  // area at once, does not block a frame on them; the area's margin keeps
  // them off screen while they wait. Unmounting is immediate.
  const inAreaDeferred = useDeferredValue(inArea);
  const focused = useNodeHasFocus(id);
  const mounted = (inArea && inAreaDeferred) || focused || selected || dragging || ALWAYS_MOUNTED.has(type);
  // Watch the wrapper's exact size while the component is rendered, for the placeholder
  useLayoutEffect(() => {
    if (!mounted) return;
    const element = document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
    return element ? observeExactSize(element, id) : undefined;
  }, [id, mounted]);
  return mounted;
}

interface NodePlaceholderProps {
  id: string;
  width: number;
  height: number;
}

/**
 * Stands in for a culled node. React Flow re-reads a node's handles from the
 * DOM whenever it re-measures the node, so the placeholder keeps an element
 * at each measured handle position with the attributes that read takes, or
 * the edges would lose their ends. The geometry is read once: it cannot
 * change while the node is culled, and a subscription here would cost on
 * every store update.
 */
export function NodePlaceholder({ id, width, height }: NodePlaceholderProps) {
  const handleBounds = useStoreApi().getState().nodeLookup.get(id)?.internals.handleBounds;
  const handles = [...(handleBounds?.source ?? []), ...(handleBounds?.target ?? [])];
  const exact = exactNodeSize(id);
  return (
    <div style={{ position: "relative", width: exact?.width ?? width, height: exact?.height ?? height }} aria-hidden>
      {handles.map((h) => (
        <div
          key={`${h.type}-${h.id ?? ""}`}
          className={h.type}
          data-handleid={h.id ?? undefined}
          data-handlepos={h.position}
          style={{ position: "absolute", left: h.x, top: h.y, width: h.width, height: h.height }}
        />
      ))}
    </div>
  );
}
