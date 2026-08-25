import { useCallback, useState } from "react";
import { useWorkflowStore } from "@/store/workflowStore";
import { WorkflowNodeData } from "@/types";
import { normalizeGenerationHistoryIndex } from "@/utils/generationCarousel";

interface HistoryItem {
  id: string;
}

interface UseGenerationCarouselParams<T extends HistoryItem> {
  nodeId: string;
  history: T[] | undefined;
  currentIndex: number | undefined;
  loadFn: (id: string) => Promise<string | null>;
  /**
   * Builds the `updateNodeData` payload for a successfully loaded asset.
   * Kept node-specific so each node can write its own output/index fields.
   */
  buildUpdate: (media: string, newIndex: number) => Partial<WorkflowNodeData>;
}

/**
 * Shared prev/next wrap-around carousel navigation for generation history.
 * Manages its own loading flag; returns handlers wired to load an asset by ID
 * and update the node on success.
 */
export function useGenerationCarousel<T extends HistoryItem>({
  nodeId,
  history,
  currentIndex,
  loadFn,
  buildUpdate,
}: UseGenerationCarouselParams<T>) {
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const [isLoading, setIsLoading] = useState(false);

  const navigate = useCallback(
    async (direction: "previous" | "next") => {
      const items = history || [];
      if (items.length === 0 || isLoading) return;

      const current = normalizeGenerationHistoryIndex(currentIndex, items.length);
      const newIndex =
        direction === "previous"
          ? current === 0
            ? items.length - 1
            : current - 1
          : (current + 1) % items.length;
      const item = items[newIndex];

      setIsLoading(true);
      const media = await loadFn(item.id);
      setIsLoading(false);

      if (media) {
        updateNodeData(nodeId, buildUpdate(media, newIndex));
      }
    },
    [nodeId, history, currentIndex, isLoading, loadFn, buildUpdate, updateNodeData]
  );

  const handlePrevious = useCallback(() => navigate("previous"), [navigate]);
  const handleNext = useCallback(() => navigate("next"), [navigate]);

  return { isLoading, handlePrevious, handleNext };
}
