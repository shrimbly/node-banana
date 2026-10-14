import { useEffect, useRef } from "react";
import { useToast } from "@/components/Toast";
import { useIsLiveLayerNode, useIsPaintedNode } from "@/components/nodes/paintMode";

/**
 * Shows an error toast when a node's status transitions into "error".
 * Tracks the previous status so re-renders while already in "error" don't
 * re-fire the toast. On the GPU canvas (a live or painted copy) the canvas
 * shows it instead (watchGenerationErrors), as its copies come and go.
 *
 * @param status current node status
 * @param error error detail shown in the toast body
 * @param title toast title (e.g. "Generation failed")
 */
export function useErrorToast(
  status: string | undefined,
  error: string | null | undefined,
  title: string
) {
  const prevStatusRef = useRef(status);
  const live = useIsLiveLayerNode();
  const painted = useIsPaintedNode();
  const gpuCanvas = live || painted;

  useEffect(() => {
    if (!gpuCanvas && status === "error" && prevStatusRef.current !== "error" && error) {
      useToast.getState().show(title, "error", true, error);
    }
    prevStatusRef.current = status;
  }, [status, error, title, gpuCanvas]);
}
