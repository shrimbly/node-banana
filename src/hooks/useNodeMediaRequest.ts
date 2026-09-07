"use client";

import { useCallback, useEffect, useRef } from "react";
import { useWorkflowStore } from "@/store/workflowStore";

/** Keep deferred file/metadata callbacks scoped to their node and workflow. */
export function useNodeMediaRequest() {
  const requestId = useRef(0);
  const cancelRequest = useCallback(() => {
    requestId.current += 1;
  }, []);

  useEffect(() => cancelRequest, [cancelRequest]);

  const beginRequest = useCallback(() => {
    const currentRequest = ++requestId.current;
    const lifecycleId = useWorkflowStore.getState().workflowLifecycleId;
    return () =>
      requestId.current === currentRequest &&
      useWorkflowStore.getState().workflowLifecycleId === lifecycleId;
  }, []);

  return { beginRequest, cancelRequest };
}
