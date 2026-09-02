import { describe, it, expect, beforeEach } from "vitest";
import { UndoManager, UndoSnapshot, clonePreservingStrings } from "../undoHistory";

function makeSnapshot(label: string): UndoSnapshot {
  return {
    nodes: [{ id: label }] as UndoSnapshot["nodes"],
    edges: [],
    groups: {},
    edgeStyle: "curved",
    edgeAppearance: { thickness: "regular", fadedOpacity: 0.25, gradient: true, loadingPulse: true, labels: "hover" as const },
  };
}

describe("UndoManager", () => {
  let manager: UndoManager;

  beforeEach(() => {
    manager = new UndoManager();
  });

  it("starts with empty stacks", () => {
    expect(manager.canUndo).toBe(false);
    expect(manager.canRedo).toBe(false);
  });

  it("push adds to undo stack", () => {
    manager.push(makeSnapshot("A"));
    expect(manager.canUndo).toBe(true);
    expect(manager.canRedo).toBe(false);
  });

  it("undo pops from undo stack and pushes current to redo", () => {
    manager.push(makeSnapshot("A"));
    const current = makeSnapshot("B");
    const result = manager.undo(current);
    expect(result?.nodes[0].id).toBe("A");
    expect(manager.canUndo).toBe(false);
    expect(manager.canRedo).toBe(true);
  });

  it("undo returns null when stack is empty", () => {
    const result = manager.undo(makeSnapshot("current"));
    expect(result).toBeNull();
  });

  it("redo pops from redo stack and pushes current to undo", () => {
    manager.push(makeSnapshot("A"));
    const current = makeSnapshot("B");
    manager.undo(current);
    // now redo stack has B, undo stack is empty
    const redone = manager.redo(makeSnapshot("A-restored"));
    expect(redone?.nodes[0].id).toBe("B");
    expect(manager.canUndo).toBe(true);
    expect(manager.canRedo).toBe(false);
  });

  it("redo returns null when stack is empty", () => {
    const result = manager.redo(makeSnapshot("current"));
    expect(result).toBeNull();
  });

  it("push clears redo stack", () => {
    manager.push(makeSnapshot("A"));
    manager.push(makeSnapshot("B"));
    const current = makeSnapshot("C");
    manager.undo(current); // redo has C
    expect(manager.canRedo).toBe(true);
    manager.push(makeSnapshot("D")); // new action clears redo
    expect(manager.canRedo).toBe(false);
  });

  it("respects max depth of 50", () => {
    for (let i = 0; i < 60; i++) {
      manager.push(makeSnapshot(`snap-${i}`));
    }
    // Should have exactly 50 entries
    let count = 0;
    while (manager.canUndo) {
      manager.undo(makeSnapshot("current"));
      count++;
    }
    expect(count).toBe(50);
  });

  it("oldest entries are pruned when exceeding max depth", () => {
    for (let i = 0; i < 55; i++) {
      manager.push(makeSnapshot(`snap-${i}`));
    }
    // The first undo should give us snap-54 (most recent), and the oldest available should be snap-5
    const result = manager.undo(makeSnapshot("current"));
    expect(result?.nodes[0].id).toBe("snap-54");

    // Undo 48 more times to get to the oldest
    let last: UndoSnapshot | null = null;
    for (let i = 0; i < 48; i++) {
      last = manager.undo(makeSnapshot("temp"));
    }
    // last should be snap-6
    expect(last?.nodes[0].id).toBe("snap-6");

    // One more undo to get the oldest
    const oldest = manager.undo(makeSnapshot("temp"));
    expect(oldest?.nodes[0].id).toBe("snap-5");

    // No more undo available
    expect(manager.canUndo).toBe(false);
  });

  it("clear empties both stacks", () => {
    manager.push(makeSnapshot("A"));
    manager.push(makeSnapshot("B"));
    manager.undo(makeSnapshot("C")); // creates redo entry
    expect(manager.canUndo).toBe(true);
    expect(manager.canRedo).toBe(true);
    manager.clear();
    expect(manager.canUndo).toBe(false);
    expect(manager.canRedo).toBe(false);
  });

  it("multiple undo/redo cycles work correctly", () => {
    manager.push(makeSnapshot("A"));
    manager.push(makeSnapshot("B"));
    manager.push(makeSnapshot("C"));

    // Undo 3 times
    const r1 = manager.undo(makeSnapshot("D"));
    expect(r1?.nodes[0].id).toBe("C");

    const r2 = manager.undo(makeSnapshot("C"));
    expect(r2?.nodes[0].id).toBe("B");

    const r3 = manager.undo(makeSnapshot("B"));
    expect(r3?.nodes[0].id).toBe("A");

    expect(manager.canUndo).toBe(false);

    // Redo 3 times
    const f1 = manager.redo(makeSnapshot("A"));
    expect(f1?.nodes[0].id).toBe("B");

    const f2 = manager.redo(makeSnapshot("B"));
    expect(f2?.nodes[0].id).toBe("C");

    const f3 = manager.redo(makeSnapshot("C"));
    expect(f3?.nodes[0].id).toBe("D");

    expect(manager.canRedo).toBe(false);
  });
});

describe("clonePreservingStrings", () => {
  it("preserves string references (identity, not just equality)", () => {
    const bigString = "data:image/png;base64," + "A".repeat(1000);
    const input = { image: bigString, label: "test" };
    const cloned = clonePreservingStrings(input);

    // Same string reference — not a copy
    expect(cloned.image).toBe(input.image);
    expect(cloned.label).toBe(input.label);
  });

  it("creates new object containers", () => {
    const input = { a: 1, nested: { b: 2 } };
    const cloned = clonePreservingStrings(input);

    expect(cloned).toEqual(input);
    expect(cloned).not.toBe(input);
    expect(cloned.nested).not.toBe(input.nested);
  });

  it("creates new array containers", () => {
    const input = [1, [2, 3]];
    const cloned = clonePreservingStrings(input);

    expect(cloned).toEqual(input);
    expect(cloned).not.toBe(input);
    expect(cloned[1]).not.toBe(input[1]);
  });

  it("skips undefined values in objects", () => {
    const input = { a: 1, b: undefined, c: "hello" };
    const cloned = clonePreservingStrings(input);

    expect(cloned).toEqual({ a: 1, c: "hello" });
    expect("b" in cloned).toBe(false);
  });

  it("converts undefined to null in arrays", () => {
    const input = [1, undefined, 3];
    const cloned = clonePreservingStrings(input);

    expect(cloned).toEqual([1, null, 3]);
  });

  it("skips function values in objects", () => {
    const input = { a: 1, fn: () => 42, c: "hello" };
    const cloned = clonePreservingStrings(input);

    expect(cloned).toEqual({ a: 1, c: "hello" });
    expect("fn" in cloned).toBe(false);
  });

  it("converts functions to null in arrays", () => {
    const input = [1, () => 42, 3];
    const cloned = clonePreservingStrings(input);

    expect(cloned).toEqual([1, null, 3]);
  });

  it("handles nested structures with large base64-like strings", () => {
    const blob1 = "data:image/png;base64," + "B".repeat(5000);
    const blob2 = "data:audio/wav;base64," + "C".repeat(3000);
    const input = {
      nodes: [
        { id: "1", data: { image: blob1, prompt: "a cat" } },
        { id: "2", data: { audio: blob2 } },
      ],
      edges: [{ source: "1", target: "2" }],
    };

    const cloned = clonePreservingStrings(input);

    // Structure is equivalent
    expect(cloned).toEqual(input);

    // Containers are independent
    expect(cloned.nodes).not.toBe(input.nodes);
    expect(cloned.nodes[0]).not.toBe(input.nodes[0]);
    expect(cloned.nodes[0].data).not.toBe(input.nodes[0].data);

    // Strings share references
    expect(cloned.nodes[0].data.image).toBe(blob1);
    expect(cloned.nodes[0].data.prompt).toBe(input.nodes[0].data.prompt);
    expect(cloned.nodes[1].data.audio).toBe(blob2);
  });

  it("produces output equivalent to JSON.parse(JSON.stringify()) for plain data", () => {
    const input = {
      nodes: [
        { id: "n1", type: "imageInput", position: { x: 100, y: 200 }, data: { image: "base64data" } },
        { id: "n2", type: "prompt", position: { x: 300, y: 200 }, data: { prompt: "hello" } },
      ],
      edges: [{ id: "e1", source: "n1", target: "n2" }],
      groups: { g1: { name: "Group", color: "blue", nodeIds: ["n1", "n2"] } },
      edgeStyle: "curved",
      edgeAppearance: { thickness: "regular", fadedOpacity: 0.25, gradient: true, loadingPulse: true, labels: "hover" as const },
    };

    const jsonClone = JSON.parse(JSON.stringify(input));
    const fastClone = clonePreservingStrings(input);

    expect(fastClone).toEqual(jsonClone);
  });

  it("handles null values correctly", () => {
    const input = { a: null, b: [null, 1] };
    const cloned = clonePreservingStrings(input);
    expect(cloned).toEqual({ a: null, b: [null, 1] });
  });

  it("handles primitives at the top level", () => {
    expect(clonePreservingStrings("hello")).toBe("hello");
    expect(clonePreservingStrings(42)).toBe(42);
    expect(clonePreservingStrings(true)).toBe(true);
    expect(clonePreservingStrings(null)).toBe(null);
  });

  it("handles empty objects and arrays", () => {
    expect(clonePreservingStrings({})).toEqual({});
    expect(clonePreservingStrings([])).toEqual([]);
  });
});
