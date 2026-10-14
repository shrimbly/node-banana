import { create } from "zustand";

/** A handle a connection being drawn would end on. */
export interface ConnectDragTarget {
  nodeId: string;
  handleId: string | null;
  type: "source" | "target";
}

interface ConnectDragState {
  /** A connection is being drawn. */
  active: boolean;
  /** The handle it would connect to if dropped now (only a valid one). */
  target: ConnectDragTarget | null;
}

/**
 * A connection being drawn on the GPU canvas, which draws it itself rather
 * than through React Flow: nodes read it where they read React Flow's
 * connection state (useShowHandleLabels, a socket's valid-target fill).
 * The classic canvas never sets it.
 */
export const useConnectDragStore = create<ConnectDragState>(() => ({ active: false, target: null }));

export function setConnectDrag(active: boolean, target: ConnectDragTarget | null = null) {
  const state = useConnectDragStore.getState();
  const same = state.target === target || (!!state.target && !!target
    && state.target.nodeId === target.nodeId && state.target.handleId === target.handleId && state.target.type === target.type);
  if (state.active !== active || !same) useConnectDragStore.setState({ active, target });
}
