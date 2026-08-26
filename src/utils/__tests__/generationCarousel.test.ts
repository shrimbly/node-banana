import { describe, expect, it } from "vitest";
import { appendGenerationHistory, normalizeGenerationHistoryIndex, sortGenerationHistory } from "../generationCarousel";

describe("normalizeGenerationHistoryIndex", () => {
  it.each([
    { index: undefined, length: 3 },
    { index: -1, length: 3 },
    { index: 3, length: 3 },
    { index: 1.5, length: 3 },
    { index: 1, length: 0 },
  ])("returns the newest item for invalid index $index and length $length", ({ index, length }) => {
    expect(normalizeGenerationHistoryIndex(index, length)).toBe(Math.max(0, length - 1));
  });

  it("preserves a valid persisted index", () => {
    expect(normalizeGenerationHistoryIndex(2, 3)).toBe(2);
  });

  it("sorts old newest-first histories into chronological order", () => {
    expect(sortGenerationHistory([
      { id: "third", timestamp: 3 },
      { id: "first", timestamp: 1 },
      { id: "second", timestamp: 2 },
    ]).map((item) => item.id)).toEqual(["first", "second", "third"]);
  });

  it("appends new history items after prior generations", () => {
    expect(appendGenerationHistory(
      [{ id: "second", timestamp: 2 }, { id: "first", timestamp: 1 }],
      { id: "third", timestamp: 3 }
    ).map((item) => item.id)).toEqual(["first", "second", "third"]);
  });
});
