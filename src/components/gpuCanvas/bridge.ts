/**
 * The running GPU canvas, for chrome that shows the whole graph and so
 * cannot read React Flow (whose store holds only the live nodes): the
 * navigator's minimap and its Fit view, the agent bringing its edits into view
 * (and shimmering them), the hook sweep crossing its connections and the
 * tutorial ringing a node's socket.
 */
import { useSyncExternalStore } from "react";
import type { SceneGraph } from "@/lib/gpuCanvas/graph";
import type { View } from "@/lib/gpuCanvas/scene";
import type { HookPath } from "@/components/edges/EdgeHookSelection";

export interface GpuCanvasBridge {
  graph: () => SceneGraph;
  view: () => View;
  /** The canvas's size in css px. */
  size: () => { width: number; height: number };
  setView: (view: Partial<View>) => void;
  /** Moves to a view over `duration` ms, as React Flow's animated setViewport. */
  animateView: (view: View, duration: number) => void;
  fit: () => void;
  /** The paths of these connections near the view, sampled in client px (the hook sweep crosses them). */
  edgePaths: (ids: Set<string>) => HookPath[];
  /**
   * Keeps the nodes among `ids` that are in view live (real elements on the live layer) until `release`;
   * `ready` resolves once they have swapped in.
   */
  holdLive: (ids: readonly string[]) => { ready: Promise<void>; release: () => void };
  /** Called when the view or the graph's layout changed; `layout` is true for the layout. */
  subscribe: (listener: (layout: boolean) => void) => () => void;
}

let current: GpuCanvasBridge | null = null;
const listeners = new Set<() => void>();

export function setGpuCanvasBridge(bridge: GpuCanvasBridge | null) {
  current = bridge;
  for (const listener of listeners) listener();
}

/** The running GPU canvas's connections for the hook sweep (EdgeHookSelection's `paths`); none while it is not running. */
export function gpuEdgePaths(ids: Set<string>): HookPath[] {
  return current?.edgePaths(ids) ?? [];
}

/** The running GPU canvas, for code outside React; null while it is not running. */
export function gpuCanvasBridge(): GpuCanvasBridge | null {
  return current;
}

/**
 * A node's element as the page shows it. On the GPU canvas only a live node has one (the painter's hidden
 * sheet holds copies, which are never shown); elsewhere React Flow's.
 */
export function shownNodeElement(id: string): HTMLElement | null {
  const scope = document.querySelector("[data-gpu-canvas]") ? "[data-gpu-canvas-live] " : "";
  return document.querySelector<HTMLElement>(`${scope}.react-flow__node[data-id="${CSS.escape(id)}"]`);
}

export function useGpuCanvasBridge(): GpuCanvasBridge | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => null,
  );
}
