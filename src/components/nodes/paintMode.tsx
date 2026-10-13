"use client";

import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useNodeId } from "@xyflow/react";
import { useWorkflowStore } from "@/store/workflowStore";
import type { WorkflowNodeData } from "@/types";

/**
 * Painted nodes render read-only.
 *
 * The GPU canvas paints node images from the real node components, mounted
 * off screen. Some nodes save derived data when they mount (Image Resize and
 * Split Grid copy their upstream image, Array recomputes its items). A
 * painted copy must not: it would write once per paint, each write would
 * queue another paint, and the copy's view of the graph can be a batch
 * behind the live one. Inside a `PaintedNodes` tree the node's writes are
 * dropped; the live node, or the run, makes them.
 */
const PaintedContext = createContext(false);

export function PaintedNodes({ children }: { children: ReactNode }) {
  return <PaintedContext.Provider value>{children}</PaintedContext.Provider>;
}

/** True inside a painted (read-only) copy of a node. */
export function useIsPaintedNode(): boolean {
  return useContext(PaintedContext);
}

type UpdateNodeData = (nodeId: string, data: Partial<WorkflowNodeData>) => void;

const ignoreWrite: UpdateNodeData = () => {};

/** The store's `updateNodeData`, or a no-op in a painted copy. Nodes take their writer from here. */
export function useUpdateNodeData(): UpdateNodeData {
  const painted = useContext(PaintedContext);
  const update = useWorkflowStore((state) => state.updateNodeData);
  return painted ? ignoreWrite : update;
}

/**
 * The store's `updateNodeData`, painted copy or not: for an effect that keeps
 * values derived from upstream in the node's data (a Switch's input type, a
 * Prompt Constructor's resolved text) and writes only when they differ. On
 * the GPU canvas a node is mounted mostly as a painted copy, painted again
 * whenever something upstream changes, so that is where it derives.
 */
export function useDerivedNodeData(): UpdateNodeData {
  return useWorkflowStore((state) => state.updateNodeData);
}

/**
 * On the GPU canvas a node is a live component only while it is worked in
 * (hovered, selected, focused); otherwise it is unmounted and drawn as a
 * picture. Whatever a node shows from its own state (a dialog, a lightbox, a
 * menu in a portal) would close the moment the pointer moved onto it and
 * the node stopped being live. A node holds itself live while such a thing
 * is open. Elsewhere (today's canvas, a painted copy) this does nothing.
 */
export type HoldLive = (nodeId: string) => () => void;

const HoldLiveContext = createContext<HoldLive | null>(null);

export function HoldLiveProvider({ hold, children }: { hold: HoldLive; children: ReactNode }) {
  return <HoldLiveContext.Provider value={hold}>{children}</HoldLiveContext.Provider>;
}

/** Keeps this node live while `active` (inside a node; the node's id comes from React Flow). */
export function useHoldLive(active: boolean, nodeId?: string | null) {
  const hold = useContext(HoldLiveContext);
  const contextId = useNodeId();
  const id = nodeId ?? contextId;
  useEffect(() => {
    if (!active || !hold || !id) return;
    return hold(id);
  }, [active, hold, id]);
}
