"use client";

import { useEffect, useRef, useState } from "react";
import type { PropsWithChildren } from "react";
import { useToast } from "@/components/Toast";
import { useWorkflowStore } from "@/store/workflowStore";
import type { WorkflowFile } from "@/store/workflowStore";
import { defaultNodeDimensions } from "@/store/utils/nodeDefaults";
import {
  clearLastWorkflowDirectory,
  getLastWorkflowDirectory,
} from "@/store/utils/localStorage";

function isRestorableWorkflow(value: unknown): value is WorkflowFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  const workflow = value as Record<string, unknown>;
  if (
    workflow.version !== 1 ||
    typeof workflow.name !== "string" ||
    !Array.isArray(workflow.nodes) ||
    !Array.isArray(workflow.edges)
  ) {
    return false;
  }

  const nodesAreValid = workflow.nodes.every((node) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return false;
    const candidate = node as Record<string, unknown>;
    const position = candidate.position as Record<string, unknown> | undefined;
    return (
      typeof candidate.id === "string" &&
      typeof candidate.type === "string" &&
      Object.prototype.hasOwnProperty.call(
        defaultNodeDimensions,
        candidate.type
      ) &&
      !!position &&
      typeof position === "object" &&
      typeof position.x === "number" &&
      typeof position.y === "number" &&
      !!candidate.data &&
      typeof candidate.data === "object" &&
      !Array.isArray(candidate.data)
    );
  });

  const edgesAreValid = workflow.edges.every((edge) => {
    if (!edge || typeof edge !== "object" || Array.isArray(edge)) return false;
    const candidate = edge as Record<string, unknown>;
    return (
      typeof candidate.id === "string" &&
      typeof candidate.source === "string" &&
      typeof candidate.target === "string"
    );
  });

  return nodesAreValid && edgesAreValid;
}

export function WorkflowRestoreGate({ children }: PropsWithChildren) {
  const loadWorkflow = useWorkflowStore((state) => state.loadWorkflow);
  const [isRestoring, setIsRestoring] = useState(true);
  const restoreAttempt = useRef(0);

  useEffect(() => {
    const directoryPath = getLastWorkflowDirectory();
    if (!directoryPath) {
      setIsRestoring(false);
      return;
    }

    const attempt = ++restoreAttempt.current;
    const abortController = new AbortController();

    const restore = async () => {
      try {
        const response = await fetch(
          `/api/workflow?path=${encodeURIComponent(directoryPath)}&load=true`,
          { signal: abortController.signal }
        );
        const result = await response.json();

        if (
          !response.ok ||
          !result.success ||
          !isRestorableWorkflow(result.workflow)
        ) {
          throw new Error(
            result.error || "The saved workflow is unavailable or invalid"
          );
        }

        await loadWorkflow(result.workflow, directoryPath);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;

        console.warn("Failed to restore the last workflow:", error);
        clearLastWorkflowDirectory();
        useToast
          .getState()
          .show(
            "Couldn’t reopen the last project. Choose a workflow to continue.",
            "warning"
          );
      } finally {
        if (restoreAttempt.current === attempt) {
          setIsRestoring(false);
        }
      }
    };

    void restore();
    return () => abortController.abort();
  }, [loadWorkflow]);

  if (isRestoring) {
    return (
      <div
        className="flex-1 flex items-center justify-center bg-neutral-950"
        role="status"
        aria-live="polite"
      >
        <div className="flex items-center gap-3 text-sm text-neutral-400">
          <div className="w-4 h-4 border-2 border-neutral-600 border-t-neutral-300 rounded-full animate-spin" />
          <span>Opening last project…</span>
        </div>
      </div>
    );
  }

  return children;
}
