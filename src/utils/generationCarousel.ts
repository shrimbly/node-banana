interface TimestampedHistoryItem {
  timestamp: number;
}

/**
 * Return a carousel history in creation order: oldest first, newest last.
 *
 * Sorting also migrates histories written by earlier versions, which inserted
 * each new generation at index 0.
 */
export function sortGenerationHistory<T extends TimestampedHistoryItem>(history: T[] | undefined): T[] {
  return [...(history || [])].sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Add an item to a carousel history while retaining its chronological order.
 * When trimming is needed, retain the most recent entries.
 */
export function appendGenerationHistory<T extends TimestampedHistoryItem>(
  history: T[] | undefined,
  item: T,
  maxItems = 50
): T[] {
  return sortGenerationHistory([...(history || []), item]).slice(-maxItems);
}

/**
 * Keep persisted carousel indices within the current history bounds.
 * History is oldest-first, so an invalid or missing index falls back to the
 * newest item at the end.
 */
export function normalizeGenerationHistoryIndex(
  index: number | null | undefined,
  historyLength: number
): number {
  if (
    historyLength <= 0 ||
    typeof index !== "number" ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= historyLength
  ) {
    return Math.max(0, historyLength - 1);
  }

  return index;
}
