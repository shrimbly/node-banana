"use client";

import { useCallback } from "react";
import { useWorkflowStore } from "@/store/workflowStore";

/**
 * The newest request per node id. Kept outside the component so that a node
 * remounted mid-read (on the GPU canvas a hovered node leaves the live layer
 * when the pointer does) still supersedes the read its earlier instance
 * started: a Remove or another upload on the new instance bumps the same count.
 */
const latestRequest = new Map<string, number>();

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
export function useNodeMediaRequest(nodeId: string) {
  const cancelRequest = useCallback(() => {
    latestRequest.set(nodeId, (latestRequest.get(nodeId) ?? 0) + 1);
  }, [nodeId]);

  const beginRequest = useCallback(() => {
    const currentRequest = (latestRequest.get(nodeId) ?? 0) + 1;
    latestRequest.set(nodeId, currentRequest);
    const generation = useWorkflowStore.getState().canvasGeneration;
    return () =>
      latestRequest.get(nodeId) === currentRequest && useWorkflowStore.getState().canvasGeneration === generation;
  }, [nodeId]);

  return { beginRequest, cancelRequest };
}
