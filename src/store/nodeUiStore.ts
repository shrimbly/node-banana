"use client";

import { create } from "zustand";

/**
 * A node's own view state (a collapsed controls card, the settings tab it
 * shows, an opened list), kept apart from the node so the GPU canvas can
 * share it between a node's live component and its painted copies.
 *
 * On the classic canvas a node stays mounted, so its useState holds this.
 * On the GPU canvas a node is a live component only while worked in, and a
 * fresh painted copy otherwise: local state would reset to its default each
 * time the node went back to a picture. Nodes read it through useNodeUiState
 * (paintMode.tsx). Never saved with the workflow; the GPU canvas forgets a
 * node's entry when the node goes and every entry when another workflow
 * opens, as classic's remount does.
 */
interface NodeUiStore {
  byNode: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  set: (id: string, key: string, value: unknown) => void;
  forget: (ids?: Iterable<string>) => void;
}

export const useNodeUiStore = create<NodeUiStore>((set) => ({
  byNode: {},
  set: (id, key, value) => set((state) => {
    if (state.byNode[id]?.[key] === value) return state;
    return { byNode: { ...state.byNode, [id]: { ...state.byNode[id], [key]: value } } };
  }),
  forget: (ids) => set((state) => {
    if (!ids) return Object.keys(state.byNode).length ? { byNode: {} } : state;
    let next: Record<string, Readonly<Record<string, unknown>>> | null = null;
    for (const id of ids) {
      if (!(id in state.byNode)) continue;
      next ??= { ...state.byNode };
      delete next[id];
    }
    return next ? { byNode: next } : state;
  }),
}));
