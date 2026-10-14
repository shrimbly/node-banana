import { create } from "zustand";

/**
 * The connection under the pointer on the GPU canvas, whose scene takes the
 * pointer rather than the edge's own element: a live EditableEdge reads it
 * where it reads its own hover (its label brightens). The classic canvas
 * never sets it.
 */
export const useEdgeHoverStore = create<{ edgeId: string | null }>(() => ({ edgeId: null }));

export function setHoveredSceneEdge(edgeId: string | null) {
  if (useEdgeHoverStore.getState().edgeId !== edgeId) useEdgeHoverStore.setState({ edgeId });
}
