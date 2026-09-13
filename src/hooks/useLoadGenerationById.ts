import { useCallback, useRef } from "react";
import { useWorkflowStore } from "@/store/workflowStore";
import { useToast } from "@/components/Toast";

/**
 * Returns a loader that fetches a previously-generated asset by ID from the
 * configured generations folder via POST /api/load-generation.
 *
 * @param resultField preferred key on the response payload (e.g. "image",
 *   "video", "audio"); falls back to `result.image` when absent.
 * @param label capitalized media label used in log messages (e.g. "Image").
 */
export function useLoadGenerationById(resultField: string, label: string) {
  const generationsPath = useWorkflowStore((state) => state.generationsPath);
  const saveDirectoryPath = useWorkflowStore((state) => state.saveDirectoryPath);
  // Said once per node, not on every arrow press
  const warnedRef = useRef(false);

  return useCallback(
    async (id: string): Promise<string | null> => {
      // A workflow with a folder keeps its generations beside it even when the
      // path was never recorded; only a workflow with no folder has nowhere to look.
      const directoryPath = generationsPath ?? (saveDirectoryPath ? `${saveDirectoryPath}/generations` : null);
      if (!directoryPath) {
        if (!warnedRef.current) {
          warnedRef.current = true;
          useToast.getState().show(`Set a project folder to browse ${label.toLowerCase()} history`, "warning");
        }
        return null;
      }

      try {
        const response = await fetch("/api/load-generation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            directoryPath,
            imageId: id,
          }),
        });

        const result = await response.json();
        if (!result.success) {
          // Missing assets are expected when refs point to deleted/moved files
          console.log(`${label} not found: ${id}`);
          return null;
        }
        return result[resultField] || result.image;
      } catch (error) {
        console.warn(`Error loading ${label.toLowerCase()}:`, error);
        return null;
      }
    },
    [generationsPath, saveDirectoryPath, resultField, label]
  );
}
