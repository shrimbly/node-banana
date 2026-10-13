"use client";

import { useCallback, useRef } from "react";
import { useWorkflowStore } from "@/store/workflowStore";

/**
 * Scopes a node's deferred file reads (FileReader, metadata probes) to the
 * upload that started them. `beginRequest` returns a check that turns false
 * once a later upload or a removal supersedes it, or the canvas is replaced
 * (a load or tab switch can bring back a node with the same id).
 *
 * Not when the node unmounts: the read belongs to the node, not to the
 * component. A node scrolled out of view, or on the GPU canvas a node the
 * pointer left, unmounts while its file is still being read, and the file
 * still arrives. A deleted node takes no write.
 */
export function useNodeMediaRequest() {
  const requestId = useRef(0);
  const cancelRequest = useCallback(() => {
    requestId.current += 1;
  }, []);

  const beginRequest = useCallback(() => {
    const currentRequest = ++requestId.current;
    const generation = useWorkflowStore.getState().canvasGeneration;
    return () =>
      requestId.current === currentRequest && useWorkflowStore.getState().canvasGeneration === generation;
  }, []);

  return { beginRequest, cancelRequest };
}
