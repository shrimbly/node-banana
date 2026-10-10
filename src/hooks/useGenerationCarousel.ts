import { useCallback, useState } from "react";
import { useWorkflowStore } from "@/store/workflowStore";
import { WorkflowNodeData } from "@/types";

interface HistoryItem {
  id: string;
  /** The asset library's id, when the entry was recorded there. */
  assetId?: string;
}

interface UseGenerationCarouselParams<T extends HistoryItem, R> {
  nodeId: string;
  history: T[] | undefined;
  currentIndex: number | undefined;
  /**
   * Loads an entry's media; gets the whole entry, so it can use its asset id
   * or its file name. Usually one data URL; a node whose runs produce several
   * outputs loads them all and returns them together.
   */
  loadFn: (item: T) => Promise<R | null>;
  /**
   * Builds the `updateNodeData` payload for a successfully loaded asset.
   * Kept node-specific so each node can write its own output/index fields.
   */
  buildUpdate: (media: R, newIndex: number) => Partial<WorkflowNodeData>;
}

/**
 * The entry to go to from `current`. An index outside the list (-1: the node
 * shows an output that is not in its history, like a generation the library
 * failed to keep) sits before the newest entry: next goes to the newest,
 * previous wraps to the oldest.
 */
export function carouselTarget(current: number | undefined, count: number, direction: "previous" | "next"): number {
  const index = Number.isInteger(current) ? (current as number) : 0;
  if (index < 0 || index >= count) return direction === "next" ? 0 : count - 1;
  if (direction === "previous") return index === 0 ? count - 1 : index - 1;
  return (index + 1) % count;
}

/**
 * Shared prev/next wrap-around carousel navigation for generation history.
 * Manages its own loading flag; returns handlers wired to load an asset by ID
 * and update the node on success.
 */
export function useGenerationCarousel<T extends HistoryItem, R = string>({
  nodeId,
  history,
  currentIndex,
  loadFn,
  buildUpdate,
}: UseGenerationCarouselParams<T, R>) {
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const [isLoading, setIsLoading] = useState(false);

  const navigate = useCallback(
    async (direction: "previous" | "next") => {
      const items = history || [];
      if (items.length === 0 || isLoading) return;

      const newIndex = carouselTarget(currentIndex, items.length, direction);
      const item = items[newIndex];

      setIsLoading(true);
      const media = await loadFn(item);
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
