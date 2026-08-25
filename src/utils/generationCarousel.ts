/**
 * Keep persisted carousel indices within the current history bounds.
 * History is newest-first, so an invalid or missing index falls back to 0.
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
    return 0;
  }

  return index;
}
