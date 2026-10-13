/**
 * The running GPU canvas, for chrome that shows the whole graph and so
 * cannot read React Flow (whose store holds only the live nodes): the
 * navigator's minimap and its Fit view.
 */
import { useSyncExternalStore } from "react";
import type { SceneGraph } from "@/lib/gpuCanvas/graph";
import type { View } from "@/lib/gpuCanvas/scene";

export interface GpuCanvasBridge {
  graph: () => SceneGraph;
  view: () => View;
  /** The canvas's size in css px. */
  size: () => { width: number; height: number };
  setView: (view: Partial<View>) => void;
  fit: () => void;
  /** Called when the view or the graph's layout changed. */
  subscribe: (listener: () => void) => () => void;
}

let current: GpuCanvasBridge | null = null;
const listeners = new Set<() => void>();

export function setGpuCanvasBridge(bridge: GpuCanvasBridge | null) {
  current = bridge;
  for (const listener of listeners) listener();
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
