import { describe, it, expect } from "vitest";
import { hasHistoryEntries, pruneMissingHistory } from "../historyPruning";
import type { WorkflowNode } from "@/types";

const entry = (id: string) => ({ id, timestamp: 1, prompt: "", aspectRatio: "1:1", model: "m" });

const node = (id: string, type: string, data: Record<string, unknown>) =>
  ({ id, type, position: { x: 0, y: 0 }, data }) as unknown as WorkflowNode;

describe("pruneMissingHistory", () => {
  it("keeps only the entries whose files exist, on every carousel node type", () => {
    const { nodes, changed } = pruneMissingHistory(
      [
        node("i", "nanoBanana", { imageHistory: [entry("a"), entry("gone"), entry("b")], selectedHistoryIndex: 0 }),
        node("v", "generateVideo", { videoHistory: [entry("gone"), entry("c")], selectedVideoHistoryIndex: 0 }),
        node("s", "generateAudio", { audioHistory: [entry("d")], selectedAudioHistoryIndex: 0 }),
      ],
      new Set(["a", "b", "c", "d"])
    );
    expect(changed).toBe(true);
    expect((nodes[0].data as { imageHistory: { id: string }[] }).imageHistory.map((e) => e.id)).toEqual(["a", "b"]);
    expect((nodes[1].data as { videoHistory: { id: string }[] }).videoHistory.map((e) => e.id)).toEqual(["c"]);
    expect((nodes[2].data as { audioHistory: { id: string }[] }).audioHistory.map((e) => e.id)).toEqual(["d"]);
  });

  it("keeps the selected entry selected when it survives, else selects the newest", () => {
    const { nodes } = pruneMissingHistory(
      [
        node("i", "nanoBanana", { imageHistory: [entry("gone"), entry("a"), entry("b")], selectedHistoryIndex: 2 }),
        node("j", "nanoBanana", { imageHistory: [entry("a"), entry("gone")], selectedHistoryIndex: 1 }),
      ],
      new Set(["a", "b"])
    );
    expect((nodes[0].data as { selectedHistoryIndex: number }).selectedHistoryIndex).toBe(1);
    expect((nodes[1].data as { selectedHistoryIndex: number }).selectedHistoryIndex).toBe(0);
  });

  it("returns the same nodes, unchanged, when nothing is missing", () => {
    const input = [node("i", "nanoBanana", { imageHistory: [entry("a")], selectedHistoryIndex: 0 }), node("p", "prompt", { prompt: "x" })];
    const { nodes, changed } = pruneMissingHistory(input, new Set(["a"]));
    expect(changed).toBe(false);
    expect(nodes[0]).toBe(input[0]);
    expect(nodes[1]).toBe(input[1]);
  });

  it("reports whether any node has entries to check", () => {
    expect(hasHistoryEntries([node("p", "prompt", {}), node("i", "nanoBanana", { imageHistory: [] })])).toBe(false);
    expect(hasHistoryEntries([node("v", "generateVideo", { videoHistory: [entry("a")] })])).toBe(true);
  });
});
