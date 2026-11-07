import { useWorkflowStore } from "@/store/workflowStore";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { readStitchDraft } from "@/lib/stitch/draft";
import { stitchMusicEdge, stitchReadContext } from "@/lib/stitch/sources";
import type { VideoStitchNodeData } from "@/types";

/**
 * Opens the editor on a Stitch node with its migrated, reconciled draft. false if the node is gone, or while an edit
 * project's session holds the editor (the Edit video view covers the canvas, so no Expand reaches here then).
 */
export function openStitchEditor(nodeId: string): boolean {
  if (useStitchEditorStore.getState().editId !== null) return false;
  const wf = useWorkflowStore.getState();
  const node = wf.nodes.find((n) => n.id === nodeId && n.type === "videoStitch");
  if (!node) return false;
  const ctx = stitchReadContext(nodeId, wf.nodes, wf.edges, wf.dimmedNodeIds);
  useStitchEditorStore.getState().open({
    nodeId,
    draft: readStitchDraft(node.data as VideoStitchNodeData, ctx),
    canvasGeneration: wf.canvasGeneration,
    // Dimmed or not: Done drops the music clips if this edge is gone by then
    musicEdgeIdAtOpen: stitchMusicEdge(nodeId, wf.edges)?.id ?? null,
  });
  return true;
}

/**
 * The header's Expand, before any other editor: a Stitch node opens the Stitch
 * editor (true even when the node is gone, since nothing else should expand
 * it); any other type is left to the caller (false).
 */
export function openEditorForExpand(nodeId: string, nodeType: string): boolean {
  if (nodeType !== "videoStitch") return false;
  openStitchEditor(nodeId);
  return true;
}
