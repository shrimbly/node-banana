import { useEffect } from "react";
import { useSaveRequestStore } from "@/store/saveRequestStore";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { useWorkflowStore, type WorkflowStore } from "@/store/workflowStore";
import { saveStitchEdit } from "./commitStitchEdit";

/**
 * Closes the editor, writing nothing, when what it edits goes away under it:
 * the canvas is replaced (load, clear, tab switch) or the node is deleted
 * (an agent's graph ops can do that while the dialog is up). And puts the
 * open edit in the node whenever the workflow is saved (⌘S, File › Save,
 * the header's Save), leaving the editor open. Node sessions only: an edit
 * project's session belongs to no canvas and saves on its own.
 */
export function useEditorLifecycle(): void {
  const isOpen = useStitchEditorStore((s) => s.isOpen && s.nodeId !== null);
  useEffect(() => {
    if (!isOpen) return;
    const check = (wf: Pick<WorkflowStore, "canvasGeneration" | "nodes">) => {
      const { nodeId, canvasGeneration, isOpen: open, close } = useStitchEditorStore.getState();
      if (!open || nodeId === null) return;
      const gone = !wf.nodes.some((n) => n.id === nodeId && n.type === "videoStitch");
      if (gone || wf.canvasGeneration !== canvasGeneration) close();
    };
    check(useWorkflowStore.getState());
    return useWorkflowStore.subscribe(check);
  }, [isOpen]);

  // A request is set before the floating menu answers it (in an effect), so the node holds the edit by the time the
  // workflow is written
  useEffect(() => {
    if (!isOpen) return;
    return useSaveRequestStore.subscribe((state, prev) => {
      if (state.request && state.request !== prev.request) saveStitchEdit();
    });
  }, [isOpen]);
}
