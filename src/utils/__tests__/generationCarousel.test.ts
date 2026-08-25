import { describe, expect, it } from "vitest";
import { normalizeGenerationHistoryIndex } from "../generationCarousel";

describe("normalizeGenerationHistoryIndex", () => {
  it.each([
    { index: undefined, length: 3 },
    { index: -1, length: 3 },
    { index: 3, length: 3 },
    { index: 1.5, length: 3 },
    { index: 1, length: 0 },
  ])("returns the newest item for invalid index $index and length $length", ({ index, length }) => {
    expect(normalizeGenerationHistoryIndex(index, length)).toBe(0);
  });

  it("preserves a valid persisted index", () => {
    expect(normalizeGenerationHistoryIndex(2, 3)).toBe(2);
  });
});
