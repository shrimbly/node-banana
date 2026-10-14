/**
 * A generation node shows a toast as its run fails (useErrorToast in the node,
 * on today's canvas). On the GPU canvas the node is mounted only while it is
 * worked in, and its painted copies mount and remount as they please, so the
 * hook there would fire zero, one or two times. The canvas watches the store
 * instead: a generation node whose status turns to "error" shows the toast once.
 */
import { diffNodes, indexOfNode } from "@/store/nodeChanges";
import type { WorkflowNode } from "@/types";

/** The toast title for each node type that shows one. */
export const GENERATION_ERROR_TITLES: Readonly<Record<string, string>> = {
  nanoBanana: "Generation failed",
  generateVideo: "Video generation failed",
  generate3d: "3D generation failed",
};

interface ErrorToastState {
  nodes: readonly WorkflowNode[];
}

interface ErrorToastStore {
  subscribe: (listener: (state: ErrorToastState, previous: ErrorToastState) => void) => () => void;
}

type Show = (title: string, error: string) => void;

function status(node: WorkflowNode): { status?: string; error?: string | null } {
  return node.data as { status?: string; error?: string | null };
}

/** Shows `show` for each generation node that fails; returns the unsubscribe. */
export function watchGenerationErrors(store: ErrorToastStore, show: Show): () => void {
  return store.subscribe((state, previous) => {
    if (state.nodes === previous.nodes) return;
    const changes = diffNodes(previous.nodes, state.nodes);
    // As the hook: a node that arrives in error (a workflow opened) shows nothing.
    for (const id of changes.updated) {
      const node = state.nodes[indexOfNode(state.nodes, id)];
      const title = node && GENERATION_ERROR_TITLES[node.type ?? ""];
      if (!node || !title) continue;
      const now = status(node);
      if (now.status !== "error" || !now.error) continue;
      const before = previous.nodes[indexOfNode(previous.nodes, id)];
      if (before && status(before).status !== "error") show(title, now.error);
    }
  });
}
