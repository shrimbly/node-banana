import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settleNodes } from "../nodeSheets";

/** A node element React Flow has measured (jsdom lays nothing out: its height is given). */
function node(id: string, height = 40) {
  const element = document.createElement("div");
  element.className = "react-flow__node";
  element.setAttribute("data-id", id);
  Object.defineProperty(element, "offsetHeight", { configurable: true, get: () => height });
  return element;
}

describe("settleNodes", () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
  });
  afterEach(() => {
    root.remove();
    vi.restoreAllMocks();
  });

  it("waits for a node that mounts later, then reports nothing unloaded", async () => {
    root.appendChild(node("a"));
    const started = performance.now();
    const settled = settleNodes(root, ["a", "b"], started + 2000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    root.appendChild(node("b"));
    const result = await settled;
    expect(result.unloaded.size).toBe(0);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("does not query the root for every node on every frame", async () => {
    for (const id of ["a", "b", "c", "d"]) root.appendChild(node(id));
    const query = vi.spyOn(root, "querySelectorAll");
    const one = vi.spyOn(root, "querySelector");
    await settleNodes(root, ["a", "b", "c", "d"], performance.now() + 2000);
    expect(one).not.toHaveBeenCalled();
    // A pass for the nodes, and one for headers each time one is missing (at most every 100 ms).
    expect(query.mock.calls.filter(([selector]) => selector === ".react-flow__node[data-id]").length).toBe(1);
  });

  it("finds a node again once its element is replaced", async () => {
    const first = node("a", 0);
    root.appendChild(first);
    const started = performance.now();
    const settled = settleNodes(root, ["a"], started + 2000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    first.remove();
    root.appendChild(node("a"));
    await settled;
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
