"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useNodeId } from "@xyflow/react";
import { useWorkflowStore } from "@/store/workflowStore";
import { useNodeUiStore } from "@/store/nodeUiStore";
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

/**
 * True inside the GPU canvas's live layer. Its React Flow starts no
 * connection of its own: the GPU canvas's editor draws them, from presses the
 * layer hands it.
 */
export function useIsLiveLayerNode(): boolean {
  return useContext(HoldLiveContext) !== null;
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

type SetValue<T> = (value: T | ((previous: T) => T)) => void;

/**
 * useState for a node's view state: plain local state on the classic canvas,
 * kept in useNodeUiStore under the node's id and `key` on the GPU canvas (its
 * live layer and its painted copies), so a node looks the same whichever way
 * it is drawn.
 *
 * `scope` stands for what classic's component is mounted for (a model, a
 * settings tab): there a change of it remounts the component and resets its
 * state. Here a stored value belongs to the scope it was set under; under
 * another it reads as `initial`, and is dropped so it does not come back with
 * its old scope.
 */
export function useNodeUiState<T>(id: string, key: string, initial: T, scope?: string): [T, SetValue<T>] {
  const live = useIsLiveLayerNode(), painted = useIsPaintedNode();
  const gpu = live || painted;
  const [local, setLocal] = useState(initial);
  const raw = useNodeUiStore((state) => state.byNode[id]?.[key]);
  const setStored = useCallback<SetValue<T>>((next) => {
    const store = useNodeUiStore.getState();
    const current = scopedValue<T>(store.byNode[id]?.[key], scope);
    const value = typeof next === "function" ? (next as (previous: T) => T)(current === undefined ? initial : current) : next;
    store.set(id, key, scope === undefined ? value : { scope, value });
  }, [id, key, initial, scope]);
  const stale = gpu && scope !== undefined && raw !== undefined && scopedValue(raw, scope) === undefined;
  useEffect(() => {
    if (!stale) return;
    const store = useNodeUiStore.getState(), current = store.byNode[id]?.[key];
    if (current !== undefined && scopedValue(current, scope) === undefined) store.set(id, key, undefined);
  }, [stale, id, key, scope]);
  if (!gpu) return [local, setLocal];
  const stored = scopedValue<T>(raw, scope);
  return [stored === undefined ? initial : stored, setStored];
}

/** A stored view-state entry's value, `undefined` when it was set under another scope. */
export function scopedValue<T>(raw: unknown, scope: string | undefined): T | undefined {
  if (scope === undefined) return raw as T | undefined;
  const entry = raw as { scope?: unknown; value?: T } | null | undefined;
  return entry && typeof entry === "object" && entry.scope === scope ? entry.value : undefined;
}

/**
 * Marks a painted copy as not ready while `pending` (a waveform decoding, a
 * video's poster being extracted): the GPU canvas waits for it before
 * painting, and paints it again later if the wait runs out. Renders nothing
 * elsewhere.
 */
export function PaintPending({ pending }: { pending: boolean }) {
  const painted = useIsPaintedNode();
  return painted && pending ? <div hidden data-paint-pending="" /> : null;
}
